/**
 * Web demo: simüle edilen telefon donanımı.
 *
 *  - GPS: Moda'da deterministik bir yürüyüş (world.ts `MY_LOOP`). Tarayıcı konumu İSTENMEZ.
 *    Örnekler expo-location `LocationObject` → `RawLocationSample` biçimindedir ve gerçek konum hattına
 *    (normalizeSample → selectTrackingProfile → shouldPublish → publisher → writeFanout) girer.
 *  - Pil: varsayılan %78; demo kontrolünden "%12" yapılabilir (düşük pil profili ve rozet görünür).
 *  - Arka plan konum görevi: native'de expo-task-manager'ın çağırdığı işlev; web'de `backgroundTask.web.ts`
 *    kaydeder, simüle motor sayfa gizliyken (AppState ≠ active) çağırır.
 *  - Faz 3: hareket kipi ("Masada bekle" / "Yürümeye başla" / "Araca bin") ve OS etkinlik tanıma olayları
 *    (CMMotionActivityManager / Activity Recognition karşılığı, `activitySource.web.ts` okur); uyku çiti görevi.
 */
import { MINUTE, type DeviceStatus, type LatLng, type MotionState, type RawLocationSample, type SleepGeofence, type TrackingPlanRow } from '@konum/core';
import { DRIVE_LOOP, jitter, MY_LOOP, nearestMetersOnPath, pointAlong } from '../server/world';
import { safeStorage } from '../server/storage';
import { demoPerms } from './permissions';

// --- pil ---------------------------------------------------------------------------------------

const BATTERY_KEY = 'konum.demo.battery.v1';
export const DEMO_DEFAULT_BATTERY_PCT = 78;

type BatteryListener = (pct: number) => void;
const batteryListeners = new Set<BatteryListener>();

function loadBattery(): number {
  const n = Number(safeStorage.get(BATTERY_KEY));
  return Number.isInteger(n) && n >= 0 && n <= 100 && safeStorage.get(BATTERY_KEY) !== null ? n : DEMO_DEFAULT_BATTERY_PCT;
}

let batteryPct = loadBattery();

export function demoBatteryPct(): number {
  return batteryPct;
}

export function setDemoBatteryPct(pct: number): void {
  const next = Math.max(0, Math.min(100, Math.round(pct)));
  batteryPct = next;
  if (next === DEMO_DEFAULT_BATTERY_PCT) safeStorage.remove(BATTERY_KEY);
  else safeStorage.set(BATTERY_KEY, String(next));
  for (const l of [...batteryListeners]) l(next);
}

export function onDemoBatteryChange(l: BatteryListener): () => void {
  batteryListeners.add(l);
  return () => batteryListeners.delete(l);
}

export function demoDeviceStatus(): DeviceStatus {
  return { batteryLevel: batteryPct / 100, isCharging: false };
}

// --- GPS + hareket kipi (Faz 3) ------------------------------------------------------------------

/** Yürüyüş hızı (m/sn): 5 sn'de ~6 m; 10 m mesafe filtresiyle yaklaşık her 10 sn'de bir yayın. */
const MY_SPEED_MPS = 1.2;
/** "Araca bin": ~41 km/sa (core sürüş bandı ≥ 8,5 m/sn). */
const DRIVE_SPEED_MPS = 11.5;

export type DemoMotionMode = 'walk' | 'still' | 'drive';

/** OS etkinlik olayı (modules/konum-activity `NativeActivityEvent` ile aynı biçim; cihaz saati). */
export interface DemoActivityEvent {
  type: 'still' | 'walking' | 'automotive';
  confidence: 'high';
  at: number;
}

interface MotionRec {
  mode: DemoMotionMode;
  since: number;
  /** Yürüyüş / araç: yol üzerinde başlangıç metresi. */
  m0: number;
  /** Hareketsiz: telefonun durduğu yer. */
  anchor: LatLng | null;
  /** Son OS etkinlik olayı. */
  act: DemoActivityEvent | null;
}

const MOTION_KEY = 'konum.demo.motion.v1';
/**
 * [Demo kısaltması] Gerçekte OS "hareketsiz" kararı ~2 dk (araçtan inişte 4 dk) sürer ve core makinesi bu süreyi
 * bekler. Demo, etkinlik olayının zamanını bu kadar geriye yazarak bekleyişi atlar; olaylar yine sıralıdır.
 */
