# Faz 6: Ana Ekran ve Kilit Ekranı Widget'ları, Tek Dokunuşla 1 Saat, Profil Fotoğrafı ve Cinsiyet Çerçevesi

Faz 6, Faz 1–5 sözleşmelerini **genişletir**: paylaşım, paket ve push alanlarının anlamı değişmedi. Widget'tan başlayan
paylaşım `share_start` ile **aynı iç fonksiyonu** (`writeShareStarts`) kullanır; arka plan takibi Faz 3'ün
`resume_tracking` uyandırmasıyla başlar. Çelişki olursa `packages/core` (`profile.ts`, `favorites.ts`,
`quickShare.ts`, `widget.ts`, `contracts.ts`) geçerlidir. **[Varsayım]** ile işaretlenen her şey gerçek cihazda ya da
ürün kararıyla doğrulanmalıdır.

**Durum:** Kod hazır. Birim, kural ve emülatör testleri geçiyor; tarayıcı demosunda cinsiyetli kayıt → fotoğraf yükleme →
çerçeveli liste ve harita pinleri → favoriler (sınır 4) → widget galerisi (iOS ana ekran, kilit ekranı, Android) →
widget'tan 1 saatlik paylaşım ve geri sayım → token süresi dolunca derin bağlantıyla uygulama akışı uçtan uca çalışıyor
(§9). **Swift ve Kotlin kodu bu ortamda derlenmedi** (Xcode / Android SDK yok); `expo prebuild` iki platformda da
beklenen native yapılandırmayı üretiyor. Gerçek cihazda denenmedi.

| İstenen | Nerede |
| --- | --- |
| Cinsiyet, çerçeve rengi, avatar yolları, baş harfler, tek avatar görünüm modeli | `packages/core/src/profile.ts` (`GENDERS`, `GENDER_RING`, `genderRingColor`, `AVATAR_LIMITS`, `avatarObjectPaths`, `checkAvatarPair`, `initialsOf`, `avatarViewOf`, `resolveProfileGender`) |
| Favoriler (en çok 4, sıra = widget sırası) | `packages/core/src/favorites.ts`, callable `favorites_set` (`backend/functions/src/handlers/favorites.ts`) |
| Hızlı paylaşım kararı, token, hata metinleri, derin bağlantı | `packages/core/src/quickShare.ts` (`quickShareRoute`, `quickShareExpiry`, `quickShareErrorText/Action`, `quickShareDeepLink`, `QUICK_SHARE_NOTIFICATION`) |
| Widget anlık görüntüsü (yerel kodun okuduğu JSON) | `packages/core/src/widget.ts` (`WidgetSnapshot`, `buildWidgetSnapshot`, `widgetSnapshotChanged`, `widgetSyncDecision`, `widgetStatusText`, `formatCountdown`) |
| Token ve hızlı paylaşım callable'ları, `widget_refresh` | `backend/functions/src/handlers/widget.ts`, `callable.ts` (`tokenCallable`), `push.ts` |
| Profil: cinsiyet zorunlu, fotoğraf çifti, eski sürümün silinmesi | `backend/functions/src/handlers/user.ts`, `backend/storage.rules` |
| iOS WidgetKit uzantısı | `apps/mobile/targets/widgets/` (`@bacons/apple-targets`) |
| Android AppWidget + Hızlı Ayar kutucuğu + Expo modülü | `apps/mobile/modules/konum-widgets/` (Kotlin, RemoteViews, config plugin) |
| JS köprüsü, eşitleme, token yaşam döngüsü, başsız benimseme | `apps/mobile/src/services/widgets/{widgetBridge,widgetSync,widgetBackground,widgetAvatarFiles}.ts`, `services/f6Services.ts` |
| Kayıt / profil / cinsiyet kapısı / fotoğraf hattı | `src/features/{auth/ProfileNameScreen,profile/*}`, `app/(main)/profile.tsx`, `src/services/profile/*`, `state/profileStore.ts` |
| Çerçeveli avatar ve harita pini | `src/ui/Avatar.tsx`, `src/features/profile/FriendAvatar.tsx`, `src/features/map/FriendMarker(.web).tsx` |
| Uygulama içi hızlı paylaşım ve derin bağlantı sayfası | `app/quick-share.tsx`, `src/features/quickShare/*`, `state/quickShareStore.ts` |
| Tarayıcı demosu ("FAZ 6 · WIDGET'LAR") | `src/demo/server/{server,avatars}.ts`, `src/demo/web/{widgetModel,widgetSim}.ts`, `src/demo/shell/Faz6.web.tsx` |

---

## 1. Widget mimarisi

### 1.1 Ortak ilke: uygulama yazar, widget yalnızca okur

```text
uygulama (JS)                                       paylaşılan alan                      widget
 depolar (arkadaşlar, gelen konumlar, paylaşımlarım, ─▶ App Group UserDefaults (iOS) /  ─▶ WidgetKit zaman çizelgesi /
 favoriler, izinler, bölge adları)                      SharedPreferences "konum_widgets"   AppWidgetProvider (RemoteViews)
   → core buildWidgetSnapshot (saf, ≤ 16 KB)           konum.widget.snapshot.v1 (JSON)
   → widgetSnapshotChanged: none / minor / major       avatar dosyaları (120 px JPEG)
   → widgetSyncDecision (yazma ≥ 60 sn, yenileme ≥ 5 dk; major hemen)
 token yöneticisi ─────────────────────────────────▶ anahtarlık (App Group erişim grubu) /
   widget_token_issue (cihaza özel, 30 gün)           AndroidKeyStore AES-GCM ile şifreli tercih
 consumeEvents() ◀──────────────────────────────────── konum.widget.events.v1 (widget'ın hızlı paylaşım sonuçları)
```

