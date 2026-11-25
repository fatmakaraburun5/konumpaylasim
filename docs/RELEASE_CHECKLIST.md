# Mağaza Yayını Kontrol Listesi (Faz 1–6)

Bu liste, altı fazın birlikte App Store ve Google Play'e çıkmadan önce doğrulanması gerekenleri alan alan toplar. Her
madde ya bir hesap / konsol işidir ya da gerçek cihazda yapılacak bir denemedir; kod tarafı hazırdır (bkz. faz belgeleri
`PHASE2.md` … `PHASE6.md`, geçiş listeleri `PHASES.md`). **[Varsayım]** işaretli ürün kararları yayından önce
kapatılmalıdır. Kutular yayın sorumlusu tarafından işaretlenir.

> Not: Gerçek Firebase projesinin kurulması ve dağıtım hattı bu listenin dışında, ayrı bir işte yürüyor (son bölüm).
> Aşağıdaki "Dağıtım" maddeleri o iş bitince gerçek projeye karşı yapılır.

## 1. Kimlikler, imzalama ve sürüm

- [ ] Gerçek paket kimliği seçildi ve `apps/mobile/app.config.ts` `BUNDLE_ID` değiştirildi. App Group
      `group.${BUNDLE_ID}` ve widget kimliği `${BUNDLE_ID}.widgets` bundan türetilir (`targets/` ve
      `modules/konum-widgets/` içinde elle yazılmış kimlik yok). Kod dışında kalan yer tutucular da güncellendi:
      `backend/hosting/public/.well-known/{apple-app-site-association,assetlinks.json}` ve onları denetleyen
      `backend/test/unit/contract.test.ts` (`firebase-kurulum` dalı bunu `com.konumpaylasim.app` için yapıyor);
      sonunda `grep -rn com.example.konum` yalnızca belgelerde çıkmalı.
- [ ] Apple Developer: uygulama App ID'si + **widget uzantısı App ID'si** (`${BUNDLE_ID}.widgets`); ikisinde de **App
      Groups** (`group.${BUNDLE_ID}`), uygulamada Push Notifications, Associated Domains, Time Sensitive Notifications;
      provizyon profilleri iki hedef için ayrı.
- [ ] `APPLE_TEAM_ID` derleme ortamında verildi (`@bacons/apple-targets` uzantıyı bununla imzalar); uzantı uygulamaya
      gömülü (Embed Foundation Extensions) ve aynı ekip kimliğiyle imzalı.
- [ ] Android: yükleme anahtarı + Play App Signing; SHA-256 parmak izleri `assetlinks.json`'a, SHA-1'ler Maps SDK
      Android anahtarına ve Firebase Android uygulamasına eklendi.
- [ ] Sürümleme kararı: `version` (şu an `0.1.0`), iOS `buildNumber` ve Android `versionCode` her mağaza yüklemesinde
      artırılıyor (EAS `autoIncrement` ya da CI). `eas.json` henüz yok: derleme profilleri (development / preview /
      production) oluşturuldu.
- [ ] `expo prebuild` temiz üretim: Android manifestte `RECORD_AUDIO`, depolama ve `SYSTEM_ALERT_WINDOW` kaldırılmış
      (`tools:node="remove"`), widget sağlayıcıları ve `exported=false` alıcı var; iOS'ta uzantı dağıtım hedefi 17.0,
      uygulama 16.4.
- [ ] iOS bağlama: `useFrameworks: 'dynamic'` ile react-native-maps Google pod'u + Firebase SPM macOS'ta derlendi
      (`apps/mobile/README.md` "iOS bağlama notu").

## 2. Native derleme ve yerel modüller

- [ ] `modules/konum-activity` (Faz 3, Swift `CMMotionActivityManager` / Kotlin Activity Recognition) iOS ve Android'de
      derlendi; `KONUM_ACTIVITY_RECOGNITION=0` kapalı derleme de denendi.
