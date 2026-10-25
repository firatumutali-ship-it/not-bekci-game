# NÖBETÇİ: BÖLÜM 2 — Multiplayer

Terk edilmiş lunaparkta geçen birinci şahıs korku oyunu. Node.js + Socket.IO sunucusu, tek dosyalık Three.js istemcisi.

> **Durum:** Bu proje **hiçbir yerde yayınlanmadı (deploy edilmedi)**. Aşağıdaki her şey yerel makinede test edildi. İnternetten oynamak için kendi sunucuna kurman gerekir (bkz. "Yayınlama").

## Kurulum ve çalıştırma

```bash
npm install
npm start            # http://localhost:3000
npm test             # 4 test paketi: boss çekirdeği (50), oyun çekirdeği (8), sunucu duman (71), boss sunucu (60)
```

Node.js 18+ gerekir.

**Önemli:** `index.html` dosyasına çift tıklayarak açarsan multiplayer ÇALIŞMAZ (tek oyunculu mod çalışır). Multiplayer için sunucu şarttır: `npm start` (Windows'ta `start.bat`, Mac/Linux'ta `./start.sh`), sonra tarayıcıda `http://localhost:3000` aç.

### Sahip (owner / yönetici) anahtarı

Yönetici kimliği **sunucu ayarından** gelir; oyunda uydurulmaz. İki yol:

```bash
OWNER_KEY="en-az-8-karakterlik-uzun-bir-anahtar" npm start
```

veya `server.config.example.json` dosyasını `server.config.json` olarak kopyalayıp `ownerKey` alanını değiştir (bu dosya `.gitignore`'dadır).

- Anahtar yoksa ya da 8 karakterden kısa / örnek değerse, sunucu o çalıştırma için rastgele bir anahtar üretir ve konsola yazar.
- Anahtarı **Multiplayer menüsündeki "Sahip anahtarı"** alanına yazarak odaya girersin. Doğrulama sunucuda yapılır (zaman-sabit karşılaştırma, hatalı denemelerde geçici kilit).
- **Staff Room şifresi (292016) yönetici yetkisi verir:** keypad'e doğru kodu giren oyuncu (sunucu kodu ve keypad'e yakınlığı doğrular) o odada yönetici olur. Sahip anahtarı (OWNER_KEY) girmek de yönetici yapar; ikisi birbirinden bağımsız çalışır. Dikkat: kodu bilen herkes yönetici olabilir, o yüzden `STAFF_CODE` ile kodu değiştirebilirsin.

Diğer ayarlar (ortam değişkeni ya da config): `PORT`, `STAFF_CODE`, `TRUST_PROXY`, `ALLOWED_ORIGINS`, `BANS_FILE` (varsayılan `data/bans.json`).

## İki tarayıcıyla test

1. `OWNER_KEY=deneme-anahtari-123 npm start`
2. Tarayıcı A: `http://localhost:3000` → **MULTIPLAYER** → isim yaz, **Sahip anahtarı** alanına `deneme-anahtari-123` → **ODA KUR**. 5 harfli oda kodunu not al.
3. Tarayıcı B (gizli pencere): isim yaz, anahtarı **boş bırak**, oda kodunu gir → **KATIL**.
4. A'da lobide B'yi gör, sohbeti dene, **BAŞLAT** (sadece host).
5. Oyunda birbirinizin avatarını görün. B kapanınca avatarı kaybolur.
6. Staff Room: A veya B, hut'un arkasındaki odanın dış keypad'ine `292016` girer → yönetici olur, içeri girer, çekiçleri alır. (Sahip anahtarı şart değil.)
7. A bir çekiç seçip (1/2/3) B'ye bakıp **VUR** (veya sol tık) yapar. Kick: B odadan atılır, kodla tekrar girebilir. Ban: B kalıcı yasaklanır (sunucu yeniden başlasa da). Şifreyi girmemiş oyuncu çekiç alamaz.

Ban listesini sıfırlamak için `data/bans.json` dosyasını sil.

## Kontroller