- Widget **Firebase'e bağlanmaz**, Firestore / RTDB dinlemez. Tek ağ çağrısı "1 sa paylaş" düğmesindeki
  `widget_quick_share` HTTP isteğidir (token ile, Firebase oturumu ve App Check olmadan).
- Anlık görüntü **snake_case JSON**, `v: 1`. Swift `Codable` (`convertFromSnakeCase`) ve Kotlin `org.json` aynı
  anahtarları okur; `__tests__/widgetBridge.test.ts` Swift ve Kotlin kaynaklarındaki her anahtarın gerçek
  `buildWidgetSnapshot` çıktısında bulunduğunu denetler (alan adı değişirse test kırılır).
- Durum metinleri (`widgetStatusText`), geri sayım biçimi (`formatCountdown`), hata metinleri ve yönlendirme sırası
  (`quickShareRoute`) core'da tanımlıdır; Swift / Kotlin bunların birebir kopyasıdır (yorumlarda kaynak belirtilir).

```ts
interface WidgetSnapshot {
  v: 1; generated_at; signed_in; me_initials; default_uid;        // default_uid = ilk favori
  favorites: WidgetFavorite[];                                     // ≤ 4, favori sırasıyla
  quick: { token_ok; bg_location_ok };                             // token'ın KENDİSİ yok
  privacy: { lock_screen_details };                                // varsayılan false
}
interface WidgetFavorite {
  uid; name (≤ 18); initials; gender; ring;                        // ring = genderRingColor
  avatar_file;                                                     // paylaşılan alandaki DOSYA ADI, asla URL
  status: 'sharing_live' | 'sharing_stale' | 'not_sharing' | 'paused';   // ONUN bana paylaşımı
  last_seen_at; place (≤ 28, bölge adı ya da kısa adres; koordinat benzeri metin atılır);
  battery_pct; battery_low;
  my_share_expires_at; my_share_active;                            // BENİM ona paylaşımım → geri sayım
}
```

### 1.2 iOS: WidgetKit (`targets/widgets`, `@bacons/apple-targets`)

