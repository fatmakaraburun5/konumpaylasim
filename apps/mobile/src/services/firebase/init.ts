/**
 * Firebase başlatma. Uygulama ön planda da, arka plan konum görevinde (başsız JS bağlamı) de
 * İLK Firebase çağrısından önce `ensureFirebase()` çalışmalıdır: idempotenttir.
 *
 * Sıra:
 * 1. App Check: Android Play Integrity, iOS App Attest (DeviceCheck yedeği); geliştirmede debug sağlayıcı.
 *    Backend App Check'i Firestore, RTDB ve callable'larda zorunlu tutar; bu yüzden korunan HİÇBİR
 *    servis (RTDB örneği dahil) App Check'ten önce oluşturulmaz. RNFB 27 `initializeAppCheck` senkron
 *    döner, yerel sağlayıcı arka planda kurulur: ilk token kısa bir süre beklenir, yoksa ilk istekler
 *    token'sız gider ve zorlamada reddedilirdi.
 * 2. RTDB disk kalıcılığı KAPALI (gizlilik): bir arkadaşın konumu diske yazılmaz, `child_removed`
 *    ile bellekten silinir. Bu ayar veritabanı ilk kullanılmadan önce yapılmalıdır.
 * 3. Geliştirmede emülatörler.
 */
import { getApp } from '@react-native-firebase/app';
import {
  getToken as getAppCheckToken,
  initializeAppCheck,
  ReactNativeFirebaseAppCheckProvider,
  type AppCheck,
} from '@react-native-firebase/app-check';
import { connectAuthEmulator, getAuth } from '@react-native-firebase/auth';
import { connectDatabaseEmulator, getDatabase, setPersistenceEnabled } from '@react-native-firebase/database';
import { connectFirestoreEmulator, getFirestore } from '@react-native-firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from '@react-native-firebase/functions';

/** Cloud Functions bölgesi (backend: europe-west1). */
export const FUNCTIONS_REGION = 'europe-west1';

let ready: Promise<void> | null = null;

export function ensureFirebase(): Promise<void> {
  if (!ready) ready = init();
  return ready;
}

/** [Varsayım] İlk App Check token'ı için toplam bekleme üst sınırı (çevrimdışı açılış bunu aşmasın). */
const APP_CHECK_READY_BUDGET_MS = 3_000;
const APP_CHECK_ATTEMPT_TIMEOUT_MS = 1_500;
const APP_CHECK_RETRY_GAP_MS = 300;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sağlayıcı hazır olana (ilk token alınana) kadar kısa süre bekle; hata ya da süre aşımı yok sayılır. */
async function waitForAppCheck(appCheck: AppCheck): Promise<void> {
  const deadline = Date.now() + APP_CHECK_READY_BUDGET_MS;
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    const ok = await Promise.race([
      getAppCheckToken(appCheck).then(
        () => true,
        () => false,
      ),
      delay(Math.min(APP_CHECK_ATTEMPT_TIMEOUT_MS, left)).then(() => false),
    ]);
    if (ok) return;
    await delay(APP_CHECK_RETRY_GAP_MS);
  }
  if (__DEV__) console.warn('[konum] App Check token süresinde alınamadı; istekler token yenilenince korunur');
}

async function init(): Promise<void> {
  const app = getApp();

  // 1) App Check: korunan servislerden önce.
  const debugToken = process.env.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN || undefined;
  const provider = new ReactNativeFirebaseAppCheckProvider();
  provider.configure({
    android: { provider: __DEV__ ? 'debug' : 'playIntegrity', debugToken },
    // [Varsayım: doğrulanmalı] App Attest iOS 14+; eski cihazlarda DeviceCheck yedeği.
    apple: { provider: __DEV__ ? 'debug' : 'appAttestWithDeviceCheckFallback', debugToken },
  });
  let appCheck: AppCheck | null = null;
  try {
    appCheck = initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
  } catch (e) {
    if (__DEV__) console.warn('[konum] App Check başlatılamadı', e);
  }
  if (appCheck) await waitForAppCheck(appCheck);

  // 2) RTDB kalıcılığı: başka hiçbir veritabanı çağrısından önce.
  try {
    await setPersistenceEnabled(getDatabase(app), false);
  } catch (e) {
    // Veritabanı bu süreçte zaten kullanıldıysa ayar değiştirilemez; yerel varsayılan da kapalıdır.
    if (__DEV__) console.warn('[konum] RTDB persistence ayarlanamadı', e);
  }

  // 3) Geliştirme: Local Emulator Suite
  if (__DEV__ && process.env.EXPO_PUBLIC_USE_EMULATORS === '1') {
    const host = process.env.EXPO_PUBLIC_EMULATOR_HOST || 'localhost';
    connectAuthEmulator(getAuth(app), `http://${host}:9099`);
    connectFirestoreEmulator(getFirestore(app), host, 8080);
    connectDatabaseEmulator(getDatabase(app), host, 9000);
    connectFunctionsEmulator(getFunctions(app, FUNCTIONS_REGION), host, 5001);
  }
}
