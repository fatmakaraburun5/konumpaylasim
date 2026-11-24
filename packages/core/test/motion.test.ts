import { describe, expect, it } from 'vitest';
import {
  MINUTE,
  MOTION_THRESHOLDS,
  SECOND,
  initialMotion,
  motionReducer,
  motionToActivity,
  sleepGeofenceRadiusM,
  speedBand,
  stillRadiusM,
  type ActivityState,
  type MotionEvent,
  type MotionMachine,
  type MotionResult,
} from '../src';

const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);
const BASE = { lat: 41.0082, lng: 28.9784 };
/** Kuzeye `m` metre. */
const north = (m: number) => ({ lat: BASE.lat + m / 111_320, lng: BASE.lng });

function run(events: Array<[number, MotionEvent]>, start: MotionMachine = initialMotion(T0)) {
  let m = start;
  const results: MotionResult[] = [];
  for (const [at, ev] of events) {
    const r = motionReducer(m, ev, at);
    results.push(r);
    m = r.machine;
  }
  return { m, results, transitions: results.flatMap((r) => (r.transition ? [r.transition] : [])) };
}

const fix = (at: number, dM: number, speed: number | null, accuracy = 10): [number, MotionEvent] => [
  at,
  { type: 'fix', ...north(dM), accuracy, speed_mps: speed, at },
];
const act = (at: number, activity: ActivityState, confidence: 'low' | 'medium' | 'high' = 'high'): [number, MotionEvent] => [
  at,
  { type: 'activity', activity, confidence, at },
];

describe('yardımcılar', () => {
  it('sabitlik yarıçapı doğrulukla büyür, tavanlıdır', () => {
    expect(stillRadiusM(5)).toBe(60);
    expect(stillRadiusM(50)).toBe(100);
    expect(stillRadiusM(500)).toBe(200);
    expect(sleepGeofenceRadiusM(10)).toBe(100);
    expect(sleepGeofenceRadiusM(90)).toBe(135);
    expect(sleepGeofenceRadiusM(400)).toBe(150);
  });

  it('hız bantları histerezisli', () => {
    expect(speedBand(1.4, 'unknown')).toBe('walking');
    expect(speedBand(12, 'unknown')).toBe('driving');
    expect(speedBand(25, 'unknown')).toBe('fast');
    // 18 m/s: araçtan hızlıya geçmez (eşik 19,4), hızlıdan araca da düşmez (dönüş 16,7).
    expect(speedBand(18, 'driving')).toBe('driving');
    expect(speedBand(18, 'fast')).toBe('fast');
    expect(speedBand(7.5, 'driving')).toBe('driving');
    expect(speedBand(7.5, 'cycling')).toBe('cycling');
  });

  it("hareket durumu pakette Faz 1 etkinliğine eşlenir ('fast' → 'automotive')", () => {
    expect(motionToActivity('stationary')).toBe('still');
    expect(motionToActivity('fast')).toBe('automotive');
    expect(motionToActivity('driving')).toBe('automotive');
    expect(motionToActivity('walking')).toBe('walking');
  });
});

