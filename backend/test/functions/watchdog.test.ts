/**
 * Faz 3 duraksama bekçisi (`sweepStalls`): uzun paylaşımlarda (haftalık, süresiz, > 8 sa) son paket
 * `max(4·hb, 45 dk)`'dan eskiyse göndericiye sessiz `resume_tracking`, ikinci kaçırmada görünür bildirim;
 * hız sınırı ve `stall_nudges` kaydı; yeni paketle dönem kapanır; 24 saatten eski iz noktaları budanır.
 * Bekçi test sürecinde sahte FCM ve enjekte edilen saatle doğrudan çağrılır. Bekçi emülatördeki TÜM aktif uzun
 * paylaşımlara bakar: doğrulamalar yalnızca bu testin göndericilerine süzülür.
 */
import { DAY, HOUR, MINUTE, type OutgoingShareView } from '@konum/core';
import { afterAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import { decideNudge, stallThresholdMs, sweepStalls } from '../../functions/src/handlers/watchdog';
import type { PushMessage, PushSender } from '../../functions/src/push';
import { type TestUser, call, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';
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
  return { sent, send, to: (u: TestUser) => sent.filter((s) => s.uid === u.uid).map((s) => s.msg) };
}

const shareDoc = async (id: string) => (await db().doc(`location_shares/${id}`).get()).data();

describe('saf karar (decideNudge)', () => {
  it('eşik max(4·hb, 45 dk); hb yoksa / sınır dışıysa 10 dk varsayılır', () => {
    expect(stallThresholdMs(undefined)).toBe(45 * MINUTE);
    expect(stallThresholdMs(2 * MINUTE)).toBe(45 * MINUTE);
    expect(stallThresholdMs(30 * MINUTE)).toBe(2 * HOUR);
    expect(stallThresholdMs(60 * MINUTE)).toBe(4 * HOUR);
    expect(stallThresholdMs(5)).toBe(45 * MINUTE);
  });

  it('merdiven: sessiz → (≥30 dk) görünür → 6 sa arayla → dönem başına en çok 4', () => {
    const seen = 1_000_000;
    let now = seen + 46 * MINUTE;
    const d1 = decideNudge(seen, undefined, null, now);
    expect(d1).toMatchObject({ stalled: true, level: 1, next: { count: 1, visible: 0 } });
    expect(decideNudge(seen, undefined, d1.next, now + 10 * MINUTE).level).toBe(0);
    now += 30 * MINUTE;
    const d2 = decideNudge(seen, undefined, d1.next, now);
    expect(d2).toMatchObject({ level: 2, next: { count: 2, visible: 1 } });
    expect(decideNudge(seen, undefined, d2.next, now + 5 * HOUR).level).toBe(0);
    const d3 = decideNudge(seen, undefined, d2.next, now + 6 * HOUR);
    const d4 = decideNudge(seen, undefined, d3.next, now + 12 * HOUR);
    expect(d4).toMatchObject({ level: 2, next: { count: 4, visible: 3 } });
    expect(decideNudge(seen, undefined, d4.next, now + 30 * HOUR).level).toBe(0);
    // Yeni paket: dönem kapanır; sonraki duraksama sayacı sıfırdan başlatır.
    const rec = decideNudge(now + 31 * HOUR, undefined, d4.next, now + 31 * HOUR + MINUTE);
    expect(rec).toMatchObject({ stalled: false, recovered: true, level: 0 });
    const again = decideNudge(now + 31 * HOUR, undefined, rec.next, now + 32 * HOUR);
    expect(again).toMatchObject({ level: 1, next: { count: 1 } });
  });
});

describe('sweepStalls (emülatör)', () => {
  it('haftalık paylaşım: sessiz uyandırma → görünür bildirim → hız sınırı → yeni paketle kapanış → hb eşiği', async () => {
    const [A, B, C] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can')]);
    await befriend(A, B);
    await befriend(A, C);
    const weekly = (await start(A, [B], { kind: 'weekly' })).shares[0] as OutgoingShareView;
    const short = (await start(A, [C], { kind: 'preset', preset: 'h1' })).shares[0] as OutgoingShareView;
    const T0 = weekly.started_at;
    const fcm = fakeFcm();

    // 30 dk: henüz duraksama yok. Kısa (1 sa süreli) paylaşım hiç denetlenmez.
    let r = await sweepStalls({ now: T0 + 30 * MINUTE, send: fcm.send });
    expect(r.stalled).not.toContain(weekly.share_id);
    expect(fcm.to(A)).toHaveLength(0);

    // Eski ve yeni iz noktaları (budama aynı turda).
    const sweepAt = T0 + 50 * MINUTE;
    const key = (ts: number) => `${String(ts).padStart(13, '0')}-001`;
    const trail = `live_trail/${B.uid}/${weekly.share_id}`;
    await rtdb()
      .ref(trail)
      .set({ [key(sweepAt - 25 * HOUR)]: { v: 1 }, [key(sweepAt - HOUR)]: { v: 1 } });

    // 50 dk paket yok (> 45 dk): sessiz, yalnızca veri `resume_tracking`.
    r = await sweepStalls({ now: sweepAt, send: fcm.send });
    expect(r.stalled).toContain(weekly.share_id);
    expect(r.stalled).not.toContain(short.share_id);
    expect(r.nudged).toContain(weekly.share_id);
    expect(r.silent_senders).toContain(A.uid);
    expect(r.visible_senders).not.toContain(A.uid);
    let msgs = fcm.to(A);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.notification).toBeUndefined();
    expect(msgs[0]?.data).toEqual({ type: 'resume_tracking', session_ids: weekly.session_id, level: '1' });
    expect(msgs[0]?.android?.priority).toBe('high');
    expect(msgs[0]?.apns?.headers?.['apns-push-type']).toBe('background');
    expect(msgs[0]?.apns?.payload?.aps?.contentAvailable).toBe(true);
    expect((await shareDoc(weekly.share_id))?.stall_nudges).toMatchObject({ count: 1, visible: 0, last_seen_ts: T0, first_at: sweepAt });
    expect(Object.keys((await rtdb().ref(trail).once('value')).val() ?? {})).toEqual([key(sweepAt - HOUR)]);
    expect(r.pruned_trail_points).toBeGreaterThanOrEqual(1);
    // Sürüm ve durum değişmez (yalnızca kayıt alanı).
    expect(await shareDoc(weekly.share_id)).toMatchObject({ status: 'active', version: weekly.version });

    // 20 dk sonra: görünür bildirim için erken (≥ 30 dk).
    r = await sweepStalls({ now: T0 + 70 * MINUTE, send: fcm.send });
    expect(fcm.to(A)).toHaveLength(1);

    // İkinci kaçırma (≥ 30 dk): sessiz + görünür.
    r = await sweepStalls({ now: T0 + 81 * MINUTE, send: fcm.send });
    expect(r.visible_senders).toContain(A.uid);
    msgs = fcm.to(A);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]?.data).toMatchObject({ type: 'resume_tracking', level: '2' });
    expect(msgs[2]?.notification?.body).toBe('Konum paylaşımın duraksadı. Devam etmek için dokun.');
    expect(msgs[2]?.data).toEqual({ type: 'tracking_stalled', session_ids: weekly.session_id });
    for (const m of msgs) expect(JSON.stringify(m)).not.toMatch(/"lat"|"lng"/);
    expect((await shareDoc(weekly.share_id))?.stall_nudges).toMatchObject({ count: 2, visible: 1 });

    // Hız sınırı: 6 saat dolmadan tekrar yok.
    await sweepStalls({ now: T0 + 3 * HOUR, send: fcm.send });
    expect(fcm.to(A)).toHaveLength(3);

    // Gönderen yeniden yayınladı (hb 30 dk): dönem kapanır, push yok.
    const fresh = T0 + 4 * HOUR;
    await rtdb().ref(`live_locations/${B.uid}/${weekly.share_id}`).set({ server_ts: fresh, hb: 30 * MINUTE });
    r = await sweepStalls({ now: fresh + 10 * MINUTE, send: fcm.send });
    expect(r.recovered).toContain(weekly.share_id);
    expect(r.stalled).not.toContain(weekly.share_id);
    expect((await shareDoc(weekly.share_id))?.stall_nudges).toMatchObject({ recovered_at: fresh + 10 * MINUTE });
    expect(fcm.to(A)).toHaveLength(3);

    // hb = 30 dk → eşik 2 sa: 100 dk sessizlik duraksama değildir; 125 dk yeni dönem başlatır (sessiz).
    r = await sweepStalls({ now: fresh + 100 * MINUTE, send: fcm.send });
    expect(r.stalled).not.toContain(weekly.share_id);
    r = await sweepStalls({ now: fresh + 125 * MINUTE, send: fcm.send });
    expect(r.stalled).toContain(weekly.share_id);
    expect(fcm.to(A)).toHaveLength(4);
    expect(fcm.to(A)[3]?.data).toMatchObject({ type: 'resume_tracking', level: '1' });
    expect((await shareDoc(weekly.share_id))?.stall_nudges).toMatchObject({ count: 1, visible: 0, last_seen_ts: fresh, recovered_at: null });

    // Durdurulan paylaşım artık denetlenmez.
    await call('share_stop', { op_id: opId(), session_id: weekly.session_id }, A);
    r = await sweepStalls({ now: fresh + 10 * HOUR, send: fcm.send });
    expect(r.stalled).not.toContain(weekly.share_id);
    expect(fcm.to(A)).toHaveLength(4);
  });

  it('8 saatten uzun süren süreli paylaşım da kapsanır; aynı gönderenin birden çok alıcısı tek push alır', async () => {
    const [S, R1, R2] = await Promise.all([newUser('Selin'), newUser('Rüzgar'), newUser('Ravza')]);
    await befriend(S, R1);
    await befriend(S, R2);
    const res = await start(S, [R1, R2], { kind: 'preset', preset: 'h1' });
    const [s1, s2] = res.shares as [OutgoingShareView, OutgoingShareView];
    // Benzetim: paylaşım 12 saate uzatılmış (belge doğrudan; bekçi yalnızca Firestore + canlı düğüme bakar).
    for (const s of [s1, s2]) await db().doc(`location_shares/${s.share_id}`).update({ expires_at: s.started_at + 12 * HOUR });
    const fcm = fakeFcm();
    // 7 sa: süreli ve 8 saatten kısa → kapsam dışı.
    let r = await sweepStalls({ now: s1.started_at + 7 * HOUR, send: fcm.send });
    expect(r.stalled).not.toContain(s1.share_id);
    // 9 sa: uzun paylaşım, paket yok → duraksama; iki alıcı, tek push.
    r = await sweepStalls({ now: s1.started_at + 9 * HOUR, send: fcm.send });
    expect(r.stalled).toEqual(expect.arrayContaining([s1.share_id, s2.share_id]));
    expect(fcm.to(S)).toHaveLength(1);
    expect(fcm.to(S)[0]?.data).toMatchObject({ type: 'resume_tracking', session_ids: res.session_id });
    // Süre dolduysa kapsam dışı.
    r = await sweepStalls({ now: s1.started_at + 13 * HOUR, send: fcm.send });
    expect(r.stalled).not.toContain(s1.share_id);
    expect(fcm.to(S)).toHaveLength(1);
  });

  it('push hatası bekçiyi durdurmaz; kayıt önce yazıldığı için tekrar yağmuru olmaz', async () => {
    const [S, R] = await Promise.all([newUser('Sena'), newUser('Rana')]);
    await befriend(S, R);
    const s = (await start(S, [R], { kind: 'indefinite' })).shares[0] as OutgoingShareView;
    let calls = 0;
    const failing: PushSender = async (uid) => {
      if (uid === S.uid) calls++;
      throw new Error('fcm kapalı');
    };
    const r = await sweepStalls({ now: s.started_at + DAY, send: failing });
    expect(r.nudged).toContain(s.share_id);
    expect(r.silent_senders).not.toContain(S.uid);
    await sweepStalls({ now: s.started_at + DAY + 5 * MINUTE, send: failing });
    expect(calls).toBe(1);
  });
});
