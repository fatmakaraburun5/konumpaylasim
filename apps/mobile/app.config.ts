/**
 * Expo yapılandırması (Continuous Native Generation): ios/ ve android/ klasörleri DEPODA TUTULMAZ,
 * `npx expo prebuild` ile her seferinde bu dosyadan üretilir.
 *
 * Gizli değerler ortam değişkenlerinden gelir (bkz. `.env.example`). Expo CLI `.env` dosyasını
 * bu dosya değerlendirilmeden önce yükler.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

/** [Varsayım] Gerçek paket kimliği mağaza hesabı açılınca belirlenecek. */
const BUNDLE_ID = 'com.example.konum';

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
};

const GOOGLE_SERVICES_JSON = env('GOOGLE_SERVICES_JSON') ?? './firebase/google-services.json';
const GOOGLE_SERVICE_INFO_PLIST = env('GOOGLE_SERVICE_INFO_PLIST') ?? './firebase/GoogleService-Info.plist';

/**
 * Google Haritalar anahtarları. Anahtar yoksa yer tutucu yazılır: yerel derleme yine de çalışır,
 * ancak harita karoları yüklenmez (Google SDK yetkilendirme hatası loglar). iOS'ta yer tutucu
 * ayrıca `react-native-maps/Google` pod'unun kurulmasını garanti eder; aksi halde PROVIDER_GOOGLE çöker.
 */
const MISSING_KEY = 'MISSING_GOOGLE_MAPS_KEY';
const GOOGLE_MAPS_IOS_API_KEY = env('GOOGLE_MAPS_IOS_API_KEY') ?? MISSING_KEY;
const GOOGLE_MAPS_ANDROID_API_KEY = env('GOOGLE_MAPS_ANDROID_API_KEY') ?? MISSING_KEY;

/**
 * Üretim derlemesi mi? EAS profili (`EAS_BUILD_PROFILE`) ya da elle verilen `APP_VARIANT`.
 * [Varsayım] Profil adı "production"; eas.json henüz yok (bkz. README).
 */
const IS_PRODUCTION = env('EAS_BUILD_PROFILE') === 'production' || env('APP_VARIANT') === 'production';

if (GOOGLE_MAPS_IOS_API_KEY === MISSING_KEY || GOOGLE_MAPS_ANDROID_API_KEY === MISSING_KEY) {
  if (IS_PRODUCTION) {
    // Üretimde yer tutucuyla harita boş çıkardı: derlemeyi durdur.
    throw new Error(
      '[konum] Üretim derlemesi için GOOGLE_MAPS_IOS_API_KEY ve GOOGLE_MAPS_ANDROID_API_KEY zorunlu. ' +
        'Anahtarları Google Cloud Console\'da paket kimliği (iOS) ve paket adı + SHA-1 (Android) ile kısıtlayın.',
    );
  }
  // Geliştirme / CI: JS paketi anahtarsız da üretilebilmeli; yalnızca uyarıyoruz.
  console.warn('[konum] GOOGLE_MAPS_IOS_API_KEY / GOOGLE_MAPS_ANDROID_API_KEY tanımlı değil: harita boş görünecek.');
}

/**
 * Faz 2: QR / paylaşım bağlantısı alan adı. QR şu URL'yi taşır: `https://<LINK_DOMAIN>/s/<token>`.
 *  - iOS Universal Links: `associatedDomains: applinks:<LINK_DOMAIN>`; alan adında
 *    `/.well-known/apple-app-site-association` (appID `<TEAM_ID>.<BUNDLE_ID>`, yol `/s/*`) yayınlanmalı.
 *  - Android App Links: `autoVerify` intent filtresi; alan adında `/.well-known/assetlinks.json`
 *    (paket adı + imza SHA-256 parmak izleri) yayınlanmalı.
 * Uygulama kurulu değilse aynı URL tarayıcıda salt okunur web haritasını (apps/web) açar.
 * Varsayılan core `LINK_DOMAIN_DEFAULT` ile aynıdır [Varsayım: gerçek alan adı alınınca `.env`'de verilir].
 */
const LINK_DOMAIN_DEFAULT = 'konum.example.com';
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function resolveLinkDomain(): string {
  const raw = env('LINK_DOMAIN');
  if (!raw) return LINK_DOMAIN_DEFAULT;
  const d = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (HOST_RE.test(d)) return d;
  if (IS_PRODUCTION) throw new Error(`[konum] LINK_DOMAIN geçersiz: "${raw}" (ör. konum.ornek.com)`);
  console.warn(`[konum] LINK_DOMAIN geçersiz ("${raw}"), varsayılan kullanılıyor: ${LINK_DOMAIN_DEFAULT}`);
  return LINK_DOMAIN_DEFAULT;
}
const LINK_DOMAIN = resolveLinkDomain();
if (IS_PRODUCTION && LINK_DOMAIN === LINK_DOMAIN_DEFAULT) {
  console.warn('[konum] Üretim derlemesinde LINK_DOMAIN yer tutucu (konum.example.com): QR bağlantıları uygulamayı açmaz.');
}

