/**
 * Realtime Database: alıcı gelen kutusu `live_locations/{uid}` ve sunucu saat farkı.
 *
 * Gizlilik:
 *  - Okuma kuralı yalnızca `auth.uid === $receiver_id`: kimse başkasının kutusunu dinleyemez.
 *  - Paylaşım bitince sunucu kaydı siler → `child_removed` → bellekteki konum hemen silinir.
 *  - Disk kalıcılığı kapalıdır (bkz. init.ts); konum hiçbir zaman AsyncStorage'a yazılmaz.
 *
 * Çevrimdışı yazma: RTDB çevrimdışıyken `update()` yazmayı kuyruğa alır ve söz bağlantı dönene kadar
 * bekler. Konum hattı sıralı çalıştığı için bu, sonraki örnekleri ve süre dolunca takibi kapatmayı da
 * bekletirdi. Bu yüzden: `.info/connected` izlenir, bağlantı yokken yazma HİÇ yapılmaz ve her yazma
 * zaman aşımına bağlanır. Bağlıyken başlayıp zaman aşımına uğrayan yazma SDK kuyruğunda kalabilir;
 * bağlantı dönünce gönderilse de RTDB kuralı 2 dakikadan eski örneği reddeder. [Varsayım: doğrulanmalı]
 */
import { parseDelivered, PATHS, type DeliveredLocation, type EpochMs, type ShareId, type UserId } from '@konum/core';
import {
  getDatabase,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onValue,
  ref,
  update,
  type DataSnapshot,
} from '@react-native-firebase/database';

export interface InboxHandlers {
  onUpsert: (loc: DeliveredLocation) => void;
  onRemove: (shareId: ShareId) => void;
  onError?: (e: Error) => void;
}

export function listenInbox(uid: UserId, h: InboxHandlers): () => void {
  const inbox = ref(getDatabase(), PATHS.liveInbox(uid));
  const handle = (snap: DataSnapshot) => {
    const loc = parseDelivered(snap.val());
    // Anahtar ile içerik tutarsızsa (bozuk/sahte yazma) yok say.
    if (!loc || loc.share_id !== snap.key) return;
    h.onUpsert(loc);
  };
  const cancel = (e: Error) => h.onError?.(e);
  const subs = [
    onChildAdded(inbox, handle, cancel),
    onChildChanged(inbox, handle, cancel),
    onChildRemoved(
      inbox,
      (snap) => {
        if (snap.key) h.onRemove(snap.key);
      },
      cancel,
    ),
  ];
  return () => subs.forEach((u) => u());
}

// --- Faz 3: çevrimdışı iz (live_trail/{ben}/{share_id}/{point_id}) ------------------------------

/** Alıcının elindeki iz noktası (gönderen çevrimdışıyken kaydedilip sonradan eşitlenen). */
export interface TrailFix {
  id: string;
  lat: number;
  lng: number;
  accuracy: number;
  /** Ölçüm anı (sunucu saati). */
  timestamp: EpochMs;
  server_ts: EpochMs;
  battery_pct: number | null;
  q: 1;
}

const POINT_ID_RE = /^\d{13}-\d{3}$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Bozuk noktalar sessizce atılır; sıralı (eskiden yeniye). */
export function parseTrail(raw: unknown): TrailFix[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: TrailFix[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!POINT_ID_RE.test(id) || !v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    if (!num(p.lat) || !num(p.lng) || !num(p.accuracy) || !num(p.timestamp) || !num(p.server_ts)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) continue;
    out.push({
      id,
      lat: p.lat,
      lng: p.lng,
      accuracy: p.accuracy,
      timestamp: p.timestamp,
      server_ts: p.server_ts,
      battery_pct: num(p.battery_pct) ? p.battery_pct : null,
      q: 1,
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export interface TrailHandlers {
  onTrail: (shareId: ShareId, points: TrailFix[]) => void;
  onRemove: (shareId: ShareId) => void;
  onError?: (e: Error) => void;
}

/** Okuma kuralı yalnızca alıcı (backend Faz 3). Paylaşım bitince sunucu düğümü siler → `onRemove`. */
export function listenTrail(uid: UserId, h: TrailHandlers): () => void {
  const root = ref(getDatabase(), `live_trail/${uid}`);
  const handle = (snap: DataSnapshot) => {
    if (snap.key) h.onTrail(snap.key, parseTrail(snap.val()));
  };
  const cancel = (e: Error) => h.onError?.(e);
  const subs = [
    onChildAdded(root, handle, cancel),
    onChildChanged(root, handle, cancel),
    onChildRemoved(
      root,
      (snap) => {
        if (snap.key) h.onRemove(snap.key);
      },
      cancel,
    ),
  ];
  return () => subs.forEach((u) => u());
}

/** `.info/serverTimeOffset`: sunucu - cihaz (ms). */
export function listenServerTimeOffset(cb: (offsetMs: number) => void, onError?: (e: Error) => void): () => void {
  return onValue(
    ref(getDatabase(), PATHS.serverTimeOffset),
    (snap) => {
      const v = Number(snap.val());
      cb(Number.isFinite(v) ? v : 0);
    },
    (e) => onError?.(e),
  );
}

// --- bağlantı durumu ------------------------------------------------------------------------

const CONNECTED_PATH = '.info/connected';
let connected = false;
let connectedUnsub: (() => void) | null = null;
const connectedListeners = new Set<(c: boolean) => void>();

function ensureConnectedListener(): void {
  if (connectedUnsub) return;
  connectedUnsub = onValue(ref(getDatabase(), CONNECTED_PATH), (snap) => {
    const next = snap.val() === true;
    if (next === connected) return;
    connected = next;
    for (const l of connectedListeners) l(next);
  });
}

export function isConnected(): boolean {
  return connected;
}

/** RTDB bağlantı değişimleri (yeniden bağlanınca bekleyen durdurmalar ve dinleyiciler tazelenir). */
export function listenConnected(cb: (connected: boolean) => void): () => void {
  ensureConnectedListener();
  connectedListeners.add(cb);
  return () => connectedListeners.delete(cb);
}

/** Bağlıysa hemen, değilse en çok `timeoutMs` boyunca bağlantıyı bekler (başsız soğuk açılışta bağlantı birkaç yüz ms sürer). */
export function waitForConnection(timeoutMs: number): Promise<boolean> {
  ensureConnectedListener();
  if (connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(timer);
      connectedListeners.delete(onChange);
      resolve(v);
    };
    const onChange = (c: boolean) => {
      if (c) done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    connectedListeners.add(onChange);
  });
}

export class WriteTimeoutError extends Error {
  constructor() {
    super('RTDB yazması zaman aşımına uğradı');
    this.name = 'WriteTimeoutError';
  }
}

/** [Varsayım] Bağlıyken bir çok yollu yazmanın onayı için yeterli süre. */
export const WRITE_TIMEOUT_MS = 10_000;

/** Tek atomik çok yollu yazma (fan-out). Bir yol reddedilirse tamamı reddedilir. Zaman aşımı = hata. */
export function writeFanout(map: Record<string, unknown>, timeoutMs: number = WRITE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WriteTimeoutError()), timeoutMs);
    update(ref(getDatabase()), map).then(
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
