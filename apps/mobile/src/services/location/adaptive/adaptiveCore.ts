/**
 * Faz 3: uyarlamalı takip motorunun SAF çekirdeği (test edilebilir, yan etkisiz).
 *
 *   olaylar (konum örneği, OS etkinliği, uyku çiti çıkışı, zamanlayıcı)
 *     → core `motionReducer` (histerezisli hareket durumu + uyku çiti merkezi)
 *     → core `selectTrackingPlan` (hareket × evre × pil bandı → matris satırı)
 *     → gönderim planı (`sendPlan`, uygulamanın O ANKİ evresi: `shouldPublish` kapısı + paketteki `hb`)
 *       arka plan planı (`bgPlan`, her zaman 'background' satırı: OS konum isteği + uyku çiti)
 *
 * OS isteğinin yeniden başlatılması (expo-location `startLocationUpdatesAsync`) yalnızca satır değiştiğinde ve
 * `decideApply` kurallarıyla yapılır:
 *   - Uykudan uyanış (GPS kapalı → açık) ve ilk uygulama: HEMEN (hareket başladıysa gecikme yok).
 *   - Diğer değişiklikler: yeni anahtar en az `APPLY_DEBOUNCE_MS` boyunca değişmeden kalmalı ve son
 *     yeniden başlatmadan bu yana en az `MIN_REAPPLY_MS` geçmeli (pil bandı / bant titremesi isteği sürekli
 *     yeniden başlatmasın).
 *   - Platform şu an yeniden yapılandırmaya izin vermiyorsa (Android arka planı) değişiklik BEKLER.
 */
import {
  initialMotion,
  lowBatteryTrigger,
  motionReducer,
  selectTrackingPlan,
  type AppPhase,
  type BatteryBand,
  type EpochMs,
  type LowBatteryState,
  type MotionEvent,
  type MotionMachine,
  type MotionState,
  type SleepGeofence,
  type TrackingPlan,
} from '@konum/core';

/** [Varsayım] Satır değişikliğinin kalıcı sayılması için bekleme. */
export const APPLY_DEBOUNCE_MS = 20_000;
/** [Varsayım] İki OS yeniden başlatması arası en kısa süre (acil durumlar hariç). */
export const MIN_REAPPLY_MS = 60_000;

export interface AppliedPlan {
  key: string;
  at: EpochMs;
  /** Uygulanan satır GPS kapalı (uyku / canlı tutma) mıydı. */
  sleeping: boolean;
}

export interface AdaptiveSnapshot {
  machine: MotionMachine;
  prevBattery: BatteryBand | null;
  applied: AppliedPlan | null;
  /** Bekleyen (henüz uygulanmamış) satır anahtarı. */
  pending: { key: string; since: EpochMs } | null;
  /** OS'ye kayıtlı uyku çiti (başarılı kayıttan sonra). */
  fence: SleepGeofence | null;
  /** Alıcıya en son bildirilen `hb` (ms). */
  lastSentHb: number | null;
  /** Makineye en son verilen OS etkinliğinin anı (aynı olay iki kez işlenmesin). */
  lastActivityAt: EpochMs | null;
  /** Düşük pil tetikleyicisi, paylaşım oturumu başına. */
  lowBattery: Record<string, LowBatteryState>;
}

export function initialSnapshot(now: EpochMs): AdaptiveSnapshot {
  return {
    machine: initialMotion(now),
    prevBattery: null,
    applied: null,
    pending: null,
    fence: null,
    lastSentHb: null,
    lastActivityAt: null,
    lowBattery: {},
  };
}

export interface AdaptiveContext {
  now: EpochMs;
  appPhase: AppPhase;
  batteryPct: number | null;
  isCharging: boolean | null;
  /** Always / ACCESS_BACKGROUND_LOCATION var mı (core `nextPermissionStep(...).canUseGeofence`). */
  canUseGeofence: boolean;
}

export type FenceOp = { set: SleepGeofence } | { clear: true } | null;

export interface AdaptiveStep {
  snapshot: AdaptiveSnapshot;
  motion: MotionState;
  sendPlan: TrackingPlan;
  bgPlan: TrackingPlan;
  transitions: { from: MotionState; to: MotionState; reason: string }[];
  /** OS uyku çiti işlemi (kayıtlı çit ile istenen çitin farkı). */
  fenceOp: FenceOp;
}

const sameFence = (a: SleepGeofence | null, b: SleepGeofence | null) =>
  a === b || (!!a && !!b && a.lat === b.lat && a.lng === b.lng && a.radiusM === b.radiusM);

const eventAt = (e: MotionEvent) => e.at;

