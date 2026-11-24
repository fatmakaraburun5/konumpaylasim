/**
 * Faz 3: yerel hareket etkinliği modülünün JS sarmalayıcısı (modules/konum-activity).
 *
 *  - iOS: CMMotionActivityManager (ios/KonumActivityModule.swift)
 *  - Android: Activity Recognition Transition API (android/.../KonumActivityModule.kt)
 *
 * Yerel modül derlenmemiş / bağlanmamışsa (Expo Go, web, jest, bu modülsüz eski derleme) `requireOptionalNativeModule`
 * null döner: tüm işlevler güvenli varsayılan değerleri verir ve çağıran hız/yer değiştirme çıkarımına düşer.
 * [Varsayım] Yerel kod bu ortamda derlenmedi (Xcode / Android SDK yok).
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeActivityType = 'still' | 'walking' | 'running' | 'cycling' | 'automotive' | 'unknown';
export type NativeActivityConfidence = 'low' | 'medium' | 'high';
export type ActivityPermission = 'granted' | 'denied' | 'undetermined' | 'restricted';

export interface NativeActivityEvent {
  type: NativeActivityType;
  confidence: NativeActivityConfidence;
  /** Cihaz saati (ms). */
  at: number;
}

interface Subscription {
  remove: () => void;
}

interface KonumActivityNative {
  isAvailable: () => boolean;
  getPermissionStatusAsync: () => Promise<unknown>;
  requestPermissionAsync: () => Promise<unknown>;
  startAsync: () => Promise<boolean>;
  stopAsync: () => Promise<void>;
  getLastActivity: () => unknown;
  addListener: (event: 'onActivity', cb: (e: unknown) => void) => Subscription;
}

let native: KonumActivityNative | null | undefined;
function mod(): KonumActivityNative | null {
  if (native === undefined) {
    try {
      native = requireOptionalNativeModule<KonumActivityNative>('KonumActivity');
    } catch {
      native = null;
    }
  }
  return native;
}

/** Testler için yerel modülü değiştirir (null = yok). */
export function __setNativeActivityModuleForTests(m: KonumActivityNative | null | undefined): void {
  native = m;
}

const TYPES = new Set<NativeActivityType>(['still', 'walking', 'running', 'cycling', 'automotive', 'unknown']);
const CONF = new Set<NativeActivityConfidence>(['low', 'medium', 'high']);

/** Yerelden gelen değeri doğrular (bozuk/eksik olay yok sayılır). */
export function parseActivityEvent(v: unknown): NativeActivityEvent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const type = o.type as NativeActivityType;
  const confidence = o.confidence as NativeActivityConfidence;
  const at = Number(o.at);
  if (!TYPES.has(type) || !CONF.has(confidence) || !Number.isFinite(at) || at <= 0) return null;
  return { type, confidence, at: Math.round(at) };
}

function parsePermission(v: unknown): ActivityPermission {
  const s = typeof v === 'string' ? v : v && typeof v === 'object' ? String((v as { status?: unknown }).status ?? '') : '';
  return s === 'granted' || s === 'denied' || s === 'restricted' ? s : 'undetermined';
}

export function isActivityModuleAvailable(): boolean {
  const m = mod();
  if (!m) return false;
  try {
    return m.isAvailable();
  } catch {
    return false;
  }
}

export async function getActivityPermission(): Promise<ActivityPermission> {
  const m = mod();
  if (!m) return 'restricted';
  try {
    return parsePermission(await m.getPermissionStatusAsync());
  } catch {
    return 'restricted';
  }
}

export async function requestActivityPermission(): Promise<ActivityPermission> {
  const m = mod();
  if (!m) return 'restricted';
  try {
    return parsePermission(await m.requestPermissionAsync());
  } catch {
    return 'restricted';
  }
}

/** Güncellemeleri başlatır; dinleyici aboneliği döner (modül yoksa ya da izin yoksa null). */
export async function startActivityUpdates(onEvent: (e: NativeActivityEvent) => void): Promise<(() => void) | null> {
  const m = mod();
  if (!m || !isActivityModuleAvailable()) return null;
  let sub: Subscription | null = null;
  try {
    sub = m.addListener('onActivity', (raw) => {
      const e = parseActivityEvent(raw);
      if (e) onEvent(e);
    });
    const ok = await m.startAsync();
    if (!ok) {
      sub.remove();
      return null;
    }
  } catch {
    sub?.remove();
    return null;
  }
  return () => {
    sub?.remove();
    void m.stopAsync().catch(() => undefined);
  };
}

/** Son bilinen etkinlik (Android: başsız uyanışta da SharedPreferences'tan). */
export function getLastActivity(): NativeActivityEvent | null {
  const m = mod();
  if (!m) return null;
  try {
    return parseActivityEvent(m.getLastActivity());
  } catch {
    return null;
  }
}
