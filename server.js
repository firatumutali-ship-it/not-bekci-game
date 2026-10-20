'use strict';
/**
 * NÖBETÇİ: BÖLÜM 2 — multiplayer sunucusu (Node.js + Express + Socket.IO)
 *
 * Güvenlik modeli (özet):
 *  - Yönetici (owner) kimliği SUNUCU ayarından gelir: OWNER_KEY ortam değişkeni veya server.config.json.
 *    İstemci anahtarı gönderir, sunucu zaman-sabit karşılaştırmayla doğrular. İstemci kendini yönetici ilan edemez.
 *  - Staff Room şifresi (STAFF_CODE) sunucuda doğrulanır; doğru girilirse kapıyı açar VE yönetici yetkisi verir (OWNER_KEY da ayrıca yönetici yapar).
 *  - Ban/Kick: yetki, oda üyeliği, hedef ve mesafe sunucuda doğrulanır. Banlar bans.json dosyasına kalıcı yazılır.
 *  - Hareket: sunucu hızı, sınırları ve yüksekliği doğrular; geçersiz hareket reddedilip istemci düzeltilir.
 *  - Oda kodları kriptografik rastgele; deneme/yanlış anahtar/yanlış şifre için hız sınırı vardır.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const BossCore = require('./public/boss-core.js');   // sunucu ve tek oyunculu mod aynı boss mantığını kullanır

/* ---------------------------------------------------------------- AYARLAR */
function loadConfig(overrides) {
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'server.config.json'), 'utf8')); } catch (e) { /* dosya yoksa sorun değil */ }
  const env = process.env;
  const pick = (k, envName, def) => (overrides && overrides[k] !== undefined) ? overrides[k]
    : (env[envName] !== undefined && env[envName] !== '') ? env[envName]
    : (fileCfg[k] !== undefined ? fileCfg[k] : def);
  const cfg = {
    port: Number(pick('port', 'PORT', 3000)),
    ownerKey: String(pick('ownerKey', 'OWNER_KEY', '')),
    staffCode: String(pick('staffCode', 'STAFF_CODE', '292016')),
    lockerCode: '3714',   // istemcideki bulmaca kodu ile aynı; değiştirilemez
    trustProxy: String(pick('trustProxy', 'TRUST_PROXY', 'false')) === 'true' || String(pick('trustProxy', 'TRUST_PROXY', '')) === '1',
    allowedOrigins: String(pick('allowedOrigins', 'ALLOWED_ORIGINS', '')).split(',').map(s => s.trim()).filter(Boolean),
    bansFile: String(pick('bansFile', 'BANS_FILE', path.join(__dirname, 'data', 'bans.json'))),
    ownerTagPass: String(pick('ownerTagPass', 'OWNER_TAG_PASS', 'şifredeuali2016')),   // OWNER etiketini açmak için şifre (sunucuda doğrulanır)
    unbanCode: String(pick('unbanCode', 'UNBAN_CODE', '20162016')),   // ENGELLENDİN ekranındaki "ban aç" şifresi (yalnızca sunucuda doğrulanır)
    maxPlayers: 8,
    ownerKeyGenerated: false
  };
  if (cfg.ownerKey && (cfg.ownerKey.length < 8 || /^CHANGE-ME/i.test(cfg.ownerKey))) {
    console.warn('[uyarı] OWNER_KEY çok kısa (en az 8 karakter) veya örnek değer; yok sayıldı.');
    cfg.ownerKey = '';
  }
  if (!cfg.ownerKey) {
    cfg.ownerKey = crypto.randomBytes(9).toString('base64url');
    cfg.ownerKeyGenerated = true;
  }
  return cfg;
}

