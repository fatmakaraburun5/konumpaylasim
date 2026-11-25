/**
 * Faz 8: izin matrisi (arkadaşlık ≠ izin, yönlü belgeler), görünmez mod ve Güvenlik Sözleşmesi / KVKK onay kapısı.
 * Çoğu çağrı Functions emülatörü üzerinden gider (kapı + şema + hata eşlemesi gerçek); ping, koordinat içeriği
 * görülsün diye sahte FCM göndericisiyle doğrudan işleyiciden çağrılır.
 */
import { assertFails } from '@firebase/rules-unit-testing';
import {
  CONSENT_VERSION,
  MeetupShareRequestSchema,
  SOS_LIMITS,
  SosSendRequestSchema,
  SosUpdateRequestSchema,
  type InvisibleSetResponse,
  type LinkShareCreateResponse,
  type OutgoingShareView,
  PATHS,
  type PermissionRequestRespondResponse,
  type ShareStartResponse,
  friendshipId,
  hasGrant,
  parsePermissionGrantDoc,
  parsePing,
  requestId,
  shareId,
} from '@konum/core';
import { afterAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import { consentWithdraw } from '../../functions/src/handlers/access';
import { meetupShare } from '../../functions/src/handlers/meetup';
import { placeNoteUpsert } from '../../functions/src/handlers/notes';
import { pingSend } from '../../functions/src/handlers/ping';
import { sosSend, sosUpdate } from '../../functions/src/handlers/sos';
import type { PushMessage, PushSender } from '../../functions/src/push';
import { type TestUser, acceptConsent, call, callError, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';
import { TZ, befriend, writeLive } from '../review/helpers';

afterAll(async () => {
  await cleanupRulesEnv();
});

const grantOf = async (granter: TestUser, grantee: TestUser) =>
  parsePermissionGrantDoc((await db().doc(PATHS.permissionGrant(granter.uid, grantee.uid)).get()).data());
const shareDoc = async (sender: TestUser, receiver: TestUser) => (await db().doc(`location_shares/${shareId(sender.uid, receiver.uid)}`).get()).data();
const aclOf = async (id: string) => (await rtdb().ref(`share_acl/${id}`).once('value')).val();
const userDoc = async (u: TestUser) => (await db().doc(`users/${u.uid}`).get()).data();
const codeOf = (e: { details?: Record<string, unknown> }) => e.details?.code;

const startShare = (sender: TestUser, receivers: TestUser[], extra: Record<string, unknown> = {}) =>
  call<ShareStartResponse>(
    'share_start',
    { op_id: opId(), receiver_ids: receivers.map((r) => r.uid), duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ, ...extra },
    sender,
  );
const setPermission = (granter: TestUser, grantee: TestUser, scope: string, granted: boolean) =>
  call('permission_set', { op_id: opId(), grantee_id: grantee.uid, scope, granted }, granter);

function fakeFcm() {
  const sent: { uid: string; msg: PushMessage }[] = [];
  const send: PushSender = async (uid, msg) => {
    sent.push({ uid, msg });
    return { sent: 1, removed: 0 };
  };
  return { sent, send };
}
const ctxOf = (u: TestUser, now = Date.now()): CallCtx => ({ uid: u.uid, phone_e164: null, now });

describe('arkadaşlık izin değildir (varsayılan kapalı)', () => {
  it('kabul hiçbir izin yazmaz; share_start alıcıyı needs_grant_receiver_ids ile döndürür; grant_location_view yalnızca o yönü açar', async () => {
    const [A, B] = await Promise.all([newUser('Ayşe'), newUser('Bora')]);
    await befriend(A, B, { grants: 'none' });
    expect(await grantOf(A, B)).toBeNull();
    expect(await grantOf(B, A)).toBeNull();

    const r = await startShare(A, [B]);
    expect(r.shares).toEqual([]);
    expect(r.needs_grant_receiver_ids).toEqual([B.uid]);
    expect(r.skipped_receiver_ids).not.toContain(B.uid);
    expect(await shareDoc(A, B)).toBeUndefined();
    expect(await aclOf(shareId(A.uid, B.uid))).toBeNull();

    // "Konumunu görme izni de verilecek" onayıyla: izin + paylaşım aynı işlemde; ters yön yazılmaz.
    const r2 = await startShare(A, [B], { grant_location_view: true });
    expect(r2.shares.map((s) => s.receiver_id)).toEqual([B.uid]);
    expect(r2.needs_grant_receiver_ids).toEqual([]);
    const g = await grantOf(A, B);
    expect(g?.scopes.location_view?.via).toBe('share');
    expect(hasGrant(g, 'ping')).toBe(false);
    expect(await grantOf(B, A)).toBeNull();
    expect(await aclOf(shareId(A.uid, B.uid))).toMatchObject({ status: 'active' });

    // Arkadaşlık bitince iki yöndeki izin belgeleri de silinir.
    await call('friendship_remove', { op_id: opId(), friendship_id: friendshipId(A.uid, B.uid) }, A);
    expect(await grantOf(A, B)).toBeNull();
    expect(await grantOf(B, A)).toBeNull();
  });
});

describe('izin isteği yönü', () => {
  it('tek taraflı onay yalnızca hedef → isteyen iznini yazar; ret soğuması isteyene sızmaz', async () => {
    const [A, B] = await Promise.all([newUser('Ayşe'), newUser('Bora')]);
    await befriend(A, B, { grants: 'none' });

    const sent = await call('permission_request_send', { op_id: opId(), target_id: B.uid, scopes: ['location_view', 'ping'] }, A);
    expect(sent.status).toBe('sent');
    const pending = await grantOf(B, A);
    expect(pending?.pending?.scopes).toEqual(['location_view', 'ping']);
    expect(hasGrant(pending, 'location_view')).toBe(false);

    const res = await call<PermissionRequestRespondResponse>(
      'permission_request_respond',
      { op_id: opId(), requester_id: A.uid, grant_scopes: ['location_view'], share: { duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ } },
      B,
    );
    expect(res.granted_scopes).toEqual(['location_view']);
    expect(res.declined_scopes).toEqual(['ping']);
    expect(res.share?.shares.map((s) => s.receiver_id)).toEqual([A.uid]);
    const g = await grantOf(B, A);
    expect(hasGrant(g, 'location_view')).toBe(true);
    expect(hasGrant(g, 'ping')).toBe(false);
    // Ret isteyene sızmaz: reddedilen `ping` isteyenin okuduğu belgede süresi dolana kadar "bekliyor" kalır (aynı
    // istek anı / bitişle); ret anı yalnızca granter'ın okuduğu `permission_declines` kaydındadır.
    expect(g?.pending).toEqual({ ...pending?.pending, scopes: ['ping'] });
    expect(g?.declined_at).toEqual({});
    expect((await db().doc(`permission_declines/${B.uid}_${A.uid}`).get()).data()?.declined_at).toEqual({ ping: expect.any(Number) });
    // Ters yön (isteyen → hedef) hiç yazılmaz.
    expect(await grantOf(A, B)).toBeNull();
    expect(await shareDoc(B, A)).toMatchObject({ status: 'active' });

    // Reddedilen kapsamı hemen yeniden istemek: yanıt yine `sent`, belge (sürüm dahil) değişmez, push yok.
    const again = await call('permission_request_send', { op_id: opId(), target_id: B.uid, scopes: ['ping'] }, A);
    expect(again.status).toBe('sent');
    expect(await grantOf(B, A)).toEqual(g);
  });

  it('salt ret izin belgesine hiç dokunmaz (isteyen "bekliyor" görür)', async () => {
    const [A, B] = await Promise.all([newUser('Ayşe'), newUser('Bora')]);
    await befriend(A, B, { grants: 'none' });
    await call('permission_request_send', { op_id: opId(), target_id: B.uid, scopes: ['location_view'] }, A);
    const before = await grantOf(B, A);
    const res = await call<PermissionRequestRespondResponse>('permission_request_respond', { op_id: opId(), requester_id: A.uid, grant_scopes: [] }, B);
    expect(res).toMatchObject({ granted_scopes: [], declined_scopes: ['location_view'], share: null });
    expect(await grantOf(B, A)).toEqual(before);
    expect((await db().doc(`permission_declines/${B.uid}_${A.uid}`).get()).data()).toMatchObject({ granter_id: B.uid, grantee_id: A.uid, declined_at: { location_view: expect.any(Number) } });
  });

  it('konum isteği kabulü hedef → isteyen location_view iznini aynı işlemde yazar (ters yön yok)', async () => {
    const [A, B] = await Promise.all([newUser('Ayşe'), newUser('Bora')]);
    await befriend(A, B, { grants: 'none' });
    await call('location_request_send', { op_id: opId(), target_id: B.uid }, A);
    const r = await call(
      'location_request_respond',
      { op_id: opId(), request_id: requestId(A.uid, B.uid), accept: true, duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ },
      B,
    );
    expect(r.status).toBe('accepted');
    expect((await grantOf(B, A))?.scopes.location_view?.via).toBe('location_request');
    expect(await grantOf(A, B)).toBeNull();
    expect(await shareDoc(B, A)).toMatchObject({ status: 'active', in_response_to: requestId(A.uid, B.uid) });
  });
});

describe('izni geri almak', () => {
  it('location_view kapatılınca paylaşım biter, ACL mezar taşı olur ve canlı yazma reddedilir', async () => {
    const [A, B] = await Promise.all([newUser('Ayşe'), newUser('Bora')]);
    await befriend(A, B);
    const r = await startShare(A, [B]);
    const s = r.shares[0] as OutgoingShareView;
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'active' });

    const off = await setPermission(A, B, 'location_view', false);
    expect(off.scopes).not.toContain('location_view');
    expect(await shareDoc(A, B)).toMatchObject({ status: 'ended', end_reason: 'stopped_by_sender' });
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'ended' });
    await assertFails(writeLive(A, s));
    // Diğer kapsamlar ve ters yön etkilenmez.
    expect(hasGrant(await grantOf(A, B), 'ping')).toBe(true);
    expect(hasGrant(await grantOf(B, A), 'location_view')).toBe(true);

    // Yeniden paylaşım izinsiz başlamaz.
    const again = await startShare(A, [B]);
    expect(again.needs_grant_receiver_ids).toEqual([B.uid]);
  });
});

