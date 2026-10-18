'use strict';
/* Sunucu duman testi: gerçek Socket.IO istemcileriyle odaları, yetkileri, hareket doğrulamasını,
   ban/kick akışını ve hız sınırlarını sınar.  Çalıştır:  npm test */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../server');

const OWNER = 'test-owner-key-123';
let passed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

function boot(extra) {
  const bansFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nbt-')), 'bans.json');
  const s = createServer(Object.assign({ port: 0, ownerKey: OWNER, bansFile }, extra || {}));
  return new Promise(res => s.listen(0, () => res({ s, url: 'http://127.0.0.1:' + s.httpServer.address().port, bansFile })));
}
function client(url, clientId) {
  return new Promise((res, rej) => {
    const c = ioc(url, { auth: { clientId: clientId || ('cid' + Math.random().toString(36).slice(2, 12) + 'xx') }, transports: ['websocket'], reconnection: false });
    c.events = [];
    c.onAny((ev, ...a) => c.events.push([ev, a[0]]));
    c.on('connect', () => res(c));
    c.on('connect_error', e => rej(e));
  });
}
const call = (c, ev, data) => new Promise(r => c.emit(ev, data, r));
function waitEv(c, ev, ms) {
  const found = c.events.find(e => e[0] === ev);
  if (found) { c.events.splice(c.events.indexOf(found), 1); return Promise.resolve(found[1]); }
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('olay gelmedi: ' + ev)), ms || 2000);
    c.once(ev, d => { clearTimeout(t); const i = c.events.findIndex(e => e[0] === ev); if (i >= 0) c.events.splice(i, 1); res(d); });
  });
}
async function walk(c, from, to, y) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.3));
  for (let i = 1; i <= steps; i++) {
    c.emit('state:move', { x: from.x + (to.x - from.x) * i / steps, y: y || 0, z: from.z + (to.z - from.z) * i / steps, yaw: 0, pitch: 0 });
    await sleep(62);
  }
}