| Konu | Karar |
| --- | --- |
| Hedef | Ayrı uzantı hedefi `${BUNDLE_ID}.widgets`, **dağıtım hedefi iOS 17.0** (uygulama 16.4'te kalır). Kimlikler `app.config.ts` `BUNDLE_ID`'den türetilir; App Group `group.${BUNDLE_ID}`. |
| Aileler | `systemSmall` (seçili favori + "1 sa paylaş"), `systemMedium` (≤ 4 favori, her birinde "1 sa" / geri sayım), `accessoryCircular` (avatar + ilerleme halkası), `accessoryRectangular` (ad + durum), `accessoryInline` (tek satır). |
| Yapılandırma | `AppIntentConfiguration` + `SelectFavoriteIntent`: anlık görüntüdeki favorilerden `AppEntity` seçici; boşsa `default_uid`. |
| Düğme | iOS 17 `Button(intent: StartQuickShareIntent)`; niyet **uzantı sürecinde** çalışır, `authenticationPolicy = .requiresAuthentication` (kilitliyken Face ID / parola olmadan çalışmaz). |
| Geri sayım | `Text(timerInterval:)`; yuvarlak kilit ekranında `ProgressView(timerInterval:)` (sistem çizer, giriş harcamaz). |
| Göreli zaman | `Text(date, style: .relative)` saniye gösterdiği için kullanılmadı; "3 dk önce" 5 dk'lık zaman çizelgesi girişleriyle hesaplanır. |
| iOS 16 | Uzantı iOS 17+; iOS 16 cihazda widget yok. Core `ios_too_old` yolu uygulama içi / demo içindir. |
| Kilit ekranı | Sistem tek renk çizer (cinsiyet rengi yalnızca ana ekranda). Yer / pil `.privacySensitive()` ve yalnızca `privacy.lock_screen_details` açıksa. |

### 1.3 Android: AppWidget + RemoteViews (Glance **değil**)

| Konu | Karar |
| --- | --- |
| Neden Glance değil | Jetpack Glance, Compose derleyici eklentisi + Kotlin sürüm eşlemesi ister; Expo modülünde bunu bu ortamda derleyip doğrulayamıyoruz. Klasik `AppWidgetProvider` + XML yerleşim + `RemoteViews` her Android sürümünde çalışır, ek bağımlılık getirmez ve Glance'ın da sonunda ürettiği şeydir. Glance'a geçiş ileride yalnızca çizim katmanını değiştirir (anlık görüntü sözleşmesi aynı). |
| Boyutlar | 2x2 (`KonumWidgetSmallProvider`, ilk favori) ve 4x2 (`KonumWidgetLargeProvider`, ≤ 4 favori); `targetCellWidth/Height`, yeniden boyutlanabilir. Kişi seçici (yapılandırma etkinliği) yok **[Varsayım]**. |
| Avatar | Kotlin `Canvas`: 120 px fotoğraf (ya da baş harfler) + cinsiyet renginde halka + beyaz boşluk + durum noktası, bit eşlem olarak `setImageViewBitmap`. |
| Geri sayım | `Chronometer` (`setChronometerCountDown`, API 24+), sistem çizer. |
| Düğme | `PendingIntent.getBroadcast` → açık olmayan (`exported=false`) `QuickShareReceiver` → `goAsync()` + arka plan iş parçacığında `HttpURLConnection` (bağlantı 4 sn + okuma 5 sn; alıcı ~10 sn sınırının altında). |
| Uygulamayı açma | Alıcı **etkinlik başlatmaz** (Android 10+ arka plandan etkinlik başlatmayı engeller). "Uygulamayı aç" gereken durumlar çizim anında `PendingIntent.getActivity(konum://quick-share?...)` olarak bağlanır. |
| Hızlı Ayar kutucuğu | `QuickShareTileService` "Konum: 1 sa paylaş" (varsayılan favori). Kilitliyken `unlockAndRun`: kilit açılmadan çalışmaz. Hata yerel bildirimle (dokununca derin bağlantı; `POST_NOTIFICATIONS` varsa). |
| Kilit ekranı | Android 5+ kilit ekranı widget'ı yok; kilit ekranından erişim Hızlı Ayar kutucuğudur. |
| Token | AndroidKeyStore AES-256-GCM anahtarıyla şifrelenmiş `SharedPreferences` (`security-crypto`'nun `EncryptedSharedPreferences`'ı 1.1.0'da kullanımdan kalktı). |
| Yeni izin | Yok (yalnızca mevcut `INTERNET`, `POST_NOTIFICATIONS`). Yeni bağımlılık: `androidx.work:work-runtime:2.9.1`. |

### 1.4 Boyut, veri ve bellek sınırları

| Sınır | Değer | Neden |
| --- | --- | --- |
| Anlık görüntü | ≤ 16 KB (`WIDGET_LIMITS.maxBytes`; demo ölçümü 4 favoriyle ~1,3 KB) | UserDefaults / SharedPreferences küçük değer içindir. Aşılırsa `buildWidgetSnapshot` önce yer ve avatar alanlarını, sonra sondaki favorileri atar. |
| Favori | ≤ 4 (`FAVORITES_LIMIT`) | systemMedium / 4x2'de okunur kalan en fazla sütun. |
| Ad / yer | 18 / 28 karakter (`truncateText`, "…") | Küçük widget satırı. |
| Avatar | 120 px kare JPEG (`AVATAR_LIMITS.widgetPx`), kişi başına bir dosya | iOS uzantısının bellek sınırı ~30 MB **[Varsayım: cihazda ölçülmeli]**; uzantı ağdan resim indirmez, URL çözmez. |
| Uzantı ağı | Yalnızca `StartQuickShareIntent`; zaman aşımı 8 sn (iOS), 4 + 5 sn (Android) | Niyet / alıcı süre sınırları. |
| Çift dokunuş | Aynı kişiye 20 sn içinde süren istek varsa yenisi gönderilmez | Tekrarlanan paylaşım / hız sınırı tüketimi. |
| Hata durumu | 2 dk (sonra düğme normale döner; bu sürede "Uygulamada aç" bağlantısı) | Kısa geri bildirim, kalıcı hata yok. |

## 2. Yenileme stratejisi ve bütçe

| Tetik | iOS | Android |
| --- | --- | --- |
| Uygulama durumu değişti | `widgetSync`: büyük değişim (durum, paylaşımım, favoriler, oturum, token) → yaz + `reloadAllTimelines` hemen; küçük (son görülme, pil, yer) → yaz ≥ 60 sn, yenile ≥ 5 dk (`widgetSyncDecision`). Ertelenen yenileme süre dolunca bir kez yapılır. | Aynı karar; yenileme = `AppWidgetManager.updateAppWidget`. |
| Zamanla bayatlama ("Paylaşıyor · 3 dk önce" → "Bağlantı yok") | Zaman çizelgesi: şimdi + 5 dk adımlarla 60 dk, her favorinin bayatlık sınırı (son paket + 15 dk), paylaşımımın bitişi, hata durumunun bitişi; politika `.after(şimdi + 60 dk)`. Giriş eklemek yenileme bütçesi harcamaz. | WorkManager periyodik iş (30 dk) + bir sonraki bayatlık / bitiş sınırına tek seferlik iş; `updatePeriodMillis` 30 dk yedek. |
| Arkadaş bana paylaşımı başlattı / bitirdi | Sunucu `widget_refresh` (yalnızca veri, `content-available`, öncelik 5, 15 dk ömür) → uygulama uyanırsa eşitler; uygulama kapalıysa yalnızca widget'ı yeniden çizer (son anlık görüntüyle). | Aynı (FCM normal öncelik, 15 dk TTL, `collapseKey`). |
| Widget'tan hızlı paylaşım | Niyet anlık görüntüyü yerinde yamalar (`my_share_expires_at`, `my_share_active`) + `reloadAllTimelines`. | Alıcı aynı yamayı yapar + tüm widget'ları günceller. |
| Uygulama ön plana döndü | `consumeEvents()` + zorunlu eşitleme (kısıtı aşar) + 3 sn sonra bir kez daha (dinleyiciler yetişsin). | Aynı. |

**Bütçe:** WidgetKit günde ~40–70 sistem yenilemesi verir **[Varsayım: Apple belgesi kesin sayı vermez]**; uygulamanın
yenilemeleri en çok 5 dk'da bir küçük değişimle sınırlıdır, büyük değişimler (paylaşım başladı / bitti) seyrektir.
`widget_refresh` yalnızca alıcı paylaşanı **favorilerinde** tutuyorsa ve paylaşımın **aktiflik durumu değiştiğinde**
gönderilir (uzatma, duraksama kaydı göndermez). iOS sessiz push'u kısıtlayabilir; doğruluk zaman çizelgesi ve ön plan
eşitlemesiyle sağlanır.

## 3. Tek dokunuşla 1 saatlik paylaşım

### 3.1 Akış (iOS 17 etkileşimli widget; Android aynı sırayla alıcıda)

```text
kullanıcı      widget (uzantı / alıcı)                    sunucu: widget_quick_share              uygulama / alıcı
   │ "1 sa" ───▶│ 1. core quickShareRoute (çizim anında):     │                                        │
   │            │    oturum, favori, token (> 5 dk), izin     │                                        │
   │            │    → open_app ise düğme = derin bağlantı    │                                        │
   │ Face ID ──▶│ 2. requiresAuthentication (kilitliyse)     │                                        │
   │            │ 3. anahtarlıktan {token, endpoint}         │                                        │
   │            │ 4. POST {"data":{token,to_uid,op_id,       │                                        │
   │            │    source}} ──────────────────────────────▶│ sha256(token) → widget_tokens/{özet}   │
   │            │                                            │ iptal/yok → token_invalid              │
   │            │                                            │ süresi dolmuş → token_expired          │
   │            │                                            │ profil yok/siliniyor → token_invalid   │
   │            │                                            │ favori değil → not_favorite            │
   │            │                                            │ arkadaş değil/engelli → not_friend     │
   │            │                                            │ saatte 6 başarı → rate_limited         │
   │            │                                            │ quickShareExpiry:                      │
   │            │                                            │  yok/bitmiş → writeShareStarts (60 dk) │
   │            │                                            │  < 60 dk kaldı → bitiş = şimdi+60 dk   │
   │            │                                            │  ≥ 60 dk / süresiz → already_active    │
   │            │◀── {status, share_id, expires_at, to_name} │ runOp (op_id, token sahibi başına)     │
   │            │ 5. snapshot yaması + olay + yeniden çiz    │ ── resume_tracking (sessiz) ──────────▶│ başsız: paylaşımı kalıcı
   │ "✓ Başladı"│    → geri sayım (Text(timerInterval:) /    │ ── quick_share_started (görünür) ─────▶│ hedeflere ekle → takip
   │            │      Chronometer)                          │    "Ayşe ile 1 saatlik paylaşım başladı"│ başlar; bildirimde "Durdur"
   │            │                                            │ share_acl_reconciler → alıcıya         │
   │            │                                            │ widget_refresh (beni favoride tutuyorsa)│
```

- **Uygulama içi eşdeğeri:** Arkadaşlar ekranındaki Favoriler kartında "⏱ 1 sa" ve derin bağlantı sayfası
  (`app/quick-share.tsx` → `QuickShareSheet`) aynı kuralı uygular: yoksa başlat, 60 dk'dan az kaldıysa 60 dk'ya uzat,
  daha uzunsa dokunma (8 saatlik paylaşım asla kısalmaz). Sayfa geri sayım, "Durdur" (oturum yalnızca bu kişiyeyse) ve
  "Tamam" gösterir; izin eksikse mevcut Faz 3 izin akışına girer.
- **Bildirimdeki "Durdur":** iOS kategori `QUICK_SHARE` (core `QUICK_SHARE_NOTIFICATION`), eylem `QUICK_SHARE_STOP`
  uygulamayı öne getirir; `f6Services.handleQuickShareResponse` oturum yalnızca bu kişiye açıksa `share_stop` yapar
  (kalıcı durdurma niyetiyle), çok kişilik oturumda dokunmaz (haritadaki paylaşım kartı).
- **Başsız benimseme:** `resume_tracking` push'u `session_ids` taşır; `widgetBackground.ts` sunucudaki giden paylaşımlardan
  yalnızca adı geçen, aktif, süresi dolmamış ve bu cihazda durdurulmamış olanları kalıcı hedeflere ekler, sonra Faz 3
  `resumeTracking` takibi başlatır.

### 3.2 Hata ve izin düşüşleri

| Durum | Widget davranışı | Uygulama / sunucu |
| --- | --- | --- |
| Oturum kapalı (`signed_out`) | "Giriş yap"; dokunuş uygulamayı açar | Çıkışta anlık görüntü boşalır, token iptal + yerelden silinir |
| Favori yok (`no_favorite`) | "Favori ekle"; dokunuş uygulamayı (Arkadaşlar) açar | — |
| Token yok (`no_token`) / 5 dk içinde dolacak (`token_expiring`) | Düğme = `konum://quick-share?to&src` | Uygulama açılınca `widget_token_issue` (yenile), paylaşımı kendisi yapar |
| Token sunucuda dolmuş (`token_expired`) / iptal (`token_invalid`) | 2 dk "Oturum yenilenmeli" + "Uygulamada aç"; `quick.token_ok = false` yaması | Uygulama yeni token alır; paylaşım uygulamadan |
| "Her Zaman" konum izni yok (`no_bg_location`) | Düğme = derin bağlantı | Uygulamada mevcut izin akışı; arka planda takip başlayamayacağı için sunucuya hiç gidilmez |
| iOS < 17 (`ios_too_old`) | Uzantı yüklenmez (hedef 17.0); demo / uygulama içinde `Link` / `widgetURL` | — |
| Çevrimdışı / zaman aşımı (`unavailable`) | Widget'ta "Bağlantı yok" (uygulama açılmaz) | İstek sunucuya ulaşmadı; tekrar denemek güvenli (yeni `op_id`) |
| Hız sınırı (`rate_limited`, token başına saatte 6 başarılı çağrı) | "Çok sık denendi, bekle" | `retry_after_ms` döner |
| Artık arkadaş değil (`not_friend`) | "Artık arkadaş değilsiniz" + uygulamayı aç | Arkadaşlık bitince sunucu favorilerden de çıkarır |
| Favori değil (`not_favorite`; kendisi dahil) | "Kişi favorilerde değil" + uygulamayı aç | — |
| Zaten açık (`already_active`, ≥ 60 dk ya da süresiz) | Başarı sayılır (geri sayım / süresizde "Paylaşıyorsun", düğme yok) | Paylaşım değişmez; push "Konum paylaşımı zaten açık" |
| Kilitli telefon | iOS Face ID / parola (niyet politikası); Android kutucuk `unlockAndRun` | — |

Uygulamayı açan hatalar ile widget'ta metin gösteren hatalar ayrımı core `quickShareErrorAction`'dadır
(`rate_limited`, `unavailable` → metin; diğerleri → uygulama).

### 3.3 Widget token'ının güvenliği

- **Neden ayrı token:** Widget uzantısı / AppWidget alıcısı Firebase Auth oturumuna ve App Check'e erişemez. Uygulama
  oturum açıkken `widget_token_issue` (oturum + App Check) ile **cihaza özel** 32 baytlık (base64url 43 karakter,
  256 bit) token alır.
- **Sunucu yalnızca özeti saklar:** `widget_tokens/{sha256Hex(token)}` = `{uid, device_id, created_at, expires_at,
  last_used_at, uses: {window_start, count}, revoked, purge_at}`. Düz token yalnızca yanıtta döner; `ops` kaydına ve
  günlüklere yazılmaz (bu yüzden `widget_token_issue` `runOp` kullanmaz; her çağrı aynı cihazın eskisini iptal eder).
  Koleksiyon istemciye tamamen kapalıdır (`firestore.rules`); TTL `purge_at`.
- **Yetkisi dar:** token yalnızca sahibinin **favorilerine**, yalnızca **1 saatlik** paylaşım başlatabilir / uzatabilir;
  konum okuyamaz, durduramaz, başka callable çağıramaz. Ömür 30 gün, bitişe 7 günden az kalınca uygulama ön planda
  yeniler; kullanıcı başına en çok 5 aktif token, günde 20 üretim **[Varsayım]**.
- **İptal:** çıkıştan ÖNCE (kimlik varken) `widget_token_revoke(device_id)`; hesap silmede tüm token belgeleri silinir.
  Çevrimdışı çıkışta sunucudaki token en geç 30 günde geçersizleşir.
- **Cihazda:** iOS anahtarlık, erişim grubu = App Group (`kSecAttrAccessGroup = group.${BUNDLE_ID}`,
  `AfterFirstUnlockThisDeviceOnly`; ayrı `keychain-access-groups` yetkisi eklenmedi, çünkü Firebase Auth ve
  expo-secure-store'un varsayılan anahtarlık grubunu değiştirirdi). Android: AndroidKeyStore AES-GCM. Token anlık
  görüntüye **girmez** (`quick.token_ok` yalnızca bir bayrak).
- **Callable:** `widget_quick_share` yeni `tokenCallable` sarmalayıcısıyla dışa açılır (oturum ve App Check yok; Cloud
  Run çağırıcısı herkese açık olmalı). İstek özeti `op_id` tekrarını token sahibi başına tekilleştirir ve düz token
  yerine token özetini içerir. Kaba kuvvet 256 bitlik token'da anlamsız; başarısız çağrılar sayılmaz.

### 3.4 Kilit ekranı gizliliği

- `privacy.lock_screen_details` varsayılan **kapalı**: kilit ekranı aksesuarları yalnızca ad, durum ve zamanı gösterir;
  yer ve pil gösterilmez. Profil ekranındaki "Kilit ekranında ayrıntı göster" anahtarı bunu açar (demo galerisi de aynı
  ayarı okur).
- Ana ekran widget'ında yer / pil satırı `.privacySensitive()` (iOS kilitliyken / StandBy'da örter).
- Anlık görüntüde ham koordinat yoktur: `place` yalnızca Faz 5 bölge adı ya da kısa adres (`safePlaceLabel` koordinat
  benzeri metni atar); karşı taraf paylaşmıyorsa yer ve pil düşer; oturum kapalıyken favori listesi boştur.
- Kilitli telefondan paylaşım başlatılamaz (iOS `requiresAuthentication`, Android `unlockAndRun`).

## 4. Cinsiyet alanı ve kayıt

- **Model:** `users/{uid}.gender: 'female' | 'male' | null` (null yalnızca eski hesaplar). Arkadaşlar cinsiyeti
  `friendships.member_profiles[uid].gender` üzerinden görür (mevcut profil yayılımı); bekleyen istek profili yalnızca
  addır (`gender: null` → nötr gri çerçeve).
- **Zorunluluk:** `user_bootstrap` profil OLUŞTURULURKEN `gender` ister (yoksa `gender_required`, `invalid-argument`);
  sonraki güncellemelerde isteğe bağlıdır, `null`'a çekilemez (şema reddeder). Kural core `resolveProfileGender`.
- **Kayıt ekranı:** ad + iki büyük çip (Kadın / Erkek; seçili çip pembe / mavi kenarlı); cinsiyet seçilmeden "Devam"
  pasif. Sunucu `gender_required` dönerse kimlik deposu `needsProfile`'a geçer.
- **Eski hesaplar:** `gender == null` → `(main)/_layout`'ta kapatılamaz `GenderGate`; oturum servisleri (süren
  paylaşımlar, arka plan takibi) bu sırada çalışmaya devam eder.
- Profil ekranından (`/profile`) cinsiyet değiştirilebilir; değişim arkadaşlardaki kopyalara yayılır.
- **Gizlilik notu:** cinsiyet yalnızca çerçeve rengi için kullanılır; Data Safety / App Privacy formunda "kişisel bilgi
  (cinsiyet)" olarak beyan edilmeli (`RELEASE_CHECKLIST.md`).

## 5. Profil fotoğrafı hattı

```text
Kamera / Galeri (expo-image-picker, allowsEditing, aspect 1:1)
  izin: reddedildi → "Ayarları aç"; iOS sınırlı galeri yeterli; Android 13+ sistem fotoğraf seçicisi
  → ortadan kare kırp (seçici kırpmadıysa) → 512 px JPEG q 0.8 (> 400 KB ise 0.65 → 0.5)
  → 512'den 160 px JPEG q 0.7 (> 60 KB ise 0.55 → 0.4)          [expo-image-manipulator]
  → YENİDEN KODLAMA: kamera / galeri EXIF verisi (GPS konumu, cihaz, saat) atılır
  → Storage avatars/{uid}/{sürüm}.jpg + avatars/{uid}/{sürüm}_160.jpg   (sürüm = yükleme anı, 13 haneli epoch ms)
  → user_bootstrap {avatar_url, avatar_thumb_url}  (sunucu: aynı sürüm + _160 kardeşi mi, checkAvatarPair)
  → sunucu avatar_version'ı yazar, member_profiles'a yayar, ÖNCEKİ sürümün iki nesnesini siler (en iyi çaba)
```

- **İyimser arayüz:** yerel önizleme hemen görünür; yükleme / kayıt hatasında "Tekrar dene" yeniden kodlamadan sürer;
  "Fotoğrafı kaldır" → `avatar_url: null` (sunucu üç avatar alanını da temizler).
- **Storage kuralları** (`backend/storage.rules`): yalnızca `avatars/{uid}/{dosya}`, yazan = sahibi, ad
  `AVATAR_FILE_RE` (`^[0-9]{13}(_160)?\.jpg$`), `contentType == image/jpeg`, ana ≤ 400 000 B, küçük ≤ 60 000 B
  (`contract.test.ts` core `AVATAR_LIMITS` ile eşitliği denetler); `get` yalnızca sahibine (SDK `getDownloadURL` için),
  `list` kapalı, silme sahibine. Arkadaşlar indirme token'lı URL ile okur (Faz 1 tasarımı, kurallardan bağımsız).
- **Önbellek:** `expo-image` `cachePolicy="memory-disk"`, `recyclingKey` = sürüm; listeler ve pinler küçük boyu
  (`avatar_thumb_url`), profil ekranı ana boyu kullanır. Arkadaş listesi yüklenince küçük boylar `Image.prefetch` ile
  (en çok 60) ön belleğe alınır. Widget için favorilerin küçük boyu indirilip `saveAvatar` ile 120 px dosyaya yazılır
  (sürüm değişmedikçe yeniden indirilmez; favoriden çıkanın dosyası silinir).
- Fotoğraf yoksa ya da yüklenemezse core `initialsOf` (tr-TR büyük harf) baş harfleri çizilir.

## 6. Çerçeveli avatar ve harita pini

- **Avatar** (`ui/Avatar.tsx`): 3 px cinsiyet şeridi (`genderRingColor`: kadın `#EC4899`, erkek `#3B82F6`, bilinmiyor
  `#9CA3AF`) + beyaz iç boşluk + fotoğraf / baş harfler. Tazelik artık halkada değil, küçük **durum noktasında**
  (canlı yeşil, yakın zamanda mavi, bayat gri); pil rozeti aynen. Arkadaş listesi, favoriler, gelen şeridi, paylaşım
  kartları, hızlı paylaşım sayfası ve pinler aynı bileşeni (`FriendAvatar`) kullanır.
- **Pin** (`FriendMarker.tsx`): beyaz baloncuk içinde çerçeveli avatar + cinsiyet renginde kuyruk; çapa kuyruğun ucu
  (`friendMarkerAnchor`). Seçiliyse baloncuk ve kuyruk birincil renk, SOS'ta kırmızı; bayat pin soluk.
- **Android `tracksViewChanges`:** react-native-maps özel görünümlü işaretçiyi bit eşlem olarak dondurur. Fotoğraflı
  pinde `tracksViewChanges` resmin `onLoad` / `onError`'una kadar AÇIK, ardından 600 ms daha (en çok 5 sn); her görsel
  değişimden (seçim, tazelik, pil, not, fotoğraf) sonra 600 ms açık, sonra kapalı; nabız varken açık. Böylece boş
  resimli pin donmaz, sürekli yeniden çizim de pil harcamaz. iOS'ta Google Maps SDK görünümü kendisi izler.
- **Widget'ta** çerçeve yerel kodda çizilir (iOS SwiftUI iç içe `Circle().fill` katmanları, Android `Canvas`), renk anlık
  görüntüdeki `ring` alanıdır.

## 7. Push özeti (Faz 6)

| Tür | Alıcı | Veri (koordinat YOK) | Metin / davranış | Kanal / öncelik |
| --- | --- | --- | --- | --- |
| `quick_share_started` | gönderenin kendi cihazları | `share_id, to_name, expires_at` (epoch ms metni; süresizde boş) | "Konum paylaşımı başladı · Ayşe Yılmaz ile 1 saatlik paylaşım başladı"; iOS kategori `QUICK_SHARE` + "Durdur" | Android `share_status`, iOS `active`, etiket `quick_share_${share_id}` |
| `resume_tracking` (Faz 3) | gönderenin kendi cihazları | `session_ids, level` | sessiz; başsız benimseme + takip | yüksek öncelik, `content-available` |
| `widget_refresh` | paylaşanı favorisinde tutan alıcı | `from` | sessiz; widget yeniden çizilir / uygulama eşitler | iOS background, öncelik 5; Android normal; 15 dk |

Sunucunun alıcıya ayrı bir "paylaşım başladı" push'u yoktur (Faz 1'den beri alıcı paylaşımı Firestore / RTDB'den
görür); alıcının widget'ı `widget_refresh` ile güncellenir.