const ACTIVITY_LEAD_MS = 4 * MINUTE + 5_000;

function loadMotion(): MotionRec {
  try {
    const raw = safeStorage.get(MOTION_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<MotionRec>) : null;
    if (v && (v.mode === 'walk' || v.mode === 'still' || v.mode === 'drive') && typeof v.since === 'number' && typeof v.m0 === 'number') {
      return { mode: v.mode, since: v.since, m0: v.m0, anchor: v.anchor ?? null, act: v.act ?? null };
    }
  } catch {
    // bozuk kayıt: varsayılan yürüyüş
  }
  // Faz 1/2 ile aynı: duvar saatine bağlı yürüyüş (yeniden yüklemede de aynı yerden sürer).
  return { mode: 'walk', since: 0, m0: 0, anchor: null, act: null };
}

let motion = loadMotion();
const motionListeners = new Set<(mode: DemoMotionMode) => void>();
const activityListeners = new Set<(e: DemoActivityEvent) => void>();

interface Pose extends LatLng {
  heading: number | null;
  speed: number;
}

function poseAt(rec: MotionRec, now: number): Pose {
  const sec = Math.floor(now / 1000);
  switch (rec.mode) {
    case 'still': {
      const a = rec.anchor ?? pointAlong(MY_LOOP, 0, true);
      return { lat: a.lat, lng: a.lng, heading: null, speed: 0 };
    }
    case 'drive': {
      const p = pointAlong(DRIVE_LOOP, rec.m0 + ((now - rec.since) / 1000) * DRIVE_SPEED_MPS, true);
      return { lat: p.lat, lng: p.lng, heading: p.heading, speed: DRIVE_SPEED_MPS + ((sec % 7) - 3) * 0.35 };
    }
    default: {
      const p = pointAlong(MY_LOOP, rec.m0 + ((now - rec.since) / 1000) * MY_SPEED_MPS, true);
      return { lat: p.lat, lng: p.lng, heading: p.heading, speed: MY_SPEED_MPS + ((sec % 5) - 2) * 0.04 };
    }
  }
}

/** Telefonun şu anki (gürültüsüz) konumu: uyku çiti izlemesi bunu kullanır. */
export function demoPosition(now: number = Date.now()): LatLng {
  const p = poseAt(motion, now);
  return { lat: p.lat, lng: p.lng };
}

export function demoMotionMode(): DemoMotionMode {
  return motion.mode;
}

export function onDemoMotionChange(l: (mode: DemoMotionMode) => void): () => void {
  motionListeners.add(l);
  return () => motionListeners.delete(l);
}

/** Hareket izni verilmişse son OS etkinliği (yoksa null: core yalnızca hız / yer değiştirmeyle karar verir). */
export function lastDemoActivity(): DemoActivityEvent | null {
  return demoPerms().motion === 'granted' ? motion.act : null;
}

export function onDemoActivity(l: (e: DemoActivityEvent) => void): () => void {
  activityListeners.add(l);
  return () => activityListeners.delete(l);
}

const ACTIVITY_OF: Record<DemoMotionMode, DemoActivityEvent['type']> = { walk: 'walking', still: 'still', drive: 'automotive' };

/**
 * Hareket kipini değiştirir. Konum sıçramaz: yeni yol mevcut konuma en yakın noktadan devam eder.
 * OS etkinlik tanıma olayı üretilir (yalnızca hareket izni varsa dinleyicilere gider).
 */
export function setDemoMotion(mode: DemoMotionMode, now: number = Date.now()): void {
  const here = demoPosition(now);
  const act: DemoActivityEvent = { type: ACTIVITY_OF[mode], confidence: 'high', at: Math.max(now - ACTIVITY_LEAD_MS, (motion.act?.at ?? 0) + 1) };
  let next: MotionRec;
  if (mode === 'still') next = { mode, since: now, m0: 0, anchor: here, act };
  else next = { mode, since: now, m0: nearestMetersOnPath(mode === 'drive' ? DRIVE_LOOP : MY_LOOP, here, true), anchor: null, act };
  motion = next;
  safeStorage.set(MOTION_KEY, JSON.stringify(next));
  for (const l of [...motionListeners]) l(mode);
  if (demoPerms().motion === 'granted') for (const l of [...activityListeners]) l({ ...act });
}