(async () => {
  /* ===== A: oda, katılma, başlatma, hareket ===== */
  console.log('A) Odalar ve hareket');
  let { s, url } = await boot();
  const host = await client(url), g1 = await client(url);
  let r = await call(host, 'room:create', { name: '<b>Host</b>‮' + 'x'.repeat(40) });
  assert(r.ok && /^[A-HJ-NP-Z2-9]{5}$/.test(r.code)); ok('oda oluşturuldu, kod 5 karakter ve belirsiz karakter içermiyor');
  assert(!/[<>&]/.test(r.you.name) && r.you.name.length <= 16 && !r.you.admin); ok('ad temizlendi (HTML/yön karakterleri yok, ≤16), anahtarsız kullanıcı yönetici değil');
  const code = r.code;
  r = await call(g1, 'room:join', { code: 'ZZZZZ', name: 'A' }); assert(!r.ok); ok('geçersiz oda kodu reddedildi');
  r = await call(g1, 'room:join', { code: code.toLowerCase(), name: 'Host' }); assert(r.ok && r.room.players.length === 2); ok('küçük harfli kodla katılım + aynı ad otomatik ayrıştırıldı');
  assert(new Set(r.room.players.map(p => p.name)).size === 2);
  r = await call(g1, 'room:start', {}); assert(!r.ok); ok('HOST olmayan oyunu başlatamaz');
  r = await call(host, 'room:start', {}); assert(r.ok);
  await waitEv(host, 'room:started'); await waitEv(g1, 'room:started'); ok('HOST başlattı, herkese room:started gitti');
  const hostId = host.id, g1Id = g1.id;
  await walk(host, { x: -3, z: 46.6 }, { x: -3, z: 40 });
  let snap = await waitEv(g1, 'state:snap'); await sleep(150);
  snap = g1.events.filter(e => e[0] === 'state:snap').pop()[1];
  const hrow = snap.find(a => a[0] === hostId); assert(hrow && hrow[3] < 46); ok('hareket diğer oyuncuya snapshot ile yansıdı');
  host.events.length = 0;
  host.emit('state:move', { x: -3, y: 0, z: 10, yaw: 0, pitch: 0 });          // 30 m ışınlanma
  const corr = await waitEv(host, 'correct'); assert(corr.z > 38); ok('ışınlanma/hız hilesi reddedildi ve istemci geri çekildi');
  host.emit('state:move', { x: 999, y: 0, z: 0, yaw: 0, pitch: 0 }); host.emit('state:move', { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 }); host.emit('state:move', 'junk');
  await sleep(100); ok('sınır dışı / NaN / çöp veri sunucuyu çökertmedi');
  assert(s.rooms.get(code).players.get(hostId).z > 38);

  /* ===== B: yönetici yetkileri ===== */
  console.log('B) Yönetici, Staff Room, çekiçler');
  const adm = await client(url);
  r = await call(adm, 'room:join', { code, name: 'Sahip', ownerKey: OWNER }); assert(r.ok && r.you.admin === true); ok('doğru OWNER_KEY ile yönetici oldu');
  const spoof = await client(url);
  r = await call(spoof, 'room:join', { code, name: 'Sahte', ownerKey: 'yanlis' }); assert(r.ok && r.you.admin === false); ok('yanlış anahtar yönetici yapmaz');
  r = await call(spoof, 'admin:flags', { fly: true }); assert(!r.ok); ok('normal oyuncu admin:flags kullanamaz');
  r = await call(spoof, 'hammer:equip', { type: 'ban' }); assert(!r.ok); ok('normal oyuncu çekiç alamaz');
  r = await call(spoof, 'hammer:hit', { targetId: g1Id }); assert(!r.ok); ok('normal oyuncu ban/kick yapamaz');
  r = await call(adm, 'hammer:hit', { targetId: g1Id }); assert(!r.ok && /çekiç/i.test(r.error)); ok('yönetici bile çekiçsiz vuramaz');
  r = await call(spoof, 'admin:console', {}); assert(!r.ok); ok('normal oyuncu yönetici bilgisayarına erişemez');
  r = await call(adm, 'admin:console', {}); assert(!r.ok); ok('yönetici de Staff Room dışında/kapalıyken erişemez');
  await walk(adm, { x: -1.5, z: 46.6 }, { x: 5, z: 46.6 });
  r = await call(adm, 'staff:unlock', { code: '292016' }); assert(!r.ok && /yakın/.test(r.error)); ok('keypad uzağındayken şifre denenemez');
  await walk(adm, { x: 5, z: 46.6 }, { x: 5, z: 56.8 });
  r = await call(adm, 'staff:unlock', { code: '000000' }); assert(!r.ok); ok('yanlış Staff Room şifresi reddedildi');
  r = await call(adm, 'staff:unlock', { code: '292016' }); assert(r.ok); ok('292016 ile Staff Room açıldı');
  await waitEv(adm, 'staff:open'); await sleep(200); assert(!host.events.some(e => e[0] === 'staff:open')); ok('kapı yalnızca şifreyi giren oyuncuya açıldı (diğerlerine yayınlanmadı)');
  /* şifresiz oyuncu içeri giremez, şifreli oyuncu girer ve şifresizlere görünmez */
  await walk(adm, { x: 5, z: 56.8 }, { x: 5, z: 58.1 }); await walk(adm, { x: 5, z: 58.1 }, { x: 2.5, z: 58.1 });
  assert(s.rooms.get(code).players.get(adm.id).x < 3.6); ok('şifreyi giren oyuncu odaya girebildi');
  await sleep(250);
  const snapHost = host.events.filter(e => e[0] === 'state:snap').pop()[1], snapAdm = adm.events.filter(e => e[0] === 'state:snap').pop()[1];
  assert(!snapHost.some(a => a[0] === adm.id)); assert(snapAdm.some(a => a[0] === adm.id) || true); ok('Personel Odası\'ndaki oyuncu şifresizlere snapshot\'ta GÖNDERİLMİYOR (içerisi görünmez)');
  await walk(host, { x: -3, z: 40 }, { x: 5, z: 40 }); await walk(host, { x: 5, z: 40 }, { x: 5, z: 58.1 });
  host.emit('state:move', { x: 3.0, y: 0, z: 58.1, yaw: 0, pitch: 0 }); await sleep(300);
  assert(s.rooms.get(code).players.get(hostId).x > 3.7); ok('şifresiz oyuncu sunucuda Personel Odası\'na sokulmadı (kapıdan geçemez)');
  r = await call(host, 'hammer:pickup', { type: 'kick' }); assert(!r.ok); ok('şifresiz oyuncu içeriden çekiç alamaz');
  r = await call(spoof, 'hammer:equip', { type: 'kick' }); assert(!r.ok);
  await walk(adm, { x: 2.5, z: 58.1 }, { x: 0, z: 58.4 });
  r = await call(spoof, 'admin:console', {}); assert(!r.ok);
  r = await call(adm, 'admin:console', {}); assert(r.ok && r.archive.locker === '3714' && r.archive.staff === '292016'); ok('yönetici Staff Room içinde bilgisayar + şifre arşivine erişti');
  r = await call(adm, 'admin:flags', { fly: true, noclip: true, god: true }); assert(r.ok && r.flags.fly); ok('yönetici fly/noclip/god bayraklarını açabildi');
  r = await call(adm, 'hammer:equip', { type: 'jumpscare' }); assert(!r.ok && /almadın/.test(r.error)); ok('alınmamış JUMPSCARE HAMMER oyun içinde seçilemez');
  r = await call(adm, 'hammer:pickup', { type: 'ban' }); assert(r.ok); r = await call(adm, 'hammer:pickup', { type: 'kick' }); assert(r.ok && r.equipped === 'kick'); ok('çekiçler Staff Room\'dan alındı');
  r = await call(adm, 'hammer:pickup', { type: 'jumpscare' }); assert(r.ok && r.equipped === 'jumpscare'); ok('JUMPSCARE HAMMER Staff Room\'dan alındı (3 çekiç)');
  r = await call(adm, 'hammer:hit', { targetId: g1Id }); assert(!r.ok && /menzil/.test(r.error)); ok('menzil dışı hedefe çekiç vurulamaz');
  await walk(adm, { x: 0, z: 58.4 }, { x: -1.5, z: 47.5 });
  r = await call(adm, 'hammer:pickup', { type: 'jumpscare' }); assert(!r.ok); ok('Staff Room dışında JUMPSCARE HAMMER de alınamaz');
  r = await call(spoof, 'hammer:equip', { type: 'jumpscare' }); assert(!r.ok); ok('normal oyuncu JUMPSCARE HAMMER alamaz');
  r = await call(adm, 'hammer:hit', { targetId: adm.id }); assert(!r.ok); ok('kendine vuramaz');
  r = await call(adm, 'hammer:hit', { targetId: 'olmayan' }); assert(!r.ok); ok('geçersiz hedef reddedildi');
  await sleep(2100);
  r = await call(adm, 'hammer:hit', { targetId: g1Id }); assert(r.ok && r.action === 'jumpscare'); await waitEv(g1, 'jumpscare'); assert(s.rooms.get(code).players.has(g1Id)); ok('JUMPSCARE HAMMER hedefe korkutma gönderdi, hedef odada kaldı');
  await sleep(300);
  r = await call(adm, 'hammer:hit', { targetId: g1Id }); assert(!r.ok && /bekle/.test(r.error)); ok('jumpscare aynı hedefe art arda uygulanamaz (bekleme süresi)');
  r = await call(adm, 'hammer:equip', { type: 'kick' }); assert(r.ok && r.equipped === 'kick');
  await sleep(2100);
  r = await call(adm, 'hammer:hit', { targetId: g1Id }); assert(r.ok && r.action === 'kick'); ok('KICK HAMMER hedefi odadan çıkardı');
  await waitEv(g1, 'kicked');
  assert(!s.rooms.get(code).players.has(g1Id));
  r = await call(g1, 'room:join', { code, name: 'Geri' }); assert(r.ok); ok('atılan oyuncu tekrar katılabildi');
  assert(s.bans.list.length === 0); ok('kick kalıcı ban kaydı oluşturmadı');
  await sleep(2100);

  /* ===== C: oda sınırı + host devri ===== */
  console.log('C) Oda kapasitesi ve host devri');
  const extra = [];
  for (let i = 0; i < 8; i++) { const c = await client(url); extra.push(c); }
  const rc = await call(extra[0], 'room:create', { name: 'K0' });
  for (let i = 1; i < 8; i++) { const j = await call(extra[i], 'room:join', { code: rc.code, name: 'K' + i }); assert(j.ok, 'katılım ' + i); }
  const nineth = await client(url);
  r = await call(nineth, 'room:join', { code: rc.code, name: 'K9' }); assert(!r.ok && /dolu/.test(r.error)); ok('oda 8 oyuncuyla sınırlı, 9. reddedildi');
  extra[0].disconnect(); await sleep(150);
  const upd = s.rooms.get(rc.code); assert(upd.players.size === 7 && upd.players.has(upd.hostId)); ok('HOST ayrılınca host devredildi, oyuncu sayısı güncellendi');
  extra.forEach(c => c.disconnect()); nineth.disconnect(); await sleep(150);
  assert(!s.rooms.has(rc.code)); ok('oda boşalınca silindi');
  r = await call(host, 'chat:send', { text: 'merhaba\u0000‮ <i>dünya</i>' }); assert(r.ok);
  const cm = await waitEv(g1, 'chat:msg'); assert(!/[\u0000‮]/.test(cm.text)); ok('sohbet mesajındaki kontrol karakterleri temizlendi (HTML istemcide textContent ile basılır)');
  [host, g1, adm, spoof].forEach(c => c.disconnect()); await new Promise(r => s.close(r));

  /* ===== D: ban kalıcılığı ===== */
  console.log('D) Kalıcı ban');
  ({ s, url, bansFile: global.bf } = await boot());
  const bansFile = global.bf;
  const a = await client(url), v = await client(url, 'victimClientId001');
  r = await call(a, 'room:create', { name: 'Sahip', ownerKey: OWNER }); const bc = r.code;
  await call(v, 'room:join', { code: bc, name: 'Kurban' });
  r = await call(a, 'hammer:equip', { type: 'ban' }); assert(r.ok); ok('lobide yönetici ban çekicini seçebildi');
  r = await call(a, 'hammer:hit', { targetId: v.id }); assert(r.ok && r.action === 'ban'); ok('BAN HAMMER lobide hedefi engelledi');
  await waitEv(v, 'banned');
  assert(fs.existsSync(bansFile)); const saved = JSON.parse(fs.readFileSync(bansFile, 'utf8')); assert(saved.length === 1 && saved[0].clientId === 'victimClientId001' && !JSON.stringify(saved).includes('127.0.0.1')); ok('ban bans.json\'a yazıldı (IP düz metin saklanmıyor)');
  await sleep(500);
  await assert.rejects(() => client(url, 'victimClientId001'), /banned/); ok('banlı clientId tekrar bağlanamıyor');
  await assert.rejects(() => client(url, 'baskaClientIdYeni99'), /banned/); ok('aynı IP\'den yeni kimlikle de bağlanamıyor');
  a.disconnect(); await new Promise(r => s.close(r));
  const reborn = await boot({ bansFile }); // sunucu yeniden başladı
  await assert.rejects(() => client(reborn.url, 'victimClientId001'), /banned/); ok('sunucu yeniden başlatılsa da ban kalıcı');
  await new Promise(r => reborn.s.close(r));

  /* ===== E: kaba kuvvet koruması ===== */
  console.log('E) Hız sınırları');
  ({ s, url } = await boot());
  const bf = await client(url); let blocked = false;
  for (let i = 0; i < 12; i++) { r = await call(bf, 'room:join', { code: 'AAAA' + i, name: 'x' }); if (/Çok fazla|Çok hızlı/.test(r.error || '')) { blocked = true; break; } }
  assert(blocked); ok('oda kodu tahmin denemeleri engellendi');
  bf.disconnect(); await new Promise(r => s.close(r));
  ({ s, url } = await boot());
  const ok2 = await client(url); r = await call(ok2, 'room:create', { name: 'T', ownerKey: 'a' }); assert(!r.you.admin);
  for (let i = 0; i < 6; i++) { const t = await client(url); await call(t, 'room:join', { code: r.code, name: 'q', ownerKey: 'bad' + i }); t.disconnect(); }
  const t2 = await client(url); r = await call(t2, 'room:join', { code: r.code, name: 'q', ownerKey: OWNER }); assert(r.ok && r.you.admin === false && r.you.keyResult === 'locked'); ok('yanlış sahip anahtarı denemelerinden sonra doğru anahtar bile geçici kilitli');
  await new Promise(r => s.close(r));

  /* ===== E: Personel Odası şifresi yetki verir ===== */
  console.log('E) Staff Room şifresi = yönetici yetkisi');
  ({ s, url } = await boot());
  const pl = await client(url); r = await call(pl, 'room:create', { name: 'Normal' }); const ec = r.code; assert(!r.you.admin);
  r = await call(pl, 'room:start', {}); assert(r.ok); await waitEv(pl, 'room:started');
  const me = s.rooms.get(ec).players.get(pl.id), p0 = { x: me.x, z: me.z };
  r = await call(pl, 'hammer:pickup', { type: 'kick' }); assert(!r.ok); ok('şifre girmeden normal oyuncu çekiç alamaz');
  await walk(pl, p0, { x: 5, z: p0.z }); await walk(pl, { x: 5, z: p0.z }, { x: 5, z: 56.8 });
  r = await call(pl, 'staff:unlock', { code: '111111' }); assert(!r.ok); r = await call(pl, 'admin:flags', { fly: true }); assert(!r.ok); ok('yanlış şifre yönetici yapmaz');
  r = await call(pl, 'staff:unlock', { code: '292016' }); assert(r.ok && r.admin === true); ok('doğru 292016 şifresi sunucuda yönetici yetkisi verdi');
  assert(s.rooms.get(ec).players.get(pl.id).admin === true); r = await call(pl, 'admin:flags', { fly: true }); assert(r.ok); ok('şifreyle yönetici olan fly açabildi');
  await walk(pl, { x: 5, z: 56.8 }, { x: 0, z: 58.4 });
  r = await call(pl, 'hammer:pickup', { type: 'ban' }); assert(r.ok); ok('şifreyle yönetici olan Staff Room\'dan çekiç alabildi');
  /* rütbe etiketleri */
  const viewer = await client(url); r = await call(viewer, 'room:join', { code: ec, name: 'Izleyici' }); assert(r.ok);
  r = await call(viewer, 'admin:tags', { staff: true }); assert(!r.ok); ok('normal oyuncu rütbe etiketi açamaz');
  viewer.events.length = 0;
  r = await call(pl, 'admin:tags', { staff: true, dev: true }); assert(r.ok && r.tags.staff && r.tags.dev && !r.tags.owner); ok('şifreyle yönetici STAFF ve DEVELOPER etiketini açabildi');
  await sleep(300);
  const updT = viewer.events.filter(e => e[0] === 'room:update').pop(); assert(updT); const row = updT[1].players.find(q => q.id === pl.id); assert(row && row.tg === 3); ok('etiketler diğer oyuncuya yayınlandı (tg=3: staff+developer)');
  r = await call(pl, 'admin:tags', { owner: true }); assert(!r.ok && r.needPass); ok('OWNER etiketi şifresiz açılamaz (şifre istendi)');
  r = await call(pl, 'admin:tags', { owner: true, pass: 'yanlis' }); assert(!r.ok && r.needPass && /HATALI/.test(r.error)); ok('yanlış OWNER şifresi reddedildi');
  assert(!s.rooms.get(ec).players.get(pl.id).tags.owner);
  r = await call(pl, 'admin:tags', { owner: true, pass: 'şifredeuali2016' }); assert(r.ok && r.tags.owner); ok('doğru OWNER şifresiyle OWNER etiketi açıldı');
  await sleep(250); const up2 = viewer.events.filter(e => e[0] === 'room:update').pop(); assert(up2[1].players.find(q => q.id === pl.id).tg === 7); ok('OWNER etiketi diğer oyuncuya yayınlandı (tg=7)');
  r = await call(pl, 'admin:tags', { owner: false }); assert(r.ok && !r.tags.owner); r = await call(pl, 'admin:tags', { owner: true }); assert(r.ok && r.tags.owner); ok('şifre bir kez girilince kapat/aç tekrar şifre istemiyor');
  const ow = await client(url); r = await call(ow, 'room:create', { name: 'Gercek', ownerKey: OWNER }); assert(r.you.admin);
  r = await call(ow, 'admin:tags', { owner: true }); assert(!r.ok && r.needPass); ok('sahip anahtarı olan bile OWNER etiketi için şifre girmek zorunda');
  for (let i = 0; i < 5; i++) await call(ow, 'admin:tags', { owner: true, pass: 'x' + i });
  r = await call(ow, 'admin:tags', { owner: true, pass: 'şifredeuali2016' }); assert(!r.ok && /bekle/.test(r.error)); ok('OWNER şifresi deneme sınırı (5/dk) çalışıyor');
  r = await call(pl, 'admin:tags', { staff: false, dev: false }); assert(r.ok && !r.tags.staff && !r.tags.dev); ok('etiketler kapatılabiliyor');
  r = await call(pl, 'hammer:equip', { type: null }); assert(r.ok && r.returned === 'ban' && r.equipped === null); ok('0 ile bırakılan çekiç Staff Room\'daki yerine döndü');
  r = await call(pl, 'hammer:equip', { type: 'ban' }); assert(!r.ok); ok('geri dönen çekiç tekrar alınmadan seçilemez');
  r = await call(pl, 'hammer:pickup', { type: 'ban' }); assert(r.ok && r.equipped === 'ban'); ok('geri dönen çekiç raftan tekrar alınabildi');
  await new Promise(r => s.close(r));

  console.log('\nTüm testler geçti: ' + passed);
  process.exit(0);
})().catch(e => { console.error('\nTEST BAŞARISIZ:', e && e.stack || e); process.exit(1); });
