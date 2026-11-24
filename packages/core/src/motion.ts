/**
 * Faz 3: hareket durumu makinesi (saf, deterministik).
 *
 * Girdiler: işletim sisteminin etkinlik tanıma çıktısı (iOS CMMotionActivityManager, Android Activity
 * Recognition Transition API; güven düzeyiyle), konum örnekleri (hız + doğruluk) ve uyku çiti (geofence)
 * çıkış olayları. Çıktı: `MotionState` ve "sabit"e girerken kurulacak uyku çitinin merkezi/yarıçapı.
 *
 * Histerezis:
 *  - Sabite GİRİŞ: yer değiştirme `STILL_RADIUS_M` (doğruluğa göre büyür) içinde ≥ `STILL_ENTER_MS` kaldıysa,
 *    ya da işletim sistemi yüksek güvenle "still" diyorsa ≥ `OS_STILL_ENTER_MS` (araçtan inişte daha uzun).
 *  - Sabitten ÇIKIŞ: OS hareket etkinliği (orta/yüksek güven), uyku çiti çıkışı veya çit merkezinden
 *    `max(STILL_RADIUS_M, 2 × doğruluk)` ötede bir örnek.
 *  - Hız bantları (yürüme/koşu/bisiklet/araç/hızlı) yukarı ve aşağı farklı eşik + bekleme süresiyle değişir;
 *    kırmızı ışıkta duran araç "yürüme"ye düşmez.
 *
 * Eşikler [Varsayım]: sahada pil ve doğruluk ölçümüyle ayarlanacak.
 */
import { haversineM, type LatLng } from './geo';
import type { ActivityState } from './packet';
import { MINUTE, SECOND, type EpochMs } from './time';

export type MotionState = 'stationary' | 'walking' | 'running' | 'cycling' | 'driving' | 'fast' | 'unknown';
export const MOTION_STATES: readonly MotionState[] = ['stationary', 'walking', 'running', 'cycling', 'driving', 'fast', 'unknown'];

/** Hareket hâlindeki bantlar, yavaştan hızlıya. */
const MOVING_BANDS = ['walking', 'running', 'cycling', 'driving', 'fast'] as const;
type MovingBand = (typeof MOVING_BANDS)[number];

export type ActivityConfidence = 'low' | 'medium' | 'high';

export const MOTION_THRESHOLDS = {
  /** Sabit sayılacak en büyük yer değiştirme (doğruluk iyiyse). */
  STILL_RADIUS_M: 60,
  /** Doğruluk kötüyse yarıçap 2 × doğruluk'a büyür, ama en çok bu kadar. */
  STILL_RADIUS_MAX_M: 200,
  /** Yer değiştirmeye göre sabite giriş süresi. */
  STILL_ENTER_MS: 4 * MINUTE,
  /** OS yüksek güvenle "still" derse giriş süresi. */
  OS_STILL_ENTER_MS: 2 * MINUTE,
  /** Araç/hızlı banttan OS "still" ile giriş: trafik ışığı/sıkışıklık için daha uzun. */
  OS_STILL_ENTER_FROM_VEHICLE_MS: 4 * MINUTE,
  /** OS etkinliği bu kadar eskiyse bant seçiminde kullanılmaz. */
  OS_ACTIVITY_TTL_MS: 2 * MINUTE,
  /** Uyku çiti yarıçapı (iOS bölge izleme ~100 m altında güvenilmez). */
  SLEEP_GEOFENCE_MIN_M: 100,
  SLEEP_GEOFENCE_MAX_M: 150,
  /** Bant yükseltme (hızlanma) için adayın sürmesi gereken süre. */
  UPSHIFT_DWELL_MS: 10 * SECOND,
  /** Bant düşürme (yavaşlama) için bekleme; araç bantlarından düşüş daha uzun. */
  DOWNSHIFT_DWELL_MS: 30 * SECOND,
  DOWNSHIFT_FROM_VEHICLE_DWELL_MS: 90 * SECOND,
  /** Hız bandı eşikleri (m/s): [yukarı geçiş, aşağı dönüş]. */
  BANDS: {
    running: { up: 2.5, down: 2.0 }, // ≈ 9 / 7 km/sa
    cycling: { up: 4.5, down: 3.8 }, // ≈ 16 / 14 km/sa
    driving: { up: 8.5, down: 7.0 }, // ≈ 31 / 25 km/sa
    fast: { up: 19.4, down: 16.7 }, // ≈ 70 / 60 km/sa (otoyol, motosiklet)
  },
  /** Bu hızın altı "hareket yok" (GPS hız gürültüsü). */
  MOVING_MIN_MPS: 0.8,
  /** Bundan kötü doğruluklu örnek bant/sabit kararına katılmaz (yalnızca son konum güncellenir). */
  MAX_DECISION_ACCURACY_M: 250,
} as const;

