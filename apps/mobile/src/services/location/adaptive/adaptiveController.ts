/**
 * Faz 3: uyarlamalı takip denetleyicisi (G/Ç katmanı). Saf karar mantığı `adaptiveCore.ts`'tedir.
 *
 * Durum (hareket makinesi, uygulanan satır, uyku çiti, düşük pil tetikleyicisi, son `hb`) AsyncStorage'da
 * kalıcıdır: işletim sistemi uygulamayı başsız (headless) uyandırdığında makine kaldığı yerden sürer.
 * Tüm işlemler tek bir kilitten geçer (konum görevi, çit görevi ve zamanlayıcı aynı JS bağlamında
 * eşzamanlı çağırabilir).
 *
 * OS işlemleri motor (LocationEngine) üzerinden yapılır:
 *  - `applyPlan` (native ExpoLocationEngine): matris satırı → expo-location seçenekleri (planOptions.ts).
 *    Motor bunu sağlamıyorsa (web demo) Faz 1 `startBackground(profile)` kullanılır.
 *  - `setSleepGeofence`: uyku çiti (expo-location `startGeofencingAsync`, TaskManager görevi
 *    backgroundTask.ts'te). Motor sağlamıyorsa çit yok sayılır (sabit satır yine düşük güçlü çalışır).
 */
import type { EpochMs, MotionEvent, MotionState, SleepGeofence, TrackingPlan, TrackingPlanRow, TrackingProfile } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  decideApply,
  initialSnapshot,
  stepAdaptive,
  stepLowBattery,
  type AdaptiveContext,
  type AdaptiveSnapshot,
  type ApplyDecision,
} from './adaptiveCore';
import { modeHint, planApplyKey, type ServiceNotification } from './planOptions';

const KEY = 'konum.bg.adaptive.v1';

export interface AdaptiveStorage {
  load: (now: EpochMs) => Promise<AdaptiveSnapshot>;
  save: (s: AdaptiveSnapshot) => Promise<void>;
  clear: () => Promise<void>;
}

const MOTION_STATE_SET = new Set<MotionState>(['stationary', 'walking', 'running', 'cycling', 'driving', 'fast', 'unknown']);

function isSnapshot(v: unknown): v is AdaptiveSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<AdaptiveSnapshot>;
  return !!s.machine && MOTION_STATE_SET.has(s.machine.state) && typeof s.machine.since === 'number' && typeof s.lowBattery === 'object';
}

export const asyncStorageAdaptive: AdaptiveStorage = {
  load: async (now) => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return isSnapshot(parsed) ? { ...initialSnapshot(now), ...parsed } : initialSnapshot(now);
    } catch {
      return initialSnapshot(now);
    }
  },
  save: (s) => AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => undefined),
  clear: () => AsyncStorage.removeItem(KEY).catch(() => undefined),
};

/** Denetleyicinin kullandığı motor yüzeyi (LocationEngine'in alt kümesi). */
export interface AdaptiveEngineIO {
  canReconfigureNow: () => boolean;
  startBackground: (profile: TrackingProfile, notificationBody: string) => Promise<void>;
  applyPlan?: (row: TrackingPlanRow, motion: MotionState, notification: ServiceNotification) => Promise<void>;
  setSleepGeofence?: (fence: SleepGeofence | null) => Promise<void>;
}

export interface ObserveInput {
  events: readonly MotionEvent[];
  ctx: AdaptiveContext;
  /** Etkin paylaşım oturumları (düşük pil durumu oturum başına). */
  sessionKeys: readonly string[];
  /** Ön plan servisi bildirimi (başlık + gövde; mod ipucu burada eklenir). */
  notification: ServiceNotification;
  /** true: debounce'u atla (ön plan yeni hedef/metin uyguluyor). */
  force?: boolean;
}

export interface ObserveResult {
  motion: MotionState;
  /** Faz 7: gözlemden ÖNCEKİ hareket durumu ve o duruma giriş anı ("yola çıktı" tespiti). */
  previous?: { state: MotionState; since: EpochMs };
  sendPlan: TrackingPlan;
  bgPlan: TrackingPlan;
  transitions: { from: MotionState; to: MotionState; reason: string }[];
  /** Bu gözlemde düşük pil bildirimi tetiklenen oturumlar. */
  lowBatteryFired: string[];
  /** Bildirimden sonra yeniden kurulan oturumlar (sunucu durumu da kurulsun). */
  lowBatteryRearmed: string[];
  lastSentHb: number | null;
  apply: ApplyDecision | { apply: false; reason: 'failed'; pending: AdaptiveSnapshot['pending'] };
}

