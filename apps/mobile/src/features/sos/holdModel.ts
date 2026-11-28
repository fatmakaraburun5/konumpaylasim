/**
 * SOS basılı tutma motorunun saf kuralları (bileşen ve testler aynı sayıları kullanır).
 *
 *  - İlerleme ZAMANA bağlıdır (`requestAnimationFrame` her karede `holdProgressAt` ile hesaplar); kare kaçsa ya da
 *    üst bileşen yeniden çizilse de ilerleme kaybolmaz, çünkü başlangıç anı bileşen içinde (ref) tutulur.
 *  - Erken bırakma: ilerleme anında sıfırlanmaz, `REWIND_MS × p` sürede akıcı biçimde geri sarılır. Geri sarma
 *    sırasında yeniden basılırsa kalan yerden devam eder (`resumeStart`).
 *  - %100'de TEK SEFER tetiklenir; parmak kalkana ve `COOLDOWN_MS` geçene kadar yeni tetikleme yok.
 */
import { SOS_LIMITS } from '@konum/core';

export const HOLD_MS = SOS_LIMITS.holdMs;
/** Tam ilerlemenin geri sarılma süresi (kısmi ilerleme orantılı daha kısa). */
export const REWIND_MS = 300;
/** Tetiklemeden sonra yeni tetiklemeye kapalı süre (çift basma / titreyen el). */
export const COOLDOWN_MS = 1_500;
/** Parmak düğme sınırından bu kadar dışarı kaysa da basılı tutma sürer (dp/px). */
export const HOLD_SLOP = 56;
/** Küçük düğmenin dokunma alanını büyütür. */
export const HOLD_HIT_SLOP = 12;

export const holdProgressAt = (startedAt: number, now: number): number => Math.min(1, Math.max(0, (now - startedAt) / HOLD_MS));

/** Geri sarma: `from` ilerlemesinden `rewindStartedAt` anından itibaren 0'a. */
export const rewindProgressAt = (from: number, rewindStartedAt: number, now: number): number =>
  Math.max(0, from - (now - rewindStartedAt) / REWIND_MS);

/** Kalan ilerlemeden devam etmek için sanal başlangıç anı. */
export const resumeStart = (progress: number, now: number): number => now - progress * HOLD_MS;

/** Kilit: akış boşta (ya da hata) değilse ve son tetiklemeden bu yana `COOLDOWN_MS` geçmediyse basış yok sayılır. */
export function canStartHold(opts: { locked: boolean; lastTriggerAt: number | null; now: number }): boolean {
  if (opts.locked) return false;
  return opts.lastTriggerAt === null || opts.now - opts.lastTriggerAt >= COOLDOWN_MS;
}