export interface MotionSample extends LatLng {
  accuracy: number;
  speed_mps: number | null;
  at: EpochMs;
}

export interface SleepGeofence extends LatLng {
  radiusM: number;
}

export type MotionEvent =
  | { type: 'activity'; activity: ActivityState; confidence: ActivityConfidence; at: EpochMs }
  | ({ type: 'fix' } & MotionSample)
  | { type: 'geofence_exit'; at: EpochMs }
  /** Zamanlayıcı: yeni örnek gelmese de süre koşullarını değerlendir. */
  | { type: 'tick'; at: EpochMs };

export interface MotionMachine {
  state: MotionState;
  since: EpochMs;
  /** Sabitlik penceresinin çapası (pencere içindeki ilk örnek). */
  anchor: MotionSample | null;
  lastFix: MotionSample | null;
  /** OS'nin yüksek güvenle "still" demeye başladığı an. */
  osStillSince: EpochMs | null;
  /** Son OS hareket etkinliği (still dışı, orta/yüksek güven). */
  osMoving: { activity: ActivityState; at: EpochMs } | null;
  /** Değişmeyi bekleyen bant adayı. */
  candidate: { band: MovingBand; since: EpochMs } | null;
  /** Sabitteyken kurulu uyku çiti. */
  geofence: SleepGeofence | null;
}

export type MotionTransitionReason =
  | 'displacement_still'
  | 'no_movement'
  | 'os_still'
  | 'os_activity'
  | 'geofence_exit'
  | 'displacement_exit'
  | 'speed';

export interface MotionResult {
  machine: MotionMachine;
  /** Durum değiştiyse. */
  transition?: { from: MotionState; to: MotionState; reason: MotionTransitionReason };
  /** Sabite girildi: bu çiti kur (iOS CLCircularRegion / Android GeofencingClient), GPS'i kapat. */
  setGeofence?: SleepGeofence;
  /** Sabitten çıkıldı: çiti kaldır. */
  clearGeofence?: true;
}

export function initialMotion(now: EpochMs, state: MotionState = 'unknown'): MotionMachine {
  return { state, since: now, anchor: null, lastFix: null, osStillSince: null, osMoving: null, candidate: null, geofence: null };
}

/** Doğruluğa duyarlı sabitlik yarıçapı: max(60 m, 2 × doğruluk), en çok 200 m. */
export function stillRadiusM(accuracy: number): number {
  const T = MOTION_THRESHOLDS;
  return Math.min(T.STILL_RADIUS_MAX_M, Math.max(T.STILL_RADIUS_M, 2 * Math.max(0, accuracy)));
}

/** Uyku çiti yarıçapı: 100–150 m (doğruluk kötüyse büyür). */
export function sleepGeofenceRadiusM(accuracy: number): number {
  const T = MOTION_THRESHOLDS;
  return Math.round(Math.min(T.SLEEP_GEOFENCE_MAX_M, Math.max(T.SLEEP_GEOFENCE_MIN_M, 1.5 * Math.max(0, accuracy))));
}

const isVehicle = (s: MotionState) => s === 'driving' || s === 'fast';
const bandIndex = (b: MovingBand) => MOVING_BANDS.indexOf(b);

/** Hızdan bant; mevcut banda göre histerezisli eşik. */
export function speedBand(speed: number, current: MotionState): MovingBand {
  const B = MOTION_THRESHOLDS.BANDS;
  const cur = (MOVING_BANDS as readonly string[]).includes(current) ? bandIndex(current as MovingBand) : -1;
  // Her eşik için: mevcut bant eşiğin üstündeyse aşağı dönüş değeri, altındaysa yukarı geçiş değeri geçerli.
  const above = (band: Exclude<MovingBand, 'walking'>) => {
    const idx = bandIndex(band);
    const t = B[band];
    return speed >= (cur >= idx ? t.down : t.up);
  };
  if (above('fast')) return 'fast';
  if (above('driving')) return 'driving';
  if (above('cycling')) return 'cycling';
  if (above('running')) return 'running';
  return 'walking';
}

