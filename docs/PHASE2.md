# Faz 2: Native Google Maps, paylaşım süreleri ve QR paylaşımı

Faz 2, Faz 1'in kimlik, arkadaşlık (`friendships`), aktif paylaşım (`location_shares`) ve canlı konum paketi
sözleşmelerini **genişletir**; hiçbir Faz 1 alanının anlamı değişmez. Sözleşmelerin tek kaynağı `packages/core`'dur
(`link.ts`, `markerMotion.ts`, `mapsPolicy.ts`, `contracts.ts`, `model.ts`). Tahmine dayanan her karar
**[Varsayım]** diye işaretlidir.

| İstenen | Nerede |
| --- | --- |
| Native harita, açık/koyu stil, yumuşak pin hareketi | `apps/mobile/src/features/map/*`, `ui/theme.ts` (`mapStyleFor`), core `markerMotion.ts` |
| Rota çizgisi + ETA ve kalan mesafe alt kartı | `EtaCard`, `useEta`, `services/maps/routesRepo.ts`, backend `route_compute` |
| Adres metni (maliyetsiz önbellekli) | `services/maps/geocodeRepo.ts`, backend `geocode_reverse`, core `GEOCODE_POLICY` |
| Süreler, bitişe yakın bildirim, +30 dk / +1 saat | core `duration.ts`, mobil `linkStore`, `expiryNotifications`, backend `link_share_extend` |
| QR ve paylaşım bağlantısı | backend `link_share_create`, mobil `LinkQrSheet`, core `link.ts` |
| Universal Links / App Links, uygulama yoksa web haritası | `app.config.ts`, `app/s/[token].tsx`, `backend/hosting`, `apps/web` |
| Anında iptal, pinin kalkması | backend `link_share_stop` + RTDB kuralları, web/uygulama görüntüleyicisi |
| Maps maliyet ve kota koruması | §4; backend `handlers/maps.ts`, core `mapsPolicy.ts` |

Durum: kod hazır; birim, kural ve emülatör testleri ile gerçek emülatörlere karşı uçtan uca kabul testi geçiyor
(§5). Gerçek Firebase projesinde, gerçek Google anahtarlarıyla ve cihazda denenmedi (bkz. `PHASES.md`, Faz 2 → Faz 3).

---

## 1. Harita ekranı

### 1.1 Bileşen ağacı

```text
MapHome (app/(main)/index.tsx) — seçim durumu, ulaşım modu, sayfalar
├─ MapCanvas — react-native-maps, PROVIDER_GOOGLE (iOS ve Android'de native Google Maps SDK)
│   ├─ FriendMarker × n — MarkerAnimated + useMarkerMotion (yumuşak kayma, seçiliyse vurgulu)
│   ├─ DestinationPin — haritaya uzun basınca bırakılan hedef
│   └─ Polyline — seçili hedefin rotası (core decodePolyline)
├─ TopBar · IncomingStrip (bana paylaşanlar; dokununca seçer) · SyncBanner · RecenterButton
├─ alt alan
│   ├─ seçim VARSA: ExpiryBanner(lar) → EtaCard
│   └─ seçim YOKSA: BackgroundPermissionHint → ExpiryBanner(lar) → ActiveShareCard × oturum
│                    → ActiveLinkCard × bağlantı | ShareButton
├─ ShareSheet — "Arkadaşlar | Bağlantı (QR)" (AudienceSwitch) → DurationPicker → PermissionFlow
└─ LinkQrSheet — QR, bağlantı, Kopyala / Paylaş, kalan süre, +30 dk / +1 saat, "Paylaşımı durdur"

app/s/[token].tsx (kimlik kapısı dışında, kökte)
└─ LinkViewerScreen — salt okunur: LinkViewerMap (tek pin + doğruluk halkası) + durum kartı
```

Seçim: arkadaş pinine ya da şeritteki kişiye dokunmak o arkadaşı, haritaya uzun basmak bir noktayı seçer.
Arkadaşın paylaşımı biterse seçim kalkar. Rota ve adres yalnızca `EtaCard` ekrandayken istenir.

**Harita stili.** `mapStyleFor(scheme)` tema belirteçlerinden tam açık ve koyu JSON stil üretir ve
`customMapStyle` ile verilir; sistem teması değişince harita da değişir. Web görüntüleyicisi aynı belirteçleri
kullanır (`apps/web/src/theme/tokens.ts`). [Varsayım] Bulut tabanlı harita stili (Map ID) kullanılmıyor; JSON stilin
ek ücreti yoktur, Google'ın güncel koşullarıyla doğrulanmalı.

