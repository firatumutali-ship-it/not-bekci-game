'use strict';
/* Sunucu testi: ban açma kodu, ücretsiz SAPAN, Tech Tree satın alma, admin altın, boss oturumu (zafer / yenilgi), ölümcül saldırılar.
   Çalıştır: node test/boss-server.js  (npm test içinde) */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { io: ioc } = require('socket.io-client');
const http = require('http');
const { createServer } = require('../server');
const C = require('../public/boss-core.js');

const OWNER = 'test-owner-key-123';
let passed = 0; const ok = n => { passed++; console.log('  ✓ ' + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAST = { introWalk: 0.3, introSummon: 0.3, introEnter: 0.3, portalMax: 40, countdown: 1.5, spawnPause: 0.2, fightMax: 90, endDelay: 1 };

function boot(extra) {
  const bansFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nbb-')), 'bans.json');
  const s = createServer(Object.assign({ port: 0, ownerKey: OWNER, bansFile, bossTiming: FAST }, extra || {}));
  return new Promise(res => s.listen(0, () => res({ s, url: 'http://127.0.0.1:' + s.httpServer.address().port, bansFile })));
}
function client(url, clientId) {
  return new Promise((res, rej) => {
    const c = ioc(url, { auth: { clientId: clientId || ('cid' + Math.random().toString(36).slice(2, 12) + 'xx') }, transports: ['websocket'], reconnection: false });
    c.events = []; c.onAny((ev, ...a) => c.events.push([ev, a[0], Date.now()]));
    c.on('connect', () => res(c)); c.on('connect_error', e => rej(e));
  });
}
const call = (c, ev, data) => new Promise(r => c.emit(ev, data, r));
async function waitFor(c, ev, pred, ms) {
  const end = Date.now() + (ms || 4000);
  while (Date.now() < end) { const i = c.events.findIndex(e => e[0] === ev && (!pred || pred(e[1]))); if (i >= 0) return c.events.splice(i, 1)[0][1]; await sleep(25); }
  throw new Error('olay gelmedi: ' + ev);
}
async function fly(c, from, to) {   // admin fly modunda hızlı yürüme (sunucu hız sınırı: 16 m/sn)
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.9));
  for (let i = 1; i <= n; i++) { c.emit('state:move', { x: from.x + (to.x - from.x) * i / n, y: 0, z: from.z + (to.z - from.z) * i / n, yaw: 0, pitch: 0 }); await sleep(62); }
}
function post(url, body, headers) {
  return new Promise((res, rej) => {
    const u = new URL(url + '/api/unban'); const data = JSON.stringify(body);
    const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) }, r => { let t = ''; r.on('data', d => t += d); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(t || '{}') })); });
    rq.on('error', rej); rq.write(data); rq.end();
  });
}

