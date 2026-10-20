/* Boss çekirdeği birim testleri: node test/boss-core.js */
const assert = require('assert');
const C = require('../public/boss-core.js');
let passed = 0; const ok = n => { passed++; console.log('  ✓ ' + n); };
const FAST = { introWalk: 0.5, introSummon: 0.5, introEnter: 0.5, portalMax: 5, countdown: 2, spawnPause: 0.2, fightMax: 60, endDelay: 0.5 };
function host(players, e) {   // sunucunun/istemcinin yaptığı gibi olayları anında uygula
  const mv = (id, m, zone) => { const p = players.find(q => q.id === id); if (p) { p.x = m.x; p.z = m.z; p.zone = zone; } };
  if (e.t === 'enter') mv(e.id, e.spawn, 'wait');
  if (e.t === 'toArena') e.moves.forEach(m => mv(m.id, m, 'arena'));
  if (e.t === 'home') e.moves.forEach(m => mv(m.id, m, 'park'));
}
function run(S, players, secs, onEv, dt = 0.05) { const all = []; for (let t = 0; t < secs && !S.done; t += dt) { const ev = C.tick(S, dt, players); for (const e of ev) { all.push(e); host(players, e); if (onEv && onEv(e) === 'stop') return all; } } return all; }
const P = (id, x, z, zone) => ({ id, x, z, hp: 100, alive: true, zone: zone || C.zoneOf(x, z) });

console.log('A) Silahlar ve bölgeler');
assert.deepStrictEqual(C.ORDER, ['sling', 'gun', 'sword', 'hammer', 'stick']); ok('ağaç sırası: SAPAN (ilk) + 1 silah, 2 kılıç, 3 çekiç, 4 çubuk');
assert.strictEqual(C.WEAPONS.sling.price, 0); assert(C.ORDER.filter(k => C.WEAPONS[k].price === 0).length === 1); ok('yalnızca SAPAN ücretsiz (fiyat 0), diğer hiçbir eşya bedava değil');
const pr = ['gun', 'sword', 'hammer', 'stick'].map(k => C.WEAPONS[k].price); assert(pr.every((v, i) => v > 0 && (i === 0 || pr[i - 1] > v))); ok('maddi değer sırası azalıyor (silah > kılıç > çekiç > çubuk), hepsi ücretli');
assert(['gun', 'sword', 'hammer', 'stick'].every((k, i) => C.WEAPONS[k].slot === i + 1) && C.WEAPONS.sling.slot === 5); ok('slotlar: silah 1, kılıç 2, çekiç 3, çubuk 4, sapan 5');
assert(C.WEAPONS.sling.ranged && C.WEAPONS.sling.dmg < C.WEAPONS.stick.dmg + 1 && C.WEAPONS.sling.dmg >= 8); assert(C.BOSS.hp1 / (C.WEAPONS.sling.dmg / C.WEAPONS.sling.cd) > 120); ok('sapan dengeli: boss\'u tek başına en az 2 dakikada (≈' + Math.round(C.BOSS.hp1 / (C.WEAPONS.sling.dmg / C.WEAPONS.sling.cd)) + ' sn) öldürebilir, hemen değil');
assert.strictEqual(C.zoneOf(0, 0), 'park'); assert.strictEqual(C.zoneOf(160, 0), 'arena'); assert.strictEqual(C.zoneOf(160, -60), 'wait'); ok('bölge tespiti (park / arena / bekleme odası)');
assert(C.nearTech(-9.5, 50) && !C.nearTech(0, 0)); ok('tech tree yakınlık kontrolü');

