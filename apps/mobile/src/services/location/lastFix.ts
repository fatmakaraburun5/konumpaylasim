/**
 * Faz 9: son doğrulanmış konum (`konum.bg.lastFix.v1`) — çevrimdışı SOS SMS'i ve Güvenli Dönüş için.
 *
 *  - Yalnızca güvenilir ölçüm (`accuracy ≤ VERIFIED_ACCURACY_M`, 100 m) yazılır; daha eski ölçüm yenisini ezmez.
 *  - Paylaşım olmasa da yazılır: konum hattı (arka plan / nabız, hedef denetiminden ÖNCE) ve ön plan izleyicisi
 *    (f9Services → locationStore) çağırır. Diske en sık `MIN_WRITE_INTERVAL_MS`'de bir (doğruluk belirgin iyileşirse
 *    hemen); pil ayrıca okunur.
 *  - Çıkışta `clearBackgroundState` siler. Sunucuya GİTMEZ (yalnızca kullanıcının kendi SMS'inde).
 */
import { batteryPct, VERIFIED_ACCURACY_M, type DeviceStatus, type EpochMs, type RawLocationSample, type UserId } from '@konum/core';
import { loadLastFix, saveLastFix, type PersistedLastFix } from '../../state/persist';
import { readDeviceStatus } from './deviceStatus';

/** [Varsayım] Disk yazma aralığı (her GPS örneği diske gitmesin). */
export const LAST_FIX_MIN_WRITE_INTERVAL_MS = 15_000;

export interface LastFixDeps {
  load: () => Promise<PersistedLastFix | null>;
  save: (v: PersistedLastFix) => Promise<void>;
  device: () => Promise<DeviceStatus>;
}

const defaultDeps: LastFixDeps = { load: loadLastFix, save: saveLastFix, device: readDeviceStatus };

/** Ham örnek → son doğrulanmış konum adayı (sunucu saati). Güvenilir değilse null. Saf. */
export function toLastFixCandidate(
  raw: Pick<RawLocationSample, 'latitude' | 'longitude' | 'accuracy' | 'timestamp'>,
  offsetMs: number,
): Pick<PersistedLastFix, 'lat' | 'lng' | 'accuracy' | 'timestamp'> | null {
  const acc = raw.accuracy;
  if (typeof acc !== 'number' || !Number.isFinite(acc) || acc < 0 || acc > VERIFIED_ACCURACY_M) return null;
  if (!Number.isFinite(raw.latitude) || !Number.isFinite(raw.longitude) || Math.abs(raw.latitude) > 90 || Math.abs(raw.longitude) > 180) return null;
  return { lat: raw.latitude, lng: raw.longitude, accuracy: Math.round(acc * 10) / 10, timestamp: Math.round(raw.timestamp + offsetMs) };
}

/** Yeni aday yazılmalı mı? (daha yeni; ve aralık doldu ya da doğruluk belirgin iyileşti). Saf. */
export function shouldWriteLastFix(prev: Pick<PersistedLastFix, 'timestamp' | 'accuracy'> | null, next: Pick<PersistedLastFix, 'timestamp' | 'accuracy'>): boolean {
  if (!prev) return true;
  if (next.timestamp <= prev.timestamp) return false;
  if (next.timestamp - prev.timestamp >= LAST_FIX_MIN_WRITE_INTERVAL_MS) return true;
  return next.accuracy < prev.accuracy * 0.6;
}

/** Ölçümü (güvenilirse) son doğrulanmış konum olarak kaydeder. Hata yutulur. */
export async function recordLastFix(
  raw: Pick<RawLocationSample, 'latitude' | 'longitude' | 'accuracy' | 'timestamp'>,
  offsetMs: number,
  uid: UserId | null,
  deps: LastFixDeps = defaultDeps,
): Promise<boolean> {
  try {
    const cand = toLastFixCandidate(raw, offsetMs);
    if (!cand) return false;
    const prev = await deps.load().catch(() => null);
    if (!shouldWriteLastFix(prev, cand)) return false;
    const d = await deps.device().catch(() => ({ batteryLevel: null, isCharging: null }) as DeviceStatus);
    const pct = batteryPct(d.batteryLevel);
    await deps.save({ uid: uid ?? prev?.uid ?? null, ...cand, battery_pct: pct === null ? null : Math.round(pct), is_charging: pct === null ? null : d.isCharging });
    return true;
  } catch {
    return false;
  }
}

/** Son doğrulanmış konum (yoksa ya da başka hesabınsa null). */
export async function getLastFix(uid?: UserId | null): Promise<PersistedLastFix | null> {
  const v = await loadLastFix().catch(() => null);
  if (!v) return null;
  if (uid && v.uid && v.uid !== uid) return null;
  return v;
}

/** Yaş (ms) — `now` sunucu saati. */
export const lastFixAgeMs = (fix: Pick<PersistedLastFix, 'timestamp'>, now: EpochMs): number => Math.max(0, now - fix.timestamp);
