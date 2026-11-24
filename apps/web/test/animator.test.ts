import { describe, expect, it } from 'vitest';
import { MARKER_MOTION, haversineM, interpolateLatLng } from '@konum/core';
import { MarkerAnimator } from '../src/viewer/animator';

const A = { lat: 40.98712, lng: 29.02561 };
const B = { lat: 40.98689, lng: 29.02634 }; // ~66 m
const FAR = { lat: 41.1, lng: 29.1 }; // > 2 km

describe('MarkerAnimator (core markerTransition + interpolateLatLng)', () => {
  it('ilk konum doğrudan yerleşir', () => {
    const a = new MarkerAnimator();
    expect(a.positionAt(0)).toBeNull();
    expect(a.push({ ...A, timestamp: 1_000 }, 0)).toEqual({ kind: 'snap', reason: 'first' });
    expect(a.positionAt(0)).toEqual(A);
    expect(a.isAnimating(0)).toBe(false);
  });

  it('yakın yeni konuma örnekler arası süre kadar (300 ms – 2 sn) yumuşak kayar', () => {
    const a = new MarkerAnimator();
    a.push({ ...A, timestamp: 0 }, 0);
    const t = a.push({ ...B, timestamp: 5_000 }, 100);
    expect(t).toEqual({ kind: 'animate', durationMs: MARKER_MOTION.maxDurationMs });
    expect(a.positionAt(100)).toEqual(A);
    const mid = a.positionAt(100 + 1_000)!;
    expect(mid).toEqual(interpolateLatLng(A, B, 0.5));
    expect(haversineM(A, mid)).toBeGreaterThan(0);
    expect(haversineM(mid, B)).toBeGreaterThan(0);
    expect(a.isAnimating(100 + 1_000)).toBe(true);
    expect(a.positionAt(100 + 2_000)).toEqual(B);
    expect(a.isAnimating(100 + 2_000)).toBe(false);
  });

  it('kısa ara en az 300 ms sürer', () => {
    const a = new MarkerAnimator();
    a.push({ ...A, timestamp: 0 }, 0);
    expect(a.push({ ...B, timestamp: 100 }, 0)).toEqual({ kind: 'animate', durationMs: MARKER_MOTION.minDurationMs });
  });

  it('animasyon ortasında yeni konum: GÖRÜNEN konumdan devam eder (geri sıçrama yok)', () => {
    const a = new MarkerAnimator();
    a.push({ ...A, timestamp: 0 }, 0);
    a.push({ ...B, timestamp: 5_000 }, 0);
    const shown = a.positionAt(1_000)!;
    const C = { lat: 40.98661, lng: 29.02702 };
    a.push({ ...C, timestamp: 10_000 }, 1_000);
    expect(a.positionAt(1_000)).toEqual(shown);
    expect(a.positionAt(3_000)).toEqual(C);
  });

  it('> 2 km sıçrama ve > 120 sn ara doğrudan konumlanır', () => {
    const a = new MarkerAnimator();
    a.push({ ...A, timestamp: 0 }, 0);
    expect(a.push({ ...FAR, timestamp: 5_000 }, 0)).toEqual({ kind: 'snap', reason: 'jump' });
    expect(a.positionAt(0)).toEqual(FAR);
    const b = new MarkerAnimator();
    b.push({ ...A, timestamp: 0 }, 0);
    expect(b.push({ ...B, timestamp: 121_000 }, 0)).toEqual({ kind: 'snap', reason: 'gap' });
    expect(b.positionAt(0)).toEqual(B);
  });

  it('"hareketi azalt" açıkken hep doğrudan', () => {
    const a = new MarkerAnimator();
    a.push({ ...A, timestamp: 0 }, 0);
    a.push({ ...B, timestamp: 5_000 }, 0, true);
    expect(a.positionAt(0)).toEqual(B);
    expect(a.isAnimating(0)).toBe(false);
  });

  it('eski ya da aynı örnek yok sayılır', () => {
    const a = new MarkerAnimator();
    a.push({ ...B, timestamp: 5_000 }, 0);
    expect(a.push({ ...A, timestamp: 1_000 }, 10)).toBeNull();
    expect(a.push({ ...B, timestamp: 5_000 }, 10)).toBeNull();
    expect(a.positionAt(10)).toEqual(B);
  });

  it('reset sonrası yeniden ilk konum', () => {
    const a = new MarkerAnimator();
    a.push({ ...A, timestamp: 0 }, 0);
    a.reset();
    expect(a.positionAt(0)).toBeNull();
    expect(a.push({ ...B, timestamp: 1 }, 0)).toEqual({ kind: 'snap', reason: 'first' });
  });
});