/** OS etkinliğinin hareket bandı karşılığı. */
function osBand(activity: ActivityState): MovingBand | null {
  switch (activity) {
    case 'walking':
      return 'walking';
    case 'running':
      return 'running';
    case 'cycling':
      return 'cycling';
    case 'automotive':
      return 'driving';
    default:
      return null;
  }
}

/** OS etkinliği ile hız bandını birleştirir: hız güçlü kanıttır, OS belirsiz aralıkta ayırt eder. */
function combineBand(speedB: MovingBand | null, os: MovingBand | null): MovingBand | null {
  if (!os) return speedB;
  if (!speedB) return os;
  if (os === 'driving') return isVehicle(speedB) ? speedB : 'driving'; // araçta yavaş akış
  if (os === 'cycling') return isVehicle(speedB) ? speedB : 'cycling';
  // yürüme/koşu: hız araç düzeyindeyse OS gecikmiştir, hıza güven.
  return bandIndex(speedB) >= bandIndex('cycling') ? speedB : os;
}

/** Hareket durumu → pakete giden `activity_state` (RTDB sözleşmesi değişmez; 'fast' → 'automotive'). */
export function motionToActivity(state: MotionState): ActivityState {
  switch (state) {
    case 'stationary':
      return 'still';
    case 'driving':
    case 'fast':
      return 'automotive';
    default:
      return state;
  }
}

/**
 * Durum makinesi adımı. `now` olay zamanından bağımsız saat (zamanlayıcı/tick için); olaylar sırayla verilmeli.
 */
