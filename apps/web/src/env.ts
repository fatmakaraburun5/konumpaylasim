/**
 * Derleme zamanı yapılandırması (Vite `VITE_*` değişkenleri). Hepsi istemciye gömülür: burada
 * SIR OLMAZ. Firebase web yapılandırması ve HTTP referrer kısıtlı Maps JS anahtarı herkese açıktır.
 */

export interface FirebaseWebConfig {
  apiKey?: string;
  appId?: string;
  projectId: string;
  databaseURL: string;
  /** Emülatör kullanılıyorsa `host:port`. */
  emulator: { host: string; port: number } | null;
}

export interface WebConfig {
  /** Firebase yapılandırması eksikse null (sayfa "Konum şu an alınamıyor" gösterir). */
  firebase: FirebaseWebConfig | null;
  /** Google Maps JavaScript API anahtarı (HTTP referrer kısıtlı). Yoksa yedek harita. */
  mapsKey: string | null;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
}

type Env = Record<string, string | boolean | undefined>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Emülatör ad alanı: backend/.firebaserc → database hedefi `live` → `demo-konum`. */
export const EMULATOR_NAMESPACE_DEFAULT = 'demo-konum';
export const EMULATOR_HOST_DEFAULT = '127.0.0.1:9000';

function parseHostPort(v: string): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(v.trim());
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1] as string, port } : null;
}

/** Saf: testlerde sahte `env` ile çağrılır. */
export function readConfig(env: Env): WebConfig {
  let firebase: FirebaseWebConfig | null = null;
  const useEmulators = str(env.VITE_USE_EMULATORS) === '1';
  if (useEmulators) {
    const ns = str(env.VITE_RTDB_NAMESPACE) ?? EMULATOR_NAMESPACE_DEFAULT;
    const emulator = parseHostPort(str(env.VITE_RTDB_EMULATOR_HOST) ?? EMULATOR_HOST_DEFAULT);
    if (emulator) {
      firebase = {
        projectId: str(env.VITE_FIREBASE_PROJECT_ID) ?? ns,
        // Ad alanı alt alan adından okunur; bağlantı connectDatabaseEmulator ile emülatöre gider.
        databaseURL: `https://${ns}.firebaseio.com`,
        emulator,
      };
    }
  } else {
    const databaseURL = str(env.VITE_FIREBASE_DATABASE_URL);
    const projectId = str(env.VITE_FIREBASE_PROJECT_ID);
    if (databaseURL && projectId && /^https:\/\//.test(databaseURL)) {
      firebase = {
        apiKey: str(env.VITE_FIREBASE_API_KEY) ?? undefined,
        appId: str(env.VITE_FIREBASE_APP_ID) ?? undefined,
        projectId,
        databaseURL,
        emulator: null,
      };
    }
  }

  return {
    firebase,
    mapsKey: str(env.VITE_GOOGLE_MAPS_WEB_KEY),
    appStoreUrl: httpsOrNull(env.VITE_APP_STORE_URL),
    playStoreUrl: httpsOrNull(env.VITE_PLAY_STORE_URL),
  };
}

function httpsOrNull(v: unknown): string | null {
  const s = str(v);
  return s && /^https:\/\/[^\s]+$/.test(s) ? s : null;
}

export const config: WebConfig = readConfig(import.meta.env as unknown as Env);
