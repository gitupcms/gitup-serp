# flaregun ile test (2026-11-16)

Kurulum: 3 Worker (ücretsiz plan), `flaregun serve -p 18080`, openserp `SCRAPER_PROXY=http://127.0.0.1:18080`, `POOL_SIZE=1`. Test bitince Worker'lar silindi (`flaregun down`).

## Çıkış IP'leri
- CONNECT modu (bizim kullandığımız): 10 istekte 9 farklı IPv6 adresi geldi. Hepsi Cloudflare'in `2a09:bac5:4e3c::/31` bloğunda. Gerçek IP sızmadı.
- Fetch modu (`?url=`, bizim kullanmadığımız): hedef sunucuya kullanıcının **gerçek IPv6 adresi** `X-Forwarded-For` ile gitti. Bu mod kullanılmamalı.
- Cloudflare üzerindeki siteler (örnek: api.ipify.org) CONNECT modunda TLS aşamasında düşüyor, çünkü `cloudflare:sockets` Cloudflare IP'lerine bağlanamıyor.

## Google
- Yalın curl-impersonate: 3/3 200 döndü, sayfa JS kontrol sayfası (`enablejs`). Doğrudan bağlantıdaki sonuçla aynı. Engel ya da `/sorry` yok.
- openserp'in tam akışı (tarayıcıda ısınma, sonra hibrit istek): 6/6 `Success`, 8-9 organik sonuç. Isınmadan sonra sorgu başına 1-6 sn.
- Sorunlar:
  1. `link` alanı neredeyse hep `null`. Google `/goto?url=` jetonu veriyor, bunu çözen kod yok.
  2. `hl=en&gl=us` ile sorulan "weather istanbul" sorgusunda ilk sonuç Arapça geldi. Çıkış IP'sinin konumu dil ve ülke ayarlarını eziyor.
- Örneklem küçük: 6 sorgu, tek kimlik, kısa süre. Uzun süreli ve yüksek hacimli davranış ölçülmedi.
