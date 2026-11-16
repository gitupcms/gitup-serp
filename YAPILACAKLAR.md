# openserp: yapılacaklar

**Hedef:** [serpmaven](https://github.com/nodemaven/serpmaven)'in (MIT) Hono ve TypeScript ile yazılmış karşılığı. Çıkış IP'si olarak NodeMaven residential proxy yerine kendi **Cloudflare Workers IP sistemimizi** kullanıyor (`worker/` ve `src/egress/`). Kod olarak flaregun ya da CFspider kullanılmıyor, yalnızca fikirlerinden yararlanıldı.

İşaretler:
- `[+]` yapıldı
- `[~]` kısmen yapıldı ya da canlıda doğrulanmadı
- `[ ]` yapılacak
- `[-]` bilerek yapılmayacak

Not: "Canlı" etiketi, gerçek Google'a karşı Cloudflare çıkışıyla denendiği anlamına geliyor.

---

## 0. Karar ve deneme aşaması
- [+] serpmaven'i inceledik ve zayıf noktalarını listeledik.
- [+] TLS taklidi denemesi (`spike/tls/RAPOR.md`): cuimp + curl-impersonate, Chrome ile aynı JA4 ve HTTP/2 parmak izini veriyor.
- [+] flaregun denemesi (`spike/flaregun/RAPOR.md`): Cloudflare çıkışıyla Google'da 6/6 başarılı.
- [+] CFspider incelendi. Riskleri: pip ayarını kendi sunucusuna çeviriyor, açık proxy, uzaktan sayfa yüklüyor. Alınan fikirler: API ile kurulum ve zorunlu token.

## 1. Cloudflare çıkış sistemi (NodeMaven'in yerine)
- [+] Hono Worker (`worker/`): yalnızca `/tunnel` (WebSocket üzerinden `cloudflare:sockets`). Token zorunlu, yalnızca 443 ve 80 portları, özel IP'ler reddediliyor, fetch modu yok.
- [+] Cloudflare API istemcisi (`src/egress/cf.ts`): kurma, kaldırma, listeleme ve workers.dev alt alan adı. wrangler kullanılmıyor, esbuild ile paketleniyor.
- [+] `npm run egress:up -- N` / `egress:down` / `egress:ls`. Durum dosyası `.openserp/egress.json`, izinler 0600.
- [+] Yerel CONNECT tüneli (`src/egress/tunnel.ts`): Node ile, `Proxy-Authorization` zorunlu, sırayla dağıtım (round-robin), hata veren Worker bir süre dinlendiriliyor.
- [+] `npm start`: `SCRAPER_PROXY` boşsa Cloudflare çıkışını otomatik kullanıyor.
- [+] Canlı: token'sız istek 401, başka yollar 404, Google 6/6 başarılı.
- [ ] Kalıcı `CF_API_TOKEN` ve `CF_ACCOUNT_ID` `.env` dosyasına yazılacak. Şimdilik wrangler OAuth token'ı kullanılıyor.
- [~] Hesapta workers.dev alt alan adı yoksa otomatik oluşturuluyor (`ensureSubdomain`). Alt alan adı olmayan bir hesapta canlı denenmedi.
- [+] Kota sayacı (`src/egress/usage.ts`): UTC günü bazında sayıyor, %80'de uyarı veriyor, %100'de 429 dönüyor. Sayım `egress:ls` ile görülüyor. Durum klasörü `EGRESS_STATE_DIR` ile değiştirilebiliyor.
- [+] 401/400 durumu canlıda doğrulandı. Yanlış token'la eksiksiz WebSocket isteği 401 alıyor. 400, `Sec-WebSocket-Key` eksik olduğunda isteği Cloudflare'in reddetmesinden geliyor, bizim koddan değil.
- [+] Yük testi: 50 sorgu (CLI, link çözme kapalı) **50/50 başarılı**, hiç engel yok. Ortanca süre 5,2 sn, p90 6,6 sn. İlk sorgu ısınmayla birlikte 46 sn sürdü.
- [ ] Daha büyük yük testi: 500+ sorgu ve `POOL_SIZE` > 1.
- [ ] Birden çok Cloudflare hesabı: kota ve IP çeşitliliği için.
- [~] Çıkış ülkesi seçimi: Cloudflare'de seçilemiyor. Varsayılan `DEFAULT_GL=us` ve `DEFAULT_HL=en` eklendi (API, CLI ve MCP). Organik sonuçlar artık gl'ye uyuyor, ama yerel paket hâlâ çıkış IP'sinin şehrine göre geliyor ("pizza near me": organik sonuçlar Orlando'dan, yerel paket Londra'dan). Bunu çözmek için `location` (uule) ya da upstream proxy zinciri gerekiyor. `gl` verilmeyen bir sorgu Japonca sonuç döndürdü; sonuçlar çıkış IP'sinin konumuna göre değişiyor. Yapılabilecekler: varsayılan `gl` ve `hl` vermek, ya da bir upstream SOCKS veya HTTP proxy'ye isteğe bağlı zincirleme.

## 2. Tarayıcı, kimlik ve hibrit akış
- [+] patchright, görünür pencere (headful), kalıcı profil. Proxy doğrudan tarayıcıya veriliyor; serpmaven'deki gibi kimlik doğrulamasız yerel relay yok.
- [+] Kimlik: profil + oturum + çerezler. Isınma turu (bekleme süresi kısa ve ayarlanabilir), consent ekranı.
- [+] Tarayıcının gerçek header sırası kaydedilip HTTP isteklerinde tekrarlanıyor.
- [+] Hibrit akış: istek cuimp ile gidiyor. JS kontrolü ya da `serp` olmayan bir sayfa gelirse o sorgu tarayıcıda çalışıyor, çerezler HTTP tarafına aktarılıyor. Üst üste N başarısız HTTP denemesinden sonra tarayıcıda kalınıyor.
- [+] Tek sürüm kaynağı: TLS `chrome152`, user-agent tarayıcının kendisinden.
- [+] Sorgu başına en fazla 3 çıkış. Üst üste 6 retten sonra devre kesici (breaker) devreye girip durumu `down` yapıyor. `unknown` gelirse çıkış yakılmıyor.
- [+] `AbortSignal` destekleniyor, temizlik ve kapanış düzgün yapılıyor.
- [~] Consent seçicileri ve ısınma turu canlıda çalıştı, ancak başka diller ve ülkeler denenmedi.
- [ ] `POOL_SIZE` > 1 canlıda denenecek. serpmaven'deki `--workers` (16'ya kadar) karşılığı.
- [+] Tarayıcı her `BROWSER_MAX_PAGES` (varsayılan 50) sayfada aynı profil ve çerezlerle yeniden başlıyor, ardından 5-15 sn bekliyor. Restart sonrası çerezlerin korunduğu sahte Google'la denendi.
- [+] Çıkış başına en fazla sorgu sayısı: `EXIT_MAX_QUERIES` (varsayılan 300).
- [ ] İlk sorguyu arama kutusuna yazarak yapma (serpmaven `_query`). Gerekirse eklenecek; şu an URL ile açılıyor.
- [+] Alakasız ("zehirli") sayfa tespiti akışa bağlandı: bir çıkışın son 5 sayfasından 3'ü alakasızsa o çıkış bırakılıyor. Latin dışı alfabeler, tırnak ya da `site:` gibi operatörler içeren ve tek kelimelik sorgular hiç yargılanmıyor. Canlıda Türkçe, Japonca ve `site:` sorgularıyla 6/6 denendi, yanlış alarm çıkmadı.
- [ ] HTTP tarafında silinen çerezlerin tarayıcıya da yansıtılması.
- [ ] Header'ları NetLog'dan kaydetme: şu an CDP'den alınıyor, sıra bir miktar farklı olabilir.

