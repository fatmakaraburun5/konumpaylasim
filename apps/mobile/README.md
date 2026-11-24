# Konum — mobil uygulama (Faz 1 + Faz 2)

Arkadaşlarla süreli canlı konum paylaşımı. Expo SDK 58, React Native 0.88, TypeScript (strict),
Firebase (Auth, Firestore, Realtime Database, Functions, App Check, Messaging), Google Haritalar.

İş kuralları (süre çözümü, paylaşım durum makinesi, paket biçimi, takip profilleri, telefon ve davet
kodu biçimi) `packages/core` içindedir; bu uygulama onları **değiştirmeden** kullanır. Spesifikasyon ile
core farklıysa **core geçerlidir** (teslim edilen pakette `v` ve `share_id` vardır, zamanlar epoch ms,
davet kodu `LOC-` + 6 karakter).

---

## 1. Gereksinimler

- Node 22+ (Firebase JS 13 bağımlılıkları Node 24 ister; 22'de yalnızca `EBADENGINE` uyarısı verir).
- iOS: macOS + Xcode (CocoaPods `pod install` prebuild/run sırasında çalışır).
- Android: Android Studio / SDK 36, JDK 17.
- **Expo Go çalışmaz**: uygulama yerel modüller (Firebase, Google Haritalar, arka plan konumu) içerir.
  Bir *development build* (expo-dev-client) gerekir.

## 2. Kurulum

```bash
cd apps/mobile
npm install            # @konum/core "file:../../packages/core" olarak bağlanır
cp .env.example .env   # değerleri doldur (aşağıya bak)
```

> Ağ, `api.expo.dev`'e erişimi engelliyorsa `npx expo install …` komutlarını `EXPO_OFFLINE=1` ile
> çalıştır; sürümler `expo/bundledNativeModules.json` dosyasından seçilir.

### Ortam değişkenleri (`.env`)

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `GOOGLE_MAPS_IOS_API_KEY` | evet* | iOS Maps SDK anahtarı. Yoksa yer tutucu yazılır, harita karoları yüklenmez. |
| `GOOGLE_MAPS_ANDROID_API_KEY` | evet* | Android Maps SDK anahtarı. |
| `GOOGLE_SERVICES_JSON` | hayır | `google-services.json` yolu (varsayılan `./firebase/google-services.json`). EAS'ta dosya sırrı olarak verilir. |
| `GOOGLE_SERVICE_INFO_PLIST` | hayır | `GoogleService-Info.plist` yolu (varsayılan `./firebase/GoogleService-Info.plist`). |
| `EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN` | hayır | Geliştirme derlemesinde App Check hata ayıklama belirteci (Firebase konsoluna kaydedilmeli). |
| `EXPO_PUBLIC_USE_EMULATORS` | hayır | `1` ise Auth/Firestore/RTDB/Functions yerel emülatörlere bağlanır. |
| `EXPO_PUBLIC_EMULATOR_HOST` | hayır | Emülatör adresi (Android emülatörü için `10.0.2.2`). |
| `LINK_DOMAIN` | hayır | Faz 2 paylaşım bağlantısı alan adı (`https://<LINK_DOMAIN>/s/<token>`). Normalize edilir (şema ve sondaki `/` atılır, küçük harfe çevrilir). Yoksa `konum.example.com` [Varsayım]; üretimde geçersizse hata. iOS `associatedDomains` ve Android `intentFilters` bundan üretilir; backend'in `LINK_DOMAIN`'i ile AYNI olmalı. |
| `EAS_BUILD_PROFILE` / `APP_VARIANT` | hayır | `production` ise Maps anahtarları zorunludur; eksikse yapılandırma hata verir. |

\* Geliştirme/CI derlemesi anahtarsız da tamamlanır (JS paketi üretilebilsin diye); yalnızca uyarı basılır.
Üretim profilinde (`EAS_BUILD_PROFILE=production` ya da `APP_VARIANT=production`) anahtar yoksa
`app.config.ts` hata fırlatır. Anahtarları Google Cloud Console'da kısıtlayın: iOS paket kimliği,
Android paket adı + imza SHA-1.

### Firebase yapılandırma dosyaları

Firebase konsolundan indirilen dosyalar **depoya konmaz** (`.gitignore`):

```
apps/mobile/firebase/google-services.json        # Android, paket adı com.example.konum
apps/mobile/firebase/GoogleService-Info.plist    # iOS, bundle id com.example.konum
```

Paket kimliği `com.example.konum` bir yer tutucudur [Varsayım]; mağaza hesabı açılınca
`app.config.ts` içindeki `BUNDLE_ID` ile birlikte değiştirilmelidir. Ayrıntı: `firebase/README.md`.

Firebase tarafında gerekenler [Varsayım: doğrulanmalı]: Telefon ile giriş açık; App Check'te
Android için Play Integrity, iOS için App Attest (DeviceCheck yedekli); Functions bölgesi
`europe-west1`; RTDB kuralları yalnızca aktif alıcının `live_locations/{alıcı}/{share_id}` okumasına izin verir.

## 3. Çalıştırma

Bu proje **Continuous Native Generation** kullanır: `ios/` ve `android/` klasörleri depoda tutulmaz,
her seferinde `app.config.ts`'ten üretilir. Elle düzenlenmez; yerel ayarlar config plugin ile yapılır
(`plugins/withLocationForegroundService.js`).

```bash
# Yerel development build (prebuild + derleme + cihaza kurulum)
npx expo run:android
npx expo run:ios               # macOS gerekir

# Metro'yu dev client için başlat
npm start                      # = expo start --dev-client
```

EAS ile development build [Varsayım: eas.json henüz eklenmedi]:

```bash
npx eas build --profile development --platform android
npx eas build --profile development --platform ios
```

Diğer komutlar:

```bash
npm run typecheck              # tsc --noEmit
npm test                       # jest (jest-expo)
npx expo export --platform android   # JS paketini üret (dist/), yerel derleme gerektirmez
npx expo prebuild --no-install --platform android --clean   # yerel projeyi incelemek için; sonra android/ silinir
```

### Tarayıcıda önizleme (demo)

Telefon ya da Firebase hesabı olmadan uygulamanın gerçek arayüzünü tarayıcıda açmak için:

```bash
cd apps/mobile
npm ci
npm run web                    # = expo start --web → http://localhost:8081
```

Giriş: herhangi bir Türkiye cep numarası (ör. 532 123 45 67), **Demo kodu: 123456**, ad "Deniz Kaya".
Geniş ekranda uygulama 390×844 telefon çerçevesinde açılır, yanında **Demo kontrolleri** paneli vardır
("Bitişe 2 dk kalsın", "Ayşe paylaşımı durdursun", "Mehmet yeniden paylaşsın", "Arkadaşlık isteği gelsin", "Pilim %12 olsun", "Demoyu sıfırla").
Dar ekranda panel sağ kenardaki **Demo** sekmesinden açılır.

Faz 2 de önizlemede denenebilir:

- **Rota / ETA:** haritada bir arkadaşa dokun → alt kartta rota çizgisi, "12 dk · 1,4 km" ve adres
  ("Bahariye Cd., Kadıköy"); Araç / Yürüyüş / Bisiklet süreyi değiştirir. Haritaya uzun bas (ya da sağ tık) →
  o noktaya rota.
- **QR bağlantısı:** "Konumumu paylaş" → "Bağlantı (QR)" → süre → QR sayfası (+30 dk / +1 saat, Kopyala,
  Paylaş: paylaşım sayfası yoksa panoya kopyalar). **"Bağlantıyı önizle"** QR'ı okutan kişinin göreceği
  salt okunur haritayı (`/s/<token>`) uygulama içinde açar.
- Panel: **"Bağlantıyı aç (izleyici)"** (en yeni bağlantı), **"Bağlantıyı sunucudan iptal et"** (açık izleyici
  2 sn içinde "Paylaşım sona erdi" der), **"Google yanıt vermesin"** (önbellekte olmayan rota/adres hata verir)
  ve bugünkü rota / adres sayaçları (günlük sınır 200 / 100, önbellek isabeti sayılmaz). "Bitişe 2 dk kalsın"
  QR bağlantılarını da kısaltır; bitmek üzere bildirimi bağlantılar için de çıkar.

Faz 4 (ayrıntı: `docs/PHASE4.md`):

- **Ping:** panel "Ayşe 'Buradayım' göndersin" → üstte kayan kart + pinde nabız; kendin göndermek için arkadaşa dokun
  → EtaCard'da "📍 Buradayım" / "🚶 Yoldayım" (ya da Arkadaşlar ekranındaki küçük düğmeler).
- **Notlar:** sol alttaki "Not ekle" → durum notu (hazır çipler, süre); haritaya uzun bas → EtaCard "📝 Buraya not
  bırak" → yer notu. Panelden Ayşe'nin durum notu (pin altında balon) ve park yeri notu (not pini + alt kart).
- **SOS:** sağ alttaki kırmızı düğmeyi 1,5 sn basılı tut → (ilk seferde acil kişi seçimi) → 5 sn geri sayım →
  "Uyarı gönderildi"; botlar birkaç saniyede "Gördü" der. Panel "Ayşe SOS göndersin" → alıcı tam ekran acil kartı,
  "Ayşe güvende" → yeşil kart.

Tek dosyalık statik derleme (sunucu gerektirmez, dış istek atmaz):

```bash
npm run web:export             # → dist-web/index.html (JS içine gömülü)
cd dist-web && python3 -m http.server 8080   # → http://localhost:8080/
```

`dist-web/index.html` herhangi bir alt yoldan ve `<iframe sandbox="allow-scripts">` içinden de açılır.
SPA yönlendirmesi gerekmez: tanınmayan yol `app/+not-found.web.tsx` ile "/" yoluna gider. `localStorage`
erişilemezse (korumalı iframe, gizli pencere) demo verileri yalnızca bellekte tutulur.

**Simüle edilenler** (yalnızca web paketi; Android/iOS paketleri değişmez):

| Gerçek uygulamada | Web önizlemesinde |
| --- | --- |
| Firebase (Auth, Firestore, RTDB, Functions) | Bellek içi demo sunucusu `src/demo/server/` (@konum/core kurallarıyla, tarayıcıda saklanır) |
| SMS ile giriş | Sabit demo kodu 123456 |
| Arkadaşlar | Ayşe (canlı), Mehmet (az önce, %14 pil), Zeynep (2 sa önce), Can; Elif'ten bekleyen istek. Davet koduyla eklenen kişi birkaç saniyede kabul eder |
| Google Maps SDK (açık/koyu stil, pin kayması) | Kadıköy/Moda'nın basit vektör çizimi (`PreviewMap.web.tsx`); pinler core `markerTransition` ile kayar. Yalnızca önizleme içindir |
| Routes API / Geocoding API (sunucu `route_compute`, `geocode_reverse`) | Demo sunucusu önizleme caddeleri üzerinde sahte rota (`fakeGoogle.ts`, mod hızlarıyla süre) ve hücre başına Kadıköy/Moda sokak adı üretir; önbellek anahtarı, günlük kota ve `maps_unavailable` core kurallarıyla |
| QR bağlantısı (`link_share_*`, `link_live`, App/Universal Links) | Gerçek token (`crypto.getRandomValues`, core `encodeLinkToken` / `linkTokenHash`) ve aynı ACL; QR okutmak yerine "Bağlantıyı önizle" izleyiciyi uygulama içinde açar. Dış bağlantı / mobil web haritası yok |
| GPS ve arka plan konum görevi | Moda'da simüle yürüyüş (5 sn'de bir örnek); arka plan görevi ve pil yönetimi yok |
| Gerçek bildirimler (FCM, yerel bildirim) | Uygulama içi "telefon bildirimi" kartı (+30 dk / +1 saat / Durdur) |
| `Alert.alert` iletişim kutuları | Telefon çerçevesi içinde açılan uygulama içi iletişim kutusu |