describe('sabite giriş', () => {
  it('yer değiştirme 60 m içinde 4 dk kalınca sabit + uyku çiti', () => {
    const evs: Array<[number, MotionEvent]> = [];
    for (let s = 0; s <= 4 * 60; s += 30) evs.push(fix(T0 + s * SECOND, (s % 60) / 3, 0.1, 15));
    const { m, transitions, results } = run(evs);
    expect(m.state).toBe('stationary');
    expect(transitions.at(-1)?.reason).toBe('displacement_still');
    const fence = results.find((r) => r.setGeofence)?.setGeofence;
    expect(fence).toBeDefined();
    expect(fence!.radiusM).toBeGreaterThanOrEqual(100);
    expect(fence!.radiusM).toBeLessThanOrEqual(150);
    expect(m.geofence).toEqual(fence);
  });

  it('3,5 dk yetmez; yarıçap dışına çıkan örnek pencereyi sıfırlar', () => {
    const { m } = run([fix(T0, 0, 0, 10), fix(T0 + 3.5 * MINUTE, 20, 0, 10)]);
    expect(m.state).not.toBe('stationary');
    const r2 = run([fix(T0, 0, 0, 10), fix(T0 + 2 * MINUTE, 90, 0, 10), fix(T0 + 4.5 * MINUTE, 95, 0, 10)]);
    expect(r2.m.state).not.toBe('stationary'); // pencere 2. dk'da yeniden başladı
    const r3 = run([fix(T0, 0, 0, 10), fix(T0 + 2 * MINUTE, 90, 0, 10), fix(T0 + 6.1 * MINUTE, 95, 0, 10)]);
    expect(r3.m.state).toBe('stationary');
  });

  it('kötü doğrulukta (80 m) 120 m titreme sabitliği bozmaz', () => {
    const { m } = run([fix(T0, 0, null, 80), fix(T0 + 2 * MINUTE, 120, null, 80), fix(T0 + 4 * MINUTE, 10, null, 80)]);
    expect(m.state).toBe('stationary');
  });

  it('OS yüksek güvenle "still" → 2 dk sonra sabit; düşük/orta güven saymaz', () => {
    const hi = run([act(T0, 'still', 'high'), [T0 + 119 * SECOND, { type: 'tick', at: T0 + 119 * SECOND }], [T0 + 2 * MINUTE, { type: 'tick', at: T0 + 2 * MINUTE }]]);
    expect(hi.transitions).toHaveLength(1);
    expect(hi.transitions[0]).toMatchObject({ to: 'stationary', reason: 'os_still' });
    const lo = run([act(T0, 'still', 'medium'), [T0 + 10 * MINUTE, { type: 'tick', at: T0 + 10 * MINUTE }]]);
    expect(lo.m.state).toBe('unknown');
  });

  it('araçtan OS "still" ile giriş 4 dk ister (kırmızı ışık / trafik)', () => {
    const driving = { ...initialMotion(T0, 'driving') };
    const r = run([act(T0, 'still', 'high'), [T0 + 3 * MINUTE, { type: 'tick', at: T0 + 3 * MINUTE }]], driving);
    expect(r.m.state).toBe('driving');
    const r2 = run([act(T0, 'still', 'high'), [T0 + 4 * MINUTE, { type: 'tick', at: T0 + 4 * MINUTE }]], driving);
    expect(r2.m.state).toBe('stationary');
  });

  it('araçta örnek gelmemesi (tünel) sabite geçirmez', () => {
    const r = run([fix(T0, 0, 15, 5), act(T0, 'automotive'), [T0 + 10 * MINUTE, { type: 'tick', at: T0 + 10 * MINUTE }]]);
    expect(r.m.state).toBe('driving');
  });

  it('yürürken örnek gelmemesi (mesafe filtresi) ve düşük hız → sabit', () => {
    const r = run([fix(T0, 0, 0.3, 10), [T0 + 5 * MINUTE, { type: 'tick', at: T0 + 5 * MINUTE }]], initialMotion(T0, 'walking'));
    expect(r.m.state).toBe('stationary');
    expect(r.transitions[0]?.reason).toBe('no_movement');
  });
});

