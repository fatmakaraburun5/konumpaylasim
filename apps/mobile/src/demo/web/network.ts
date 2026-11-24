/**
 * Web demo: simüle hücresel bağlantı (Faz 3 "Tünele gir"). Çevrimdışıyken:
 *  - RTDB `.info/connected` false (liveRepo.web.ts), yazmalar zaman aşımına düşer, dinleyiciler güncelleme almaz;
 *  - callable'lar `unavailable` ile başarısız olur (callTransport.web.ts);
 *  - push gelmez (push.web.ts bağlantı gelince iletir).
 * GPS çalışmaya devam eder: noktalar uygulamanın kalıcı kuyruğuna girer, bağlantı gelince eşitlenir.
 */
type Listener = (online: boolean) => void;

let online = true;
let tunnelUntil: number | null = null;
let tunnelTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l(online);
    } catch {
      // dinleyici hatası bağlantı durumunu etkilemez
    }
  }
}

export function demoOnline(): boolean {
  return online;
}

export function onDemoNetworkChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setDemoOnline(v: boolean): void {
  if (v && tunnelTimer) {
    clearTimeout(tunnelTimer);
    tunnelTimer = null;
    tunnelUntil = null;
  }
  if (online === v) return;
  online = v;
  emit();
}

/** "Tünele gir": `ms` boyunca bağlantı yok, sonra kendiliğinden gelir. */
export function startDemoTunnel(ms: number): void {
  if (tunnelTimer) clearTimeout(tunnelTimer);
  tunnelUntil = Date.now() + ms;
  tunnelTimer = setTimeout(() => {
    tunnelTimer = null;
    tunnelUntil = null;
    setDemoOnline(true);
  }, ms);
  if (online) {
    online = false;
    emit();
  } else emit();
}

/** Tünelden çıkışa kalan süre (tünelde değilse null). */
export function demoTunnelLeftMs(now: number = Date.now()): number | null {
  return tunnelUntil === null ? null : Math.max(0, tunnelUntil - now);
}

/** Bağlantıyı en çok `timeoutMs` bekler (RTDB `waitForConnection` karşılığı). */
export function waitDemoOnline(timeoutMs: number): Promise<boolean> {
  if (online) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      off();
      resolve(v);
    };
    const t = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    const off = onDemoNetworkChange((v) => {
      if (v) finish(true);
    });
  });
}
