/**
 * Web demo: OS hareket etkinliği kaynağı (native `activitySource.ts` ile aynı dışa aktarımlar). Yerel modül yerine
 * simüle telefon (demo/web/device.ts): demo panelindeki "Masada bekle" / "Yürümeye başla" / "Araca bin" birer
 * yüksek güvenli etkinlik olayı üretir. Hareket izni simüledir (demo/web/permissions.ts); izin yoksa olay yoktur ve
 * core `motionReducer` yalnızca hız / yer değiştirmeyle karar verir (native yedek yoluyla aynı).
 */
import type { MotionEvent } from '@konum/core';
import type { ActivityPermission, NativeActivityEvent } from '../../../../modules/konum-activity';
import { lastDemoActivity, onDemoActivity } from '../../../demo/web/device';
import { demoPerms, requestDemoPermission } from '../../../demo/web/permissions';

let flagOverride: boolean | null = null;

export function __setActivityFlagForTests(v: boolean | null): void {
  flagOverride = v;
}

/** Web demoda bayrak her zaman açık (izin ayrı simüle edilir). */
export function activityRecognitionEnabled(): boolean {
  return flagOverride ?? true;
}

export function activityRecognitionUsable(): boolean {
  return activityRecognitionEnabled() && demoPerms().motion === 'granted';
}

export function toMotionActivityEvent(e: NativeActivityEvent, offsetMs: number): Extract<MotionEvent, { type: 'activity' }> {
  return { type: 'activity', activity: e.type, confidence: e.confidence, at: e.at + offsetMs };
}

export function lastActivityEvent(offsetMs: number): Extract<MotionEvent, { type: 'activity' }> | null {
  if (!activityRecognitionUsable()) return null;
  const e = lastDemoActivity();
  return e ? toMotionActivityEvent(e, offsetMs) : null;
}

export async function activityPermission(): Promise<ActivityPermission> {
  if (!activityRecognitionEnabled()) return 'restricted';
  return demoPerms().motion;
}

export async function askActivityPermission(): Promise<ActivityPermission> {
  if (!activityRecognitionEnabled()) return 'restricted';
  return requestDemoPermission('motion');
}

/** Native ile aynı imza (web'de expo-location hareket API'si yok; kullanılmaz). */
export function fromExpoMotionActivity(_o: { activities?: Record<string, { detected?: boolean; confidence?: number }>; timestamp?: number }): NativeActivityEvent | null {
  return null;
}

/** Abonelik izin verilmeden de kurulur: simüle telefon olayı yalnızca hareket izni varken üretir (izin sonradan verilebilir). */
export async function subscribeActivity(onEvent: (e: NativeActivityEvent) => void): Promise<(() => void) | null> {
  if (!activityRecognitionEnabled()) return null;
  return onDemoActivity((e) => onEvent({ type: e.type, confidence: e.confidence, at: e.at }));
}
