/**
 * YALNIZCA web: pinin yumuşak hareketi (native `useMarkerMotion.ts` → react-native-maps AnimatedRegion karşılığı).
 *
 * Aynı karar katmanı: `planMarkerMove` (core `markerTransition`): ilk konum / > 2 km sıçrama / > 120 sn ara →
 * anında; aksi halde iki örnek arasındaki süre kadar (300 ms – 2 sn). Çizim `requestAnimationFrame` içinde core
 * `interpolateLatLng(a, b, animationProgress(...))` ile (kübik yumuşatma, 180. meridyen kısa yoldan).
 * Hareket sürerken yeni konum gelirse pin O ANKİ yerinden yeni hedefe kayar (geri sıçrama yok).
 * "Hareketi azalt" tercihi açıksa animasyon yapılmaz.
 */
import { animationProgress, interpolateLatLng, type LatLng } from '@konum/core';
import { useEffect, useRef, useState } from 'react';
import { planMarkerMove } from './markerMotionPlan';

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function useAnimatedLatLng(lat: number, lng: number, timestamp: number | undefined): LatLng {
  const [pos, setPos] = useState<LatLng>({ lat, lng });
  const posRef = useRef<LatLng>(pos);
  const last = useRef<{ lat: number; lng: number; timestamp: number } | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const next = { lat, lng, timestamp: timestamp ?? Date.now() };
    const step = planMarkerMove(last.current, next);
    if (step.kind === 'ignore') return;
    last.current = next;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (step.kind === 'snap' || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      posRef.current = step.to;
      setPos(step.to);
      return;
    }
    const from = posRef.current;
    const t0 = performance.now();
    const tick = () => {
      const k = animationProgress(t0, step.durationMs, performance.now());
      const p = k >= 1 ? step.to : interpolateLatLng(from, step.to, k);
      posRef.current = p;
      setPos(p);
      frame.current = k < 1 ? requestAnimationFrame(tick) : null;
    };
    frame.current = requestAnimationFrame(tick);
  }, [lat, lng, timestamp]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return pos;
}
