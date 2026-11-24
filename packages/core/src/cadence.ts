/**
 * Konum toplama sıklığı (takip profili) ve yayın kapısı.
 * Faz 1: uygulama durumu + hızdan çıkarılan aktiviteye göre üç profil.
 * Faz 3: hareket sensörü, düşük pil ve çevrimdışı kuyruk bu modüle eklenir (aynı arayüz).
 */
import { haversineM } from './geo';
import type { ActivityState, NormalizedSample } from './packet';
import { MINUTE, SECOND, type EpochMs } from './time';

export type AppPhase = 'foreground' | 'background';

export type TrackingProfileId = 'off' | 'live_foreground' | 'live_background' | 'still_background' | 'low_battery';

export interface TrackingProfile {
  id: TrackingProfileId;
  /** İşletim sisteminden istenen en kısa aralık. */
  timeIntervalMs: number;
  /** Bu kadar yer değiştirmeden yeni örnek isteme. */
  distanceFilterM: number;
  accuracy: 'high' | 'balanced' | 'low';
  /** Hiç hareket olmasa da en geç bu aralıkla paket gönder (alıcı "canlı mı" anlasın). */
  heartbeatMs: number;
}

/** [Varsayım] Faz 1 değerleri; sahada pil ölçümüyle ayarlanacak. */
export const TRACKING_PROFILES: Record<TrackingProfileId, TrackingProfile> = {
  off: { id: 'off', timeIntervalMs: 0, distanceFilterM: 0, accuracy: 'low', heartbeatMs: 0 },
  live_foreground: { id: 'live_foreground', timeIntervalMs: 5 * SECOND, distanceFilterM: 10, accuracy: 'high', heartbeatMs: MINUTE },
  live_background: { id: 'live_background', timeIntervalMs: 30 * SECOND, distanceFilterM: 25, accuracy: 'balanced', heartbeatMs: 5 * MINUTE },
  still_background: { id: 'still_background', timeIntervalMs: 2 * MINUTE, distanceFilterM: 50, accuracy: 'balanced', heartbeatMs: 10 * MINUTE },
  low_battery: { id: 'low_battery', timeIntervalMs: 2 * MINUTE, distanceFilterM: 100, accuracy: 'low', heartbeatMs: 15 * MINUTE },
};

export const LOW_BATTERY_PCT = 15;

export interface TrackingInput {
  hasActiveOutgoingShare: boolean;
  appPhase: AppPhase;
  activity: ActivityState;
  batteryPct: number | null;
  isCharging: boolean | null;
}

export function selectTrackingProfile(input: TrackingInput): TrackingProfile {
  if (!input.hasActiveOutgoingShare) return TRACKING_PROFILES.off;
  const lowBattery = input.batteryPct !== null && input.batteryPct <= LOW_BATTERY_PCT && input.isCharging !== true;
  if (lowBattery && input.appPhase === 'background') return TRACKING_PROFILES.low_battery;
  if (input.appPhase === 'foreground') return TRACKING_PROFILES.live_foreground;
  return input.activity === 'still' ? TRACKING_PROFILES.still_background : TRACKING_PROFILES.live_background;
}

export interface LastPublished {
  lat: number;
  lng: number;
  sent_at: EpochMs;
  battery_pct: number | null;
  activity: ActivityState;
}

export type PublishDecision =
  | { publish: true; reason: 'first' | 'moved' | 'heartbeat' | 'activity_changed' | 'battery_changed' | 'targets_changed' }
  | { publish: false; reason: 'too_soon' | 'not_moved' | 'tracking_off' };

/**
 * Yeni örnek yayınlanmalı mı? Gereksiz yazmaları keser: pil ve RTDB bant genişliği.
 * `targetsChanged`: yeni alıcı eklendi / süre uzatıldı → hemen gönder.
 */
export function shouldPublish(
  last: LastPublished | null,
  next: { sample: NormalizedSample; battery_pct: number | null; activity: ActivityState },
  profile: TrackingProfile,
  now: EpochMs,
  targetsChanged = false,
): PublishDecision {
  if (profile.id === 'off') return { publish: false, reason: 'tracking_off' };
  if (!last) return { publish: true, reason: 'first' };
  if (targetsChanged) return { publish: true, reason: 'targets_changed' };
  const elapsed = now - last.sent_at;
  if (elapsed >= profile.heartbeatMs) return { publish: true, reason: 'heartbeat' };
  // İşletim sistemi aralığa tam uymaz; %80'den erken gelen örnekleri atla.
  if (elapsed < profile.timeIntervalMs * 0.8) return { publish: false, reason: 'too_soon' };
  if (next.activity !== last.activity) return { publish: true, reason: 'activity_changed' };
  if (crossedBatteryThreshold(last.battery_pct, next.battery_pct)) return { publish: true, reason: 'battery_changed' };
  const moved = haversineM(last, next.sample);
  // Doğruluk dairesinin içindeki "titreme" hareket sayılmaz.
  const threshold = Math.max(profile.distanceFilterM, Math.min(next.sample.accuracy, 100));
  return moved >= threshold ? { publish: true, reason: 'moved' } : { publish: false, reason: 'not_moved' };
}

function crossedBatteryThreshold(prev: number | null, next: number | null): boolean {
  if (prev === null || next === null) return prev !== next;
  if (Math.abs(prev - next) >= 5) return true;
  return (prev > LOW_BATTERY_PCT) !== (next > LOW_BATTERY_PCT);
}