describe('ping', () => {
  it('alıcının ping izni yoksa not_permitted; konumum yalnızca location_view iznim varsa eklenir', async () => {
    const [P, Q] = await Promise.all([newUser('Pelin'), newUser('Kaan')]);
    await befriend(P, Q, { grants: 'none' });
    const fcm = fakeFcm();
    const now = Date.now();
    const loc = { lat: 41.008238, lng: 28.978359, accuracy: 9, timestamp: now - 2_000 };

    const e = await pingSend(ctxOf(P, now), { op_id: opId(), to: Q.uid, kind: 'here', location: loc, eta_s: null }, fcm).then(
      () => null,
      (err: { details?: Record<string, unknown> }) => err,
    );
    expect(e && codeOf(e)).toBe('not_permitted');
    expect(fcm.sent).toHaveLength(0);

    // Q, P'ye ping izni verir; P henüz Q'ya konum izni vermedi → konum sessizce çıkarılır.
    await setPermission(Q, P, 'ping', true);
    // "Yoldayım" ETA'sı da konumdan türer: konumla birlikte çıkarılır (kayıtta ve push metninde yok).
    const r1 = await pingSend(ctxOf(P, now), { op_id: opId(), to: Q.uid, kind: 'on_way', location: loc, eta_s: 720 }, fcm);
    const rec1 = parsePing((await rtdb().ref(`ping_inbox/${Q.uid}/${r1.ping_id}`).once('value')).val(), r1.ping_id);
    expect(rec1).toMatchObject({ from: P.uid, kind: 'on_way', location: null, eta_s: null });
    expect(JSON.stringify(fcm.sent.at(-1)?.msg)).not.toMatch(/dk/);

    await setPermission(P, Q, 'location_view', true);
    const later = now + 60_000;
    const r2 = await pingSend(ctxOf(P, later), { op_id: opId(), to: Q.uid, kind: 'here', location: { ...loc, timestamp: later - 2_000 }, eta_s: null }, fcm);
    const rec2 = parsePing((await rtdb().ref(`ping_inbox/${Q.uid}/${r2.ping_id}`).once('value')).val(), r2.ping_id);
    expect(rec2?.location).toMatchObject({ lat: 41.008238, accuracy: 9 });
    // Push hiçbir zaman koordinat taşımaz.
    for (const m of fcm.sent) expect(JSON.stringify(m.msg)).not.toMatch(/41\.00|28\.97|"lat"/);

    // Ters yön: P'nin Q'ya ping izni vermemesi Q'nun P'ye pingini engeller.
    const back = await callError('ping_send', { op_id: opId(), to: P.uid, kind: 'here' }, Q);
    expect(codeOf(back)).toBe('not_permitted');
  });
});