| Klavye | İşlev |
|---|---|
| WASD / fare | Yürü / bak |
| Shift / C | Koş / çömel (C aç-kapa) |
| E | Etkileş |
| F | Fener |
| Tab | Not defteri |
| Enter | Sohbet |
| **Sadece yönetici:** G / N / I | Fly / Noclip / Invincible |
| **Sadece yönetici:** 7 / 8 / 9 | STAFF / DEVELOPER / OWNER etiketi aç-kapa |
| J / K / L / 0 | Yönetici çekicleri: Kick / Ban / Jumpscare; 0 = elindeki çekici Personel Odası'ndaki yerine geri koyar |
| E (Teknoloji Ağacı'nda) | Silah satın al / kuşan / bırak. Sayı tuşuyla silah seçme YOK; silahlar yalnızca teknoloji ağacından (kulübe yanı + arenada sol ve sağ) |

**Mobil:** sol yarıda kayan joystick, sağ yarıda bakış alanı; ekranda E, FENER, KOŞ, ÇÖM, NOT, VUR, ▲▼ (fly yukarı/aşağı), SOHBET ve ☰ düğmeleri.

**Mobilde yönetici çubuğu** (sağ üstte, sadece yönetici olunca çıkar): **KICK / BAN / KORKUT** çekici seçer (soluksa çekici henüz almadın), **BIRAK** elindeki çekici Personel Odası'ndaki yerine geri koyar, **FLY / NOCLIP / GOD** modları, **STAFF / DEV / OWNER** isim etiketlerini açıp kapatır. Çekiç elindeyken oyuncuya bakıp **VUR** düğmesine bas.

## Staff Room

- Hut'un hemen arkasında, kapı dışındaki keypad'e **292016** girilir.
- **3 çekiç (3D model):** Kick (1), Ban (2), Jumpscare (3). Sadece yönetici alabilir (şifreyi giren ya da sahip anahtarı olan); sunucu odada olup olmadığını doğrular.
  - Kick: odadan atar (tekrar girebilir). Ban: kalıcı yasak. Jumpscare: hedefe korkutma ekranı gösterir (atmaz, 6 sn bekleme).
- **3 duvar şalteri:** Fly modu, Noclip modu, Invincible modu.
- **Bilgisayar:** tüm şifreli yerlerin kodları (dolap 3714, Staff Room 292016), **elektriksiz tüm kameralar**, **19 eşyanın yeri** (harita + liste).
- **Invincible:** canavarlar seni görmez ve öldüremez.
- **İsim etiketleri (rütbe):** Fly/Noclip/Invincible'ın yanında **STAFF** (açık mavi), **DEVELOPER** (mor) ve **OWNER** (sarı) etiketleri de var. Açınca ismin üstünde **herkes** görür; birden fazlası aynı anda açılabilir (alt alta dizilir). Açma yolları: Personel Odası'nın kuzey duvarındaki 3 şalter (bilgisayarın yanı), yönetici bilgisayarındaki "İSİM ETİKETİ" kutuları, klavyede **7 / 8 / 9** ve mobil yönetici çubuğundaki STAFF / DEV / OWNER düğmeleri.
  - **OWNER etiketi şifrelidir:** açmaya çalışınca şifre kutusu çıkar (varsayılan şifre `şifredeuali2016`). Şifre yalnızca sunucuda doğrulanır, istemci koduna ve yönetici bilgisayarına yazılmaz. Doğru girilince o oyuncuda tekrar sorulmaz; kapatmak şifresizdir. Yanlış şifrede 1 dakikada 5 deneme sınırı vardır. Değiştirmek için: `OWNER_TAG_PASS=yeni-sifre npm start` (veya `server.config.json` içinde `"ownerTagPass"`). Tek oyunculu modda (görecek kimse yok) şifre sorulmaz.
- **Kapı kilidi:** Kapı yalnızca şifreyi giren oyuncuya açılır. Şifresiz oyuncu için kapı kapalı görünür, sunucu onu odaya sokmaz ve içerideki oyuncuyu/avatarı ona göndermez (içerisi görünmez).
- **Canavarlar içeri giremez:** canavarlar Personel Odası'na giremez, içerideki oyuncuyu görmez ve öldüremez (oda güvenli bölgedir).
- **Canavar POV:** Yönetici bilgisayarında "CANAVAR POV" düğmesi; Palyaço ve Brute'un gözünden canlı izlersin (A/D ile geçiş). Canavar sahada değilse "SİNYAL YOK" yazar.

## Güvenlik

- Pozisyonlar sunucuda doğrulanır (hız, sınır, yükseklik); ihlalde düzeltme gönderilir.
- Çekiç/ban/kick/yönetici bayrakları sadece sunucuda kontrol edilir; istemci tarafı sır yok (sahip anahtarı sunucuda).
- İsimler ve sohbet `textContent` ile gösterilir (HTML enjeksiyonu yok); uzunluk sınırları var.
- Oda oluşturma/katılma, sohbet, vuruş, bayrak ve Staff Room denemeleri için hız sınırları var.
- Origin kontrolü: varsayılan aynı-origin, ya da `ALLOWED_ORIGINS`.
- HTTPS'e hazır tasarım (proxy arkasında çalışır), ama sunucu kendisi TLS sonlandırmaz.

## Yayınlama (yapılmadı)

Bir VPS'te `npm start`'ı bir süreç yöneticisiyle çalıştır ve önüne HTTPS sonlandıran bir ters proxy (nginx, Caddy) koy. WebSocket yükseltmesini ilet. `TRUST_PROXY=1` ayarla (IP-ban ve hız sınırları doğru IP'yi görsün). Alan adın farklıysa `ALLOWED_ORIGINS` ayarla.

## Bilinen sınırlamalar (dürüst liste)

- **Canavar yapay zekâsı ve bulmaca ilerlemesi her oyuncuda yerel**; oyuncular arasında senkron değil. Senkron olanlar: oyuncular, sohbet, çekiçler/kick/ban/jumpscare, yönetici bayrakları.
- Sunucu duvar çarpışması bilmez; sadece hız/sınır/yükseklik doğrular. Duvardan geçme hilesi sınırlıdır ama imkânsız değildir.
- Ban, clientId + IP özetine bağlıdır; ikisini de değiştiren biri aşabilir.
- Staff Room kodu yetki verdiği için, kodu bilen herkes yönetici olabilir; tek oyuncu modunda kod istemci kaynağında da görünür. Çok oyunculuda sunucu kodu ayrıca doğrular. Herkese açık oynatacaksan `STAFF_CODE` değiştir.
- Tek oyuncu modunda Staff Room anahtarlarını/bilgisayarı kullanan yerel oyuncu yönetici olur (çevrimiçi ban/kick yoktur, sahte oyuncu yok).
- Çoklu oyuncu modunda kayıt (save) devre dışıdır.
- Staff Room, fly/noclip/invincible, çekiçler ve joystick önceki dosyada yoktu; sıfırdan eklendi.
- **İNTERNET (P2P) modu gerçek internette denenmedi**: yalnızca aynı bilgisayarda iki tarayıcı + yerel eşleştirme sunucusuyla (gerçek WebRTC) test edildi. Gerçek ağda (NAT/mobil veri) bağlantı, herkese açık PeerJS sunucusunun (0.peerjs.com) ve TURN yedeğinin ayakta olmasına bağlıdır; sunucu kapalıysa "Eşleştirme sunucusuna ulaşılamadı" görürsün. Bu durumda `render.yaml`/`online.bat` yolu kullanılabilir.
- P2P'de HOST ve misafirler birbirinin IP adresini ağ katmanında görebilir (WebRTC'nin doğası). Ban yalnızca clientId'ye bağlıdır (IP yok), yeni bir clientId ile aşılabilir. HOST sekmesini arka plana alsa da oyun döngüsü Worker ile sürer, ancak bilgisayar uyursa oda kopar.
- Test edildi: sunucu duman testleri, iki mobil tarayıcıyla uçtan uca, yeniden bağlanma, invincible (açık/kapalı kontrol). İnternet üzerinden gerçek ortamda **denenmedi**.

## İnternetten oynamak — Node.js'siz (oyunun içinden, oda koduyla)

Menüde **MULTIPLAYER → İNTERNET (kodla)** modu var (dosya olarak açılınca varsayılan). Kurulum, Node.js, aynı Wi-Fi, link/dosya gönderme gerekmez:

1. Herkes oyunu açar (`dist/NOBETCI.html` tek dosyası yeterli; çift tıkla).
2. Biri **CREATE ROOM** der → 5 harfli oda kodu çıkar (o kişi HOST, otomatik oyun sahibidir).
3. Diğerleri **JOIN ROOM** + kod. Farklı internetten bile girer (WebRTC; bağlantıyı kurmak için herkese açık PeerJS eşleştirme sunucusu kullanılır, oyun verisi oyuncular arasında akar).

Önemli: HOST'un sekmesi açık kalmalı (kapanırsa oda kapanır, misafirler "ODA KAPANDI" görür). Oyun mantığını (hasar, altın, boss, ban) HOST'un tarayıcısı yürütür; HOST'un hızlı bir internetle oynaması önerilir. Güvenlik notu: bu modda sunucu kodları (Staff Room şifresi vb.) dosyanın içindedir; arkadaşların güvendiğin kişiler olmalı.
Ban listesi HOST'un tarayıcısında saklanır; ENGELLENDİN ekranındaki ban açma şifresi bu modda da çalışır.
Eski Node.js sunucusu (`npm start`, `online.bat`) hâlâ çalışır; menüden **SUNUCU** seçilir.

`public/index.html` ve `dist/NOBETCI.html` TEK DOSYADIR (her şey içinde gömülü), zipten ya da çıkarmadan açılsa da çalışır. Kaynağı düzenlemek için `src/index.template.html`, `public/boss-core.js`, `game-server.js`, `p2p.js`, `multiplayer.js` dosyalarını değiştir, sonra `npm run build` (public/index.html'i üzerine yazar).

### Render.com ile 7/24 sunucu (isteğe bağlı)
`render.yaml` hazırdır (GitHub'a yükle → Render'da Blueprint). `OWNER_KEY` ve `UNBAN_CODE` ortam değişkenlerini panelde kendin gir.

## Teknoloji Ağacı ve Boss (özet)
- Eşyalar: SAPAN (ücretsiz, tek bedava eşya), ÇUBUK 100, ÇEKİÇ 400, KILIÇ 900, SİLAH 1800 altın. **Bir kez alınır, kalıcıdır, tüketilmez**; altın yalnızca ilk alırken harcanır.
- Ağaçlar: güvenlik kulübesinin batısı + boss arenasında sol ve sağ. Satın alma/kuşanma yalnızca ağacın yanında (sunucu mesafeyi doğrular); kuşanılmayan silahla saldırı sunucuda reddedilir.
- Boss (dev palyaço) hareket etmez; yumruk (kol kalkar, TAM 1 sn bekler, sonra tek vuruş) ve ses dalgası (uyarı, yönlü, sütunlara takılır) saldırıları vardır. Her 30 dakikada otomatik başlar; Staff Room düğmesi ve yönetici bilgisayarından da başlatılır.
- Ban açma şifresi `UNBAN_CODE` (varsayılan kodda tanımlıdır; yayınlamadan önce değiştir).

## Grafik (Ayarlar > Grafik kalitesi)
- **Yüksek:** piksel başına PBR ışıklandırma, ıslak asfalt yansımaları, duvar/zemin kir ve su izi dokusu (üç yönlü, UV gerektirmez), yumuşak gölgeler, el feneri ışık huzmesi, lamba haleleri, ay hâlesi, havada toz, sinematik ton eğrisi (ACES), renk derecelendirme, vinyet ve film greni.
- **Düşük:** köşe başına ışıklandırma, hafif vinyet; telefonlarda varsayılan budur. Yüksek, gerçek telefonda **denenmedi** (yalnızca masaüstü Chromium'da yazılım çizimiyle).
- Canavar/karakter modelleri hâlâ basit geometriden oluşur; yüzey ve ışık iyileştirildi, model kalitesi değişmedi.

## Organik modeller ve Mini Boss saldırısı
- **Canavarlar ve Dev Palyaço** artık eklemli: kalça–diz–ayak, omuz–dirsek–el (parmaklar kıvrılır), omurga/gövde bükülmesi, çene, kafa takibi. Koşarken öne eğilir, yakalamaya atılırken kollar uzanır, çene takırdar; boşta nefes alır.
- **Boss animasyonları**: yumruk (diz bükme, gövde bükülmesi, dirsek kurma → savurma → toparlanma, hâlâ 1 sn gerçek uyarı), ses dalgası (nefes çekme, gövde şişmesi, çene açılması → kükreme), yorgunluk (eğilip soluma), ölüm (dizler çöker).
- **Mini Boss çağırma** (`summon`): boss ara sıra (en az 30 sn arayla, uygun anda %22 şansla, ortada mini yokken) kollarını kaldırır; 2 sn boyunca arenada mor halkalar belirir (hasar yok), sonra 3–5 mini palyaço çıkar. Mini bosslar en yakın oyuncuya koşar, 0,55 sn kolunu kaldırır (kırmızı daire = vuruş alanı, kaçılabilir) ve vurur: **34 hasar** (ölümcül değil, can 100). Öldürmek 25 altın + hasar altını verir; boss canından düşmez; boss ölünce / savaş bitince kaybolurlar.
- Kararları sunucu (veya P2P'de host) verir; hız, uyarı süresi, hasar `public/boss-core.js` içindeki `MINI` ve `TIMING.summon*` değerlerinden ayarlanır.
