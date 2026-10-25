'use strict';
/* src/index.template.html + public/*.js  ->  public/index.html  (TEK DOSYA: oyun + boss + P2P + PeerJS + istemci hepsi içinde)
 *                                          ->  dist/NOBETCI.html (aynısı, Node sunucusu etiketi olmadan)
 * Düzenleme akışı: kaynak dosyaları (src/index.template.html, public/boss-core.js, game-server.js, p2p.js, multiplayer.js) düzenle,
 * sonra `npm run build`. public/index.html'i elle düzenleme (build üzerine yazar). */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), pub = path.join(root, 'public');
const read = f => fs.readFileSync(path.join(pub, f), 'utf8');
const safe = (name, code) => { if (code.includes('</script')) throw new Error(name + ' içinde </script geçemez'); return code; };
let html = fs.readFileSync(path.join(root, 'src', 'index.template.html'), 'utf8');
const A = '<!--BOSSCORE:START-->', B = '<!--BOSSCORE:END-->';
const i = html.indexOf(A), j = html.indexOf(B);
if (i < 0 || j < 0) throw new Error('şablonda BOSSCORE işaretleri yok');
html = html.slice(0, i) + '<script>/* boss-core.js */\n' + safe('boss-core.js', read('boss-core.js')) + '\n</script>' + html.slice(j + B.length);
for (const f of ['vendor/peerjs.min.js', 'game-server.js', 'p2p.js', 'multiplayer.js']) {
  const tag = '<script src="' + f + '"></script>';
  if (!html.includes(tag)) throw new Error('şablonda yok: ' + tag);
  html = html.replace(tag, () => '<script>/* ' + f + ' */\n' + safe(f, read(f)) + '\n</script>');
}
fs.writeFileSync(path.join(pub, 'index.html'), html);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'NOBETCI.html'), html.replace('<script src="/socket.io/socket.io.js"></script>\n', ''));
console.log('Üretildi: public/index.html ve dist/NOBETCI.html (' + Math.round(html.length / 1024) + ' KB)');
