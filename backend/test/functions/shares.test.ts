/**
 * Paylaşım callable'ları uçtan uca: Auth emülatöründe telefonla giriş → callable (Functions emülatörü)
 * → Firestore + RTDB ACL aynası → istemci kimliğiyle canlı konum yazması (RTDB kuralları).
 */
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  HOUR,
  MINUTE,
  type OutgoingShareView,
  type ShareStartResponse,
  blockId,
  friendshipId,
  shareId,
  sortedPair,
} from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mirrorAcl } from '../../functions/src/acl';
import { db, rtdb } from '../../functions/src/admin';
import { sweepExpired } from '../../functions/src/handlers/sweeper';
import {
  type TestUser,
  call,
  callError,
  cleanupRulesEnv,
  clientDb,
  deliveredFor,
  livePathOf,
  newUser,
  opId,
  waitFor,
  DATABASE_RULES,
} from '../helpers/emulator';
import { DB_HOST, RTDB_NS } from '../helpers/env';
import { grantAll } from '../review/helpers';

const TZ = 'Europe/Istanbul';

/** Faz 8: arkadaşlık + iki yönde tüm istenebilir izinler (bu dosyanın Faz 1 anlamı korunur). */
async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: b.invite_code }, a);
  const r = await call('friend_request_respond', { op_id: opId(), friendship_id: friendshipId(a.uid, b.uid), accept: true }, b);
  expect(r.status).toBe('accepted');
  await grantAll(a, b);
}

async function start(sender: TestUser, receivers: TestUser[], duration: unknown = { kind: 'preset', preset: 'h1' }, op = opId()) {
  return call<ShareStartResponse>(
    'share_start',
    { op_id: op, receiver_ids: receivers.map((r) => r.uid), duration, time_zone: TZ },
    sender,
  );
}

const aclOf = async (id: string) => (await rtdb().ref(`share_acl/${id}`).once('value')).val();
const liveOf = async (sender: TestUser, receiver: TestUser) =>
  (await rtdb().ref(livePathOf({ sender_id: sender.uid, receiver_id: receiver.uid })).once('value')).val();
const shareDoc = async (sender: TestUser, receiver: TestUser) =>
  (await db().doc(`location_shares/${shareId(sender.uid, receiver.uid)}`).get()).data();

function target(s: OutgoingShareView, sender: TestUser) {
  return { sender_id: sender.uid, receiver_id: s.receiver_id, share_mode: s.share_mode, expires_at: s.expires_at };
}

async function writeLive(sender: TestUser, s: OutgoingShareView, expiresAt: number | null = s.expires_at) {
  const t = { ...target(s, sender), expires_at: expiresAt };
  // core buildPackets süresi dolmuş hedefi atlar; reddi sınayabilmek için paket geçici bir gelecek bitişle
  // üretilip expires_at sonra istenen değere çekilir.
  const base = deliveredFor({ ...t, expires_at: expiresAt === null ? null : Date.now() + HOUR });
  const v = expiresAt === null ? base : { ...base, expires_at: expiresAt };
  return (await clientDb(sender.uid)).ref(livePathOf(t)).set(v);
}

let A: TestUser; // gönderen
let B: TestUser; // arkadaş
let C: TestUser; // yabancı
let D: TestUser; // A'yı engelledi
let E: TestUser; // tutarsız durum: kabul edilmiş arkadaşlık + engel (savunma derinliği)