/**
 * Faz 3: OS hareket etkinliği (iOS CMMotionActivityManager, Android Activity Recognition Transition API;
 * yerel modül modules/konum-activity). Varsayılan AÇIK; `KONUM_ACTIVITY_RECOGNITION=0` ile kapanır: o zaman
 * NSMotionUsageDescription / ACTIVITY_RECOGNITION hiç eklenmez ve hareket durumu yalnızca konum örneklerinden
 * (hız + yer değiştirme) çıkarılır. [Varsayım] Mağaza incelemesinde izin gerekçesi aşağıdaki metin.
 */
const ACTIVITY_RECOGNITION = env('KONUM_ACTIVITY_RECOGNITION') !== '0';
const MOTION_USAGE =
  'Hareketsizken GPS’i kapatıp pilini korumak ve yürüme / araç hızına göre konum güncelleme sıklığını ayarlamak için hareket etkinliğini kullanıyoruz. Bu bilgi telefonundan çıkmaz.';

/**
 * Faz 4: SOS bildirimleri.
 *  - iOS `time-sensitive` yetkisi her zaman açık: SOS odak modunu (Focus) deler ve kilit ekranında öne çıkar.
 *  - iOS Critical Alerts (sessiz modu ve Rahatsız Etme'yi aşan ses) Apple'ın ayrı onayını ister; onay gelmeden
 *    yetkiyi eklemek imzalamayı bozar. Bu yüzden `IOS_CRITICAL_ALERTS=1` ile açılır, varsayılan KAPALI
 *    [Varsayım: Apple onayı gerekir]. Backend'de de `SOS_CRITICAL_ALERTS` bayrağı aynı anda açılmalı.
 *  - Android: `ACCESS_NOTIFICATION_POLICY` — `sos` kanalı `bypassDnd` ile Rahatsız Etme modunu aşabilsin
 *    (kullanıcı Ayarlar > Rahatsız Etme erişimi'nden izin verir; verilmezse kanal yine MAX önceliklidir).
 */
const IOS_CRITICAL_ALERTS = env('IOS_CRITICAL_ALERTS') === '1';

const LOCATION_WHEN_IN_USE =
  'Konumunu yalnızca sen paylaşım başlattığında, seçtiğin arkadaşlarına ve seçtiğin süre boyunca göstermek için kullanıyoruz.';
