/**
 * Web demo: RTDB gelen kutusu, sunucu saat farkı ve çok yollu yazma → bellek içi demo sunucusu.
 * Sunucu, `database.rules.json`'daki `live_locations` / `link_live` / `live_trail` kurallarını uygular (bkz. server.ts).
 * Sunucu saati = cihaz saati (fark 0).
 *
 * Faz 3:
 *  - Bağlantı simüledir (demo/web/network.ts, "Tünele gir"): çevrimdışıyken `.info/connected` false, yazmalar zaman
 *    aşımına düşer (sonradan UYGULANMAZ; noktalar uygulamanın kalıcı kuyruğundadır), dinleyiciler güncelleme almaz
 *    ve bağlantı gelince son durumu tek seferde alır (RTDB yeniden eşitlemesi gibi).
 *  - `listenTrail`: `live_trail/{ben}` (native ile aynı imza ve `parseTrail`).
 *  - Demo "Mehmet'in bağlantısı kopsun" düğümü ESKİ bir paketle yeniden kurar: düğümdeki `timestamp` geriye gittiyse
 *    (RTDB'de yalnızca silinip yeniden yazılan düğümde olur) önce `onRemove`, hemen ardından `onUpsert` iletilir.
 */
import { parseDelivered, type DeliveredLocation, type EpochMs, type ShareId, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { demoOnline, onDemoNetworkChange, waitDemoOnline } from '../../demo/web/network';
import { demoCurrentUid } from '../../demo/web/session';

export interface InboxHandlers {
  onUpsert: (loc: DeliveredLocation) => void;
  onRemove: (shareId: ShareId) => void;
  onError?: (e: Error) => void;
}

/**
 * Sunucu aboneliği + çevrimdışı tutma: bağlantı yokken gelen değerler bekletilir, bağlantı gelince en sonuncusu işlenir.
 */
function subscribeOnline<T>(compute: () => T, onValue: (v: T) => void): () => void {
  let pending: { v: T } | null = null;
  const unsub = demoServer().subscribe(compute, (v) => {
    if (demoOnline()) onValue(v);
    else pending = { v };
  });
  const unNet = onDemoNetworkChange((online) => {
    if (!online || !pending) return;
    const p = pending;
    pending = null;
    onValue(p.v);
  });
  return () => {
    unsub();
    unNet();
  };
}

export function listenInbox(uid: UserId, h: InboxHandlers): () => void {
  // RTDB child_added/changed/removed davranışı: önceki görüntüyle farkı ilet.
  let prev: Record<string, string> = {};
  let prevTs: Record<string, number> = {};
  return subscribeOnline(
    () => demoServer().inboxOf(uid),
    (inbox) => {
      const next: Record<string, string> = {};
      const nextTs: Record<string, number> = {};
      for (const [key, value] of Object.entries(inbox)) {
        const raw = JSON.stringify(value);
        next[key] = raw;
        if (prev[key] === raw) {
          if (prevTs[key] !== undefined) nextTs[key] = prevTs[key] as number;
          continue;
        }
        const loc = parseDelivered(value);
        if (!loc || loc.share_id !== key) continue;
        nextTs[key] = loc.timestamp;
        const before = prevTs[key];
        if (before !== undefined && loc.timestamp < before) h.onRemove(key); // düğüm yeniden kuruldu (demo zaman atlaması)
        h.onUpsert(loc);
      }
      for (const key of Object.keys(prev)) if (!(key in next)) h.onRemove(key);
      prev = next;
      prevTs = nextTs;
    },
  );
}

// --- Faz 3: çevrimdışı iz (live_trail/{ben}/{share_id}/{point_id}) ------------------------------

/** Alıcının elindeki iz noktası (native `liveRepo.ts` `TrailFix` ile aynı). */
export interface TrailFix {
  id: string;
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: EpochMs;
  server_ts: EpochMs;
  battery_pct: number | null;
  q: 1;
}

const POINT_ID_RE = /^\d{13}-\d{3}$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Native `parseTrail` ile aynı: bozuk noktalar sessizce atılır; sıralı (eskiden yeniye). */
export function parseTrail(raw: unknown): TrailFix[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: TrailFix[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!POINT_ID_RE.test(id) || !v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    if (!num(p.lat) || !num(p.lng) || !num(p.accuracy) || !num(p.timestamp) || !num(p.server_ts)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) continue;
    out.push({ id, lat: p.lat, lng: p.lng, accuracy: p.accuracy, timestamp: p.timestamp, server_ts: p.server_ts, battery_pct: num(p.battery_pct) ? p.battery_pct : null, q: 1 });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export interface TrailHandlers {
  onTrail: (shareId: ShareId, points: TrailFix[]) => void;
  onRemove: (shareId: ShareId) => void;
  onError?: (e: Error) => void;
}

/** Okuma kuralı yalnızca alıcı. Paylaşım bitince sunucu düğümü siler → `onRemove`. */
export function listenTrail(uid: UserId, h: TrailHandlers): () => void {
  let prev: Record<string, string> = {};
  return subscribeOnline(
    () => (demoCurrentUid() === uid ? demoServer().trailOf(uid) : {}),
    (byShare) => {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(byShare)) {
        const raw = JSON.stringify(value);
        next[key] = raw;
        if (prev[key] !== raw) h.onTrail(key, parseTrail(value));
      }
      for (const key of Object.keys(prev)) if (!(key in next)) h.onRemove(key);
      prev = next;
    },
  );
}

export function listenServerTimeOffset(cb: (offsetMs: number) => void, _onError?: (e: Error) => void): () => void {
  let live = true;
  const t = setTimeout(() => {
    if (live) cb(0);
  }, 0);
  return () => {
    live = false;
    clearTimeout(t);
  };
}

/** `.info/connected` (simüle). */
export function isConnected(): boolean {
  return demoOnline();
}

export function listenConnected(cb: (connected: boolean) => void): () => void {
  return onDemoNetworkChange(cb);
}

export function waitForConnection(timeoutMs: number): Promise<boolean> {
  return waitDemoOnline(timeoutMs);
}

export class WriteTimeoutError extends Error {
  constructor() {
    super('RTDB yazması zaman aşımına uğradı');
    this.name = 'WriteTimeoutError';
  }
}

export const WRITE_TIMEOUT_MS = 10_000;
/** Çevrimdışı yazma bu kadar sonra zaman aşımı verir (demo hattı uzun beklemesin). */
const OFFLINE_WRITE_FAIL_MS = 1_500;

export function writeFanout(map: Record<string, unknown>, timeoutMs: number = WRITE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!demoOnline()) {
      setTimeout(() => reject(new WriteTimeoutError()), Math.min(timeoutMs, OFFLINE_WRITE_FAIL_MS));
      return;
    }
    const timer = setTimeout(() => reject(new WriteTimeoutError()), timeoutMs);
    demoServer()
      .applyFanout(map, demoCurrentUid())
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
  });
}