export function motionReducer(m: MotionMachine, event: MotionEvent, now: EpochMs): MotionResult {
  const T = MOTION_THRESHOLDS;
  let next: MotionMachine = { ...m };

  const go = (to: MotionState, reason: MotionTransitionReason, extra: Partial<MotionResult> = {}): MotionResult => {
    if (to === m.state) return { machine: next, ...extra };
    const leavingStill = m.state === 'stationary';
    next = { ...next, state: to, since: now, candidate: null };
    const res: MotionResult = { machine: next, transition: { from: m.state, to, reason }, ...extra };
    if (leavingStill && to !== 'stationary') {
      next.geofence = null;
      next.osStillSince = null;
      res.machine = next;
      res.clearGeofence = true;
    }
    return res;
  };

  const enterStill = (reason: MotionTransitionReason): MotionResult => {
    const ref = pickCentre(next.anchor, next.lastFix);
    const fence: SleepGeofence | null = ref ? { lat: ref.lat, lng: ref.lng, radiusM: sleepGeofenceRadiusM(ref.accuracy) } : null;
    next = { ...next, geofence: fence, candidate: null };
    const res = go('stationary', reason);
    if (fence) res.setGeofence = fence;
    return res;
  };

  const osStillDue = (): boolean => {
    if (next.osStillSince === null) return false;
    const need = isVehicle(m.state) ? T.OS_STILL_ENTER_FROM_VEHICLE_MS : T.OS_STILL_ENTER_MS;
    return now - next.osStillSince >= need;
  };

  const stillWindowDue = (): boolean => !!next.anchor && now - next.anchor.at >= T.STILL_ENTER_MS;

  switch (event.type) {
    case 'activity': {
      if (event.activity === 'still') {
        // Yalnızca yüksek güvenli "still" sayaç başlatır; orta/düşük güven hiçbir şeyi değiştirmez.
        if (event.confidence === 'high' && next.osStillSince === null) next.osStillSince = event.at;
        if (m.state !== 'stationary' && osStillDue()) return enterStill('os_still');
        return { machine: next };
      }
      const band = osBand(event.activity);
      if (!band || event.confidence === 'low') return { machine: next };
      next.osStillSince = null;
      next.osMoving = { activity: event.activity, at: event.at };
      if (m.state === 'stationary' || m.state === 'unknown') {
        next.anchor = null;
        const speedB = next.lastFix?.speed_mps != null && now - next.lastFix.at <= T.OS_ACTIVITY_TTL_MS
          ? speedBand(next.lastFix.speed_mps, m.state)
          : null;
        return go(combineBand(speedB, band) ?? band, 'os_activity');
      }
      // Hareket hâlindeyken OS bandı aday olarak değerlendirilir (bekleme süresiyle).
      return considerBand(combineBand(null, band), 'os_activity');
    }

    case 'geofence_exit': {
      next.osStillSince = null;
      next.anchor = null;
      if (m.state !== 'stationary') return { machine: { ...next, geofence: null } };
      return go('unknown', 'geofence_exit');
    }

    case 'tick': {
      if (m.state === 'stationary') return { machine: next };
      if (osStillDue()) return enterStill('os_still');
      // Örnek gelmiyor (mesafe filtresi bastırıyor) ve son bilinen hız düşük → hareket yok sayılır.
      // Araç/bisiklet bandında örnek yokluğu tünel/GPS kaybı olabilir: sabite GEÇİLMEZ.
      const slow = !next.lastFix || next.lastFix.speed_mps === null || next.lastFix.speed_mps < T.MOVING_MIN_MPS;
      const osSaysMoving = next.osMoving !== null && now - next.osMoving.at <= T.OS_ACTIVITY_TTL_MS;
      if (stillWindowDue() && slow && !osSaysMoving && (m.state === 'walking' || m.state === 'running' || m.state === 'unknown')) {
        return enterStill('no_movement');
      }
      return { machine: next };
    }

    case 'fix': {
      const fix: MotionSample = { lat: event.lat, lng: event.lng, accuracy: event.accuracy, speed_mps: event.speed_mps, at: event.at };
      next.lastFix = fix;
      if (fix.accuracy > T.MAX_DECISION_ACCURACY_M) return { machine: next };

      if (m.state === 'stationary') {
        const centre = next.geofence ?? next.anchor;
        if (centre && haversineM(centre, fix) > stillRadiusM(fix.accuracy)) {
          next.anchor = fix;
          const b = fix.speed_mps !== null && fix.speed_mps >= T.MOVING_MIN_MPS ? speedBand(fix.speed_mps, 'unknown') : 'unknown';
          return go(b, 'displacement_exit');
        }
        return { machine: next };
      }

      // Sabitlik penceresi: çapadan yarıçap dışına çıkan örnek pencereyi yeniden başlatır.
      if (!next.anchor || haversineM(next.anchor, fix) > stillRadiusM(Math.max(fix.accuracy, next.anchor.accuracy))) {
        next.anchor = fix;
      }
      const movingFast = fix.speed_mps !== null && fix.speed_mps >= T.MOVING_MIN_MPS;
      // GPS hızı OS "still" ile çelişiyorsa (sıkışık trafikte sürünme) OS sayacı sıfırlanır.
      if (movingFast) next.osStillSince = null;
      if (osStillDue()) return enterStill('os_still');
      if (stillWindowDue() && !movingFast) return enterStill('displacement_still');

      if (fix.speed_mps === null) return { machine: next };
      if (!movingFast) {
        // Durdu ama henüz sabit değil: bant korunur (yalnızca yürüme/koşu "yürüme"ye iner).
        if (m.state === 'unknown') return { machine: next };
        return considerBand(m.state === 'running' ? 'walking' : null, 'speed');
      }
      const os = next.osMoving && now - next.osMoving.at <= T.OS_ACTIVITY_TTL_MS ? osBand(next.osMoving.activity) : null;
      const band = combineBand(speedBand(fix.speed_mps, m.state), os);
      if (m.state === 'unknown' && band) return go(band, 'speed');
      return considerBand(band, 'speed');
    }
  }

  function considerBand(band: MovingBand | null, reason: MotionTransitionReason): MotionResult {
    if (!band || band === m.state) {
      next.candidate = null;
      return { machine: next };
    }
    const cand = next.candidate && next.candidate.band === band ? next.candidate : { band, since: now };
    next.candidate = cand;
    const cur = (MOVING_BANDS as readonly string[]).includes(m.state) ? bandIndex(m.state as MovingBand) : -1;
    const up = bandIndex(band) > cur;
    const dwell = up ? T.UPSHIFT_DWELL_MS : isVehicle(m.state) ? T.DOWNSHIFT_FROM_VEHICLE_DWELL_MS : T.DOWNSHIFT_DWELL_MS;
    if (now - cand.since >= dwell) return go(band, reason);
    return { machine: next };
  }
}

/** Çit merkezi: iki adaydan doğruluğu iyi olan. */
function pickCentre(a: MotionSample | null, b: MotionSample | null): MotionSample | null {
  if (!a) return b;
  if (!b) return a;
  return b.accuracy <= a.accuracy ? b : a;
}