- [ ] `modules/konum-widgets` (Faz 6, Swift + Kotlin) ve `targets/widgets` (WidgetKit) Xcode 16+ ve Android Gradle ile
      derlendi; riskli API'ler (`AppIntentConfiguration`, `Button(intent:)`, `ProgressView(timerInterval:)`,
      `TileService.startActivityAndCollapse`, `setChronometerCountDown`) cihazda çalışıyor (`PHASE6.md` §10).
- [ ] Yeni yerel bağımlılıklar development build'de: expo-secure-store, expo-clipboard, react-native-qrcode-svg (Faz 2),
      expo-sqlite (Faz 3), expo-image-picker, expo-image-manipulator, expo-image, expo-file-system,
      @react-native-firebase/storage, `androidx.work` (Faz 6).

## 3. İzin metinleri ve izin akışları

- [ ] iOS `Info.plist` metinleri Türkçe ve gerçek kullanımı anlatıyor: `NSLocationWhenInUseUsageDescription`,
      `NSLocationAlwaysAndWhenInUseUsageDescription`, (açıksa) `NSMotionUsageDescription`, `NSCameraUsageDescription`
      ("Profil fotoğrafı çekebilmen için…"), `NSPhotoLibraryUsageDescription` ("Yalnızca seçtiğin fotoğraf yüklenir").
      Mikrofon izni İSTENMİYOR (`microphonePermission: false`).
- [ ] Android: `ACCESS_FINE/COARSE/BACKGROUND_LOCATION`, `FOREGROUND_SERVICE(_LOCATION)`, `POST_NOTIFICATIONS`,
      `ACTIVITY_RECOGNITION` (açıksa), `CAMERA` (image-picker kütüphanesinden). Fazladan izin yok.
- [ ] Kademeli konum izni (Faz 3 `nextPermissionStep`): sistem penceresinden önce açıklama; "Her zaman" yalnızca
      gerektiğinde; reddedince "Ayarları aç". Bölgeler (Faz 5) ve widget arka plan paylaşımı (Faz 6) aynı izni ister.
- [ ] Kamera / galeri reddi → "Ayarları aç"; iOS sınırlı galeri; Android 13+ fotoğraf seçici (depolama izni yok).
- [ ] Bildirim izni: Android 13+ çalışma zamanı izni; iOS izin istemi bağlamında (ilk paylaşım / SOS).

## 4. Arka plan konumu gerekçesi

