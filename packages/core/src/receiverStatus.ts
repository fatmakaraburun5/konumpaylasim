/**
 * Faz 3: alıcı tarafında "son doğrulanmış konum" ve bağlantı durumu (saf).
 *
 *  - Koordinat: doğruluğu ≤ 100 m olan EN SON ölçüm (yoksa en son ölçüm). Kötü doğruluklu bir hücre ölçümü
 *    iyi bir GPS noktasını ezmesin.
 *  - Durum: son paketin sunucuya ulaştığı andan (`server_ts`) bu yana geçen süre, gönderenin O ANKİ moduna
 *    göre beklenen aralıkla (`hb`) kıyaslanır. Sabit duran gönderen 15 dk'da bir paket atar: 10 dk sessizlik
 *    normaldir; araçtaki gönderen için 5 dk sessizlik "bağlantısı kopmuş olabilir" demektir.
 *      live              sessizlik ≤ 2·hb ve ölçüm ≤ 2 dk
 *      recent            sessizlik ≤ 2·hb, ölçüm daha eski (sabit/seyrek mod ya da kuyruktan gelen nokta)
 *      delayed           2·hb < sessizlik ≤ 4·hb
 *      offline_suspected 4·hb < sessizlik ≤ max(6 sa, 6·hb)
 *      stale             daha uzun
 *  - `hb` yoksa (Faz 1/2 göndereni) `DEFAULT_RECEIVER_HB_MS`.
 */
import { formatClock } from './format';
import { PACKET_LIMITS } from './packet';
import { HOUR, MINUTE, SECOND, type EpochMs, type OffsetFn, deviceOffset } from './time';

export type ReceiverStatus = 'live' | 'recent' | 'delayed' | 'offline_suspected' | 'stale';
export const RECEIVER_STATUSES: readonly ReceiverStatus[] = ['live', 'recent', 'delayed', 'offline_suspected', 'stale'];

/** [Varsayım] Faz 1 arka plan kalp atışı (5 dk) ile sabit (10 dk) arası. */
export const DEFAULT_RECEIVER_HB_MS = 10 * MINUTE;
/** Bu doğruluktan iyi ölçümler "doğrulanmış" sayılır. */
export const VERIFIED_ACCURACY_M = 100;
export const LIVE_FIX_AGE_MS = 2 * MINUTE;
export const STALE_AFTER_MS = 6 * HOUR;
/** Ağ titremesi payı. */
const GRACE_MS = 30 * SECOND;

/** Alıcının elindeki bir ölçüm (canlı düğüm ya da iz noktası). */
export interface ReceivedFix {
  lat: number;
  lng: number;
  accuracy: number;
  /** Ölçüm anı (sunucu saati). */
  timestamp: EpochMs;
  /** Sunucuya ulaştığı an. */
  server_ts: EpochMs;
  battery_pct: number | null;
  hb?: number | null;
  q?: 1 | null;
}

export interface LastVerifiedLocation {
  lat: number;
  lng: number;
  accuracy: number;
  /** Gösterilen koordinatın ölçüldüğü an. */
  recorded_at: EpochMs;
  /** En son paketteki pil (koordinattan daha yeni olabilir). */
  battery_pct: number | null;
  status: ReceiverStatus;
  /** "Son doğrulanmış konum · 14:05 · %42" */
  label: string;
  /** Durum cümlesi: "Canlı", "Bağlantısı kopmuş olabilir" … */
  statusText: string;
  /** Son paketten bu yana geçen süre. */
  silenceMs: number;
  /** Kullanılan beklenen aralık. */
  hbMs: number;
  /** Koordinat kuyruktan geldiyse true. */
  fromQueue: boolean;
}

export const RECEIVER_STATUS_TEXT: Record<ReceiverStatus, string> = {
  live: 'Canlı',
  recent: 'Güncel',
  delayed: 'Güncelleme gecikiyor',
  offline_suspected: 'Bağlantısı kopmuş olabilir',
  stale: 'Uzun süredir güncelleme yok',
};