describe('sabitten çıkış', () => {
  const still = () => run([act(T0, 'still', 'high'), fix(T0 + 30 * SECOND, 0, 0, 10), [T0 + 3 * MINUTE, { type: 'tick', at: T0 + 3 * MINUTE }]]).m;

  it('OS hareket etkinliği (orta güven) çıkarır ve çiti kaldırır', () => {
    const r = motionReducer(still(), { type: 'activity', activity: 'walking', confidence: 'medium', at: T0 + 10 * MINUTE }, T0 + 10 * MINUTE);
    expect(r.transition).toMatchObject({ from: 'stationary', to: 'walking', reason: 'os_activity' });
    expect(r.clearGeofence).toBe(true);
    expect(r.machine.geofence).toBeNull();
  });

  it('düşük güvenli etkinlik çıkarmaz', () => {
    const r = motionReducer(still(), { type: 'activity', activity: 'automotive', confidence: 'low', at: T0 + 10 * MINUTE }, T0 + 10 * MINUTE);
    expect(r.machine.state).toBe('stationary');
  });

  it('uyku çiti çıkışı çıkarır', () => {
    const r = motionReducer(still(), { type: 'geofence_exit', at: T0 + 10 * MINUTE }, T0 + 10 * MINUTE);
    expect(r.transition).toMatchObject({ to: 'unknown', reason: 'geofence_exit' });
    expect(r.clearGeofence).toBe(true);
  });

  it('çit merkezinden max(60 m, 2×doğruluk) ötede örnek çıkarır; içindeki titreme çıkarmaz', () => {
    const s = still();
    const inside = motionReducer(s, { type: 'fix', ...north(55), accuracy: 10, speed_mps: 1.2, at: T0 + 10 * MINUTE }, T0 + 10 * MINUTE);
    expect(inside.machine.state).toBe('stationary');
    const noisy = motionReducer(s, { type: 'fix', ...north(90), accuracy: 50, speed_mps: null, at: T0 + 10 * MINUTE }, T0 + 10 * MINUTE);
    expect(noisy.machine.state).toBe('stationary');
    const out = motionReducer(s, { type: 'fix', ...north(75), accuracy: 10, speed_mps: 1.4, at: T0 + 10 * MINUTE }, T0 + 10 * MINUTE);
    expect(out.transition).toMatchObject({ to: 'walking', reason: 'displacement_exit' });
  });
});

describe('hareket bantları', () => {
  it('yürüme → araç → hızlı (otoyol) ve geri; kırmızı ışık banttan düşürmez', () => {
    const evs: Array<[number, MotionEvent]> = [];
    let t = T0;
    let d = 0;
    const go = (sec: number, speed: number) => {
      for (let s = 0; s < sec; s += 5) {
        t += 5 * SECOND;
        d += speed * 5;
        evs.push(fix(t, d, speed, 5));
      }
    };
    go(60, 1.4);
    go(60, 13);
    go(30, 0); // kırmızı ışık
    go(60, 26);
    go(120, 12);
    const { m, transitions } = run(evs);
    expect(transitions.map((x) => x.to)).toEqual(['walking', 'driving', 'fast', 'driving']);
    expect(m.state).toBe('driving');
  });

  it('OS "automotive" yavaş araç hızında (6 m/s) bisiklet yerine araç seçtirir', () => {
    const r = run([act(T0, 'automotive'), fix(T0 + 5 * SECOND, 0, 6, 5), fix(T0 + 20 * SECOND, 90, 6, 5)]);
    expect(r.m.state).toBe('driving');
  });

  it('bant yükseltme 10 sn, araçtan düşüş 90 sn bekler', () => {
    const start = initialMotion(T0, 'walking');
    const up = run([fix(T0, 0, 13, 5), fix(T0 + 5 * SECOND, 65, 13, 5)], start);
    expect(up.m.state).toBe('walking');
    const up2 = run([fix(T0, 0, 13, 5), fix(T0 + 11 * SECOND, 140, 13, 5)], start);
    expect(up2.m.state).toBe('driving');
    const car = initialMotion(T0, 'driving');
    const down = run([act(T0, 'walking'), fix(T0 + 60 * SECOND, 0, 1.4, 5)], car);
    expect(down.m.state).toBe('driving');
    const down2 = run([act(T0, 'walking'), fix(T0 + 30 * SECOND, 0, 1.4, 5), fix(T0 + 121 * SECOND, 100, 1.4, 5)], car);
    expect(down2.m.state).toBe('walking');
  });

  it('eşikler belgelenen değerlerde', () => {
    expect(MOTION_THRESHOLDS.STILL_RADIUS_M).toBe(60);
    expect(MOTION_THRESHOLDS.STILL_ENTER_MS).toBe(4 * MINUTE);
    expect(MOTION_THRESHOLDS.OS_STILL_ENTER_MS).toBe(2 * MINUTE);
  });
});
