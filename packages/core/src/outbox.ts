/**
 * Faz 3: çevrimdışı kuyruk (outbox), saf mantık.
 *
 * Akış (mobil katman):
 *  1. `shouldPublish` "gönder" dediği her örnek, bağlantı yoksa ya da yazma başarısızsa `enqueueOutbox` ile
 *     kuyruğa girer (kalıcı depoda saklanır: uygulama öldürülse de kaybolmaz).
 *  2. Bağlantı gelince `planFlush(kuyruk, etkinHedefler, now)`:
 *     - `liveWrites`: hedef başına EN YENİ nokta → canlı düğüme `q: 1` + `recorded_at` ile (alıcıda
 *       "son doğrulanmış konum" anında düzelir). Hedefte daha yeni canlı nokta varsa yazılmaz.
 *     - `trailBatches`: tüm noktalar iz düğümüne, en çok `maxPathsPerBatch` yol/çağrı. Bir noktanın tüm
 *       yolları aynı partidedir: parti başarılıysa `ackOutbox(kuyruk, parti.pointIds)`.
 *     - `drop`: bitmiş/geri alınmış/süresi dolmuş hedeflerin noktaları ve hedefin bitişinden SONRA
 *       kaydedilmiş noktalar (gizlilik: bitmiş paylaşıma geriye dönük veri yazılmaz) → hemen silinir.
 *  3. Başarısız yazmada `flushBackoffMs(deneme)` kadar beklenir (üstel, tavanlı, titreşimli).
 *
 * İdempotentlik: nokta kimliği zamandan türetilir (`outboxPointId`), iz yolu `.../{point_id}`; aynı parti
 * iki kez yazılırsa aynı düğümün üstüne yazılır.
 *
 * Gizlilik kararı: QR bağlantılarına İZ YAZILMAZ (`LINK_TRAIL_ENABLED = false`). Anonim izleyici yalnızca
 * en son noktayı görür; çevrimdışı dönemin güzergâhı yalnızca arkadaş alıcılara (live_trail) gider.
 */
import { haversineM } from './geo';
import type { ShareMode } from './duration';
import type { ShareId, UserId } from './model';
import {
  LIVE_PACKET_VERSION,
  PACKET_LIMITS,
  SERVER_TIMESTAMP,
  type ActivityState,
  type DeliveredLocationWrite,
  type ServerTimestamp,
} from './packet';
import { linkSenderName, type LinkLiveLocationWrite } from './link';
import { HOUR, MINUTE, SECOND, type EpochMs } from './time';

export const OUTBOX_LIMITS = {
  /** Kuyruk tavanı; aşılınca sıkıştırma (seyreltme) yapılır. */
  maxPoints: 2_000,
  /** Sıkıştırma hedefi (her eklemede yeniden sıkıştırmamak için tavanın altı). */
  compactTarget: 1_500,
  /** Bundan eski nokta atılır (RTDB kuralı da `q: 1` için en çok 24 sa kabul eder). */
  maxAgeMs: PACKET_LIMITS.maxQueuedSampleAgeMs,
  /** Tek çok yollu yazmadaki en fazla yol. [Varsayım] */
  maxPathsPerBatch: 200,
} as const;

/** Bağlantılara iz yazılmaz (gizlilik). */
export const LINK_TRAIL_ENABLED = false;

/** Kuyruk noktası: kayıt anındaki hedeflerin kimlikleri ve örnek alanları. */
export interface OutboxPoint {
  /** Zaman tabanlı, sıralanabilir, RTDB anahtarına uygun kimlik. */
  id: string;
  /** Kayıt anında etkin hedeflerin kimlikleri (`outboxTargetId`). */
  target_ids: string[];
  lat: number;
  lng: number;
  accuracy: number;
  speed_mps: number | null;
  heading: number | null;
  activity_state: ActivityState;
  battery_pct: number | null;
  is_charging: boolean | null;
  /** Ölçüm anı, sunucu saatine çevrilmiş (paketteki `timestamp` ile aynı anlam). */
  timestamp: EpochMs;
  /** Ölçüm anı, cihaz saati (ham). */
  recorded_at: EpochMs;
  /** Kayıt anındaki `hb` (ms). */
  hb: number | null;
}