## 8. Callable'lar ve hata kodları

| Callable | İstek | Yanıt | Hatalar |
| --- | --- | --- | --- |
| `user_bootstrap` (genişledi) | `+ gender?, avatar_thumb_url?` | `user` her zaman `gender, avatar_thumb_url, avatar_version, favorite_ids` içerir | `gender_required`, `invalid_argument` (`thumb_without_main` / `thumb_mismatch`, `gender: null`, geçersiz dosya adı) |
| `favorites_set` | `op_id, favorite_ids (≤ 4, benzersiz)` | `{favorite_ids}` (sırası korunur, arkadaş olmayanlar sessizce düşer) | `invalid_argument` |
| `widget_token_issue` | `op_id, device_id` | `{token, expires_at, endpoint_path: 'widget_quick_share'}` | `rate_limited` (günde 20), `failed-precondition` (profil yok) |
| `widget_token_revoke` | `op_id, device_id \| null (tümü)` | `{revoked}` | — |
| `widget_quick_share` (oturumsuz) | `token, to_uid, op_id, source (ios_widget / ios_lock / android_widget / android_tile)` | `{status: started \| extended \| already_active, share_id, expires_at (null yalnızca süresiz), to_name}` | `token_invalid`, `token_expired` (`unauthenticated`), `not_favorite`, `not_friend` (`failed-precondition`), `rate_limited` (`resource-exhausted`, `retry_after_ms`) |