- [ ] **Apple inceleme notu:** arka plan konumunun neden gerektiği (süreli / süresiz canlı paylaşım, bölge varış /
      ayrılış, widget'tan başlatılan 1 saatlik paylaşım), kullanıcının her paylaşımı açıkça başlattığı, mavi gösterge,
      "Durdur"un her yerde olduğu; demo hesap + adım adım test yolu + ekran kaydı (paylaşım başlat → kilitle → alıcıda
      hareket → Durdur).
- [ ] **Google Play "Arka planda konum erişimi" beyanı** + kısa video (belirgin açıklama ekranı → izin → arka planda
      paylaşım → bildirimdeki "Durdur"); belirgin açıklama metni Play ifadesiyle ("uygulama kapalıyken veya
      kullanılmıyorken de") güncel.
- [ ] Android ön plan servisi türü `location` + Play Console "Ön plan hizmeti" beyanı (Android 14+).
- [ ] Gerçek cihazda pil ölçümü (`PHASE3.md` §4.3) ve üretici pil yöneticileri (Xiaomi, Samsung, Huawei) 24 sa süresiz
      paylaşım; Faz 5 bölge algılaması uygulama kapalıyken (`PHASE5.md` §7.1); Faz 6 widget'tan paylaşım uygulama
      kapalıyken (`PHASE6.md` §9.1).

## 5. Bildirimler, SOS ve Critical Alerts

- [ ] APNs kimlik doğrulama anahtarı Firebase'e yüklü; `remote-notification` arka plan modu ve `content-available`
      (Faz 3 `resume_tracking`, Faz 6 `widget_refresh`) gerçek cihazda uyandırıyor.
- [ ] Android kanalları: `share_expiring`, `location_requests`, `share_status`, `sos`, `ping`, `konum_widget_quick`;
      adlar ve önemler Türkçe ve doğru.
- [ ] iOS kategorileri: `SHARE_EXPIRING` (+30 dk / +1 saat), `QUICK_SHARE` ("Durdur"), SOS / ping (`showTitle`).
- [ ] **Critical Alerts:** Apple'a yetki başvurusu yapıldı (`PHASE4.md` §3.4). Onay gelene kadar `IOS_CRITICAL_ALERTS`
      ve Functions `SOS_CRITICAL_ALERTS` KAPALI (SOS `time-sensitive`). Onay gelince ikisi **birlikte** açılır,
      entitlement'lı provizyon profili yenilenir.
- [ ] SOS cihaz testleri: DND / Odak açık, sessiz mod, kilit ekranı, uygulama kapalıyken dokunma → tam ekran kart
      (`PHASE4.md` §6.1). App Store notunda SOS'un acil servisin yerine geçmediği ("112'yi ara" düğmesi) yazıyor.
- [ ] Android `USE_FULL_SCREEN_INTENT` / "Rahatsız Etme erişimi" kararı (Play politikası) **[Varsayım]**.

## 6. Widget'lar ve uzantılar (Faz 6)

- [ ] App Group iki hedefte de aynı ve imzalı derlemede uzantı anlık görüntüyü (`konum.widget.snapshot.v1`) okuyor.
- [ ] Anahtarlık paylaşımı: uzantı token'ı App Group erişim grubundan okuyor (imzalı derleme; simülatörde
      `errSecMissingEntitlement` beklenir → widget uygulamayı açar).
- [ ] iOS: kilit ekranı aksesuarlarında Face ID / parola istemi; `lock_screen_details` kapalıyken yer / pil görünmüyor;
      StandBy'da `.privacySensitive()` örtüyor.
- [ ] Android: 2x2 / 4x2 farklı başlatıcılarda (Pixel, Samsung One UI) düzgün; Hızlı Ayar kutucuğu kilitliyken
      `unlockAndRun`; WorkManager bayatlık yenilemesi Doze'da çalışıyor.
- [ ] Widget galerisi açıklamaları ve önizlemeleri Türkçe; mağaza ekran görüntülerinde widget yer alıyor (isteğe bağlı).
- [ ] `widget_quick_share` kimliksiz çağrılabiliyor (Cloud Run invoker `allUsers`), token akışı uçtan uca: al →
      widget'tan paylaş → push → başsız takip → iptal (çıkış).

## 7. Firebase güvenliği: App Check, kurallar, anahtarlar

- [ ] **App Check:** iOS App Attest (DeviceCheck yedek), Android Play Integrity; Functions `ENFORCE_APP_CHECK`
      üretimde açık (`APP_CHECK_ENFORCE` ≠ `false`); Firestore / RTDB / Storage için App Check zorlaması konsolda
      açıldı (önce izleme kipinde ölçüldü). Web haritası RTDB zorlaması açılacaksa reCAPTCHA Enterprise.
- [ ] **Kurallar dağıtıldı ve emülatör testleri geçti:** `firestore.rules` (users, friendships, location_shares,
      link_shares, place_notes, sos_alerts, zones, zone_events, meetups, `widget_tokens` kapalı),
      `database.rules.json` (live_locations, link_live, live_trail, ping_inbox), **`storage.rules`** (yalnızca
      `avatars/{uid}/{13 hane}(_160).jpg`, `image/jpeg`, 400 KB / 60 KB, list kapalı).
- [ ] `firestore.indexes.json`: bileşik dizinler + TTL alanları (Faz 3 `battery_alerts`, Faz 4 `place_notes`,
      `sos_alerts`, Faz 5 `zone_events`, `zone_cooldowns`, `meetups`, `meetup_cache`, Faz 6 `widget_tokens.purge_at`).
- [ ] **Anahtar kısıtları:** Maps SDK iOS (paket kimliği), Android (paket + SHA-1), web (referrer
      `https://<alan>/*`), sunucu anahtarı yalnızca Routes / Geocoding / Places (Secret Manager
      `GOOGLE_MAPS_SERVER_KEY`); kullanılmayan Google API'leri kapalı; bütçe uyarıları %50 / %90 / %100 ve
      `config/maps` bütçesi.
- [ ] Sırlar: `PHONE_HMAC_PEPPER`, Maps sunucu anahtarı Secret Manager'da; depoda gerçek anahtar yok.
- [ ] Functions hizmet hesabı: Storage nesne silme (avatar eski sürümü, hesap silme), Cloud Tasks kuyruğu
      (`shareexpirytask`) yetkileri.

## 8. Gizlilik etiketleri ve veri formları

- [ ] **App Store Gizlilik "beslenme" etiketi:** Kesin Konum (uygulama işlevi, kullanıcıya bağlı, izleme yok),
      Telefon numarası (hesap), Ad, **Fotoğraflar** (profil fotoğrafı, kullanıcıya bağlı), **Diğer kullanıcı içeriği /
      kişisel bilgi: cinsiyet** (yalnızca çerçeve rengi), Cihaz kimliği (push belirteci, widget cihaz kimliği),
      Tanılama (çökme raporlama eklenirse).
- [ ] **Google Play Veri Güvenliği formu:** aynı kalemler + "Konum: hassas, arka planda", "Fotoğraflar", "Kişisel
      bilgi: cinsiyet"; aktarımda şifreleme; silme talebi yolu; üçüncü taraf: Google (Maps / Places / Routes; sunucu
      üzerinden, buluşma önerisinde arkadaş konumu hesap için gider, saklanmaz — `PHASE5.md` §6).
