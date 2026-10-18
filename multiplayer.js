/* NÖBETÇİ: BÖLÜM 2 — çok oyunculu ağ istemcisi (Socket.IO).
 * index.html içindeki oyun window.NobetciAPI üzerinden bu dosyaya bağlanır.
 * Güvenlik notu: bu dosya hiçbir yetki kararı vermez; yönetici, çekiç, ban/kick, Staff Room şifresi ve hareket
 * doğrulaması SUNUCUDA yapılır (server.js). İstemci yalnızca istek gönderir ve sunucunun cevabını uygular. */
(function () {
  'use strict';
  const API = window.NobetciAPI;
  if (!API) return;
  const $ = id => document.getElementById(id);
  const show = id => $(id).classList.remove('hid');
  const hide = id => $(id).classList.add('hid');
  const LS_NAME = 'nobetci2_mpname', LS_CID = 'nobetci2_cid';
  const HN = { kick: 'KICK HAMMER', ban: 'BAN HAMMER', jumpscare: 'JUMPSCARE HAMMER' };

  function getCid() {
    try {
      let c = localStorage.getItem(LS_CID);
      if (c && /^[A-Za-z0-9_-]{8,64}$/.test(c)) return c;
      c = (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : (Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2))).slice(0, 40);
      if (c.length < 8) c = 'cid' + c + Date.now().toString(36);
      localStorage.setItem(LS_CID, c); return c;
    } catch (e) { return 'tmp' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  }

  const S = { sock: null, room: null, me: null, code: '', name: '', ownerKey: '', inGame: false, leaving: false, dropped: false, hammer: null, pingMs: null, sendT: null, pingT: null };

  /* ---------------------------------------------------------------- bağlantı durumu */
  function setNet(kind) {
    const el = $('netstat'); el.className = ''; el.textContent = '';
    const dot = document.createElement('i'); el.appendChild(dot);
    if (kind === 'online') { el.classList.add('on'); el.appendChild(document.createTextNode('BAĞLI' + (S.pingMs != null ? ' • ' + S.pingMs + ' ms' : ''))); }
    else if (kind === 'offline') { el.classList.add('off'); el.appendChild(document.createTextNode('BAĞLANTI KOPTU — yeniden bağlanılıyor…')); }
    else el.appendChild(document.createTextNode('SUNUCUYA BAĞLANIYOR…'));
  }
  const hideNet = () => hide('netstat');
  const mpMsg = t => { $('mpMsg').textContent = t || ''; };
  const lobbyMsg = t => { $('lMsg').textContent = t || ''; };

  function emitAck(ev, data, cb) {
    if (!S.sock || !S.sock.connected) { cb({ ok: false, error: 'Sunucuya bağlı değilsin.' }); return; }
    S.sock.timeout(5000).emit(ev, data, (err, res) => cb(err ? { ok: false, error: 'Sunucu yanıt vermedi.' } : (res || { ok: false, error: 'Boş yanıt.' })));
  }

  /* ---------------------------------------------------------------- oyuna verilen ağ arayüzü */
  const netApi = {
    died: () => { if (S.sock) S.sock.emit('player:died'); },
    respawn: () => { if (S.sock) S.sock.emit('player:respawn'); },
    unlock: (code, cb) => emitAck('staff:unlock', { code }, cb),
    console: cb => emitAck('admin:console', {}, cb),
    flags: (f, cb) => emitAck('admin:flags', f, cb),
    tags: (t, cb) => emitAck('admin:tags', t, cb),
    pickup: (type, cb) => emitAck('hammer:pickup', { type }, cb),
    equip: (type, cb) => emitAck('hammer:equip', { type }, cb),
    hit: (targetId, cb) => emitAck('hammer:hit', { targetId }, cb),
    chat: text => emitAck('chat:send', { text }, () => {}),
    leave: () => { S.leaving = true; if (S.sock) S.sock.emit('room:leave'); }
  };

  /* ---------------------------------------------------------------- yardımcı UI */
  function addLobbyChat(name, text, admin) {
    const log = $('lChat'), d = document.createElement('div'), b = document.createElement('b');
    b.textContent = name + ': '; if (admin) b.style.color = '#e0c060';
    d.appendChild(b); d.appendChild(document.createTextNode(text)); log.appendChild(d);
    while (log.children.length > 40) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  function showExpelled(title, text) {
    S.leaving = true; S.inGame = false; stopSend(); API.freeze();
    hide('lobby'); hide('mpMenu'); hide('netstat');
    $('kTitle').textContent = title; $('kText').textContent = text; show('kicked');
  }
  $('kBack').onclick = () => location.reload();

  function renderLobby() {
    const room = S.room; if (!room) return;
    $('lCode').textContent = room.code;
    $('lCount').textContent = '(' + room.players.length + '/' + room.max + ')';
    const me = room.players.find(p => p.id === (S.sock && S.sock.id));
    const iAmAdmin = !!(me && me.admin), iAmHost = !!(me && me.host);
    S.hammer = me ? me.hammer : null;
    const list = $('lPlayers'); list.textContent = '';
    for (const p of room.players) {
      const row = document.createElement('div'); row.className = 'prow';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name; row.appendChild(nm);
      const badge = (t, c) => { const b = document.createElement('span'); b.className = 'badge ' + (c || ''); b.textContent = t; row.appendChild(b); };
      if (p.host) badge('HOST', 'host'); if (p.admin) badge('YÖNETİCİ', 'adm'); if (me && p.id === me.id) badge('SEN');
      if (iAmAdmin && me && p.id !== me.id && !p.admin) {
        row.classList.add('target');
        row.onclick = () => lobbyHit(p);
      }
      list.appendChild(row);
    }
    $('lHam').classList.toggle('hid', !iAmAdmin);
    for (const [id, t] of [['hKick', 'kick'], ['hBan', 'ban'], ['hScare', 'jumpscare']]) $(id).classList.toggle('sel', S.hammer === t);
    $('lStart').style.display = iAmHost ? 'block' : 'none';
    if (!iAmHost) $('lStart').style.display = 'none';
    if (!$('lMsg').textContent) lobbyMsg(iAmHost ? 'Herkes hazır olunca OYUNU BAŞLAT\'a bas.' : 'Oyunu başlatması için HOST bekleniyor…');
  }
  function lobbyHit(p) {
    if (!S.hammer) { lobbyMsg('Önce bir çekiç seç (KICK / BAN / JUMPSCARE).'); return; }
    if (S.hammer !== 'jumpscare' && !confirm(p.name + (S.hammer === 'ban' ? ' sunucudan ENGELLENSİN mi?' : ' odadan atılsın mı?'))) return;
    emitAck('hammer:hit', { targetId: p.id }, r => lobbyMsg(r.ok ? (r.name + (r.action === 'ban' ? ' engellendi.' : r.action === 'jumpscare' ? ' korkutuldu!' : ' odadan atıldı.')) : r.error));
  }
  function selHammer(t) {
    emitAck('hammer:equip', { type: S.hammer === t ? null : t }, r => { if (r.ok) { S.hammer = r.equipped; lobbyMsg(r.equipped ? HN[r.equipped] + ' seçildi — bir oyuncunun adına tıkla.' : 'Çekiç bırakıldı.'); renderLobby(); } else lobbyMsg(r.error); });
  }
  $('hKick').onclick = () => selHammer('kick'); $('hBan').onclick = () => selHammer('ban'); $('hScare').onclick = () => selHammer('jumpscare');
  $('lStart').onclick = () => emitAck('room:start', {}, r => { if (!r.ok) lobbyMsg(r.error); });
  $('lLeave').onclick = () => { if (S.sock) S.sock.emit('room:leave'); S.code = ''; S.room = null; S.me = null; hide('lobby'); show('mpMenu'); mpMsg(''); };
  $('lCopy').onclick = () => { const c = S.code; try { navigator.clipboard.writeText(c); lobbyMsg('Oda kodu kopyalandı: ' + c); } catch (e) { lobbyMsg('Oda kodu: ' + c); } };
  $('lChatIn').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { const t = $('lChatIn').value.trim(); if (t) emitAck('chat:send', { text: t }, () => {}); $('lChatIn').value = ''; }
  });

  /* ---------------------------------------------------------------- Socket.IO */
  function startPing() {
    stopPing();
    S.pingT = setInterval(() => {
      if (!S.sock || !S.sock.connected) return; const t = performance.now();
      S.sock.timeout(4000).emit('net:ping', null, err => { if (err) return; S.pingMs = Math.round(performance.now() - t); setNet('online'); });
    }, 2500);
  }
  function stopPing() { if (S.pingT) { clearInterval(S.pingT); S.pingT = null; } }
  function startSend() {
    stopSend();
    S.sendT = setInterval(() => {
      if (!S.inGame || !S.sock || !S.sock.connected) return;
      const st = API.getState(); if (st) S.sock.volatile.emit('state:move', st);
    }, 66);
  }
  function stopSend() { if (S.sendT) { clearInterval(S.sendT); S.sendT = null; } }

  function rejoin() {
    S.dropped = false;
    S.sock.timeout(6000).emit('room:join', { code: S.code, name: S.name, ownerKey: S.ownerKey }, (err, r) => {
      if (err || !r || !r.ok) { showExpelled('BAĞLANTI KOPTU', (r && r.error) || 'Odaya yeniden bağlanılamadı. Oda kapanmış olabilir.'); return; }
      S.room = r.room; S.me = r.you; API.setSelf(S.sock.id); API.setAdmin(r.you.admin); renderLobby();
      if (S.inGame) { API.msg('Yeniden bağlandın.', 3); API.remoteSync(r.room.players); }
    });
  }

  function connect() {
    if (S.sock) return S.sock;
    setNet('connecting'); show('netstat');
    API.setNet(netApi);
    const sock = io({ auth: { clientId: getCid() }, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 700, reconnectionDelayMax: 4000, timeout: 8000 });
    S.sock = sock;
    sock.on('connect', () => { API.setSelf(sock.id); setNet('online'); startPing(); if (S.dropped && S.code && !S.leaving) rejoin(); });
    sock.on('disconnect', reason => { stopPing(); if (S.leaving) return; setNet('offline'); if (S.code) S.dropped = true; if (reason === 'io server disconnect') setTimeout(() => { if (S.sock === sock && !S.leaving) sock.connect(); }, 1000); });
    sock.io.on('reconnect_attempt', () => { if (!S.leaving) setNet(S.dropped ? 'offline' : 'connecting'); });
    sock.on('connect_error', err => {
      if (err && err.message === 'banned') { sock.disconnect(); S.sock = null; hideNet(); showExpelled('ENGELLENDİN', 'Bu sunucudan kalıcı olarak engellendin.'); return; }
      setNet(S.dropped ? 'offline' : 'connecting'); if (!S.code) mpMsg('Sunucuya ulaşılamıyor… yeniden deneniyor.');
    });
    sock.on('room:update', room => {
      S.room = room; API.setSelf(sock.id);
      const me = room.players.find(p => p.id === sock.id); if (me) { S.me = me; API.setAdmin(me.admin); API.setTags(me.tg); }
      if (S.inGame) API.remoteSync(room.players);
      renderLobby();
    });
    sock.on('room:started', d => {
      hide('lobby'); hide('mpMenu');
      if (!S.inGame) { S.inGame = true; API.setNet(netApi); API.startMP(d && d.spawn); API.remoteSync(S.room ? S.room.players : []); startSend(); }
      else if (d && d.spawn) API.teleport(d.spawn.x, d.spawn.y || 0, d.spawn.z);
    });
    sock.on('state:snap', arr => { if (S.inGame && Array.isArray(arr)) API.remoteSnap(arr); });
    sock.on('player:left', d => { if (d && d.id) API.remoteRemove(d.id); });
    sock.on('chat:msg', d => { if (!d) return; addLobbyChat(d.name, d.text, d.admin); if (S.inGame) API.chat(d.name, d.text, d.admin); });
    sock.on('staff:open', () => { API.setAdmin(true); API.setStaffOpen(true); });   // yalnızca şifreyi giren oyuncuya gelir; başkalarının kapısı kapalı kalır
    sock.on('correct', d => { if (S.inGame && d) API.teleport(d.x, d.y, d.z); });
    sock.on('jumpscare', () => API.jumpscare());
    sock.on('kicked', d => showExpelled('ODADAN ATILDIN', (d && d.by ? d.by : 'Oyun sahibi') + ' seni odadan attı. İstersen tekrar katılabilirsin.'));
    sock.on('banned', d => showExpelled('ENGELLENDİN', (d && d.by ? d.by : 'Oyun sahibi') + ' seni sunucudan engelledi.'));
    return sock;
  }

  function whenConnected(ok, fail) {
    connect();
    if (S.sock.connected) { ok(); return; }
    let n = 0; const t = setInterval(() => {
      if (S.sock && S.sock.connected) { clearInterval(t); ok(); } else if (++n > 40) { clearInterval(t); fail(); }
    }, 200);
  }
  function busy(b) { $('mpCreate').disabled = b; $('mpJoin').disabled = b; }
  function readForm() {
    const name = ($('mpName').value || '').trim().slice(0, 16);
    try { localStorage.setItem(LS_NAME, name); } catch (e) { /* kayıt yoksa sorun değil */ }
    S.name = name; S.ownerKey = $('mpKey').value || '';
  }
  function enterLobby(r) {
    S.room = r.room; S.me = r.you; S.code = r.code; S.leaving = false; S.dropped = false;
    API.setSelf(S.sock.id); API.setAdmin(r.you.admin); API.setStaffOpen(false);
    hide('mpMenu'); show('lobby'); $('lChat').textContent = '';
    lobbyMsg(r.you.keyResult === 'bad' ? 'Sahip anahtarı yanlış — normal oyuncu olarak katıldın.' : r.you.keyResult === 'locked' ? 'Çok fazla hatalı anahtar denemesi — geçici olarak kilitlendi.' : r.you.admin ? 'Oyun sahibi olarak doğrulandın.' : '');
    renderLobby();
  }
  $('mpCreate').onclick = () => {
    readForm(); API.initAudio(); busy(true); mpMsg('Oda oluşturuluyor…');
    whenConnected(() => emitAck('room:create', { name: S.name, ownerKey: S.ownerKey }, r => { busy(false); if (!r.ok) { mpMsg(r.error); return; } mpMsg(''); enterLobby(r); }), () => { busy(false); mpMsg('Sunucuya bağlanılamadı.'); });
  };
  $('mpJoin').onclick = () => {
    readForm(); API.initAudio(); const code = ($('mpCode').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) { mpMsg('Oda kodu 5 karakter olmalı.'); return; }
    busy(true); mpMsg('Katılınıyor…');
    whenConnected(() => emitAck('room:join', { code, name: S.name, ownerKey: S.ownerKey }, r => { busy(false); if (!r.ok) { mpMsg(r.error); return; } mpMsg(''); enterLobby(r); }), () => { busy(false); mpMsg('Sunucuya bağlanılamadı.'); });
  };
  $('mpCode').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') $('mpJoin').click(); });
  for (const id of ['mpName', 'mpKey', 'lChatIn']) $(id).addEventListener('keydown', e => e.stopPropagation());
  $('mpBack').onclick = () => { hide('mpMenu'); if (S.sock && !S.code) { S.leaving = true; S.sock.disconnect(); S.sock = null; S.leaving = false; hideNet(); } };
  $('bMP').onclick = () => {
    API.initAudio(); show('mpMenu'); mpMsg('');
    try { $('mpName').value = localStorage.getItem(LS_NAME) || ''; } catch (e) { /* ignore */ }
    if (typeof io === 'undefined') { const mm = $('mpMsg'); mm.style.whiteSpace = 'pre-line'; mm.style.fontSize = '15px'; mm.style.lineHeight = '1.5';
      mpMsg('⚠ index.html dosyasını çift tıklayarak açtın; multiplayer böyle çalışmaz.\n1) Node.js kur (nodejs.org)\n2) Proje klasöründe: npm install  →  npm start\n   (Windows: start.bat dosyasına çift tıkla)\n3) Tarayıcıda şunu aç: http://localhost:3000'); $('mpCreate').disabled = true; $('mpJoin').disabled = true; return; }
    connect();
  };
})();