Web'e özgü kod yalnızca Metro platform uzantılarıyla (`*.web.ts(x)`) seçilir; native dosyalar aynıdır.
Tek istisna `metro.config.js`'teki `platform === 'web'` dalıdır (AsyncStorage → güvenli depo).

### iOS bağlama notu

`expo-build-properties` → `ios.useFrameworks: 'dynamic'`. Görev tanımı `static` istiyordu, ancak
@react-native-firebase 27 (Firebase Apple SDK 13, yalnızca SPM) statik bağlamayı `pod install`
sırasında bilerek reddeder (`rnfirebase_fail_if_spm_static_linkage!`). react-native-maps Google pod'u
ile dinamik framework uyumu macOS'ta doğrulanmalıdır [Varsayım: doğrulanmalı].

---

## 4. Klasör yapısı

```
app/                    expo-router rotaları (yalnızca ince ekranlar + yetki kapısı)
  _layout.tsx           sağlayıcılar: GestureHandler → SafeArea → BottomSheetModalProvider → Stack
  (auth)/               phone · otp · name
  (main)/               index (harita) · friends; oturum servislerini başlatır
index.ts                giriş: arka plan görevleri expo-router'dan ÖNCE tanımlanır
plugins/                config plugin'leri (Android ön plan servisi türü: location)
src/
  ui/                   tasarım belirteçleri (tokens.ts), tema, temel bileşenler
  lib/                  sunucu saati, hata eşleme, zod şemaları, Türkçe ekler
  state/                zustand depoları + arka plan için kalıcı veri (persist.ts) + kalıcı durdurma niyetleri (stopIntents.ts)
  services/firebase/    init (App Check), callables, sharesRepo, liveRepo, publisher
  services/location/    LocationEngine arayüzü, Expo uygulaması, arka plan görevi, yayın hattı
  services/notifications/  "süre doluyor" bildirimi, eylemler, kanallar, push belirteci
  services/sharingCoordinator.ts   oturum açıkken tüm bağlantılar
  services/resilientListener.ts    hata veren dinleyiciyi geri çekilmeli yeniden abone eder
  features/             auth · permissions · map · share · friends
__tests__/              birim testleri
```

