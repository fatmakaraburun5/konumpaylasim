/**
 * Faz 6: kayıtta zorunlu cinsiyet + profil yayılımı, avatar çifti doğrulaması, favoriler, widget token'ı ve
 * widget'tan tek tuşla 1 saatlik paylaşım. Çoğu çağrı Functions emülatörü üzerinden (şema, hata eşlemesi, OTURUMSUZ
 * `widget_quick_share`); bildirim içeriği ve hız sınırı için işleyiciler test sürecinde sahte FCM ile çağrılır.
 */
import {
  HOUR,
  MINUTE,
  QUICK_SHARE_LIMITS,
  WidgetQuickShareRequestSchema,
  friendshipId,
  shareId,
  widgetTokenHash,
} from '@konum/core';
import { assertFails } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import { notifyWidgetRefresh, widgetQuickShare, widgetTokenIssue } from '../../functions/src/handlers/widget';
import type { PushMessage, PushSender } from '../../functions/src/push';
import {
  type TestUser,
  call,
  callError,
  cleanupRulesEnv,
  clientFirestore,
  newUser,
  opId,
  randomPhone,
  signInWithPhone,
} from '../helpers/emulator';
import { befriend, start } from '../review/helpers';

afterAll(async () => {
  await cleanupRulesEnv();
});

function fakeFcm() {
  const sent: { uid: string; msg: PushMessage }[] = [];
  const send: PushSender = async (uid, msg) => {
    sent.push({ uid, msg });
    return { sent: 1, removed: 0 };
  };
  return { sent, send };
}

const ctxOf = (u: TestUser, now = Date.now()): CallCtx => ({ uid: u.uid, phone_e164: null, now });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { details?: { code?: string } }) => e.details?.code ?? String(e));
const avatarUrl = (uid: string, v: number, thumb = false) =>
  `https://firebasestorage.googleapis.com/v0/b/demo-konum.firebasestorage.app/o/avatars%2F${uid}%2F${v}${thumb ? '_160' : ''}.jpg?alt=media&token=t`;
const userDoc = async (u: TestUser) => (await db().doc(`users/${u.uid}`).get()).data();
const memberProfile = async (a: TestUser, b: TestUser) =>
  ((await db().doc(`friendships/${friendshipId(a.uid, b.uid)}`).get()).data()?.member_profiles ?? {})[a.uid];
const qsIn = (token: string, to: string, src = 'ios_widget') => WidgetQuickShareRequestSchema.parse({ token, to_uid: to, op_id: opId(), source: src });

let A: TestUser; // Ayşe
let B: TestUser; // Bora
let C: TestUser; // Can
let X: TestUser; // yabancı

beforeAll(async () => {
  [A, B, C, X] = await Promise.all([newUser('Ayşe', 'female'), newUser('Bora', 'male'), newUser('Can', 'male'), newUser('Xenon', 'male')]);
  await Promise.all([befriend(A, B), befriend(A, C)]);
});

// ---------------------------------------------------------------------------
// Cinsiyet + avatar
// ---------------------------------------------------------------------------