Yerel istemci `error.details.code`'u okur (core `toQuickShareError`); yoksa HTTP / gRPC durumundan eşler, ağ hatası
`unavailable`. Arkadaşlık bitince / engellenince iki tarafın `favorite_ids`'inden karşı taraf çıkar; hesap silmede
token'lar, başkalarının favorilerindeki uid ve `avatars/{uid}/` klasörü silinir.

## 9. Testler

| Paket | Komut | Sonuç |
| --- | --- | --- |
| core | `cd packages/core && npx vitest run && npx tsc --noEmit` | 221/221 (17 dosya), Faz 6 için `test/faz6.test.ts` (13: cinsiyet kuralı, avatar çifti, favoriler, yönlendirme sırası, sunucu kararı, anlık görüntü boyut / gizlilik, derin bağlantı) |
| mobil | `cd apps/mobile && npx tsc --noEmit && npx jest` | 211/211 (26 suite); Faz 6: `faz6App` (14: eşitleme kısıtı, girdi seçimi, derin bağlantı, 1 saat kuralı, fotoğraf hattı, favoriler, push, başsız benimseme, bildirimdeki "Durdur"), `widgetBridge` (6: no-op, olay / yetenek ayrıştırma, Swift + Kotlin anahtar sözleşmesi), `demoFaz6` (6) |
| backend | `cd backend && npm run typecheck && npm run build && env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npm test` | 221/221 (21 dosya, Storage emülatörü dahil); Faz 6: `test/functions/faz6.test.ts` (11), `test/rules/storage.rules.test.ts` (3), sözleşme testleri |
| web | `cd apps/web && npm run typecheck && npm run build && npm test` | 53/53 (4 dosya), derleme temiz |
| Android / iOS paketi | `EXPO_OFFLINE=1 CI=1 npx expo export --platform android` (ve `ios`) | 2821 / 2820 modül. Hermes paketinde demo metni yok ("FAZ 6 · WIDGET", "Widget oturumu sunucuda dolsun", `putAvatarObject`, `demoServer`, "Deniz Kaya", "FAZ 5 SENARYOLARI": 0; UTF-8 ve UTF-16); Faz 6 arayüz metinleri var (pozitif kontrol) |
| native yapılandırma | `EXPO_OFFLINE=1 CI=1 npx expo prebuild --platform android\|ios --no-install` (sahte Firebase dosyalarıyla) | Android: iki widget sağlayıcısı, `exported=false` alıcı, `BIND_QUICK_SETTINGS_TILE` kutucuk, yeni izin yok (`RECORD_AUDIO`, depolama, `SYSTEM_ALERT_WINDOW` kaldırılmış). iOS: `widgets` uzantı hedefi (`${BUNDLE_ID}.widgets`, iOS 17.0), uygulama + uzantıda `group.${BUNDLE_ID}`, `KonumAppGroup`, kamera / galeri izin metinleri. Üretilen klasörler silindi |
| web demo | `npm run web:export` + Playwright | `dist-web/index.html` tek dosya (3,9 MB), 48/48 denetim, konsol hatası yok |