beforeAll(async () => {
  [A, B, C, D, E] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Deniz'), newUser('Ece')]);
  await befriend(A, B);
  await befriend(A, D);
  await call('user_block', { op_id: opId(), user_id: A.uid }, D);
  // E: arkadaşlık belgesi "accepted" ama E → A engeli var (normalde engel arkadaşlığı siler).
  const now = Date.now();
  await db().doc(`friendships/${friendshipId(A.uid, E.uid)}`).set({
    id: friendshipId(A.uid, E.uid),
    member_ids: sortedPair(A.uid, E.uid),
    status: 'accepted',
    requested_by: A.uid,
    via: 'invite_code',
    member_profiles: {},
    created_at: now,
    updated_at: now,
    accepted_at: now,
  });
  await db().doc(`blocks/${blockId(E.uid, A.uid)}`).set({ blocker_id: E.uid, blocked_id: A.uid, created_at: now });
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('ortam', () => {
  it('firebase.json RTDB kuralları Functions ile aynı ad alanına yüklendi', async () => {
    const res = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${RTDB_NS}`, { headers: { Authorization: 'Bearer owner' } });
    expect(JSON.parse(await res.text())).toEqual(JSON.parse(DATABASE_RULES));
  });
});

describe('share_start', () => {
  it('arkadaş olmayanları, engellileri ve kendini sessizce atlar', async () => {
    const r = await start(A, [B, C, D, E, A]);
    expect(r.shares.map((s) => s.receiver_id)).toEqual([B.uid]);
    expect(new Set(r.skipped_receiver_ids)).toEqual(new Set([C.uid, D.uid, E.uid, A.uid]));
    for (const u of [C, D, E]) {
      expect(await shareDoc(A, u)).toBeUndefined();
      expect(await aclOf(shareId(A.uid, u.uid))).toBeNull();
    }
    const s = r.shares[0] as OutgoingShareView;
    expect(s).toMatchObject({ status: 'active', share_mode: 'timed', session_id: r.session_id, end_reason: null });
    expect(s.expires_at).toBe((s.started_at as number) + 60 * MINUTE);
    expect(Math.abs(r.server_now - Date.now())).toBeLessThan(30_000);
    expect(await aclOf(s.share_id)).toEqual({
      sender_id: A.uid,
      receiver_id: B.uid,
      status: 'active',
      share_mode: 'timed',
      expires_at: s.expires_at,
      version: s.version,
      // Faz 3: kuyruk (q: 1) ve iz noktalarının alt sınırı.
      started_at: s.started_at,
    });
  });

  it('share_start sonrası geçerli canlı yazma geçer; yalnızca alıcı okur', async () => {
    const r = await start(A, [B]);
    const s = r.shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(A, s));
    const recv = await clientDb(B.uid);
    const snap = await assertSucceeds(recv.ref(`live_locations/${B.uid}/${s.share_id}`).once('value'));
    expect(snap.val()).toMatchObject({ v: 1, share_id: s.share_id, sender_id: A.uid, expires_at: s.expires_at });
    expect(snap.val()).not.toHaveProperty('receiver_ids');
    await assertFails((await clientDb(C.uid)).ref(`live_locations/${B.uid}`).once('value'));
    // Arkadaş olmayana yazma (ACL yok) reddedilir.
    const fake: OutgoingShareView = { ...s, share_id: shareId(A.uid, C.uid), receiver_id: C.uid };
    await assertFails(writeLive(A, fake));
  });

  it('aynı op_id ile tekrar aynı yanıtı döner ve ikinci kez uygulanmaz', async () => {
    const op = opId();
    const first = await start(A, [B], { kind: 'preset', preset: 'm15' }, op);
    const second = await start(A, [B], { kind: 'preset', preset: 'm15' }, op);
    expect(second).toEqual(first);
    const doc = await shareDoc(A, B);
    expect(doc?.session_id).toBe(first.session_id);
    expect(doc?.version).toBe(first.shares[0]?.version);
    // Farklı op_id yeni oturum açar ve sürümü artırır.
    const third = await start(A, [B], { kind: 'preset', preset: 'm15' });
    expect(third.session_id).not.toBe(first.session_id);
    expect(third.shares[0]?.version).toBe((first.shares[0]?.version ?? 0) + 1);
  });

  it('geçersiz süre ve saat dilimi hata kodu taşır', async () => {
    const e1 = await callError('share_start', { op_id: opId(), receiver_ids: [B.uid], duration: { kind: 'custom_minutes', minutes: 2 }, time_zone: TZ }, A);
    expect(e1.status).toBe('INVALID_ARGUMENT');
    expect(e1.details).toMatchObject({ code: 'invalid_duration', reason: 'too_short', retryable: false });
    const e2 = await callError('share_start', { op_id: opId(), receiver_ids: [B.uid], duration: { kind: 'end_of_day' }, time_zone: 'Mars/Olympus' }, A);
    expect(e2.details).toMatchObject({ code: 'invalid_argument' });
    const e3 = await callError('share_start', { op_id: 'not-a-uuid', receiver_ids: [B.uid], duration: { kind: 'weekly' }, time_zone: TZ }, A);
    expect(e3.details).toMatchObject({ code: 'invalid_argument' });
    const e4 = await callError('share_start', { op_id: opId(), receiver_ids: [B.uid], duration: { kind: 'weekly' }, time_zone: TZ }, null);
    expect(e4.status).toBe('UNAUTHENTICATED');
    expect(e4.details).toMatchObject({ code: 'unauthenticated' });
  });

  it('gün sonu sunucuda kullanıcının saat diliminde hesaplanır; süresiz ACL expires_at taşımaz', async () => {
    const eod = await start(A, [B], { kind: 'end_of_day' });
    const s = eod.shares[0] as OutgoingShareView;
    expect(s.share_mode).toBe('until_end_of_day');
    // Europe/Istanbul = UTC+3: yerel gece yarısı UTC 21:00.
    expect(new Date(s.expires_at as number).getUTCHours()).toBe(21);
    const forever = await start(A, [B], { kind: 'indefinite' });
    const f = forever.shares[0] as OutgoingShareView;
    expect(f.expires_at).toBeNull();
    expect(await aclOf(f.share_id)).not.toHaveProperty('expires_at');
    await assertSucceeds(writeLive(A, f, null));
  });
});

describe('share_extend', () => {
  it('expires_at ve ACL ilerler; yeni bitişle yazma geçer, eskisiyle reddedilir', async () => {
    const r = await start(A, [B], { kind: 'preset', preset: 'm15' });
    const s = r.shares[0] as OutgoingShareView;
    const ext = await call('share_extend', { op_id: opId(), session_id: r.session_id, minutes: 30 }, A);
    expect(ext.expires_at).toBe((s.expires_at as number) + 30 * MINUTE);
    expect(ext.shares[0]).toMatchObject({ share_id: s.share_id, version: s.version + 1, expires_at: ext.expires_at });
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'active', expires_at: ext.expires_at, version: s.version + 1 });
    const doc = await shareDoc(A, B);
    expect(doc).toMatchObject({ extended_count: 1, expires_at: ext.expires_at });
    await assertSucceeds(writeLive(A, s, ext.expires_at));
    await assertFails(writeLive(A, s, s.expires_at));

    const ext2 = await call('share_extend', { op_id: opId(), session_id: r.session_id, minutes: 60 }, A);
    expect(ext2.expires_at).toBe(ext.expires_at + 60 * MINUTE);
  });

  it('gün sonu uzatılınca timed olur; süresiz uzatılamaz; bilinmeyen oturum share_not_active', async () => {
    const eod = await start(A, [B], { kind: 'end_of_day' });
    const ext = await call('share_extend', { op_id: opId(), session_id: eod.session_id, minutes: 60 }, A);
    expect(ext.share_mode).toBe('timed');
    const forever = await start(A, [B], { kind: 'indefinite' });
    const e1 = await callError('share_extend', { op_id: opId(), session_id: forever.session_id, minutes: 30 }, A);
    expect(e1.details).toMatchObject({ code: 'invalid_duration' });
    const e2 = await callError('share_extend', { op_id: opId(), session_id: 'yok', minutes: 30 }, A);
    expect(e2.details).toMatchObject({ code: 'share_not_active' });
    // Başkasının oturumu: bulunamaz (sorgu sender_id == çağıran).
    const e3 = await callError('share_extend', { op_id: opId(), session_id: forever.session_id, minutes: 30 }, B);
    expect(e3.details).toMatchObject({ code: 'share_not_active' });
  });
});

describe('share_stop / share_revoke', () => {
  it('share_stop canlı kopyayı siler, ACL mezar taşı yazar ve sonraki yazma reddedilir', async () => {
    const r = await start(A, [B]);
    const s = r.shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(A, s));
    expect(await liveOf(A, B)).not.toBeNull();

    const stop = await call('share_stop', { op_id: opId(), session_id: r.session_id }, A);
    expect(stop.shares[0]).toMatchObject({ status: 'ended', end_reason: 'stopped_by_sender', version: s.version + 1 });
    expect(await liveOf(A, B)).toBeNull();
    const stoppedDoc = await shareDoc(A, B);
    expect(stoppedDoc).toMatchObject({ status: 'ended', end_reason: 'stopped_by_sender' });
    // Mezar taşı uid çifti taşımaz; ended_at belgeyle aynıdır (7 gün sonra temizlenir).
    expect(await aclOf(s.share_id)).toEqual({ status: 'ended', version: s.version + 1, ended_at: stoppedDoc?.ended_at });
    await assertFails(writeLive(A, s));

    // Tekrar durdurmak idempotenttir.
    const again = await call('share_stop', { op_id: opId(), session_id: r.session_id }, A);
    expect(again.shares[0]).toMatchObject({ status: 'ended', version: s.version + 1 });
  });

  it('eski sürümlü ayna yazması yeni mezar taşını ezemez', async () => {
    const r = await start(A, [B]);
    const s = r.shares[0] as OutgoingShareView;
    await call('share_stop', { op_id: opId(), session_id: r.session_id }, A);
    const res = await mirrorAcl({
      share_id: s.share_id,
      sender_id: A.uid,
      receiver_id: B.uid,
      status: 'active',
      share_mode: s.share_mode,
      expires_at: s.expires_at,
      ended_at: null,
      end_reason: null,
      version: s.version,
    });
    expect(res.applied).toBe(false);
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'ended', version: s.version + 1 });
    await assertFails(writeLive(A, s));
  });

  it('share_revoke: alıcı kapatır, canlı kopya silinir, gönderen yazamaz', async () => {
    const r = await start(A, [B]);
    const s = r.shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(A, s));
    const rev = await call('share_revoke', { op_id: opId(), sender_id: A.uid }, B);
    expect(rev).toMatchObject({ share_id: s.share_id, status: 'ended' });
    expect(await liveOf(A, B)).toBeNull();
    expect(await shareDoc(A, B)).toMatchObject({ status: 'ended', end_reason: 'revoked_by_receiver' });
    await assertFails(writeLive(A, s));
    // Paylaşım hiç yoksa da aynı yanıt (C → B paylaşımı yok).
    const none = await call('share_revoke', { op_id: opId(), sender_id: C.uid }, B);
    expect(none.status).toBe('ended');
  });
});

describe('süre dolumu', () => {
  it('tarama (enjekte saat) paylaşımı expired ile bitirir; sonraki yazma reddedilir', async () => {
    const r = await start(A, [B], { kind: 'custom_minutes', minutes: 5 });
    const s = r.shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(A, s));

    // Henüz süresi dolmadı: dokunulmaz.
    const early = await sweepExpired({ now: Date.now() });
    expect(early.ended_share_ids).not.toContain(s.share_id);

    const res = await sweepExpired({ now: (s.expires_at as number) + 1 });
    expect(res.ended_share_ids).toContain(s.share_id);
    expect(await shareDoc(A, B)).toMatchObject({ status: 'ended', end_reason: 'expired', version: s.version + 1 });
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'ended', version: s.version + 1 });
    expect(await liveOf(A, B)).toBeNull();
    await assertFails(writeLive(A, s));
  });
});

describe('uzlaştırıcı (onDocumentWritten)', () => {
  it('commit ile ayna arasında kaybolan ACL, belge yazımında yeniden uygulanır', async () => {
    const r = await start(A, [B]);
    const s = r.shares[0] as OutgoingShareView;
    // share_start'ın kendi tetikleyicisi de aynayı uygular; o bitsin diye kısa bekleme (yalnızca test düzeni).
    await new Promise((r) => setTimeout(r, 1_500));
    // "Çökme" benzetimi: ayna yok (ACL'siz yazmanın reddi kural testlerinde ayrıca sınanır).
    await rtdb().ref(`share_acl/${s.share_id}`).remove();
    await db().doc(`location_shares/${s.share_id}`).update({ updated_at: Date.now() });
    const acl = await waitFor(async () => aclOf(s.share_id));
    expect(acl).toMatchObject({ status: 'active', version: s.version });
    await assertSucceeds(writeLive(A, s));
  });
});

describe('arkadaşlık kaldırma ve engelleme', () => {
  it('friendship_remove iki yöndeki paylaşımları friendship_removed ile bitirir', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const xy = (await start(X, [Y])).shares[0] as OutgoingShareView;
    const yx = (await start(Y, [X])).shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(X, xy));
    await assertSucceeds(writeLive(Y, yx));
    await call('friendship_remove', { op_id: opId(), friendship_id: friendshipId(X.uid, Y.uid) }, X);
    expect(await shareDoc(X, Y)).toMatchObject({ status: 'ended', end_reason: 'friendship_removed' });
    expect(await shareDoc(Y, X)).toMatchObject({ status: 'ended', end_reason: 'friendship_removed' });
    expect(await liveOf(X, Y)).toBeNull();
    expect(await liveOf(Y, X)).toBeNull();
    await assertFails(writeLive(Y, yx));
    const again = await start(X, [Y]);
    expect(again.skipped_receiver_ids).toEqual([Y.uid]);
  });

  it('user_block paylaşımları bitirir (engellenene "blocked" sızdırmadan) ve bekleyen konum isteğini iptal eder', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const xy = (await start(X, [Y])).shares[0] as OutgoingShareView;
    const yx = (await start(Y, [X])).shares[0] as OutgoingShareView;
    const req = await call('location_request_send', { op_id: opId(), target_id: X.uid }, Y);
    await call('user_block', { op_id: opId(), user_id: Y.uid }, X);
    // Engellenen de paylaşım belgesini okuyabilir: neden arkadaşlıktan çıkarılmayla aynıdır.
    expect(await shareDoc(X, Y)).toMatchObject({ status: 'ended', end_reason: 'friendship_removed' });
    expect(await shareDoc(Y, X)).toMatchObject({ status: 'ended', end_reason: 'friendship_removed' });
    await assertFails(writeLive(Y, yx));
    expect((await db().doc(`location_requests/${req.request_id}`).get()).data()).toMatchObject({ status: 'cancelled' });
    expect((await db().doc(`friendships/${friendshipId(X.uid, Y.uid)}`).get()).exists).toBe(false);
    await assertFails(writeLive(X, xy));
    // Engellenen, engelleyene paylaşım başlatamaz ve istek gönderemez.
    expect((await start(Y, [X])).skipped_receiver_ids).toEqual([X.uid]);
    const e = await callError('location_request_send', { op_id: opId(), target_id: X.uid }, Y);
    expect(e.details).toMatchObject({ code: 'not_friends' });
  });
});
