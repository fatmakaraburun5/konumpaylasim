/**
 * Faz 3: uyarlamalı takibin JS ayaktayken çalışan parçaları.
 *
 *  - Zamanlayıcı (`TICK_MS`): hareket makinesine `tick` verir (örnek gelmese de "sabit"e geçiş süresi dolsun) ve
 *    uyku modunda (GPS kapalı, seyrek istek) kalp atışı zamanı gelince tek seferlik ölçüm aldırır (pipeline).
 *  - OS hareket etkinliği aboneliği (modules/konum-activity; bayrak + izin + modül varsa).
 *
 * Başlatan: sharingCoordinator (paylaşım başlayınca), backgroundTask.ts (başsız uyanış). Paylaşım kalmayınca
 * zamanlayıcı kendini durdurur. iOS'ta uygulama konum oturumuyla arka planda ayakta kaldıkça, Android'de ön plan
 * servisi sürdükçe zamanlayıcı çalışır. [Varsayım: Android başsız bağlamda JS zamanlayıcıları FGS sürerken çalışır]
 */
import { getServerOffsetMs } from '../../../lib/clock';
import { loadTargets } from '../../../state/persist';
import { handleMotionEvent } from '../pipeline';
import { subscribeActivity, toMotionActivityEvent } from './activitySource';

export const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let activityUnsub: (() => void) | null = null;
let activityStarting = false;

async function tick(): Promise<void> {
  const persisted = await loadTargets();
  if (!persisted.uid || (persisted.targets.length === 0 && persisted.linkTargets.length === 0)) {
    stopAdaptiveRuntime();
    return;
  }
  await handleMotionEvent({ type: 'tick' });
}

/** Tekrar çağrılabilir: zaten çalışıyorsa bir şey yapmaz. */
export function ensureAdaptiveRuntime(): void {
  if (!timer) timer = setInterval(() => void tick().catch(() => undefined), TICK_MS);
  if (!activityUnsub && !activityStarting) {
    activityStarting = true;
    void subscribeActivity((e) => void handleMotionEvent(toMotionActivityEvent(e, getServerOffsetMs())))
      .then((unsub) => {
        if (unsub && !timer) unsub(); // bu arada durduruldu
        else activityUnsub = unsub;
      })
      .catch(() => undefined)
      .finally(() => {
        activityStarting = false;
      });
  }
}

export function stopAdaptiveRuntime(): void {
  if (timer) clearInterval(timer);
  timer = null;
  activityUnsub?.();
  activityUnsub = null;
}

export function isAdaptiveRuntimeRunning(): boolean {
  return timer !== null;
}
