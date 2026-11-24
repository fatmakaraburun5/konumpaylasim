/**
 * Faz 3: core `TRACKING_MATRIX` satırı → expo-location arka plan görevi seçenekleri.
 *
 * Eşleme (core `trackingMatrix.ts` başlığıyla aynı):
 *  - gps 'high'     → Accuracy.High     (iOS kCLLocationAccuracyNearestTenMeters, Android PRIORITY_HIGH_ACCURACY)
 *  - gps 'balanced' → Accuracy.Balanced (iOS HundredMeters, Android BALANCED_POWER_ACCURACY)
 *  - gps 'low'      → Accuracy.Low      (iOS Kilometer, Android BALANCED_POWER_ACCURACY — expo-location 58 eşlemesi)
 *  - gps 'off'      → Accuracy.Lowest   "uyku / canlı tutma": GNSS yok (iOS ThreeKilometers = hücre/Wi-Fi,
 *                     Android PRIORITY_LOW_POWER). Sürekli güncelleme TAMAMEN durdurulmaz: Android'de ön plan
 *                     servisi (FGS) arka planda yeniden BAŞLATILAMAZ (expo-location `ForegroundServiceStartNotAllowedException`),
 *                     iOS'ta konum oturumu kapanırsa uygulama askıya alınır ve kalp atışı zamanlayıcısı çalışmaz.
 *                     Bu yüzden uyku = düşük güçlü, seyrek (kalp atışı aralığında) istek + uyku çiti.
 *                     [Varsayım: cihazda pil ölçümüyle doğrulanmalı]
 *  - osIntervalMs   → timeInterval (Android; iOS yok sayar). 0 ise kalp atışı aralığı.
 *  - distanceFilterM→ distanceInterval. Android'de 0 (nabız için zaman tabanlı, mesafe kapısı JS'te
 *                     `shouldPublish`); iOS'ta satır mesafesi (iOS zaman aralığı desteklemez).
 *  - deferMs        → deferredUpdatesInterval (+ deferredUpdatesDistance = mesafe filtresi). iOS toplu teslim,
 *                     Android expo-location kendi tamponu (yalnızca uygulama arka plandayken).
 *  - iOS activityType hareket durumuna göre; `pausesUpdatesAutomatically: false` (iOS duraklatırsa yeniden
 *    başlatacak kod çalışmaz; uyku zaten düşük doğrulukla yapılıyor); mavi gösterge açık.
 */
import type { EpochMs, MotionState, TrackingPlanRow } from '@konum/core';
import * as Location from 'expo-location';
import { untilClock } from '../../../lib/turkish';
import { lightColors } from '../../../ui/tokens';

export const FOREGROUND_SERVICE_PREFIX = 'Konumun paylaşılıyor';

const ACCURACY: Record<TrackingPlanRow['gps'], Location.LocationAccuracy> = {
  high: Location.Accuracy.High,
  balanced: Location.Accuracy.Balanced,
  low: Location.Accuracy.Low,
  off: Location.Accuracy.Lowest,
};

/** iOS CLActivityType: hareket durumuna göre (iOS otomatik duraklatma ve sinyal filtresi buna bakar). */
export function activityTypeFor(motion: MotionState): Location.LocationActivityType {
  switch (motion) {
    case 'walking':
    case 'running':
    case 'cycling':
      return Location.ActivityType.Fitness;
    case 'driving':
    case 'fast':
      return Location.ActivityType.AutomotiveNavigation;
    default:
      return Location.ActivityType.Other;
  }
}

/** GPS kapalı satırda (uyku) seyrek istek aralığı: kalp atışı ama en az 1 dk. */
const sleepIntervalMs = (row: TrackingPlanRow) => Math.max(60_000, row.heartbeatMs || 15 * 60_000);

/** Sürekli istek aralığı (Android `timeInterval`). */
export function effectiveIntervalMs(row: TrackingPlanRow): number {
  return row.osIntervalMs > 0 ? row.osIntervalMs : sleepIntervalMs(row);
}

/** Ön plan servisi bildirimi başlığı: "Konumun paylaşılıyor · 14:45'e kadar" ya da "… · Süresiz". */
export function serviceTitleFor(expiries: readonly (EpochMs | null)[]): string {
  if (expiries.length === 0) return FOREGROUND_SERVICE_PREFIX;
  if (expiries.some((e) => e === null)) return `${FOREGROUND_SERVICE_PREFIX} · Süresiz`;
  return `${FOREGROUND_SERVICE_PREFIX} · ${untilClock(Math.max(...(expiries as EpochMs[])))}`;
}

/** "2 kişiyle", "QR bağlantısıyla", "2 kişiyle + QR bağlantısı". */
export function audienceText(receivers: number, links: number): string {
  if (links === 0) return `${receivers} kişiyle`;
  const l = links === 1 ? 'QR bağlantısı' : `${links} QR bağlantısı`;
  if (receivers === 0) return links === 1 ? 'QR bağlantısıyla' : `${links} QR bağlantısıyla`;
  return `${receivers} kişiyle + ${l}`;
}

/** Bildirim gövdesine eklenecek mod ipucu (kullanıcı pilin neden az gittiğini görsün). */
export function modeHint(row: TrackingPlanRow, motion: MotionState): string | null {
  if (row.significantChanges && row.gps === 'off') return 'Pil kritik: yalnızca önemli konum değişiklikleri';
  if (row.gps === 'off' || motion === 'stationary') return 'Hareketsiz: pil tasarrufu';
  return null;
}

export interface ServiceNotification {
  title: string;
  body: string;
}

export function toPlanTaskOptions(
  row: TrackingPlanRow,
  motion: MotionState,
  notification: ServiceNotification,
  platform: 'ios' | 'android' | string,
): Location.LocationTaskOptions {
  const sleeping = row.gps === 'off';
  const distance = sleeping ? Math.max(row.distanceFilterM, 100) : row.distanceFilterM;
  const opts: Location.LocationTaskOptions = {
    accuracy: ACCURACY[row.gps],
    timeInterval: effectiveIntervalMs(row),
    distanceInterval: platform === 'android' ? 0 : distance,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: activityTypeFor(motion),
    foregroundService: {
      notificationTitle: notification.title,
      notificationBody: notification.body,
      notificationColor: lightColors.primary,
      // Kullanıcı uygulamayı son uygulamalardan kaydırsa da paylaşım sürsün (OEM izin verirse).
      killServiceOnDestroy: false,
    },
  };
  if (row.deferMs > 0) {
    opts.deferredUpdatesInterval = row.deferMs;
    opts.deferredUpdatesDistance = row.distanceFilterM;
  }
  return opts;
}

/**
 * Uygulanan seçeneklerin anahtarı: aynı anahtar = OS isteğini yeniden başlatmaya gerek yok.
 * Bildirim metni anahtarda: Android'de metin ancak yeniden kayıtla güncellenir.
 */
export function planApplyKey(row: TrackingPlanRow, motion: MotionState, notification: ServiceNotification): string {
  return [
    row.gps,
    effectiveIntervalMs(row),
    row.distanceFilterM,
    row.deferMs,
    activityTypeFor(motion),
    notification.title,
    notification.body,
  ].join('|');
}