## 5. Bileşen ağacı

### MapHome (`src/features/map/MapHome.tsx`)

- `MapHome`
  - `MapCanvas` — `react-native-maps`, `PROVIDER_GOOGLE` (iki platformda), açık/koyu harita stili
    - `FriendMarker` × gelen konum
      - `Marker`
        - `Avatar` — tazelik halkası (canlı: düz · yakın: birincil renk düz · eski: kesikli), pil rozeti (≤ %15 uyarı rengi)
  - `TopBar`
    - `Avatar` (profil menüsü: çıkış)
    - başlık
    - `Chip` — davet kodu (`LOC-XXXXXX`, dokununca paylaş; dokunma hedefi 44)
    - `IconButton` — arkadaşlar
  - `IncomingStrip` — bana paylaşanlar (Canlı / "x dk önce", pil %)
    - `Avatar` × kişi · görünür "×" düğmesi → "Görmeyi bırak" (uzun basma ve ekran okuyucu eylemi de var)
  - eşitleme uyarı şeridi — bir dinleyici hata verip yeniden deneniyorsa
  - alt bölge
    - `RecenterButton`
    - `BackgroundPermissionHint` — paylaşım sürerken "Her zaman" izni yoksa, engellemeyen öneri
    - `ExpiryBanner` — "Paylaşımın X içinde bitiyor" + `Chip` "+30 dk" / "+1 saat"
    - `ActiveShareCard` × oturum
      - `ProgressRing` — kalan süre
      - alıcı listesi (`Avatar`), bitiş nedenleri (core `END_REASON_TEXT`)
      - `Chip` × uzatma adımları · `Button` "Durdur" / "Tekrar dene" / "Kapat"
    - `ShareButton` — "Konumumu paylaş" (süren paylaşım yokken)
  - `ShareSheet` (aşağıda)
  - çıkış ilerleme örtüsü ("Paylaşımların durduruluyor, çıkış yapılıyor…")

