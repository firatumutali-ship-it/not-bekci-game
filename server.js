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
const { createGame, BanStore, SPAWN_POINTS, safeEq, cleanId } = require('./public/game-server.js');   // oyun mantığı (tarayıcıda P2P modunda da kullanılır)

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
    allowChosenCode: false,
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

/* ------------------------------------------------------------ BAN DEPOLAMA (dosya) */
const fileBans = file => ({
  load: () => JSON.parse(fs.readFileSync(file, 'utf8')),
  save: list => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 2)); fs.renameSync(tmp, file); }
});

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

  const bans = new BanStore(fileBans(CFG.bansFile));
  const game = createGame({ io, CFG, bans, bossTiming: overrides && overrides.bossTiming });   // oyun mantığı: public/game-server.js (tarayıcıda da çalışır)
  const rooms = game.rooms, lim = game.lim;

  function listen(port, cb) { return httpServer.listen(port === undefined ? CFG.port : port, cb); }
  function close(cb) { game.close(); io.close(() => cb && cb()); }
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