describe('user_bootstrap: cinsiyet ve avatar (Faz 6)', () => {
  it('profil oluşturulurken cinsiyet zorunlu; null reddedilir; verilmezse korunur', async () => {
    const auth = await signInWithPhone(randomPhone());
    const e = await callError('user_bootstrap', { display_name: 'Deniz' }, auth);
    expect(e.status).toBe('INVALID_ARGUMENT');
    expect(e.details).toMatchObject({ code: 'gender_required' });
    expect((await callError('user_bootstrap', { display_name: 'Deniz', gender: 'other' }, auth)).status).toBe('INVALID_ARGUMENT');
    const r = await call('user_bootstrap', { display_name: 'Deniz', gender: 'male' }, auth);
    expect(r.user).toMatchObject({ gender: 'male', favorite_ids: [], avatar_thumb_url: null, avatar_version: null });
    expect((await call('user_bootstrap', {}, auth)).user.gender).toBe('male');
    expect((await callError('user_bootstrap', { gender: null }, auth)).status).toBe('INVALID_ARGUMENT');
  });

  it('eski hesap (gender yok) güncellemede cinsiyet seçer; cinsiyet ve küçük avatar arkadaş kopyasına yayılır', async () => {
    // Faz 6 öncesi hesabı taklit et: alan yok.
    const { gender: _drop, ...legacy } = (await userDoc(C)) ?? {};
    await db().doc(`users/${C.uid}`).set(legacy);
    expect((await call('user_bootstrap', {}, C)).user.gender).toBeNull();
    const v = Date.now();
    await call('user_bootstrap', { gender: 'female', avatar_url: avatarUrl(C.uid, v), avatar_thumb_url: avatarUrl(C.uid, v, true) }, C);
    expect(await userDoc(C)).toMatchObject({ gender: 'female', avatar_version: v, avatar_thumb_url: avatarUrl(C.uid, v, true) });
    expect(await memberProfile(C, A)).toEqual({
      display_name: 'Can',
      avatar_url: avatarUrl(C.uid, v),
      gender: 'female',
      avatar_thumb_url: avatarUrl(C.uid, v, true),
    });
    // Fotoğrafı kaldırma: üç alan birlikte null.
    await call('user_bootstrap', { avatar_url: null }, C);
    expect(await userDoc(C)).toMatchObject({ avatar_url: null, avatar_thumb_url: null, avatar_version: null });
    expect(await memberProfile(C, A)).toMatchObject({ avatar_url: null, avatar_thumb_url: null, gender: 'female' });
  });

  it('küçük avatar aynı sürümün _160 kardeşi olmalı; ana boy olmadan / yanlış adla reddedilir', async () => {
    const v = Date.now();
    const bad = [
      { avatar_url: avatarUrl(B.uid, v), avatar_thumb_url: avatarUrl(B.uid, v + 1, true) },
      { avatar_thumb_url: avatarUrl(B.uid, v, true) },
      { avatar_url: avatarUrl(B.uid, v, true) },
      { avatar_url: avatarUrl(B.uid, v), avatar_thumb_url: avatarUrl(A.uid, v, true) },
    ];
    for (const d of bad) {
      const e = await callError('user_bootstrap', d, B);
      expect(e.status).toBe('INVALID_ARGUMENT');
    }
    // Eski istemci yalnızca ana boyu gönderebilir: küçük boy null kalır.
    await call('user_bootstrap', { avatar_url: avatarUrl(B.uid, v) }, B);
    expect(await userDoc(B)).toMatchObject({ avatar_url: avatarUrl(B.uid, v), avatar_thumb_url: null, avatar_version: v });
  });

  it.skipIf(!process.env.FIREBASE_STORAGE_EMULATOR_HOST)('fotoğraf değişince önceki sürümün iki nesnesi Storage\'dan silinir', async () => {
    const { adminStorage } = await import('../../functions/src/admin');
    const bucket = adminStorage().bucket('demo-konum.firebasestorage.app');
    const v1 = Date.now() - 1000;
    const v2 = v1 + 1;
    const files = [`avatars/${A.uid}/${v1}.jpg`, `avatars/${A.uid}/${v1}_160.jpg`, `avatars/${A.uid}/${v2}.jpg`];
    await Promise.all(files.map((f) => bucket.file(f).save(Buffer.from([0xff, 0xd8, 0xff]), { contentType: 'image/jpeg' })));
    await call('user_bootstrap', { avatar_url: avatarUrl(A.uid, v1), avatar_thumb_url: avatarUrl(A.uid, v1, true) }, A);
    await call('user_bootstrap', { avatar_url: avatarUrl(A.uid, v2), avatar_thumb_url: avatarUrl(A.uid, v2, true) }, A);
    const exists = await Promise.all(files.map(async (f) => (await bucket.file(f).exists())[0]));
    expect(exists).toEqual([false, false, true]);
  });
});

