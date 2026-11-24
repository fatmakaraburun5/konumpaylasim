import { describe, expect, it } from 'vitest';
import {
  MARKER_MOTION,
  animationProgress,
  bearingDeg,
  easeInOutCubic,
  haversineM,
  interpolateLatLng,
  markerTransition,
  type MotionFix,
} from '../src';

const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);
const fix = (lat: number, lng: number, dtMs = 0): MotionFix => ({ lat, lng, timestamp: T0 + dtMs });

describe('markerTransition', () => {
  const a = fix(41.0, 29.0);

  it('ilk konum: anında yerleş', () => {
    expect(markerTransition(null, a)).toEqual({ kind: 'snap', reason: 'first' });
    expect(markerTransition(undefined, a)).toEqual({ kind: 'snap', reason: 'first' });
  });

  it('süre = örnekler arası süre, 300 ms – 2 sn aralığında', () => {
    expect(markerTransition(a, fix(41.0001, 29.0, 100))).toEqual({ kind: 'animate', durationMs: 300 });
    expect(markerTransition(a, fix(41.0001, 29.0, 1_000))).toEqual({ kind: 'animate', durationMs: 1_000 });
    expect(markerTransition(a, fix(41.0001, 29.0, 5_000))).toEqual({ kind: 'animate', durationMs: 2_000 });
    expect(markerTransition(a, fix(41.0001, 29.0, 120_000))).toEqual({ kind: 'animate', durationMs: 2_000 });
    // sıra dışı (eski) örnek: en kısa animasyon
    expect(markerTransition(a, fix(41.0001, 29.0, -5_000))).toEqual({ kind: 'animate', durationMs: MARKER_MOTION.minDurationMs });
  });

  it('2 km üstü sıçrama veya 120 sn üstü ara: animasyon yok', () => {
    const far = fix(41.02, 29.0, 10_000); // ~2.2 km kuzey
    expect(haversineM(a, far)).toBeGreaterThan(2_000);
    expect(markerTransition(a, far)).toEqual({ kind: 'snap', reason: 'jump' });
    const near = fix(41.017, 29.0, 10_000); // ~1.9 km
    expect(haversineM(a, near)).toBeLessThan(2_000);
    expect(markerTransition(a, near).kind).toBe('animate');
    expect(markerTransition(a, fix(41.0001, 29.0, 120_001))).toEqual({ kind: 'snap', reason: 'gap' });
  });
});

describe('interpolateLatLng', () => {
  const a = { lat: 41.0, lng: 29.0 };
  const b = { lat: 41.01, lng: 29.02 };

  it('uçlar ve orta nokta', () => {
    expect(interpolateLatLng(a, b, 0)).toEqual(a);
    const end = interpolateLatLng(a, b, 1);
    expect(end.lat).toBeCloseTo(b.lat, 12);
    expect(end.lng).toBeCloseTo(b.lng, 12);
    const mid = interpolateLatLng(a, b, 0.5);
    expect(mid.lat).toBeCloseTo(41.005, 12);
    expect(mid.lng).toBeCloseTo(29.01, 12);
  });

  it('ease-in-out: başta ve sonda yavaş', () => {
    const q = interpolateLatLng(a, b, 0.25);
    expect(q.lat - a.lat).toBeLessThan((b.lat - a.lat) * 0.25);
    const r = interpolateLatLng(a, b, 0.75);
    expect(r.lat - a.lat).toBeGreaterThan((b.lat - a.lat) * 0.75);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
    // monoton
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = easeInOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('t aralık dışında sınırlanır', () => {
    expect(interpolateLatLng(a, b, -3)).toEqual(a);
    expect(interpolateLatLng(a, b, 7).lat).toBeCloseTo(b.lat, 12);
  });

  it('180. meridyeni kısa yoldan geçer', () => {
    const p = interpolateLatLng({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 0.5);
    expect(Math.abs(p.lng)).toBeCloseTo(180, 9);
    const q = interpolateLatLng({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 0.75);
    expect(q.lng).toBeLessThan(-179);
    expect(q.lng).toBeGreaterThan(-180);
  });
});

describe('animationProgress', () => {
  it('0..1', () => {
    expect(animationProgress(T0, 1_000, T0 - 10)).toBe(0);
    expect(animationProgress(T0, 1_000, T0 + 500)).toBe(0.5);
    expect(animationProgress(T0, 1_000, T0 + 5_000)).toBe(1);
    expect(animationProgress(T0, 0, T0)).toBe(1);
  });
});

describe('bearingDeg', () => {
  const o = { lat: 41, lng: 29 };
  it('ana yönler', () => {
    expect(bearingDeg(o, { lat: 41.01, lng: 29 })).toBeCloseTo(0, 6);
    expect(bearingDeg(o, { lat: 41, lng: 29.01 })).toBeCloseTo(90, 1);
    expect(bearingDeg(o, { lat: 40.99, lng: 29 })).toBeCloseTo(180, 6);
    expect(bearingDeg(o, { lat: 41, lng: 28.99 })).toBeCloseTo(270, 1);
    expect(bearingDeg(o, o)).toBe(0);
  });
  it('her zaman [0, 360)', () => {
    for (let i = 0; i < 360; i += 7) {
      const rad = (i * Math.PI) / 180;
      const d = bearingDeg(o, { lat: o.lat + 0.01 * Math.cos(rad), lng: o.lng + 0.01 * Math.sin(rad) });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(360);
    }
  });
});
