/**
 * Faz 3 `battery_low_notify`: oturum başına %15 altına inişte BİR KEZ bildirim, yeniden kurma (≥ %20 / şarj /
 * canlı paket kanıtı), 30 dk tak-çıkar koruması, günlük tavan, op_id tekrarı ve yetki. İşleyici test sürecinde sahte
 * FCM göndericisi ve enjekte edilen saatle doğrudan çağrılır; uçtan uca bölüm Functions emülatöründe dışa aktarımı,
 * şemayı ve kimlik zorunluluğunu doğrular.
 */
import { DAY, MINUTE, type OutgoingShareView, type ShareStartResponse } from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import { batteryLowNotify } from '../../functions/src/handlers/battery';
import type { PushMessage, PushSender } from '../../functions/src/push';
import { type TestUser, call, callError, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';
import { befriend, start } from '../review/helpers';

afterAll(async () => {
  await cleanupRulesEnv();
});

interface Sent {
  uid: string;
  msg: PushMessage;
}

function fakeFcm() {
  const sent: Sent[] = [];
  const send: PushSender = async (uid, msg) => {
    sent.push({ uid, msg });
    return { sent: 1, removed: 0 };
  };
  return { sent, send };
}

const ctxOf = (u: TestUser, now: number): CallCtx => ({ uid: u.uid, phone_e164: null, now });

let A: TestUser; // gönderen ("Ayşe")
let B: TestUser;
let C: TestUser;
let X: TestUser; // yabancı
let session: ShareStartResponse;

beforeAll(async () => {
  [A, B, C, X] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Xenon')]);
  await befriend(A, B);
  await befriend(A, C);
  session = await start(A, [B, C], { kind: 'weekly' });
  expect(session.shares).toHaveLength(2);
});

describe('battery_low_notify (işleyici)', () => {
  it('%15 altı: oturumun alıcılarına bir kez bildirim; metin ve veri koordinat taşımaz', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const r = await batteryLowNotify(ctxOf(A, t0), { op_id: opId(), session_id: session.session_id, battery_pct: 14 }, fcm);
    expect(r).toMatchObject({ status: 'notified', armed: false, receivers: 2 });
    expect(new Set(fcm.sent.map((s) => s.uid))).toEqual(new Set([B.uid, C.uid]));
    for (const { msg } of fcm.sent) {
      expect(msg.notification).toEqual({ title: "Ayşe'nin pili azaldı", body: 'Pil %14. Konum daha seyrek güncellenecek.' });
      expect(msg.data.type).toBe('battery_low');
      expect(Object.keys(msg.data).sort()).toEqual(['battery_pct', 'share_id', 'type']);
      expect(JSON.stringify(msg)).not.toMatch(/lat|lng|41\.|28\./);
    }
    const toB = fcm.sent.find((s) => s.uid === B.uid)?.msg.data as Record<string, string>;
    expect(toB.share_id).toBe((session.shares.find((s) => s.receiver_id === B.uid) as OutgoingShareView).share_id);

    // Aynı düşüşte tekrar (pil %13, %12): bildirim yok.
    const again = await batteryLowNotify(ctxOf(A, t0 + MINUTE), { op_id: opId(), session_id: session.session_id, battery_pct: 13 }, fcm);
    expect(again).toMatchObject({ status: 'suppressed', armed: false, receivers: 0 });
    // Ara değer (%17): durum değişmez.
    const mid = await batteryLowNotify(ctxOf(A, t0 + 2 * MINUTE), { op_id: opId(), session_id: session.session_id, battery_pct: 17 }, fcm);
    expect(mid).toMatchObject({ status: 'noop', armed: false });
    expect(fcm.sent).toHaveLength(2);

    // Yeniden kurma (≥ %20) ve 30 dk tak-çıkar koruması: 10 dk sonra yeni düşüş sessizce tüketilir.
    const re = await batteryLowNotify(ctxOf(A, t0 + 5 * MINUTE), { op_id: opId(), session_id: session.session_id, battery_pct: 22 }, fcm);
    expect(re).toMatchObject({ status: 'rearmed', armed: true });
    const early = await batteryLowNotify(ctxOf(A, t0 + 10 * MINUTE), { op_id: opId(), session_id: session.session_id, battery_pct: 15 }, fcm);
    expect(early).toMatchObject({ status: 'suppressed', armed: false });
    expect(fcm.sent).toHaveLength(2);

    // Şarja takıldı → kuruldu; 40 dk sonra yeni düşüş → yeniden bildirim.
    const ch = await batteryLowNotify(ctxOf(A, t0 + 20 * MINUTE), { op_id: opId(), session_id: session.session_id, battery_pct: 16, is_charging: true }, fcm);
    expect(ch).toMatchObject({ status: 'rearmed', armed: true });
    const second = await batteryLowNotify(ctxOf(A, t0 + 40 * MINUTE), { op_id: opId(), session_id: session.session_id, battery_pct: 12 }, fcm);
    expect(second).toMatchObject({ status: 'notified', receivers: 2 });
    expect(fcm.sent).toHaveLength(4);
    expect(fcm.sent[3]?.msg.notification?.body).toBe('Pil %12. Konum daha seyrek güncellenecek.');

    const state = (await db().doc(`battery_alerts/${A.uid}_${session.session_id}`).get()).data();
    expect(state).toMatchObject({ uid: A.uid, session_id: session.session_id, armed: false, fired: 2, fired_at: t0 + 40 * MINUTE, last_pct: 12 });
    expect(state?.recent_fired_at).toEqual([t0, t0 + 40 * MINUTE]);
  });

  it('op_id tekrarı saklanan yanıtı döndürür ve bildirimi yeniden göndermez', async () => {
    const [S, R] = await Promise.all([newUser('Ümit'), newUser('Rana')]);
    await befriend(S, R);
    const s = await start(S, [R], { kind: 'indefinite' });
    const fcm = fakeFcm();
    const op = opId();
    const now = Date.now();
    const first = await batteryLowNotify(ctxOf(S, now), { op_id: op, session_id: s.session_id, battery_pct: 9 }, fcm);
    const replay = await batteryLowNotify(ctxOf(S, now + 1_000), { op_id: op, session_id: s.session_id, battery_pct: 9 }, fcm);
    expect(first).toMatchObject({ status: 'notified', receivers: 1 });
    expect(replay).toEqual(first);
    expect(fcm.sent).toHaveLength(1);
    expect(fcm.sent[0]?.msg.notification?.title).toBe("Ümit'in pili azaldı");
    // Aynı op_id başka istekle: hata.
    await expect(batteryLowNotify(ctxOf(S, now + 2_000), { op_id: op, session_id: s.session_id, battery_pct: 8 }, fcm)).rejects.toMatchObject({
      details: { code: 'invalid_argument' },
    });
  });

  it('yedek yeniden kurma: bildirimden sonra yayınlanan şarjlı / yüksek pilli canlı paket durumu kurar', async () => {
    const [S, R] = await Promise.all([newUser('Can'), newUser('Rüya')]);
    await befriend(S, R);
    const s = await start(S, [R], { kind: 'weekly' });
    const share = s.shares[0] as OutgoingShareView;
    const fcm = fakeFcm();
    const t0 = Date.now();
    expect((await batteryLowNotify(ctxOf(S, t0), { op_id: opId(), session_id: s.session_id, battery_pct: 14 }, fcm)).status).toBe('notified');
    // İstemci yeniden kurma çağrısını kaçırdı; ama 20 dk sonra %85 + şarj gösteren paket yayınlandı.
    await rtdb()
      .ref(`live_locations/${R.uid}/${share.share_id}`)
      .set({ battery_pct: 85, is_charging: true, server_ts: t0 + 20 * MINUTE });
    const r = await batteryLowNotify(ctxOf(S, t0 + 45 * MINUTE), { op_id: opId(), session_id: s.session_id, battery_pct: 15 }, fcm);
    expect(r).toMatchObject({ status: 'notified' });
    expect(fcm.sent).toHaveLength(2);
    expect(fcm.sent[1]?.msg.notification?.title).toBe("Can'ın pili azaldı");
  });

  it('günlük tavan: 24 saatte oturum başına en çok 6 bildirim', async () => {
    const [S, R] = await Promise.all([newUser('Bora'), newUser('Rıza')]);
    await befriend(S, R);
    const s = await start(S, [R], { kind: 'indefinite' });
    const fcm = fakeFcm();
    const t0 = Date.now();
    let notified = 0;
    for (let i = 0; i < 8; i++) {
      const at = t0 + i * 2 * 31 * MINUTE;
      await batteryLowNotify(ctxOf(S, at), { op_id: opId(), session_id: s.session_id, battery_pct: 25 }, fcm);
      const r = await batteryLowNotify(ctxOf(S, at + 31 * MINUTE), { op_id: opId(), session_id: s.session_id, battery_pct: 14 }, fcm);
      if (r.status === 'notified') notified++;
    }
    expect(notified).toBe(6);
    expect(fcm.sent).toHaveLength(6);
    // Bir gün sonra yeniden açılır.
    await batteryLowNotify(ctxOf(S, t0 + 2 * DAY), { op_id: opId(), session_id: s.session_id, battery_pct: 30 }, fcm);
    const later = await batteryLowNotify(ctxOf(S, t0 + 2 * DAY + MINUTE), { op_id: opId(), session_id: s.session_id, battery_pct: 14 }, fcm);
    expect(later.status).toBe('notified');
  });

  it('yalnızca oturumun gönderenine açık; bitmiş / bilinmeyen oturum share_not_active', async () => {
    const fcm = fakeFcm();
    const now = Date.now();
    const code = async (u: TestUser, sessionId: string) => {
      try {
        await batteryLowNotify(ctxOf(u, now), { op_id: opId(), session_id: sessionId, battery_pct: 10 }, fcm);
        return 'ok';
      } catch (err) {
        return (err as { details?: { code?: string } }).details?.code;
      }
    };
    expect(await code(B, session.session_id)).toBe('share_not_active'); // alıcı, gönderenin oturumu adına çağıramaz
    expect(await code(X, session.session_id)).toBe('share_not_active');
    expect(await code(A, 'bilinmeyen-oturum')).toBe('share_not_active');

    const [S, R] = await Promise.all([newUser('Deniz'), newUser('Rasim')]);
    await befriend(S, R);
    const s = await start(S, [R], { kind: 'preset', preset: 'h1' });
    await call('share_stop', { op_id: opId(), session_id: s.session_id }, S);
    expect(await code(S, s.session_id)).toBe('share_not_active');
    expect(fcm.sent).toHaveLength(0);
  });
});

