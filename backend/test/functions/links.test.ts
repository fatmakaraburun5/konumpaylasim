/**
 * Faz 2 bağlantı (QR) paylaşımı uçtan uca: telefonla giriş → callable (Functions emülatörü) → Firestore
 * `link_shares` + RTDB `link_acl` aynası → gönderen `link_live` yazar (kurallar) → token sahibi kimliksiz okur.
 * Süre dolumu ve bakım işleyicileri test sürecinde enjekte edilen saatle doğrudan çağrılır.
 */
import { createHash } from 'node:crypto';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  type DurationChoice,
  LINK_DOMAIN_DEFAULT,
  LINK_DURATION_OPTIONS,
  LINK_TOKEN_RE,
  type LinkShareCreateResponse,
  LinkShareCreateResponseSchema,
  type LinkShareUpdateResponse,
  LinkShareUpdateResponseSchema,
  MINUTE,
  buildLinkLiveWrite,
  buildLinkUrl,
  generateLinkToken,
  linkTokenHash,
  linkViewState,
  parseLinkLive,
  parseLinkToken,
} from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import { handleLinkExpiryTask } from '../../functions/src/handlers/links';
import { auditActiveLinkAcls, reconcilePendingLinkAcls, sweepExpired } from '../../functions/src/handlers/sweeper';
import {
  SAMPLE_DEVICE,
  type TestUser,
  anonDb,
  call,
  callError,
  cleanupRulesEnv,
  clientDb,
  clientFirestore,
  newUser,
  opId,
  sampleAt,
  waitFor,
} from '../helpers/emulator';

const TZ = 'Europe/Istanbul';
type View = Pick<LinkShareCreateResponse, 'token_hash' | 'share_mode' | 'expires_at'>;

const create = (u: TestUser, duration: unknown = { kind: 'preset', preset: 'h1' }, op = opId()) =>
  call<LinkShareCreateResponse>('link_share_create', { op_id: op, duration, time_zone: TZ }, u);
const extend = (u: TestUser, link_id: string, minutes: 30 | 60, op = opId()) =>
  call<LinkShareUpdateResponse>('link_share_extend', { op_id: op, link_id, minutes }, u);
const stop = (u: TestUser, link_id: string, op = opId()) => call<LinkShareUpdateResponse>('link_share_stop', { op_id: op, link_id }, u);

const aclOf = async (hash: string) => (await rtdb().ref(`link_acl/${hash}`).once('value')).val();
const liveOf = async (hash: string) => (await rtdb().ref(`link_live/${hash}`).once('value')).val();
const linkDoc = async (id: string) => (await db().doc(`link_shares/${id}`).get()).data();

/** Gönderen kimliğiyle core paketini yazar (mobil yayıncının yaptığı). */
async function publish(u: TestUser, v: View, patch: Record<string, unknown> = {}) {
  const w = buildLinkLiveWrite(sampleAt(), SAMPLE_DEVICE, { share_mode: v.share_mode, expires_at: v.expires_at, sender_name: u.display_name });
  return (await clientDb(u.uid)).ref(`link_live/${v.token_hash}`).set({ ...w, ...patch });
}

const anonRead = async (hash: string) => (await anonDb()).ref(`link_live/${hash}`).once('value');

let A: TestUser; // gönderen
let B: TestUser; // başka kullanıcı
let C: TestUser; // sınır testi
let D: TestUser; // süre seçenekleri

