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
- [+] Büyük yük testi yapıldı (510 sorgu, `POOL_SIZE=2`, linkler kapalı). Cloudflare çıkışının asıl sınırı ortaya çıktı:
  - 1. çalıştırma: dakikada yaklaşık 12 sorgu hızla ilk 91 sorgu temiz geçti. Yaklaşık 7. dakikada `sorry` başladı, 168. sorguda devre kesici açıldı. Toplam 158 başarılı sorgu. O sürümde kesici kalıcı açık kaldığı için kalan 343 sorgu Google'a hiç gitmeden düştü (düzeltildi, aşağıda).
  - 2. çalıştırma, 10 dk sonra, uyarlanır hız ve kendiliğinden toparlanan kesiciyle: 14 sorgu geçti, sonra `sorry` geldi. Hız 3 sn'den 60 sn'ye çıktı. Kesici 5, 10, 20 ve 30 dk bekleyip denedi; her deneme reddedildi. İlk engelden yaklaşık 50 dk sonra hâlâ engelliydi, test orada durduruldu.
  - Sonuç: Google, Cloudflare'in paylaşılan çıkış aralığını kısa sürede yaklaşık 250 sorgudan sonra en az 50 dk engelliyor. Sorun hız değil, IP aralığının itibarı: 60 sn aralıkla bile reddedildi. Kesici artık çökmüyor, bekleyip yeniden deniyor (canlıda doğrulandı).
- [ ] Engelin ne kadar sürdüğünü ölçmek: birkaç saat sonra canary ile tekrar denenecek. Günlük canary bunu zaten kendiliğinden ölçecek.
- [+] Yüksek hacim için: Cloudflare çıkışı varsayılan, engellenince `FALLBACK_PROXY` (residential) devreye giriyor (`src/scraper/failover.ts`). Reddedilen sorgu yedekte bir kez daha deneniyor, Cloudflare'in breaker'ı açılınca trafik geri dönüyor. Yedek ilk ihtiyaçta açılıyor, `FALLBACK_IDLE_S` (600) boşta kalınca kapanıyor. Kayıtta `search_metadata.egress`, `/health`'te iki tarafın sayıları var. Canlıda geçiş ve yedeğin tembel açılışı görüldü; yedeğin gerçekten sonuç vermesi residential hesapla denenecek (yerel IP ile denenince Google `sorry` verdi). Birden çok Cloudflare hesabı muhtemelen işe yaramaz, çünkü çıkış IP aralığı aynı.
- [+] Son yedek olarak DuckDuckGo (`ENGINE_FALLBACK=duckduckgo`, varsayılan kapalı): Google reddederken (residential de reddederse ondan sonra) sorgular Cloudflare üzerinden DuckDuckGo HTML'den cevaplanıyor, kayıtta `search_metadata.engine: "duckduckgo"`. Yalnız organik sonuç ve yalnız 1. sayfa: 2. sayfa `vqd` ile POST istiyor ve başka IP'den gelince anomaly veriyor; Cloudflare çıkışı her istekte IP değiştiriyor. Anomaly sayfası ret sayılıp 10 dk bekleniyor, çözülmüyor. Canlı (Cloudflare, 3 Worker): DuckDuckGo 1. sayfa 7/7 sorgu 10'ar sonuç; runtime'da Google 2 sorgu servis etti, zorla kapatınca 2 sorgu DuckDuckGo'dan geldi, açınca Google'a geri döndü.
- [+] Captcha'da çerez sıfırlama (karust/openserp fikri): zaten vardı. Reddedilen kimlik emekliye ayrılıyor, profil klasörü siliniyor, yeni kimlik sıfır çerezle başlıyor.
- [ ] Residential proxy hesabı açıp `.env`'e `FALLBACK_PROXY=http://user-{session}:pass@host:port` yazmak (kullanıcı), sonra yük testini yedekle tekrarlamak.
- [ ] Birden çok Cloudflare hesabı: kota ve IP çeşitliliği için. İkinci bir hesap gerekiyor; şu an tek hesapla günde 100 bin istek fazlasıyla yetiyor.
- [+] Çıkış ülkesi: Cloudflare'de seçilemiyor, ama artık gerek kalmadı. Varsayılan `DEFAULT_GL=us` ve `DEFAULT_HL=en`; `location` verilmezse gl ülkesi uule olarak gönderiliyor. Canlıda yerel paket artık doğru ülkeden geliyor: us için Colorado ve Missouri, tr için Gaziantep ve Bursa. Önceden Londra geliyordu. Şehir düzeyinde konum için `location` verilmeli.

