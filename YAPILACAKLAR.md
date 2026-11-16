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
- [ ] Hesapta workers.dev alt alan adı yoksa otomatik oluşturulacak.
- [ ] Kota sayacı: ücretsiz planda günde 100 bin istek sınırı var. Worker ve gün bazında sayım yapılıp sınıra yaklaşınca uyarı verilecek. Bu, serpmaven'deki maliyet raporunun karşılığı.
- [ ] Birden çok Cloudflare hesabı: kota ve IP çeşitliliği için.
- [ ] Çıkış ülkesi seçimi: Cloudflare'de seçilemiyor. Seçenek: bir upstream SOCKS veya HTTP proxy'ye isteğe bağlı zincirleme (CFspider'daki fikir).
- [ ] Yanlış token'la gelen istek 401 yerine 400 alıyor. Büyük olasılıkla Cloudflare'in WebSocket kontrolünden kaynaklanıyor; incelenecek.
- [ ] Yük testi: 50-100 sorguda Cloudflare IP'lerinin ne zaman engellendiği ölçülecek.

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
- [ ] Tarayıcıyı her 50 sayfada bir yeniden başlatma, ardından bekleme (serpmaven'de var).
- [ ] Çıkış başına en fazla sorgu sayısı (serpmaven: 300).
- [ ] İlk sorguyu arama kutusuna yazarak yapma (serpmaven `_query`). Gerekirse eklenecek; şu an URL ile açılıyor.
- [ ] Alakasız ya da "zehirli" sayfa tespiti: `unrelated` fonksiyonu yazıldı ama akışa bağlanmadı.
- [ ] HTTP tarafında silinen çerezlerin tarayıcıya da yansıtılması.
- [ ] Header'ları NetLog'dan kaydetme: şu an CDP'den alınıyor, sıra bir miktar farklı olabilir.

## 3. Ayrıştırma ve sınıflandırma
- [+] Organik sonuçlar, reklamlar, "People also ask", ilgili aramalar, sayfalama, AI Overview, yerel sonuçlar, sonuç sayısı.
- [+] Yedek seçici zinciri: sınıf adları yoksa ya da `#rso` bulunamazsa da çalışıyor.
- [+] Sınıflandırıcı: tanınmayan sayfaya `block` değil `unknown` diyor. HTTP 429 `sorry`, 403 `block` sayılıyor.
- [+] Engel sayfası metinleri ve AI Overview başlığı tr, de, fr ve es dillerinde de tanınıyor.
- [+] Canlı: organik sonuçlar ve "People also ask" geliyor.
- [~] AI Overview'u yapıdan tanıyan seçiciler ve yabancı dil metinleri tahmine dayalı; canlıda doğrulanacak. Testlerde `ai_overview` hiç dolmadı.
- [ ] Gerçek Google HTML örnekleri (`SAVE_HTML` ile) test fixture'ı olarak eklenecek.
- [ ] Günlük canlı kontrol: Google HTML yapısını değiştirince haber verecek bir canary testi.
- [ ] Yerel sonuçların ve reklamların canlıda kontrolü.

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
- [ ] `X-Forwarded-For` desteği (reverse proxy arkasında hız sınırı doğru çalışsın diye), ayara bağlı.
- [ ] Çok sayfalı isteklerde her sayfaya ayrı arşiv kimliği verilmesi.
- [ ] OpenAPI ya da şema dokümanı.

## 6. CLI (serpmaven `search`)
- [ ] `openserp search "sorgu"`: dosyadan ya da stdin'den sorgu okuma.
- [ ] `--pages`, `--hl`, `--gl`, `--location`, `--links`.
- [ ] `--format jsonl|json|csv`, `--output`.
- [ ] `--resume` (serpmaven `output.answered`).
- [ ] `--workers` (havuz), ilerleme çıktısı.
- [ ] `openserp doctor`: Chromium, curl-impersonate, Cloudflare durumu ve ekran (display) kontrolü.
- [-] `login` / `logout` (NodeMaven): kullanılmıyor, yerine `egress:*` komutları var.

## 7. MCP sunucusu
- [ ] stdio JSON-RPC, tek araç `google_search(query, pages 1-3, hl, gl, links)`.
- [ ] Kısa yanıt biçimi: `results`, `related_questions`, `related_searches`, `ai_overview`, `places`, `errors`.

## 8. Dağıtım ve işletim
- [+] `npm run setup`: Chromium (`.browsers/`) ve curl-impersonate (`bin/`).
- [+] `.env` ve `.env.example`; `npm start` `.env` dosyasını okuyor.
- [ ] Dockerfile: Node, Xvfb, tini, root olmayan kullanıcı, `HEALTHCHECK`.
- [ ] CI (GitHub Actions): tip kontrolü, testler, Worker paketi.
- [ ] README: kurulum, Cloudflare token adımları, API örnekleri.
- [ ] İlk commit.

## 9. Bilerek yapılmayanlar
- [-] NodeMaven SDK ve demo hesabı. Yerine Cloudflare çıkışı kullanılıyor.
- [-] Yerel kimlik doğrulamasız relay ve bayt sayımı. Proxy doğrudan tarayıcıya veriliyor.
- [-] Cloak motoru, donor çerezleri, profil klonlama. Gerekirse sonra eklenecek.
- [-] Legacy paket uyumluluk katmanları (gserp, google-browser-scraper).
- [-] flaregun'un fetch modu (gerçek IP'yi sızdırıyor) ve CFspider'ın VLESS, panel ve kod gizleme bölümleri.
