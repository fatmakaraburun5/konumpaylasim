/**
 * Faz 3: hareket durumu × uygulama evresi × pil bandı → GPS örnekleme ve sunucu gönderim planı.
 *
 * Satır alanları platforma şöyle eşlenir (mobil katman):
 *  - `gps`: 'high' → iOS kCLLocationAccuracyBest / Android PRIORITY_HIGH_ACCURACY;
 *           'balanced' → iOS HundredMeters / Android BALANCED_POWER_ACCURACY;
 *           'low' → iOS Kilometer / Android LOW_POWER;
 *           'off' → GNSS yok: sürekli güncelleme durur, uyku çiti + kalp atışı zamanlayıcısı tek seferlik
 *                   düşük güçlü (hücre/Wi-Fi) ölçüm alır.
 *  - `osIntervalMs` / `distanceFilterM`: expo-location `timeInterval` / `distanceInterval`.
 *  - `deferMs`: toplu teslim (iOS `deferredUpdatesInterval`, Android `maxWaitTime` / FusedLocation batching);
 *               radyo ve CPU uyanma sayısını düşürür.
 *  - `sendMinIntervalMs`: iki canlı yazma arası en kısa süre (`shouldPublish` kapısı).
 *  - `heartbeatMs`: hareket olmasa da en geç bu aralıkla paket; pakete `hb` olarak yazılır.
 *  - `significantChanges`: iOS startMonitoringSignificantLocationChanges / Android pasif sağlayıcı (~500 m).
 *
 * Değerler [Varsayım]: sahada pil ölçümüyle ayarlanacak (bkz. `simulate.ts` senaryoları).
 */
import { LOW_BATTERY_PCT, TRACKING_PROFILES, type AppPhase, type TrackingProfile, type TrackingProfileId } from './cadence';
import { MOTION_STATES, type MotionState } from './motion';
import { MINUTE, SECOND } from './time';

export type BatteryBand = 'normal' | 'low' | 'critical' | 'charging';
export const BATTERY_BANDS: readonly BatteryBand[] = ['normal', 'low', 'critical', 'charging'];
export const APP_PHASES: readonly AppPhase[] = ['foreground', 'background'];

export type GpsPower = 'high' | 'balanced' | 'low' | 'off';

export interface TrackingPlanRow {
  gps: GpsPower;
  /** 0 = sürekli güncelleme yok (yalnızca çit/önemli değişiklik/kalp atışı). */
  osIntervalMs: number;
  distanceFilterM: number;
  deferMs: number;
  sendMinIntervalMs: number;
  heartbeatMs: number;
  useSleepGeofence: boolean;
  significantChanges: boolean;
}

/** Kritik pil eşiği (yüzde). */
export const CRITICAL_BATTERY_PCT = 5;
/** Düşük banttan normale dönüş eşiği (histerezis; `battery.ts` yeniden kurma eşiğiyle aynı). */
export const BATTERY_RECOVER_PCT = 20;

const S = SECOND;
const M = MINUTE;

type BaseRow = Omit<TrackingPlanRow, 'significantChanges'> & { significantChanges?: boolean };

/** Normal pil satırları. */
const BASE: Record<AppPhase, Record<MotionState, BaseRow>> = {
  foreground: {
    stationary: { gps: 'balanced', osIntervalMs: 10 * S, distanceFilterM: 10, deferMs: 0, sendMinIntervalMs: 30 * S, heartbeatMs: 2 * M, useSleepGeofence: false },
    walking: { gps: 'high', osIntervalMs: 5 * S, distanceFilterM: 5, deferMs: 0, sendMinIntervalMs: 5 * S, heartbeatMs: M, useSleepGeofence: false },
    running: { gps: 'high', osIntervalMs: 3 * S, distanceFilterM: 5, deferMs: 0, sendMinIntervalMs: 5 * S, heartbeatMs: M, useSleepGeofence: false },
    cycling: { gps: 'high', osIntervalMs: 3 * S, distanceFilterM: 10, deferMs: 0, sendMinIntervalMs: 5 * S, heartbeatMs: M, useSleepGeofence: false },
    driving: { gps: 'high', osIntervalMs: 2 * S, distanceFilterM: 20, deferMs: 0, sendMinIntervalMs: 3 * S, heartbeatMs: M, useSleepGeofence: false },
    fast: { gps: 'high', osIntervalMs: 2 * S, distanceFilterM: 50, deferMs: 0, sendMinIntervalMs: 3 * S, heartbeatMs: M, useSleepGeofence: false },
    unknown: { gps: 'high', osIntervalMs: 5 * S, distanceFilterM: 10, deferMs: 0, sendMinIntervalMs: 5 * S, heartbeatMs: M, useSleepGeofence: false },
  },
  background: {
    stationary: { gps: 'off', osIntervalMs: 0, distanceFilterM: 0, deferMs: 0, sendMinIntervalMs: 15 * M, heartbeatMs: 15 * M, useSleepGeofence: true },
    walking: { gps: 'balanced', osIntervalMs: 20 * S, distanceFilterM: 15, deferMs: 60 * S, sendMinIntervalMs: 20 * S, heartbeatMs: 5 * M, useSleepGeofence: false },
    running: { gps: 'balanced', osIntervalMs: 15 * S, distanceFilterM: 20, deferMs: 60 * S, sendMinIntervalMs: 15 * S, heartbeatMs: 5 * M, useSleepGeofence: false },
    cycling: { gps: 'high', osIntervalMs: 10 * S, distanceFilterM: 30, deferMs: 45 * S, sendMinIntervalMs: 10 * S, heartbeatMs: 3 * M, useSleepGeofence: false },
    driving: { gps: 'high', osIntervalMs: 5 * S, distanceFilterM: 50, deferMs: 30 * S, sendMinIntervalMs: 10 * S, heartbeatMs: 2 * M, useSleepGeofence: false },
    fast: { gps: 'high', osIntervalMs: 5 * S, distanceFilterM: 100, deferMs: 30 * S, sendMinIntervalMs: 10 * S, heartbeatMs: 2 * M, useSleepGeofence: false },
    unknown: { gps: 'balanced', osIntervalMs: 30 * S, distanceFilterM: 25, deferMs: 60 * S, sendMinIntervalMs: 30 * S, heartbeatMs: 5 * M, useSleepGeofence: false },
  },
};