Ekran görüntüleri (1280×860, 2x; tarayıcı demosu, giriş 532 123 45 67 / 123456 / "Deniz Kaya", Kadın):

| Görüntü | Akış |
| --- | --- |
| `01-kayit-cinsiyet.png` | Kayıt: cinsiyet seçilmeden "Devam" pasif; Kadın seçilince pembe kenarlı çip |
| `02-profil-fotografi.png` | Profil → Galeri → oluşturulmuş deneme görüntüsü yüklendi: pembe çerçeveli fotoğraf, "Fotoğrafı kaldır", EXIF notu |
| `03-arkadaslar-cerceve.png` | Arkadaşlar: Ayşe / Zeynep pembe, Mehmet mavi, fotoğrafsız Can "CÖ" mavi, bekleyen Elif nötr gri; yıldızlar |
| `04-favori-siniri.png` | Can'a yıldız → Favoriler 4/4, Elif'i kabul edip yıldızlayınca "En fazla 4 favori seçebilirsin" |
| `05-harita-pinleri.png` | Haritada çerçeveli fotoğraflı pinler, cinsiyet renginde kuyruk; üst çubukta kendi fotoğrafım |
| `06-widget-ios.png` | iOS systemSmall (Ayşe + "1 sa paylaş") ve systemMedium (4 favori), anlık görüntü 1,3 / 16 KB |
| `07-widget-kilit-ekrani.png` | Kilit ekranı: satır içi, yuvarlak (geri sayım halkası), dikdörtgen (yer / pil örtülü), "Face ID istenir" |
| `08-widget-android.png` | Android 2x2, 4x2 ve "Konum: 1 sa paylaş" Hızlı Ayar kutucuğu |
| `09-hizli-paylasim-sayac.png` | Widget "1 sa paylaş" → "✓ Başladı", "Ayşe Yılmaz ile 1 saatlik paylaşım başladı" bildirimi, uygulamada "Konumun paylaşılıyor · 60 dk kaldı" |
| `10-token-suresi-doldu.png` | "Widget oturumu sunucuda dolsun" → Mehmet "1 sa" → derin bağlantı → uygulamada "1 saatlik paylaşım başladı" sayfası (Durdur / Tamam); token yenilendi |