console.log('B) Zaman çizelgesi');
{
  const S = C.createSession({ timing: FAST }); const p1 = P('a', 0, 40);
  const evs = run(S, [p1], 1.6, null);
  assert(evs.some(e => e.t === 'announce' && e.k === 'intro')); assert.strictEqual(S.phase, 'portal'); ok('intro bitti → portal açık');
  assert.strictEqual(S.portal, 1); assert.strictEqual(S.boss.vis, false); ok('palyaço portala girip kayboldu');
  p1.x = 0; p1.z = 3;
  let entered = null; run(S, [p1], 0.2, e => { if (e.t === 'enter') entered = e; });
  assert(entered && entered.id === 'a'); assert.strictEqual(S.phase, 'wait'); ok('portala giren oyuncu bekleme odasına alındı, geri sayım başladı');
  assert(C.zoneOf(entered.spawn.x, entered.spawn.z) === 'wait'); ok('bekleme odası doğuş noktası bölge içinde');
  p1.x = entered.spawn.x; p1.z = entered.spawn.z; p1.zone = 'wait';
  let toArena = null; run(S, [p1], 3, e => { if (e.t === 'toArena') toArena = e; });
  assert(toArena && toArena.moves[0].id === 'a'); assert.strictEqual(S.phase, 'fight'); ok('geri sayım bitince savaş başladı, oyuncu arenaya alındı');
  assert.strictEqual(S.boss.maxHp, C.BOSS.hp1); ok('tek oyuncu için boss HP = ' + C.BOSS.hp1);
}
{
  const S = C.createSession({ timing: Object.assign({}, FAST, { portalMax: 1 }) }); const p1 = P('a', 0, 40);
  const evs = run(S, [p1], 5); assert(evs.some(e => e.t === 'end' && e.result === 'cancel')); assert(S.done); ok('kimse girmezse oturum iptal oldu');
}
{
  const S = C.createSession({ timing: FAST }); const a = P('a', 0, 3), b = P('b', 1, 3), c = P('c', 0, 40);
  const hist = []; run(S, [a, b, c], 1.8, e => { if (e.t === 'enter') hist.push(e.id); });
  assert.deepStrictEqual(hist.sort(), ['a', 'b']); ok('portala yakın iki oyuncu girdi, uzaktaki girmedi');
  a.zone = b.zone = 'wait'; let mv = null; run(S, [a, b, c], 3, e => { if (e.t === 'toArena') mv = e; });
  assert.strictEqual(mv.moves.length, 2); assert.strictEqual(S.boss.maxHp, C.BOSS.hp1 + C.BOSS.hpPer); ok('2 oyuncu: boss HP büyüdü (' + S.boss.maxHp + ')');
}

