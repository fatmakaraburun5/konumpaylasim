/**
 * Hata veren Firestore / RTDB dinleyicisini geri çekilmeli olarak yeniden abone eder.
 *
 * Firebase dinleyicisi bir hata (izin, App Check token'ı hazır değil, kural dağıtımı, geçici ağ) verdiğinde
 * KALICI olarak kapanır; yeniden abone olunmazsa harita / paylaşım kartı oturum boyunca boş kalırdı.
 * Burada: hata → abonelik bırakılır → 2 sn, 5 sn, 15 sn, 30 sn, 60 sn (üst sınır) sonra yeniden denenir.
 * `resubscribeNow()` (uygulama öne gelince / bağlantı dönünce) bekleyen denemeyi hemen yapar.
 * İlk veri gelince geri çekilme sıfırlanır.
 */

/** [Varsayım] Geri çekilme adımları; son değer üst sınırdır. */
export const LISTENER_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

export interface ListenerHandlers {
  /** Dinleyici veri verdi (sağlıklı). */
  ok: () => void;
  /** Dinleyici hata verdi (kapandı). */
  error: (e: Error) => void;
}

export interface ResilientListener {
  resubscribeNow: () => void;
  dispose: () => void;
  readonly failing: boolean;
}

export interface ResilientListenerOptions {
  onStatus?: (name: string, healthy: boolean, error?: Error) => void;
  backoffMs?: readonly number[];
}

export function resilientListener(
  name: string,
  subscribe: (h: ListenerHandlers) => () => void,
  opts: ResilientListenerOptions = {},
): ResilientListener {
  const steps = opts.backoffMs ?? LISTENER_BACKOFF_MS;
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let generation = 0;
  let failing = false;
  let disposed = false;

  const start = () => {
    if (disposed) return;
    const gen = ++generation;
    try {
      const u = subscribe({
        ok: () => {
          if (gen !== generation) return;
          attempt = 0;
          if (failing) {
            failing = false;
            opts.onStatus?.(name, true);
          }
        },
        error: (e) => {
          if (gen !== generation || disposed) return;
          fail(e);
        },
      });
      // Abonelik sırasında senkron hata verdiyse dönen aboneliği hemen bırak.
      if (gen !== generation) u();
      else unsub = u;
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  };

  const fail = (e: Error) => {
    if (__DEV__) console.warn(`[konum] dinleyici hatası (${name})`, e.message);
    generation++; // bu aboneliğe ait geç gelen olaylar yok sayılır
    const u = unsub;
    unsub = null;
    try {
      u?.();
    } catch {
      // zaten kapanmış
    }
    failing = true;
    opts.onStatus?.(name, false, e);
    if (timer) return;
    const delay = steps[Math.min(attempt, steps.length - 1)] ?? 60_000;
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      start();
    }, delay);
  };

  start();

  return {
    get failing() {
      return failing;
    },
    resubscribeNow: () => {
      if (disposed || !failing || !timer) return;
      clearTimeout(timer);
      timer = null;
      start();
    },
    dispose: () => {
      disposed = true;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      unsub?.();
      unsub = null;
    },
  };
}