### ShareSheet (`src/features/share/ShareSheet.tsx`)

- `ShareSheet`
  - `BottomSheetModal` (%92, arka perde)
    - `BottomSheetScrollView`
      - `SheetHeader` — "Konumunu paylaş"
      - `RecipientPicker`
        - `BottomSheetTextInput` (Türkçe büyük/küçük harf duyarsız arama)
        - satır × arkadaş (`Avatar` + işaret kutusu) · boş durum: "Arkadaş ekle"
      - `DurationPicker`
        - kısa grup: `Chip` 15 dk · 1 saat · 8 saat · Gün sonuna kadar
        - uzun grup: `Chip` Özel · 1 hafta · Süresiz (onay uyarısı)
        - `CustomDurationPicker` — "Süre" / "Bitiş saati" kipi, artı/eksi adımlayıcılar (5 dk)
        - önizleme: "17:45'e kadar" (core `resolveDuration` + `formatExpiryLabel`)
      - gizlilik notu ("Seçtiğin kişiler birbirini görmez…")
    - alt bilgi (footer): hata metni + `Button` "Paylaşımı başlat"
  - `PermissionFlow` — ilk paylaşımda bir kez (sonra yalnızca ön plan izni yoksa): ön plan izni → "Her zaman" izni →
    bildirim izni (her adım önce açıklanır). Sonraki "Her zaman" yükseltmesi `BackgroundPermissionHint` şeridinden.

## 6. Durum akışı (store → services → Firebase)