/* ------------------------------------------------------------- SABİTLER */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I karışmasın
const BOUNDS = 66;            // harita sınırı (±)
const EXIT_Z_MIN = -80;       // çıkış koridoru
const SPEED_WALK_MAX = 7.0;   // sprint 5.4 + tolerans
const SPEED_ADMIN_MAX = 16;   // fly / noclip bayrağı açıkken
const TP_MAX = 4.6;           // saklanma gibi kısa ışınlanmalar
const HIT_RANGE = 8;          // çekiç menzili (sunucu mesafesi)
const STAFF_ROOM = { x1: -3.6, x2: 3.7, z1: 55.1, z2: 61.8 };
const STAFF_KEYPAD = { x: 3.8, z: 56.8 };
const HUT_RESPAWN = { x: -0.8, y: 0.15, z: 52.3 };
const SPAWN_POINTS = [];
for (const z of [46.6, 45.0]) for (const x of [-3, -1.5, 0, 1.5, 3]) SPAWN_POINTS.push({ x, y: 0, z, yaw: 0 });
const HAMMERS = ['kick', 'ban', 'jumpscare'];
const SCARE_COOLDOWN_MS = 6000;
const NAME_RE_BAD = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿<>&"'`\\]/g;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const hash = s => crypto.createHash('sha256').update('nobetci2|' + s).digest('hex');
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function cleanName(raw, fallback) {
  let n = String(raw == null ? '' : raw).normalize('NFKC').replace(NAME_RE_BAD, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || fallback;
}
function cleanText(raw, max) {
  return String(raw == null ? '' : raw).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanId(raw) { const s = String(raw == null ? '' : raw); return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : ''; }

/* --------------------------------------------------------- HIZ SINIRLAYICI */
class Limiter {
  constructor() { this.m = new Map(); }
  /** pencere içinde en fazla `limit` olay; fazlası reddedilir */
  hit(key, limit, windowMs) {
    const now = Date.now(); let e = this.m.get(key);
    if (!e || now - e.t0 > windowMs) { e = { t0: now, n: 0 }; this.m.set(key, e); }
    e.n++; return e.n <= limit;
  }
  count(key, windowMs) { const e = this.m.get(key); return (e && Date.now() - e.t0 <= windowMs) ? e.n : 0; }
  reset(key) { this.m.delete(key); }
  sweep() { const now = Date.now(); for (const [k, e] of this.m) if (now - e.t0 > 600000) this.m.delete(k); }
}

/* ------------------------------------------------------------ BAN DEPOSU */
class BanStore {
  constructor(file) { this.file = file; this.list = []; this.load(); }
  load() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(j)) this.list = j.filter(b => b && (b.clientId || b.ipHash)); } catch (e) { this.list = []; }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.list, null, 2)); fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[ban] kayıt yazılamadı:', e.message); }
  }
  isBanned(clientId, ip) {
    const ih = ip ? hash(ip) : '';
    return this.list.some(b => (clientId && b.clientId === clientId) || (ih && b.ipHash === ih));
  }
  /** clientId'ye ya da IP'ye bağlı tüm banları kaldırır; kaldırılan sayısını döndürür */
  remove(clientId, ip) {
    const ih = ip ? hash(ip) : ''; const before = this.list.length;
    this.list = this.list.filter(b => !((clientId && b.clientId === clientId) || (ih && b.ipHash === ih)));
    if (this.list.length !== before) this.save();
    return before - this.list.length;
  }
  add(clientId, ip, name, by) {
    this.list.push({ clientId: clientId || '', ipHash: ip ? hash(ip) : '', name, by, at: new Date().toISOString() });
    this.save();
  }
}

