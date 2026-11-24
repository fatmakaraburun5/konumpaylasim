/**
 * Faz 2 RTDB + Firestore kuralları: `link_live/{token_hash}` yalnızca aktif ve süresi dolmamış `link_acl` varken
 * token'ı bilen (kimliksiz de olabilir) tarafından okunur; yalnızca gönderen, yalnızca core alanlarıyla yazar.
 * ACL düğümleri Admin SDK ile (kurallar atlanarak) hazırlanır.
 */
import { randomUUID } from 'node:crypto';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  type EpochMs,
  type ShareMode,
  buildLinkLiveWrite,
  generateLinkToken,
  linkTokenHash,
  parseLinkLive,
} from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rtdb } from '../../functions/src/admin';
import { SAMPLE_DEVICE, anonDb, cleanupRulesEnv, clientDb, clientFirestore, loadDatabaseRules, rulesEnv, sampleAt } from '../helpers/emulator';

const uid = (p: string) => `${p}${randomUUID().slice(0, 8)}`;

interface SeededLink {
  token: string;
  hash: string;
  sender: string;
  share_mode: ShareMode;
  expires_at: EpochMs | null;
}

async function seedLink(opts: { expiresInMs?: number | null; status?: 'active' | 'ended' } = {}): Promise<SeededLink> {
  const token = generateLinkToken();
  const hash = linkTokenHash(token);
  const sender = uid('s');
  const expires_at = opts.expiresInMs === null ? null : Date.now() + (opts.expiresInMs ?? 3_600_000);
  const share_mode: ShareMode = expires_at === null ? 'indefinite' : 'timed';
  const acl: Record<string, unknown> =
    opts.status === 'ended'
      ? { status: 'ended', version: 2, ended_at: Date.now(), end_reason: 'stopped_by_sender' }
      : { status: 'active', sender_id: sender, link_id: uid('L'), share_mode, version: 1 };
  if (expires_at !== null && opts.status !== 'ended') acl.expires_at = expires_at;
  await rtdb().ref(`link_acl/${hash}`).set(acl);
  return { token, hash, sender, share_mode, expires_at };
}

/** core `buildLinkLiveWrite` ile geçerli paket (server_ts yer tutucu). */
function packet(l: SeededLink, patch: Record<string, unknown> = {}, ts: EpochMs = Date.now()): Record<string, unknown> {
  return { ...buildLinkLiveWrite(sampleAt(ts), SAMPLE_DEVICE, { share_mode: l.share_mode, expires_at: l.expires_at, sender_name: 'Ayşe Y.' }), ...patch };
}

const live = (hash: string) => `link_live/${hash}`;

