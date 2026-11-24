/**
 * Pin hareketi (saf, saat dışarıdan): core `markerTransition` kararını verir, ara konum
 * `interpolateLatLng(a, b, animationProgress(...))` ile hesaplanır. Çizim requestAnimationFrame'dedir.
 *
 * Animasyon ortasında yeni konum gelirse kayma o anki GÖRÜNEN konumdan başlar (pin geri sıçramaz).
 */
import {
  animationProgress,
  interpolateLatLng,
  markerTransition,
  type LatLng,
  type MarkerTransition,
  type MotionFix,
} from '@konum/core';

export class MarkerAnimator {
  private target: MotionFix | null = null;
  private from: LatLng | null = null;
  private startedAt = 0;
  private durationMs = 0;

  /**
   * Yeni konum. `reduceMotion` (işletim sistemi "hareketi azalt") ise her zaman doğrudan konumlanır.
   * Daha eski örnek yok sayılır (null döner).
   */
  push(fix: MotionFix, now: number, reduceMotion = false): MarkerTransition | null {
    if (this.target && fix.timestamp < this.target.timestamp) return null;
    if (this.target && fix.timestamp === this.target.timestamp && fix.lat === this.target.lat && fix.lng === this.target.lng) {
      return null; // aynı paket (ör. sunucunun uzatma eşitlemesi): hareket yok
    }
    const t = markerTransition(this.target, fix);
    if (t.kind === 'animate' && !reduceMotion) {
      this.from = this.positionAt(now);
      this.startedAt = now;
      this.durationMs = t.durationMs;
    } else {
      this.from = null;
      this.durationMs = 0;
    }
    this.target = { lat: fix.lat, lng: fix.lng, timestamp: fix.timestamp };
    return t;
  }

  positionAt(now: number): LatLng | null {
    if (!this.target) return null;
    const done = { lat: this.target.lat, lng: this.target.lng };
    if (!this.from || this.durationMs <= 0) return done;
    const p = animationProgress(this.startedAt, this.durationMs, now);
    // Uçlarda tam değer: boylam sarma işlemindeki kayan nokta artığı pini hedefin yanına bırakmasın.
    if (p >= 1) return done;
    if (p <= 0) return { ...this.from };
    return interpolateLatLng(this.from, this.target, p);
  }

  isAnimating(now: number): boolean {
    return this.from !== null && this.durationMs > 0 && now - this.startedAt < this.durationMs;
  }

  reset(): void {
    this.target = null;
    this.from = null;
    this.durationMs = 0;
  }
}
