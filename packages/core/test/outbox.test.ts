import { describe, expect, it } from 'vitest';
import {
  DELIVERED_FIELDS,
  LINK_LIVE_FIELDS,
  LINK_TRAIL_ENABLED,
  MINUTE,
  OUTBOX_LIMITS,
  SECOND,
  TRAIL_FIELDS,
  ackOutbox,
  buildLinkLiveWrite,
  buildPackets,
  compactPoints,
  emptyOutbox,
  enqueueOutbox,
  flushBackoffMs,
  liveTrailPath,
  outboxPointId,
  parseDelivered,
  parseLinkLive,
  planFlush,
  toFanoutUpdate,
  toQueuedDeliveredWrite,
  toQueuedLinkWrite,
  trailBatchUpdate,
  type OutboxSample,
  type OutboxState,
  type OutboxTarget,
} from '../src';

const T0 = Date.UTC(2026, 10, 24, 15, 0, 0);
const share = (o: Partial<Extract<OutboxTarget, { kind: 'share' }>> = {}): Extract<OutboxTarget, { kind: 'share' }> => ({
  kind: 'share',
  share_id: 'alice_bob',
  receiver_id: 'bob',
  share_mode: 'weekly',
  expires_at: T0 + 7 * 24 * 60 * MINUTE,
  ...o,
});
const link: Extract<OutboxTarget, { kind: 'link' }> = {
  kind: 'link',
  token_hash: 'a'.repeat(43),
  share_mode: 'indefinite',
  expires_at: null,
  sender_name: 'Alice',
};
const sample = (i: number, o: Partial<OutboxSample> = {}): OutboxSample => ({
  lat: 41 + i * 0.0005,
  lng: 29,
  accuracy: 8,
  speed_mps: 12,
  heading: 0,
  activity_state: 'automotive',
  battery_pct: 50,
  is_charging: false,
  timestamp: T0 + i * 10 * SECOND,
  recorded_at: T0 + i * 10 * SECOND - 400,
  hb: 2 * MINUTE,
  ...o,
});
const fill = (n: number, targets: OutboxTarget[] = [share()], limits = {}) => {
  let s: OutboxState = emptyOutbox();
  for (let i = 0; i < n; i++) s = enqueueOutbox(s, sample(i), targets, T0 + i * 10 * SECOND, limits);
  return s;
};

