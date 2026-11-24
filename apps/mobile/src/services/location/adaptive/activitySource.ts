/**
 * Faz 3: OS hareket etkinliği kaynağı (isteğe bağlı, yapılandırma bayrağı arkasında).
 *
 *  - Bayrak: app.config `extra.activityRecognition` (`KONUM_ACTIVITY_RECOGNITION=0` ile kapanır).
 *  - Yerel modül (modules/konum-activity) yoksa, izin verilmemişse ya da bayrak kapalıysa hiçbir olay üretilmez;
 *    core `motionReducer` yalnızca konum örneklerinden (hız + yer değiştirme) çıkarım yapar. Yani yedek yol
 *    AYRI bir kod değildir: aynı durum makinesinin OS girdisiz çalışmasıdır.
 *  - Olay zamanları cihaz saatindedir; hareket makinesi sunucu saatiyle çalışır (`offsetMs` eklenir).
 *  - Ara yedek (yalnızca iOS, yalnızca ön plan): yerel modül bağlı değilse expo-location 58
 *    `watchMotionActivityAsync` (derlenmiş, Expo bakımlı). Arka plan geçişleri için yerel modül gerekir.
 */
import type { MotionEvent } from '@konum/core';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import {
  getActivityPermission,
  getLastActivity,
  isActivityModuleAvailable,
  requestActivityPermission,
  startActivityUpdates,
  type ActivityPermission,
  type NativeActivityEvent,
} from '../../../../modules/konum-activity';

let flagOverride: boolean | null = null;

/** Testler için bayrağı zorlar (null = yapılandırmadan oku). */
export function __setActivityFlagForTests(v: boolean | null): void {
  flagOverride = v;
}

export function activityRecognitionEnabled(): boolean {
  if (flagOverride !== null) return flagOverride;
  const extra = (Constants.expoConfig?.extra ?? {}) as { activityRecognition?: unknown };
  return extra.activityRecognition === true;
}

/** Bayrak açık ve yerel modül bağlı mı. */
export function activityRecognitionUsable(): boolean {
  return activityRecognitionEnabled() && isActivityModuleAvailable();
}

export function toMotionActivityEvent(e: NativeActivityEvent, offsetMs: number): Extract<MotionEvent, { type: 'activity' }> {
  return { type: 'activity', activity: e.type, confidence: e.confidence, at: e.at + offsetMs };
}

/** Son OS etkinliği (Android: başsız uyanışta da). Kullanılamıyorsa null. */
export function lastActivityEvent(offsetMs: number): Extract<MotionEvent, { type: 'activity' }> | null {
  if (!activityRecognitionUsable()) return null;
  const e = getLastActivity();
  return e ? toMotionActivityEvent(e, offsetMs) : null;
}

const fromExpoPermission = (r: { granted?: boolean; status?: string; canAskAgain?: boolean }): ActivityPermission =>
  r.granted || r.status === 'granted' ? 'granted' : r.status === 'denied' ? 'denied' : 'undetermined';

/** Hareket izni (yerel modül, yoksa iOS'ta expo-location). Kullanılamıyorsa 'restricted'. */
export async function activityPermission(): Promise<ActivityPermission> {
  if (!activityRecognitionEnabled()) return 'restricted';
  if (isActivityModuleAvailable()) return getActivityPermission();
  if (Platform.OS !== 'ios' || typeof Location.getMotionActivityPermissionsAsync !== 'function') return 'restricted';
  try {
    return fromExpoPermission(await Location.getMotionActivityPermissionsAsync());
  } catch {
    return 'restricted';
  }
}

export async function askActivityPermission(): Promise<ActivityPermission> {
  if (!activityRecognitionEnabled()) return 'restricted';
  if (isActivityModuleAvailable()) return requestActivityPermission();
  if (Platform.OS !== 'ios' || typeof Location.requestMotionActivityPermissionsAsync !== 'function') return 'restricted';
  try {
    return fromExpoPermission(await Location.requestMotionActivityPermissionsAsync());
  } catch {
    return 'restricted';
  }
}

const EXPO_PRIORITY: readonly [string, NativeActivityEvent['type']][] = [
  ['automotive', 'automotive'],
  ['cycling', 'cycling'],
  ['running', 'running'],
  ['walking', 'walking'],
  ['stationary', 'still'],
];

/** expo-location `MotionActivityObject` → olay (algılanan en "hızlı" etkinlik). */
export function fromExpoMotionActivity(o: { activities?: Record<string, { detected?: boolean; confidence?: number }>; timestamp?: number }): NativeActivityEvent | null {
  const acts = o.activities ?? {};
  for (const [key, type] of EXPO_PRIORITY) {
    const a = acts[key];
    if (!a?.detected) continue;
    const confidence = a.confidence === 2 ? 'high' : a.confidence === 1 ? 'medium' : 'low';
    const at = Number(o.timestamp);
    return { type, confidence, at: Number.isFinite(at) && at > 0 ? Math.round(at) : Date.now() };
  }
  return null;
}

/** Canlı olaylar (JS ayaktayken). İzin yoksa / modül yoksa null. */
export async function subscribeActivity(onEvent: (e: NativeActivityEvent) => void): Promise<(() => void) | null> {
  if (!activityRecognitionEnabled()) return null;
  if (isActivityModuleAvailable()) {
    if ((await getActivityPermission()) !== 'granted') return null;
    return startActivityUpdates(onEvent);
  }
  // Ara yedek: iOS ön plan (expo-location). İzin istemez; yalnızca verilmişse abone olur.
  if (Platform.OS !== 'ios' || typeof Location.watchMotionActivityAsync !== 'function') return null;
  try {
    const perm = await Location.getMotionActivityPermissionsAsync();
    if (!perm.granted) return null;
    const sub = await Location.watchMotionActivityAsync((o) => {
      const e = fromExpoMotionActivity(o as unknown as Parameters<typeof fromExpoMotionActivity>[0]);
      if (e) onEvent(e);
    });
    return () => sub.remove();
  } catch {
    return null;
  }
}
