# Konum web görüntüleyici (`apps/web`)

QR kodu ya da paylaşım bağlantısını (`https://<LINK_DOMAIN>/s/<token>`) **uygulaması olmayan** kişinin açtığı
salt okunur, telefona göre tasarlanmış canlı konum sayfası. Uygulama kuruluysa aynı bağlantı Universal Links /
App Links ile doğrudan uygulamada açılır; bu sayfa yalnızca tarayıcıya düşen istekler içindir.

Vite + React + TypeScript. `@konum/core` TypeScript kaynağı olarak kullanılır (`file:../../packages/core`):
token biçimi, özet, paket şeması, durum kuralı, pin hareketi ve Türkçe metinler mobil uygulamayla aynı koddan gelir.

## Akış

1. `/s/<token>` açılır. `src/token.ts` token'ı core `parseLinkToken` ile doğrular, **adresten siler**
   (`history.replaceState` → `/s/canli`) ve yalnızca bu sekmenin `sessionStorage`'ında tutar (yenileme çalışsın diye).
2. Özet tarayıcıda hesaplanır: core `linkTokenHash(token)` = SHA-256 hex. Ağa yalnızca bu özet çıkar.
3. Firebase RTDB `link_live/{özet}` kimliksiz dinlenir (`onValue`). Okuma kuralı `link_acl/{özet}` aktif ve
   süresi dolmamışken izin verir (backend `database.rules.json`).
4. Paket core `parseLinkLive` ile okunur; ekran durumu core `linkViewState` + web ayrımlarıyla (`src/viewer/model.ts`).
5. Paylaşım durdurulunca sunucu ACL'yi kapatır ve `link_live` düğümünü siler: açık sekme `null` ya da
   `permission_denied` alır, pin kalkar, "Paylaşım sona erdi" görünür. Paketteki `expires_at` geçince sayfa sunucuyu
   beklemeden kendiliğinden biter.

## Ekran durumları

| Durum | Ne zaman | Metin |
| --- | --- | --- |
| `loading` | İlk anlık görüntü bekleniyor | Konum yükleniyor… |
| `live` | Geçerli paket var | Gönderen adı, "Canlı · şimdi" (core `freshness` + `FRESHNESS_TEXT` + `formatAgo`), "17:30'a kadar · 42 dk kaldı" (core `untilClock`; 24 saatten uzaksa tarih önde) ya da "Süresiz", ±doğruluk, pil |
| `waiting` | Erişim var, gönderen henüz yazmadı | Paylaşan kişinin konumu bekleniyor |
| `ended` | Erişim VARDI; sonra düğüm silindi / `permission_denied` / `expires_at` geçti | Paylaşım sona erdi |
| `unavailable` | İlk okuma reddedildi (hiç erişim olmadı) | Bağlantı geçersiz ya da süresi dolmuş |
| `invalid` | Adres `/s/<geçerli biçimde token>` değil | Bağlantı geçersiz |
| `offline` | Yüklenirken ağ yok (tarayıcı çevrimdışı ya da 8 sn içinde bağlanamadı) | İnternet bağlantısı yok |
| `error` | Dinleyici izin dışı bir hatayla düştü / Firebase yapılandırması eksik | Konum şu an alınamıyor (Yeniden dene) |

Canlıyken bağlantı koparsa durum `live` kalır (son bilinen konum), üstte "Çevrimdışı" çipi ve "Bağlantı yok · N dk önce"
görünür. Var olmayan, bitmiş ve süresi dolmuş bağlantı bilerek ayırt edilmez. `unavailable` ve `ended` ayrımı, başlık ve
açıklama metinleri core'dadır (`linkViewState` + `hadAccess`, `LINK_VIEW_TEXT`, `LINK_VIEW_DETAIL`): uygulama içi izleyici
(`app/s/[token].tsx`) aynı metinleri gösterir. `offline` ve `error` yalnızca web'e özgüdür.

### Faz 3: son doğrulanmış konum, gecikme, düşük pil, kuyruk

Canlı kartın üst satırı core `lastVerifiedLocation` / `receiverStatusOf` ile gönderenin kalp atışına (`hb`, pakette;
yoksa 10 dk) göre yazılır. Sekme bu oturumda gördüğü son 20 paketi yalnızca bellekte tutar (bitince/kesilince silinir).