/** Arkadaş paylaşımı ya da QR bağlantısı. */
export type OutboxTarget =
  | {
      kind: 'share';
      share_id: ShareId;
      receiver_id: UserId;
      share_mode: ShareMode;
      expires_at: EpochMs | null;
      /** Alıcıda şu an duran canlı noktanın `timestamp`'i (biliniyorsa); daha eskisi canlıya yazılmaz. */
      last_live_ts?: EpochMs | null;
      /** Paylaşımın başladığı an: öncesinde kaydedilmiş nokta bu hedefe gitmez. */
      started_at?: EpochMs | null;
    }
  | {
      kind: 'link';
      token_hash: string;
      share_mode: ShareMode;
      expires_at: EpochMs | null;
      sender_name: string;
      last_live_ts?: EpochMs | null;
      started_at?: EpochMs | null;
    };

export const outboxTargetId = (t: OutboxTarget): string => (t.kind === 'share' ? `s:${t.share_id}` : `l:${t.token_hash}`);

/** 13 haneli zaman + 3 haneli sıra: sözlük sırası = zaman sırası; RTDB anahtarında yasak karakter yok. */
export function outboxPointId(timestamp: EpochMs, seq: number): string {
  return `${String(Math.max(0, Math.round(timestamp))).padStart(13, '0')}-${String(Math.abs(Math.trunc(seq)) % 1000).padStart(3, '0')}`;
}

export interface OutboxState {
  points: readonly OutboxPoint[];
  /** Kimlik çakışmasını önleyen artan sayaç. */
  seq: number;
  /** Sıkıştırmayla seyreltilen (bilinçli atılan) nokta sayısı. */
  thinned: number;
  /** Yaş/taşma nedeniyle KAYBEDİLEN nokta sayısı. */
  lost: number;
}

export const emptyOutbox = (): OutboxState => ({ points: [], seq: 0, thinned: 0, lost: 0 });

export type OutboxSample = Omit<OutboxPoint, 'id' | 'target_ids'>;

/** Noktayı ekler: yaşlıları atar, tavan aşılırsa sıkıştırır. Kuyruk `timestamp`'e göre sıralı kalır. */
export function enqueueOutbox(
  state: OutboxState,
  sample: OutboxSample,
  targets: readonly OutboxTarget[],
  now: EpochMs,
  limits: { maxPoints?: number; compactTarget?: number; maxAgeMs?: number } = {},
): OutboxState {
  const maxPoints = limits.maxPoints ?? OUTBOX_LIMITS.maxPoints;
  const compactTarget = limits.compactTarget ?? Math.min(OUTBOX_LIMITS.compactTarget, Math.floor(maxPoints * 0.75));
  const maxAgeMs = limits.maxAgeMs ?? OUTBOX_LIMITS.maxAgeMs;
  const target_ids = [...new Set(targets.map(outboxTargetId))];
  if (target_ids.length === 0) return state;
  const point: OutboxPoint = { ...sample, id: outboxPointId(sample.timestamp, state.seq), target_ids };

  let points = state.points.filter((p) => p.id !== point.id);
  let lost = state.lost;
  // Sıralı ekleme (geç teslim edilen toplu örnekler araya girebilir).
  let idx = points.length;
  while (idx > 0 && (points[idx - 1] as OutboxPoint).timestamp > point.timestamp) idx--;
  points = [...points.slice(0, idx), point, ...points.slice(idx)];

  const fresh = points.filter((p) => now - p.timestamp <= maxAgeMs);
  lost += points.length - fresh.length;
  points = fresh;

  let thinned = state.thinned;
  if (points.length > maxPoints) {
    const compacted = compactPoints(points, compactTarget);
    thinned += points.length - compacted.length;
    points = compacted;
  }
  return { points, seq: (state.seq + 1) % 1000, thinned, lost };
}

