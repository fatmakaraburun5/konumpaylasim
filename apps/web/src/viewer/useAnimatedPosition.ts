/**
 * Yeni konum gelince pini önceki GÖRÜNEN konumdan yenisine kaydırır (requestAnimationFrame).
 * Karar core'dan (`markerTransition`): ilk konum, > 2 km sıçrama ya da > 120 sn ara → doğrudan.
 * "Hareketi azalt" açıksa her zaman doğrudan konumlanır.
 */
import { useEffect, useRef, useState } from 'react';
import type { LatLng, MotionFix } from '@konum/core';
import { MarkerAnimator } from './animator';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface AnimatedPosition {
  position: LatLng | null;
  animating: boolean;
}

export function useAnimatedPosition(fix: MotionFix | null): AnimatedPosition {
  const animator = useRef(new MarkerAnimator());
  const [state, setState] = useState<AnimatedPosition>({ position: null, animating: false });
  const lat = fix?.lat;
  const lng = fix?.lng;
  const ts = fix?.timestamp;

  useEffect(() => {
    if (lat === undefined || lng === undefined || ts === undefined) {
      animator.current.reset();
      setState({ position: null, animating: false });
      return;
    }
    const a = animator.current;
    a.push({ lat, lng, timestamp: ts }, performance.now(), prefersReducedMotion());
    let raf = 0;
    const frame = () => {
      const now = performance.now();
      const animating = a.isAnimating(now);
      setState({ position: a.positionAt(now), animating });
      if (animating) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [lat, lng, ts]);

  return state;
}