## 2. Tarayıcı, kimlik ve hibrit akış
- [+] patchright, görünür pencere (headful), kalıcı profil. Proxy doğrudan tarayıcıya veriliyor; serpmaven'deki gibi kimlik doğrulamasız yerel relay yok.
- [+] Kimlik: profil + oturum + çerezler. Isınma turu (bekleme süresi kısa ve ayarlanabilir), consent ekranı.
- [+] Tarayıcının gerçek header sırası kaydedilip HTTP isteklerinde tekrarlanıyor.
- [+] Hibrit akış: istek cuimp ile gidiyor. JS kontrolü ya da `serp` olmayan bir sayfa gelirse o sorgu tarayıcıda çalışıyor, çerezler HTTP tarafına aktarılıyor. Üst üste N başarısız HTTP denemesinden sonra tarayıcıda kalınıyor.
- [+] Tek sürüm kaynağı: TLS `chrome152`, user-agent tarayıcının kendisinden.
- [+] Sorgu başına en fazla 3 çıkış. Üst üste 6 retten sonra devre kesici (breaker) devreye girip durumu `down` yapıyor. `unknown` gelirse çıkış yakılmıyor.
- [+] `AbortSignal` destekleniyor, temizlik ve kapanış düzgün yapılıyor.
- [~] Consent seçicileri ve ısınma turu canlıda çalıştı, ancak başka diller ve ülkeler denenmedi.
- [+] `POOL_SIZE` > 1 canlıda denendi (2 kimlik + 1 yedek). Çalışıyor, ama Cloudflare çıkışının engellenme sınırı yüzünden paralellik toplam kapasiteyi artırmıyor; yalnızca engele daha hızlı ulaştırıyor.
- [+] Tarayıcı her `BROWSER_MAX_PAGES` (varsayılan 50) sayfada aynı profil ve çerezlerle yeniden başlıyor, ardından 5-15 sn bekliyor. Restart sonrası çerezlerin korunduğu sahte Google'la denendi. Canlıda da görüldü: yeniden başlatma 1,6 sn, ardından 11,6 sn bekleme. Chromium'un belleği yeniden başlatmadan sonra yaklaşık 1,5 GB'tan 0,9 GB'a indi (kaba ölçüm, 2 sn aralıklı RSS). Tarayıcı yalnızca HTTP denemesi tutmazsa açıldığı için 10 sorguda bir kez yeniden başladı.
- [+] Çıkış başına en fazla sorgu sayısı: `EXIT_MAX_QUERIES` (varsayılan 300).
- [-] İlk sorguyu arama kutusuna yazarak yapma (serpmaven `_query`): yapılmadı. URL ile açmak canlıda sorun çıkarmadı; engel oranı artarsa yeniden bakılır.
- [+] Alakasız ("zehirli") sayfa tespiti akışa bağlandı: bir çıkışın son 5 sayfasından 3'ü alakasızsa o çıkış bırakılıyor. Latin dışı alfabeler, tırnak ya da `site:` gibi operatörler içeren ve tek kelimelik sorgular hiç yargılanmıyor. Canlıda Türkçe, Japonca ve `site:` sorgularıyla 6/6 denendi, yanlış alarm çıkmadı.
- [-] HTTP tarafında silinen çerezlerin tarayıcıya da yansıtılması: yapılmadı. Google canlıda çerez silmedi; her yeniden başlatmada çerezler zaten yeniden kopyalanıyor.
- [-] Header'ları NetLog'dan kaydetme: yapılmadı. CDP'den alınan header'larla HTTP denemeleri canlıda geçiyor (her sorguda fetch yaklaşık 1,2 sn, ek engel yok).

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
- [+] Günlük canlı kontrol: `npm run canary` (6 sorgu: reklam, yerel paket, organik, AI Overview, Türkçe, Japonca) ve `.github/workflows/canary.yml`. Workflow her gün çalışır ama yalnızca repo secrets'ta `CF_API_TOKEN` ve `CF_ACCOUNT_ID` varsa; ayrı bir Worker öneki (`EGRESS_PREFIX=openserp-canary`) kullandığı için senin Workers'ına dokunmaz. Canlıda yerelde çalıştırıldı ve 15 kontrolün 15'i geçti.
- [+] Yerel sonuçların ve reklamların canlıda kontrolü (fixture'lara bakın).

## 4. Link çözme
- [+] Sırasıyla sayfa içi liste, `ping` URL'si ve `/goto` deneniyor (`Location`). "Verifying" sayfası bekleme ve tekrar denemeyle aşılıyor.
- [+] Aynı anda en fazla 4 istek, sayfa başına 30 saniye bütçe. Hata olursa yalnızca o link `null` kalıyor, mekanizma kendini kapatmıyor.
- [+] API `links` parametresi (varsayılan: hepsi, `0`: kapalı).
- [+] Canlı: 33/33 link çözüldü.
- [+] `links_wait` (API, `--links-wait`, MCP): S saniye sonra o ana kadar çözülen linklerle yanıt veriyor, kalan istekler iptal ediliyor. Canlıda `links_wait=8` ile 9 linkin 5'i çözüldü, sayfa 9,5 sn sürdü.
- [+] Yedek kimlik (`SPARE_IDENTITIES`, varsayılan 1): bir çıkış reddedilince önceden ısınmış yedek hemen devreye giriyor, yeni yedek arka planda ısınıyor. Canary'de ilk sorgu 40,5 sn sürdü; önceden 110 sn sürüyordu. Ancak bu çalıştırmada `sorry` gelmediği için 40,5 sn, yedeğin değil normal ısınmanın süresi.
- [~] Hız: ölçüldü (`search_metadata.timings`, 10 canlı sorgu, 10 link).
  - Link çözme 9-25 sn sürüyor. Bunun neredeyse tamamı Google'ın "Verifying your request" bekletmesi: toplam bekletme süresi link süresinin 2-3 katı, yani bekletmeler artık üst üste biniyor. Bu süre Google'ın verdiği gecikme; daha fazla kısaltmanın yolu daha az link istemek ya da `links_wait`.
  - 60-115 sn süren aykırı sayfaların nedeni link çözme değil. İlk sorguda çıkış `sorry` alıyor, sonra yeni kimlik ısınıyor: `queue` 67-74 sn.
  - Sıradaki iyileştirme: ısınmayı ilk sorgudan önce bitirmek ve `sorry` sonrası yedek kimliği önceden hazır tutmak.

## 5. HTTP API (Hono)
- [+] `GET /search.json` (`/search`): `q`, `pages`, `hl`, `gl`, `location` (uule), `tbs`, `cr`, `lr`, `links`, `async`.
- [+] `GET /searches/:id.json`: arşiv (LRU, 500 kayıt, 1 saat).
- [+] `GET /health` (kimlik doğrulamasız ve sorgusuz).
- [+] Anahtar yalnızca `Authorization: Bearer` başlığıyla kabul ediliyor, sabit süreli karşılaştırma yapılıyor. `?api_key=` gönderilirse 400.
- [+] Kuyruk dolunca 429, zaman aşımında 504. Hız sınırı uygulanıyor. Loglara sorgu yazılmıyor.
- [+] `X-Forwarded-For` desteği, `TRUST_PROXY` ayarıyla açılıyor.
- [+] Çok sayfalı isteklerde her sayfaya ayrı arşiv kimliği veriliyor; birleşik sonuç istek kimliğinde duruyor.
- [+] `GET /openapi.json` (OpenAPI 3.1). Parametreler aynı zod şemasından üretildiği için kodla uyumsuz hale gelemez.

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
- [+] Dockerfile: Node 22, Xvfb, tini, root olmayan kullanıcı, `HEALTHCHECK`, `/data` birimi. `docker run IMAGE cli|mcp|egress:*` çalışıyor. İmaj 2,1 GB ve yalnızca x86_64. Egress yoksa `/health` 503 döndüğü için konteyner `unhealthy` görünür. Canlı uçtan uca deneme yapıldı: konteyner Cloudflare çıkışıyla arama yaptı (8 organik sonuç, 3/3 link, 9,5 sn), anahtarsız istek 401 aldı, Docker sağlık durumu `healthy` oldu. CI GitHub'da yeşil.
- [+] CI (GitHub Actions): tip kontrolü, testler, Worker paketi ve ayrı bir `docker build` işi. Gizli anahtar kullanmıyor, canlı çağrı yapmıyor.
- [+] README: kurulum, Cloudflare token adımları, API, CLI, MCP ve Docker örnekleri, kaynakça.
- [+] İlk commit (`gitupcms/gitup-serp`).

## 9. Bilerek yapılmayanlar
- [-] NodeMaven SDK ve demo hesabı. Yerine Cloudflare çıkışı kullanılıyor.
- [-] Yerel kimlik doğrulamasız relay ve bayt sayımı. Proxy doğrudan tarayıcıya veriliyor.
- [-] Cloak motoru, donor çerezleri, profil klonlama. Gerekirse sonra eklenecek.
- [-] Legacy paket uyumluluk katmanları (gserp, google-browser-scraper).
- [-] flaregun'un fetch modu (gerçek IP'yi sızdırıyor) ve CFspider'ın VLESS, panel ve kod gizleme bölümleri.
- [+] npm paketi hazır: `@gitupcms/gitup-serp` (0.1.0). `gitup-serp setup | egress up/down/ls | serve | mcp | canary | search | doctor`. Paketlenmiş hali geçici bir klasöre kurulup denendi (doctor, serve, mcp, egress). Yayınlamak için `npm login` gerekiyor (kullanıcı).
- [+] karust/openserp'ten alınanlar (0.2.0):
  - Önbellek (`CACHE_TTL_S` 120, `CACHE_MAX`, `X-Cache`, aynı anda gelen aynı sorgu tek arama).
  - Çıktı formatları (`format=markdown|text`, `Accept`, CLI `--format markdown`).
  - Tarih filtresi (`date=h|d|w|m|y` ya da `YYYYMMDD..YYYYMMDD` → `tbs`).
  - `POST /parse`.
  - Sayfa içeriği çıkarma: `/extract`, aramada `extract=N`, MCP `extract` aracı, CLI `gitup-serp extract`.
- [+] Çıkarma yalnız çıkıştan geçiyor, makineden doğrudan hiç çekmiyor. Cloudflare arkasındaki siteler için Worker'a `/fetch` modu eklendi: tünel TLS'te kopunca (curl 35) ya da CONNECT reddedilince aynı URL Worker `fetch()`'i ile çekiliyor. Kayıtta `via` alanı var.
  - Canlı: wikipedia ve rei tünelden; hono.dev, developers.cloudflare.com ve discord.com `worker-fetch` ile geldi.
  - `cdn-cgi/trace` ile kontrol: sitenin gördüğü IP bizimki değil, bir Cloudflare IPv6 adresi.
  - Uçtan uca `search --extract 2 --format markdown --date y` çalıştı.
- [ ] Çıkarma kalitesi: bazı sayfalarda (YouTube, Medium) menü ve link kalabalığı kalıyor; UTF-8 dışı karakter kodlaması yok; PDF yok.