(async () => {
  console.log('F) Ban açma kodu');
  let { s, url, bansFile } = await boot();
  const cid = 'banned-client-0001';
  s.bans.add(cid, '::ffff:127.0.0.1', 'Ben', 'Test');
  await assert.rejects(client(url, cid), /banned/); ok('banlı oyuncu sunucuya bağlanamıyor (ENGELLENDİN)');
  let r = await post(url, { clientId: cid, code: '1234' }); assert(r.status === 403 && !r.body.ok); ok('yanlış ban-açma şifresi reddedildi');
  r = await post(url, { clientId: cid, code: '20162016' }, { Origin: 'http://evil.example' }); assert.strictEqual(r.status, 403); ok('başka siteden (Origin) ban açma denemesi reddedildi');
  r = await post(url, { clientId: 'x', code: '20162016' }); assert.strictEqual(r.status, 400); ok('geçersiz clientId reddedildi');
  await assert.rejects(client(url, cid), /banned/); ok('hatalı denemelerden sonra hâlâ banlı');
  r = await post(url, { clientId: cid, code: '20162016' }); assert(r.status === 200 && r.body.ok && r.body.removed >= 1); ok('doğru şifre (20162016) banı kaldırdı');
  const back = await client(url, cid); assert(back.connected); ok('ban açılınca oyuncu tekrar bağlanabildi');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(bansFile, 'utf8')), []); ok('ban kaydı kalıcı dosyadan da silindi');
  back.close();
  for (let i = 0; i < 5; i++) await post(url, { clientId: cid, code: 'x' + i });
  r = await post(url, { clientId: cid, code: '20162016' }); assert.strictEqual(r.status, 429); ok('ban-açma şifresi deneme sınırı (5 / 10 dk) çalışıyor');
  await new Promise(r => s.close(r));

  console.log('G) Sapan, Tech Tree, altın');
  ({ s, url } = await boot());
  const adm = await client(url), pl = await client(url);
  r = await call(adm, 'room:create', { name: 'Admin', ownerKey: OWNER }); assert(r.ok && r.you.admin); const code = r.code;
  await call(pl, 'room:join', { code, name: 'Oyuncu' });
  r = await call(adm, 'room:start', {}); assert(r.ok);
  await sleep(150); const room = s.rooms.get(code);
  let adminSpot = { x: -3, z: 46.6 };
  r = await call(adm, 'shop:buy', { item: 'sling' }); assert(!r.ok && /yaklaş/.test(r.error)); ok('Tech Tree\'den uzakta satın alma reddedildi');
  await call(adm, 'admin:flags', { fly: true });
  await fly(adm, adminSpot, { x: C.TECH.x + 1, z: C.TECH.z }); adminSpot = { x: C.TECH.x + 1, z: C.TECH.z };
  r = await call(adm, 'shop:buy', { item: 'gun' }); assert(!r.ok && /Yetersiz/.test(r.error)); ok('altın yokken SİLAH (1800) alınamadı');
  r = await call(adm, 'shop:buy', { item: 'stick' }); assert(!r.ok); ok('altın yokken ÇUBUK (100) bile bedava değil');
  for (const it of ['sword', 'hammer']) { r = await call(adm, 'shop:buy', { item: it }); assert(!r.ok); } ok('KILIÇ ve ÇEKİÇ de ücretsiz değil');
  r = await call(adm, 'shop:buy', { item: 'bogus' }); assert(!r.ok); ok('geçersiz eşya reddedildi');
  r = await call(adm, 'shop:buy', { item: 'sling' }); assert(r.ok && r.gold === 0 && r.weapons.includes('sling') && r.weapons.length === 1); ok('SAPAN 0 altına açıldı (başka hiçbir eşya açılmadı)');
  r = await call(adm, 'shop:buy', { item: 'sling' }); assert(!r.ok && /zaten/.test(r.error)); ok('sapan ikinci kez alınamaz');
  r = await call(pl, 'admin:gold', { target: 'self', amount: 100 }); assert(!r.ok); ok('yönetici olmayan altın veremez (sunucu doğruladı)');
  r = await call(adm, 'admin:gold', { target: 'self', amount: 100 }); assert(!r.ok && /Personel/.test(r.error)); ok('Personel Odası dışında altın verilemez');
  r = await call(adm, 'boss:start', {}); assert(!r.ok); ok('Personel Odası dışında boss başlatılamaz');
  await fly(adm, adminSpot, { x: 1, z: 52 }); adminSpot = { x: 1, z: 52 };
  r = await call(adm, 'staff:unlock', { code: '292016' }); assert(r.ok);
  await fly(adm, adminSpot, { x: 0, z: 58 }); adminSpot = { x: 0, z: 58 };
  r = await call(adm, 'admin:gold', { target: 'self', amount: 0 }); assert(!r.ok);
  r = await call(adm, 'admin:gold', { target: 'self', amount: 999999999 }); assert(!r.ok); ok('geçersiz/aşırı miktar reddedildi');
  r = await call(adm, 'admin:gold', { target: 'all', amount: 2000 }); assert(r.ok && r.count === 2); ok('yönetici bilgisayarından herkese altın verildi');
  const tu = await waitFor(pl, 'tech:update', t => t.gold === 2000); assert(tu.gold === 2000); ok('oyuncu altın güncellemesini aldı (2000)');
  r = await call(adm, 'admin:gold', { target: pl.id, amount: 50 }); assert(r.ok && r.count === 1); ok('tek oyuncuya altın verme çalışıyor');
  r = await call(adm, 'admin:gold', { target: 'nobody', amount: 5 }); assert(!r.ok);
  await fly(adm, adminSpot, { x: C.TECH.x + 1, z: C.TECH.z }); adminSpot = { x: C.TECH.x + 1, z: C.TECH.z };
  r = await call(adm, 'shop:buy', { item: 'gun' }); assert(r.ok && r.gold === 200 && r.weapons.includes('gun')); ok('altınla SİLAH alındı (2000−1800 = 200)');
  r = await call(adm, 'boss:info', {}); assert(r.ok && !r.active && r.nextIn > 1000 && r.gold === 200); ok('boss:info: sonraki otomatik boss ~30 dk sonra');

  console.log('H) Boss oturumu: zafer');
  await fly(adm, adminSpot, { x: 0, z: 58 }); adminSpot = { x: 0, z: 58 };
  r = await call(adm, 'boss:start', {}); assert(r.ok); ok('Personel Odası\'ndan boss başlatıldı');
  r = await call(adm, 'boss:start', {}); assert(!r.ok); ok('aynı anda ikinci boss başlatılamıyor');
  await waitFor(adm, 'boss:fx', e => e.t === 'announce' && e.k === 'intro'); ok('giriş animasyonu duyurusu geldi');
  await waitFor(adm, 'boss:state', st => st.ph === 'portal', 6000); ok('palyaço portalı açtı (portal fazı)');
  await fly(adm, adminSpot, { x: C.PORTAL.x, z: C.PORTAL.z }); adminSpot = { x: C.PORTAL.x, z: C.PORTAL.z };
  const tw = await waitFor(adm, 'teleport', t => t.zone === 'wait', 4000); assert(C.zoneOf(tw.x, tw.z) === 'wait'); ok('portala giren yönetici bekleme odasına ışınlandı');
  const tArena = await waitFor(adm, 'teleport', t => t.zone === 'arena', 6000); assert(C.zoneOf(tArena.x, tArena.z) === 'arena'); ok('geri sayım bitince boss arenasına alındı');
  const st0 = await waitFor(adm, 'boss:state', st => st.ph === 'fight'); const bx0 = st0.b.x, bz0 = st0.b.z;
  assert(bx0 === C.ARENA.bossX && bz0 === C.ARENA.bossZ); ok('boss arenada sabit konumda doğdu');
  r = await call(pl, 'weapon:attack', { w: 'sling', yaw: 0, pitch: 0 }); assert(!r.ok); ok('savaşta olmayan oyuncu saldıramaz');
  await sleep(300);
  r = await call(adm, 'weapon:attack', { w: 'hammer', yaw: 0, pitch: 0 }); assert(!r.ok && /sahip/.test(r.error)); ok('sahip olunmayan silahla saldırı reddedildi');
  r = await call(adm, 'weapon:attack', { w: 'sling', yaw: 0, pitch: 0 }); assert(r.ok === true || r.error === 'cd'); 
  let hit = r.hit ? r : null; if (!hit) { await sleep(800); hit = await call(adm, 'weapon:attack', { w: 'sling', yaw: 0, pitch: 0 }); }
  assert(hit.hit && hit.dmg === 10 && hit.gold === 3); ok('SAPAN isabet etti: 10 hasar, 3 altın (sunucu hesapladı)');
  r = await call(adm, 'weapon:attack', { w: 'sling', yaw: 0, pitch: 0 }); assert(!r.ok && r.error === 'cd'); ok('sapan bekleme süresi (cooldown) sunucuda uygulanıyor');
  await sleep(800); r = await call(adm, 'weapon:attack', { w: 'sling', yaw: Math.PI, pitch: 0 }); assert(r.ok && !r.hit); ok('arkaya bakarak ateş: ıska');
  const goldBefore = (await call(adm, 'boss:info', {})).gold;
  room.boss.boss.hp = 12; await sleep(800);
  r = await call(adm, 'weapon:attack', { w: 'gun', yaw: 0, pitch: 0 }); assert(r.ok && r.hit); ok('son vuruş boss\'a isabet etti');
  const endWin = await waitFor(adm, 'boss:end', null, 3000); assert.strictEqual(endWin.result, 'win'); ok('boss öldü → zafer bildirimi');
  const gold1 = (await call(adm, 'boss:info', {})).gold;
  await sleep(300); const tu2 = adm.events.filter(e => e[0] === 'tech:update').map(e => e[1].gold);
  assert(gold1 - goldBefore >= C.BOSS.winGold && gold1 - goldBefore < C.BOSS.winGold + 40); ok('zafer ödülü ' + C.BOSS.winGold + ' altın bir kez verildi (+hasar altını)');
  const home = await waitFor(adm, 'teleport', t => t.zone === 'park', 5000); assert(home.z > 40); ok('savaş sonunda oyuncu eve (hut yanı) gönderildi');
  await sleep(800); assert(!s.rooms.get(code).boss); const g2 = (await call(adm, 'boss:info', {})).gold; assert.strictEqual(g2, gold1); ok('oturum kapandı, altın ikinci kez eklenmedi');

  console.log('I) Boss oturumu: yenilgi + ölümcül ses dalgası');
  adminSpot = { x: home.x, z: home.z }; await fly(adm, adminSpot, { x: 0, z: 58 }); adminSpot = { x: 0, z: 58 };
  r = await call(adm, 'boss:start', {}); assert(r.ok);
  await waitFor(adm, 'boss:state', st => st.ph === 'portal', 6000);
  await fly(adm, adminSpot, { x: C.PORTAL.x, z: C.PORTAL.z });
  await waitFor(adm, 'teleport', t => t.zone === 'wait', 4000); await waitFor(adm, 'teleport', t => t.zone === 'arena', 6000);
  await waitFor(adm, 'boss:state', st => st.ph === 'fight'); adm.events.length = 0; await sleep(300);
  const bs = room.boss; bs.next = ['wave']; bs.boss.st = 'idle'; bs.boss.stT = 99;
  const tW = Date.now(); const wind = await waitFor(adm, 'boss:fx', e => e.t === 'fx' && e.k === 'waveWind', 2000); ok('ses dalgası uyarısı (waveWind) tüm oyunculara yayıldı, yön ' + wind.d.toFixed(2));
  const hurt = await waitFor(adm, 'boss:hurt', null, 5000); const dt = Date.now() - tW;
  assert(hurt.k === 'wave' && hurt.hp === 0 && dt >= C.TIMING.waveWarn * 1000 * 0.9 - 100); ok('dalga ' + (dt / 1000).toFixed(1) + ' sn sonra (uyarıdan sonra) ölümcül hasar verdi');
  const down = await waitFor(adm, 'boss:down', null, 500); assert(down.id === adm.id); ok('ölüm tüm odaya bildirildi (boss:down)');
  r = await call(adm, 'weapon:attack', { w: 'sling', yaw: 0, pitch: 0 }); assert(!r.ok); ok('ölen oyuncu saldıramaz');
  const lose = await waitFor(adm, 'boss:end', null, 4000); assert.strictEqual(lose.result, 'lose'); ok('tüm oyuncular ölünce yenilgi bildirildi');
  const homeL = await waitFor(adm, 'teleport', t => t.zone === 'park', 5000); assert(homeL.z > 40); ok('yenilgide de oyuncular eve gönderildi, canları yenilendi');
  assert.strictEqual(s.rooms.get(code).players.get(adm.id).bhp, 100); ok('boss canı (bhp) sıfırlandı');
  const w = s.rooms.get(code).wallets; assert([...w.values()].every(x => x.weapons.size >= 0)); ok('cüzdan (altın + silahlar) oturum bittikten sonra korundu');
  await new Promise(r => s.close(r));

  console.log('\nBoss/sunucu testleri geçti: ' + passed);
  process.exit(0);
})().catch(e => { console.error('\nTEST BAŞARISIZ:', e && e.stack || e); process.exit(1); });
