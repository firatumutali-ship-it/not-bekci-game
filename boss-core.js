/* NÖBETÇİ — Boss çekirdeği (SUNUCU ve TEK OYUNCULU MOD AYNI KODU KULLANIR)
 *
 * Saf mantık: DOM / Three.js / ağ yok. Sunucu (Node) ve tarayıcı aynı dosyayı yükler.
 *   Boss SABİT durur (Scary Baboon tarzı): kovalamaz. İki saldırısı var: YUMRUK (önce 1 sn kol havada, sonra vuruş) ve SES DALGASI.
 *   - Teknoloji ağacındaki silahların değerleri (WEAPONS)
 *   - Boss oturumu zaman çizelgesi: intro → portal → bekleme odası (60 sn) → savaş → bitiş
 *   - Boss yapay zekâsı (Dev Palyaço): kovalama, darbe, yer ezme, hamle (charge) + yorgunluk
 *   - Oyuncu saldırısının isabet hesabı (yakın dövüş / silah ışını)
 * Koordinat kuralları: oyuncu ileri yönü = (-sin yaw, -cos yaw). Boss/canavar ileri yönü = (sin yaw, cos yaw).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BossCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------ silahlar (teknoloji ağacı)
     Sıra, MADDİ DEĞERE göre: 1. SİLAH, 2. KILIÇ, 3. ÇEKİÇ, 4. ÇUBUK. SAPAN ücretsizdir (fiyat 0), ağacın ilk eşyasıdır, tuş 5. */
  const WEAPONS = {
    sling:  { id: 'sling',  slot: 5, name: 'SAPAN', price: 0,    dmg: 10, cd: 0.70, reach: 45, ranged: true,  desc: 'ÜCRETSİZ ilk silah. Menzilli ama yavaş ve zayıf.' },
    gun:    { id: 'gun',    slot: 1, name: 'SİLAH', price: 1800, dmg: 28, cd: 0.22, reach: 70,  ranged: true,  desc: 'Menzilli. Hızlı ateş.' },
    sword:  { id: 'sword',  slot: 2, name: 'KILIÇ', price: 900,  dmg: 40, cd: 0.45, reach: 3.6, ranged: false, desc: 'Hızlı yakın dövüş.' },
    hammer: { id: 'hammer', slot: 3, name: 'ÇEKİÇ', price: 400,  dmg: 55, cd: 0.95, reach: 3.2, ranged: false, desc: 'Ağır, yavaş darbe.' },
    stick:  { id: 'stick',  slot: 4, name: 'ÇUBUK', price: 100,  dmg: 12, cd: 0.30, reach: 2.8, ranged: false, desc: 'En ucuz, en zayıf.' }
  };
  const ORDER = ['sling', 'gun', 'sword', 'hammer', 'stick'];
  const FREEZE_SECONDS = 4;        // normal canavarlar hasar alınca ölmez, bu kadar donar
  const FREEZE_IMMUNE = 2;         // çözüldükten sonra tekrar donmama süresi (sürekli donma hilesini engeller)

  /* ------------------------------------------------------------ dünya yerleşimi */
  const ARENA_CX = 160;
  const PORTAL = { x: 0, z: 3, r: 2.2 };               // Orta Plaza'da açılan portal
  const TECH = { x: -9.5, z: 52.0, use: 5.0 };         // Teknoloji ağacı: güvenlik kulübesinin batısı
  const ARENA_TECH = [ { x: ARENA_CX - 16, z: 12, use: 4.5 }, { x: ARENA_CX + 16, z: 12, use: 4.5 } ];   // arenada SOL ve SAĞ teknoloji ağacı
  const ARENA = { cx: 160, cz: 0, half: 24, wall: 22, bossX: 160, bossZ: -12 };
  const WAIT = { cx: 160, cz: -60, half: 7 };
  const HOME = { x: -0.8, y: 0.15, z: 52.3 };

  const TIMING = {
    introWalk: 3.5, introSummon: 2.5, introEnter: 2.5,   // ~8.5 sn giriş animasyonu
    portalMax: 120,       // portal açık kalır; kimse girmezse iptal
    countdown: 60,        // İLK oyuncu girince başlayan bekleme odası süresi
    spawnPause: 4,        // boss'un kükreme süresi (dokunulmaz)
    punchWarn: 1.0,       // YUMRUK: kol havada TAM bekleme (bu sürede hasar YOK), sonra vuruş
    punchStrike: 0.35,    // yumruğun inme animasyonu (hasar kontrolü bunun BAŞLANGICINDA, tek sefer)
    punchRecover: 1.0,    // kol geri döner
    waveWarn: 1.8,        // SES DALGASI: hazırlık/uyarı süresi (yön bu sırada kilitlenir)
    idle: 1.3, idleRage: 0.8,   // saldırılar arası bekleme (boss %50 canın altında hızlanır)
    tired: 2.6,           // ses dalgasından sonra nefes nefese (hasar ×1.5)
    summonWarn: 2.0,      // MİNİ BOSS ÇAĞIRMA: boss kollarını kaldırır, doğma noktaları işaretlenir (hasar YOK)
    summonEnd: 1.4,       // çağırdıktan sonra toparlanma
    summonCool: 30,       // iki çağırma arası en az süre (boss bunu SIK yapmaz)
    summonChance: 0.22,   // uygun olduğunda her saldırı seçiminde şans
    fightMax: 420,        // süre dolarsa boss kazanır
    endDelay: 8,          // bittikten sonra eve dönüş
    autoEvery: 1800       // otomatik başlatma: 30 dk
  };
  const BOSS = { hp1: 3000, hpPer: 2000, r: 2.6, h: 9, scale: 3.0, winGold: 500, damageGoldRate: 0.25 };
  /* Saldırı alanları (dünya koordinatı, boss +z yönüne bakar; bossun SAĞI = dünya -x). Ayarlanabilir. */
  const PUNCH = { width: 10, overlap: 1, depth: 16, back: 2, lag: 0.35 };       // lag: gecikme toleransı (öldürücü alan görselden bu kadar içeride)
  const WAVE = { speed: 14, range: 40, halfW: 2.4, thick: 2.2, maxAngle: 1.1, lag: 0.35 };
  const PILLARS = [ { x: ARENA_CX - 9, z: 0, r: 1.5 }, { x: ARENA_CX + 9, z: 0, r: 1.5 }, { x: ARENA_CX - 15, z: 7, r: 1.5 }, { x: ARENA_CX + 15, z: 7, r: 1.5 } ];

  /* Mini boss: boss'un ara sıra çağırdığı küçük palyaçolar. Oyunculara koşup yakın dövüşle saldırır (öldürücü DEĞİL, hasar verir). */
  const MINI = { hp: 120, speed: 4.0, r: 0.75, h: 2.4, reach: 1.7, windup: 0.55, strike: 0.25, cd: 1.4, dmg: 34, rise: 1.1, killGold: 25, hitGoldRate: 0.25, maxAlive: 6, front: 9 };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rectOf = z => ({ x1: z.cx - z.half - 1.5, x2: z.cx + z.half + 1.5, z1: z.cz - z.half - 1.5, z2: z.cz + z.half + 1.5 });
  const ZONE_RECT = { arena: rectOf(ARENA), wait: rectOf(WAIT) };
  function zoneOf(x, z) {
    for (const k of ['arena', 'wait']) { const r = ZONE_RECT[k]; if (x >= r.x1 && x <= r.x2 && z >= r.z1 && z <= r.z2) return k; }
    return 'park';
  }
  const inPortal = (x, z) => Math.hypot(x - PORTAL.x, z - PORTAL.z) <= PORTAL.r + 0.3;
  const nearTech = (x, z) => Math.hypot(x - TECH.x, z - TECH.z) <= TECH.use || ARENA_TECH.some(k => Math.hypot(x - k.x, z - k.z) <= k.use);
  const waitSpawn = i => ({ x: WAIT.cx + ((i % 4) - 1.5) * 2.4, y: 0, z: WAIT.cz + (Math.floor(i / 4) - 0.5) * 2.4, yaw: 0 });
  const arenaSpawn = (i, n) => ({ x: ARENA.cx + (i - (n - 1) / 2) * 3.0, y: 0, z: ARENA.cz + 13, yaw: 0 });
  const homeSpawn = i => ({ x: -3 + (i % 5) * 1.5, y: 0, z: 46.6 - Math.floor(i / 5) * 1.6, yaw: 0 });

  /* ------------------------------------------------------------ oturum */
  function createSession(opts) {
    opts = opts || {};
    const T = Object.assign({}, TIMING, opts.timing || {});
    return {
      id: opts.id || 1, T, phase: 'intro', t: 0, result: null, done: false,
      portal: 0, countdown: null, part: new Set(), entered: new Set(), q: [], homed: false,
      next: (opts.script || []).slice(), rand: opts.rand || Math.random,
      boss: { x: 0, z: -24, yaw: 0, st: 'walk', stT: 0, hp: 0, maxHp: 0, r: BOSS.r, h: BOSS.h, vis: true,
              side: 'R', wd: 0, wf: 0, wl: 0, hit: new Set(), last: [], dmgBy: {} },
      minis: [], miniSeq: 0, lastSummon: -1e9, spawnPts: []
    };
  }

  function turn(b, want, maxStep) {
    let d = Math.atan2(Math.sin(want - b.yaw), Math.cos(want - b.yaw));
    b.yaw += clamp(d, -maxStep, maxStep);
  }
  const isRage = b => b.hp > 0 && b.hp < b.maxHp * 0.5;

  /* Oyuncular: [{id,x,z,hp,alive,zone}] → olaylar (events) */
  function tick(S, dt, players) {
    const ev = S.q.splice(0, S.q.length); const T = S.T; const b = S.boss;
    if (S.done) return ev;
    S.t += dt;

    if (S.phase === 'intro') {
      if (S.t - dt <= 0) ev.push({ t: 'announce', k: 'intro' });
      const w = T.introWalk, s = T.introSummon, e = T.introEnter;
      if (S.t < w) { b.st = 'walk'; b.yaw = 0; b.z = -24 + (S.t / w) * 20; }
      else if (S.t < w + s) { b.st = 'summon'; b.z = -4; b.yaw = 0; S.portal = clamp((S.t - w) / s, 0, 1); }
      else if (S.t < w + s + e) { b.st = 'enter'; S.portal = 1; b.yaw = 0; b.z = -4 + ((S.t - w - s) / e) * (PORTAL.z + 0.5 + 4); }
      else { b.vis = false; b.st = 'gone'; S.portal = 1; S.phase = 'portal'; S.t = 0; ev.push({ t: 'phase', phase: 'portal' }); }
    }
    else if (S.phase === 'portal' || S.phase === 'wait') {
      for (const p of players) {
        if (p.zone === 'park' && p.alive !== false && inPortal(p.x, p.z) && !S.entered.has(p.id)) {
          S.entered.add(p.id); ev.push({ t: 'enter', id: p.id, spawn: waitSpawn(S.entered.size - 1) });
          if (S.phase === 'portal') { S.phase = 'wait'; S.t = 0; ev.push({ t: 'phase', phase: 'wait' }); }
        }
      }
      if (S.phase === 'portal') {
        S.countdown = Math.max(0, T.portalMax - S.t);
        if (S.t >= T.portalMax) { S.result = 'cancel'; S.phase = 'end'; S.t = 0; S.done = true; S.portal = 0; ev.push({ t: 'end', result: 'cancel' }); }
      } else {
        S.countdown = Math.max(0, T.countdown - S.t);
        if (S.t >= T.countdown) {
          const ids = players.filter(p => p.zone === 'wait').map(p => p.id);
          S.portal = 0;
          if (!ids.length) { S.result = 'cancel'; S.phase = 'end'; S.t = 0; S.done = true; ev.push({ t: 'end', result: 'cancel' }); }
          else {
            S.part = new Set(ids); const n = ids.length;
            b.maxHp = BOSS.hp1 + BOSS.hpPer * (n - 1); b.hp = b.maxHp; b.x = ARENA.bossX; b.z = ARENA.bossZ; b.yaw = 0;
            b.vis = true; b.st = 'spawn'; b.stT = 0; b.hit = new Set(); b.last = []; b.dmgBy = {};
            S.phase = 'fight'; S.t = 0; S.countdown = null;
            ev.push({ t: 'phase', phase: 'fight' }); ev.push({ t: 'toArena', moves: ids.map((id, i) => Object.assign({ id }, arenaSpawn(i, n))) });
            ev.push({ t: 'announce', k: 'fight' });
          }
        }
      }
    }
    else if (S.phase === 'fight') {
      const alive = players.filter(p => p.zone === 'arena' && p.alive !== false && S.part.has(p.id));
      if (b.hp > 0) { bossAI(S, dt, alive, ev); miniAI(S, dt, alive, ev); }
      if (b.hp <= 0) { /* applyDamage zaten sonucu ayarladı */ }
      else if (!alive.length) { finish(S, 'lose', ev); }
      else if (S.t >= T.fightMax) { finish(S, 'lose', ev); }
    }
    else if (S.phase === 'end') {
      if (!S.homed && S.t >= (S.result === 'cancel' ? 0 : T.endDelay)) {
        S.homed = true; S.done = true;
        const ids = players.filter(p => p.zone !== 'park').map(p => p.id);
        ev.push({ t: 'home', moves: ids.map((id, i) => Object.assign({ id }, homeSpawn(i))) });
      }
    }
    return ev;
  }

  function finish(S, result, ev) {
    if (S.phase === 'end') return;
    S.result = result; S.phase = 'end'; S.t = 0; S.minis = []; (ev || S.q).push({ t: 'end', result });
    if (result === 'win') (ev || S.q).push({ t: 'rewards', gold: rewards(S) });
  }
  function rewards(S) { const g = {}; for (const id of S.part) g[id] = BOSS.winGold; return g; }

  /* ------------------------------------------------------------ saldırı geometrisi (sunucu + istemci ORTAK) */
  /* yumruk alanı (dünya dikdörtgeni). side: 'R' = bossun sağı (dünya -x), 'L' = solu (+x). */
  function punchZone(side) {
    const bx = ARENA.bossX, bz = ARENA.bossZ;
    return side === 'R' ? { x1: bx - PUNCH.width, x2: bx + PUNCH.overlap, z1: bz - PUNCH.back, z2: bz + PUNCH.depth }
                        : { x1: bx - PUNCH.overlap, x2: bx + PUNCH.width, z1: bz - PUNCH.back, z2: bz + PUNCH.depth };
  }
  function inPunch(side, x, z, lag) {
    const r = punchZone(side), m = lag === undefined ? PUNCH.lag : lag;
    return x > r.x1 + m && x < r.x2 - m && z > r.z1 + m && z < r.z2 - m;
  }
  /* ses dalgası: yön açısı d (0 = +z, + = +x). Işın duvara ya da sütuna çarpınca kısalır. */
  function waveGeom(d) {
    const ux = Math.sin(d), uz = Math.cos(d), ox = ARENA.bossX + ux * BOSS.r, oz = ARENA.bossZ + uz * BOSS.r;
    let len = WAVE.range;
    const wx = ox - ARENA.cx, wz = oz - ARENA.cz, bq = wx * ux + wz * uz, Rw = ARENA.wall - 0.8;
    const disc = bq * bq - (wx * wx + wz * wz - Rw * Rw);
    if (disc > 0) len = Math.min(len, -bq + Math.sqrt(disc));
    for (const P of PILLARS) {
      const px = P.x - ox, pz = P.z - oz, sp = px * ux + pz * uz, perp = Math.abs(px * uz - pz * ux);
      if (sp > 0 && perp < P.r + WAVE.halfW) len = Math.min(len, Math.max(0, sp - P.r));
    }
    return { ox, oz, ux, uz, len: Math.max(0, len) };
  }

  function miniSpawnPoints(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: ARENA.cx + (i - (n - 1) / 2) * 3.8, z: ARENA.bossZ + MINI.front + (i % 2) * 1.6 });
    return out;
  }
  function miniPush(m) {
    const lim = ARENA.half - 1.2;
    m.x = clamp(m.x, ARENA.cx - lim, ARENA.cx + lim); m.z = clamp(m.z, ARENA.cz - lim, ARENA.cz + lim);
    for (const P of PILLARS) { const dx = m.x - P.x, dz = m.z - P.z, d = Math.hypot(dx, dz), min = P.r + MINI.r; if (d < min) { const k = d > 1e-4 ? min / d : 1; m.x = P.x + (d > 1e-4 ? dx * k : min); m.z = P.z + (d > 1e-4 ? dz * k : 0); } }
    const bx = m.x - ARENA.bossX, bz = m.z - ARENA.bossZ, bd = Math.hypot(bx, bz), bm = BOSS.r + MINI.r;
    if (bd < bm && bd > 1e-4) { m.x = ARENA.bossX + bx / bd * bm; m.z = ARENA.bossZ + bz / bd * bm; }
  }
  /* mini boss yapay zekası (sunucu karar verir): en yakın canlı oyuncuya koş → 0.55 sn uyarı (hasar YOK) → vuruş */
  function miniAI(S, dt, alive, ev) {
    for (const m of S.minis) {
      m.stT += dt;
      if (m.st === 'rise') { if (m.stT >= MINI.rise) { m.st = 'chase'; m.stT = 0; } continue; }
      let tg = null, td = 1e9;
      for (const p of alive) { const d = Math.hypot(p.x - m.x, p.z - m.z); if (d < td) { td = d; tg = p; } }
      if (m.st === 'chase') {
        m.cd = Math.max(0, m.cd - dt);
        if (!tg) continue;
        m.yaw = Math.atan2(tg.x - m.x, tg.z - m.z);
        if (td <= MINI.reach * 0.9 && m.cd <= 0) { m.st = 'wind'; m.stT = 0; m.tgt = tg.id; m.hit = false; continue; }
        if (td > MINI.reach * 0.6) { const sp = Math.min(MINI.speed * dt, td - MINI.reach * 0.6); m.x += Math.sin(m.yaw) * sp; m.z += Math.cos(m.yaw) * sp; }
        for (const o of S.minis) if (o !== m) { const dx = m.x - o.x, dz = m.z - o.z, d = Math.hypot(dx, dz); if (d < MINI.r * 1.8 && d > 1e-4) { const pu = (MINI.r * 1.8 - d) * 0.5; m.x += dx / d * pu; m.z += dz / d * pu; } }
        miniPush(m);
      }
      else if (m.st === 'wind') {                                   // dururken kolunu kaldırır: kaçılabilir
        if (tg) m.yaw = Math.atan2(tg.x - m.x, tg.z - m.z);
        if (m.stT >= MINI.windup - 1e-6) {
          m.st = 'strike'; m.stT = 0;
          const victim = alive.filter(p => Math.hypot(p.x - m.x, p.z - m.z) <= MINI.reach + 0.3).sort((a, c) => Math.hypot(a.x - m.x, a.z - m.z) - Math.hypot(c.x - m.x, c.z - m.z))[0];
          if (victim) ev.push({ t: 'hurt', id: victim.id, dmg: MINI.dmg, k: 'mini' });
          ev.push({ t: 'fx', k: 'miniStrike', mid: m.id });
        }
      }
      else if (m.st === 'strike') { if (m.stT >= MINI.strike) { m.st = 'chase'; m.stT = 0; m.cd = MINI.cd; } }
    }
  }

  function bossAI(S, dt, alive, ev) {
    const b = S.boss, T = S.T; b.stT += dt;
    b.x = ARENA.bossX; b.z = ARENA.bossZ; b.yaw = 0;               // SABİT: boss asla yer değiştirmez
    const rage = isRage(b), EPS = 1e-6;
    const lethal = (p, k) => ev.push({ t: 'hurt', id: p.id, dmg: 9999, k });
    if (b.st === 'spawn') { if (b.stT >= T.spawnPause) { b.st = 'idle'; b.stT = 0; } return; }
    if (b.st === 'idle') {
      if (b.stT < (rage ? T.idleRage : T.idle)) return;
      let pick = S.next.length ? S.next.shift() : null;
      if (!pick) {
        const L = b.last, banned = L.length >= 2 && L[0] === L[1] ? L[0] : null;
        const pool = ['L', 'R', 'wave', 'wave'].filter(x => x !== banned);   // dalga biraz daha sık
        pick = pool[Math.floor(S.rand() * pool.length) % pool.length];
        /* ARA SIRA mini boss çağırır: bekleme dolmuş, ortada mini yok ve şansa bağlı */
        if (alive.length && !S.minis.length && S.t - S.lastSummon >= T.summonCool && S.rand() < T.summonChance) pick = 'summon';
      }
      b.last.unshift(pick); b.last.length = Math.min(b.last.length, 2);
      b.stT = 0; b.hit = new Set();
      if (pick === 'summon') {
        const n = clamp(2 + alive.length, 3, MINI.maxAlive - 1); S.spawnPts = miniSpawnPoints(n);
        b.st = 'summonWind'; ev.push({ t: 'fx', k: 'summonWind', pts: S.spawnPts.map(q => [Math.round(q.x * 100) / 100, Math.round(q.z * 100) / 100]) });
      }
      else if (pick === 'L' || pick === 'R') { b.side = pick; b.st = 'punchWind'; ev.push({ t: 'fx', k: 'punchWind', side: pick }); }
      else {
        let aim = alive.length ? alive[Math.floor(S.rand() * alive.length) % alive.length] : null;
        let d = aim ? Math.atan2(aim.x - b.x, aim.z - b.z) : 0;
        b.wd = clamp(d, -WAVE.maxAngle, WAVE.maxAngle); b.wf = 0; b.wl = waveGeom(b.wd).len;
        b.st = 'waveWind'; ev.push({ t: 'fx', k: 'waveWind', d: b.wd, len: b.wl });
      }
      return;
    }
    if (b.st === 'summonWind') {                                  // kollar havada, işaretler yanıyor: mini YOK, hasar YOK
      if (b.stT >= T.summonWarn - EPS) {
        b.st = 'summonEnd'; b.stT = 0; S.lastSummon = S.t;
        for (const q of S.spawnPts) if (S.minis.length < MINI.maxAlive) S.minis.push({ id: ++S.miniSeq, x: q.x, z: q.z, yaw: 0, hp: MINI.hp, st: 'rise', stT: 0, cd: 0, tgt: null, hit: false });
        ev.push({ t: 'fx', k: 'summon', n: S.minis.length });
      }
      return;
    }
    if (b.st === 'summonEnd') { if (b.stT >= T.summonEnd) { b.st = 'idle'; b.stT = 0; } return; }
    if (b.st === 'punchWind') {                                   // kol havada: hasar YOK
      if (b.stT >= T.punchWarn - EPS) {
        b.st = 'punch'; b.stT = 0; ev.push({ t: 'fx', k: 'punch', side: b.side });
        for (const p of alive) if (!b.hit.has(p.id) && inPunch(b.side, p.x, p.z)) { b.hit.add(p.id); lethal(p, 'punch'); }   // tek sefer, vuruş anında
      }
      return;
    }
    if (b.st === 'punch') { if (b.stT >= T.punchStrike) { b.st = 'recover'; b.stT = 0; } return; }
    if (b.st === 'recover') { if (b.stT >= T.punchRecover) { b.st = 'idle'; b.stT = 0; } return; }
    if (b.st === 'waveWind') {
      if (b.stT >= T.waveWarn - EPS) { b.st = 'wave'; b.stT = 0; b.wf = 0; ev.push({ t: 'fx', k: 'wave', d: b.wd, len: b.wl }); }
      return;
    }
    if (b.st === 'wave') {
      const G = waveGeom(b.wd), prev = b.wf; b.wf = Math.min(b.wl, prev + WAVE.speed * dt);
      for (const p of alive) {
        if (b.hit.has(p.id)) continue;
        const px = p.x - G.ox, pz = p.z - G.oz, s = px * G.ux + pz * G.uz, perp = Math.abs(px * G.uz - pz * G.ux);
        if (s >= Math.max(0, prev - WAVE.thick) && s <= b.wf && perp <= WAVE.halfW - WAVE.lag) { b.hit.add(p.id); lethal(p, 'wave'); }
      }
      if (b.wf >= b.wl) { b.st = 'tired'; b.stT = 0; ev.push({ t: 'fx', k: 'tired' }); }
      return;
    }
    if (b.st === 'tired') { if (b.stT >= T.tired) { b.st = 'idle'; b.stT = 0; } }
  }

  /* ------------------------------------------------------------ oyuncu saldırısı */
  function attackResult(S, p, wid, yaw, pitch) {
    const W = WEAPONS[wid]; if (!W || !S || S.phase !== 'fight') return null;
    const b = S.boss; if (b.hp <= 0 || b.st === 'dead') return { hit: false };
    const mh = miniHit(S, p, W, yaw, pitch), bh = (b.st === 'spawn') ? { hit: false } : bossHit(S, p, wid, W, yaw, pitch);
    if (mh && (!bh.hit || mh.dist < bh.dist)) return { hit: true, dmg: mh.dmg, w: wid, mini: mh.id };
    if (bh.hit) return { hit: true, dmg: bh.dmg, w: wid };
    return { hit: false };
  }
  /* oyuncunun saldırısı en yakın mini bosa denk geliyor mu? (boss'tan önce kontrol edilir) */
  function miniHit(S, p, W, yaw, pitch) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw); let best = null;
    for (const m of S.minis) {
      if (m.st === 'rise' || m.hp <= 0) continue;
      const bx = m.x - p.x, bz = m.z - p.z, d = Math.hypot(bx, bz);
      if (!W.ranged) {
        const gap = d - MINI.r; if (gap > W.reach) continue;
        if (gap > 0.3 && d > 1e-3 && (fx * bx + fz * bz) / d < 0.5) continue;
        if (!best || d < best.dist) best = { id: m.id, dist: d, dmg: W.dmg };
      } else {
        const cp = Math.cos(pitch), hx = fx * cp, hz = fz * cp, hy = Math.sin(pitch), hl = Math.hypot(hx, hz); if (hl < 1e-6) continue;
        const ux = hx / hl, uz = hz / hl, sd = bx * ux + bz * uz; if (sd <= 0) continue;
        const perp = Math.abs(bx * uz - bz * ux); if (perp > MINI.r * 1.1) continue;
        const s0 = sd - Math.sqrt(Math.max(0, MINI.r * MINI.r - perp * perp)); if (s0 > W.reach) continue;
        const y = 1.6 + (hy / hl) * Math.max(0, s0); if (y < 0 || y > MINI.h) continue;
        if (!best || s0 < best.dist) best = { id: m.id, dist: s0, dmg: W.dmg };
      }
    }
    return best;
  }
  function bossHit(S, p, wid, W, yaw, pitch) {
    const b = S.boss;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), bx = b.x - p.x, bz = b.z - p.z, d = Math.hypot(bx, bz);
    const mul = b.st === 'tired' ? 1.5 : 1;
    if (!W.ranged) {
      const gap = d - b.r; if (gap > W.reach) return { hit: false };
      if (gap > 0.3 && d > 1e-3 && (fx * bx + fz * bz) / d < 0.5) return { hit: false };
      return { hit: true, dmg: Math.round(W.dmg * mul), w: wid, dist: d };
    }
    const cp = Math.cos(pitch), hx = fx * cp, hz = fz * cp, hy = Math.sin(pitch), hl = Math.hypot(hx, hz);
    if (hl < 1e-6) return { hit: false };
    const ux = hx / hl, uz = hz / hl, s = bx * ux + bz * uz; if (s <= 0) return { hit: false };
    const perp = Math.abs(bx * uz - bz * ux); if (perp > b.r * 0.95) return { hit: false };
    const s0 = s - Math.sqrt(Math.max(0, b.r * b.r - perp * perp)); if (s0 > W.reach) return { hit: false };
    const y = 1.6 + (hy / hl) * Math.max(0, s0); if (y < 0 || y > b.h) return { hit: false };
    return { hit: true, dmg: Math.round(W.dmg * mul), w: wid, dist: s0 };
  }

  /* hasarı uygular: altın = hasar × oran. Boss ölürse oturumu 'win' ile bitirir. */
  function applyDamage(S, id, dmg, miniId) {
    if (miniId) {
      const m = S.minis.find(q => q.id === miniId); if (!m || m.hp <= 0 || S.phase !== 'fight') return { gold: 0, killed: false, mini: true };
      dmg = Math.min(dmg, m.hp); m.hp -= dmg; let gold = Math.round(dmg * MINI.hitGoldRate), killed = false;
      if (m.hp <= 0) { killed = true; gold += MINI.killGold; S.minis = S.minis.filter(q => q !== m); }
      return { gold, killed, mini: true };
    }
    const b = S.boss; if (S.phase !== 'fight' || b.hp <= 0) return { gold: 0, killed: false };
    dmg = Math.min(dmg, b.hp); b.hp -= dmg; b.dmgBy[id] = (b.dmgBy[id] || 0) + dmg;
    const gold = Math.round(dmg * BOSS.damageGoldRate); let killed = false;
    if (b.hp <= 0) { b.hp = 0; b.st = 'dead'; b.stT = 0; killed = true; S.minis = []; finish(S, 'win'); }
    return { gold, killed };
  }

  function snapshot(S) {
    const b = S.boss, r2 = v => Math.round(v * 100) / 100;
    return { id: S.id, ph: S.phase, t: r2(S.t), cd: S.countdown === null ? null : r2(S.countdown), pt: r2(S.portal), res: S.result,
             b: { x: r2(b.x), z: r2(b.z), yaw: r2(b.yaw), st: b.st, sT: r2(b.stT), hp: Math.round(b.hp), mx: Math.round(b.maxHp), v: b.vis ? 1 : 0,
               sd: b.side, wd: r2(b.wd), wf: r2(b.wf), wl: r2(b.wl) },
             sp: b.st === 'summonWind' ? S.spawnPts.map(q => [r2(q.x), r2(q.z)]) : [],
             m: S.minis.map(q => [q.id, r2(q.x), r2(q.z), r2(q.yaw), Math.round(q.hp), q.st, r2(q.stT)]) };
  }

  return { WEAPONS, ORDER, FREEZE_SECONDS, FREEZE_IMMUNE, PORTAL, TECH, ARENA_TECH, ARENA, WAIT, HOME, TIMING, BOSS, MINI, miniSpawnPoints, ZONE_RECT, PUNCH, WAVE, PILLARS, punchZone, inPunch, waveGeom,
           zoneOf, inPortal, nearTech, waitSpawn, arenaSpawn, homeSpawn, createSession, tick, attackResult, applyDamage, snapshot, rewards };
});
