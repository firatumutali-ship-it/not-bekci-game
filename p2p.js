/* NÖBETÇİ: BÖLÜM 2 — Node.js'siz internet çoklu oyuncu (tarayıcıdan tarayıcıya, WebRTC).
 *
 * Nasıl çalışır: odayı kuran oyuncunun (HOST) tarayıcısı oyun sunucusunu çalıştırır (game-server.js, Node sunucusundaki
 * aynı mantık). Diğer oyuncular oda koduyla HOST'a WebRTC ile bağlanır. Bağlantıyı kurmak için herkese açık bir
 * "eşleştirme" sunucusu (PeerJS bulutu) kullanılır; oyun verisi doğrudan oyuncular arasında akar.
 * Sunucu kurmak, Node.js yüklemek, aynı Wi-Fi'da olmak, link/dosya göndermek GEREKMEZ: yalnızca 5 harflik oda kodu.
 *
 * Güvenlik: tüm kararlar HOST'un tarayıcısındaki game-server.js'de verilir (istemciye güvenilmez); bu dosya yalnızca
 * mesaj taşır. HOST, oyunun sahibidir: sekmesini kapatırsa oda kapanır. */
(function () {
  'use strict';
  const G = window.NobetciGame, PeerLib = window.Peer;
  const PREFIX = 'nobetci2-';
  const LS_BANS = 'nobetci2_p2p_bans';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clone = v => { if (v === undefined) return v; try { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); } catch (e) { return JSON.parse(JSON.stringify(v)); } };

  /* Eşleştirme sunucusu ayarı: varsayılan PeerJS bulutu. Test/özel için ?peer=host:port veya window.NOBETCI_PEER = {host,port,path,secure} */
  function peerOpts() {
    const o = { debug: 0 };
    let c = window.NOBETCI_PEER;
    if (!c) { try { const q = new URLSearchParams(location.search).get('peer'); if (q) { const m = /^([\w.-]+):(\d+)$/.exec(q); if (m) c = { host: m[1], port: +m[2], path: '/', secure: false }; } } catch (e) { /* ignore */ } }
    if (c) Object.assign(o, c);
    return o;
  }
  const supported = !!(G && PeerLib && typeof RTCPeerConnection !== 'undefined');

  /* Arka plandaki sekmede de düzgün çalışan zamanlayıcı (Worker): HOST başka sekmeye geçse bile oyun döngüsü yavaşlamasın. */
  function tickIv(fn, ms) {
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(function(){postMessage(0)},' + (ms | 0) + ')'], { type: 'application/javascript' }));
      const w = new Worker(url), h = { w, url }; w.onmessage = () => { try { fn(); } catch (e) { console.error(e); } };
      w.onerror = () => { try { w.terminate(); } catch (e) { /* ignore */ } h.w = null; if (!h.t) h.t = setInterval(fn, ms); };   // Worker açılamazsa normal zamanlayıcıya düş
      return h;
    } catch (e) { return { t: setInterval(fn, ms) }; }
  }
  function tickClear(h) { if (!h) return; if (h.w) { try { h.w.terminate(); } catch (e) { /* ignore */ } } try { URL.revokeObjectURL(h.url); } catch (e) { /* ignore */ } if (h.t) clearInterval(h.t); }

  /* ---------------------------------------------------------------- ortak soket tabanı (socket.io-client alt kümesi) */
  class SockBase {
    constructor() { this.h = {}; this.ioh = {}; this.acks = new Map(); this.ackN = 0; this.connected = false; this.id = ''; this.manual = false;
      this.io = { on: (ev, fn) => { (this.ioh[ev] = this.ioh[ev] || []).push(fn); } };
      this.volatile = { emit: (ev, d) => this.emit(ev, d) }; }
    on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
    _fire(ev, a, b) { for (const f of (this.h[ev] || []).slice()) { try { f(a, b); } catch (e) { console.error('[p2p]', ev, e); } } }
    _fireIo(ev) { for (const f of (this.ioh[ev] || []).slice()) { try { f(); } catch (e) { console.error('[p2p]', ev, e); } } }
    emit(ev, data, ack) {
      if (typeof data === 'function') { ack = data; data = undefined; }
      if (!this.connected) return this;
      const m = { e: ev, d: data }; if (typeof ack === 'function') { const id = ++this.ackN; this.acks.set(id, ack); m.a = id; }
      this._tx(m); return this;
    }
    timeout(ms) {
      return { emit: (ev, data, cb) => {
        let done = false; const t = setTimeout(() => { if (!done) { done = true; cb(new Error('timeout')); } }, ms);
        this.emit(ev, data, res => { if (done) return; done = true; clearTimeout(t); cb(null, res); });
      } };
    }
    _rx(m) {
      if (!m || typeof m !== 'object') return;
      if (typeof m.e === 'string') this._fire(m.e, m.d);
      else if (m.k !== undefined) { const f = this.acks.get(m.k); if (f) { this.acks.delete(m.k); try { f(m.r); } catch (e) { console.error(e); } } }
    }
  }

  /* ---------------------------------------------------------------- HOST tarafı: bellek içi "io" (Socket.IO benzeri) */
  class ServerSocket {
    constructor(io, tx, auth, address) { this.io = io; this.tx = tx; this.id = G.randomHex(10); this.data = {}; this.handshake = { auth: auth || {}, address: address || '', headers: {} };
      this.hs = {}; this.rooms = new Set(); this.closed = false; }
    on(ev, fn) { (this.hs[ev] = this.hs[ev] || []).push(fn); return this; }
    emit(ev, d) { if (!this.closed) this.tx.send({ e: ev, d }); }
    join(r) { this.rooms.add(r); let s = this.io.rooms.get(r); if (!s) this.io.rooms.set(r, s = new Set()); s.add(this); }
    leave(r) { this.rooms.delete(r); const s = this.io.rooms.get(r); if (s) { s.delete(this); if (!s.size) this.io.rooms.delete(r); } }
    disconnect() { if (this.closed) return; try { this.tx.close(); } catch (e) { /* ignore */ } this._closed('server namespace disconnect'); }
    _recv(m) {
      if (this.closed || !m || typeof m.e !== 'string' || m.e.length > 40) return;
      const hs = this.hs[m.e]; if (!hs) return;
      const ack = m.a !== undefined ? (r => { if (!this.closed) this.tx.send({ k: m.a, r }); }) : undefined;
      for (const f of hs.slice()) { try { f(m.d, ack); } catch (e) { console.error('[host]', m.e, e); if (ack) ack({ ok: false, error: 'Sunucu hatası.' }); } }
    }
    _closed(reason) {
      if (this.closed) return; this.closed = true;
      for (const r of [...this.rooms]) this.leave(r);
      this.io.socks.delete(this.id);
      for (const f of (this.hs.disconnect || []).slice()) { try { f(reason); } catch (e) { console.error(e); } }
    }
  }
  class MiniIO {
    constructor() { this.mw = []; this.ch = []; this.rooms = new Map(); this.socks = new Map(); }
    use(fn) { this.mw.push(fn); }
    on(ev, fn) { if (ev === 'connection') this.ch.push(fn); }
    to(room) { return { emit: (ev, d) => { const s = this.rooms.get(room); if (!s) return; for (const k of [...s]) k.emit(ev, d); } }; }
    /** bağlantıyı kabul eder; ara katmanlar (ban/clientId) reddederse { err } döner */
    accept(tx, auth, address) {
      const sock = new ServerSocket(this, tx, auth, address); let err = null;
      for (const fn of this.mw) { fn(sock, e => { if (e && !err) err = e; }); if (err) break; }
      if (err) return { err: err.message || 'denied' };
      this.socks.set(sock.id, sock); sock.join(sock.id);
      for (const f of this.ch) f(sock);
      return { sock };
    }
    closeAll() { for (const s of [...this.socks.values()]) s.disconnect(); }
  }

  /* HOST'un kendi istemcisi: bellek içi bağlantı (ağa çıkmaz) */
  class LocalSocket extends SockBase {
    constructor(io, cid) {
      super();
      const self = this;
      const tx = { send: m => { const c = clone(m); queueMicrotask(() => self._rx(c)); }, close: () => { self._down('io server disconnect'); } };
      const r = io.accept(tx, { clientId: cid }, 'p2p:' + cid);
      if (r.err) { queueMicrotask(() => self._fire('connect_error', new Error(r.err))); return; }
      this.srv = r.sock; this.id = r.sock.id;
      queueMicrotask(() => { if (this.manual) return; this.connected = true; this._fire('connect'); });
    }
    _tx(m) { const c = clone(m), s = this.srv; queueMicrotask(() => s._recv(c)); }
    _down(reason) { if (!this.connected) return; this.connected = false; this._fire('disconnect', reason); }
    connect() { /* bellek içi bağlantı kopmaz */ }
    disconnect() { this.manual = true; if (this.connected) { this.connected = false; this._fire('disconnect', 'io client disconnect'); } if (this.srv) this.srv._closed('client namespace disconnect'); }
  }

  /* ---------------------------------------------------------------- HOST: oda sunucusu */
  let HOST = null;
  const bansAdapter = {
    load: () => JSON.parse(localStorage.getItem(LS_BANS) || '[]'),
    save: l => localStorage.setItem(LS_BANS, JSON.stringify(l))
  };
  const rndCode = () => { let c = ''; for (let i = 0; i < 5; i++) c += G.ROOM_ALPHABET[G.randomInt(G.ROOM_ALPHABET.length)]; return c; };
  function openPeer(id) {
    return new Promise((res, rej) => {
      const p = id ? new PeerLib(id, peerOpts()) : new PeerLib(undefined, peerOpts());
      const t = setTimeout(() => { try { p.destroy(); } catch (e) { /* ignore */ } rej(Object.assign(new Error('Eşleştirme sunucusuna (peerjs.com) 15 sn içinde bağlanılamadı.'), { type: 'timeout' })); }, 15000);
      p.on('open', () => { clearTimeout(t); res(p); });
      p.on('error', e => { clearTimeout(t); try { p.destroy(); } catch (x) { /* ignore */ } rej(e && e.type && !e.message ? Object.assign(new Error(e.type), { type: e.type }) : e); });
    });
  }

  async function startHost() {
    if (HOST) return HOST;
    if (!supported) throw new Error('Bu tarayıcı WebRTC desteklemiyor (güncel Chrome/Edge/Firefox/Safari kullan).');
    let peer = null, code = '';
    for (let i = 0; i < 6 && !peer; i++) {
      code = rndCode();
      try { peer = await openPeer(PREFIX + code); } catch (e) { if (e && e.type === 'unavailable-id') continue; throw e; }
    }
    if (!peer) throw new Error('Oda kodu üretilemedi, tekrar dene.');
    const io = new MiniIO();
    const CFG = Object.assign({}, G.DEFAULTS, { ownerKey: G.randomHex(12), trustProxy: false, allowedOrigins: [], allowChosenCode: true });
    const bans = new G.BanStore(bansAdapter);
    const game = G.createGame({ io, CFG, bans, setInterval: (f, ms) => tickIv(f, ms), clearInterval: tickClear, bossTiming: window.NOBETCI_BOSS_TIMING });
    const H = { code, peer, io, game, CFG, bans, conns: new Set(), stopped: false, hostKey: CFG.ownerKey };
    HOST = H;

    peer.on('disconnected', () => { if (H.stopped) return; let n = 0; const t = setInterval(() => { if (H.stopped || !peer.disconnected || ++n > 30) return clearInterval(t); try { peer.reconnect(); } catch (e) { /* ignore */ } }, 3000); });
    peer.on('error', e => { if (e && e.type !== 'peer-unavailable') console.warn('[p2p host]', e.type || e); });
    peer.on('connection', conn => {
      let sock = null, tx = null, rx = 0, rxT = performance.now(), lastRx = performance.now();
      H.conns.add(conn);
      const dropT = setTimeout(() => { if (!sock) { try { conn.close(); } catch (e) { /* ignore */ } } }, 10000);   // selamlaşmayan bağlantıyı at
      const hb = tickIv(() => {
        if (conn.open) { try { conn.send({ t: 'p' }); } catch (e) { /* ignore */ } }
        if (performance.now() - lastRx > 20000) { try { conn.close(); } catch (e) { /* ignore */ } }
      }, 3000);
      const cleanup = reason => { clearTimeout(dropT); tickClear(hb); H.conns.delete(conn); if (sock) sock._closed(reason); sock = null; };
      conn.on('close', () => cleanup('transport close'));
      conn.on('error', () => cleanup('transport error'));
      conn.on('data', m => {
        const now = performance.now(); lastRx = now;
        if (now - rxT > 1000) { rxT = now; rx = 0; } if (++rx > 500) { try { conn.close(); } catch (e) { /* ignore */ } return; }   // sel (flood) koruması
        if (!m || typeof m !== 'object') return;
        if (m.t === 'p') return;
        if (!sock) {
          tx = { send: x => { try { if (conn.open) conn.send(x); } catch (e) { /* ignore */ } }, close: () => { try { conn.close(); } catch (e) { /* ignore */ } } };
          const cid = G.cleanId(m.cid);
          if (m.t === 'unban') { handleUnban(H, cid, m.code, tx); return; }
          if (m.t !== 'hello' || !cid) { tx.send({ t: 'err', m: 'bad-client' }); return; }
          const r = io.accept(tx, { clientId: cid }, 'p2p:' + cid);
          if (r.err) { tx.send({ t: 'err', m: r.err }); setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 400); return; }
          sock = r.sock; clearTimeout(dropT); tx.send({ t: 'ok', id: sock.id });
          return;
        }
        sock._recv(m);
      });
    });
    return H;
  }
  /* Engelli oyuncunun ban açması: şifre HOST'ta doğrulanır (bağlantı kurulamadığı için selamlaşma aşamasında) */
  function handleUnban(H, cid, code, tx) {
    const k = 'unbanfail:' + cid;
    if (!cid || typeof code !== 'string') { tx.send({ t: 'unban', ok: false, error: 'Geçersiz istek.' }); return; }
    if (H.game.lim.count(k, 600000) >= 5) { tx.send({ t: 'unban', ok: false, error: 'Çok fazla hatalı deneme. 10 dakika bekle.' }); return; }
    if (!G.safeEq(code.slice(0, 100), H.CFG.unbanCode)) { H.game.lim.hit(k, 99, 600000); tx.send({ t: 'unban', ok: false, error: 'HATALI ŞİFRE' }); return; }
    H.game.lim.reset(k); const n = H.bans.remove(cid, 'p2p:' + cid);
    tx.send({ t: 'unban', ok: true, removed: n });
  }
  function stopHost() {
    const H = HOST; if (!H) return; HOST = null; H.stopped = true;
    try { H.game.close(); } catch (e) { /* ignore */ }
    for (const c of [...H.conns]) { try { if (c.open) c.send({ t: 'bye' }); } catch (e) { /* ignore */ } }   // misafirlere "oda kapandı" bildirimi
    setTimeout(() => {
      try { H.io.closeAll(); } catch (e) { /* ignore */ }
      for (const c of [...H.conns]) { try { c.close(); } catch (e) { /* ignore */ } }
      try { H.peer.destroy(); } catch (e) { /* ignore */ }
    }, 600);
  }
  function hostSocket(cid) { if (!HOST) throw new Error('Host başlatılmadı.'); return new LocalSocket(HOST.io, cid); }

  /* ---------------------------------------------------------------- GUEST: HOST'a bağlanan istemci soketi */
  class GuestSocket extends SockBase {
    constructor(code, cid) {
      super(); this.code = code; this.cid = cid; this.peer = null; this.conn = null; this.tries = 0; this.everConnected = false; this.busy = false; this.hb = null; this.lastRx = 0; this.failSince = 0;
      this._connect();
    }
    _tx(m) { try { if (this.conn && this.conn.open) this.conn.send(m); } catch (e) { /* ignore */ } }
    _cleanup() {
      if (this.hb) { tickClear(this.hb); this.hb = null; }
      if (this.conn) { try { this.conn.close(); } catch (e) { /* ignore */ } this.conn = null; }
      if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } this.peer = null; }
    }
    async _connect() {
      if (this.manual || this.busy) return; this.busy = true;
      if (this.tries > 0) this._fireIo('reconnect_attempt');
      let fatal = null;
      try {
        const peer = await openPeer(null); if (this.manual) { try { peer.destroy(); } catch (e) { /* ignore */ } return; }
        this.peer = peer;
        const conn = await new Promise((res, rej) => {
          const c = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
          const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { type: 'timeout' })), 20000);
          c.on('open', () => { clearTimeout(t); res(c); });
          c.on('error', e => { clearTimeout(t); rej(e); });
          peer.on('error', e => { clearTimeout(t); rej(e); });
        });
        if (this.manual) { this._cleanup(); return; }
        this.conn = conn; this.lastRx = performance.now();
        const reply = await new Promise((res, rej) => {
          const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { type: 'timeout' })), 10000);
          conn.on('data', m => {
            this.lastRx = performance.now();
            if (!m || typeof m !== 'object' || m.t === 'p') return;
            if (m.t === 'bye') { this.manual = true; this.connected = false; this._cleanup(); this._fire('host-gone'); return; }   // HOST odayı bilerek kapattı
            if (m.t === 'ok' || m.t === 'err') { clearTimeout(t); res(m); return; }
            if (this.connected) this._rx(m);
          });
          conn.on('close', () => { clearTimeout(t); rej(Object.assign(new Error('closed'), { type: 'closed' })); this._dropped('transport close'); });
          conn.on('error', () => { clearTimeout(t); rej(Object.assign(new Error('error'), { type: 'error' })); });
          conn.send({ t: 'hello', cid: this.cid, v: 1 });
        });
        if (reply.t === 'err') { fatal = new Error(reply.m || 'denied'); throw fatal; }
        this.id = reply.id; this.connected = true; this.everConnected = true; this.tries = 0; this.failSince = 0;
        this.hb = tickIv(() => {
          this._tx({ t: 'p' });
          if (performance.now() - this.lastRx > 20000) { try { this.conn && this.conn.close(); } catch (e) { /* ignore */ } this._dropped('ping timeout'); }
        }, 3000);
        this._fire('connect');
      } catch (e) {
        this._cleanup();
        if (this.manual) { this.busy = false; return; }
        const notFound = e && e.type === 'peer-unavailable';
        if (fatal || (notFound && !this.everConnected)) { this.busy = false; this._fire('connect_error', fatal || new Error('not-found')); return; }   // yeniden deneme yok
        if (!this.failSince) this.failSince = Date.now();
        if (this.everConnected && Date.now() - this.failSince > 45000) { this.busy = false; this._fire('host-gone'); return; }   // host geri gelmedi: oda kapandı
        this._fire('connect_error', new Error(e && e.type === 'timeout' ? 'timeout' : (e && e.type) || 'network'));
        this.busy = false; this.tries++;
        setTimeout(() => this._connect(), Math.min(4000, 700 * this.tries));
        return;
      }
      this.busy = false;
    }
    _dropped(reason) {
      if (this.manual || !this.connected) return;
      this.connected = false; if (this.hb) { tickClear(this.hb); this.hb = null; }
      this.acks.clear(); this._fire('disconnect', reason); this._cleanup();
      this.busy = false; if (!this.failSince) this.failSince = Date.now(); this.tries = 1; setTimeout(() => this._connect(), 700);
    }
    connect() { if (!this.connected && !this.busy && !this.manual) this._connect(); }
    disconnect() { this.manual = true; const was = this.connected; this.connected = false; this._cleanup(); if (was) this._fire('disconnect', 'io client disconnect'); }
  }

  /* Engellenmiş oyuncunun ban açma isteği (HOST'a tek seferlik bağlantı) */
  async function unban(code, cid, pass) {
    let peer = null;
    try {
      peer = await openPeer(null);
      return await new Promise(res => {
        const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        const t = setTimeout(() => res({ ok: false, error: 'Host\'a ulaşılamadı.' }), 15000);
        c.on('open', () => c.send({ t: 'unban', cid, code: pass }));
        c.on('data', m => { if (m && m.t === 'unban') { clearTimeout(t); res(m); } });
        c.on('error', () => { clearTimeout(t); res({ ok: false, error: 'Host\'a ulaşılamadı.' }); });
        peer.on('error', () => { clearTimeout(t); res({ ok: false, error: 'Host\'a ulaşılamadı (oda açık mı?).' }); });
      });
    } catch (e) { return { ok: false, error: 'Eşleştirme sunucusuna ulaşılamadı.' }; }
    finally { try { peer && peer.destroy(); } catch (e) { /* ignore */ } }
  }

  window.NobetciP2P = {
    supported,
    startHost, stopHost, hostSocket,
    hostInfo: () => HOST ? { code: HOST.code, hostKey: HOST.hostKey } : null,
    guest: (code, cid) => { const g = new GuestSocket(code, cid); window.NobetciP2P._debug.guestSock = g; return g; },
    unban,
    _debug: { get host() { return HOST; }, guestSock: null }
  };
})();