| Durum | Ne zaman (sessizlik = şimdi − son paketin `server_ts`) | Üst satır | Ek |
| --- | --- | --- | --- |
| `live` | ≤ 2·hb ve ölçüm ≤ 2 dk | Canlı · şimdi | — |
| `recent` | ≤ 2·hb, ölçüm daha eski (sabit duran gönderen 15 dk'da bir yazar: sahte alarm yok) | Güncel · 8 dk önce | "Son doğrulanmış konum · 14:05 · %42" |
| `delayed` | > 2·hb + 30 sn | Güncelleme gecikiyor · 5 dk önce | aynı etiket |
| `offline_suspected` | > 4·hb + 30 sn | Bağlantısı kopmuş olabilir · 9 dk önce | etiket + "Telefonu çekim alanı dışında ya da kapalı olabilir…"; pin gri ama YERİNDE (paylaşım bitmedi) |
| `stale` | > max(6 sa, 6·hb) | Uzun süredir güncelleme yok · 7 sa önce | aynı |

- Pin, doğruluk dairesi ve "Haritada göster" doğruluğu ≤ 100 m olan EN SON ölçümdedir: kötü doğruluklu bir hücre ölçümü iyi GPS
  noktasını ezmez. Pil en son paketten gelir.
- Sayfa kendisi çevrimdışıyken gönderen hakkında karar verilmez: "Bağlantı yok · N dk önce" (Faz 2) önceliklidir.
- Düşük pil: `battery_pct ≤ %15` → bildirimle aynı metin (core `lowBatteryPushText`): "Ayşe Yılmaz'ın pili azaldı · Pil %14. Konum daha
  seyrek güncellenecek.", pil kutusu uyarı tonunda. Bağlantı paketi `is_charging` taşımaz (gizlilik); not pil %15'in üstüne çıkınca kalkar.
- Kuyruk (`q: 1`): bağlantıya iz yazılmaz (`LINK_TRAIL_ENABLED = false`), yalnızca kuyruktaki EN SON nokta gelir → sakin not
  "Bağlantı geri geldi · çevrimdışıyken kaydedilen konum eşitlendi" (aynı 2 dk içinde birden çok gelirse core `syncedPointsText`), 2 dk sonra kalkar.
  Daha eski kuyruk noktası konumu geri almaz (RTDB kuralı da reddeder).
- Gizlilik Faz 2 ile aynı: koordinat ekrana yazılmaz, `recorded_at` / `is_charging` / kimlikler bağlantı paketinde yok, yeni ağ isteği yok.
- Ekran okuyucu: durum ya da düşük pil değişince tek satır duyuru ("Ayşe Yılmaz: Bağlantısı kopmuş olabilir").
- Önizleme (mock): `?senaryo=gecikiyor | kopuk | dusukpil | esitlendi`; konsolda `__konumMock.emitLive({ hb, q, server_ts, battery_pct })`,
  `__konumMock.setServerOffset(ms)` (paket gelmeden zamanı ilerletir).

Düğmeler: **Uygulamada aç** (`konum://s/<token>`), **Haritada göster** (`https://www.google.com/maps?q=lat,lng`,
yeni sekme, `noreferrer`) ve mağaza rozetleri (adres verilmemişse "Yakında" yer tutucusu).

## Harita

- `VITE_GOOGLE_MAPS_WEB_KEY` varsa **Google Maps JavaScript API** (`@googlemaps/js-api-loader`, `v=weekly`,
  `language=tr`, `region=TR`). Açık / koyu JSON stil mobil `mapStyleFor` ile aynı, cihaz ayarı değişince canlı
  güncellenir. Pin özel `OverlayView` (JSON stil `mapId` istemez), doğruluk dairesi `Circle`.
  Kullanıcı haritayı sürüklerse takip durur, "Kişiye odaklan" düğmesi çıkar.
- Anahtar yoksa ya da Google anahtarı reddederse (`gm_authFailure`) **yedek görünüm**: ağ isteği yapmayan sade bir
  vektör desen; pin ortada, desen kişiyle birlikte kayar, ölçek çubuğu var, koordinat yazılmaz (gerçek konum
  "Haritada göster" bağlantısının arkasında).
- Pin hareketi: core `markerTransition` (ilk konum / > 2 km / > 120 sn → doğrudan, aksi hâlde 300 ms – 2 sn) +
  `interpolateLatLng(…, animationProgress(…))`, `requestAnimationFrame` ile. Animasyon ortasında yeni konum gelirse
  görünen konumdan devam eder. "Hareketi azalt" açıksa animasyon yok.

### Maps maliyet ve kota kuralları

- Harita betiği yalnızca **ilk canlı konum geldiğinde** yüklenir; geçersiz, bitmiş, bekleyen bağlantı Maps yüklemez
  (Dynamic Maps ücreti harita yüklemesi başınadır).
- Sayfa başına **tek** `Map` örneği; konum güncellemeleri yeni yükleme saymaz. Bittikten sonra harita yeniden kurulmaz.
- Web görüntüleyici Routes / Geocoding / Places **çağırmaz**; yalnızca `maps` kütüphanesi yüklenir.
- Anahtar GCP'de yalnızca **Maps JavaScript API**'ye ve **HTTP referrer** `https://<LINK_DOMAIN>/*` ile kısıtlanır;
  günlük istek tavanı ve bütçe uyarısı kurulmalı [Varsayım: tavan değeri ürünle belirlenecek].

## Gizlilik

- Token adresten silinir; Maps JS (kimlik doğrulama isteğinde sayfa adresini gönderir) ve tarayıcı geçmişi `/s/canli` görür.
  Token yalnızca bellekte + sekmenin `sessionStorage`'ında; hiçbir yere gönderilmez, günlüğe yazılmaz. Firebase'e yalnızca özet gider.
- `<meta name="referrer">`: anahtarsız derlemede `no-referrer`; anahtarlı derlemede `strict-origin` (referrer kısıtlı anahtar
  kaynağı görmek zorunda; yol yine gitmez). Playwright testi Referer'ın yalnızca kaynak olduğunu denetler.
- Derlenen `index.html`'de CSP meta: `default-src 'none'`, yalnızca kendi dosyalarımız, RTDB (WebSocket + uzun yoklama),
  anahtar varsa Google Maps alanları. zod JIT kapalı (`src/zodSetup.ts`), `unsafe-eval` gerekmez.
- `noindex, nofollow`, `robots.txt` her şeyi kapatır; analitik, çerez, dış font yok. Bağlantı önizlemesi (`og:`) kişisel bilgi içermez.
- Sınır: ilk sayfa isteği `/s/<token>` yolunu Firebase Hosting'e gönderir (bağlantının doğası). Hosting istek günlükleri
  Cloud Logging'e aktarılıyorsa yol görünür [Varsayım: aktarım kapalı tutulmalı ya da `/s/` yolu dışlanmalı].

## Ortam değişkenleri

Hepsi derlemeye gömülür; gizli değer içermez. Örnek: `.env.example`.

| Değişken | Açıklama |
| --- | --- |
| `VITE_FIREBASE_PROJECT_ID` | Firebase proje kimliği (üretim) |
| `VITE_FIREBASE_DATABASE_URL` | RTDB adresi, `https://…firebasedatabase.app` (europe-west1) |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID` | İsteğe bağlı (RTDB okuması için gerekmez) |
| `VITE_GOOGLE_MAPS_WEB_KEY` | Maps JavaScript API anahtarı; boşsa yedek görünüm |
| `VITE_APP_STORE_URL`, `VITE_PLAY_STORE_URL` | Mağaza adresleri (yalnızca `https://`); boşsa "Yakında" |
| `VITE_USE_EMULATORS=1` | RTDB emülatörüne bağlan (proje ve ad alanı `demo-konum`) |
| `VITE_RTDB_EMULATOR_HOST` | Varsayılan `127.0.0.1:9000` |
| `VITE_RTDB_NAMESPACE` | Varsayılan `demo-konum` (`backend/.firebaserc` → `database` hedefi `live`) |

Firebase yapılandırması eksikse sayfa açılır ama "Konum şu an alınamıyor" gösterir.

## Geliştirme

```bash
cd apps/web && npm ci

# Sahte veri kaynağıyla (Firebase gerekmez). Token üret:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm run dev:mock      # http://localhost:5173/s/<token>?senaryo=canli  (bekliyor | bitti | gecersiz | cevrimdisi)
                      # tarayıcı konsolunda: __konumMock.emitLive({lat, lng}), .remove(), .deny(), .setConnected(false)

# RTDB emülatörüyle:
cd ../../backend && npm run emulators                    # ayrı terminal
cd ../apps/web && VITE_USE_EMULATORS=1 npm run dev       # http://localhost:5173/s/<link_share_create yanıtındaki token>
```

Sahte kaynak (`src/data/mockSource.ts`) yalnızca `--mode mock` derlemesine girer; üretim paketinde yoktur.

## Testler

```bash
npm run typecheck
npm test              # vitest: durum makinesi, sunum metinleri, pin animasyonu, token, yapılandırma, CSP
npm run e2e           # mock derleme + Playwright duman testi (playwright ve Chromium kurulu olmalı)

# Google Maps yolu (gerçek Google'a gidilmez; Playwright sahte betik verir):
VITE_GOOGLE_MAPS_WEB_KEY=stub npx vite build --mode mock --outDir dist-mock-maps --emptyOutDir
DIST_MAPS=dist-mock-maps OUT_DIR=e2e-output node e2e/smoke.cjs
```

`e2e/*.cjs` Playwright'ı `require('playwright')` ile kullanır (pakete bağımlılık olarak eklenmedi; yerelde
`npm i --no-save playwright && npx playwright install chromium`).