export function effectiveHbMs(hb: number | null | undefined): number {
  if (typeof hb !== 'number' || !Number.isFinite(hb) || hb <= 0) return DEFAULT_RECEIVER_HB_MS;
  // Çok kısa hb ağ titremesinde gereksiz "gecikiyor" üretir: en az 1 dk.
  return Math.min(PACKET_LIMITS.maxHeartbeatMs, Math.max(MINUTE, hb));
}

export function receiverStatusOf(latest: Pick<ReceivedFix, 'timestamp' | 'server_ts' | 'hb'>, now: EpochMs): ReceiverStatus {
  const hb = effectiveHbMs(latest.hb);
  const silence = Math.max(0, now - latest.server_ts);
  if (silence > Math.max(STALE_AFTER_MS, 6 * hb)) return 'stale';
  if (silence > 4 * hb + GRACE_MS) return 'offline_suspected';
  if (silence > 2 * hb + GRACE_MS) return 'delayed';
  return now - latest.timestamp <= LIVE_FIX_AGE_MS ? 'live' : 'recent';
}

/**
 * `fixes`: alıcının bildiği ölçümler (sıra önemsiz). En yeni paket (server_ts) durumu ve pili belirler;
 * koordinat doğrulanmış en son ölçümden gelir.
 */
export function lastVerifiedLocation(
  fixes: readonly ReceivedFix[],
  now: EpochMs,
  offsetAt: OffsetFn = deviceOffset,
): LastVerifiedLocation | null {
  if (fixes.length === 0) return null;
  let latestPacket = fixes[0] as ReceivedFix;
  let latestFix = fixes[0] as ReceivedFix;
  let verified: ReceivedFix | null = null;
  for (const f of fixes) {
    if (f.server_ts > latestPacket.server_ts || (f.server_ts === latestPacket.server_ts && f.timestamp > latestPacket.timestamp)) latestPacket = f;
    if (f.timestamp > latestFix.timestamp) latestFix = f;
    if (f.accuracy <= VERIFIED_ACCURACY_M && (!verified || f.timestamp > verified.timestamp)) verified = f;
  }
  const shown = verified ?? latestFix;
  // "Canlı" yalnızca GÖSTERİLEN koordinat tazeyse (kötü doğruluklu taze hücre ölçümü eski GPS noktasını canlı yapmaz).
  const status = receiverStatusOf({ timestamp: shown.timestamp, server_ts: latestPacket.server_ts, hb: latestPacket.hb ?? null }, now);
  const battery = latestPacket.battery_pct ?? shown.battery_pct ?? null;
  return {
    lat: shown.lat,
    lng: shown.lng,
    accuracy: shown.accuracy,
    recorded_at: shown.timestamp,
    battery_pct: battery,
    status,
    label: lastVerifiedLabel(shown.timestamp, battery, offsetAt, status === 'live'),
    statusText: RECEIVER_STATUS_TEXT[status],
    silenceMs: Math.max(0, now - latestPacket.server_ts),
    hbMs: effectiveHbMs(latestPacket.hb),
    fromQueue: shown.q === 1,
  };
}

/** "Son doğrulanmış konum · 14:05 · %42" (canlıyken "Canlı · 14:05 · %42"). Pil bilinmiyorsa son parça yok. */
export function lastVerifiedLabel(at: EpochMs, batteryPct: number | null, offsetAt: OffsetFn = deviceOffset, live = false): string {
  const parts = [live ? 'Canlı' : 'Son doğrulanmış konum', formatClock(at, offsetAt)];
  if (batteryPct !== null && Number.isFinite(batteryPct)) parts.push(`%${Math.round(batteryPct)}`);
  return parts.join(' · ');
}

/** "Çevrimdışıyken kaydedilen 12 nokta eşitlendi" */
export function syncedPointsText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return `Çevrimdışıyken kaydedilen ${Math.round(count)} nokta eşitlendi`;
}

/** Düşük pil rozeti: "Pil %14" (yalnızca ≤ %15 iken). */
export function lowBatteryBadge(batteryPct: number | null, threshold = 15): string | null {
  if (batteryPct === null || !Number.isFinite(batteryPct) || batteryPct > threshold) return null;
  return `Pil %${Math.round(batteryPct)}`;
}