/**
 * Seyreltme: ilk/son ve dönüş noktaları korunur; zaman VE mesafe aralığı giderek büyütülerek hedef sayıya
 * inilir. Gürültü dönüş sayılmasın diye iki kenar da doğruluğun en az 2 katı ve 30 m olmalı.
 */
export function compactPoints(points: readonly OutboxPoint[], target: number): OutboxPoint[] {
  if (points.length <= target || points.length <= 2) return [...points];
  const turning = new Set<number>();
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1] as OutboxPoint;
    const b = points[i] as OutboxPoint;
    const c = points[i + 1] as OutboxPoint;
    const minEdge = Math.max(30, 2 * b.accuracy);
    if (haversineM(a, b) < minEdge || haversineM(b, c) < minEdge) continue;
    if (angleDiff(bearing(a, b), bearing(b, c)) >= 45) turning.add(i);
  }
  // Küçük aralıkla başla, ikiye katla: hedefin çok altına inmeden (5 sn'lik sürüş verisi 2000 → ~1000) seyrelt.
  let gapMs = 5 * SECOND;
  let gapM = 10;
  for (let round = 0; round < 14; round++) {
    const kept: OutboxPoint[] = [points[0] as OutboxPoint];
    let last = points[0] as OutboxPoint;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i] as OutboxPoint;
      if (turning.has(i) || (p.timestamp - last.timestamp >= gapMs && haversineM(last, p) >= gapM) || p.timestamp - last.timestamp >= gapMs * 4) {
        kept.push(p);
        last = p;
      }
    }
    kept.push(points[points.length - 1] as OutboxPoint);
    if (kept.length <= target) return kept;
    gapMs *= 2;
    gapM *= 2;
    if (round >= 8) turning.clear(); // dönüşler bile sığmıyorsa onları da seyrelt
  }
  // Son çare: eşit aralıklı örnekleme (ilk ve son korunur).
  const out: OutboxPoint[] = [];
  const step = (points.length - 1) / (target - 1);
  for (let k = 0; k < target; k++) out.push(points[Math.round(k * step)] as OutboxPoint);
  return out;
}

const toRad = (d: number) => (d * Math.PI) / 180;
function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const angleDiff = (x: number, y: number) => {
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};

/** Kuyruktan başarıyla yazılan noktaları çıkarır. */
export function ackOutbox(state: OutboxState, ids: readonly string[]): OutboxState {
  if (ids.length === 0) return state;
  const done = new Set(ids);
  return { ...state, points: state.points.filter((p) => !done.has(p.id)) };
}

// ---------------------------------------------------------------------------
// İz (trail) düğümü
// ---------------------------------------------------------------------------

/** `live_trail/{receiver_id}/{share_id}/{point_id}`: yalnızca arkadaş alıcılar, yalnızca kuyruk noktaları. */
export const liveTrailPath = (receiverId: UserId, shareId: ShareId, pointId: string): string =>
  `live_trail/${receiverId}/${shareId}/${pointId}`;

/** İz noktası (RTDB). Konum ve zaman dışında yalnızca pil; hız/yön/etkinlik iz için gerekmez. */
export interface TrailPoint {
  v: typeof LIVE_PACKET_VERSION;
  lat: number;
  lng: number;
  accuracy: number;
  /** Ölçüm anı (sunucu saati). */
  timestamp: EpochMs;
  recorded_at: EpochMs;
  battery_pct: number | null;
  q: 1;
  server_ts: EpochMs;
}

export type TrailPointWrite = {
  [K in keyof TrailPoint]?: K extends 'server_ts' ? ServerTimestamp : Exclude<TrailPoint[K], null>;
};

/** RTDB `live_trail` kuralının izin vermesi gereken alanlar. */
export const TRAIL_FIELDS = ['v', 'lat', 'lng', 'accuracy', 'timestamp', 'recorded_at', 'battery_pct', 'q', 'server_ts'] as const satisfies readonly (keyof TrailPoint)[];