Duman testi durumları, Faz 3 durumlarını (hb'ye göre gecikme → bağlantı kopması, kuyruk notu, %15 düşük pil, kötü doğruluklu
ölçüm, sabit gönderende sahte alarm olmaması), yumuşak hareketi, süre dolumunu, adresten token silinmesini, üçüncü taraf istek / CSP ihlali /
konsol hatası olmamasını denetler ve 390x844 ekran görüntülerini `OUT_DIR`'e yazar.

### Uçtan uca kabul testi (gerçek emülatörler)

`e2e/emulator.cjs` (`e2e/run-emulator.sh`) GERÇEK Auth + Firestore + RTDB + Functions emülatörlerine (Cloud Tasks
emülatörü otomatik açılır), `VITE_USE_EMULATORS=1` ile derlenmiş bu sayfaya (`vite preview`, port 8211) ve mobil
uygulamanın kendi yayıncı koduna (`publishLinkSample`, `LinkDocSchema`; `e2e/integration/lib.ts` esbuild ile paketlenir)
karşı çalışır. Gönderen, kimliği doğrulanmış istemci SDK'sıyla ve kurallar uygulanarak yazar.

```bash
cd ../../backend && npm run build
npx firebase emulators:exec --project demo-konum --only auth,firestore,database,functions "bash ../apps/web/e2e/run-emulator.sh"
# OUT=<klasör> ekran görüntüleri ve e2e-results.json için (varsayılan apps/web/e2e-output)
```