/**
 * Faz 5 demo: telefonu verilen noktaya koyar ve orada "masada" bekletir (bölge senaryoları: "Evden çık" / "Eve var"
 * yürüyüşü zaman atlamalı oynatılır, sonra telefon varış noktasında durur). Hareket dinleyicileri bilgilendirilir.
 */
export function placeDemoPhone(p: LatLng, now: number = Date.now()): void {
  const act: DemoActivityEvent = { type: 'still', confidence: 'high', at: Math.max(now - ACTIVITY_LEAD_MS, (motion.act?.at ?? 0) + 1) };
  const next: MotionRec = { mode: 'still', since: now, m0: 0, anchor: { lat: p.lat, lng: p.lng }, act };
  motion = next;
  safeStorage.set(MOTION_KEY, JSON.stringify(next));
  for (const l of [...motionListeners]) l('still');
  if (demoPerms().motion === 'granted') for (const l of [...activityListeners]) l({ ...act });
}

/** Simüle GPS ölçümü (kipine göre: yürüyüş, masada, araç). */
export function demoLocationSample(now: number = Date.now()): RawLocationSample {
  const p = poseAt(motion, now);
  const sec = Math.floor(now / 1000);
  const still = motion.mode === 'still';
  const j = jitter(sec, still ? 3 : 1.5);
  return {
    latitude: Math.round((p.lat + j.lat) * 1e6) / 1e6,
    longitude: Math.round((p.lng + j.lng) * 1e6) / 1e6,
    accuracy: still ? 9 + (sec % 4) : motion.mode === 'drive' ? 5 + (sec % 3) : 6 + (sec % 5),
    speed: still ? (sec % 3) * 0.05 : p.speed,
    heading: p.heading,
    timestamp: now,
    mocked: false,
  };
}

// --- simüle OS konum isteği (demo paneli okur) -----------------------------------------------------

export interface DemoEngineState {
  /** Arka plan görevi kayıtlı mı (paylaşım sürüyor). */
  running: boolean;
  /** Uygulanan core matris satırı (applyPlan); Faz 1 yolu (startBackground) ise null. */
  row: TrackingPlanRow | null;
  motion: MotionState | null;
  notification: { title: string; body: string } | null;
  fence: SleepGeofence | null;
  /** Arka planda GPS örnekleme aralığı (kapalıysa null). */
  gpsIntervalMs: number | null;
  /** Son GPS ölçümü (ön plan izleme ya da arka plan görevi). */
  lastFixAt: number | null;
  gpsFixes: number;
}

let engineState: DemoEngineState = { running: false, row: null, motion: null, notification: null, fence: null, gpsIntervalMs: null, lastFixAt: null, gpsFixes: 0 };
const engineListeners = new Set<(s: DemoEngineState) => void>();

export function demoEngineState(): DemoEngineState {
  return { ...engineState };
}

export function setDemoEngineState(patch: Partial<DemoEngineState>): void {
  engineState = { ...engineState, ...patch };
  for (const l of [...engineListeners]) l({ ...engineState });
}

export function onDemoEngineChange(l: (s: DemoEngineState) => void): () => void {
  engineListeners.add(l);
  return () => engineListeners.delete(l);
}

// --- arka plan konum görevi (TaskManager karşılığı) -----------------------------------------------

type TaskFn = (samples: RawLocationSample[]) => Promise<void> | void;
let locationTask: TaskFn | null = null;

/** `backgroundTask.web.ts` çağırır (native'de `TaskManager.defineTask`). */
export function defineDemoLocationTask(fn: TaskFn): void {
  locationTask = fn;
}

export function runDemoLocationTask(samples: RawLocationSample[]): void {
  if (!locationTask) return;
  void Promise.resolve(locationTask(samples)).catch(() => undefined);
}

// --- Faz 3: uyku çiti görevi (TaskManager `konum-sleep-geofence` karşılığı) ------------------------

let geofenceTask: (() => Promise<void> | void) | null = null;

export function defineDemoGeofenceTask(fn: () => Promise<void> | void): void {
  geofenceTask = fn;
}

export function runDemoGeofenceTask(): void {
  if (!geofenceTask) return;
  void Promise.resolve(geofenceTask()).catch(() => undefined);
}