const lower = (g: GpsPower): GpsPower => (g === 'high' ? 'balanced' : g === 'balanced' ? 'low' : g);
const cap = (v: number, max: number) => Math.min(v, max);

function deriveRow(phase: AppPhase, motion: MotionState, battery: BatteryBand): TrackingPlanRow {
  const b: TrackingPlanRow = { significantChanges: false, ...BASE[phase][motion] };
  switch (battery) {
    case 'normal':
      return b;
    case 'charging':
      // Şarjda pil cezası yok: toplu teslim yarıya iner (araç şarjı / CarPlay), sabit kalp atışı 10 dk.
    {
      const heartbeatMs = motion === 'stationary' && phase === 'background' ? 10 * M : b.heartbeatMs;
      return { ...b, deferMs: Math.round(b.deferMs / 2), heartbeatMs, sendMinIntervalMs: Math.min(b.sendMinIntervalMs, heartbeatMs) };
    }
    case 'low':
      // ≤ %15: aralıklar ≈ 2 kat, doğruluk bir kademe düşük; sabit kalp atışı 30 dk.
      return {
        ...b,
        gps: lower(b.gps),
        osIntervalMs: b.osIntervalMs * 2,
        distanceFilterM: b.distanceFilterM * 2,
        deferMs: phase === 'background' && b.osIntervalMs > 0 ? Math.max(b.deferMs * 2, 60 * S) : 0,
        sendMinIntervalMs: b.sendMinIntervalMs * 2,
        heartbeatMs: cap(b.heartbeatMs * 2, 30 * M),
      };
    case 'critical':
      // ≤ %5: yalnızca kalp atışı + önemli konum değişikliği. Ön planda kullanıcı bakıyor: hafif düşük güç takip.
      if (phase === 'foreground') {
        return { gps: 'low', osIntervalMs: 60 * S, distanceFilterM: 100, deferMs: 0, sendMinIntervalMs: 60 * S, heartbeatMs: 5 * M, useSleepGeofence: false, significantChanges: false };
      }
      return {
        gps: 'off',
        osIntervalMs: 0,
        distanceFilterM: 500,
        deferMs: 0,
        sendMinIntervalMs: 5 * M,
        heartbeatMs: motion === 'stationary' ? 60 * M : 30 * M,
        useSleepGeofence: motion === 'stationary',
        significantChanges: true,
      };
  }
}

function buildMatrix(): Record<MotionState, Record<AppPhase, Record<BatteryBand, TrackingPlanRow>>> {
  const out = {} as Record<MotionState, Record<AppPhase, Record<BatteryBand, TrackingPlanRow>>>;
  for (const motion of MOTION_STATES) {
    out[motion] = {} as Record<AppPhase, Record<BatteryBand, TrackingPlanRow>>;
    for (const phase of APP_PHASES) {
      out[motion][phase] = {} as Record<BatteryBand, TrackingPlanRow>;
      for (const battery of BATTERY_BANDS) out[motion][phase][battery] = Object.freeze(deriveRow(phase, motion, battery));
    }
  }
  return out;
}

/** Tam matris: `TRACKING_MATRIX[motion][appPhase][batteryBand]`. */
export const TRACKING_MATRIX: Readonly<Record<MotionState, Readonly<Record<AppPhase, Readonly<Record<BatteryBand, TrackingPlanRow>>>>>> =
  buildMatrix();

/**
 * Pil bandı. Şarj her şeyin önündedir. Histerezis: önceki bant düşük/kritikse %20'ye çıkana kadar en az 'low'.
 */
export function batteryBand(pct: number | null, charging: boolean | null, prev?: BatteryBand): BatteryBand {
  if (charging === true) return 'charging';
  if (pct === null || !Number.isFinite(pct)) return prev === 'low' || prev === 'critical' ? prev : 'normal';
  if (pct <= CRITICAL_BATTERY_PCT) return 'critical';
  if (pct <= LOW_BATTERY_PCT) return 'low';
  if ((prev === 'low' || prev === 'critical') && pct < BATTERY_RECOVER_PCT) return 'low';
  return 'normal';
}

