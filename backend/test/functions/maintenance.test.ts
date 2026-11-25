/**
 * Bakım işleri: pasif hesap süreci (geri dönüştürülmüş numara savunması) ve FCM token sahipliği.
 * İşleyiciler test sürecinde enjekte edilen saatle doğrudan çağrılır.
 */
import { randomUUID } from 'node:crypto';
import { DAY, type OutgoingShareView, type ShareStartResponse, friendshipId, shareId } from '@konum/core';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../functions/src/admin';
import { sweepInactive } from '../../functions/src/handlers/user';
import { resolvePushTokens } from '../../functions/src/push';
import { type TestUser, call, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';
import { grantAll } from '../review/helpers';

afterAll(async () => {
  await cleanupRulesEnv();
});

async function befriend(a: TestUser, b: TestUser): Promise<void> {
  await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: b.invite_code }, a);
  await call('friend_request_respond', { op_id: opId(), friendship_id: friendshipId(a.uid, b.uid), accept: true }, b);
  await grantAll(a, b); // Faz 8: iki yönde tüm istenebilir izinler
}

const start = (sender: TestUser, receiver: TestUser) =>
  call<ShareStartResponse>(
    'share_start',
    { op_id: opId(), receiver_ids: [receiver.uid], duration: { kind: 'weekly' }, time_zone: 'Europe/Istanbul' },
    sender,
  );

const shareOf = async (s: TestUser, r: TestUser) => (await db().doc(`location_shares/${shareId(s.uid, r.uid)}`).get()).data();
const userOf = async (u: TestUser) => (await db().doc(`users/${u.uid}`).get()).data();

describe('pasif hesap süreci', () => {
  it('30 gün: gelen paylaşımlar biter; 180 gün: sosyal grafik sıfırlanır; girişte yeniden aktif', async () => {
    const [X, Y] = await Promise.all([newUser('Pasif'), newUser('Arkadas')]);
    await befriend(X, Y);
    const incoming = (await start(Y, X)).shares[0] as OutgoingShareView;
    const outgoing = (await start(X, Y)).shares[0] as OutgoingShareView;
    const now = Date.now();

    await db().doc(`users/${X.uid}`).update({ last_active_at: now - 31 * DAY });
    const r1 = await sweepInactive({ now });
    expect(r1.cut).toContain(X.uid);
    expect(r1.cut).not.toContain(Y.uid);
    expect(await shareOf(Y, X)).toMatchObject({ status: 'ended', version: incoming.version + 1 });
    expect(await shareOf(X, Y)).toMatchObject({ status: 'active', version: outgoing.version });
    expect((await userOf(X))?.inactivity_state).toBe('incoming_cut');
    expect((await db().doc(`friendships/${friendshipId(X.uid, Y.uid)}`).get()).exists).toBe(true);

    // İdempotent: aynı durumda tekrar kesmez.
    expect((await sweepInactive({ now })).cut).not.toContain(X.uid);

    await db().doc(`users/${X.uid}`).update({ last_active_at: now - 181 * DAY });
    const r2 = await sweepInactive({ now });
    expect(r2.reset).toContain(X.uid);
    expect((await db().doc(`friendships/${friendshipId(X.uid, Y.uid)}`).get()).exists).toBe(false);
    expect(await shareOf(X, Y)).toMatchObject({ status: 'ended', end_reason: 'friendship_removed' });
    expect((await userOf(X))?.inactivity_state).toBe('graph_reset');

    // Hesap sahibi geri döner: kalp atışı durumu aktif yapar.
    await call('user_bootstrap', {}, X);
    expect(await userOf(X)).toMatchObject({ inactivity_state: 'active' });
    expect(Math.abs(((await userOf(X))?.last_active_at as number) - Date.now())).toBeLessThan(60_000);
  });

  it('yakın zamanda konum yayınlayan cihazın sosyal grafiği sıfırlanmaz', async () => {
    const [X, Y] = await Promise.all([newUser('Yayinci'), newUser('Alici')]);
    await befriend(X, Y);
    const s = (await start(X, Y)).shares[0] as OutgoingShareView;
    const { rtdb } = await import('../../functions/src/admin');
    await rtdb().ref(`live_locations/${Y.uid}/${s.share_id}/server_ts`).set(Date.now());
    const now = Date.now();
    await db().doc(`users/${X.uid}`).update({ last_active_at: now - 181 * DAY, inactivity_state: 'incoming_cut' });
    const r = await sweepInactive({ now });
    expect(r.reset).not.toContain(X.uid);
    expect((await db().doc(`friendships/${friendshipId(X.uid, Y.uid)}`).get()).exists).toBe(true);
    expect(await shareOf(X, Y)).toMatchObject({ status: 'active' });
  });
});

describe('FCM token sahipliği', () => {
  const put = (uid: string, id: string, token: string) =>
    db().doc(`devices/${uid}/tokens/${id}`).set({ token, platform: 'ios', updated_at: Date.now() });

  it('aynı cihazda hesap değişince token yalnızca SON sahibine gider; eski kopya silinir', async () => {
    const a = `pa${randomUUID().slice(0, 8)}`;
    const b = `pb${randomUUID().slice(0, 8)}`;
    const token = `tok-${randomUUID()}`;
    await put(a, 't', token);
    await new Promise((r) => setTimeout(r, 20));
    await put(b, 't', token); // B aynı cihazda giriş yaptı
    expect(await resolvePushTokens(a)).toEqual([]);
    expect((await db().doc(`devices/${a}/tokens/t`).get()).exists).toBe(false);
    const mine = await resolvePushTokens(b);
    expect(mine.map((t) => t.token)).toEqual([token]);
  });

  it('kullanıcı başına en yeni 10 token kullanılır, fazlası silinir', async () => {
    const u = `pc${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 12; i++) await put(u, `t${String(i).padStart(2, '0')}`, `tok-${randomUUID()}`);
    const kept = await resolvePushTokens(u);
    expect(kept).toHaveLength(10);
    const left = await db().collection(`devices/${u}/tokens`).get();
    expect(left.size).toBe(10);
    expect(left.docs.map((d) => d.id)).not.toContain('t00');
    expect(left.docs.map((d) => d.id)).not.toContain('t01');
  });
});
