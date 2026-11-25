/**
 * Konum istekleri: gönderme, bekleyen tekillik, bekleme süresi, kabulde paylaşım (varsayılan 1 saat),
 * ret ve 15 dk sonra süre dolumu.
 */
import { MINUTE, friendshipId, requestId, shareId } from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import { sweepExpired } from '../../functions/src/handlers/sweeper';
import { type TestUser, call, callError, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';
import { grantAll } from '../review/helpers';

/** Faz 8: varsayılan olarak iki yönde tüm istenebilir izinler; `grants: 'none'` yalnızca arkadaşlık. */
async function friends(opts: { grants?: 'all' | 'none' } = {}): Promise<[TestUser, TestUser]> {
  const [X, Y] = await Promise.all([newUser('İsteyen'), newUser('Hedef')]);
  await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: Y.invite_code }, X);
  await call('friend_request_respond', { op_id: opId(), friendship_id: friendshipId(X.uid, Y.uid), accept: true }, Y);
  if ((opts.grants ?? 'all') === 'all') await grantAll(X, Y);
  return [X, Y];
}

const reqDoc = async (id: string) => (await db().doc(`location_requests/${id}`).get()).data();

let stranger: TestUser;
beforeAll(async () => {
  stranger = await newUser('Yabancı');
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('location_request_send', () => {
  it('bekleyen istek oluşturur; ikinci gönderim aynı isteği döner', async () => {
    const [X, Y] = await friends();
    const r1 = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    expect(r1).toMatchObject({ request_id: requestId(X.uid, Y.uid), status: 'pending' });
    expect(r1.expires_at - r1.server_now).toBe(15 * MINUTE);
    const r2 = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    expect(r2.expires_at).toBe(r1.expires_at);
    expect(await reqDoc(r1.request_id)).toMatchObject({ requester_id: X.uid, target_id: Y.uid, status: 'pending', share_id: null });
  });

  it('arkadaş olmayana not_friends; kendine invalid_argument', async () => {
    const [X] = await friends();
    const e = await callError('location_request_send', { op_id: opId(), target_id: stranger.uid }, X);
    expect(e.details).toMatchObject({ code: 'not_friends' });
    const self = await callError('location_request_send', { op_id: opId(), target_id: X.uid }, X);
    expect(self.details).toMatchObject({ code: 'invalid_argument' });
  });

  it('retten sonra 10 dk bekleme: rate_limited', async () => {
    const [X, Y] = await friends();
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    await call('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: false }, Y);
    expect((await reqDoc(r.request_id))?.status).toBe('rejected');
    const e = await callError('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    expect(e.status).toBe('RESOURCE_EXHAUSTED');
    expect(e.details).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(Number(e.details?.retry_after_ms)).toBeGreaterThan(0);
  });
});

describe('location_request_cancel', () => {
  it('yalnızca isteyen geri çeker; idempotent; bekleme süresi sıfırlanmaz', async () => {
    const [X, Y] = await friends();
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    const notMine = await callError('location_request_cancel', { op_id: opId(), request_id: r.request_id }, Y);
    expect(notMine.status).toBe('NOT_FOUND');
    const c = await call('location_request_cancel', { op_id: opId(), request_id: r.request_id }, X);
    expect(c.status).toBe('cancelled');
    expect((await reqDoc(r.request_id))?.status).toBe('cancelled');
    const again = await call('location_request_cancel', { op_id: opId(), request_id: r.request_id }, X);
    expect(again.status).toBe('cancelled');
    const late = await callError('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: true }, Y);
    expect(late.status).toBe('FAILED_PRECONDITION');
    const resend = await callError('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    expect(resend.details).toMatchObject({ code: 'rate_limited' });
  });
});

describe('location_request_respond', () => {
  it('kabul: hedef → isteyen paylaşımı varsayılan 1 saat; istek aynı transaction\'da accepted', async () => {
    const [X, Y] = await friends();
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    // İsteyen kendi isteğine yanıt veremez.
    const wrong = await callError('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: true }, X);
    expect(wrong.status).toBe('NOT_FOUND');

    const ok = await call('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: true }, Y);
    expect(ok.status).toBe('approved');
    expect(ok.share).toMatchObject({ share_id: shareId(Y.uid, X.uid), receiver_id: X.uid, status: 'active', share_mode: 'timed' });
    expect(ok.share.expires_at - ok.share.started_at).toBe(60 * MINUTE);
    expect(await reqDoc(r.request_id)).toMatchObject({ status: 'approved', share_id: shareId(Y.uid, X.uid) });
    expect((await db().doc(`location_shares/${shareId(Y.uid, X.uid)}`).get()).data()).toMatchObject({
      in_response_to: r.request_id,
      sender_id: Y.uid,
    });
    expect((await rtdb().ref(`share_acl/${shareId(Y.uid, X.uid)}`).once('value')).val()).toMatchObject({ status: 'active' });

    const again = await callError('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: true }, Y);
    expect(again.status).toBe('FAILED_PRECONDITION');
  });

  it('kabulde verilen süre kullanılır', async () => {
    const [X, Y] = await friends();
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    const ok = await call(
      'location_request_respond',
      { op_id: opId(), request_id: r.request_id, accept: true, duration: { kind: 'preset', preset: 'm15' }, time_zone: 'Europe/Istanbul' },
      Y,
    );
    expect(ok.share.expires_at - ok.share.started_at).toBe(15 * MINUTE);
  });

  it('kabul mevcut paylaşımı kısaltmaz: istek beklerken başlayan daha kısa paylaşım aynı oturumda uzar', async () => {
    const [X, Y] = await friends();
    const r1 = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    const short = await call(
      'share_start',
      { op_id: opId(), receiver_ids: [X.uid], duration: { kind: 'preset', preset: 'm15' }, time_zone: 'Europe/Istanbul' },
      Y,
    );
    const s0 = short.shares[0];
    const up = await call('location_request_respond', { op_id: opId(), request_id: r1.request_id, accept: true }, Y);
    // Varsayılan 1 saat > 15 dk: aynı oturum, sürüm +1, yeni bitiş; ACL yeni sürümde.
    expect(up.session_id).toBe(short.session_id);
    expect(up.share).toMatchObject({ share_id: s0.share_id, version: s0.version + 1, share_mode: 'timed' });
    expect(up.share.expires_at).toBe(up.server_now + 60 * MINUTE);
    expect((await rtdb().ref(`share_acl/${s0.share_id}`).once('value')).val()).toMatchObject({
      status: 'active',
      version: s0.version + 1,
      expires_at: up.share.expires_at,
    });
    expect((await db().doc(`location_shares/${s0.share_id}`).get()).data()).toMatchObject({ in_response_to: r1.request_id });
    expect(await reqDoc(r1.request_id)).toMatchObject({ status: 'approved', share_id: s0.share_id });
  });

  it('hedef zaten paylaşıyorsa yeni istek oluşmaz (already_sharing)', async () => {
    const [X, Y] = await friends();
    await call('share_start', { op_id: opId(), receiver_ids: [X.uid], duration: { kind: 'preset', preset: 'h1' }, time_zone: 'Europe/Istanbul' }, Y);
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    expect(r).toMatchObject({ status: 'already_sharing', expires_at: null });
    expect(await reqDoc(r.request_id)).toBeUndefined();
  });

  it('izin yokken onay yalnızca hedef → isteyen location_view yazar; ters yön yok', async () => {
    const [X, Y] = await friends({ grants: 'none' });
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    await call('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: true, duration: { kind: 'weekly' }, time_zone: 'Europe/Istanbul' }, Y);
    const out = (await db().doc(`permission_grants/${Y.uid}_${X.uid}`).get()).data();
    expect(out?.scopes?.location_view?.via).toBe('location_request');
    expect((await db().doc(`permission_grants/${X.uid}_${Y.uid}`).get()).data()?.scopes?.location_view).toBeUndefined();
  });

  it('görünmez hedef onaylayamaz (invisible_mode), reddedebilir', async () => {
    const [X, Y] = await friends();
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    await call('invisible_set', { op_id: opId(), invisible: true }, Y);
    const e = await callError('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: true }, Y);
    expect(e.details).toMatchObject({ code: 'invisible_mode' });
    const no = await call('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: false }, Y);
    expect(no.status).toBe('rejected');
  });

  it('share_start(in_response_to) isteği de kapatır', async () => {
    const [X, Y] = await friends();
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    await call(
      'share_start',
      { op_id: opId(), receiver_ids: [X.uid], duration: { kind: 'preset', preset: 'h8' }, time_zone: 'Europe/Istanbul', in_response_to: r.request_id },
      Y,
    );
    expect(await reqDoc(r.request_id)).toMatchObject({ status: 'approved', share_id: shareId(Y.uid, X.uid) });
  });

  it('15 dk sonra tarama isteği expired yapar; süresi dolmuş isteğe yanıt already_expired', async () => {
    const [X, Y] = await friends();
    const r = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    const res = await sweepExpired({ now: r.expires_at + 1 });
    expect(res.expired_request_ids).toContain(r.request_id);
    expect((await reqDoc(r.request_id))?.status).toBe('expired');
    const e = await callError('location_request_respond', { op_id: opId(), request_id: r.request_id, accept: true }, Y);
    expect(e.status).toBe('FAILED_PRECONDITION');
  });
});