### 9.1 Cihazda yapılacak kabul senaryoları

1. **iOS 17+ kilitli telefon:** kilit ekranı aksesuarı → Face ID → paylaşım başlar; Face ID iptalinde hiçbir şey
   gönderilmemeli. systemMedium'da 4 favori, geri sayım saniye saniye akmalı.
2. **Uygulama kapalıyken (sistemce / kullanıcı tarafından) widget'tan paylaşım:** `resume_tracking` ile takip başlamalı;
   alıcı ≤ 1 dk içinde konum görmeli. iOS sessiz push kısıtında uygulama açılınca paylaşım yakalanmalı.
3. **Anahtarlık paylaşımı:** imzalı derlemede uzantı App Group erişim grubundan token'ı okuyabilmeli (imzasız
   simülatörde `errSecMissingEntitlement` → widget uygulamayı açar).
4. **Android 12+ Doze:** WorkManager sınır işleri ve `updatePeriodMillis`; Chronometer bitişte kısa süre eksi
   gösterebilir (yeniden çizimde düzelir). Farklı başlatıcılarda 2x2 / 4x2 yerleşimi.
5. **Hızlı Ayar kutucuğu** kilitliyken kilit açma istemeli; hata bildirimine dokunma derin bağlantıyı açmalı.
6. **Fotoğraf:** iOS sınırlı galeri, Android 13+ fotoğraf seçici, kamera izni kalıcı reddi → "Ayarları aç"; yüklenen
   dosyada EXIF / GPS olmadığını `exiftool` ile doğrula.