```
Kullanıcı "Paylaşımı başlat"
  └─ sharingStore.startShare(receivers, choice)
       ├─ core resolveDuration (sunucu saatiyle) ─ hata → kullanıcıya Türkçe ileti
       ├─ dispatch START_REQUESTED (yerel oturum local_<op_id>, çift dokunuş koruması)
       └─ callables.shareStart({op_id, receiver_ids, duration…})   // europe-west1, zod ile doğrulanır
            ├─ başarı → START_SUCCEEDED (gerçek share_id'ler)
            └─ hata  → ERROR_CODES eşlemesi → START_FAILED (tekrar dene)

Firestore location_shares (sender_id == ben) ──onSnapshot──▶ stopIntents.reconcile + sharingStore.applyServerShares
  (callable'la onaylanan daha yeni sürüm, dinleyici yetişene kadar tutulur)
sharingStore (1 sn TICK) ──selectPublishTargets──▶ sharingCoordinator
  ├─ persist.saveTargets  (kilitli; AsyncStorage: arka plan görevi bunu okur; oturum özetiyle)
  ├─ locationEngine.startBackground / stopBackground (expo-location + TaskManager)
  └─ syncExpiryNotifications (prompt_at'te SHARE_EXPIRING; süresizde haftalık hatırlatma)

Kullanıcı "Durdur"
  └─ sharingStore.stop(session)
       ├─ STOP_REQUESTED + stopIntents.add (bellekteki kesme anahtarı ANINDA kapanır)
       ├─ niyet diske yazılır (AsyncStorage konum.bg.stops.v1) → sonra callables.shareStop
       ├─ başarı → STOP_SUCCEEDED, niyet silinir
       └─ hata  → STOP_FAILED, yayın kapalı kalır; aynı op_id ile 5 sn → 5 dk geri çekilmeli yeniden deneme,
                  ayrıca uygulama öne gelince ve RTDB bağlantısı dönünce. Süreç yeniden başlarsa niyet
                  geri yüklenir (sunucu paylaşımı aktif gösterse bile yayın geri gelmez).

Açılış (sharingCoordinator)
  ├─ niyetler bu hesaba bağlanır → reducer'a STOP_REQUESTED olarak geri yüklenir
  ├─ sunucu yanıtı yoksa kalıcı hedeflerdeki oturum özeti GEÇİCİ kart olarak gösterilir ("Durdur" çalışır)
  ├─ kalıcı hedefler ve ön plan yayını yalnızca gerçek sunucu anlık görüntüsünden sonra
  └─ her dinleyici hata verirse 2 sn → 60 sn geri çekilmeli yeniden abone olur; haritada uyarı şeridi

Konum örneği (arka plan görevi / ön plan izleme / nabız)
  └─ pipeline.handleSamples (sıralı; ağ adımları zaman aşımlı)
       ├─ kalıcı hedefler − süresi dolanlar (sunucu saati) − durdurulanlar (kesme anahtarı)
       │    hedef yoksa: kilit içinde en güncel listeye bakıp takibi kapat, kendi son konum imlecini sil
       ├─ oturum yoklaması: zaman aşımı → örnek atlanır (hiçbir şey silinmez); kesin çıkış → 10 dk ek süre
       ├─ core normalizeSample → selectTrackingProfile → shouldPublish
       ├─ RTDB bağlı değilse yazılmaz (çevrimdışı kuyruğa paket bırakılmaz)
       └─ publisher.publishSample → RTDB update({ "live_locations/<alıcı>/<share_id>": paket, … }) (10 sn zaman aşımı)
            ├─ her yazmadan hemen önce kesme anahtarı (yeniden deneme dahil)
            └─ PERMISSION_DENIED → Firestore'dan aktif hedefleri tazele, kesişimle BİR KEZ yeniden dene
       kalıcı liste yalnızca daraltılır (removeTargetIds / refreshTargetExpiries; asla hedef eklenmez)

"+30 dk" bildirim eylemi
  ├─ uygulama açık: sharingStore.extend
  ├─ soğuk açılış (iOS) ve depo oturumu henüz tanımıyorsa: ilk anlık görüntü ≤ 6 sn beklenir, yoksa callable doğrudan
  ├─ Android kapalı/başsız: callable doğrudan + kalıcı hedef bitişi güncellenir
  └─ başarıdan sonra bildirim kaldırılır; hatada yerel "Süre uzatılamadı" bildirimi; son yanıt temizlenir

Gelen taraf:
  RTDB live_locations/<ben> (child_added/changed/removed) ─▶ incomingStore.upsert/removeLocation (core parseDelivered)
  Firestore location_shares (receiver_id == ben)          ─▶ incomingStore.setShares
  selectVisibleIncoming: biten / süresi dolan / gizlenen paylaşım anında gizlenir
    (paylaşım belgesi varsa bitiş belgeden; uzatılan paylaşım eski paket bitişiyle gizlenmez)
```

Kalıcı (diske yazılan) veri yalnızca arka plan görevinin ihtiyacı olandır: `uid`, aktif yayın
hedefleri (share_id, alıcı, bitiş, oturum özeti), sunucu saat farkı, bildirim metni, son yayın imleci
(paylaşım bitince silinir), takip profili (ayrı anahtar) ve durdurma niyetleri (yalnızca kimlikler;
çıkışta silinmez, aynı hesapla tekrar girişte sunucuya yeniden gönderilir). Gelen konumlar yalnızca
bellekte tutulur. Android otomatik yedeği kapalıdır (`allowBackup: false`). iOS'ta AsyncStorage
klasörü cihaz yedeğine dahildir; yedek dışı bırakmak yerel kod ister (henüz yok). [Varsayım: doğrulanmalı]

### Gizlilik

- Paket alıcı başına ayrı kopya olarak yazılır; pakette başka alıcıların listesi **yoktur**.
- Durdurma / süre dolması gönderenin cihazına ihtiyaç duymadan sunucuda kesilir (RTDB kuralları +
  backend); istemci ayrıca her yazmadan hemen önce kesme anahtarına ve yerel hedef listesine bakar.
- Çıkışta bu cihazın FCM token'ı hesaptan silinir ve geçersiz kılınır (oturum hâlâ açıkken); başka hesap
  girerse token önce döndürülür. Çevrimdışı çıkışta durdurma sunucuya ulaşmazsa kullanıcıya sorulur.
- "Görmeyi bırak" (`share_revoke`) alıcı tarafında anında iyimser gizleme yapar.
- Paylaşım bağlantısı (Faz 2): `https://<LINK_DOMAIN>/s/<token>` ve `konum://s/<token>` → `app/s/[token].tsx` (bkz. §9).