/** Olayları hareket makinesine verir ve iki planı (gönderim + arka plan) seçer. */
export function stepAdaptive(s: AdaptiveSnapshot, events: readonly MotionEvent[], ctx: AdaptiveContext): AdaptiveStep {
  let machine = s.machine;
  let lastActivityAt = s.lastActivityAt;
  const transitions: AdaptiveStep['transitions'] = [];
  for (const e of [...events].sort((a, b) => eventAt(a) - eventAt(b))) {
    if (e.type === 'activity') {
      if (lastActivityAt !== null && e.at <= lastActivityAt) continue; // aynı OS olayı ikinci kez
      lastActivityAt = e.at;
    }
    // Ön plan izleyicisi ve arka plan görevi aynı ölçümü iki kez verebilir; geç gelen eski ölçüm makineyi geri sarmasın.
    if (e.type === 'fix' && machine.lastFix && e.at <= machine.lastFix.at) continue;
    const r = motionReducer(machine, e, ctx.now);
    machine = r.machine;
    if (r.transition) transitions.push(r.transition);
  }
  const base = {
    hasActiveOutgoingShare: true,
    motion: machine.state,
    batteryPct: ctx.batteryPct,
    isCharging: ctx.isCharging,
    prevBattery: s.prevBattery ?? undefined,
    canUseGeofence: ctx.canUseGeofence,
  } as const;
  const sendPlan = selectTrackingPlan({ ...base, appPhase: ctx.appPhase });
  const bgPlan = selectTrackingPlan({ ...base, appPhase: 'background' });

  const wanted = ctx.canUseGeofence && bgPlan.row.useSleepGeofence && machine.state === 'stationary' ? machine.geofence : null;
  let fenceOp: FenceOp = null;
  if (wanted && !sameFence(wanted, s.fence)) fenceOp = { set: wanted };
  else if (!wanted && s.fence) fenceOp = { clear: true };

  return {
    snapshot: { ...s, machine, lastActivityAt, prevBattery: sendPlan.battery },
    motion: machine.state,
    sendPlan,
    bgPlan,
    transitions,
    fenceOp,
  };
}

export type ApplyDecision =
  | { apply: true; reason: 'first' | 'wake' | 'critical' | 'settled'; pending: null }
  | { apply: false; reason: 'same' | 'cannot_reconfigure' | 'debounce' | 'rate_limited'; pending: AdaptiveSnapshot['pending'] };

/** Yeni arka plan satırı OS'ye şimdi uygulanmalı mı? */
export function decideApply(
  s: Pick<AdaptiveSnapshot, 'applied' | 'pending'>,
  key: string,
  plan: Pick<TrackingPlan, 'row' | 'battery'>,
  now: EpochMs,
  canReconfigure: boolean,
): ApplyDecision {
  if (s.applied?.key === key) return { apply: false, reason: 'same', pending: null };
  const pending = s.pending?.key === key ? s.pending : { key, since: now };
  if (!canReconfigure) return { apply: false, reason: 'cannot_reconfigure', pending };
  if (!s.applied) return { apply: true, reason: 'first', pending: null };
  const sleepingNext = plan.row.gps === 'off';
  if (s.applied.sleeping && !sleepingNext) return { apply: true, reason: 'wake', pending: null };
  if (plan.battery === 'critical') return { apply: true, reason: 'critical', pending: null };
  if (now - pending.since < APPLY_DEBOUNCE_MS) return { apply: false, reason: 'debounce', pending };
  if (now - s.applied.at < MIN_REAPPLY_MS) return { apply: false, reason: 'rate_limited', pending };
  return { apply: true, reason: 'settled', pending: null };
}

/**
 * Düşük pil: etkin oturumların her biri için core tetikleyicisi; bitmiş oturumların durumu atılır.
 * `rearmed`: daha önce bildirim gitmiş ve şimdi yeniden kurulan oturumlar (sunucu durumunu da kurmak için).
 */
export function stepLowBattery(
  states: Record<string, LowBatteryState>,
  sessionKeys: readonly string[],
  pct: number | null,
  charging: boolean | null,
  now: EpochMs,
): { next: Record<string, LowBatteryState>; fired: string[]; rearmed: string[] } {
  const next: Record<string, LowBatteryState> = {};
  const fired: string[] = [];
  const rearmed: string[] = [];
  for (const k of new Set(sessionKeys)) {
    const prev = states[k] ?? null;
    const r = lowBatteryTrigger(prev, pct, charging, now);
    next[k] = r.state;
    if (r.fire) fired.push(k);
    else if (prev && !prev.armed && r.state.armed && r.state.fired > 0) rearmed.push(k);
  }
  return { next, fired, rearmed };
}