### 1.2 Pin animasyonu

Karar kuralı core'dadır (`markerTransition`); mobil, web ve tarayıcı önizlemesi aynı kuralı kullanır:

| Durum | Davranış | Sabit (`MARKER_MOTION`) |
| --- | --- | --- |
| İlk konum | Anında konumlan (`snap: first`) | — |
| Önceki konumdan > 2 km uzak | Anında konumlan (`snap: jump`): uçan pin yanıltır | `snapDistanceM: 2000` |
| İki örnek arası > 120 sn | Anında konumlan (`snap: gap`) | `snapGapMs: 120000` |
| Diğer | İki örnek arasındaki süre kadar, `easeInOutCubic` ile kay | `minDurationMs: 300`, `maxDurationMs: 2000` |
| Daha eski ya da aynı örnek | Yok say (`planMarkerMove`) | — |

- **Mobil:** `useMarkerMotion` → `AnimatedRegion` + JS `Animated.timing` (iki platformda aynı kod yolu). Native
  `animateMarkerToCoordinate` seçilmedi: react-native-maps 1.29'da iOS Google oluşturucusunda animasyon yapmıyor,
  Android'de farklı eğri kullanıyor. Yeni konum animasyon sürerken gelirse `stopAnimation` pinin o anki yerini verir
  ve yeni animasyon oradan başlar (geri sıçrama yok). 180. meridyen kısa yoldan geçilir (`unwrapLng`).
- **Web:** `MarkerAnimator` + `requestAnimationFrame`, core `interpolateLatLng(animationProgress(...))`; ara noktadan
  devam eder, "hareketi azalt" açıksa doğrudan konumlanır.
- Maliyet: örnekler 10–60 sn arayla gelir, animasyon en çok 2 sn sürer; birkaç pin için JS yükü önemsizdir.
  [Varsayım] Google iOS'ta akıcılık cihazda doğrulanmalı.

### 1.3 ETA alt kartı

Tasarım (yukarıdan aşağı):

```text
[avatar] Ayşe                                  ← ad ya da "Seçilen nokta"
         Canlı · Bağdat Cd., Kadıköy           ← tazelik + ters geocode adresi (önbellekli)
[ Araç ] [ Yürüyüş ] [ Bisiklet ]              ← ulaşım modu çipleri
12 dk · 3,2 km                                 ← core formatEtaDuration · formatDistanceTr
Ayşe ilerledikçe güncellenir
[ Rotayı kapat ]
```

Durum metinleri sakindir ve kart çökmez: konum yok, hesaplanıyor, "Harita servisine şu an ulaşılamıyor"
(`maps_unavailable`), günlük sınır doldu (`quota_exceeded`), "Bu iki nokta arasında rota bulunamadı"
(`route_not_found`). Bu durumlarda harita ve pinler çalışmaya devam eder.

Veri akışı:

```text
seçim (arkadaş / nokta) + benim konumum + mod
  → useRouteEta (kart görünür VE uygulama ön planda; konum/hedef/mod değişince ve 15 sn'de bir değerlendirir)
  → routesRepo.refresh: core shouldRecomputeRoute({last, origin, destination, travelMode, now, visible})
       hayır → bellek önbelleğindeki sonuç (32 kayıt, mod başına; moda geri dönmek bedava)
       evet  → tek uçuş: route_compute callable {op_id, origin, destination, travel_mode}
  → backend: App Check → route_cache (5 dk, kullanıcıya özel) → kullanıcı kotası + proje bütçesi
       → Routes API computeRoutes (FieldMask: süre, mesafe, çizgi; DRIVE: TRAFFIC_UNAWARE)
  → {distance_m, duration_s, polyline, cached, computed_at}
  → EtaCard metni + MapCanvas Polyline (decodePolyline) + fitTo(ben, hedef)

seçili hedefin konumu
  → useAddress → geocodeRepo.lookup: core shouldReverseGeocode + geocodeCell (geohash 7, ~150 m)
       hücre bellekte (200 hücre) → isabet; değilse geocode_reverse {lat, lng}
  → backend: geocode_cache/{hücre} (30 gün, ortak) → kota → Geocoding API (hücre MERKEZİ, language=tr)
```

