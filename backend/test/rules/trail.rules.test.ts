/**
 * Faz 3 RTDB kuralları: `live_trail/{receiver}/{share_id}/{point_id}` (çevrimdışı dönemin noktaları) ve canlı
 * düğümlerdeki kuyruk (`q: 1`) noktalarının `started_at` alt sınırı. Yazmalar core outbox ile üretilir
 * (`enqueueOutbox` → `planFlush` → `trailBatchUpdate`), testler yalnızca alanları bozar.
 */
import { randomUUID } from 'node:crypto';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  HOUR,
  LINK_TRAIL_ENABLED,
  MINUTE,
  type OutboxSample,
  type OutboxTarget,
  SERVER_TIMESTAMP,
  buildLinkLiveWrite,
  emptyOutbox,
  enqueueOutbox,
  liveTrailPath,
  planFlush,
  shareId,
  toTrailWrite,
  trailBatchUpdate,
} from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rtdb } from '../../functions/src/admin';
import { SAMPLE_DEVICE, allowBattery, anonDb, cleanupRulesEnv, clientDb, deliveredFor, livePathOf, loadDatabaseRules, sampleAt } from '../helpers/emulator';

const uid = (p: string) => `${p}${randomUUID().slice(0, 8)}`;

interface Pair {
  id: string;
  sender_id: string;
  receiver_id: string;
  share_mode: 'timed' | 'indefinite';
  expires_at: number | null;
  started_at: number;
}

async function seedPair(opts: { expiresInMs?: number | null; startedAgoMs?: number; status?: 'active' | 'ended'; withStartedAt?: boolean } = {}): Promise<Pair> {
  const sender_id = uid('s');
  const receiver_id = uid('r');
  const id = shareId(sender_id, receiver_id);
  const expires_at = opts.expiresInMs === null ? null : Date.now() + (opts.expiresInMs ?? HOUR);
  const share_mode = expires_at === null ? 'indefinite' : 'timed';
  const started_at = Date.now() - (opts.startedAgoMs ?? 2 * HOUR);
  const acl: Record<string, unknown> =
    opts.status === 'ended'
      ? { status: 'ended', version: 2, ended_at: Date.now() }
      : { sender_id, receiver_id, status: 'active', share_mode, version: 1 };
  if (opts.status !== 'ended') {
    if (expires_at !== null) acl.expires_at = expires_at;
    if (opts.withStartedAt ?? true) acl.started_at = started_at;
  }
  await rtdb().ref(`share_acl/${id}`).set(acl);
  await allowBattery(sender_id);
  return { id, sender_id, receiver_id, share_mode, expires_at, started_at };
}

const shareTarget = (p: Pair): Extract<OutboxTarget, { kind: 'share' }> => ({
  kind: 'share',
  share_id: p.id,
  receiver_id: p.receiver_id,
  share_mode: p.share_mode,
  expires_at: p.expires_at,
  started_at: p.started_at,
});

const sample = (ts: number): OutboxSample => ({
  lat: 41.0082,
  lng: 28.9784,
  accuracy: 15,
  speed_mps: 0.4,
  heading: null,
  activity_state: 'walking',
  battery_pct: 42,
  is_charging: false,
  timestamp: ts,
  recorded_at: ts - 1_500,
  hb: 300_000,
});

/** Çevrimdışı dönemde `n` nokta kuyruğa alınır, sonra core planı ile iz partisi üretilir. */
function trailUpdate(p: Pair, times: number[]): { update: Record<string, unknown>; ids: string[] } {
  let q = emptyOutbox();
  for (const t of times) q = enqueueOutbox(q, sample(t), [shareTarget(p)], t);
  const plan = planFlush(q, [shareTarget(p)], Date.now());
  const batch = plan.trailBatches[0];
  if (!batch) throw new Error('iz partisi yok');
  return { update: trailBatchUpdate(batch) as Record<string, unknown>, ids: batch.pointIds };
}

const pointAt = (p: Pair, ts: number, seq = 1) => {
  const id = `${String(ts).padStart(13, '0')}-${String(seq).padStart(3, '0')}`;
  const value = toTrailWrite({ ...sample(ts), id, target_ids: [`s:${p.id}`] }) as Record<string, unknown>;
  return { path: liveTrailPath(p.receiver_id, p.id, id), value };
};