## 3. Ayrıştırma ve sınıflandırma
- [+] Organik sonuçlar, reklamlar, "People also ask", ilgili aramalar, sayfalama, AI Overview, yerel sonuçlar, sonuç sayısı.
- [+] Yedek seçici zinciri: sınıf adları yoksa ya da `#rso` bulunamazsa da çalışıyor.
- [+] Sınıflandırıcı: tanınmayan sayfaya `block` değil `unknown` diyor. HTTP 429 `sorry`, 403 `block` sayılıyor.
- [+] Engel sayfası metinleri ve AI Overview başlığı tr, de, fr ve es dillerinde de tanınıyor.
- [+] Canlı: organik sonuçlar ve "People also ask" geliyor.
- [+] Canlı: AI Overview 50 sorgunun 20'sinde doldu.
- [~] Yabancı dillerdeki engel ve AI Overview metinleri tahmine dayalı, canlıda doğrulanmadı.
- [+] Reklamlar: seçicide hata yokmuş, sorun `gl` verilmemesiymiş. `gl=us` ile 8 ticari sorgunun 3'ünde 2'şer üst reklam geldi ve doğru ayrıştırıldı.
- [+] Gerçek Google HTML örnekleri (`test/fixtures/*.html.gz`, `test/fixtures.test.ts`): reklam, yerel paket ve AI Overview içeren 3 sayfa.
- [ ] Günlük canlı kontrol: Google HTML yapısını değiştirince haber verecek bir canary testi.
- [+] Yerel sonuçların ve reklamların canlıda kontrolü (fixture'lara bakın).

## 4. Link çözme
- [+] Sırasıyla sayfa içi liste, `ping` URL'si ve `/goto` deneniyor (`Location`). "Verifying" sayfası bekleme ve tekrar denemeyle aşılıyor.
- [+] Aynı anda en fazla 4 istek, sayfa başına 30 saniye bütçe. Hata olursa yalnızca o link `null` kalıyor, mekanizma kendini kapatmıyor.
- [+] API `links` parametresi (varsayılan: hepsi, `0`: kapalı).
- [+] Canlı: 33/33 link çözüldü.
- [ ] `links_wait`: S saniye sonra o ana kadar çözülen linklerle yanıt vermek (serpmaven'de var).
- [ ] Hız: link çözme sayfa başına 14-30 saniye sürüyor. Bütçe ve paralellik ayarlanacak.

## 5. HTTP API (Hono)
- [+] `GET /search.json` (`/search`): `q`, `pages`, `hl`, `gl`, `location` (uule), `tbs`, `cr`, `lr`, `links`, `async`.
- [+] `GET /searches/:id.json`: arşiv (LRU, 500 kayıt, 1 saat).
- [+] `GET /health` (kimlik doğrulamasız ve sorgusuz).
- [+] Anahtar yalnızca `Authorization: Bearer` başlığıyla kabul ediliyor, sabit süreli karşılaştırma yapılıyor. `?api_key=` gönderilirse 400.
- [+] Kuyruk dolunca 429, zaman aşımında 504. Hız sınırı uygulanıyor. Loglara sorgu yazılmıyor.
- [+] `X-Forwarded-For` desteği, `TRUST_PROXY` ayarıyla açılıyor.
- [+] Çok sayfalı isteklerde her sayfaya ayrı arşiv kimliği veriliyor; birleşik sonuç istek kimliğinde duruyor.
- [ ] OpenAPI ya da şema dokümanı.

## 6. CLI (serpmaven `search`)
- [+] `npm run cli -- search "sorgu"`: sorgular argümandan, `--input` dosyasından ya da stdin'den okunabiliyor.
- [+] `--pages`, `--hl`, `--gl`, `--location`, `--links`, `--format jsonl|json|csv`, `--output`, `--resume`.
- [+] Paralellik `POOL_SIZE` ile ayarlanıyor. İlerleme stderr'e yazılıyor. Çıkış kodları: 0, 1, 2, Ctrl-C'de 130.
- [+] `doctor`: Node, curl-impersonate, Chromium, ekran ve egress kontrol ediliyor. Token değerleri gösterilmiyor.
- [+] Canlı: 50 sorgu CLI ile çalıştı.
- [+] `bin` girdisi (`gitup-serp`): `cli.mjs` sarmalayıcısı yereldeki tsx'i çalıştırıyor, PATH'te tsx gerekmiyor.
- [+] `--hl` ve `--gl` doğrulaması (API ile aynı kurallar, hatalıysa çıkış kodu 2).
- [-] `login` / `logout` (NodeMaven): kullanılmıyor, yerine `egress:*` komutları var.

## 7. MCP sunucusu
- [+] `npm run mcp`: stdio JSON-RPC, SDK yok, tek araç `google_search(query, pages 1-3, hl, gl, links)`. Runtime ilk çağrıda başlatılıyor (lazy).
- [+] Kısa yanıt biçimi: `results`, `related_questions`, `related_searches`, `ai_overview`, `places`, `errors`.
- [+] Canlı: `tools/call` ile 9 sonuç geldi, linkler ve AI Overview dolu. stdout yalnızca JSON satırlarından oluşuyor.
- [+] Claude Desktop ve Claude Code için örnek ayar (README). `npm --prefix` ile başka klasörden de başlıyor.

## 8. Dağıtım ve işletim
- [+] `npm run setup`: Chromium (`.browsers/`) ve curl-impersonate (`bin/`).
- [+] `.env` ve `.env.example`; `npm start` `.env` dosyasını okuyor.
- [+] Dockerfile: Node 22, Xvfb, tini, root olmayan kullanıcı, `HEALTHCHECK`, `/data` birimi. `docker run IMAGE cli|mcp|egress:*` çalışıyor. İmaj 2,1 GB ve yalnızca x86_64. Egress yoksa `/health` 503 döndüğü için konteyner `unhealthy` görünür.
- [+] CI (GitHub Actions): tip kontrolü, testler, Worker paketi ve ayrı bir `docker build` işi. Gizli anahtar kullanmıyor, canlı çağrı yapmıyor.
- [+] README: kurulum, Cloudflare token adımları, API, CLI, MCP ve Docker örnekleri, kaynakça.
- [+] İlk commit (`gitupcms/gitup-serp`).

## 9. Bilerek yapılmayanlar
- [-] NodeMaven SDK ve demo hesabı. Yerine Cloudflare çıkışı kullanılıyor.
- [-] Yerel kimlik doğrulamasız relay ve bayt sayımı. Proxy doğrudan tarayıcıya veriliyor.
- [-] Cloak motoru, donor çerezleri, profil klonlama. Gerekirse sonra eklenecek.
- [-] Legacy paket uyumluluk katmanları (gserp, google-browser-scraper).
- [-] flaregun'un fetch modu (gerçek IP'yi sızdırıyor) ve CFspider'ın VLESS, panel ve kod gizleme bölümleri.