export function toTrailWrite(p: OutboxPoint): TrailPointWrite {
  const out: TrailPointWrite = {
    v: LIVE_PACKET_VERSION,
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy,
    timestamp: p.timestamp,
    recorded_at: p.recorded_at,
    q: 1,
    server_ts: SERVER_TIMESTAMP,
  };
  if (p.battery_pct !== null) out.battery_pct = p.battery_pct;
  return out;
}

/** Kuyruk noktası → arkadaş canlı düğümü kopyası (`q: 1`). */
export function toQueuedDeliveredWrite(p: OutboxPoint, t: Extract<OutboxTarget, { kind: 'share' }>, senderId: UserId): DeliveredLocationWrite {
  const out: DeliveredLocationWrite = {
    v: LIVE_PACKET_VERSION,
    share_id: t.share_id,
    sender_id: senderId,
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy,
    activity_state: p.activity_state,
    timestamp: p.timestamp,
    share_mode: t.share_mode,
    server_ts: SERVER_TIMESTAMP,
    q: 1,
    recorded_at: p.recorded_at,
  };
  if (p.speed_mps !== null) out.speed_mps = p.speed_mps;
  if (p.heading !== null) out.heading = p.heading;
  if (p.battery_pct !== null) out.battery_pct = p.battery_pct;
  if (p.battery_pct !== null && p.is_charging !== null) out.is_charging = p.is_charging;
  if (t.expires_at !== null) out.expires_at = t.expires_at;
  if (p.hb !== null) out.hb = p.hb;
  return out;
}

/** Kuyruk noktası → bağlantı canlı düğümü kopyası (`q: 1`, iz yok). */
export function toQueuedLinkWrite(p: OutboxPoint, t: Extract<OutboxTarget, { kind: 'link' }>): LinkLiveLocationWrite {
  const out: LinkLiveLocationWrite = {
    v: LIVE_PACKET_VERSION,
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy,
    timestamp: p.timestamp,
    server_ts: SERVER_TIMESTAMP,
    sender_name: linkSenderName(t.sender_name),
    share_mode: t.share_mode,
    q: 1,
  };
  if (p.heading !== null) out.heading = p.heading;
  if (p.speed_mps !== null) out.speed_mps = p.speed_mps;
  if (p.battery_pct !== null) out.battery_pct = p.battery_pct;
  if (t.expires_at !== null) out.expires_at = t.expires_at;
  if (p.hb !== null) out.hb = p.hb;
  return out;
}

// ---------------------------------------------------------------------------
// Boşaltma planı
// ---------------------------------------------------------------------------

export interface FlushLiveWrite {
  target: OutboxTarget;
  point: OutboxPoint;
}

export interface FlushTrailWrite {
  target: Extract<OutboxTarget, { kind: 'share' }>;
  point: OutboxPoint;
  path: string;
}

export interface FlushBatch {
  writes: FlushTrailWrite[];
  /** Bu parti başarılıysa kuyruktan silinecek noktalar (tüm yolları bu partide). */
  pointIds: string[];
}

export interface FlushPlan {
  liveWrites: FlushLiveWrite[];
  trailBatches: FlushBatch[];
  /** Hiçbir geçerli hedefi kalmayan noktalar: yazılmadan silinir. */
  drop: string[];
  /** İz partisi olmayan ama canlıya yazılacak noktalar (yalnızca bağlantı hedefli): canlı yazma başarılıysa silinir. */
  liveOnlyPointIds: string[];
}

function pairAllowed(p: OutboxPoint, t: OutboxTarget, now: EpochMs, maxAgeMs: number): boolean {
  if (now - p.timestamp > maxAgeMs) return false;
  if (t.expires_at !== null && (t.expires_at <= now || p.timestamp >= t.expires_at)) return false;
  if (t.started_at != null && p.timestamp < t.started_at) return false;
  return true;
}