describe('görünmez mod', () => {
  it('açınca paylaşımlar ve bağlantılar biter, yeni paylaşım invisible_mode; kapatınca yalnızca seçilenler eski bitişle döner', async () => {
    const [V, W1, W2] = await Promise.all([newUser('Vera'), newUser('Wael'), newUser('Yağmur')]);
    await befriend(V, W1);
    await befriend(V, W2);
    const r = await startShare(V, [W1, W2]);
    const s1 = r.shares.find((s) => s.receiver_id === W1.uid) as OutgoingShareView;
    const s2 = r.shares.find((s) => s.receiver_id === W2.uid) as OutgoingShareView;
    const link = await call<LinkShareCreateResponse>('link_share_create', { op_id: opId(), duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ }, V);

    const on = await call<InvisibleSetResponse>('invisible_set', { op_id: opId(), invisible: true }, V);
    expect(on.invisible).toBe(true);
    for (const s of [s1, s2]) {
      expect((await db().doc(`location_shares/${s.share_id}`).get()).data()).toMatchObject({ status: 'ended', end_reason: 'stopped_by_sender' });
      expect(await aclOf(s.share_id)).toMatchObject({ status: 'ended' });
    }
    expect((await rtdb().ref(`link_acl/${link.token_hash}`).once('value')).val()).toMatchObject({ status: 'ended' });
    const state = (await userDoc(V))?.invisible;
    expect(state).toMatchObject({ on: true, links_ended: 1 });
    expect(new Set(state.snapshot.map((e: { receiver_id: string }) => e.receiver_id))).toEqual(new Set([W1.uid, W2.uid]));

    // Canlı yazma ACL'den reddedilir; yeni paylaşım ve bağlantı başlamaz.
    await assertFails(writeLive(V, s1));
    expect(codeOf(await callError('share_start', { op_id: opId(), receiver_ids: [W1.uid], duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ }, V))).toBe(
      'invisible_mode',
    );
    expect(codeOf(await callError('link_share_create', { op_id: opId(), duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ }, V))).toBe('invisible_mode');
    expect(codeOf(await callError('link_share_extend', { op_id: opId(), link_id: link.link_id, minutes: 30 }, V))).toBe('invisible_mode');

    // Görünür ol: yalnızca W1 seçildi; eski bitiş saatiyle yeniden başlar, W2 kapalı kalır.
    const off = await call<InvisibleSetResponse>('invisible_set', { op_id: opId(), invisible: false, restore_receiver_ids: [W1.uid] }, V);
    expect(off).toMatchObject({ invisible: false, restored_receiver_ids: [W1.uid], skipped_receiver_ids: [] });
    expect((await userDoc(V))?.invisible ?? null).toBeNull();
    const back = await shareDoc(V, W1);
    expect(back).toMatchObject({ status: 'active', share_mode: 'timed', expires_at: s1.expires_at });
    expect(back?.session_id).not.toBe(s1.session_id);
    expect(await aclOf(s1.share_id)).toMatchObject({ status: 'active', expires_at: s1.expires_at });
    expect(await shareDoc(V, W2)).toMatchObject({ status: 'ended' });
  });
});