- [ ] **iOS Privacy Manifest** (`PrivacyInfo.xcprivacy`): gerekli neden API'leri (UserDefaults: App Group anlık
      görüntüsü, dosya zaman damgası, sistem açılış süresi) uygulama ve **widget uzantısı** için; üçüncü taraf SDK
      manifestleri (Firebase, Google Maps) güncel.
- [ ] Gizlilik politikası metni: konum saklama süreleri (canlı kopya paylaşım bitince silinir, `live_trail` ≤ 24 sa,
      bölge olay kaydı 30 gün), push'larda koordinat olmadığı, profil fotoğrafının EXIF / GPS'ten arındırıldığı,
      cinsiyetin yalnızca görünüm için kullanıldığı, widget kilit ekranı varsayılanı.
- [ ] EXIF doğrulaması: gerçek cihazdan yüklenen avatar dosyasında GPS / EXIF yok (`exiftool`).

## 9. Hesap silme ve veri hakları

- [ ] Backend `account_delete` hazır (profil, arkadaşlıklar, paylaşımlar, ACL'ler, bölgeler, olaylar, notlar, SOS,
      widget token'ları, başkalarının favorilerindeki uid, `avatars/{uid}/` klasörü).
- [ ] **Uygulama içinden hesap silme ekranı** (Apple 5.1.1(v) zorunlu; Play de istiyor): mobil arayüzde henüz YOK —
      Profil ekranına "Hesabımı sil" (onay + yeniden kimlik doğrulama) eklenmeli; ayrıca web'den silme talebi bağlantısı
      (Play Veri Güvenliği "hesap silme URL'si").
- [ ] Çıkış: push belirteci, widget token'ı (sunucuda iptal), yerel anlık görüntü, avatar dosyaları, kalıcı hedefler,
      bölge kayıtları siliniyor (cihazda doğrula).

## 10. İnceleme için test hesapları

- [ ] Apple ve Google inceleyicileri için **iki demo hesabı** (birbirine arkadaş, biri favori) ve Firebase Phone Auth
      **test telefon numaraları + sabit kod** (gerçek SMS gerekmez); inceleme notunda numaralar ve kod.
- [ ] Demo hesaplarda örnek bölge, profil fotoğrafı (gerçek kişi değil), favori ve widget kurulumu anlatımı.
- [ ] İnceleme notunda: arka plan konumu gerekçesi, SOS'un ne yaptığı, widget'ın Face ID istediği, verinin
      arkadaşlar dışına çıkmadığı (QR bağlantısı yalnızca kullanıcı paylaşırsa).

## 11. Çökme raporlama ve izleme

- [ ] Çökme raporlama SDK'sı seçildi ve eklendi (ör. Firebase Crashlytics; şu an YOK); iOS dSYM / Android mapping
      yüklemesi CI'da; gizlilik etiketine "Tanılama" eklendi. Widget uzantısının çökmeleri de raporlanıyor.
- [ ] Cloud Functions hata uyarıları (Cloud Monitoring), Maps bütçe alarmı, RTDB bant genişliği ve Firestore okuma
      uyarıları.
- [ ] Sürüm notları ve aşamalı yayın (Play %10 → %50 → %100, App Store phased release).

## 12. Faz bazında son cihaz kabulü

- [ ] **Faz 1:** iki hesapla 1 saatlik paylaşım, ekran kapalı 30 dk akış, "Durdur" sonrası kesilme; uçak modunda süre
      dolumu ≤ 1 dk.
- [ ] **Faz 2:** QR → uygulama kuruluysa uygulamada, değilse web haritası; iptalde web sekmesi 2 sn içinde kapanır;
      Universal / App Links doğrulanmış (`pm get-app-links` "verified", AASA 200).
- [ ] **Faz 3:** S1–S9 dayanıklılık senaryoları, %15 pil bildirimi, çevrimdışı kuyruk eşitlemesi.
- [ ] **Faz 4:** ping / not / SOS bildirim davranışı, soğuk açılışta doğru ekran.
- [ ] **Faz 5:** evden çıkış / eve varış (uygulama kapalı), GPS sapmasında sıfır yanlış tetik, buluşma önerisi gerçek
      Places / Routes anahtarıyla ve faturada beklenen SKU'lar.
- [ ] **Faz 6:** kayıt cinsiyet zorunlu, eski hesap kapısı, kamera / galeri fotoğrafı ve çerçeve renkleri (liste, pin,
      widget), Android pin `tracksViewChanges`, widget'tan 1 saat (kilitli / kilitsiz, uygulama kapalı), token süresi
      dolunca uygulama akışı, hız sınırı, kilit ekranı gizliliği (`PHASE6.md` §9.1).

## Gerçek Firebase projesine geçiş (ertelendi)

Gerçek Firebase projesinin açılması, yapılandırma dosyalarının (`google-services.json`, `GoogleService-Info.plist`)
yerleştirilmesi, kural / dizin / Functions / Hosting / Storage dağıtımı, sırlar ve CI dağıtım hattı bu fazın kapsamı
dışında **ayrı bir işte** yürütülüyor: `firebase-kurulum` dalındaki çalışma (önyükleme ve dağıtım betikleri, GitHub
Actions iş akışı ve `docs/DEPLOY.md`). O iş birleştirildiğinde:

- [ ] `firebase-kurulum` dalı bu dalla birleştirildi; Faz 6 eklemeleri (`storage.rules`, `firebase.json` storage girdisi,
      `widget_tokens` kuralı ve TTL, 4 yeni callable, `tokenCallable`'ın kimliksiz çağrılabilirliği) dağıtım
      betiklerine ve iş akışına eklendi.
- [ ] Yukarıdaki §7 maddeleri gerçek projeye karşı işaretlendi ve faz belgelerindeki emülatör kabul testleri
      (`PHASES.md`) gerçek projede bir kez tekrarlandı.