beforeAll(async () => {
  [A, B, C, D] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Deniz')]);
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('link_share_create', () => {
  it('token sunucuda üretilir ve bir kez döner; yalnızca SHA-256 özeti saklanır; ACL aynası yazılır', async () => {
    const r = await create(A);
    expect(LinkShareCreateResponseSchema.safeParse(r).success).toBe(true);
    expect(r.token).toMatch(LINK_TOKEN_RE);
    expect(r.url).toBe(buildLinkUrl(LINK_DOMAIN_DEFAULT, r.token));
    expect(parseLinkToken(r.url)).toBe(r.token);
    expect(r.token_hash).toBe(createHash('sha256').update(r.token).digest('hex'));
    expect(r).toMatchObject({ status: 'active', share_mode: 'timed', version: 1, extended_count: 0, end_reason: null });
    expect(r.expires_at).toBe(r.started_at + 60 * MINUTE);

    const doc = await linkDoc(r.link_id);
    expect(doc).toMatchObject({ link_id: r.link_id, sender_id: A.uid, audience: 'link', token_hash: r.token_hash, status: 'active', version: 1 });
    // Düz token hiçbir sunucu kaydında yok (belge, op kaydı).
    expect(JSON.stringify(doc)).not.toContain(r.token);
    const ops = await db().collection('ops').where('uid', '==', A.uid).get();
    expect(ops.docs.length).toBeGreaterThan(0);
    for (const o of ops.docs) {
      expect(JSON.stringify(o.data())).not.toContain(r.token);
      expect(JSON.stringify(o.data())).not.toContain(r.url);
    }

    expect(await aclOf(r.token_hash)).toEqual({
      status: 'active',
      sender_id: A.uid,
      link_id: r.link_id,
      share_mode: 'timed',
      expires_at: r.expires_at,
      version: 1,
      // Faz 3: kuyruk (q: 1) noktasının alt sınırı (belgedeki started_at).
      started_at: r.started_at,
    });
    await stop(A, r.link_id);
  });

  it('süre seçenekleri Faz 1 motoruyla: 15 dk, 1 saat, 8 saat, gün sonu, haftalık, süresiz', async () => {
    const choices = LINK_DURATION_OPTIONS.map((o) => o.choice).filter((c): c is DurationChoice => c !== null);
    expect(choices).toHaveLength(6);
    for (const choice of choices) {
      const r = await create(D, choice);
      const acl = await aclOf(r.token_hash);
      if (choice.kind === 'preset') {
        const min = { m15: 15, h1: 60, h8: 480 }[choice.preset];
        expect(r.share_mode).toBe('timed');
        expect(r.expires_at).toBe(r.started_at + min * MINUTE);
      } else if (choice.kind === 'end_of_day') {
        expect(r.share_mode).toBe('until_end_of_day');
        expect(r.expires_at).toBeGreaterThan(r.started_at);
      } else if (choice.kind === 'weekly') {
        expect(r.share_mode).toBe('weekly');
        expect(r.expires_at).toBe(r.started_at + 7 * 24 * 60 * MINUTE);
      } else {
        expect(r).toMatchObject({ share_mode: 'indefinite', expires_at: null });
        expect(acl).not.toHaveProperty('expires_at');
      }
      expect(acl).toMatchObject({ status: 'active', share_mode: r.share_mode });
      await stop(D, r.link_id);
    }
  });

  it('aynı op_id tekrarı (yanıt kayboldu): token yenilenir, eski token hemen geçersiz; farklı istek reddedilir', async () => {
    const op = opId();
    const r1 = await create(A, { kind: 'preset', preset: 'h1' }, op);
    await assertSucceeds(publish(A, r1));
    const r2 = await create(A, { kind: 'preset', preset: 'h1' }, op);
    expect(LinkShareCreateResponseSchema.safeParse(r2).success).toBe(true);
    expect(r2.link_id).toBe(r1.link_id);
    expect(r2.token).not.toBe(r1.token);
    expect(r2.token_hash).toBe(linkTokenHash(r2.token));
    expect(r2.version).toBe(r1.version + 1);
    expect(r2.expires_at).toBe(r1.expires_at);
    expect(await aclOf(r1.token_hash)).toMatchObject({ status: 'ended' });
    expect(await aclOf(r2.token_hash)).toMatchObject({ status: 'active', version: r2.version });
    expect(await liveOf(r1.token_hash)).toBeNull();
    await assertFails(anonRead(r1.token_hash));
    await assertFails(publish(A, r1));
    await assertSucceeds(publish(A, r2));
    expect((await linkDoc(r1.link_id))?.token_hash).toBe(r2.token_hash);

    const e = await callError('link_share_create', { op_id: op, duration: { kind: 'weekly' }, time_zone: TZ }, A);
    expect(e.details?.code).toBe('invalid_argument');
    await stop(A, r1.link_id);
    // Bitmiş bağlantının oluşturma tekrarı token vermez.
    const again = await callError('link_share_create', { op_id: op, duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ }, A);
    expect(again.details?.code).toBe('share_not_active');
  });

  it(`kullanıcı başına en çok 5 aktif bağlantı (link_limit_reached); durdurunca yer açılır`, async () => {
    const made: LinkShareCreateResponse[] = [];
    for (let i = 0; i < 5; i++) made.push(await create(C));
    const e = await callError('link_share_create', { op_id: opId(), duration: { kind: 'preset', preset: 'm15' }, time_zone: TZ }, C);
    expect(e.status).toBe('RESOURCE_EXHAUSTED');
    expect(e.details).toMatchObject({ code: 'link_limit_reached', retryable: false });
    await stop(C, (made[0] as LinkShareCreateResponse).link_id);
    const ok = await create(C);
    expect(ok.status).toBe('active');
    for (const l of [...made.slice(1), ok]) await stop(C, l.link_id);
  });

  it('kimliksiz çağrı ve bozuk süre reddedilir', async () => {
    expect((await callError('link_share_create', { op_id: opId(), duration: { kind: 'preset', preset: 'h1' } }, null)).details?.code).toBe(
      'unauthenticated',
    );
    const bad = await callError('link_share_create', { op_id: opId(), duration: { kind: 'custom_minutes', minutes: 1 }, time_zone: TZ }, A);
    expect(bad.details?.code).toMatch(/invalid_(duration|argument)/);
  });
});

describe('link_live (canlı konum) ve link_shares okuma', () => {
  it('yalnızca gönderen yazar; token sahibi kimliksiz okur; yanlış token ve liste reddedilir', async () => {
    const r = await create(A);
    await assertSucceeds(publish(A, r));
    await assertFails(publish(B, r));
    const snap = await assertSucceeds(anonRead(r.token_hash));
    const p = parseLinkLive(snap.val());
    expect(p).toMatchObject({ sender_name: 'Ayşe', share_mode: 'timed', expires_at: r.expires_at });
    expect(snap.val()).not.toHaveProperty('sender_id');
    expect(linkViewState({ tokenValid: true, loaded: true, denied: false, live: p, seenLive: true, now: Date.now() })).toBe('live');

    await assertFails(anonRead(linkTokenHash(generateLinkToken())));
    await assertFails((await anonDb()).ref('link_live').once('value'));
    await assertFails((await clientDb(B.uid)).ref(`link_acl/${r.token_hash}`).once('value'));
    await assertFails(publish(A, r, { sender_id: A.uid }));
    await assertFails(publish(A, r, { expires_at: (r.expires_at as number) + MINUTE }));

    const fsA = await clientFirestore(A.uid);
    await assertSucceeds(fsA.doc(`link_shares/${r.link_id}`).get());
    await assertSucceeds(fsA.collection('link_shares').where('sender_id', '==', A.uid).where('status', '==', 'active').get());
    await assertFails((await clientFirestore(B.uid)).doc(`link_shares/${r.link_id}`).get());
    await stop(A, r.link_id);
  });
});

describe('link_share_extend', () => {
  it('+30 dk / +1 saat Faz 1 kuralıyla; ACL ve saklanan paket aynı çağrıda eşitlenir', async () => {
    const r = await create(A, { kind: 'preset', preset: 'm15' });
    await assertSucceeds(publish(A, r));
    const e1 = await extend(A, r.link_id, 30);
    expect(LinkShareUpdateResponseSchema.safeParse(e1).success).toBe(true);
    expect(e1).toMatchObject({ link_id: r.link_id, token_hash: r.token_hash, version: 2, extended_count: 1, status: 'active' });
    expect(e1.expires_at).toBe((r.expires_at as number) + 30 * MINUTE);
    expect(await aclOf(r.token_hash)).toMatchObject({ status: 'active', version: 2, expires_at: e1.expires_at });
    expect((await liveOf(r.token_hash))?.expires_at).toBe(e1.expires_at);
    await assertFails(publish(A, r)); // eski bitişle yazma reddedilir
    await assertSucceeds(publish(A, e1));

    const e2 = await extend(A, r.link_id, 60);
    expect(e2.expires_at).toBe((e1.expires_at as number) + 60 * MINUTE);
    expect(e2.extended_count).toBe(2);
    // Aynı op_id tekrarı ikinci kez uzatmaz.
    const op = opId();
    const e3 = await extend(A, r.link_id, 30, op);
    const e3b = await extend(A, r.link_id, 30, op);
    expect(e3b).toEqual(e3);
    expect((await linkDoc(r.link_id))?.expires_at).toBe(e3.expires_at);
    await stop(A, r.link_id);
  });

  it('başkasının ve var olmayan bağlantı aynı hatayı alır; süresiz uzatılamaz; biten uzatılamaz', async () => {
    const r = await create(A, { kind: 'indefinite' });
    const theirs = await callError('link_share_extend', { op_id: opId(), link_id: r.link_id, minutes: 30 }, B);
    const missing = await callError('link_share_extend', { op_id: opId(), link_id: 'yokboylebirbaglanti', minutes: 30 }, B);
    expect(theirs.details?.code).toBe('link_not_found');
    expect(missing.details?.code).toBe('link_not_found');
    expect(theirs.status).toBe(missing.status);
    expect((await callError('link_share_extend', { op_id: opId(), link_id: r.link_id, minutes: 30 }, A)).details?.code).toBe('invalid_duration');
    await stop(A, r.link_id);
    expect((await callError('link_share_extend', { op_id: opId(), link_id: r.link_id, minutes: 30 }, A)).details?.code).toBe('share_not_active');
  });
});

describe('link_share_stop (anında iptal)', () => {
  it('Firestore → mezar taşı → link_live silinir; açık dinleyici boşalır; okuma/yazma aynı akışta reddedilir', async () => {
    const r = await create(A);
    await assertSucceeds(publish(A, r));

    const viewer = await anonDb();
    const events: unknown[] = [];
    const ref = viewer.ref(`link_live/${r.token_hash}`);
    ref.on(
      'value',
      (s) => events.push(s.val()),
      () => events.push('denied'),
    );
    await waitFor(async () => events.some((e) => e && e !== 'denied'));

    const s = await stop(A, r.link_id);
    expect(LinkShareUpdateResponseSchema.safeParse(s).success).toBe(true);
    expect(s).toMatchObject({ status: 'ended', end_reason: 'stopped_by_sender', version: 2 });
    // Callable döndüğü anda: paket yok, ACL mezar taşı, yeni okuma ve yazma reddedilir.
    expect(await liveOf(r.token_hash)).toBeNull();
    const acl = await aclOf(r.token_hash);
    expect(acl).toMatchObject({ status: 'ended', version: 2, end_reason: 'stopped_by_sender' });
    expect(acl).not.toHaveProperty('sender_id');
    expect(acl).not.toHaveProperty('link_id');
    await assertFails(anonRead(r.token_hash));
    await assertFails(publish(A, r));
    // Açık web sekmesi: dinleyici ya null görür ya iptal edilir → "Paylaşım sona erdi".
    await waitFor(async () => events.length > 1 && (events.at(-1) === null || events.at(-1) === 'denied'), 2_000);
    ref.off();
    const last = events.at(-1);
    expect(
      linkViewState({ tokenValid: true, loaded: true, denied: last === 'denied', live: null, seenLive: true, now: Date.now() }),
    ).toBe('ended');

    expect(await linkDoc(r.link_id)).toMatchObject({ status: 'ended', end_reason: 'stopped_by_sender', version: 2 });
    // İdempotent: tekrar durdurmak aynı sonucu verir; başkası durduramaz (ve var olup olmadığını öğrenemez).
    expect(await stop(A, r.link_id)).toMatchObject({ status: 'ended', version: 2 });
    expect((await callError('link_share_stop', { op_id: opId(), link_id: r.link_id }, B)).details?.code).toBe('link_not_found');
  });
});

describe('süre dolumu', () => {
  it('süre dolunca okuma kuralla reddedilir; görev bağlantıyı bitirir ve paketi siler', async () => {
    const r = await create(A, { kind: 'preset', preset: 'm15' });
    await assertSucceeds(publish(A, r));
    // Bitişi 1,5 sn sonraya çek (ACL + belge + paket tutarlı; sürüm aynı).
    const soon = Date.now() + 1_500;
    await rtdb().ref(`link_acl/${r.token_hash}/expires_at`).set(soon);
    await rtdb().ref(`link_live/${r.token_hash}/expires_at`).set(soon);
    await db().doc(`link_shares/${r.link_id}`).update({ expires_at: soon });
    await new Promise((res) => setTimeout(res, 1_800));

    await assertFails(anonRead(r.token_hash));
    await assertFails(publish(A, { ...r, expires_at: soon }));

    // Functions emülatörünün görev kuyruğu görevi kendisi de iletebilir (bitişten önce gelirse ≤ 30 sn bekler):
    // doğrudan çağrı ya bitirir ya da zaten bitmiş bulur.
    expect(['expired', 'not_active']).toContain(await handleLinkExpiryTask({ link_id: r.link_id, version: 1 }));
    expect(await linkDoc(r.link_id)).toMatchObject({ status: 'ended', end_reason: 'expired', version: 2 });
    expect(await aclOf(r.token_hash)).toMatchObject({ status: 'ended', end_reason: 'expired' });
    expect(await liveOf(r.token_hash)).toBeNull();
    // Eski / tekrar gelen görev bir şey yapmaz.
    expect(await handleLinkExpiryTask({ link_id: r.link_id, version: 1 })).toBe('not_active');
    expect(await handleLinkExpiryTask({ link_id: 'yok', version: 1 })).toBe('missing');
  });

  it('uzatılan bağlantının eski sürüm görevi bitirmez; dakikalık tarama süresi dolanı kapatır', async () => {
    const r = await create(A, { kind: 'preset', preset: 'm15' });
    await extend(A, r.link_id, 30);
    expect(await handleLinkExpiryTask({ link_id: r.link_id, version: 1 }, (r.expires_at as number) + 1)).toBe('stale_version');
    expect((await linkDoc(r.link_id))?.status).toBe('active');

    await assertSucceeds(publish(A, { ...r, expires_at: (await linkDoc(r.link_id))?.expires_at }));
    const now = Date.now() + 2 * 60 * MINUTE; // iki saat sonrası (enjekte edilen saat)
    const res = await sweepExpired({ now, audit: false });
    expect(res.ended_link_ids).toContain(r.link_id);
    expect(await linkDoc(r.link_id)).toMatchObject({ status: 'ended', end_reason: 'expired' });
    expect(await aclOf(r.token_hash)).toMatchObject({ status: 'ended' });
    expect(await liveOf(r.token_hash)).toBeNull();
  });
});

describe('uzlaştırma (fail-closed)', () => {
  it('denetim: belgeyle çelişen ya da sahipsiz aktif ACL kapatılır ve paket silinir', async () => {
    const r = await create(A);
    await stop(A, r.link_id);
    // Kaybolmuş mezar taşı: ACL yeniden "aktif" ve paket duruyor (sürüm aynı).
    await rtdb().ref(`link_acl/${r.token_hash}`).set({ status: 'active', sender_id: A.uid, link_id: r.link_id, share_mode: 'timed', expires_at: r.expires_at, version: 2 });
    await rtdb().ref(`link_live/${r.token_hash}`).set({ v: 1, lat: 1, lng: 1, accuracy: 1, timestamp: 1, server_ts: 1, sender_name: 'x', share_mode: 'timed' });
    const orphan = linkTokenHash(generateLinkToken());
    await rtdb().ref(`link_acl/${orphan}`).set({ status: 'active', sender_id: A.uid, link_id: 'yokboyle', share_mode: 'indefinite', version: 1 });

    const fixed = await auditActiveLinkAcls(Date.now());
    expect(fixed).toEqual(expect.arrayContaining([r.token_hash, orphan]));
    expect(await aclOf(r.token_hash)).toMatchObject({ status: 'ended' });
    expect(await liveOf(r.token_hash)).toBeNull();
    expect(await aclOf(orphan)).toMatchObject({ status: 'ended' });
  });

  it('bekleyen işaret: eski token özeti de kapatılır', async () => {
    const r = await create(A);
    const stale = linkTokenHash(generateLinkToken());
    await rtdb().ref(`link_acl/${stale}`).set({ status: 'active', sender_id: A.uid, link_id: r.link_id, share_mode: 'timed', expires_at: r.expires_at, version: 1 });
    await db().doc(`link_acl_pending/${r.link_id}`).set({ link_id: r.link_id, version: r.version, updated_at: Date.now() - 5 * MINUTE, stale_token_hash: stale });
    const done = await reconcilePendingLinkAcls(Date.now());
    expect(done).toContain(r.link_id);
    expect(await aclOf(stale)).toMatchObject({ status: 'ended' });
    expect(await aclOf(r.token_hash)).toMatchObject({ status: 'active' });
    expect((await db().doc(`link_acl_pending/${r.link_id}`).get()).exists).toBe(false);
    await stop(A, r.link_id);
  });
});

describe('account_delete', () => {
  it('aktif bağlantılar biter; link_acl, link_live ve link_shares silinir', async () => {
    const X = await newUser('Silinecek');
    const r = await create(X);
    await assertSucceeds(publish(X, r));
    await call('account_delete', { op_id: opId(), confirm: true }, X);
    expect(await aclOf(r.token_hash)).toBeNull();
    expect(await liveOf(r.token_hash)).toBeNull();
    expect(await linkDoc(r.link_id)).toBeUndefined();
    await assertFails(anonRead(r.token_hash));
  });
});