Denetlenenler (59): oluşturma yanıtı core şemasıyla, URL/derin bağlantı çözümü, düz token'ın Firestore ve `ops`
kaydında olmaması, `link_acl` biçimi ve kapalılığı, `link_live` alan listesi ve kural negatifleri, sayfanın canlı
görünümü (ad, pin, token'ın adresten silinmesi), yeni konum, +30 dk uzatmanın açık sekmeye yansıması ve yayıncının
tazeleyip yeniden denemesi, yanlış/bozuk token, "Paylaşımı Durdur" sonrası 2 sn içinde "Paylaşım sona erdi" ve pinin
kalkması, durdurulan bağlantıya okuma/yazma reddi, ağa token çıkmaması, 15 dk bağlantıda süre dolumunda okuma/yazma
reddi ve sunucunun kapatması (görev ya da tarayıcı), aynı `op_id` tekrarında token yenileme.

### Faz 3 uçtan uca kabul testi

`e2e/faz3/faz3.cjs` (`e2e/faz3/run-faz3.sh`) aynı emülatörlere karşı mobilin kendi kodunu çalıştırır:
`publishSample` / `publishLinkSample` (`hb` ile), `createOutboxRepo` (çevrimdışı kuyruk → `q: 1` canlı + `live_trail`
partileri), `stepLowBattery` (→ `battery_low_notify`) ve backend `sweepStalls` (sahte `now`, yakalayıcı push).
`dist-emu` varsa web görüntüleyicinin gerçek `hb` / `q: 1` paketlerini gösterdiğini de denetler (port 8212).

```bash
cd ../../backend && npm run build
npx firebase emulators:exec --project demo-konum --only auth,firestore,database,functions "bash ../apps/web/e2e/faz3/run-faz3.sh"
# SKIP_WEB=1 (görüntüleyici adımı yok), SKIP_WEB_BUILD=1 (dist-emu hazır), WITH_FAZ2=1 (önce Faz 2 e2e), OUT=<klasör>
```

Denetlenenler (57): bkz. `docs/PHASE3.md` §4.1.

## Derleme ve yayın

```bash
npm run build         # tsc + vite build → dist/ (base '/', dist/index.html)
```

Yayın backend üzerinden yapılır: `backend/hosting/assemble.mjs` `apps/web/dist` + `backend/hosting/public`
(`.well-known/apple-app-site-association`, `assetlinks.json`) → `backend/hosting/dist`; `firebase.json` `/s/**` → `/index.html`
yeniden yazımı ve `/s/**` başlıkları (`no-store`, `noindex`, referrer) oradadır.

```bash
npm --prefix ../apps/web ci && npm --prefix ../apps/web run build    # backend klasöründen
firebase deploy --only hosting
```

Token silindikten sonraki adres `/s/canli` de `/s/**` kuralına uyar; `trailingSlash: false` yönlendirmesine takılmaz.

## [Varsayım] ve açık konular

- Mağaza adresleri ve uygulama kimlikleri yok: rozetler yer tutucu; iOS Smart App Banner (`apple-itunes-app`) eklenmedi.
- Android'de `konum://` yerine `intent://…#Intent;scheme=konum;package=…;S.browser_fallback_url=…;end` mağazaya düşebilir
  (paket adı kesinleşince).
- RTDB App Check zorlaması açılırsa bu sayfa reCAPTCHA Enterprise ile App Check kullanmalı; şu an kimliksiz okur.
- Maps JS CSP izin listesi Google'ın kılavuzuna göre; gerçek anahtarla bir kez doğrulanmalı.