export interface TrackingPlanInput {
  hasActiveOutgoingShare: boolean;
  appPhase: AppPhase;
  motion: MotionState;
  batteryPct: number | null;
  isCharging: boolean | null;
  /** Önceki pil bandı (histerezis için). */
  prevBattery?: BatteryBand;
  /**
   * Uyku çiti kullanılabilir mi? iOS bölge izleme `Always`, Android geofence `ACCESS_BACKGROUND_LOCATION`
   * ister. Yoksa sabit/arka plan satırı GPS'i kapatamaz: düşük güçlü sürekli güncellemeye düşer.
   * Varsayılan true.
   */
  canUseGeofence?: boolean;
}

export interface TrackingPlan {
  /** 'off' = paylaşım yok. */
  active: boolean;
  row: TrackingPlanRow;
  motion: MotionState;
  appPhase: AppPhase;
  battery: BatteryBand;
  /** Kayıt/teşhis için: "background/stationary/low" ya da "off:no_share". */
  reason: string;
  /** Faz 1 uyumu: `shouldPublish` bu profille çalışır. */
  profile: TrackingProfile;
}

const OFF_ROW: TrackingPlanRow = Object.freeze({
  gps: 'off',
  osIntervalMs: 0,
  distanceFilterM: 0,
  deferMs: 0,
  sendMinIntervalMs: 0,
  heartbeatMs: 0,
  useSleepGeofence: false,
  significantChanges: false,
});

/** Çit izni yoksa sabit satırının yedeği: GNSS'siz, seyrek sürekli güncelleme (süreç ayakta kalır). */
function noGeofenceFallback(row: TrackingPlanRow): TrackingPlanRow {
  if (!row.useSleepGeofence) return row;
  return { ...row, gps: 'low', osIntervalMs: 5 * M, distanceFilterM: 100, useSleepGeofence: false, significantChanges: true };
}

export function selectTrackingPlan(input: TrackingPlanInput): TrackingPlan {
  const battery = batteryBand(input.batteryPct, input.isCharging, input.prevBattery);
  if (!input.hasActiveOutgoingShare) {
    return { active: false, row: OFF_ROW, motion: input.motion, appPhase: input.appPhase, battery, reason: 'off:no_share', profile: TRACKING_PROFILES.off };
  }
  let row = TRACKING_MATRIX[input.motion][input.appPhase][battery];
  let reason = `${input.appPhase}/${input.motion}/${battery}`;
  if (input.canUseGeofence === false && row.useSleepGeofence) {
    row = noGeofenceFallback(row);
    reason += ':no_geofence';
  }
  return { active: true, row, motion: input.motion, appPhase: input.appPhase, battery, reason, profile: profileFromRow(row, input, battery) };
}

/**
 * Plan satırını Faz 1 `TrackingProfile` biçimine çevirir; `shouldPublish` değişmeden çalışır.
 * `timeIntervalMs` burada GÖNDERİM aralığıdır (sendMinIntervalMs).
 */
export function profileFromRow(row: TrackingPlanRow, ctx: Pick<TrackingPlanInput, 'appPhase' | 'motion'>, battery: BatteryBand): TrackingProfile {
  const id: TrackingProfileId =
    battery === 'low' || battery === 'critical'
      ? 'low_battery'
      : ctx.appPhase === 'foreground'
        ? 'live_foreground'
        : ctx.motion === 'stationary'
          ? 'still_background'
          : 'live_background';
  return {
    id,
    timeIntervalMs: row.sendMinIntervalMs,
    distanceFilterM: row.distanceFilterM,
    accuracy: row.gps === 'off' ? 'low' : row.gps,
    heartbeatMs: row.heartbeatMs,
  };
}

/**
 * Plan kalp atışı, alıcıya en son bildirilen `hb`'den uzunsa HEMEN bir paket gönderilmeli (`shouldPublish`
 * `targetsChanged = true` ile zorlanır; GPS kapalıysa tek seferlik ölçüm). Yoksa alıcı eski kısa `hb`'ye göre
 * yanlışlıkla "gecikiyor" der (ör. yürüyüşten sabite ya da düşük pile geçiş).
 */
export function needsHeartbeatAnnounce(lastSentHb: number | null, plan: TrackingPlan): boolean {
  return plan.active && lastSentHb !== null && plan.row.heartbeatMs > lastSentHb;
}

/** Belge/test için matrisin düz tablo hâli. */
export function trackingMatrixRows(): Array<{ motion: MotionState; appPhase: AppPhase; battery: BatteryBand } & TrackingPlanRow> {
  const rows: Array<{ motion: MotionState; appPhase: AppPhase; battery: BatteryBand } & TrackingPlanRow> = [];
  for (const motion of MOTION_STATES) {
    for (const appPhase of APP_PHASES) {
      for (const battery of BATTERY_BANDS) rows.push({ motion, appPhase, battery, ...TRACKING_MATRIX[motion][appPhase][battery] });
    }
  }
  return rows;
}