// ---------------------------------------------------------------------------
// Favoriler
// ---------------------------------------------------------------------------

describe('favorites_set', () => {
  it('arkadaş olmayanlar sessizce düşer, sıra korunur; tekrar ve sınır aşımı reddedilir', async () => {
    const r = await call('favorites_set', { op_id: opId(), favorite_ids: [C.uid, X.uid, A.uid, B.uid] }, A);
    expect(r).toEqual({ favorite_ids: [C.uid, B.uid] });
    expect((await userDoc(A))?.favorite_ids).toEqual([C.uid, B.uid]);
    expect((await callError('favorites_set', { op_id: opId(), favorite_ids: [B.uid, B.uid] }, A)).status).toBe('INVALID_ARGUMENT');
    const five = [B.uid, C.uid, X.uid, 'u4', 'u5'];
    expect((await callError('favorites_set', { op_id: opId(), favorite_ids: five }, A)).status).toBe('INVALID_ARGUMENT');
  });

  it('arkadaşlık kaldırılınca iki taraftaki favori listesinden de çıkar', async () => {
    const [P, Q] = await Promise.all([newUser('Pelin'), newUser('Kaan', 'male')]);
    await befriend(P, Q);
    await call('favorites_set', { op_id: opId(), favorite_ids: [Q.uid] }, P);
    await call('favorites_set', { op_id: opId(), favorite_ids: [P.uid] }, Q);
    await call('friendship_remove', { op_id: opId(), friendship_id: friendshipId(P.uid, Q.uid) }, P);
    expect((await userDoc(P))?.favorite_ids).toEqual([]);
    expect((await userDoc(Q))?.favorite_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Widget token + tek tuşla paylaşım
// ---------------------------------------------------------------------------

describe('widget token ve widget_quick_share', () => {
  it('token: yalnızca özet saklanır, istemciye kapalı; oturumsuz çağrı favoriye 60 dk başlatır, op_id tekrarı aynı yanıt', async () => {
    const [S, R] = await Promise.all([newUser('Selin'), newUser('Rıza', 'male')]);
    await befriend(S, R);
    const issued = await call('widget_token_issue', { op_id: opId(), device_id: 'device-s-1' }, S);
    expect(issued).toMatchObject({ endpoint_path: 'widget_quick_share' });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const tok = await db().doc(`widget_tokens/${widgetTokenHash(issued.token)}`).get();
    expect(tok.data()).toMatchObject({ uid: S.uid, device_id: 'device-s-1', revoked: false });
    expect(JSON.stringify(tok.data())).not.toContain(issued.token);
    await assertFails((await clientFirestore(S.uid)).doc(`widget_tokens/${widgetTokenHash(issued.token)}`).get());

    // Favori değil → not_favorite (oturumsuz çağrı).
    const req = { token: issued.token, to_uid: R.uid, op_id: opId(), source: 'ios_widget' };
    expect((await callError('widget_quick_share', req, null)).details).toMatchObject({ code: 'not_favorite' });
    await call('favorites_set', { op_id: opId(), favorite_ids: [R.uid] }, S);
    const before = Date.now();
    const r = await call('widget_quick_share', { ...req, op_id: opId() }, null);
    expect(r).toMatchObject({ status: 'started', share_id: shareId(S.uid, R.uid), to_name: 'Rıza' });
    expect(r.expires_at).toBeGreaterThanOrEqual(before + 60 * MINUTE - 5_000);
    expect(r.expires_at).toBeLessThanOrEqual(Date.now() + 60 * MINUTE + 5_000);
    const share = (await db().doc(`location_shares/${r.share_id}`).get()).data();
    expect(share).toMatchObject({ status: 'active', share_mode: 'timed', sender_id: S.uid, receiver_id: R.uid, expires_at: r.expires_at });

    // İkinci basış bitişi max(mevcut, şimdi + 60 dk) yapar (geçen süre kadar uzar); aynı op_id → saklı yanıt, sayaç artmaz.
    const same = { ...req, op_id: opId() };
    const r1 = await call('widget_quick_share', same, null);
    const r2 = await call('widget_quick_share', same, null);
    expect(r2).toEqual(r1);
    expect(['extended', 'already_active']).toContain(r1.status);
    expect(r1.expires_at).toBeGreaterThanOrEqual(r.expires_at);
    expect((await db().doc(`widget_tokens/${widgetTokenHash(issued.token)}`).get()).data()?.uses?.count).toBe(2);

    // Bozuk token biçimi şemada, bilinmeyen token token_invalid.
    expect((await callError('widget_quick_share', { ...req, token: 'x' }, null)).status).toBe('INVALID_ARGUMENT');
    const unknown = { ...req, op_id: opId(), token: 'A'.repeat(43) };
    expect((await callError('widget_quick_share', unknown, null)).details).toMatchObject({ code: 'token_invalid' });

    // İptal → token_invalid; aynı cihaza yeniden üretim eskisini iptal eder.
    const again = await call('widget_token_issue', { op_id: opId(), device_id: 'device-s-1' }, S);
    expect((await callError('widget_quick_share', { ...req, op_id: opId() }, null)).details).toMatchObject({ code: 'token_invalid' });
    expect(await call('widget_token_revoke', { op_id: opId(), device_id: null }, S)).toEqual({ revoked: 1 });
    expect((await callError('widget_quick_share', { ...req, op_id: opId(), token: again.token }, null)).details).toMatchObject({
      code: 'token_invalid',
    });
  });

  it('mevcut kısa paylaşım 60 dk\'ya uzar; gönderene sessiz uyandırma + görünür onay; süresi dolan token reddedilir', async () => {
    const [S, R] = await Promise.all([newUser('Sena'), newUser('Remzi', 'male')]);
    await befriend(S, R);
    await call('favorites_set', { op_id: opId(), favorite_ids: [R.uid] }, S);
    const short = await start(S, [R], { kind: 'preset', preset: 'm15' });
    const { token } = await widgetTokenIssue(ctxOf(S), { op_id: opId(), device_id: 'device-sena' });
    const fcm = fakeFcm();
    const now = Date.now();
    const r = await widgetQuickShare(qsIn(token, R.uid, 'android_tile'), { send: fcm.send, now });
    expect(r).toMatchObject({ status: 'extended', share_id: shareId(S.uid, R.uid), expires_at: now + 60 * MINUTE, to_name: 'Remzi' });
    const doc = (await db().doc(`location_shares/${r.share_id}`).get()).data();
    expect(doc).toMatchObject({ status: 'active', session_id: short.session_id, expires_at: now + 60 * MINUTE, extended_count: 1 });
    expect(doc?.version).toBe((short.shares[0]?.version ?? 0) + 1);
    expect(fcm.sent.map((s) => [s.uid, s.msg.data.type])).toEqual([
      [S.uid, 'resume_tracking'],
      [S.uid, 'quick_share_started'],
    ]);
    const visible = fcm.sent[1]?.msg;
    expect(visible?.notification?.body).toBe('Remzi ile paylaşım 1 saate uzatıldı');
    expect(visible?.data).toMatchObject({ share_id: r.share_id, to_name: 'Remzi', expires_at: String(now + 60 * MINUTE) });
    expect(JSON.stringify(fcm.sent)).not.toMatch(/"lat"|"lng"/);
    // Aynı anda ikinci basış: bitiş zaten şimdi + 60 dk → already_active, sürüm değişmez.
    const again = await widgetQuickShare(qsIn(token, R.uid), { send: fcm.send, now });
    expect(again).toMatchObject({ status: 'already_active', expires_at: now + 60 * MINUTE });
    expect((await db().doc(`location_shares/${r.share_id}`).get()).data()?.version).toBe(doc?.version);

    await db().doc(`widget_tokens/${widgetTokenHash(token)}`).update({ expires_at: Date.now() - 1 });
    expect(await codeOf(widgetQuickShare(qsIn(token, R.uid), { send: fcm.send }))).toBe('token_expired');
  });

  it('token başına saatte 6 başarılı çağrı; arkadaş olmayan favori not_friend', async () => {
    const [S, R] = await Promise.all([newUser('Sibel'), newUser('Rüzgar', 'male')]);
    await befriend(S, R);
    await call('favorites_set', { op_id: opId(), favorite_ids: [R.uid] }, S);
    const { token } = await widgetTokenIssue(ctxOf(S), { op_id: opId(), device_id: 'device-sibel' });
    const fcm = fakeFcm();
    const now = Date.now();
    const statuses: string[] = [];
    for (let i = 0; i < QUICK_SHARE_LIMITS.perTokenPerHour; i++) {
      statuses.push((await widgetQuickShare(qsIn(token, R.uid), { send: fcm.send, now: now + i })).status);
    }
    expect(statuses[0]).toBe('started');
    // Aynı ms'de değil: her basış bitişi 1 ms ileri iter (max(mevcut, şimdi + 60 dk)).
    expect(new Set(statuses.slice(1))).toEqual(new Set(['extended']));
    const err = await widgetQuickShare(qsIn(token, R.uid), { send: fcm.send, now: now + 10 }).catch((e) => e);
    // Hız sınırında yazma yok: paylaşım bitişi son başarılı basıştaki gibi.
    expect(err.details).toMatchObject({ code: 'rate_limited' });
    expect(err.details.retry_after_ms).toBeGreaterThan(HOUR - 60_000);
    // Pencere geçince yeniden açılır (ilk paylaşımın süresi de dolmuş: yeni 60 dk).
    expect((await widgetQuickShare(qsIn(token, R.uid), { send: fcm.send, now: now + HOUR + 10 })).status).toBe('started');

    // Listede kalmış ama arkadaş olmayan kimlik (ör. yarış): not_friend.
    await db().doc(`users/${S.uid}`).update({ favorite_ids: [X.uid] });
    expect(await codeOf(widgetQuickShare(qsIn(token, X.uid), { send: fcm.send, now: now + HOUR + 11 }))).toBe('not_friend');
  });

  it('widget_refresh yalnızca paylaşanı favorilerinde tutan alıcıya gider', async () => {
    const fcm = fakeFcm();
    const s = (status: 'active' | 'ended', receiver: TestUser) => ({ sender_id: A.uid, receiver_id: receiver.uid, status, audience: 'friend' as const });
    await call('favorites_set', { op_id: opId(), favorite_ids: [A.uid] }, B);
    expect(await notifyWidgetRefresh(null, s('active', B), { send: fcm.send })).toBe(true);
    expect(await notifyWidgetRefresh(s('active', B), s('ended', B), { send: fcm.send })).toBe(true);
    // C, A'yı favorilerinde tutmuyor.
    expect(await notifyWidgetRefresh(null, s('active', C), { send: fcm.send })).toBe(false);
    expect(fcm.sent.map((x) => [x.uid, x.msg.data])).toEqual([
      [B.uid, { type: 'widget_refresh', from: A.uid }],
      [B.uid, { type: 'widget_refresh', from: A.uid }],
    ]);
  });

  it('hesap silme: widget token\'ları silinir, hesap başkalarının favorilerinden çıkar', async () => {
    const [S, R] = await Promise.all([newUser('Silinecek'), newUser('Kalan', 'male')]);
    await befriend(S, R);
    await call('favorites_set', { op_id: opId(), favorite_ids: [S.uid] }, R);
    const { token } = await call('widget_token_issue', { op_id: opId(), device_id: 'device-del' }, S);
    await call('account_delete', { op_id: opId(), confirm: true }, S);
    expect((await db().doc(`widget_tokens/${widgetTokenHash(token)}`).get()).exists).toBe(false);
    expect((await userDoc(R))?.favorite_ids).toEqual([]);
  });
});
