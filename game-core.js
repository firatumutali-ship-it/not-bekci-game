'use strict';
/* game-server.js (Node + tarayıcı ortak mantık) ve paketleme tutarlılığı testleri */
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const G = require('../public/game-server.js');
let n = 0; const ok = m => { n++; console.log('  ✓ ' + m); };
const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

for (const t of ['', 'abc', 'nobetci2|1.2.3.4', 'şifre ğüşi' + 'x'.repeat(300)]) assert.strictEqual(G.sha256(t), crypto.createHash('sha256').update(t).digest('hex'));
ok('saf JS SHA-256, Node crypto ile birebir aynı (eski bans.json dosyaları uyumlu)');
assert(G.safeEq('20162016', '20162016') && !G.safeEq('20162016', '20162017') && !G.safeEq('a', ''));
ok('safeEq doğru/yanlış şifreyi ayırıyor');
const mem = []; const adapter = { load: () => mem.slice(), save: l => { mem.length = 0; mem.push(...l); } };
let b = new G.BanStore(adapter); b.add('client12345', 'p2p:client12345', 'X', 'Host');
assert(b.isBanned('client12345', 'p2p:client12345') && !b.isBanned('baska12345', 'p2p:baska12345'));
b = new G.BanStore(adapter); assert(b.isBanned('client12345', ''));
assert.strictEqual(b.remove('client12345', 'p2p:client12345'), 1); assert(!new G.BanStore(adapter).isBanned('client12345', ''));
ok('BanStore: ekleme, kalıcılık (depolama adaptörü), kaldırma');
for (let i = 0; i < 200; i++) { const v = G.randomInt(5); assert(v >= 0 && v < 5); const w = G.randomInt(100, 999); assert(w >= 100 && w < 999); }
ok('randomInt aralıkları doğru');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.template.html'), 'utf8'), core = pub('boss-core.js'), built = pub('index.html');
assert(built.includes(core) && built.includes(pub('game-server.js')) && built.includes(pub('p2p.js')) && built.includes(pub('multiplayer.js')) && built.includes(pub('vendor/peerjs.min.js')));
assert(!/<script src="(?!https:|\/socket\.io)/.test(built)); ok('public/index.html TEK DOSYA: boss, sunucu mantığı, P2P, PeerJS, istemci içinde gömülü (güncel; değilse npm run build)');
assert(!/Digit\(\[1-5\]\)/.test(html)); ok('sayı tuşuyla silah seçme kodu kaldırıldı');
assert(/id="mpModeP2P"/.test(html) && /<script src="p2p.js">/.test(html) && /<script src="vendor\/peerjs\.min\.js">/.test(html)); ok('menüde İNTERNET modu ve P2P betikleri var');
const B = require('../public/boss-core.js');
assert.strictEqual(B.ARENA_TECH.length, 2); assert(B.ARENA_TECH[0].x < B.ARENA.cx && B.ARENA_TECH[1].x > B.ARENA.cx);
for (const k of B.ARENA_TECH) { assert(B.nearTech(k.x, k.z)); assert.strictEqual(B.zoneOf(k.x, k.z), 'arena'); assert(Math.hypot(k.x - B.ARENA.cx, k.z - B.ARENA.cz) < 20.6); for (const P of B.PILLARS) assert(Math.hypot(k.x - P.x, k.z - P.z) > 4); }
ok('arena ağaçları: sol/sağ, arena içinde, sütunlardan uzak, yakınlık kontrolü çalışıyor');
console.log('\nOyun çekirdeği testleri geçti: ' + n);