export interface AdaptiveController {
  observe: (input: ObserveInput) => Promise<ObserveResult>;
  /** Pakete yazılan `hb` (gönderim ya da kuyruğa alma sonrası). */
  noteSent: (hb: number) => Promise<void>;
  /** Takip kapandı: durum silinir, uyku çiti kaldırılır. */
  reset: () => Promise<void>;
  /** Teşhis / test. */
  snapshot: (now: EpochMs) => Promise<AdaptiveSnapshot>;
}

export function withModeHint(n: ServiceNotification, row: TrackingPlanRow, motion: MotionState): ServiceNotification {
  const hint = modeHint(row, motion);
  if (!hint) return n;
  return { title: n.title, body: n.body ? `${n.body} · ${hint}` : hint };
}

export function createAdaptiveController(opts: { io: () => AdaptiveEngineIO; storage?: AdaptiveStorage }): AdaptiveController {
  const storage = opts.storage ?? asyncStorageAdaptive;
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  const observe = (input: ObserveInput): Promise<ObserveResult> =>
    locked(async () => {
      const { ctx } = input;
      const prev = await storage.load(ctx.now);
      const step = stepAdaptive(prev, input.events, ctx);
      const battery = stepLowBattery(prev.lowBattery, input.sessionKeys, ctx.batteryPct, ctx.isCharging, ctx.now);
      let snap: AdaptiveSnapshot = { ...step.snapshot, lowBattery: battery.next };
      const io = opts.io();

      // 1) Uyku çiti (çit önce: GPS kapanmadan önce uyanma yolu hazır olsun).
      if (step.fenceOp && io.setSleepGeofence) {
        try {
          if ('set' in step.fenceOp) {
            await io.setSleepGeofence(step.fenceOp.set);
            snap = { ...snap, fence: step.fenceOp.set };
          } else {
            await io.setSleepGeofence(null);
            snap = { ...snap, fence: null };
          }
        } catch (e) {
          if (__DEV__) console.warn('[konum] uyku çiti güncellenemedi', e);
        }
      }

      // 2) OS konum isteği (yalnızca satır değiştiyse; debounce).
      const notification = withModeHint(input.notification, step.bgPlan.row, step.motion);
      const key = planApplyKey(step.bgPlan.row, step.motion, notification);
      const canReconfigure = io.canReconfigureNow();
      let decision: ObserveResult['apply'] =
        input.force && canReconfigure
          ? { apply: true, reason: 'first', pending: null }
          : decideApply(snap, key, step.bgPlan, ctx.now, canReconfigure);
      if (decision.apply) {
        try {
          if (io.applyPlan) await io.applyPlan(step.bgPlan.row, step.motion, notification);
          else await io.startBackground(step.bgPlan.profile, notification.body);
          snap = { ...snap, applied: { key, at: ctx.now, sleeping: step.bgPlan.row.gps === 'off' }, pending: null };
        } catch (e) {
          if (__DEV__) console.warn('[konum] takip planı uygulanamadı', e);
          decision = { apply: false, reason: 'failed', pending: { key, since: ctx.now } };
          snap = { ...snap, pending: decision.pending };
        }
      } else {
        snap = { ...snap, pending: decision.pending };
      }

      await storage.save(snap);
      return {
        motion: step.motion,
        previous: { state: prev.machine.state, since: prev.machine.since },
        sendPlan: step.sendPlan,
        bgPlan: step.bgPlan,
        transitions: step.transitions,
        lowBatteryFired: battery.fired,
        lowBatteryRearmed: battery.rearmed,
        lastSentHb: snap.lastSentHb,
        apply: decision,
      };
    });

  return {
    observe,
    noteSent: (hb) =>
      locked(async () => {
        const s = await storage.load(Date.now());
        if (s.lastSentHb === hb) return;
        await storage.save({ ...s, lastSentHb: hb });
      }),
    reset: () =>
      locked(async () => {
        const s = await storage.load(Date.now());
        const io = opts.io();
        if (s.fence && io.setSleepGeofence) await io.setSleepGeofence(null).catch(() => undefined);
        await storage.clear();
      }),
    snapshot: (now) => locked(() => storage.load(now)),
  };
}
