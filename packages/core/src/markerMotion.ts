/**
 * Haritadaki kişi işaretçisinin (Marker) yumuşak hareketi. Saf hesap; çizim platformdadır:
 *  - iOS / Android (react-native-maps): `markerTransition` → `animate` ise
 *    `AnimatedRegion.timing({ duration })` / `animateMarkerToCoordinate(coord, duration)`, `snap` ise doğrudan konum.
 *  - Web: `requestAnimationFrame` içinde `interpolateLatLng(a, b, animationProgress(...))`.
 *
 * Kural: yeni konum gelince işaretçi bir önceki konumdan yenisine, iki örnek arasındaki süre
 * kadar (300 ms – 2 sn) kayar. Çok uzak sıçrama (> 2 km), uzun ara (> 120 sn) veya ilk konumda
 * animasyon yapılmaz: harita boyunca "uçan" pin yanıltıcıdır.
 */
import { haversineM, type LatLng } from './geo';
import { clamp, type EpochMs } from './time';

export interface MotionFix extends LatLng {
  /** Örneğin alındığı an (paketteki `timestamp`). */
  timestamp: EpochMs;
}

export const MARKER_MOTION = {
  /** Bundan uzun sıçramada animasyon yok. */
  snapDistanceM: 2_000,
  /** İki örnek arası bundan uzunsa animasyon yok (eski konumdan "kayma" yanıltır). */
  snapGapMs: 120_000,
  minDurationMs: 300,
  maxDurationMs: 2_000,
} as const;

export type MarkerTransition =
  | { kind: 'animate'; durationMs: number }
  | { kind: 'snap'; reason: 'first' | 'jump' | 'gap' };

/**
 * Önceki ve yeni konuma göre geçiş türü. Daha ESKİ bir örneği (sıra dışı gelen) çağıran
 * atmalıdır; yine de gelirse en kısa süreyle animasyon döner.
 */
export function markerTransition(prev: MotionFix | null | undefined, next: MotionFix): MarkerTransition {
  if (!prev) return { kind: 'snap', reason: 'first' };
  if (haversineM(prev, next) > MARKER_MOTION.snapDistanceM) return { kind: 'snap', reason: 'jump' };
  const gap = next.timestamp - prev.timestamp;
  if (gap > MARKER_MOTION.snapGapMs) return { kind: 'snap', reason: 'gap' };
  return { kind: 'animate', durationMs: Math.round(clamp(gap, MARKER_MOTION.minDurationMs, MARKER_MOTION.maxDurationMs)) };
}

/** Kübik ease-in-out: 0 → 0, 0.5 → 0.5, 1 → 1; uçlarda yavaş, ortada hızlı. */
export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

const wrapLng = (lng: number): number => {
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lng > 0 ? 180 : w;
};

/**
 * a → b arası konum; `t` doğrusal ilerleme (0..1), yumuşatma içeride uygulanır.
 * Boylam 180. meridyeni kısa yoldan geçer.
 */
export function interpolateLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  const e = easeInOutCubic(t);
  let dLng = b.lng - a.lng;
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;
  return { lat: a.lat + (b.lat - a.lat) * e, lng: wrapLng(a.lng + dLng * e) };
}

/** Animasyon başlangıcından bu yana doğrusal ilerleme (0..1). */
export function animationProgress(startedAt: EpochMs, durationMs: number, now: EpochMs): number {
  if (durationMs <= 0) return 1;
  return clamp((now - startedAt) / durationMs, 0, 1);
}

/** a'dan b'ye ilk yön (büyük daire), gerçek kuzeye göre 0 ≤ derece < 360. Aynı noktada 0. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  if (y === 0 && x === 0) return 0;
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return deg >= 360 ? 0 : deg;
}