const LOCATION_ALWAYS =
  'Paylaşım sürerken uygulama arka plandayken ya da ekran kapalıyken de konumunun seçtiğin arkadaşlarına ulaşması için "Her zaman" izni gerekir. Paylaşım bitince konum takibi durur.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Konum',
  slug: 'konum',
  scheme: 'konum',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    googleServicesFile: GOOGLE_SERVICE_INFO_PLIST,
    // Universal Links: https://<LINK_DOMAIN>/s/<token> uygulamayı açar (paylaşılan canlı harita).
    associatedDomains: [`applinks:${LINK_DOMAIN}`],
    entitlements: {
      'com.apple.developer.usernotifications.time-sensitive': true,
      ...(IOS_CRITICAL_ALERTS ? { 'com.apple.developer.usernotifications.critical-alerts': true } : {}),
    },
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_WHEN_IN_USE,
      NSLocationAlwaysAndWhenInUseUsageDescription: LOCATION_ALWAYS,
      ...(ACTIVITY_RECOGNITION ? { NSMotionUsageDescription: MOTION_USAGE } : {}),
      // location: arka plan konum oturumu (mavi gösterge); remote-notification: `resume_tracking` sessiz push.
      UIBackgroundModes: ['location', 'remote-notification'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: BUNDLE_ID,
    googleServicesFile: GOOGLE_SERVICES_JSON,
    permissions: [
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.POST_NOTIFICATIONS',
      // Faz 4: SOS kanalı Rahatsız Etme modunu aşabilsin (kullanıcı Ayarlar'dan erişim verir) + titreşim.
      'android.permission.ACCESS_NOTIFICATION_POLICY',
      'android.permission.VIBRATE',
      // Faz 3: Activity Recognition Transition API (Android 10+ çalışma zamanı izni "Fiziksel etkinlik").
      ...(ACTIVITY_RECOGNITION ? ['android.permission.ACTIVITY_RECOGNITION'] : []),
      // NOT: REQUEST_IGNORE_BATTERY_OPTIMIZATIONS BİLEREK YOK (Play politikası: konum paylaşımı izinli istisna
      // kategorisinde değil [Varsayım]); haftalık/süresiz paylaşımda kullanıcı pil ayarlarına yönlendirilir.
    ],
    // [Varsayım] Şablonun varsayılan olarak eklediği, uygulamanın kullanmadığı izinler (Play incelemesi + gizlilik).
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ],
    // Gizlilik: Android otomatik yedeği AsyncStorage'daki yayın hedeflerini buluta taşımasın.
    allowBackup: false,
    // App Links: https://<LINK_DOMAIN>/s/* doğrulanmış bağlantı (assetlinks.json) → uygulama içi canlı harita.
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: LINK_DOMAIN, pathPrefix: '/s/' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-localization',
    'expo-system-ui',
    [
      'expo-build-properties',
      {
        ios: {
          /**
           * DİKKAT: Görev tanımı "static" istiyordu; ancak @react-native-firebase 27 (Firebase Apple SDK 13,
           * yalnızca SPM) statik bağlamayı `pod install` sırasında BİLEREK reddeder
           * (`rnfirebase_fail_if_spm_static_linkage!`, node_modules/@react-native-firebase/app/firebase_spm.rb).
           * RNFB 27'nin desteklediği tek seçenek dinamik framework'tür. [Varsayım: doğrulanmalı]
           * react-native-maps Google pod'unun dinamik framework ile birlikte macOS'ta derlenmesi.
           */
          useFrameworks: 'dynamic',
        },
        android: {
          // [Varsayım] Play Store hedef API şartı; Expo 58 varsayılanı zaten 36 olabilir.
          targetSdkVersion: 36,
        },
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission: LOCATION_WHEN_IN_USE,
        locationAlwaysAndWhenInUsePermission: LOCATION_ALWAYS,
        locationAlwaysPermission: LOCATION_ALWAYS,
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        // Faz 3: hareket etkinliği (bayrak açıkken; yerel modül modules/konum-activity).
        motionUsagePermission: ACTIVITY_RECOGNITION ? MOTION_USAGE : false,
        androidForegroundServiceIcon: './assets/notification-icon.png',
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#2563EB',
      },
    ],
    '@react-native-firebase/app',
    '@react-native-firebase/auth',
    '@react-native-firebase/messaging',
    '@react-native-firebase/app-check',
    [
      'react-native-maps',
      {
        // İki platformda da PROVIDER_GOOGLE: iOS'ta GoogleMaps pod'u + AppDelegate kurulumu bu eklentiyle yapılır.
        iosGoogleMapsApiKey: GOOGLE_MAPS_IOS_API_KEY,
        androidGoogleMapsApiKey: GOOGLE_MAPS_ANDROID_API_KEY,
      },
    ],
    './plugins/withLocationForegroundService',
    /**
     * Faz 6: profil fotoğrafı. Kamera ile çekme ve galeriden seçme. iOS 14+ sistem seçicisi (PHPicker) kitaplık izni
     * istemez; metin yalnızca eski yol / sınırlı erişim için. Android 13+ fotoğraf seçici izinsiz çalışır.
     */
    [
      'expo-image-picker',
      {
        photosPermission: 'Profil fotoğrafını galerinden seçebilmen için fotoğraflarına erişiyoruz. Yalnızca seçtiğin fotoğraf yüklenir.',
        cameraPermission: 'Profil fotoğrafı çekebilmen için kameraya erişiyoruz.',
        microphonePermission: false,
      },
    ],
    /**
     * Faz 6: ana ekran / kilit ekranı widget'ları (modules/konum-widgets + targets/widgets). SIRA ÖNEMLİ:
     * konum-widgets eklentisi App Group'u (`group.${BUNDLE_ID}`) ios.entitlements'a zamanuyumlu yazar ve Android
     * widget sağlayıcı / hızlı paylaşım alıcısı / Hızlı Ayarlar kutucuğu kayıtlarını manifeste ekler;
     * @bacons/apple-targets ardından WidgetKit hedefini kurar (paket kimliği `${BUNDLE_ID}.widgets`, yalnızca bu
     * hedefte iOS 17.0; uygulamanın dağıtım hedefi değişmez). Takım kimliği `APPLE_TEAM_ID` [Varsayım: EAS'ta tanımlanır].
     */
    './modules/konum-widgets/app.plugin.js',
    ['@bacons/apple-targets', env('APPLE_TEAM_ID') ? { appleTeamId: env('APPLE_TEAM_ID') } : {}],
  ],
  experiments: {
    typedRoutes: false,
  },
  extra: {
    googleMapsKeysConfigured: GOOGLE_MAPS_IOS_API_KEY !== MISSING_KEY && GOOGLE_MAPS_ANDROID_API_KEY !== MISSING_KEY,
    /** JS tarafı (src/lib/linkConfig.ts) gelen bağlantıyı yalnızca bu alan adıyla kabul eder. */
    linkDomain: LINK_DOMAIN,
    /** Faz 3: OS hareket etkinliği kullanılsın mı (src/services/location/adaptive/activitySource.ts). */
    activityRecognition: ACTIVITY_RECOGNITION,
    /** Faz 4: iOS Critical Alerts izni istensin mi (src/lib/notificationConfig.ts). */
    iosCriticalAlerts: IOS_CRITICAL_ALERTS,
  },
});