beforeAll(async () => {
  await loadDatabaseRules();
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('live_trail yazma / okuma', () => {
  it('gönderen core iz partisini yazar; yalnızca alıcı okur', async () => {
    const p = await seedPair();
    const now = Date.now();
    const { update, ids } = trailUpdate(p, [now - 20 * MINUTE, now - 15 * MINUTE, now - 10 * MINUTE]);
    expect(ids).toHaveLength(3);
    const sender = await clientDb(p.sender_id);
    await assertSucceeds(sender.ref().update(update));

    const receiver = await clientDb(p.receiver_id);
    const snap = await assertSucceeds(receiver.ref(`live_trail/${p.receiver_id}/${p.id}`).once('value'));
    expect(snap.numChildren()).toBe(3);
    const first = snap.child(ids[0] as string).val();
    expect(first).toMatchObject({ v: 1, q: 1, battery_pct: 42 });
    expect(typeof first.server_ts).toBe('number');
    // Gönderen, yabancı ve kimliksiz okuyamaz.
    await assertFails(sender.ref(`live_trail/${p.receiver_id}/${p.id}`).once('value'));
    await assertFails((await clientDb(uid('x'))).ref(`live_trail/${p.receiver_id}`).once('value'));
    await assertFails((await anonDb()).ref(`live_trail/${p.receiver_id}`).once('value'));
    await assertFails(receiver.ref('live_trail').once('value'));
  });

  it('alıcı ve yabancı iz yazamaz; üst düğüme toplu set reddedilir', async () => {
    const p = await seedPair();
    const pt = pointAt(p, Date.now() - 5 * MINUTE);
    for (const who of [p.receiver_id, uid('x')]) {
      await assertFails((await clientDb(who)).ref(pt.path).set(pt.value));
    }
    await assertFails((await anonDb()).ref(pt.path).set(pt.value));
    const sender = await clientDb(p.sender_id);
    const id = pt.path.split('/').pop() as string;
    await assertFails(sender.ref(`live_trail/${p.receiver_id}/${p.id}`).set({ [id]: pt.value }));
    // Başka alıcının yoluna (ACL'deki alıcı değil) yazamaz.
    await assertFails(sender.ref(liveTrailPath(uid('r'), p.id, id)).set(pt.value));
  });

  it('alan beyaz listesi ve nokta doğrulaması', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    const base = pointAt(p, Date.now() - 5 * MINUTE);
    const at = (v: Record<string, unknown>, path = base.path) => sender.ref(path).set(v);
    await assertSucceeds(at(base.value));
    await assertFails(at({ ...base.value, speed_mps: 3 })); // izde yok
    await assertFails(at({ ...base.value, q: 2 }));
    const { q: _q, ...noQ } = base.value;
    await assertFails(at(noQ));
    const { recorded_at: _r, ...noRec } = base.value;
    await assertFails(at(noRec));
    await assertFails(at({ ...base.value, server_ts: Date.now() - 1_000 }));
    await assertFails(at({ ...base.value, lat: 91 }));
    await assertFails(at({ ...base.value, accuracy: 5_000 }));
    await assertFails(at({ ...base.value, battery_pct: 14.5 }));
    await assertFails(at({ ...base.value, recorded_at: Date.now() + 2 * HOUR })); // cihaz saati 1 sa'ten fazla ileride
    await assertFails(at(base.value, `live_trail/${p.receiver_id}/${p.id}/bozuk-anahtar`));
    await assertFails(at(base.value, `live_trail/${p.receiver_id}/${p.id}/1700000000000-1`));
    // 24 saatten eski nokta ve paylaşım başlangıcından eski nokta reddedilir.
    await assertFails(at(pointAt(p, Date.now() - 25 * HOUR).value, pointAt(p, Date.now() - 25 * HOUR).path));
    const before = pointAt(p, p.started_at - 60_000);
    await assertFails(at(before.value, before.path));
    // Eski noktanın alt alanını tek başına güncellemek (eski server_ts) reddedilir.
    await assertFails(sender.ref(`${base.path}/lat`).set(40));
  });

  it('Faz 3 öncesi ACL (started_at yok): yalnızca 24 sa penceresi uygulanır', async () => {
    const p = await seedPair({ withStartedAt: false });
    const pt = pointAt(p, Date.now() - 3 * HOUR);
    await assertSucceeds((await clientDb(p.sender_id)).ref(pt.path).set(pt.value));
  });

  it('mezar taşından ya da süre dolduktan sonra yazma ve silme reddedilir; aktifken gönderen silebilir', async () => {
    const live = await seedPair();
    const pt = pointAt(live, Date.now() - MINUTE);
    const sender = await clientDb(live.sender_id);
    await assertSucceeds(sender.ref(pt.path).set(pt.value));
    await assertSucceeds(sender.ref(pt.path).remove());

    const ended = await seedPair({ status: 'ended' });
    const e = pointAt(ended, Date.now() - MINUTE);
    await assertFails((await clientDb(ended.sender_id)).ref(e.path).set(e.value));

    const expired = await seedPair({ expiresInMs: -1_000 });
    const x = pointAt(expired, Date.now() - MINUTE);
    await rtdb().ref(x.path).set({ ...x.value, server_ts: Date.now() });
    const xs = await clientDb(expired.sender_id);
    await assertFails(xs.ref(x.path).set(x.value));
    await assertFails(xs.ref(x.path).remove());
  });

  it('bağlantılara iz yok: link_trail düğümü kapalı', async () => {
    expect(LINK_TRAIL_ENABLED).toBe(false);
    const someone = await clientDb(uid('s'));
    await assertFails(someone.ref(`link_trail/${'a'.repeat(64)}/1700000000000-001`).set({ v: 1, lat: 1, lng: 1 }));
    await assertFails((await anonDb()).ref(`link_trail/${'a'.repeat(64)}`).once('value'));
  });
});

describe('canlı düğüm: kuyruk noktası started_at alt sınırı', () => {
  it('live_locations: q: 1 noktası paylaşım başlangıcından eski olamaz', async () => {
    const p = await seedPair({ startedAgoMs: 30 * MINUTE });
    const sender = await clientDb(p.sender_id);
    const target = { sender_id: p.sender_id, receiver_id: p.receiver_id, share_mode: p.share_mode, expires_at: p.expires_at };
    const queued = (ts: number) => ({ ...deliveredFor(target, ts), q: 1, recorded_at: ts - 500, hb: 300_000 });
    expect(livePathOf(target)).toBe(`live_locations/${p.receiver_id}/${p.id}`);
    await assertFails(sender.ref(livePathOf(target)).set(queued(p.started_at - 60_000)));
    await assertSucceeds(sender.ref(livePathOf(target)).set(queued(p.started_at + 60_000)));
    // recorded_at: cihaz saati sunucunun 1 sa'ten fazla ilerisinde olamaz; geçerli canlı paket etkilenmez.
    await assertFails(sender.ref(livePathOf(target)).set({ ...deliveredFor(target), recorded_at: Date.now() + 2 * HOUR }));
    await assertSucceeds(sender.ref(livePathOf(target)).set({ ...deliveredFor(target), recorded_at: Date.now() - 300 }));
  });

  it('link_live: q: 1 noktası bağlantı başlangıcından eski olamaz', async () => {
    const hash = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const sender_id = uid('s');
    const started_at = Date.now() - 30 * MINUTE;
    await rtdb()
      .ref(`link_acl/${hash}`)
      .set({ status: 'active', sender_id, link_id: 'L1', share_mode: 'indefinite', version: 1, started_at });
    await allowBattery(sender_id);
    const target = { token_hash: hash, share_mode: 'indefinite' as const, expires_at: null, sender_name: 'Ayşe' };
    const write = (ts: number) => ({
      ...(buildLinkLiveWrite(sampleAt(ts), SAMPLE_DEVICE, target, { q: 1, hb: 300_000 }) as Record<string, unknown>),
      server_ts: SERVER_TIMESTAMP,
    });
    const db = await clientDb(sender_id);
    await assertFails(db.ref(`link_live/${hash}`).set(write(started_at - 60_000)));
    await assertSucceeds(db.ref(`link_live/${hash}`).set(write(started_at + 60_000)));
  });
});
