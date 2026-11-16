# TLS taklit spike raporu (adım 0)

Tarih: 2026-11-16. Ölçüm doğrudan yerel IP'den yapıldı. `SPIKE_PROXY` yok, proxy turları çalıştırılmadı.
**Google sonuçları (B) ön sonuçtur.** Asıl kullanım proxy üzerinden olacak. `.env` doldurulunca `npm run spike` A ve B'yi proxy üzerinden de tekrar çalıştırır.

## Karşılaştırma (referans: patchright Chromium 156, headless)

| İstemci | JA3 | JA4 | Akamai H2 | Header sırası | Google (3 deneme) | Proxy + auth | HTTP/2 | Cookie jar | Kurulum | Son sürüm |
|---|---|---|---|---|---|---|---|---|---|---|
| impit 0.14.9 (`chrome151`) | hayır | **hayır** (`t13d1516`, uzantı eksik) | **hayır** (fazladan `5:16384`) | eşleşmedi | 3/3 200, ~95 KB, `rso` yok | var (`proxyUrl`) | var | var (tough-cookie verilirse) | prebuilt Rust, 11 MB, derleme yok | 2026-11-11 |
| cuimp 2.1.2 + curl-impersonate v2.3.2 (`curl_chrome152`) | hayır* | **evet** | **evet** | eşleşmedi (ekstra `cache-control`, accept-language yeri) | 3/3 200, ~95 KB, `rso` yok | var (`proxy`, http/socks + auth) | var | var (`cookieJar: true`, curl dosyası) | binary 11 MB tar.gz (32 MB açık), derleme yok | 2026-10-25 (binary 2026-10-30) |
| fetch / undici 8 (kontrol) | hayır | hayır (`t13d5212h1`) | hayır | eşleşmedi (pseudo sıra `:authority` önde) | 3/3 200, ~95 KB, `rso` yok | var (`ProxyAgent`) | evet (h2) | yok, kendimiz yöneteceğiz | saf JS | 2026-11-05 |
| patchright 1.64.3 Chromium (referans) | - | - | - | - | 3/3 `/sorry` yönlendirmesi | var (launch `proxy`) | var | var (tarayıcı) | 681 MB tarayıcı indirmesi | 2026-11-02 |

\* Chrome, TLS uzantı sırasını her bağlantıda karıştırıyor. Bu yüzden JA3 hash'i her çağrıda değişir, eşleşmemesi normal. Anlamlı karşılaştırma JA4 ve Akamai ile yapılır.

## Bulgular
- Chrome'un TLS ve HTTP/2 parmak izini birebir veren tek istemci **curl-impersonate (cuimp üzerinden)**: JA4 `t13d1517h2_8daaf6152771_cb7bf5808d99` ve Akamai `52d84b11737d980aef856699f885ca86` referansla aynı.
- impit'in en yeni profili `chrome151`. JA4 ve H2 ayarları güncel Chrome'dan farklı. `browser: "chrome"` aslında Chrome 124 profili veriyor (UA 124).
- Header sırası hiçbir istemcide referansla tutmadı. Bunun sebebi kısmen referansın kendisi: headless Chromium `locale` ile `accept-language`'i `accept`'ten önce gönderiyor, UA da `HeadlessChrome`. serpmaven bu sorunu header'ları gerçek tarayıcının NetLog'undan sırasıyla alıp `default_headers=False` ile göndererek çözüyor. cuimp'te de header'ları tam ve sıralı vererek aynısı yapılabilir. Bu spike'ta denenmedi.
- Google'ın cevabı parmak izinden bağımsız: üç HTTP istemcisi de, hatta düz fetch bile, 200 ve ~95 KB dönüyor ama `id="rso"` yok. Bu büyük olasılıkla JS kontrol sayfası. İçerik ayrıca doğrulanmadı. serpmaven de aynı şeyi söylüyor: önce tarayıcı JS kontrolünü geçer, HTTP istemcisi o tarayıcının cookie'leriyle devam eder. serpmaven sabit bir consent cookie kullanmıyor, cookie'leri tarayıcıdan alıyor. Bu spike'ta bu adım yok.
- Headless patchright yerel IP'den 3/3 `/sorry`'ye düştü. Bu yüzden sonuç IP itibarına da bağlı. Proxy turu bunu netleştirecek.

## Öneri
Node portu yapılabilir. HTTP katmanı için **curl-impersonate + cuimp** kullanılsın: parmak izi tutuyor, proxy auth ve cookie jar var, native derleme yok. Ancak bunun tek başına yetmeyeceği belli. serpmaven'deki hibrit akış (tarayıcıyla JS kontrolünü geçip cookie'leri ve header sırasını HTTP istemcisine aktarmak) Node'a da taşınmalı. impit, profilleri Chrome'un gerisinde kaldığı için yedek seçenek. cuimp her istekte bir curl süreci başlatıyor. Yük artarsa libcurl-impersonate için FFI ya da bir daemon düşünülebilir.

## Çalıştırma
- `npm run setup`: curl-impersonate binary'sini `bin/` altına, Chromium'u `.browsers/` altına indirir.
- `npm run spike`: tüm turları çalıştırır, ham sonucu `results.json` dosyasına yazar. `.env` dosyasında `SPIKE_PROXY` yoksa "SPIKE_PROXY missing" yazar ve proxy turlarını atlar.

## Ham sayılar (doğrudan, `results.json`)
```
impit (chrome124 profili, kayıtlı turda)  ja4 t13d1516h2_8daaf6152771_02713d6af862  akamai 1:65536;2:0;4:6291456;5:16384;6:262144|15663105|0|m,a,s,p
impit chrome151 (ayrı A ölçümü)           ja4 t13d1516h2_8daaf6152771_806a8c22fdea  akamai_hash 245c5feff195f1e4869e93b519e67e65
cuimp curl_chrome152                      ja4 t13d1517h2_8daaf6152771_cb7bf5808d99  akamai 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
fetch undici                              ja4 t13d5212h1_b262b3658495_8e6e362c5eac  akamai 2:0;4:262144|458753|0|a,m,p,s
patchright Chromium 156                   ja4 t13d1517h2_8daaf6152771_cb7bf5808d99  akamai 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p

Google B (status / byte / rso):
impit    200/94911/no  200/94856/no  200/94872/no
cuimp    200/94776/no  200/94834/no  200/94755/no
fetch    200/94933/no  200/94757/no  200/94798/no
patchr.  200 -> /sorry/index (3442, 4046, 4044 byte), rso no
```
Not: Kayıtlı turda impit `browser: "chrome"` ile çalıştı. Sonradan script `chrome151` profiline çevrildi ve A sadece peet'e karşı ayrıca ölçüldü. Google limiti aşılmasın diye B tekrarlanmadı.