describe('onay kapısı (Güvenlik Sözleşmesi / KVKK)', () => {
  it('onaysız: konum çağrıları consent_required; koruyucu çağrılar çalışır; yanlış özet / kaydırmadan onay reddedilir', async () => {
    const N = await newUser('Nil', 'female', { consent: false });
    const gated = await callError('share_start', { op_id: opId(), receiver_ids: [N.uid], duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ }, N);
    expect(codeOf(gated)).toBe('consent_required');
    expect(gated.details?.current_version).toBe(CONSENT_VERSION);
    expect(codeOf(await callError('link_share_create', { op_id: opId(), duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ }, N))).toBe('consent_required');

    // Koruyucu işlemler onaysız çalışır; görünür olmak (paylaşımı geri getirebilir) onay ister.
    expect((await call('invisible_set', { op_id: opId(), invisible: true }, N)).invisible).toBe(true);
    expect(codeOf(await callError('invisible_set', { op_id: opId(), invisible: false }, N))).toBe('consent_required');

    // Gösterilen metin = onaylanan metin: eski sürüm / yanlış özet reddedilir; kaydırmadan onay şemada reddedilir.
    expect(codeOf(await callError('consent_accept', { op_id: opId(), version: CONSENT_VERSION, text_sha256: '0'.repeat(64), scrolled_to_bottom: true, platform: 'ios', app_version: 'test' }, N))).toBe(
      'consent_required',
    );
    await expect(acceptConsent(N, { version: '2020-01-01' })).rejects.toMatchObject({ details: { code: 'consent_required' } });
    await expect(acceptConsent(N, { scrolled_to_bottom: false })).rejects.toMatchObject({ details: { code: 'invalid_argument' } });
    expect((await userDoc(N))?.consent ?? null).toBeNull();

    const ok = await acceptConsent(N);
    expect(ok.consent.version).toBe(CONSENT_VERSION);
    const rec = (await db().doc(PATHS.consent(N.uid, CONSENT_VERSION)).get()).data();
    expect(rec).toMatchObject({ user_id: N.uid, version: CONSENT_VERSION, scrolled_to_bottom: true, platform: 'ios', withdrawn_at: null });
    expect((await call('invisible_set', { op_id: opId(), invisible: false }, N)).invisible).toBe(false);
    expect((await startShare(N, [N])).skipped_receiver_ids).toEqual([N.uid]);
  });

  it('onayı geri çekmek giden paylaşımları bitirir; sonra yalnızca koruyucu çağrılar çalışır', async () => {
    const [M, F] = await Promise.all([newUser('Mert'), newUser('Filiz')]);
    await befriend(M, F);
    const r = await startShare(M, [F]);
    const s = r.shares[0] as OutgoingShareView;

    const w = await call('consent_withdraw', { op_id: opId() }, M);
    expect(w).toMatchObject({ consent: null, shares_ended: 1, links_ended: 0 });
    expect(await shareDoc(M, F)).toMatchObject({ status: 'ended' });
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'ended' });
    expect((await db().doc(PATHS.consent(M.uid, CONSENT_VERSION)).get()).data()?.withdrawn_at).toEqual(expect.any(Number));
    expect((await userDoc(M))?.consent ?? null).toBeNull();

    expect(codeOf(await callError('share_start', { op_id: opId(), receiver_ids: [F.uid], duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ }, M))).toBe(
      'consent_required',
    );
    expect(codeOf(await callError('permission_set', { op_id: opId(), grantee_id: F.uid, scope: 'ping', granted: true }, M))).toBe('consent_required');
    // İzni geri almak ve engellemek onaysız da çalışır.
    expect((await setPermission(M, F, 'location_view', false)).scopes).not.toContain('location_view');
    await call('user_block', { op_id: opId(), user_id: F.uid }, M);
    expect(await grantOf(M, F)).toBeNull();
    expect(await grantOf(F, M)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SOS: göç, canlı alıcı listesi; onayı geri çekme temizliği
// ---------------------------------------------------------------------------

const sosLoc = (now: number) => ({ lat: 41.008238, lng: 28.978359, accuracy: 9, timestamp: now - 2_000 });
const sosDoc = async (id: string) => (await db().doc(`sos_alerts/${id}`).get()).data();
const noAddress = { address: async () => null };

describe('SOS ve izinler', () => {
  it('Faz 8 öncesi acil kişi listesi (izin yok): sos_send göç izni yazar ve gönderir', async () => {
    const [S, R] = await Promise.all([newUser('Selin'), newUser('Rana')]);
    await befriend(S, R, { grants: 'none' });
    // Eski kayıt: liste var, `sos_alert` izni yok (Faz 8 öncesi `emergency_contacts_set`).
    await db().doc(`users/${S.uid}`).update({ emergency_contacts: [R.uid] });
    expect(await grantOf(S, R)).toBeNull();
    const fcm = fakeFcm();
    const now = Date.now();
    const r = await sosSend(ctxOf(S, now), SosSendRequestSchema.parse({ op_id: opId(), location: sosLoc(now), address: 'Kadıköy' }), { send: fcm.send, ...noAddress });
    expect(r.recipients).toBe(1);
    expect(r.sos.recipient_ids).toEqual([R.uid]);
    expect((await grantOf(S, R))?.scopes.sos_alert?.via).toBe('migration');
    expect(fcm.sent.map((x) => x.uid)).toEqual([R.uid]);
    // Ters yön ve başka kapsam yazılmaz.
    expect(await grantOf(R, S)).toBeNull();
    expect(hasGrant(await grantOf(S, R), 'location_view')).toBe(false);
  });

  it('aktif SOS: listeden çıkan / engellenen kişi uyarıyı okumayı hemen bırakır; sos_update yeni kişiyi eklemez', async () => {
    const [S, R1, R2, R3] = await Promise.all([newUser('Selin'), newUser('Rıza'), newUser('Remzi'), newUser('Rüya')]);
    for (const r of [R1, R2, R3]) await befriend(S, r, { grants: 'none' });
    await call('emergency_contacts_set', { op_id: opId(), contact_ids: [R1.uid, R2.uid, R3.uid] }, S);
    const fcm = fakeFcm();
    const t0 = Date.now();
    const sent = await sosSend(ctxOf(S, t0), SosSendRequestSchema.parse({ op_id: opId(), location: sosLoc(t0), address: 'X' }), { send: fcm.send, ...noAddress });
    const id = sent.sos.sos_id;
    expect(sent.sos.recipient_ids).toEqual([R1.uid, R2.uid, R3.uid]);

    // Listeden çıkar: izin silinir VE aktif uyarının alıcılarından düşer.
    await call('emergency_contacts_set', { op_id: opId(), contact_ids: [R2.uid, R3.uid] }, S);
    expect((await sosDoc(id))?.recipient_ids).toEqual([R2.uid, R3.uid]);
    expect(hasGrant(await grantOf(S, R1), 'sos_alert')).toBe(false);
    // Engelleme: karşı taraf hemen düşer.
    await call('user_block', { op_id: opId(), user_id: R2.uid }, S);
    expect((await sosDoc(id))?.recipient_ids).toEqual([R3.uid]);
    // Arkadaşlık kaldırma (karşı taraftan): düşer.
    await call('friendship_remove', { op_id: opId(), friendship_id: friendshipId(S.uid, R3.uid) }, R3);
    expect((await sosDoc(id))?.recipient_ids).toEqual([]);

    // sos_update her güncellemede kesişim alır: listeye sonradan eklenen kişi push almadan akışa katılmaz.
    await call('emergency_contacts_set', { op_id: opId(), contact_ids: [R1.uid] }, S);
    const t1 = t0 + SOS_LIMITS.updateMinIntervalMs + 1_000;
    const upd = await sosUpdate(ctxOf(S, t1), SosUpdateRequestSchema.parse({ op_id: opId(), sos_id: id, location: sosLoc(t1) }), noAddress);
    expect(upd.sos.recipient_ids).toEqual([]);
    expect((await sosDoc(id))?.recipient_ids).toEqual([]);
  });
});

describe('onayı geri çekme: konumdan türeyen her şey kapanır', () => {
  it('aktif SOS kapanır ("güvende" push), yer notları silinir, önerilen buluşma iptal; koruyucu çağrılar onaysız çalışır; yeniden onay geçmişi korur', async () => {
    const [M, F] = await Promise.all([newUser('Mert'), newUser('Filiz')]);
    await befriend(M, F);
    await call('emergency_contacts_set', { op_id: opId(), contact_ids: [F.uid] }, M);
    const fcm = fakeFcm();
    const now = Date.now();
    const sos = (await sosSend(ctxOf(M, now), SosSendRequestSchema.parse({ op_id: opId(), location: sosLoc(now), address: 'X' }), { send: fcm.send, ...noAddress })).sos;
    const note = (
      await placeNoteUpsert(ctxOf(M, now), {
        op_id: opId(),
        note_id: null,
        emoji: null,
        text: 'Buradayım',
        position: { lat: 41, lng: 29, accuracy: 5 },
        visible_to: [F.uid],
        duration_ms: 60 * 60_000,
      })
    ).note;
    const meetup = (
      await meetupShare(
        ctxOf(M, now),
        MeetupShareRequestSchema.parse({
          op_id: opId(),
          to: [F.uid],
          place: { place_id: 'p1', name: 'Moda Kahve', address: null, location: { lat: 40.98, lng: 29.02 }, primary_type: 'cafe', category: 'cafe' },
          etas: [{ key: 'me', duration_s: 600, distance_m: 2_000, estimated: false }],
        }),
        { send: fcm.send },
      )
    ).meetup;
    expect(meetup.etas.map((e) => e.key)).toEqual([M.uid]);

    fcm.sent.length = 0;
    await consentWithdraw(ctxOf(M, now + 1_000), { op_id: opId() }, { send: fcm.send });
    expect(await sosDoc(sos.sos_id)).toMatchObject({ status: 'resolved', resolve_reason: 'safe', resolved_at: now + 1_000 });
    expect(fcm.sent.map((x) => [x.uid, x.msg.data?.type])).toEqual([[F.uid, 'sos_resolved']]);
    expect((await db().doc(`place_notes/${note.note_id}`).get()).exists).toBe(false);
    expect((await db().doc(`meetups/${meetup.meetup_id}`).get()).data()).toMatchObject({ status: 'cancelled' });
    expect((await userDoc(M))?.consent ?? null).toBeNull();

    // Kendi verisini kapatmak / silmek onaysız çalışır (kapıdaki kullanıcı kendi verisini her zaman kaldırır).
    expect((await call('sos_resolve', { op_id: opId(), sos_id: sos.sos_id }, M)).sos.status).toBe('resolved');
    expect((await call('place_note_delete', { op_id: opId(), note_id: note.note_id }, M)).deleted).toBe(false);
    expect((await call('meetup_cancel', { op_id: opId(), meetup_id: meetup.meetup_id }, M)).meetup.status).toBe('cancelled');
    expect(codeOf(await callError('place_note_upsert', { op_id: opId(), note_id: null, emoji: null, text: 'x', position: { lat: 41, lng: 29, accuracy: 5 }, visible_to: [], duration_ms: 60 * 60_000 }, M))).toBe(
      'consent_required',
    );

    // Yeniden onay: önceki onay ve geri çekme anı kaydın geçmişinde kalır (üzerine yazılmaz).
    const first = (await db().doc(PATHS.consent(M.uid, CONSENT_VERSION)).get()).data();
    await acceptConsent(M);
    const rec = (await db().doc(PATHS.consent(M.uid, CONSENT_VERSION)).get()).data();
    expect(rec).toMatchObject({ withdrawn_at: null, history: [{ accepted_at: first?.accepted_at, withdrawn_at: now + 1_000, platform: 'ios' }] });
    expect(rec?.accepted_at).toBeGreaterThanOrEqual(first?.accepted_at);
  });
});
