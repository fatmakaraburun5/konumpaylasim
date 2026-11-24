/**
 * Pin hareket planı (saf, test edilebilir): core `markerTransition` kararını platform adımına çevirir.
 *  - Sıra dışı (daha eski) örnek → yok say.
 *  - Aynı örnek tekrar geldi (yeniden bağlanma) → yok say.
 *  - İlk konum / > 2 km sıçrama / > 120 sn ara → anında konumlan (uçan pin yanıltır).
 *  - Aksi halde iki örnek arasındaki süre kadar (300 ms – 2 sn) kübik yumuşatmayla kay.
 */
import { markerTransition, type LatLng, type MotionFix } from '@konum/core';

export type MotionStep =
  | { kind: 'ignore' }
  | { kind: 'snap'; to: LatLng; reason: 'first' | 'jump' | 'gap' }
  | { kind: 'animate'; to: LatLng; durationMs: number };

export function planMarkerMove(prev: MotionFix | null, next: MotionFix): MotionStep {
  if (prev) {
    if (next.timestamp < prev.timestamp) return { kind: 'ignore' };
    if (next.timestamp === prev.timestamp && next.lat === prev.lat && next.lng === prev.lng) return { kind: 'ignore' };
  }
  const t = markerTransition(prev, next);
  if (t.kind === 'snap') return { kind: 'snap', to: { lat: next.lat, lng: next.lng }, reason: t.reason };
  return { kind: 'animate', to: { lat: next.lat, lng: next.lng }, durationMs: t.durationMs };
}

/**
 * 180. meridyeni kısa yoldan geçmek için animasyon hedef boylamı: |hedef - şimdiki| > 180 ise ±360.
 * Animasyon bitince gerçek (sarılmış) boylam yazılır.
 */
export function unwrapLng(currentLng: number, targetLng: number): number {
  const d = targetLng - currentLng;
  if (d > 180) return targetLng - 360;
  if (d < -180) return targetLng + 360;
  return targetLng;
}