Yeniden hesap eşikleri (`ROUTE_POLICY`): ilk açılış ve mod değişimi hemen; aksi hâlde en az 60 sn arayla ve
yalnızca başlangıç ≥ 150 m ya da hedef ≥ 100 m kaydıysa ya da sonuç 5 dk eskidiyse. Başarısız deneme de "son deneme"
sayılır (sürekli yeniden deneme yok); `maps_unavailable` sonrası 60 sn beklenir, `quota_exceeded` sonrası UTC gün
bitene kadar çağrı yapılmaz.

---

## 2. Paylaşım süresi yaşam döngüsü ve akıllı uzatma

### 2.1 Süre seçenekleri

Arkadaş paylaşımı ve QR bağlantısı aynı süre motorunu (`resolveDuration`) kullanır; bitiş zamanını **sunucu**
hesaplar (gün sonu için istemcinin IANA saat dilimi gönderilir, varsayılan `Europe/Istanbul`).

| Seçenek | `share_mode` | `expires_at` | Uzatılabilir |
| --- | --- | --- | --- |
| 15 dk | `timed` | şimdi + 15 dk | evet |
| 1 saat | `timed` | şimdi + 60 dk | evet |
| 8 saat | `timed` | şimdi + 8 sa | evet |
| Gün sonuna kadar | `until_end_of_day` | yerel 24:00 (1 dk'dan az kaldıysa ertesi gün) | evet, uzatılınca `timed` olur |
| 1 hafta | `weekly` | şimdi + 7 gün | evet, `weekly` kalır |
| Süresiz | `indefinite` | yok (`null`) | hayır; haftalık hatırlatma |

Arkadaş paylaşımında ayrıca "Özel süre" (5 dk – 7 gün) vardır; QR ekranında gösterilmez (`LINK_DURATION_OPTIONS`).

### 2.2 Durum diyagramı (bağlantı; arkadaş paylaşımı Faz 1'de aynı)

```text
                 link_share_create (op_id)
  [süre seçimi] ───────────────────────────► ACTIVE ◄──────────────────────────────┐
                                               │                                     │ sunucu yanıtı
                         now ≥ extendPromptAt  │                                     │ (version+1)
                                               ▼                                     │
                                         EXPIRING_SOON ── "+30 dk" / "+1 saat" ─► EXTENDING
                                               │          (bildirim ya da bant)
            ┌──────────────────────────────────┼───────────────────────────────┐
            │ "Paylaşımı durdur"               │ now ≥ expires_at              │ hesap silme
            ▼                                  ▼                               ▼
        STOPPING ── link_share_stop ──►  ENDED(stopped_by_sender)   ENDED(expired)   ENDED(account_deleted)
   (yayın ANINDA kesilir; niyet diske
    yazılır, aynı op_id ile yeniden denenir)
```

- Sunucu durumu yalnızca `active | ended`'dır (`link_shares.status`); her geçiş `version`'ı artırır ve
  `link_acl` aynası bu sürümle korunur. `EXPIRING_SOON`, `EXTENDING`, `STOPPING` istemci aşamalarıdır
  (`linkStore.linkPhase`).
- `ENDED(expired)`: okuma kuralı `expires_at > now` olduğundan bitiş anında yeni okuma ve yazma kendiliğinden
  reddedilir; Cloud Tasks görevi bitiş anında (ve yedek olarak dakikalık tarayıcı) belgeyi kapatır, mezar taşını
  yazar ve son paketi siler. Gönderen telefon çevrimdışı olsa da kesme sunucuda olur.
- Biten kart 10 dk görünür kalır ("Bağlantının süresi doldu" / "Bağlantı paylaşımını durdurdun"). [Varsayım]

### 2.3 Akıllı süre uzatma

- **Kural (`extendExpiry`):** yeni bitiş = max(şimdiki bitiş, şimdi) + 30 ya da 60 dk; üst sınır **şimdi + 7 gün**.
  Gün sonu uzatılınca `timed` olur, haftalık haftalık kalır. Süresiz uzatılamaz (`invalid_duration`), bitmiş
  `share_not_active`, süresi geçmiş `already_expired` döner. Sunucu `extended_count`'u artırır.
- **Uyarı zamanı (`extendPromptAt`):** bitişten `extendPromptLeadMs(toplam süre)` önce = toplam sürenin %20'si,
  en az 3 dk, en çok 15 dk. [Varsayım]

  | Süre | Uyarı | Süre | Uyarı |
  | --- | --- | --- | --- |
  | 15 dk | bitişe 3 dk kala | 8 saat | 15 dk kala |
  | 1 saat | 12 dk kala | Gün sonu (≥ 75 dk kalmışsa) | 15 dk kala |
  | 1 hafta | 15 dk kala | Süresiz | uyarı yok; haftada bir "Konum bağlantın hâlâ açık" |

  Uzatmadan sonra toplam süre büyüdüğü için uyarı anı yeniden hesaplanır ve bildirim yeniden planlanır.
- **Bildirim:** paylaşan kişinin cihazında yerel bildirim (`expo-notifications`, Faz 1 ile aynı `SHARE_EXPIRING`
  kategorisi), kimlik `share-expiring-link:<link_id>`. Eylemler **"+30 dakika"** ve **"+1 saat"**: uygulama açık değilse
  bildirimde saklanan `op_id` ile `link_share_extend` çağrılır (tekrar güvenli), açıksa `linkStore` üzerinden.
  Durdurulmuş bağlantı uzatılmaz. Uygulama içinde aynı an `ExpiryBanner` bandı çıkar (+30 dk / +1 saat).
  [Varsayım] Sunucu push'u (`link_ending_soon`) Faz 2'de gönderilmiyor; sözleşmede ayrılmış.
- Uzatma sonrası sunucu `link_acl.expires_at` ve saklanan paketin `expires_at`'ını aynı çağrıda eşitler; açık web
  sekmesindeki "HH:MM'e kadar" satırı hemen güncellenir. Eski bitişle yazan yayıncı reddedilir, `link_shares`'tan
  tazeleyip bir kez yeniden dener (e2e'de doğrulandı).

---

## 3. QR token'ı, yönlendirme, salt okunur web ve anında iptal

### 3.1 Token üretimi ve saklama

- **Üretim (yalnızca sunucu):** `crypto.randomBytes(32)` → base64url, dolgusuz **43 karakter, 256 bit** entropi.
  Kanonik biçim `LINK_TOKEN_RE` (`/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/`): her token tek bayt dizisine karşılık gelir.
  Tahmin ya da kaba kuvvet pratikte imkânsızdır; RTDB yolu ayrıca listelenemez.
- **Saklanan:** yalnızca `token_hash = SHA-256(token)` (64 hex). Token yüksek entropili rastgele olduğu için tuz ya da
  yavaş özet gerekmez; özet aynı zamanda RTDB anahtarıdır (`link_acl/{hash}`, `link_live/{hash}`).
- **Düz token** yalnızca `link_share_create` yanıtında bir kez döner: Firestore'a, `ops` tekilleştirme kaydına
  (`token_omitted: true`) ve loglara yazılmaz (e2e'de doğrulandı). Gönderen cihaz URL'yi SecureStore'da
  (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) tutar; arka plan yayıncısı yalnızca `token_hash` bilir.
- **Yanıtı kaybolan oluşturma:** aynı `op_id` ile tekrar edilirse ve bağlantı aktifse sunucu **token'ı yeniler**
  (aynı `link_id`, yeni token/özet, `version+1`) ve eski özeti hemen kapatır. Eski token'ı kimse görmemiştir.
- **Sınırlar:** kullanıcı başına aynı anda 5 aktif bağlantı (`link_limit_reached`), saatte 20 oluşturma
  (`rate_limited`). [Varsayım]

### 3.2 QR ve bağlantı biçimi

- QR içeriği: `https://<LINK_DOMAIN>/s/<token>` (core `buildLinkUrl`; varsayılan alan `konum.example.com` [Varsayım]).
  QR hata düzeltme M, 4 modül sessiz alan, her temada koyu/beyaz.
- Kabul edilen girişler (core `parseLinkToken`): `https://<alan>/s/<token>[/][?…][#…]`, `konum://s/<token>`,
  `konum:///s/<token>`, çıplak token. Başka alan, kullanıcı bilgisi ya da bozuk token reddedilir; `http` yalnızca
  `localhost` / `127.0.0.1` için.

### 3.3 Universal Links / App Links ve web'e geri dönüş

```text
QR okutuldu → https://<LINK_DOMAIN>/s/<token>
  ├─ uygulama kurulu ve alan doğrulanmış
  │    iOS:     associatedDomains "applinks:<LINK_DOMAIN>" + AASA appIDs "<TEAM_ID>.<BUNDLE_ID>", components "/s/*"
  │    Android: intent filter VIEW, autoVerify, https, host <LINK_DOMAIN>, pathPrefix /s/ + assetlinks.json
  │             (package_name + imza SHA-256 parmak izleri)
  │    → expo-router app/s/[token].tsx (giriş gerekmez) → resolveLinkParam (yalnızca uygulamanın alan adı)
  │    → linkTokenHash (cihazda, saf TS) → link_live/{hash} dinlenir → uygulama içi canlı harita
  └─ uygulama yok (ya da bağlantı doğrudan tarayıcıda açıldı)
       → Firebase Hosting: /s/** → /index.html (apps/web)
       → token okunur, adres /s/canli yapılır (Firebase ve Maps JS yüklenmeden ÖNCE), token yalnızca bellekte
         + sekmenin sessionStorage'ında → salt okunur mobil web haritası
       → "Uygulamada aç" (konum://s/<token>) ve mağaza rozetleri
```

- Hosting: `/.well-known/apple-app-site-association` ve `/.well-known/assetlinks.json` `application/json` olarak,
  `hosting/assemble.mjs` `apps/web/dist` + `hosting/public`'i `hosting/dist`'e birleştirir.
- [Varsayım] iOS, Universal Link'i adres çubuğuna yazılan ya da aynı alan içinde gezilen bağlantıda tetiklemez; bu
  durumda web sayfasındaki "Uygulamada aç" düğmesi devreye girer.
- Uygulama açıkken gelen bağlantı, açık paylaşım/QR sayfalarını kapatarak izleyiciyi öne getirir.

### 3.4 Salt okunur web görünümü veri sözleşmesi

Okunan tek yol: RTDB `link_live/{SHA-256(token)}`; kimlik doğrulama yok. Okuma kuralı:
`link_acl/{hash}.status == 'active'` ve (`expires_at` yok ya da `> now`). `link_acl` ve `link_live` kökleri
listelenemez; `link_acl` istemciye tamamen kapalıdır.

| Alan (`LinkLiveLocation`) | Tür | Anlamı |
| --- | --- | --- |
| `v` | sayı | paket sürümü (1) |
| `lat`, `lng` | sayı | konum (6 ondalık) |
| `accuracy` | sayı, m | doğruluk yarıçapı (0–1000) |
| `heading` | sayı \| yok | yön, 0–360 |
| `speed_mps` | sayı \| yok | hız, m/sn |
| `battery_pct` | 0–100 \| yok | pil yüzdesi |
| `timestamp` | epoch ms | örneğin alındığı an (sunucu saatine çevrilmiş) |
| `server_ts` | epoch ms | sunucunun yazmayı kabul ettiği an (kural `== now` ister) |
| `sender_name` | metin ≤ 40 | yalnızca görünen ad (`linkSenderName`) |
| `expires_at` | epoch ms \| yok | bitiş (ACL ile aynı olmak zorunda; süresizde yok) |
| `share_mode` | metin | `timed` / `until_end_of_day` / `weekly` / `indefinite` |

**Bilerek dışarıda:** `sender_id`, `link_id`, `session_id`, `share_id`, alıcı listesi, telefon, `avatar_url`
[Varsayım], `is_charging`, `activity_state`, `mocked`. Yazma kuralı yalnızca bu alanlara izin verir, yazanın ACL'deki
gönderen olmasını ve `share_mode` / `expires_at`'ın ACL ile aynı olmasını ister.

Ekran durumları (core `linkViewState`; web ve uygulama aynı başlık ve açıklamayı kullanır, `LINK_VIEW_TEXT` /
`LINK_VIEW_DETAIL`):

| Durum | Ne zaman | Başlık |
| --- | --- | --- |
| `invalid` | token biçimi bozuk (ağa çıkılmaz) | Bağlantı geçersiz |
| `unavailable` | ilk okuma reddedildi: yok, durdurulmuş ya da süresi dolmuş **ayırt edilmez** | Bağlantı geçersiz ya da süresi dolmuş |
| `loading` / `waiting` | ilk anlık görüntü bekleniyor / düğüm henüz boş | Konum yükleniyor… / Paylaşan kişinin konumu bekleniyor |
| `live` | geçerli paket | ad, "Canlı · şimdi", "HH:MM'e kadar", doğruluk, pil |
| `ended` | erişim vardı, sonra düğüm silindi / ret / `expires_at` geçti; **pin kalkar** | Paylaşım sona erdi |
| `offline`, `error` (yalnızca web) | ağ yok / beklenmeyen hata | İnternet bağlantısı yok / Konum şu an alınamıyor |

Web görüntüleyicisi Routes ya da Geocoding API çağırmaz; konum diske yazılmaz.

### 3.5 Anında iptal ve süre dolumu

```text
"Paylaşımı durdur" (gönderen)
 0. İstemci: linkStops kesme anahtarı → sonraki konum örneği YAZILMAZ; niyet diske yazılır
 1. link_share_stop (op_id) → Firestore transaction: status=ended, end_reason=stopped_by_sender, version+1,
    link_acl_pending işareti
 2. RTDB link_acl/{hash} → mezar taşı {status:'ended', version, ended_at, end_reason} (sürüm korumalı)
 3. RTDB link_live/{hash} silinir → açık dinleyiciler null alır → "Paylaşım sona erdi", pin kalkar
 4. Yanıt döner (1–3 callable dönmeden tamamlanır)
 Sonra: yeni okuma → permission_denied ("unavailable"); gönderenin yazması → reddedilir; ACL aynası kaybolursa
 link_acl_reconciler tetikleyicisi, 5 dk'lık denetim ve dakikalık tarayıcı onarır.
```

Ölçülen süreler (gerçek emülatörlerle e2e, §5): durdurma çağrısının başından açık sekmenin "Paylaşım sona erdi"ye
geçmesine **≈ 1,1–1,2 sn** (bunun ≈ 1,1 sn'si emülatördeki callable süresi; sekme yanıtla aynı anda değişiyor);
hedef 2 sn. Süre dolumunda açık sekme bitişten **≤ 1,4 sn** sonra kapandı (istemci saatiyle), yeni okuma ve yazma
bitiş anında reddedildi; sunucu belgeyi Cloud Tasks göreviyle (yoksa dakikalık tarayıcıyla, en geç ≈ 60 sn) kapattı.
Gerçek projede gecikme ağ ve soğuk başlatmaya bağlıdır [Varsayım].

Barındırma başlıkları (`/s/**`): `Referrer-Policy: strict-origin` (yalnızca kök gider, yol/token asla; anahtarsız
sayfa meta ile `no-referrer`'a sıkılaştırır), `Content-Security-Policy: frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`. Sayfanın kendi CSP
meta'sı yalnızca kendi dosyalarına, RTDB'ye ve anahtar varsa Google Maps alanlarına izin verir.

---

## 4. Google Maps Platform maliyet ve kota koruma kuralları

Fiyat bu belgede **verilmez**: SKU adları ve fiyatlar Google'ın güncel fiyat listesi ve ücretsiz kullanım payıyla
doğrulanmalıdır [Varsayım]. Aşağıdakiler kodda uygulanan kaldıraçlardır.

| API | Nerede | Anahtar ve kısıtı | SKU / sayılan birim [Varsayım] |
| --- | --- | --- | --- |
| Maps SDK for iOS / Android | mobil harita | iOS anahtarı: yalnızca Maps SDK for iOS + paket kimliği; Android anahtarı: yalnızca Maps SDK for Android + paket adı ve SHA-1 (debug, upload ve Play imza anahtarları) | Mobile Native Dynamic Maps (harita yüklemesi) |
| Routes API (computeRoutes) | yalnızca sunucu (`route_compute`) | sunucu anahtarı: Secret Manager `GOOGLE_MAPS_SERVER_KEY`, yalnızca Routes + Geocoding API | Compute Routes Essentials (DRIVE trafiksiz, WALK, BICYCLE); trafikli Pro |
| Geocoding API (ters) | yalnızca sunucu (`geocode_reverse`) | aynı sunucu anahtarı | Geocoding |
| Maps JavaScript API | yalnızca web görüntüleyici | web anahtarı: yalnızca Maps JavaScript API + HTTP referrer `https://<LINK_DOMAIN>/*` | Dynamic Maps (sayfa başına harita yüklemesi) |

### 4.1 Maps SDK (mobil)

- Tek ana `MapView` (MapHome): Arkadaşlar ekranı yığına üstten açıldığı için harita altta bağlı kalır ve yeniden
  kurulmaz. İkinci harita yalnızca QR izleyicisi (`app/s/[token]`) açılınca yüklenir. [Varsayım] Yükleme sayısı
  cihazda Cloud Console metrikleriyle doğrulanmalı.
- Statik harita, Street View, Places ve Directions SDK kullanılmaz; stil JSON'dur (Map ID yok).
- Anahtarlar `.env` → `app.config.ts`; üretim derlemesi anahtarsız başlamaz. Anahtar uygulama içinde görünür
  olduğundan güvenlik **kısıtlamadan** gelir: API kısıtı + uygulama kısıtı (paket kimliği / paket adı + SHA-1).

### 4.2 Routes API

- İstemci Google'a doğrudan gitmez; anahtar istemciye inmez. Callable App Check ister (üretim).
- İstemci kuralı (`shouldRecomputeRoute`): yalnızca kart görünür ve uygulama ön plandayken; en az 60 sn arayla;
  başlangıç ≥ 150 m / hedef ≥ 100 m kayınca ya da sonuç 5 dk eskiyince; mod değişimi hemen (çoğunlukla önbellek).
  Tek uçuş, 32 kayıtlık bellek önbelleği.
- Sunucu: `X-Goog-FieldMask: routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline` (yalnızca
  Essentials alanları), alternatif rota yok, DRIVE için varsayılan `TRAFFIC_UNAWARE` (core
  `ROUTE_POLICY.drivePreference`; `ROUTES_DRIVE_PREFERENCE=TRAFFIC_AWARE` bilinçli olarak Pro SKU'ya geçirir).
- Önbellek `route_cache/{başlangıç hücresi.hedef hücresi.mod.5 dk dilimi.uid}`, 5 dk (geohash 7 ≈ 150 m);
  kullanıcıya özel (çizgi başkasının tam başlangıç noktasını taşımasın). İsabet kota yemez, anahtar gerektirmez.
- Kullanıcı başına günde 200 hesap (önbellek hariç), proje geneli günlük bütçe (varsayılan 5000 [Varsayım],
  10 parçalı sayaç, toplamı asla aşmaz). Sayaç Google çağrısından ÖNCE transaction ile ayrılır.

### 4.3 Geocoding API (adres metni)

- Ne zaman: yalnızca ETA kartı görünürken, seçili hedef için; ilk seçimde, sonra yalnızca en az 60 sn geçmiş,
  hedef başka geohash-7 hücresine geçmiş VE ≥ 200 m kaymışsa (`shouldReverseGeocode`). Aynı hücre istemcide
  (200 hücre) ve sunucuda önbellekten gelir.
- Google'a kullanıcının tam konumu değil **hücre merkezi** sorulur (`geocodeQueryPoint`), `language=tr`, kısa adres
  türleri süzgeci. Bu yüzden `geocode_cache/{hücre}` kullanıcılar arasında paylaşılır, TTL 30 gün
  [Varsayım: Google önbellek koşulları doğrulanmalı].
- Kullanıcı başına günde 100, proje geneli günlük bütçe (varsayılan 5000 [Varsayım]).

### 4.4 Maps JavaScript API (web görüntüleyici)

- Yalnızca `VITE_GOOGLE_MAPS_WEB_KEY` verilirse ve **ilk canlı konum geldiğinde**, sayfa başına **bir kez** yüklenir;
  ilk canlı konumdan önce (`invalid`, `unavailable`, `loading`, `waiting`) hiç yüklenmez. `gm_authFailure` → anahtarsız vektör
  yedek görünüm (ağ isteği yok). Anahtar yoksa sayfa tamamen Google'sız çalışır.
- Token adresten Maps JS yüklenmeden önce silinir; referrer kısıtlı anahtar yalnızca kökü görür.
- Web görüntüleyicisi Routes, Geocoding ya da Places çağırmaz.

### 4.5 Katmanlı sınırlar ve acil durdurma

```text
istemci politikası (görünürlük + eşikler) → App Check → sunucu önbelleği → kullanıcı günlük kotası (200 / 100)
  → proje günlük bütçesi (MAPS_DAILY_BUDGET ya da Firestore config/maps, yeniden dağıtım gerekmez)
  → acil kapatma: config/maps {disabled: true} ya da bütçe 0 → quota_exceeded
  → Google Cloud Console API kotaları → faturalandırma bütçe uyarıları
```

Hatalar: anahtar yok / Google hatası / zaman aşımı → `maps_unavailable` (yeniden denenebilir); kota →
`quota_exceeded` (`details.scope: user|global`, `retry_after_ms`); rota yok → `route_not_found`. Loglarda koordinat,
hücre, çizgi, adres ve URL yoktur.

### 4.6 Cloud Console ayarları (yayından önce)

- [ ] Her platform için ayrı anahtar (iOS, Android, web, sunucu); her anahtarda **API kısıtı** + uygun **uygulama
      kısıtı** (paket kimliği; paket adı + SHA-1; HTTP referrer). Sunucu anahtarı Secret Manager'da.
- [ ] APIs & Services → Quotas: Routes API (ComputeRoutes istek/dk ve /gün), Geocoding API (istek/gün),
      Maps JavaScript API ve Maps SDK (harita yüklemesi/gün) için uygulama bütçesinin biraz üstünde tavan
      [Varsayım: değerler ürün trafiğiyle belirlenecek].
- [ ] Billing → Budgets & alerts: proje bütçesi, %50 / %90 / %100 e-posta uyarısı. [Varsayım] Faz 3'te bütçe
      bildirimi (Pub/Sub) `config/maps.disabled` alanını otomatik açabilir.
- [ ] Kullanılmayan Maps API'leri (Places, Directions, Distance Matrix, Static Maps, Street View) projede kapalı.
- [ ] Cloud Monitoring: `maps_unavailable` ve `quota_exceeded` oranı için log tabanlı uyarı.

---

## 5. Testler ve kabul

| Paket | Komut | Sonuç (bu entegrasyon) |
| --- | --- | --- |
| core | `npm test && npm run typecheck` | 112 test, tsc temiz |
| mobil | `npm run typecheck && npm test` | 14 dosya, 98 test |
| mobil paketleri | `EXPO_OFFLINE=1 CI=1 npx expo export --platform android\|ios` | ikisi de derleniyor; demo kodu yok |
| tarayıcı önizlemesi | `npm run web:export` + Playwright akışı | 13/13 |
| backend | `npm test` (emülatörler) | 13 dosya, 150 test |
| web | `npm run typecheck && npm test && npm run build` | 44 test; duman testi 70/70 (Google yolu dahil, sahte betik) |
| **uçtan uca** | `cd backend && npm run build && npx firebase emulators:exec --project demo-konum --only auth,firestore,database,functions "bash ../apps/web/e2e/run-emulator.sh"` | **59/59** |

Uçtan uca test (`apps/web/e2e/emulator.cjs`) gerçek emülatörleri, gerçek web derlemesini (`vite preview`, 8211) ve
mobil uygulamanın kendi yayıncı kodunu (`publishLinkSample`, `LinkDocSchema`) kullanır; gönderen kimliği doğrulanmış
istemci SDK'sıyla, kurallar uygulanarak yazar. Kabul ölçütleri:

- [x] Doğru token canlı konumu ve adı görür; yanlış token okuyamaz ("Bağlantı geçersiz ya da süresi dolmuş").
- [x] Durdurunca açık web sekmesi 2 sn içinde "Paylaşım sona erdi" der ve pin kalkar.
- [x] Süre dolunca okuma ve yazma reddedilir; sunucu belgeyi kapatır.
- [x] Düz token sunucuda (Firestore, `ops`) saklanmaz; web isteklerine ve RTDB çerçevelerine token çıkmaz.
- [x] Yanıtı kaybolan oluşturma token'ı yeniler; eski token'lı sekme kapanır, yayıncı yeni özete geçer.
- [ ] QR'ı okutan cihazda uygulama kuruluysa uygulama içinde açılır (gerçek alan adı ve cihaz gerekir, Faz 3 geçişi).

Ekran görüntüleri (390×844, 2x): `web-live.png`, `web-ended.png`, `web-wrong-token.png` (e2e `OUT` klasörü).

## 6. Açık konular

- [Varsayım] Alan adı `konum.example.com`, AASA `TEAMID.com.example.konum`, assetlinks parmak izi yer tutucu;
  Universal/App Links gerçek değerler girilmeden doğrulanmaz.
- Google anahtarlarıyla hiçbir yol gerçek Google'a karşı denenmedi (sunucu testleri sahte `fetch`, web testi sahte
  Maps betiği kullanır).
- RTDB App Check zorlaması açılırsa anonim web görüntüleyicisi App Check (reCAPTCHA Enterprise) eklemelidir.
- Kota sayacı Google çağrısından önce ayrılır ve başarısız çağrıda geri verilmez (bilinçli: kötüye kullanımda güvenli).
- `route_cache` çizgi (konum izi) tutar; TTL 5 dk ama Firestore TTL silmesi 24 saate kadar gecikebilir; hesap
  silmede hemen silinir.
- `parseLinkLive` zod kullanır; web ana paketi ≈ 104 KB gzip. zod'suz okuyucu paketi küçültebilir (isteğe bağlı).
- Mobil cihazda: Universal/App Links doğrulaması, Google iOS'ta pin animasyonunun akıcılığı, bildirim eyleminin
  uygulamayı öne getirmesi denenmedi.