/* ------------------------------------------------------------ SUNUCU KUR */
function createServer(overrides) {
  const CFG = loadConfig(overrides);
  const app = express();
  if (CFG.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));
  /* Ban açma: engellenen oyuncunun soketi bağlanamadığı için HTTP ile yapılır. Şifre yalnızca burada doğrulanır. */
  app.post('/api/unban', express.json({ limit: '1kb' }), (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      let okOrigin = false;
      if (CFG.allowedOrigins.length) okOrigin = CFG.allowedOrigins.includes(origin);
      else { try { okOrigin = new URL(origin).host === req.headers.host; } catch (e) { okOrigin = false; } }
      if (!okOrigin) return res.status(403).json({ ok: false, error: 'İzin yok.' });
    }
    const ip = (CFG.trustProxy ? req.ip : req.socket.remoteAddress) || '';
    const k = 'unbanfail:' + ip;
    if (lim.count(k, 600000) >= 5) return res.status(429).json({ ok: false, error: 'Çok fazla hatalı deneme. 10 dakika bekle.' });
    const body = req.body || {}, clientId = cleanId(body.clientId);
    if (!clientId || typeof body.code !== 'string') return res.status(400).json({ ok: false, error: 'Geçersiz istek.' });
    if (!safeEq(body.code.slice(0, 100), CFG.unbanCode)) { lim.hit(k, 99, 600000); return res.status(403).json({ ok: false, error: 'HATALI ŞİFRE' }); }
    lim.reset(k);
    const n = bans.remove(clientId, ip);
    res.json({ ok: true, removed: n });
  });
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', dotfiles: 'ignore', maxAge: 0 }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 10 * 1024,
    pingInterval: 10000, pingTimeout: 8000,
    perMessageDeflate: false,
    serveClient: true,
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, true);                       // tarayıcı dışı istemciler (test vb.)
      if (CFG.allowedOrigins.length) return cb(null, CFG.allowedOrigins.includes(origin));
      try { return cb(null, new URL(origin).host === req.headers.host); } catch (e) { return cb(null, false); }
    }
  });

  const bans = new BanStore(CFG.bansFile);
  const rooms = new Map();       // code -> room
  const byId = new Map();        // socket.id -> player
  const lim = new Limiter();
  const sweeper = setInterval(() => lim.sweep(), 60000); sweeper.unref();

  const ipOf = sock => {
    if (CFG.trustProxy) { const xf = sock.handshake.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); }
    return sock.handshake.address || '';
  };

  /* ------------------------------------------------------------ ODA YARDIMCILARI */
  function newCode() {
    for (let tries = 0; tries < 50; tries++) {
      let c = ''; for (let i = 0; i < 5; i++) c += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  function roomView(room) {
    return {
      code: room.code, state: room.state, hostId: room.hostId, max: CFG.maxPlayers,
      players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, admin: p.admin, host: p.id === room.hostId, hammer: p.equipped || null, tg: (p.tags.staff ? 1 : 0) | (p.tags.dev ? 2 : 0) | (p.tags.owner ? 4 : 0) }))
    };
  }
  const pushRoom = room => io.to(room.code).emit('room:update', roomView(room));
  function uniqueName(room, name) {
    const used = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
    if (!used.has(name.toLowerCase())) return name;
    for (let i = 2; i < 99; i++) { const n = (name.slice(0, 13) + '#' + i); if (!used.has(n.toLowerCase())) return n; }
    return name.slice(0, 10) + '#' + crypto.randomInt(100, 999);
  }
  function spawnFor(room) {
    const taken = new Set([...room.players.values()].map(p => p.spawnIdx));
    for (let i = 0; i < SPAWN_POINTS.length; i++) if (!taken.has(i)) return i;
    return crypto.randomInt(SPAWN_POINTS.length);
  }
  function placeAtSpawn(p) {
    const s = SPAWN_POINTS[p.spawnIdx] || SPAWN_POINTS[0];
    p.x = s.x; p.y = s.y; p.z = s.z; p.yaw = s.yaw; p.pitch = 0; p.lastMoveAt = Date.now(); p.dead = false;
  }
  function inStaffRoom(p) { return p.x >= STAFF_ROOM.x1 && p.x <= STAFF_ROOM.x2 && p.z >= STAFF_ROOM.z1 && p.z <= STAFF_ROOM.z2; }
  function nearKeypad(p) { return Math.hypot(p.x - STAFF_KEYPAD.x, p.z - STAFF_KEYPAD.z) < 7; }

  function removeFromRoom(p, reason) {
    const room = p.room; if (!room) return;
    room.players.delete(p.id); p.room = null; p.zone = 'park';
    try { p.sock.leave(room.code); } catch (e) { /* ignore */ }
    io.to(room.code).emit('player:left', { id: p.id, reason: reason || 'left' });
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    if (room.hostId === p.id) room.hostId = room.players.values().next().value.id;   // host devri
    pushRoom(room);
  }


  /* ------------------------------------------------------------ BOSS DİREKTÖRÜ (oda başına) */
  const BTIM = Object.assign({}, BossCore.TIMING, (overrides && overrides.bossTiming) || {});
  let bossSeq = 0;
  const GOLD_CAP = 1000000;
  function walletFor(room, p) {
    let w = room.wallets.get(p.clientId);
    if (!w) { w = { gold: 0, weapons: new Set() }; room.wallets.set(p.clientId, w); }
    return w;
  }
  const techView = p => ({ gold: p.wallet.gold, weapons: [...p.wallet.weapons] });
  const sendTech = p => { try { p.sock.emit('tech:update', techView(p)); } catch (e) { /* ignore */ } };
  function addGold(p, n) { p.wallet.gold = clamp(p.wallet.gold + n, 0, GOLD_CAP); sendTech(p); }
  function tele(q, spot, zone) {
    q.zone = zone; q.x = spot.x; q.y = spot.y || 0; q.z = spot.z; q.yaw = spot.yaw || 0; q.lastMoveAt = Date.now();
    q.sock.emit('teleport', { x: q.x, y: q.y, z: q.z, yaw: q.yaw, zone });
  }
  function startBoss(room) {
    if (room.boss || room.state !== 'playing') return false;
    room.boss = BossCore.createSession({ id: ++bossSeq, timing: (overrides && overrides.bossTiming) || {} });
    room.bossNextAt = Date.now() + BTIM.autoEvery * 1000; room.bossWarned = 0;
    return true;
  }
  function bossEvents(room, evs) {
    for (const e of evs) {
      if (e.t === 'announce' || e.t === 'phase' || e.t === 'fx') io.to(room.code).emit('boss:fx', e);
      else if (e.t === 'enter') {
        const q = room.players.get(e.id); if (!q) continue;
        if (q.wallet.weapons.size === 0) { q.wallet.weapons.add('sling'); sendTech(q); }   // silahsız kimse boss'a eli boş girmesin: SAPAN ücretsizdir (fiyat 0)
        tele(q, e.spawn, 'wait');
      }
      else if (e.t === 'toArena') for (const m of e.moves) { const q = room.players.get(m.id); if (q) { q.bhp = 100; tele(q, m, 'arena'); } }
      else if (e.t === 'hurt') {
        const q = room.players.get(e.id); if (!q || q.zone !== 'arena' || q.bhp <= 0) continue;
        if (q.admin && q.flags.god) continue;
        q.bhp = Math.max(0, q.bhp - e.dmg);
        q.sock.emit('boss:hurt', { dmg: e.dmg, k: e.k, hp: q.bhp });
        if (q.bhp <= 0) io.to(room.code).emit('boss:down', { id: q.id, name: q.name, k: e.k });
      }
      else if (e.t === 'end') io.to(room.code).emit('boss:end', { result: e.result });
      else if (e.t === 'rewards') for (const id in e.gold) { const q = room.players.get(id); if (q) addGold(q, e.gold[id]); }
      else if (e.t === 'home') for (const m of e.moves) { const q = room.players.get(m.id); if (q) { q.bhp = 100; tele(q, m, 'park'); } }
    }
  }
  function bossStep(room, dt) {
    const S = room.boss;
    if (!S) {
      if (room.state !== 'playing' || !room.bossNextAt) return;
      const left = (room.bossNextAt - Date.now()) / 1000;
      if (left <= 0) { startBoss(room); return; }
      for (const w of [60, 10]) if (left <= w && room.bossWarned !== w && (room.bossWarned === 0 || room.bossWarned > w)) { room.bossWarned = w; io.to(room.code).emit('boss:warn', { in: w }); }
      return;
    }
    const players = [...room.players.values()].map(q => ({ id: q.id, x: q.x, z: q.z, hp: q.bhp, alive: !q.dead && q.bhp > 0, zone: q.zone }));
    bossEvents(room, BossCore.tick(S, dt, players));
    io.to(room.code).emit('boss:state', BossCore.snapshot(S));
    if (S.done) { room.boss = null; }
  }

  function joinRoom(p, room, name, ownerKey) {
    p.name = uniqueName(room, name);
    p.room = room; p.spawnIdx = spawnFor(room);
    p.admin = false; p.owner = false; p.ownerTagOk = false; p.tags = { staff: false, dev: false, owner: false }; p.staff = false; p.flags = { fly: false, noclip: false, god: false }; p.hammers = new Set(); p.equipped = null;
    p.moves = 0; p.zone = 'park'; p.bhp = 100; p.lastAtk = 0;
    p.wallet = walletFor(room, p);
    if (ownerKey) {
      const ip = p.ip;
      if (lim.count('ownerfail:' + ip, 600000) >= 5) { p.keyResult = 'locked'; }
      else if (safeEq(ownerKey, CFG.ownerKey)) { p.admin = true; p.owner = true; lim.reset('ownerfail:' + ip); p.keyResult = 'ok'; }
      else { lim.hit('ownerfail:' + ip, 99, 600000); p.keyResult = 'bad'; }
    } else p.keyResult = 'none';
    room.players.set(p.id, p); p.sock.join(room.code);
    if (room.state === 'playing') placeAtSpawn(p);
  }

  /* ------------------------------------------------------------ BAĞLANTI */
  io.use((sock, next) => {
    const clientId = cleanId(sock.handshake.auth && sock.handshake.auth.clientId);
    if (!clientId) return next(new Error('bad-client'));
    if (bans.isBanned(clientId, ipOf(sock))) return next(new Error('banned'));
    sock.data.clientId = clientId; next();
  });

  io.on('connection', sock => {
    const p = {
      id: sock.id, sock, clientId: sock.data.clientId, ip: ipOf(sock), name: 'Oyuncu', room: null, admin: false,
      flags: { fly: false, noclip: false, god: false }, hammers: new Set(), equipped: null,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: false, flash: false, sprint: false, lastMoveAt: Date.now(), dead: false, spawnIdx: 0, moves: 0
    };
    byId.set(sock.id, p);
    const ok = (ack, extra) => { if (typeof ack === 'function') ack(Object.assign({ ok: true }, extra || {})); };
    const fail = (ack, error, extra) => { if (typeof ack === 'function') ack(Object.assign({ ok: false, error }, extra || {})); };
    const guard = (name, limit, win, ack) => { if (!lim.hit(name + ':' + sock.id, limit, win)) { fail(ack, 'Çok hızlı. Biraz bekle.'); return false; } return true; };

    function afterJoin(room, ack) {
      const me = { id: p.id, admin: p.admin, name: p.name, keyResult: p.keyResult };
      ok(ack, { code: room.code, you: me, room: roomView(room), spawn: room.state === 'playing' ? SPAWN_POINTS[p.spawnIdx] : null, started: room.state === 'playing' });
      pushRoom(room);
      if (room.state === 'playing') { sock.emit('room:started', { spawn: SPAWN_POINTS[p.spawnIdx] }); sendTech(p); }
    }

    sock.on('room:create', (d, ack) => {
      if (!guard('create', 5, 60000, ack)) return;
      if (p.room) return fail(ack, 'Zaten bir odadasın.');
      d = d || {};
      if (bans.isBanned(p.clientId, p.ip)) return fail(ack, 'Bu sunucudan engellendin.');
      const code = newCode(); if (!code) return fail(ack, 'Oda oluşturulamadı.');
      const room = { code, state: 'lobby', hostId: p.id, players: new Map(), createdAt: Date.now(), wallets: new Map(), boss: null, bossNextAt: 0, bossWarned: 0 };
      rooms.set(code, room);
      joinRoom(p, room, cleanName(d.name, 'Oyuncu' + crypto.randomInt(100, 999)), typeof d.ownerKey === 'string' ? d.ownerKey.slice(0, 128) : '');
      afterJoin(room, ack);
    });

    sock.on('room:join', (d, ack) => {
      d = d || {};
      const ipKey = 'joinfail:' + p.ip;
      if (lim.count(ipKey, 60000) >= 8) return fail(ack, 'Çok fazla hatalı deneme. 1 dakika bekle.');
      if (!guard('join', 12, 60000, ack)) return;
      if (p.room) return fail(ack, 'Zaten bir odadasın.');
      if (bans.isBanned(p.clientId, p.ip)) return fail(ack, 'Bu sunucudan engellendin.');
      const code = String(d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      const room = rooms.get(code);
      if (!room) { lim.hit(ipKey, 99, 60000); return fail(ack, 'Oda bulunamadı.'); }
      if (room.players.size >= CFG.maxPlayers) return fail(ack, 'Oda dolu (en fazla ' + CFG.maxPlayers + ' oyuncu).');
      joinRoom(p, room, cleanName(d.name, 'Oyuncu' + crypto.randomInt(100, 999)), typeof d.ownerKey === 'string' ? d.ownerKey.slice(0, 128) : '');
      afterJoin(room, ack);
    });

    sock.on('room:leave', (d, ack) => { removeFromRoom(p, 'left'); ok(ack); });

    sock.on('room:start', (d, ack) => {
      const room = p.room; if (!room) return fail(ack, 'Odada değilsin.');
      if (room.hostId !== p.id) return fail(ack, 'Oyunu sadece HOST başlatabilir.');
      if (room.state === 'playing') return fail(ack, 'Oyun zaten başladı.');
      room.state = 'playing'; room.bossNextAt = Date.now() + BTIM.autoEvery * 1000; room.bossWarned = 0;
      for (const q of room.players.values()) { placeAtSpawn(q); q.sock.emit('room:started', { spawn: SPAWN_POINTS[q.spawnIdx] }); sendTech(q); }
      pushRoom(room); ok(ack);
    });

    sock.on('chat:send', (d, ack) => {
      const room = p.room; if (!room) return fail(ack, 'Odada değilsin.');
      if (!guard('chat', 5, 5000, ack)) return;
      const text = cleanText(d && d.text, 140); if (!text) return fail(ack, 'Boş mesaj.');
      io.to(room.code).emit('chat:msg', { id: p.id, name: p.name, admin: p.admin, text, t: Date.now() }); ok(ack);
    });

    /* ----------------------------------------------------- HAREKET DOĞRULAMA */
    sock.on('state:move', d => {
      const room = p.room; if (!room || room.state !== 'playing' || !d || typeof d !== 'object') return;
      if (!isNum(d.x) || !isNum(d.y) || !isNum(d.z) || !isNum(d.yaw) || !isNum(d.pitch)) return;
      const now = Date.now(); const dt = clamp((now - p.lastMoveAt) / 1000, 0.015, 0.6);
      const boosted = p.admin && (p.flags.fly || p.flags.noclip);
      const vmax = boosted ? SPEED_ADMIN_MAX : SPEED_WALK_MAX;
      let nx = d.x, nz = d.z, ny = d.y;
      const inCorridor = Math.abs(nx) < 4.2;
      const zMin = inCorridor ? EXIT_Z_MIN : -BOUNDS;
      const zr = p.zone !== 'park' ? BossCore.ZONE_RECT[p.zone] : null;
      const outOfBounds = zr ? (nx < zr.x1 || nx > zr.x2 || nz < zr.z1 || nz > zr.z2) : (Math.abs(nx) > BOUNDS || nz > BOUNDS || nz < zMin);
      const maxY = (p.admin && p.flags.fly) ? 40 : 1.6;
      const badY = ny < -0.5 || ny > maxY;
      const tp = d.tp === true;
      const allowed = vmax * dt * 1.35 + 0.9 + (tp ? TP_MAX : 0);
      const dist = Math.hypot(nx - p.x, nz - p.z);
      const intoStaff = !zr && !p.staff && room.state === 'playing' && nx >= STAFF_ROOM.x1 && nx <= STAFF_ROOM.x2 && nz >= STAFF_ROOM.z1 && nz <= STAFF_ROOM.z2;
      if (outOfBounds || badY || dist > allowed || intoStaff) {
        // reddet ve istemciyi sunucunun bildiği konuma geri çek (en fazla 4/sn)
        if (lim.hit('corr:' + sock.id, 4, 1000)) sock.emit('correct', { x: p.x, y: p.y, z: p.z });
        return;
      }
      p.x = nx; p.y = ny; p.z = nz; p.lastMoveAt = now;
      p.yaw = ((d.yaw % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      p.pitch = clamp(d.pitch, -1.6, 1.6);
      p.crouch = d.crouch === true; p.flash = d.flash === true; p.sprint = d.sprint === true;
    });
    sock.on('player:died', () => { if (p.room && p.zone === 'park') p.dead = true; });
    sock.on('player:respawn', () => {
      if (!p.room || !p.dead) return;
      if (!lim.hit('respawn:' + sock.id, 2, 3000)) return;
      p.dead = false; p.x = HUT_RESPAWN.x; p.y = HUT_RESPAWN.y; p.z = HUT_RESPAWN.z; p.lastMoveAt = Date.now();
    });

    /* ----------------------------------------------------- STAFF ROOM */
    sock.on('staff:unlock', (d, ack) => {
      const room = p.room; if (!room || room.state !== 'playing') return fail(ack, 'Oyun başlamadı.');
      if (!nearKeypad(p)) return fail(ack, 'Şifre paneline yakın değilsin.');
      const ipKey = 'staff:' + p.ip;
      if (lim.count(ipKey, 60000) >= 5) return fail(ack, 'Panel kilitlendi. 1 dakika bekle.');
      const code = String(d && d.code || '').replace(/[^0-9]/g, '').slice(0, 12);
      if (!safeEq(code, CFG.staffCode)) { lim.hit(ipKey, 99, 60000); return fail(ack, 'HATALI KOD'); }
      lim.reset(ipKey);
      /* Personel Odası şifresi (sunucuda doğrulanır): bu oyuncuya kapıyı açar VE yönetici yetkisi verir.
         Erişim OYUNCU BAZLIDIR: şifreyi bilmeyen kimse odaya giremez, içindekileri göremez. */
      const becameAdmin = !p.admin, already = p.staff; p.admin = true; p.staff = true;
      sock.emit('staff:open', { by: p.name });
      pushRoom(room); ok(ack, { admin: true, becameAdmin, already });
    });

    /* ----------------------------------------------------- YÖNETİCİ */
    sock.on('admin:console', (d, ack) => {
      const room = p.room; if (!room || room.state !== 'playing') return fail(ack, 'Oyun başlamadı.');
      if (!p.admin) return fail(ack, 'Bu bilgisayar yalnızca yöneticiye açık (Personel Odası şifresini gir).');
      if (!p.staff || !inStaffRoom(p)) return fail(ack, 'Personel Odası\'nda olmalısın.');
      ok(ack, { archive: { locker: CFG.lockerCode, staff: CFG.staffCode } });
    });
    sock.on('admin:flags', (d, ack) => {
      if (!p.room) return fail(ack, 'Odada değilsin.');
      if (!p.admin) return fail(ack, 'Yetkin yok.');
      if (!guard('flags', 10, 5000, ack)) return;
      d = d || {};
      for (const k of ['fly', 'noclip', 'god']) if (typeof d[k] === 'boolean') p.flags[k] = d[k];
      ok(ack, { flags: p.flags });
    });
    /* Rütbe etiketleri (STAFF / DEVELOPER / OWNER): ismin üstünde herkese görünür. Yalnızca yönetici açabilir.
       OWNER etiketi ŞİFRELİDİR: açmak için sunucudaki OWNER_TAG_PASS şifresi gerekir (yalnızca sunucuda doğrulanır;
       istemciye hiç gönderilmez). Doğru girildikten sonra bu bağlantıda tekrar sorulmaz. Kapatmak şifresizdir. */
    sock.on('admin:tags', (d, ack) => {
      if (!p.room) return fail(ack, 'Odada değilsin.');
      if (!p.admin) return fail(ack, 'Yetkin yok.');
      if (!guard('tags', 10, 5000, ack)) return;
      d = d || {};
      if (d.owner === true && !p.tags.owner && !p.ownerTagOk) {
        if (typeof d.pass !== 'string' || !d.pass) { return ack && ack({ ok: false, needPass: true, error: 'OWNER etiketi için şifre gerekli.' }); }
        const k = 'ownertag:' + p.ip;
        if (lim.count(k, 60000) >= 5) return ack && ack({ ok: false, needPass: true, error: 'Çok fazla hatalı deneme. 1 dakika bekle.' });
        if (!safeEq(d.pass.slice(0, 100), CFG.ownerTagPass)) { lim.hit(k, 99, 60000); return ack && ack({ ok: false, needPass: true, error: 'HATALI ŞİFRE' }); }
        lim.reset(k); p.ownerTagOk = true;
      }
      for (const kk of ['staff', 'dev', 'owner']) if (typeof d[kk] === 'boolean') p.tags[kk] = d[kk];
      pushRoom(p.room); ok(ack, { tags: p.tags });
    });
    sock.on('hammer:pickup', (d, ack) => {
      const room = p.room; if (!room || room.state !== 'playing') return fail(ack, 'Oyun başlamadı.');
      if (!p.admin) return fail(ack, 'Çekiçleri yalnızca yönetici alabilir (Personel Odası şifresini gir).');
      const t = d && d.type; if (!HAMMERS.includes(t)) return fail(ack, 'Geçersiz çekiç.');
      if (!p.staff || !inStaffRoom(p)) return fail(ack, 'Çekiçler Personel Odası\'nda.');
      p.hammers.add(t); p.equipped = t; pushRoom(room); ok(ack, { equipped: t });
    });
    sock.on('hammer:equip', (d, ack) => {
      const room = p.room; if (!room) return fail(ack, 'Odada değilsin.');
      if (!p.admin) return fail(ack, 'Yetkin yok.');
      const t = d && d.type;
      if (t !== null && !HAMMERS.includes(t)) return fail(ack, 'Geçersiz çekiç.');
      if (t && room.state === 'playing' && !p.hammers.has(t)) return fail(ack, 'Bu çekici Personel Odası\'ndan almadın.');
      /* 0 / bırak: elindeki çekiç Personel Odası'ndaki yerine geri döner (tekrar alınabilir) */
      let returned = null;
      if (!t && p.equipped && room.state === 'playing') { returned = p.equipped; p.hammers.delete(returned); }
      p.equipped = t || null; pushRoom(room); ok(ack, { equipped: p.equipped, returned });
    });
    sock.on('hammer:hit', (d, ack) => {
      const room = p.room; if (!room) return fail(ack, 'Odada değilsin.');
      if (!p.admin) return fail(ack, 'Yetkin yok.');
      if (!guard('hit', 3, 2000, ack)) return;
      const t = p.equipped; if (!HAMMERS.includes(t)) return fail(ack, 'Elinde çekiç yok.');
      const target = room.players.get(String(d && d.targetId || ''));
      if (!target || target.id === p.id) return fail(ack, 'Geçersiz hedef.');
      if (target.admin) return fail(ack, 'Yöneticiye uygulanamaz.');
      if (inStaffRoom(target) && !p.staff) return fail(ack, 'Geçersiz hedef.');
      if (room.state === 'playing' && Math.hypot(target.x - p.x, target.z - p.z) > HIT_RANGE) return fail(ack, 'Hedef menzil dışında.');
      const tname = target.name;
      if (t === 'jumpscare') {   // hedefi odadan çıkarmaz; yalnızca ona korkutma efekti gönderir
        const now = Date.now();
        if (target.lastScare && now - target.lastScare < SCARE_COOLDOWN_MS) return fail(ack, 'Hedef az önce korkutuldu. Biraz bekle.');
        target.lastScare = now; target.sock.emit('jumpscare', { by: p.name });
        return ok(ack, { action: 'jumpscare', name: tname });
      }
      if (t === 'ban') bans.add(target.clientId, target.ip, tname, p.name);
      target.sock.emit(t === 'ban' ? 'banned' : 'kicked', { by: p.name });
      removeFromRoom(target, t);
      if (t === 'ban') setTimeout(() => { try { target.sock.disconnect(true); } catch (e) { /* ignore */ } }, 300);
      io.to(room.code).emit('chat:msg', { id: 'sys', name: 'SİSTEM', admin: true, text: tname + (t === 'ban' ? ' sunucudan engellendi.' : ' odadan atıldı.'), t: Date.now() });
      ok(ack, { action: t, name: tname });
    });


    /* ----------------------------------------------------- TEKNOLOJİ AĞACI + BOSS */
    sock.on('shop:buy', (d, ack) => {
      const room = p.room; if (!room || room.state !== 'playing') return fail(ack, 'Oyun başlamadı.');
      if (!guard('buy', 15, 5000, ack)) return;
      const W = BossCore.WEAPONS[String(d && d.item)]; if (!W) return fail(ack, 'Geçersiz eşya.');
      if (p.zone !== 'park' || p.dead) return fail(ack, 'Şu an alışveriş yapamazsın.');
      if (!BossCore.nearTech(p.x, p.z)) return fail(ack, 'Teknoloji ağacına yaklaş.');
      if (p.wallet.weapons.has(W.id)) return fail(ack, 'Bu eşyaya zaten sahipsin.');
      if (p.wallet.gold < W.price) return fail(ack, 'Yetersiz altın. ' + W.price + ' gerekli.');
      p.wallet.gold -= W.price; p.wallet.weapons.add(W.id); sendTech(p); ok(ack, techView(p));
    });
    sock.on('admin:gold', (d, ack) => {
      const room = p.room; if (!room || room.state !== 'playing') return fail(ack, 'Oyun başlamadı.');
      if (!p.admin) return fail(ack, 'Yetkin yok.');
      if (!p.staff || !inStaffRoom(p)) return fail(ack, 'Personel Odası\'nda olmalısın.');
      if (!guard('gold', 10, 10000, ack)) return;
      d = d || {}; const amt = Math.floor(Number(d.amount));
      if (!Number.isFinite(amt) || amt < 1 || amt > 100000) return fail(ack, 'Miktar 1 ile 100000 arasında olmalı.');
      const tg = String(d.target || 'self'); let targets = [];
      if (tg === 'all') targets = [...room.players.values()];
      else if (tg === 'self') targets = [p];
      else { const q = room.players.get(tg); if (!q) return fail(ack, 'Oyuncu bulunamadı.'); targets = [q]; }
      for (const q of targets) addGold(q, amt);
      ok(ack, { count: targets.length, names: targets.map(q => q.name).slice(0, 8), amount: amt });
    });
    sock.on('boss:start', (d, ack) => {
      const room = p.room; if (!room || room.state !== 'playing') return fail(ack, 'Oyun başlamadı.');
      if (!p.admin) return fail(ack, 'Yetkin yok.');
      if (!p.staff || !inStaffRoom(p)) return fail(ack, 'Personel Odası\'nda olmalısın.');
      if (!guard('bossstart', 3, 10000, ack)) return;
      if (room.boss) return fail(ack, 'Boss savaşı zaten sürüyor.');
      startBoss(room);
      io.to(room.code).emit('chat:msg', { id: 'sys', name: 'SİSTEM', admin: true, text: p.name + ' boss savaşını başlattı.', t: Date.now() });
      ok(ack);
    });
    sock.on('boss:info', (d, ack) => {
      const room = p.room; if (!room) return fail(ack, 'Odada değilsin.');
      ok(ack, Object.assign({ active: !!room.boss, phase: room.boss ? room.boss.phase : null,
        nextIn: room.boss || !room.bossNextAt ? null : Math.max(0, Math.round((room.bossNextAt - Date.now()) / 1000)) }, techView(p)));
    });
    sock.on('weapon:attack', (d, ack) => {
      const room = p.room, S = room && room.boss;
      if (!S || S.phase !== 'fight' || p.zone !== 'arena' || p.bhp <= 0 || !d) return fail(ack, 'Saldıramazsın.');
      const W = BossCore.WEAPONS[String(d.w)]; if (!W || !p.wallet.weapons.has(W.id)) return fail(ack, 'Bu silaha sahip değilsin.');
      if (!isNum(d.yaw) || !isNum(d.pitch)) return fail(ack, 'Geçersiz.');
      if (!guard('atk', 60, 5000, ack)) return;
      const now = Date.now(); if (now - p.lastAtk < W.cd * 1000 * 0.8) return fail(ack, 'cd');
      p.lastAtk = now;
      const r = BossCore.attackResult(S, p, W.id, d.yaw, clamp(d.pitch, -1.6, 1.6));
      if (!r.hit) return ok(ack, { hit: false });
      const res = BossCore.applyDamage(S, p.id, r.dmg);
      if (res.gold) addGold(p, res.gold);
      ok(ack, { hit: true, dmg: r.dmg, gold: res.gold });
    });

    sock.on('net:ping', (d, ack) => { if (typeof ack === 'function') ack(); });

    sock.on('disconnect', () => { removeFromRoom(p, 'disconnect'); byId.delete(sock.id); });
  });

  /* ------------------------------------------------------------ SNAPSHOT DÖNGÜSÜ (15 Hz) */
  const tick = setInterval(() => {
    for (const room of rooms.values()) {
      if (room.state !== 'playing' || room.players.size < 2) continue;
      const rows = [];
      for (const q of room.players.values()) {
        rows.push([q, [q.id, +q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2), +q.yaw.toFixed(3), +q.pitch.toFixed(3),
          (q.crouch ? 1 : 0) | (q.flash ? 2 : 0) | (q.sprint ? 4 : 0) | (q.equipped === 'kick' ? 8 : 0) | (q.equipped === 'ban' ? 16 : 0) | (q.equipped === 'jumpscare' ? 32 : 0)]]);
      }
      /* Personel Odası'ndaki oyuncular, şifreyi bilmeyenlere gönderilmez (içerisi görünmez). */
      for (const rcv of room.players.values()) {
        const arr = rows.filter(([q]) => rcv.staff || !inStaffRoom(q)).map(r => r[1]);
        io.to(rcv.id).emit('state:snap', arr);
      }
    }
  }, 66);
  tick.unref();
  let lastBoss = Date.now();
  const bossLoop = setInterval(() => {
    const now = Date.now(); const dt = Math.min(0.25, (now - lastBoss) / 1000); lastBoss = now;
    for (const room of rooms.values()) { try { bossStep(room, dt); } catch (e) { console.error('[boss]', e); room.boss = null; } }
  }, 100);
  bossLoop.unref();

  function listen(port, cb) { return httpServer.listen(port === undefined ? CFG.port : port, cb); }
  function close(cb) { clearInterval(tick); clearInterval(bossLoop); clearInterval(sweeper); io.close(() => cb && cb()); }
  return { app, httpServer, io, CFG, bans, rooms, listen, close };
}

module.exports = { createServer, SPAWN_POINTS };

if (require.main === module) {
  const s = createServer();
  s.listen(s.CFG.port, () => {
    console.log('==============================================================');
    console.log(' NÖBETÇİ: BÖLÜM 2 sunucusu çalışıyor → http://localhost:' + s.CFG.port);
    if (s.CFG.ownerKeyGenerated) {
      console.log(' OWNER_KEY ayarlanmadı; bu çalıştırma için rastgele üretildi:');
      console.log('   OWNER_KEY = ' + s.CFG.ownerKey);
      console.log(' (Kalıcı yapmak için OWNER_KEY ortam değişkenini veya server.config.json\'u kullan.)');
    } else console.log(' Sahip anahtarı yapılandırıldı (OWNER_KEY).');
    console.log(' Ban kayıtları: ' + s.CFG.bansFile);
    console.log('==============================================================');
  });
  const stop = () => s.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
