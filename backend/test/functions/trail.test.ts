/**
 * Faz 3 `live_trail` yaşam döngüsü uçtan uca: ACL `started_at` taşır; gönderen çevrimdışı dönemin noktalarını
 * (core outbox planı) yazar, alıcı okur; durdurma, geri alma, süre dolumu, engel ve hesap silme izi siler.
 */
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  type OutboxSample,
  type OutboxTarget,
  type OutgoingShareView,
  emptyOutbox,
  enqueueOutbox,
  planFlush,
  trailBatchUpdate,
} from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rtdb } from '../../functions/src/admin';
import { sweepExpired } from '../../functions/src/handlers/sweeper';
import { type TestUser, call, cleanupRulesEnv, clientDb, loadDatabaseRules, newUser, opId } from '../helpers/emulator';
import { befriend, start } from '../review/helpers';

beforeAll(async () => {
  await loadDatabaseRules();
});

afterAll(async () => {
  await cleanupRulesEnv();
});

const target = (s: OutgoingShareView): OutboxTarget => ({
  kind: 'share',
  share_id: s.share_id,
  receiver_id: s.receiver_id,
  share_mode: s.share_mode,
  expires_at: s.expires_at,
  started_at: s.started_at,
});

const sample = (ts: number): OutboxSample => ({
  lat: 41.0082,
  lng: 28.9784,
  accuracy: 20,
  speed_mps: 0,
  heading: null,
  activity_state: 'still',
  battery_pct: 30,
  is_charging: false,
  timestamp: ts,
  recorded_at: ts,
  hb: 900_000,
});

/** Gönderen kimliğiyle iz partisi yazar (paylaşım yeni başladığı için noktalar started_at sonrası). */
async function writeTrail(sender: TestUser, s: OutgoingShareView, n = 3): Promise<string[]> {
  let q = emptyOutbox();
  const base = s.started_at + 10;
  for (let i = 0; i < n; i++) q = enqueueOutbox(q, sample(base + i * 10), [target(s)], base + i * 10);
  const plan = planFlush(q, [target(s)], Date.now());
  const batch = plan.trailBatches[0];
  if (!batch) throw new Error('iz partisi yok');
  await assertSucceeds((await clientDb(sender.uid)).ref().update(trailBatchUpdate(batch)));
  return batch.pointIds;
}

const trailOf = async (s: OutgoingShareView) => (await rtdb().ref(`live_trail/${s.receiver_id}/${s.share_id}`).once('value')).val();
const aclOf = async (id: string) => (await rtdb().ref(`share_acl/${id}`).once('value')).val();

let A: TestUser;
let B: TestUser;
let C: TestUser;
let D: TestUser;

beforeAll(async () => {
  [A, B, C, D] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Deniz')]);
  await befriend(A, B);
  await befriend(A, C);
  await befriend(A, D);
});

describe('live_trail yaşam döngüsü', () => {
  it('ACL started_at taşır; alıcı izi okur; durdurmada canlı kopya ile iz birlikte silinir', async () => {
    const s = (await start(A, [B], { kind: 'weekly' })).shares[0] as OutgoingShareView;
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'active', started_at: s.started_at });
    const ids = await writeTrail(A, s);
    const recv = await clientDb(B.uid);
    const snap = await assertSucceeds(recv.ref(`live_trail/${B.uid}/${s.share_id}`).once('value'));
    expect(Object.keys(snap.val())).toEqual(ids);
    // Paylaşım başlangıcından önceki nokta kuralla reddedilir (önceki dönemin konumu sızmaz).
    const before = `live_trail/${B.uid}/${s.share_id}/${String(s.started_at - 60_000).padStart(13, '0')}-001`;
    await assertFails(
      (await clientDb(A.uid)).ref(before).set({ v: 1, lat: 1, lng: 1, accuracy: 5, timestamp: s.started_at - 60_000, recorded_at: s.started_at - 60_000, q: 1, server_ts: { '.sv': 'timestamp' } }),
    );

    await call('share_stop', { op_id: opId(), session_id: s.session_id }, A);
    expect(await trailOf(s)).toBeNull();
    await assertFails(writeTrail(A, s));
  });

  it('alıcı geri alınca (revoke) iz silinir', async () => {
    const s = (await start(A, [C], { kind: 'indefinite' })).shares[0] as OutgoingShareView;
    await writeTrail(A, s);
    expect(await trailOf(s)).not.toBeNull();
    await call('share_revoke', { op_id: opId(), sender_id: A.uid }, C);
    expect(await trailOf(s)).toBeNull();
  });

  it('süre dolumunda (tarama) iz silinir', async () => {
    const s = (await start(A, [C], { kind: 'preset', preset: 'h1' })).shares[0] as OutgoingShareView;
    await writeTrail(A, s);
    const r = await sweepExpired({ now: (s.expires_at as number) + 1_000, audit: false });
    expect(r.ended_share_ids).toContain(s.share_id);
    expect(await trailOf(s)).toBeNull();
  });

  it('engelde iz silinir; hesap silmede alıcının gelen iz düğümü tamamen silinir', async () => {
    const s = (await start(A, [B], { kind: 'weekly' })).shares[0] as OutgoingShareView;
    await writeTrail(A, s);
    await call('user_block', { op_id: opId(), user_id: A.uid }, B);
    expect(await trailOf(s)).toBeNull();

    const d = (await start(A, [D], { kind: 'weekly' })).shares[0] as OutgoingShareView;
    await writeTrail(A, d);
    // Artık-veri benzetimi: bitmiş bir paylaşımdan kalmış iz (kuralları atlayarak).
    await rtdb().ref(`live_trail/${D.uid}/eski_paylasim/1700000000000-001`).set({ v: 1 });
    await call('account_delete', { op_id: opId(), confirm: true }, D);
    expect((await rtdb().ref(`live_trail/${D.uid}`).once('value')).exists()).toBe(false);
  });
});