beforeAll(async () => {
  await loadDatabaseRules();
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('link_live okuma', () => {
  it('token sahibi (kimliksiz) aktif bağlantıyı okur; gizli alan yok', async () => {
    const l = await seedLink();
    await assertSucceeds((await clientDb(l.sender)).ref(live(l.hash)).set(packet(l)));
    const snap = await assertSucceeds((await anonDb()).ref(live(l.hash)).once('value'));
    const p = parseLinkLive(snap.val());
    expect(p).not.toBeNull();
    expect(p?.sender_name).toBe('Ayşe Y.');
    expect(Object.keys(snap.val())).not.toContain('sender_id');
    // Giriş yapmış başka biri de token'ı biliyorsa okur (token = yetki).
    await assertSucceeds((await clientDb(uid('x'))).ref(live(l.hash)).once('value'));
  });

  it('yanlış token okuyamaz; üst düğüm ve ACL listelenemez', async () => {
    const l = await seedLink();
    await rtdb().ref(live(l.hash)).set({ ...packet(l), server_ts: Date.now() });
    const wrong = linkTokenHash(generateLinkToken());
    const anon = await anonDb();
    await assertFails(anon.ref(live(wrong)).once('value'));
    await assertFails(anon.ref('link_live').once('value'));
    await assertFails(anon.ref('link_acl').once('value'));
    await assertFails(anon.ref(`link_acl/${l.hash}`).once('value'));
    // Gönderen de ACL'yi okuyamaz / yazamaz.
    const sender = await clientDb(l.sender);
    await assertFails(sender.ref(`link_acl/${l.hash}`).once('value'));
    await assertFails(sender.ref(`link_acl/${l.hash}`).set({ status: 'active', sender_id: l.sender, version: 99 }));
    await assertFails(sender.ref('link_live').once('value'));
  });

  it('süresi dolunca okuma kuralla reddedilir (görev beklenmez)', async () => {
    const l = await seedLink({ expiresInMs: 1_500 });
    await assertSucceeds((await clientDb(l.sender)).ref(live(l.hash)).set(packet(l)));
    await assertSucceeds((await anonDb()).ref(live(l.hash)).once('value'));
    await new Promise((r) => setTimeout(r, 1_800));
    await assertFails((await anonDb()).ref(live(l.hash)).once('value'));
    await assertFails((await clientDb(l.sender)).ref(live(l.hash)).set(packet(l)));
  });

  it('mezar taşı (bitmiş) okuma ve yazmayı reddeder; süresiz aktif okunur', async () => {
    const ended = await seedLink({ status: 'ended' });
    await rtdb().ref(live(ended.hash)).set({ v: 1, lat: 1, lng: 1, accuracy: 1, timestamp: 1, server_ts: 1, sender_name: 'x', share_mode: 'timed' });
    await assertFails((await anonDb()).ref(live(ended.hash)).once('value'));
    await assertFails((await clientDb(ended.sender)).ref(live(ended.hash)).set(packet(ended)));
    const forever = await seedLink({ expiresInMs: null });
    await assertSucceeds((await clientDb(forever.sender)).ref(live(forever.hash)).set(packet(forever)));
    await assertSucceeds((await anonDb()).ref(live(forever.hash)).once('value'));
  });
});

describe('link_live yazma', () => {
  it("yalnızca ACL'deki gönderen yazar; kimliksiz ve başkası yazamaz", async () => {
    const l = await seedLink();
    await assertFails((await anonDb()).ref(live(l.hash)).set(packet(l)));
    await assertFails((await clientDb(uid('x'))).ref(live(l.hash)).set(packet(l)));
    await assertSucceeds((await clientDb(l.sender)).ref(live(l.hash)).set(packet(l)));
    // Gönderen kendi paketini silebilir (aktifken).
    await assertSucceeds((await clientDb(l.sender)).ref(live(l.hash)).remove());
  });

  it('core alanları dışında alan, eksik zorunlu alan ve bozuk değer reddedilir', async () => {
    const l = await seedLink();
    const db = await clientDb(l.sender);
    const ref = db.ref(live(l.hash));
    for (const extra of ['sender_id', 'share_id', 'link_id', 'receiver_ids', 'is_charging', 'activity_state', 'mocked', 'phone']) {
      await assertFails(ref.set(packet(l, { [extra]: extra === 'is_charging' || extra === 'mocked' ? true : 'x' })));
    }
    const { sender_name: _n, ...noName } = packet(l);
    await assertFails(ref.set(noName));
    await assertFails(ref.set(packet(l, { sender_name: '' })));
    await assertFails(ref.set(packet(l, { sender_name: 'x'.repeat(81) })));
    await assertFails(ref.set(packet(l, { lat: 91 })));
    await assertFails(ref.set(packet(l, { accuracy: 5000 })));
    await assertFails(ref.set(packet(l, { battery_pct: 50.5 })));
    await assertFails(ref.set(packet(l, { v: 2 })));
    await assertFails(ref.set(packet(l, { server_ts: Date.now() })));
    await assertFails(ref.set(packet(l, { timestamp: Date.now() - 10 * 60_000 })));
    await assertSucceeds(ref.set(packet(l)));
  });

  it('paket ACL ile bağlı: share_mode ve expires_at farklıysa reddedilir; alt alan güncellemesi de denetlenir', async () => {
    const l = await seedLink();
    const ref = (await clientDb(l.sender)).ref(live(l.hash));
    await assertFails(ref.set(packet(l, { share_mode: 'weekly' })));
    await assertFails(ref.set(packet(l, { expires_at: (l.expires_at as number) + 60_000 })));
    const { expires_at: _e, ...noExp } = packet(l);
    await assertFails(ref.set(noExp));
    await assertSucceeds(ref.set(packet(l)));
    await assertSucceeds(ref.update({ lat: 41.01, lng: 29.01, server_ts: { '.sv': 'timestamp' }, timestamp: Date.now() }));
    await assertFails(ref.update({ expires_at: (l.expires_at as number) + 1 }));

    const forever = await seedLink({ expiresInMs: null });
    await assertFails((await clientDb(forever.sender)).ref(live(forever.hash)).set(packet(forever, { expires_at: Date.now() + 60_000 })));
  });
});

describe('Firestore link_shares', () => {
  it('yalnızca gönderen okur (sorgu kısıtıyla); kimse yazamaz', async () => {
    const env = await rulesEnv();
    const sender = uid('s');
    const other = uid('o');
    const id = uid('L');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`link_shares/${id}`).set({ link_id: id, sender_id: sender, status: 'active', token_hash: 'a'.repeat(64) });
    });
    const mine = await clientFirestore(sender);
    await assertSucceeds(mine.doc(`link_shares/${id}`).get());
    await assertSucceeds(mine.collection('link_shares').where('sender_id', '==', sender).get());
    await assertFails(mine.collection('link_shares').get());
    await assertFails(mine.doc(`link_shares/${id}`).set({ sender_id: sender, status: 'active' }));
    await assertFails(mine.doc(`link_shares/${uid('N')}`).set({ sender_id: sender }));
    const theirs = await clientFirestore(other);
    await assertFails(theirs.doc(`link_shares/${id}`).get());
    await assertFails(theirs.collection('link_shares').where('sender_id', '==', sender).get());
    await assertFails((await env.unauthenticatedContext().firestore()).doc(`link_shares/${id}`).get());
  });

  it('Maps önbellek, kota ve yapılandırma koleksiyonları istemciye kapalı', async () => {
    const me = await clientFirestore(uid('u'));
    for (const p of ['route_cache/x', 'geocode_cache/sxk9', 'maps_quota/u_2026-01-01', 'maps_budget/2026-01-01_0', 'config/maps', 'link_acl_pending/x']) {
      await assertFails(me.doc(p).get());
      await assertFails(me.doc(p).set({ a: 1 }));
    }
  });
});
