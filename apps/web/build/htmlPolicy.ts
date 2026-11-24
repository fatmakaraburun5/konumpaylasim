/**
 * Derlenen index.html'e yazılan güvenlik politikası (yalnızca `vite build`; geliştirme sunucusu HMR
 * için satır içi betik kullandığından dokunulmaz).
 *
 * Referrer:
 *   - Maps anahtarı yoksa `no-referrer` (Hosting `/s/**` başlığıyla aynı).
 *   - Maps anahtarı varsa `strict-origin`: HTTP referrer kısıtlı anahtar kaynağı (origin) görmek
 *     zorunda, yol (token) yine gitmez. [Varsayım] Hosting başlığı da `strict-origin` olmalı.
 *
 * CSP (meta): varsayılan her şey kapalı; yalnızca kendi kaynaklarımız, RTDB (WebSocket + uzun
 * yoklama) ve anahtar varsa Google Maps JS alanları. `frame-ancestors` meta ile verilemez (başlık).
 */

export interface HtmlPolicyInput {
  mapsKey: boolean;
  /** `VITE_FIREBASE_DATABASE_URL` (üretim); emülatörde null. */
  databaseUrl: string | null;
  /** RTDB emülatörü `host:port`; yoksa null. */
  emulatorHost: string | null;
}

export function referrerPolicy(i: Pick<HtmlPolicyInput, 'mapsKey'>): 'no-referrer' | 'strict-origin' {
  return i.mapsKey ? 'strict-origin' : 'no-referrer';
}

function dbHosts(databaseUrl: string | null): string[] {
  const hosts = ['*.firebaseio.com', '*.firebasedatabase.app'];
  if (databaseUrl) {
    const m = /^https:\/\/([^/?#]+)/.exec(databaseUrl);
    if (m && !hosts.some((h) => m[1]!.endsWith(h.slice(1)))) hosts.push(m[1]!);
  }
  return hosts;
}

/**
 * Google Maps JS için izin listesi: Google'ın "Content Security Policy" kılavuzundaki alanlar.
 * [Varsayım] gerçek anahtarla doğrulanmalı; kılavuz değişirse burası güncellenir.
 */
const MAPS = {
  script: ['https://*.googleapis.com', 'https://*.gstatic.com', 'https://*.google.com', 'https://*.ggpht.com', 'https://*.googleusercontent.com', "'unsafe-eval'", 'blob:'],
  img: ['https://*.googleapis.com', 'https://*.gstatic.com', 'https://*.google.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com'],
  connect: ['https://*.googleapis.com', 'https://*.google.com', 'https://*.gstatic.com', 'data:', 'blob:'],
  font: ['https://fonts.gstatic.com'],
  style: ['https://fonts.googleapis.com'],
  frame: ['https://*.google.com'],
  worker: ['blob:'],
};

export function contentSecurityPolicy(i: HtmlPolicyInput): string {
  const db = dbHosts(i.databaseUrl);
  const script = ["'self'", ...db.map((h) => `https://${h}`)];
  const connect = ["'self'", ...db.flatMap((h) => [`https://${h}`, `wss://${h}`])];
  const img = ["'self'", 'data:'];
  const style = ["'self'", "'unsafe-inline'"];
  const font = ["'self'"];
  const frame: string[] = [];
  const worker: string[] = [];
  if (i.emulatorHost) {
    connect.push(`http://${i.emulatorHost}`, `ws://${i.emulatorHost}`);
    script.push(`http://${i.emulatorHost}`);
  }
  if (i.mapsKey) {
    script.push(...MAPS.script);
    img.push(...MAPS.img);
    connect.push(...MAPS.connect);
    font.push(...MAPS.font);
    style.push(...MAPS.style);
    frame.push(...MAPS.frame);
    worker.push(...MAPS.worker);
  }
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'none'"]],
    ['script-src', script],
    ['connect-src', connect],
    ['img-src', img],
    ['style-src', style],
    ['font-src', font],
    ['manifest-src', ["'self'"]],
    ['frame-src', frame.length ? frame : ["'none'"]],
    ['worker-src', worker.length ? worker : ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}