/**
 * Boşaltma planı. `activeTargets`: sunucunun HÂLÂ etkin dediği hedefler (bitmiş/geri alınmış olanlar listede
 * yoktur). İz yolları `liveTrailPath` ile kurulur; bağlantılara iz yazılmaz.
 */
export function planFlush(
  queue: OutboxState | readonly OutboxPoint[],
  activeTargets: readonly OutboxTarget[],
  now: EpochMs,
  opts: { maxPathsPerBatch?: number; maxAgeMs?: number } = {},
): FlushPlan {
  const points = Array.isArray(queue) ? (queue as readonly OutboxPoint[]) : (queue as OutboxState).points;
  const maxPaths = Math.max(1, opts.maxPathsPerBatch ?? OUTBOX_LIMITS.maxPathsPerBatch);
  const maxAgeMs = opts.maxAgeMs ?? OUTBOX_LIMITS.maxAgeMs;
  const byId = new Map(activeTargets.map((t) => [outboxTargetId(t), t] as const));

  const newest = new Map<string, FlushLiveWrite>();
  const drop: string[] = [];
  const liveOnly: string[] = [];
  const batches: FlushBatch[] = [];
  let cur: FlushBatch = { writes: [], pointIds: [] };

  for (const p of points) {
    const pairs = p.target_ids.map((id) => byId.get(id)).filter((t): t is OutboxTarget => !!t && pairAllowed(p, t, now, maxAgeMs));
    if (pairs.length === 0) {
      drop.push(p.id);
      continue;
    }
    for (const t of pairs) {
      const key = outboxTargetId(t);
      const prev = newest.get(key);
      if (!prev || p.timestamp >= prev.point.timestamp) newest.set(key, { target: t, point: p });
    }
    const trail: FlushTrailWrite[] = [];
    for (const t of pairs) {
      if (t.kind === 'share') trail.push({ target: t, point: p, path: liveTrailPath(t.receiver_id, t.share_id, p.id) });
    }
    if (trail.length === 0) {
      liveOnly.push(p.id);
      continue;
    }
    if (cur.writes.length > 0 && cur.writes.length + trail.length > maxPaths) {
      batches.push(cur);
      cur = { writes: [], pointIds: [] };
    }
    cur.writes.push(...trail);
    cur.pointIds.push(p.id);
  }
  if (cur.writes.length > 0) batches.push(cur);

  const liveWrites = [...newest.values()].filter(
    ({ target, point }) => target.last_live_ts == null || point.timestamp > target.last_live_ts,
  );
  return { liveWrites, trailBatches: batches, drop, liveOnlyPointIds: liveOnly };
}

/** Partinin RTDB çok yollu yazma haritası. */
export function trailBatchUpdate(batch: FlushBatch): Record<string, TrailPointWrite> {
  const update: Record<string, TrailPointWrite> = {};
  for (const w of batch.writes) update[w.path] = toTrailWrite(w.point);
  return update;
}

/**
 * Üstel geri çekilme: 5 sn, 10 sn, 20 sn … en çok 10 dk; ±%25 titreşim (`rand` 0..1, test için enjekte).
 */
export function flushBackoffMs(attempt: number, rand: () => number = Math.random, baseMs = 5 * SECOND, maxMs = 10 * MINUTE): number {
  const n = Math.max(0, Math.floor(attempt));
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(n, 20));
  const jitter = 0.75 + 0.5 * Math.min(1, Math.max(0, rand()));
  return Math.round(Math.min(maxMs, raw * jitter));
}

/** Kuyrukta bekleyen en eski noktanın yaşı (teşhis / "X dk'dır çevrimdışı" rozeti). */
export function outboxOldestAgeMs(state: OutboxState, now: EpochMs): number | null {
  const first = state.points[0];
  return first ? Math.max(0, now - first.timestamp) : null;
}

/** [Varsayım] Kuyruk 1 saati aşarsa gönderen tarafta "Çevrimdışısın, konumun kaydediliyor" uyarısı. */
export const OUTBOX_WARN_AGE_MS = HOUR;