describe('kuyruk kimliği ve ekleme', () => {
  it('kimlik zaman sıralı ve RTDB anahtarına uygun', () => {
    const a = outboxPointId(T0, 1);
    const b = outboxPointId(T0 + 1, 0);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^\d{13}-\d{3}$/);
    expect(a).not.toMatch(/[.#$[\]/]/);
  });

  it('sıralı tutar, aynı kimliği tekrar eklemez, hedefsiz noktayı almaz', () => {
    let s = fill(3);
    s = enqueueOutbox(s, sample(1, { timestamp: T0 + 15 * SECOND }), [share()], T0 + 30 * SECOND);
    expect(s.points.map((p) => p.timestamp)).toEqual([...s.points.map((p) => p.timestamp)].sort((x, y) => x - y));
    expect(enqueueOutbox(s, sample(9), [], T0)).toBe(s);
  });

  it('24 saatten eski nokta kaybolur (lost), tavanda sıkıştırma (thinned)', () => {
    const old = enqueueOutbox(fill(2), sample(3), [share()], T0 + OUTBOX_LIMITS.maxAgeMs + 30 * SECOND);
    expect(old.lost).toBe(2);
    const s = fill(130, [share()], { maxPoints: 100 });
    expect(s.points.length).toBeLessThanOrEqual(100);
    expect(s.thinned).toBeGreaterThan(0);
    expect(s.lost).toBe(0);
  });
});

describe('compactPoints', () => {
  it('ilk/son ve dönüş noktalarını korur, hedef sayıya iner', () => {
    // L şeklinde güzergâh: 100 nokta kuzeye, sonra 100 nokta doğuya.
    let s: OutboxState = emptyOutbox();
    const pts = [];
    for (let i = 0; i < 200; i++) {
      const north = i < 100;
      pts.push(sample(i, { lat: 41 + (north ? i : 99) * 0.0005, lng: 29 + (north ? 0 : i - 99) * 0.0007 }));
    }
    for (const p of pts) s = enqueueOutbox(s, p, [share()], p.timestamp, { maxPoints: 10_000 });
    const out = compactPoints(s.points, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out[0]).toBe(s.points[0]);
    expect(out.at(-1)).toBe(s.points.at(-1));
    expect(out).toContain(s.points[99]); // köşe
  });

  it('5 sn aralıklı sürüş verisi tavanı aşınca hedefin çok altına inmez (2001 → ~1000, ≤ 1500)', () => {
    const pts = [];
    for (let i = 0; i < 2001; i++) pts.push({ ...sample(i, { lat: 41 + i * 0.0005, lng: 29 + i * 0.0007 }), timestamp: T0 + i * 5 * SECOND, id: outboxPointId(T0 + i * 5 * SECOND, i % 1000), target_ids: ['s:alice_bob'] });
    const out = compactPoints(pts, OUTBOX_LIMITS.compactTarget);
    expect(out.length).toBeLessThanOrEqual(OUTBOX_LIMITS.compactTarget);
    expect(out.length).toBeGreaterThanOrEqual(900);
    expect(out[0]).toBe(pts[0]);
    expect(out.at(-1)).toBe(pts.at(-1));
  });
});

describe('planFlush', () => {
  it('hedef başına en yeni nokta canlıya (q:1, recorded_at), tümü ize; bağlantıya iz yazılmaz', () => {
    const s = fill(5, [share(), link]);
    const plan = planFlush(s, [share(), link], T0 + 2 * MINUTE);
    expect(LINK_TRAIL_ENABLED).toBe(false);
    expect(plan.liveWrites).toHaveLength(2);
    for (const w of plan.liveWrites) expect(w.point.id).toBe(s.points[4]!.id);
    expect(plan.trailBatches).toHaveLength(1);
    expect(plan.trailBatches[0]!.writes.every((w) => w.path.startsWith('live_trail/bob/alice_bob/'))).toBe(true);
    expect(plan.trailBatches[0]!.pointIds).toHaveLength(5);
    expect(plan.drop).toEqual([]);

    const live = toQueuedDeliveredWrite(plan.liveWrites[0]!.point, share(), 'alice');
    expect(live).toMatchObject({ q: 1, recorded_at: s.points[4]!.recorded_at, hb: 2 * MINUTE, share_id: 'alice_bob', sender_id: 'alice' });
    for (const k of Object.keys(live)) expect(DELIVERED_FIELDS).toContain(k);
    const lw = toQueuedLinkWrite(s.points[4]!, link);
    expect(lw).toMatchObject({ q: 1, sender_name: 'Alice' });
    expect(lw).not.toHaveProperty('recorded_at');
    for (const k of Object.keys(lw)) expect(LINK_LIVE_FIELDS).toContain(k);
    const update = trailBatchUpdate(plan.trailBatches[0]!);
    for (const v of Object.values(update)) for (const k of Object.keys(v)) expect(TRAIL_FIELDS).toContain(k);
  });

  it('bitmiş/geri alınmış hedef ve bitişten sonra kaydedilen nokta düşer', () => {
    const s = fill(6, [share(), link]);
    const expiring = share({ expires_at: T0 + 25 * SECOND }); // 0,1,2 geçerli; 3,4,5 bitişten sonra
    const plan = planFlush(s, [expiring], T0 + 20 * SECOND);
    expect(plan.trailBatches.flatMap((b) => b.pointIds)).toEqual(s.points.slice(0, 3).map((p) => p.id));
    expect(plan.drop).toEqual(s.points.slice(3).map((p) => p.id));
    // Bağlantı geri alındı, arkadaş paylaşımı bitti: her şey düşer.
    expect(planFlush(s, [], T0).drop).toHaveLength(6);
    // Paylaşım yeniden başlatıldıysa önceki noktalar yeni oturuma gitmez.
    expect(planFlush(s, [share({ started_at: T0 + 35 * SECOND })], T0 + MINUTE).drop).toHaveLength(4);
  });

  it('alıcıda daha yeni canlı nokta varsa canlıya yazılmaz (iz yine yazılır)', () => {
    const s = fill(3);
    const plan = planFlush(s, [share({ last_live_ts: T0 + 25 * SECOND })], T0 + MINUTE);
    expect(plan.liveWrites).toHaveLength(0);
    expect(plan.trailBatches[0]!.pointIds).toHaveLength(3);
  });

  it('partiler yol sınırına uyar, bir noktanın yolları bölünmez; ack idempotent', () => {
    const a = share();
    const b = share({ share_id: 'alice_carol', receiver_id: 'carol' });
    const s = fill(25, [a, b]);
    const plan = planFlush(s, [a, b], T0 + 5 * MINUTE, { maxPathsPerBatch: 7 });
    for (const batch of plan.trailBatches) {
      expect(batch.writes.length).toBeLessThanOrEqual(7);
      expect(batch.writes.length).toBe(batch.pointIds.length * 2);
    }
    expect(plan.trailBatches.flatMap((x) => x.pointIds)).toHaveLength(25);
    let q = ackOutbox(s, plan.trailBatches[0]!.pointIds);
    q = ackOutbox(q, plan.trailBatches[0]!.pointIds);
    expect(q.points).toHaveLength(25 - plan.trailBatches[0]!.pointIds.length);
    // Aynı parti iki kez planlanırsa aynı yollar: idempotent yazma.
    const again = planFlush(s, [a, b], T0 + 5 * MINUTE, { maxPathsPerBatch: 7 });
    expect(Object.keys(trailBatchUpdate(again.trailBatches[0]!))).toEqual(Object.keys(trailBatchUpdate(plan.trailBatches[0]!)));
    expect(liveTrailPath('bob', 'alice_bob', 'x')).toBe('live_trail/bob/alice_bob/x');
  });

  it('yalnızca bağlantı hedefli nokta iz partisine girmez, canlı yazmadan sonra silinir', () => {
    const s = fill(2, [link]);
    const plan = planFlush(s, [link], T0 + MINUTE);
    expect(plan.trailBatches).toHaveLength(0);
    expect(plan.liveOnlyPointIds).toHaveLength(2);
    expect(plan.liveWrites).toHaveLength(1);
  });
});

describe('geri çekilme', () => {
  it('üstel, tavanlı, titreşimli', () => {
    expect(flushBackoffMs(0, () => 0.5)).toBe(5_000);
    expect(flushBackoffMs(3, () => 0.5)).toBe(40_000);
    expect(flushBackoffMs(30, () => 0.5)).toBe(10 * MINUTE);
    expect(flushBackoffMs(2, () => 0)).toBe(15_000);
    expect(flushBackoffMs(2, () => 1)).toBe(25_000);
  });
});

describe('paket sözleşmesi (Faz 3 isteğe bağlı alanlar)', () => {
  const s = { lat: 41, lng: 29, accuracy: 5, speed_mps: 1, heading: 10, timestamp: T0, mocked: false };
  it('buildPackets hb/q/recorded_at taşır, yoksa hiç eklemez (Faz 2 ile aynı)', () => {
    const t = [{ share_id: 'alice_bob', receiver_id: 'bob', share_mode: 'timed' as const, expires_at: T0 + MINUTE }];
    const plain = toFanoutUpdate(buildPackets(s, { batteryLevel: 0.5, isCharging: false }, 'alice', t, T0));
    const v = Object.values(plain)[0]!;
    expect(v).not.toHaveProperty('hb');
    expect(v).not.toHaveProperty('q');
    const withHb = Object.values(toFanoutUpdate(buildPackets(s, { batteryLevel: 0.5, isCharging: false }, 'alice', t, T0, 'walking', { hb: 900_000.4 })))[0]!;
    expect(withHb.hb).toBe(900_000);
    const clamped = Object.values(toFanoutUpdate(buildPackets(s, { batteryLevel: 0.5, isCharging: false }, 'alice', t, T0, 'walking', { hb: 1 })))[0]!;
    expect(clamped.hb).toBe(10_000);
  });

  it('okuma: eksik alan undefined, bozuk alan paketi düşürmez', () => {
    const base = { v: 1, share_id: 'alice_bob', sender_id: 'alice', lat: 41, lng: 29, accuracy: 5, activity_state: 'still', timestamp: T0, share_mode: 'weekly', server_ts: T0 };
    expect(parseDelivered(base)?.hb).toBeUndefined();
    const p = parseDelivered({ ...base, hb: 'x', q: 2, recorded_at: T0 - 1 });
    expect(p).not.toBeNull();
    expect(p?.hb).toBeUndefined();
    expect(p?.q).toBeUndefined();
    expect(p?.recorded_at).toBe(T0 - 1);
    expect(parseDelivered({ ...base, hb: 120_000, q: 1 })).toMatchObject({ hb: 120_000, q: 1 });
  });

  it('bağlantı paketi hb/q taşır, recorded_at taşımaz', () => {
    const w = buildLinkLiveWrite(s, { batteryLevel: 0.4, isCharging: null }, { share_mode: 'weekly', expires_at: null, sender_name: 'A' }, { hb: 300_000, q: 1 });
    expect(w).toMatchObject({ hb: 300_000, q: 1 });
    const read = parseLinkLive({ ...w, server_ts: T0 });
    expect(read).toMatchObject({ hb: 300_000, q: 1 });
  });
});