console.log('C) Boss yapay zekâsı ve saldırı isabeti');
function fightSession() {
  const S = C.createSession({ timing: FAST }); const a = P('a', 0, 3);
  run(S, [a], 1.6); a.zone = 'wait'; run(S, [a], 0.05); a.zone = 'wait';
  let go = false; run(S, [a], 3, e => { if (e.t === 'toArena') { go = true; return 'stop'; } });
  assert(go && S.phase === 'fight'); a.x = C.ARENA.cx; a.z = C.ARENA.cz + 13; a.zone = 'arena'; return { S, a };
}
{
  const { S, a } = fightSession(); const b = S.boss;
  assert.strictEqual(C.attackResult(S, a, 'gun', 0, 0).hit, false); ok('boss kükrerken (spawn) hasar verilemez');
  run(S, [a], 0.4);
  assert.notStrictEqual(b.st, 'spawn'); ok('kükreme bitince boss saldırı döngüsüne girdi');
  b.x = a.x; b.z = a.z - 8; b.st = 'idle'; b.stT = 0;
  // oyuncu kuzeye (−z) bakıyor: yaw=0 → ileri (0,−1)
  let r = C.attackResult(S, a, 'gun', 0, 0); assert(r.hit && r.dmg === 28); ok('silah: boss\'a bakınca isabet (28)');
  r = C.attackResult(S, a, 'gun', Math.PI, 0); assert.strictEqual(r.hit, false); ok('silah: arkaya bakınca ıska');
  r = C.attackResult(S, a, 'gun', 0, 1.2); assert.strictEqual(r.hit, false); ok('silah: çok yukarı bakınca ıska');
  r = C.attackResult(S, a, 'sword', 0, 0); assert.strictEqual(r.hit, false); ok('kılıç: 8 m uzaktan vuramaz (menzil 3.6)');
  b.z = a.z - (b.r + 1.5); r = C.attackResult(S, a, 'sword', 0, 0); assert(r.hit && r.dmg === 40); ok('kılıç: yakından isabet (40)');
  r = C.attackResult(S, a, 'sword', Math.PI, 0); assert.strictEqual(r.hit, false); ok('kılıç: arkasını dönünce ıska');
  r = C.attackResult(S, a, 'hammer', 0, 0); assert.strictEqual(r.dmg, 55); r = C.attackResult(S, a, 'stick', 0, 0); assert.strictEqual(r.dmg, 12); ok('çekiç 55, çubuk 12 hasar');
  b.st = 'tired'; r = C.attackResult(S, a, 'hammer', 0, 0); assert.strictEqual(r.dmg, 83); ok('yorgun boss ×1.5 hasar alır (55→83)');
}
console.log('D) Sabit boss: yumruk (1 sn uyarı) ve ses dalgası');
const BX = C.ARENA.bossX, BZ = C.ARENA.bossZ;
function armed(script, players) { const f = fightSession(); f.S.next = script.slice(); f.S.T.spawnPause = 0; f.S.boss.st = 'idle'; f.S.boss.stT = 0; return f; }
{
  const { S, a } = fightSession(); const b = S.boss; a.x = BX; a.z = BZ + 40;   // dışarıdan izle: hasar yok
  let moved = false, chased = false; for (let t = 0; t < 40; t += 0.05) { C.tick(S, 0.05, [a]); if (b.x !== BX || b.z !== BZ || b.yaw !== 0) moved = true; if (b.st === 'chase') chased = true; a.x = BX + Math.sin(t) * 8; a.z = BZ + 6 + Math.cos(t) * 5; }
  assert(!moved && !chased); ok('boss 40 sn boyunca hiç yer değiştirmedi, kovalamadı (oyuncu etrafında dolaşırken bile)');
}
{ // yumruk: uyarı süresi TAM 1 sn, bu sürede hasar yok
  const { S, a } = armed(['R']); const b = S.boss; a.x = BX - 5; a.z = BZ + 6; let t0 = null, tHit = null, early = 0; const times = [];
  for (let t = 0; t < 4 && tHit === null; t += 0.05) { for (const e of C.tick(S, 0.05, [a])) { if (e.t === 'fx' && e.k === 'punchWind') t0 = t; if (e.t === 'hurt') { tHit = t; } if (e.t === 'hurt' && t0 === null) early++; } if (t0 !== null && tHit === null) times.push(b.st); }
  assert(t0 !== null && tHit !== null && early === 0); const gap = tHit - t0; assert(gap >= 0.95 && gap <= 1.06, 'uyarı süresi ' + gap); ok('yumruk uyarısı ' + gap.toFixed(2) + ' sn sonra vurdu (tam 1 sn)');
  assert(times.every(st => st === 'punchWind')); ok('uyarı boyunca boss "kol havada" (punchWind) durumunda, hasar yok');
}
{ // oyuncu uyarı sırasında kaçarsa yaşar; kalırsa ölür
  let hurts = [];
  const A = armed(['R']); A.a.x = BX - 5; A.a.z = BZ + 6; let moved = false;
  run(A.S, [A.a], 3, e => { if (e.t === 'fx' && e.k === 'punchWind' && !moved) { moved = true; } if (e.t === 'hurt') hurts.push(e); }, 0.05);
  assert.strictEqual(hurts.length, 1); assert(hurts[0].dmg >= 100 && hurts[0].k === 'punch'); ok('uyarıda yerinde kalan oyuncu yumrukla ölümcül hasar aldı (tam 1 kez)');
  hurts = []; const B = armed(['R']); B.a.x = BX - 5; B.a.z = BZ + 6; let t = 0, esc = false;
  while (t < 3) { for (const e of C.tick(B.S, 0.05, [B.a])) if (e.t === 'hurt') hurts.push(e); if (B.S.boss.st === 'punchWind' && B.S.boss.stT > 0.5 && !esc) { B.a.x = BX + 6; esc = true; } t += 0.05; }
  assert(esc && hurts.length === 0); ok('uyarı sırasında kaçan oyuncu (sağ yumruk, karşı tarafa) hayatta kaldı');
}
{ // sağ/sol yönler + alan dışı
  const cases = [['R', BX - 6, BZ + 5, true], ['R', BX + 6, BZ + 5, false], ['L', BX + 6, BZ + 5, true], ['L', BX - 6, BZ + 5, false], ['R', BX - 6, BZ + 18, false], ['L', BX + 6, BZ - 6, false], ['R', BX - 12, BZ + 5, false]];
  for (const [side, x, z, want] of cases) { const { S, a } = armed([side]); a.x = x; a.z = z; let hit = false; run(S, [a], 2.5, e => { if (e.t === 'hurt') hit = true; }); assert.strictEqual(hit, want, side + ' ' + x + ',' + z); }
  ok('sağ/sol yumruk doğru yönde: ' + cases.length + ' konumun hepsi beklenen sonucu verdi (alan dışı, ters taraf, boss\'un arkası güvenli)');
  const { S, a } = armed(['L']); const b2 = P('b', BX + 5, BZ + 6, 'arena'), c2 = P('c', BX - 8, BZ + 6, 'arena'); a.x = BX + 2; a.z = BZ + 6; S.part.add('b'); S.part.add('c');
  const ids = []; run(S, [a, b2, c2], 2.5, e => { if (e.t === 'hurt') ids.push(e.id); }); assert(ids.includes('a') && ids.includes('b') && !ids.includes('c')); ok('boss çevresindeki herkes ölmez: yalnızca alandakiler (a,b öldü; c yaşadı)');
  const d = armed(['R']); d.a.alive = false; d.a.x = BX - 5; d.a.z = BZ + 6; let n = 0; run(d.S, [d.a], 2.5, e => { if (e.t === 'hurt') n++; }); assert.strictEqual(n, 0); ok('zaten ölü oyuncu tekrar hasar/ölüm almaz');
}
{ // ses dalgası
  const { S, a } = armed(['wave']); const b = S.boss; a.x = BX; a.z = BZ + 14; let t0 = null, tHit = null, d = null;
  for (let t = 0; t < 6 && tHit === null; t += 0.05) for (const e of C.tick(S, 0.05, [a])) { if (e.t === 'fx' && e.k === 'waveWind') { t0 = t; d = e.d; } if (e.t === 'hurt') tHit = t; }
  assert(Math.abs(d) < 0.05); const gap = tHit - t0; assert(gap >= C.TIMING.waveWarn + 0.5 && gap < C.TIMING.waveWarn + 1.6, 'gap ' + gap); ok('ses dalgası ' + C.TIMING.waveWarn + ' sn uyarıdan sonra yola çıktı ve oyuncuya ' + gap.toFixed(2) + ' sn\'de ulaştı (hız ' + C.WAVE.speed + ' m/sn)');
  const G = C.waveGeom(0); assert(Math.abs(G.ux) < 1e-9 && G.uz === 1); ok('dalga yönü doğru (d=0 → +z, arenaya doğru)');
}
{ const cases = [[0, 14, true], [0, 30, true], [4.4, 14, false], [-4.4, 14, false], [0, -5, false], [1.5, 14, true]];
  for (const [dx, dz, want] of cases) { const { S, a } = armed(['wave']); a.x = BX + dx; a.z = BZ + dz; S.rand = () => 0; S.part.add('decoy'); const decoy = P('decoy', BX, BZ + 14, 'arena'); let hit = 0; run(S, [decoy, a], 7, e => { if (e.t === 'hurt' && e.id === 'a') hit++; }); assert.strictEqual(hit > 0, want, 'dalga ' + dx + ',' + dz); assert(hit <= 1); }
  ok('dalga yalnızca ışının içindekini vurdu (yan taraf, boss\'un arkası güvenli); hiçbir oyuncu iki kez vurulmadı'); }
{ // sütun ve duvar engeli
  const P0 = C.PILLARS[0], d = Math.atan2(P0.x - BX, P0.z - BZ), G = C.waveGeom(d); const dist = Math.hypot(P0.x - BX, P0.z - BZ);
  assert(G.len < dist - P0.r + 0.01 && G.len > 0); ok('sütun ışını keser: uzunluk ' + G.len.toFixed(1) + ' m < sütuna uzaklık ' + dist.toFixed(1));
  const front = { x: G.ox + G.ux * (G.len - 2), z: G.oz + G.uz * (G.len - 2) }, behind = { x: G.ox + G.ux * (G.len + 3.5), z: G.oz + G.uz * (G.len + 3.5) };
  const res = pt => { const f = armed(['wave']); f.S.rand = () => 0.999; f.a.x = pt.x; f.a.z = pt.z; f.S.boss.wd = d; let n = 0; f.S.next = []; f.S.next.push('wave'); const aim = { id: 'a', x: BX + Math.sin(d) * 10, z: BZ + Math.cos(d) * 10, zone: 'arena', alive: true, hp: 100 }; let hit = 0; for (let t = 0; t < 8; t += 0.05) { const pl = f.S.boss.st === 'idle' || f.S.boss.st === 'waveWind' ? [Object.assign({}, aim, { id: 'aim' }), f.a] : [f.a]; for (const e of C.tick(f.S, 0.05, pl)) if (e.t === 'hurt' && e.id === 'a') hit++; } return hit; };
  assert(res(front) <= 1); ok('sütunun önündeki oyuncu dalgayla vuruldu mu: ' + (res(front) ? 'evet' : 'dalga kısa kaldı') + '; ardındaki oyuncu: ' + (res(behind) ? 'VURULDU' : 'güvende'));
  assert.strictEqual(res(behind), 0);
  for (const dd of [-1.1, -0.6, 0.6, 1.1]) { const g = C.waveGeom(dd); const ex = g.ox + g.ux * g.len - C.ARENA.cx, ez = g.oz + g.uz * g.len - C.ARENA.cz; assert(Math.hypot(ex, ez) <= C.ARENA.wall + 0.01 || g.len < 40); assert(g.len <= C.WAVE.range); }
  ok('dalga arena duvarından dışarı çıkmaz');
}
{ // döngü + yorgunluk + savaş sonu
  const { S, a } = armed(['wave', 'L']); const b = S.boss; a.x = BX + 9; a.z = BZ + 3; const states = new Set(); let t = 0;
  while (t < 12) { C.tick(S, 0.05, [a]); states.add(b.st); t += 0.05; }
  ['waveWind', 'wave', 'tired', 'idle', 'punchWind', 'punch', 'recover'].forEach(k => assert(states.has(k), k)); assert(!states.has('chase')); ok('saldırı döngüsü: bekle → uyarı → saldırı → toparlan → bekle (kovalama durumu hiç yok)');
  b.st = 'tired'; assert.strictEqual(C.attackResult(S, { x: BX, z: BZ + 8 }, 'gun', 0, 0).dmg, 42); ok('ses dalgasından sonra yorgun boss ×1.5 hasar alır');
}
{ const { S, a } = armed(['R']); a.x = BX - 5; a.z = BZ + 6; C.applyDamage(S, 'a', 1e9); let hurts = 0; run(S, [a], 3, e => { if (e.t === 'hurt') hurts++; }); assert.strictEqual(hurts, 0); ok('boss ölünce saldırılar durur (savaş sonrası hasar yok)'); }
{ const { S, a } = fightSession(); a.x = BX; a.z = BZ + 8; S.next = ['R']; S.T.fightMax = 0.3; const ev = run(S, [a], 3); assert(ev.filter(e => e.t === 'end').length === 1); let h = 0; run(S, [a], 2, e => { if (e.t === 'hurt') h++; }); assert.strictEqual(h, 0); ok('savaş bitince (yenilgi) boss artık saldırmaz, bitiş olayı tek kez'); }
{
  const { S, a } = fightSession(); run(S, [a], 0.4);
  const rd = C.applyDamage(S, 'a', 100); assert.strictEqual(rd.gold, 25); assert.strictEqual(S.boss.hp, C.BOSS.hp1 - 100); ok('hasar → altın (100 hasar = 25 altın)');
  const fin = C.applyDamage(S, 'a', 1e9); assert(fin.killed); assert.strictEqual(S.result, 'win'); ok('boss öldü → zafer');
  const evs = run(S, [a], 2); assert(evs.some(e => e.t === 'rewards' && e.gold.a === C.BOSS.winGold)); ok('zafer ödülü verildi (' + C.BOSS.winGold + ' altın)');
  assert(evs.some(e => e.t === 'home' && e.moves[0].id === 'a')); assert(S.done); ok('savaş sonunda oyuncular eve gönderildi');
}
{
  const { S, a } = fightSession(); run(S, [a], 0.4); a.alive = false; a.hp = 0;
  const evs = run(S, [a], 2); assert(evs.some(e => e.t === 'end' && e.result === 'lose')); ok('tüm oyuncular ölünce boss kazandı');
  const S2 = fightSession(); S2.S.T.fightMax = 1; const ev2 = run(S2.S, [S2.a], 3); assert(ev2.some(e => e.t === 'end' && e.result === 'lose')); ok('süre dolunca boss kazandı');
}
console.log('\nBoss çekirdeği testleri geçti: ' + passed);