describe('battery_low_notify (uçtan uca, Functions emülatörü)', () => {
  // core CALLABLES'ta henüz yok (needs_from_others); test yardımcısı tip olarak CallableName ister.
  const NAME = 'battery_low_notify' as Parameters<typeof call>[0];

  it('kimlik zorunlu; şema doğrulanır; gönderen çağırınca bildirildi döner (emülatörde push yalnızca kayıt)', async () => {
    const [S, R] = await Promise.all([newUser('Ece'), newUser('Rıfat')]);
    await befriend(S, R);
    const s = await start(S, [R], { kind: 'weekly' });
    const unauth = await callError(NAME, { op_id: opId(), session_id: s.session_id, battery_pct: 14 }, null);
    expect(unauth.status).toBe('UNAUTHENTICATED');
    const bad = await callError(NAME, { op_id: opId(), session_id: s.session_id, battery_pct: 150 }, S);
    expect(bad.status).toBe('INVALID_ARGUMENT');
    const badId = await callError(NAME, { op_id: opId(), session_id: '../x', battery_pct: 14 }, S);
    expect(badId.status).toBe('INVALID_ARGUMENT');
    const notOwner = await callError(NAME, { op_id: opId(), session_id: s.session_id, battery_pct: 14 }, R);
    expect(notOwner.details?.code).toBe('share_not_active');
    const ok = await call(NAME, { op_id: opId(), session_id: s.session_id, battery_pct: 14 }, S);
    expect(ok).toMatchObject({ status: 'notified', armed: false, receivers: 1 });
    const dup = await call(NAME, { op_id: opId(), session_id: s.session_id, battery_pct: 13 }, S);
    expect(dup).toMatchObject({ status: 'suppressed' });
  });
});