7. **Android harita pinleri:** 30+ fotoğraflı pinde ilk çizimde boş pin kalmamalı, kaydırma akıcı olmalı.

## 10. Bilinen açıklar

- **Derlenmedi:** Swift ve Kotlin bu ortamda derlenmedi. En riskli API'ler: `AppIntentConfiguration` / `AppEntity`
  uyumları, `ProgressView(timerInterval:…)`, `Button(intent:)` + `invalidatableContent()`, API 34+
  `TileService.startActivityAndCollapse(PendingIntent)`, `RemoteViews.setChronometerCountDown`.
- **iOS 16 cihazlarda widget yok** (uzantı 17.0); iOS 18 Denetim Merkezi / kilit ekranı kontrolü (`ControlWidget`) yok.
  `OpenURLIntent` özel şemayı desteklemediği için kullanılmadı; uygulamayı açma kararı çizim anında verilir.
- **Android'de kişi seçici yok:** 2x2 ve kutucuk ilk favoriyi kullanır.
- **Uygulama kapalıyken `widget_refresh`** yalnızca widget'ı son anlık görüntüyle yeniden çizer (başsız tam yeniden
  kurulum yok); durumlar zaman çizelgesi ve sonraki ön plan eşitlemesiyle düzelir. Gönderenin widget'ı, alıcı paylaşımı
  kapatınca push almaz (kendi bitiş zamanına ve ön plan eşitlemesine güvenir).
- **Başsız benimseme** `resume_tracking` data push'unun JS'e ulaşmasına bağlıdır (iOS sessiz push'u kısabilir); ulaşmazsa
  paylaşım uygulama açılınca Firestore dinleyicisinden yakalanır.
- **Yer etiketi** yalnızca ön planda alınan Faz 5 `zone_event` bölge adı ya da ters geocode önbelleğinden gelir; widget
  için ağdan adres sorgulanmaz (adres kotası).
- **Yetim avatar nesneleri:** yükleyip `user_bootstrap` çağırmayan istemcinin dosyaları süpürülmez (yalnızca önceki
  sürüm ve hesap silmede tümü silinir) **[Varsayım: Storage yaşam döngüsü kuralı ya da süpürücü eklenmeli]**.
- **Emülatör:** Storage emülatörünün `http://127.0.0.1:9199` indirme adresleri `user_bootstrap`'ın https / alan adı
  denetimine takılır; gerçek fotoğraf yükleme uçtan uca yalnızca gerçek projede denenebilir.
- **Hız sınırı** yalnızca başarılı çağrıları sayar; `not_favorite` / `not_friend` denemeleri yazma yapmaz.
- **Profil ekranı:** yüklemeden sonra yerel önizleme kayıt bitince kalkar, yeni uzak resim yüklenene kadar kısa bir
  titreme olabilir. `QuickShareSheet` "Durdur"u yalnızca tek kişilik oturumda gösterir (kişi başına durdurma yok).
- **Dağıtım:** `firebase deploy --only storage` (yeni `storage.rules`), `firestore.rules` (`widget_tokens` kapalı),
  `firestore.indexes.json` (`widget_tokens.purge_at` TTL), 4 yeni callable; Functions hizmet hesabına Storage silme
  yetkisi; `widget_quick_share` kimliksiz çağrılabilir olmalı. Apple Developer'da App Group ve widget App ID'si,
  `APPLE_TEAM_ID` ile imzalama (`RELEASE_CHECKLIST.md`).