## 7. Platform sınırları (dürüst liste)

- **iOS, uygulama kullanıcı tarafından kapatılırsa (app switcher'dan kaydırma)** sürekli konum
  güncellemeleri durur. Yalnızca "önemli konum değişikliği" (~500 m) uygulamayı arka planda yeniden
  başlatabilir; bu durumda yayın seyrek olur. [Varsayım: doğrulanmalı]
- **iOS hareketsizken** sistem konum güncellemesi vermeyebilir; ön planda JS zamanlayıcısıyla nabız
  gönderilir, arka planda nabız garanti değildir. [Varsayım: doğrulanmalı]
- **iOS bildirim eylemleri** ("+30 dk", "+1 saat") uygulamayı öne getirir; arka planda ağ çağrısının
  tamamlanması garanti olmadığından bu seçildi. [Varsayım: doğrulanmalı]
- **Android 12+**: ön plan servisi arka plandan başlatılamaz (`ForegroundServiceStartNotAllowedException`).
  Takip profili yalnızca uygulama öndeyken yeniden yapılandırılır; arka planda mevcut servis sürer.
- **Android üretici pil yöneticileri** (Xiaomi, Huawei, Samsung vb.) ön plan servisini öldürebilir;
  kullanıcıya pil optimizasyonu istisnası önerilmesi Faz 1'de yok. [Varsayım: doğrulanmalı]
- **Android 13+** bildirim izni (`POST_NOTIFICATIONS`) ayrıca istenir; reddedilirse ön plan servisi
  bildirimi görünmeyebilir ama takip sürer. [Varsayım: doğrulanmalı]
- Süresiz paylaşımın haftalık hatırlatması yereldir; önden 4 hafta planlanır, uygulama açıldıkça yenilenir.
- Sunucu saati RTDB `.info/serverTimeOffset` ile izlenir; arka plan görevi son bilinen farkı kullanır.

## 8. Testler

```bash
npm test
```

- `__tests__/sharingStore.test.ts` — başlat → sunucu onayı → durdur akışı (callables sahte; yayın
  yalnızca onaylıyken), `details.code` → `ERROR_CODES` eşlemesi, geçersiz özel süre, uzatma sırasında
  çift gönderim koruması, saniyelik TICK ile süre dolması, kapatılan oturumun geri gelmemesi;
  durdurma başarısız + süreç yeniden başlar → yayın geri gelmez ve share_stop aynı op_id ile gider;
  otomatik yeniden deneme; aynı kişiyle yeni paylaşım eski engeli kaldırır; geç gelen anlık görüntü
  onaylanan oturumu silmez; niyet uzlaştırma (eski önbellek niyeti kaldırmaz).
- `__tests__/publisher.test.ts` — alıcı başına fan-out haritası (yollar, `v`, `share_id`, `receiver_ids`
  yok), hedef yokken hiçbir şey yazmama, PERMISSION_DENIED sonrası tek tekrar, kesme anahtarı (tazeleme
  sırasında "Durdur" → yeniden deneme o hedefe yazmaz).
- `__tests__/pipeline.test.ts` — oturum yoklaması zaman aşımı hedefleri silmez; kesin çıkışta ek süre;
  başka hesap; çevrimdışıyken yazmama; eşzamanlı "Durdur" altında kalıcı listenin yalnızca daralması;
  yeni başlayan paylaşımın korunması; başsız bağlamda diskteki niyetin yazmayı engellemesi.
- `__tests__/expiryNotifications.test.ts` — evre active → expiring_soon dönünce bildirim iptal edilmez;
  uzatmada değiştirilir; durdurulunca kaldırılır; geçmişe yeni bildirim planlanmaz.
- `__tests__/expiryActions.test.ts` — soğuk açılışta callable doğrudan (gömülü op_id), durdurulan
  oturum uzatılmaz, başarısızlıkta kullanıcı bilgilendirilir ve yeniden denenebilir.
- `__tests__/resilientListener.test.ts` — hata → geri çekilmeli yeniden abonelik, hemen yeniden deneme, dispose.
- `__tests__/incomingStore.test.ts` — uzatılan paylaşımda alıcı haritası eski paket bitişiyle gizlenmez.
- `__tests__/reminders.test.ts` — süresiz paylaşımın haftalık hatırlatma zamanları.
- `__tests__/routesRepo.test.ts` — rota/adres maliyet politikası gerçek callable sarmalayıcısı üzerinden:
  görünmezken çağrı yok, 60 sn kuralı, 150 m eşiği, 5 dk bayatlık, mod önbelleği, tek uçuş,
  `maps_unavailable` (60 sn bekleme) ve `quota_exceeded` (UTC günü boyunca çağrı yok), hücre önbelleği.
- `__tests__/linkStore.test.ts` — bağlantı oluştur (op_id, saat dilimi, URL kasada, token yayın hedefinde
  yok), yanıtı kaybolan oluşturmada aynı op_id, durdur → anında kesme + kalıcı niyet + aynı op_id ile
  yeniden deneme (süreç yeniden başlasa da), `link_not_found`, bitmek üzere evresi, uzatma, süre dolumu.
- `__tests__/linkPublisher.test.ts` — `link_live/{hash}` paketinde yalnızca `LINK_LIVE_FIELDS`,
  PERMISSION_DENIED → tazele + tek tekrar, kesme anahtarı; hatta arkadaş ve bağlantı için iki AYRI yazma,
  yalnızca bağlantı varken takibin sürmesi, eski kalıcı kayıt uyumu.
- `__tests__/deepLink.test.ts` — token/URL çözümü (yalnızca uygulamanın alan adı, kanonik base64url),
  görüntüleyici ekran durumları, `app.config.ts` Universal/App Links, pin hareket planı ve 180. meridyen.
- `__tests__/linkNotifications.test.ts` — bağlantı süre bildirimleri (aynı kategori, `share-expiring-link:<id>`),
  süresiz bağlantı hatırlatması, "+30 dk" eyleminin `link_share_extend` çağırması.

## 9. Faz 2 — Google Haritalar, rota/ETA, bağlantı (QR) paylaşımı

### Harita ekranı bileşen yapısı

```
MapHome (seçim durumu: arkadaş | uzun basışla bırakılan nokta; ulaşım modu)
├─ MapCanvas (PROVIDER_GOOGLE, mapStyleFor(theme) açık/koyu, fitTo)
│  ├─ FriendMarker × n (useMarkerMotion → MarkerAnimated + AnimatedRegion; seçili olan öne çıkar)
│  ├─ DestinationPin (uzun basış)
│  └─ Polyline (rota; decodePolyline)
├─ ExpiryBanner (arkadaş paylaşımı / "Konum bağlantın")
├─ EtaCard (hedef seçiliyken paylaşım kartlarının yerine)
│  ├─ başlık (ad / "Bırakılan nokta") + adres (useAddress → geocodeRepo)
│  ├─ Araç | Yürüyüş | Bisiklet çipleri
│  ├─ formatEtaDuration · formatDistanceTr (useRouteEta → routesRepo)
│  └─ "Rotayı kapat"
├─ ActiveShareCard / ActiveLinkCard ("QR'ı göster", "Durdur")
├─ ShareSheet (Arkadaşlar | Bağlantı (QR) → DurationPicker → "Paylaşmayı başlat" / "QR oluştur")
└─ LinkQrSheet (QR, URL, Kopyala, Paylaş, kalan süre, +30 dk / +1 saat, "Paylaşımı durdur")
```

### Pin animasyonu

`planMarkerMove(prev, next)` (core `markerTransition` üstünde): ilk konum ve büyük sıçrama / uzun ara
anında (`snap`), yakın yeni örnek iki örnek arası süre kadar (300 ms – 2 sn) `easeInOutCubic` ile kayar,
eski/yinelenen örnek yok sayılır. Animasyon JS tarafında `Animated.timing` ile `AnimatedRegion` üzerinde
yürür; iki platformda aynı eğri. Neden: react-native-maps 1.29'da iOS Google sağlayıcısında
`animateMarkerToCoordinate` koordinatı doğrudan atar (animasyon yok), Android'in `ObjectAnimator`'ı farklı
eğri kullanır. Yeni örnek gelince süren animasyon durdurulup bulunduğu yerden devam eder; boylam 180.
meridyende kısa yoldan açılır (`unwrapLng`).

### Rota ve adres: maliyet / kota kuralları (istemci)

- Google'a istemci hiç gitmez: `route_compute` / `geocode_reverse` callable'ları (sunucu anahtarı, sunucu
  önbelleği ve günlük kota backend'de).
- **Yalnızca görünürken**: ETA kartı kapalıysa ya da uygulama arka plandaysa çağrı yok (`visible=false`).
- Rota (`routesRepo`): core `shouldRecomputeRoute` — aynı hedef için en az 60 sn arayla, başlangıç ≥150 m
  ya da hedef ≥150 m oynadıysa veya sonuç 5 dk bayatsa; mod/hedef değişimi hemen; dönülen mod bellek
  önbelleğinden ücretsiz. Başarısız deneme de son deneme sayılır (hata döngüsü yok). Tek uçuş. 32 girdi LRU.
- Adres (`geocodeRepo`): core `shouldReverseGeocode` + `geocodeCell` hücre önbelleği (200 hücre); aynı
  hücredeki başka özne de ağa çıkmaz; hata sonrası 60 sn bekleme.
- `maps_unavailable` → "Varış süresi şu an hesaplanamıyor. Birazdan yeniden denenecek."; `quota_exceeded` →
  "Bugünlük rota hesaplama sınırına ulaşıldı. Yarın yeniden açılır." ve o UTC günü boyunca hiç çağrı yapılmaz
  (rota ve adres ayrı). Web görüntüleyici Routes/Geocoding çağırmaz.

### Süre yaşam döngüsü ve uzatma (bağlantı)

Süreler arkadaş paylaşımıyla aynı: 15 dk, 1 saat, 8 saat, gün sonu, haftalık, süresiz (`LINK_DURATION_OPTIONS`).
Evreler `active → expiring_soon (extendPromptAt) → extending → active` ya da `stopping → ended`; süre dolunca
saniyelik saatle `ended/expired` olur ve yayın hedefi düşer. "Bitmek üzere" yerel bildirimi Faz 1 ile aynı
kategori (`SHARE_EXPIRING`), kimlik `share-expiring-link:<link_id>`; "+30 dakika" / "+1 saat" eylemi bildirimde
gömülü op_id ile `link_share_extend` çağırır (uygulama açıksa depo üzerinden). Süresiz bağlantıya haftalık
"Konum bağlantın hâlâ açık" hatırlatması. Sunucu onaylı yanıt, dinleyici aynı sürümü getirene kadar tutulur.

### QR token, bağlantı yönlendirme, anında iptal

- Token yalnızca `link_share_create` yanıtında gelir. Token içeren URL **yalnızca** cihazın güvenli
  deposunda (expo-secure-store, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, `konum.link.token.<link_id>`) durur;
  AsyncStorage'a, günlüğe, yayın hedefine girmez. Arka plan yayıncısı yalnızca `token_hash` bilir.
  Kasada yoksa (yeniden kurulum) QR yerine "Bu bağlantının QR kodu bu cihazda yok…" + Durdur gösterilir.
- Yanıtı kaybolan oluşturma aynı süreyle 10 dk içinde yeniden denenirse aynı op_id gider; sunucu aynı
  `link_id` için token'ı yeniler (yetim bağlantı açılmaz).
- Yayın: `link_live/{token_hash}` paketi (yalnızca `LINK_LIVE_FIELDS`: gönderen kimliği, şarj durumu,
  etkinlik yok) arkadaş fan-out'undan AYRI bir RTDB `update()` ile yazılır.
- "Paylaşımı durdur": kesme anahtarı eşzamanlı kapanır (sonraki örnek yazılmaz), niyet diske
  (`konum.bg.linkstops.v1`) yazılır, `link_share_stop` aynı op_id ile geri çekilmeli yeniden denenir; süreç
  yeniden başlasa da engel sürer. Sunucu `link_acl` mezar taşı + `link_live` silme → açık görüntüleyici `null`
  alır, pin kalkar ("Paylaşım sona erdi"). Süre dolumunu RTDB kuralı keser.
- Açma: `https://<LINK_DOMAIN>/s/<token>` → uygulama kuruluysa Universal Links (iOS `applinks:`) /
  App Links (Android `autoVerify`) ile `app/s/[token].tsx`; kimlik kapısının dışında, oturum açmadan salt
  okunur harita. Kurulu değilse aynı URL web haritasını açar. Yalnızca uygulamanın alan adı ve kanonik
  43 karakter base64url token kabul edilir; aksi "Bağlantı geçersiz". İlk okuma reddedilirse (yok / durdurulmuş /
  süresi dolmuş, ayırt edilmez) "Bağlantı geçersiz ya da süresi dolmuş"; erişim varken biterse "Paylaşım sona erdi".
  Durumlar ve metinler web haritasıyla ortak (core `linkViewState` + `hadAccess`, `LINK_VIEW_TEXT`, `LINK_VIEW_DETAIL`).
- Barındırma (backend): `/.well-known/apple-app-site-association` (`<TEAM_ID>.<BUNDLE_ID>`, `/s/*`) ve
  `/.well-known/assetlinks.json` (paket adı + imza SHA-256) — yer tutucular gerçek değerlerle değişmeli.

### Yeni bağımlılıklar

`expo-secure-store` (~58.0.3), `expo-clipboard` (~58.0.4), `react-native-qrcode-svg` (6.3.54, tam sürüm;
`react-native-svg` zaten vardı). Hepsi yeni bir development build gerektirir.

### Faz 2 platform sınırları [Varsayım: cihazda doğrulanmalı]

- Universal Links iOS'ta yalnızca başka bir uygulamadan/Safari'den dokunulunca açılır; adres çubuğuna
  yazılan URL web haritasında kalır. Android App Links doğrulaması assetlinks.json imza parmak izine bağlı.
- Bağlantı "+30 dk" bildirim eylemi iOS'ta uygulamayı öne getirir (Faz 1 ile aynı gerekçe).
- iOS'ta uygulama kapatılınca (app switcher) bağlantı yayını da arkadaş yayını gibi seyrekleşir.
