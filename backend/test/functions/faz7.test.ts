/**
 * Faz 7: Etkinlik Alanı (3 aşamalı oylama, hatırlatıcılar, bildirim kutusu), gizlilik tercihleri (pil paylaşımı RTDB
 * aynası) ve "yola çıktı" bildirimi. İşleyiciler sahte FCM ile doğrudan çağrılır; birkaç çağrı Functions emülatörü
 * üzerinden (dışa aktarım, şema, onay kapısı ve hata eşlemesi).
 */
import {
  EVENT_LIMITS,
  EventAdvanceRequestSchema,
  EventCreateRequestSchema,
  EventInviteAddRequestSchema,
  EventRsvpRequestSchema,
  EventTimeOptionsSetRequestSchema,
  EventVenueProposeRequestSchema,
  EventVoteRequestSchema,
  HOUR,
  MINUTE,
  addDaysToDate,
  localDateOf,
  localDateTimeToEpoch,
  offsetFnForTimeZone,
} from '@konum/core';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import {
  eventAdvance,
  eventCancel,
  eventCreate,
  eventInviteAdd,
  eventRsvp,
  eventTimeOptionsSet,
  eventVenuePropose,
  eventVote,
  sweepEvents,
} from '../../functions/src/handlers/events';
import { movementReport } from '../../functions/src/handlers/privacy';
import { batteryLowNotify } from '../../functions/src/handlers/battery';
import type { PushMessage, PushSender } from '../../functions/src/push';
import { type TestUser, call, callError, cleanupRulesEnv, clientFirestore, newUser, opId, waitFor } from '../helpers/emulator';
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
  return { sent, send, clear: () => sent.splice(0, sent.length) };
}

const TZ = 'Europe/Istanbul';
const offsetAt = offsetFnForTimeZone(TZ);
const ctxOf = (u: TestUser, now = Date.now()): CallCtx => ({ uid: u.uid, phone_e164: null, now });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { details?: { code?: string } }) => e.details?.code ?? String(e));
const date3 = () => addDaysToDate(localDateOf(Date.now(), offsetAt), 3);

let O: TestUser; // Erim (düzenleyen)
let A: TestUser; // Ayşe
let B: TestUser; // Bora
let C: TestUser; // Can: arkadaş, izin YOK
let X: TestUser; // yabancı

beforeAll(async () => {
  [O, A, B, C, X] = await Promise.all([newUser('Erim'), newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Xenon')]);
  await Promise.all([befriend(O, A), befriend(O, B), befriend(O, C, { grants: 'none' })]);
});

const venues = [{ name: 'Moda Kahve', address: 'Moda Cd. 1' }, { name: 'Kadıköy Fırın' }];

describe('event_create: davet yalnızca meetup_invite izni verenlere', () => {
  it('izinsiz / yabancı sessizce düşer, sayısı döner; davetlilere push + bildirim kutusu', async () => {
    const fcm = fakeFcm();
    const now = Date.now();
    const r = await eventCreate(
      ctxOf(O, now),
      EventCreateRequestSchema.parse({ op_id: opId(), title: 'Kahvaltı', date: date3(), time_zone: TZ, invitee_ids: [A.uid, B.uid, C.uid, X.uid], venue_options: venues }),
      fcm,
    );
    expect(r.event.invitee_ids).toEqual([A.uid, B.uid]);
    expect(r.skipped_count).toBe(2);
    expect(r.event.names).toMatchObject({ [O.uid]: 'Erim', [A.uid]: 'Ayşe', [B.uid]: 'Bora' });
    expect(new Set(fcm.sent.map((s) => s.uid))).toEqual(new Set([A.uid, B.uid]));
    expect(fcm.sent[0]?.msg.data).toEqual({ type: 'event_invite', event_id: r.event.event_id, from: O.uid });
    expect(fcm.sent[0]?.msg.notification?.body).toContain('Erim seni “Kahvaltı” etkinliğine davet etti');
    expect(fcm.sent[0]?.msg.android?.notification?.channelId).toBe('events');
    const stored = (await db().doc(`events/${r.event.event_id}`).get()).data();
    expect(stored).toMatchObject({ open: true, stage: 'rsvp', member_ids: [O.uid, A.uid, B.uid] });
    const notices = await db().collection(`users/${A.uid}/notices`).where('event_id', '==', r.event.event_id).get();
    expect(notices.docs.map((d) => d.get('type'))).toEqual(['event_invite']);

    // Hiç izinli yoksa: arkadaş var → not_permitted, yoksa not_friends
    expect(await codeOf(eventCreate(ctxOf(O), EventCreateRequestSchema.parse({ op_id: opId(), title: 'X', date: date3(), time_zone: TZ, invitee_ids: [C.uid] })))).toBe('not_permitted');
    expect(await codeOf(eventCreate(ctxOf(O), EventCreateRequestSchema.parse({ op_id: opId(), title: 'X', date: date3(), time_zone: TZ, invitee_ids: [X.uid] })))).toBe('not_friends');
  });

  it('callable: geçersiz tarih event_date_invalid; 301 karakterlik not reddedilir; kuralda yalnızca üyeler okur', async () => {
    const past = addDaysToDate(localDateOf(Date.now(), offsetAt), -1);
    const e = await callError('event_create', { op_id: opId(), title: 'Eski', date: past, time_zone: TZ, invitee_ids: [A.uid] }, O);
    expect(e.details?.code).toBe('event_date_invalid');
    const ok = await call('event_create', { op_id: opId(), title: 'Sinema', date: date3(), time_zone: TZ, invitee_ids: [A.uid] }, O);
    const id = ok.event.event_id as string;
    const long = await callError('event_rsvp', { op_id: opId(), event_id: id, round: 'initial', status: 'not_going', note: 'a'.repeat(301) }, A);
    expect(long.details?.code).toBe('event_note_too_long');
    const stranger = await callError('event_rsvp', { op_id: opId(), event_id: id, round: 'initial', status: 'going' }, X);
    expect(stranger.details?.code).toBe('event_not_found');

    await assertSucceeds((await clientFirestore(A.uid)).doc(`events/${id}`).get());
    await assertFails((await clientFirestore(X.uid)).doc(`events/${id}`).get());
    await assertFails((await clientFirestore(A.uid)).doc(`events/${id}`).set({ title: 'hack' }));
    await assertSucceeds((await clientFirestore(A.uid)).collection(`users/${A.uid}/notices`).get());
    await assertFails((await clientFirestore(X.uid)).collection(`users/${A.uid}/notices`).get());
    await assertFails((await clientFirestore(O.uid)).doc(`event_reminders/${id}_morning`).get());
    // iptal (callable, sahip): davetliye event_cancelled
    const c = await call('event_cancel', { op_id: opId(), event_id: id }, O);
    expect(c.event.stage).toBe('cancelled');
  });
});

describe('3 aşama: tarih/katılım → mekan → saat → son onay → hatırlatıcılar', () => {
  it('tam akış', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const date = date3();
    const created = await eventCreate(
      ctxOf(O, t0),
      EventCreateRequestSchema.parse({ op_id: opId(), title: 'Piknik', date, time_zone: TZ, invitee_ids: [A.uid, B.uid], venue_options: venues }),
      fcm,
    );
    const id = created.event.event_id;
    fcm.clear();

    // Aşama 1: A katılacak, B katılamayacak (not kartta görünür) → sahibe push
    await eventRsvp(ctxOf(A, t0 + 1), EventRsvpRequestSchema.parse({ op_id: opId(), event_id: id, round: 'initial', status: 'going' }), fcm);
    const rb = await eventRsvp(ctxOf(B, t0 + 2), EventRsvpRequestSchema.parse({ op_id: opId(), event_id: id, round: 'initial', status: 'not_going', note: 'O gün şehir dışındayım' }), fcm);
    expect(rb.event.rsvp[B.uid]).toMatchObject({ status: 'not_going', note: 'O gün şehir dışındayım' });
    expect(fcm.sent.map((s) => s.uid)).toEqual([O.uid, O.uid]);
    expect(fcm.sent[1]?.msg.notification?.body).toBe('Bora katılamayacak: “O gün şehir dışındayım”');
    fcm.clear();

    // Aşama 2: A 3. mekanı önerir, sahip oylamayı açar; B oy veremez
    await eventVenuePropose(ctxOf(A, t0 + 3), EventVenueProposeRequestSchema.parse({ op_id: opId(), event_id: id, venue: { name: 'Fenerbahçe Parkı' } }), fcm);
    expect(await codeOf(eventAdvance(ctxOf(A, t0 + 4), EventAdvanceRequestSchema.parse({ op_id: opId(), event_id: id, action: 'open_venue_vote' }), fcm))).toBe('event_not_owner');
    const opened = await eventAdvance(ctxOf(O, t0 + 4), EventAdvanceRequestSchema.parse({ op_id: opId(), event_id: id, action: 'open_venue_vote' }), fcm);
    expect(opened.event.stage).toBe('venue_vote');
    expect(fcm.sent.map((s) => s.uid)).toEqual([A.uid]); // B "katılamayacağım" dedi: rahatsız edilmez
    expect(await codeOf(eventVote(ctxOf(B, t0 + 5), EventVoteRequestSchema.parse({ op_id: opId(), event_id: id, kind: 'venue', option_id: 'v3' }), fcm))).toBe('event_not_eligible');
    fcm.clear();
    await eventVote(ctxOf(O, t0 + 5), EventVoteRequestSchema.parse({ op_id: opId(), event_id: id, kind: 'venue', option_id: 'v3' }), fcm);
    const v2 = await eventVote(ctxOf(A, t0 + 6), EventVoteRequestSchema.parse({ op_id: opId(), event_id: id, kind: 'venue', option_id: 'v3' }), fcm);
    // Herkes oy verdi → mekan kesin; saat seçeneği yok → sahibe "saat ekle"
    expect(v2.event).toMatchObject({ stage: 'time_vote', venue_option_id: 'v3', stage_deadline_at: null });
    expect(fcm.sent.map((s) => [s.uid, s.msg.data])).toEqual([[O.uid, { type: 'event_stage', event_id: id, notice: 'need_times' }]]);
    fcm.clear();

    // Aşama 3: saatler → oylama → final
    const ts = await eventTimeOptionsSet(ctxOf(O, t0 + 7), EventTimeOptionsSetRequestSchema.parse({ op_id: opId(), event_id: id, minutes: [600, 840] }), fcm);
    const [t10, t14] = ts.event.time_options.map((t) => t.option_id);
    await eventVote(ctxOf(A, t0 + 8), EventVoteRequestSchema.parse({ op_id: opId(), event_id: id, kind: 'time', option_id: t10! }), fcm);
    const fin = await eventVote(ctxOf(O, t0 + 9), EventVoteRequestSchema.parse({ op_id: opId(), event_id: id, kind: 'time', option_id: t10! }), fcm);
    expect(t14).toBeDefined();
    const startsAt = localDateTimeToEpoch(date, 600, offsetAt);
    expect(fin.event).toMatchObject({ stage: 'final', time_option_id: t10, starts_at: startsAt });
    // Son onay bildirimi TÜM davetlilere (B dahil)
    const finals = fcm.sent.filter((s) => s.msg.data.type === 'event_stage' && (s.msg.data as { notice: string }).notice === 'final');
    expect(new Set(finals.map((s) => s.uid))).toEqual(new Set([A.uid, B.uid]));
    const rems = await db().collection('event_reminders').where('event_id', '==', id).get();
    const plan = Object.fromEntries(rems.docs.map((d) => [d.get('kind'), d.get('due_at')]));
    expect(plan).toEqual({ day_before: startsAt - 24 * HOUR, morning: localDateTimeToEpoch(date, 480, offsetAt) });

    // B son onayda katılacak
    await eventRsvp(ctxOf(B, t0 + 10), EventRsvpRequestSchema.parse({ op_id: opId(), event_id: id, round: 'final', status: 'going' }), fcm);
    fcm.clear();

    // Süpürücü: 1 gün önce hatırlatması bir kez gider (sahip + katılanlar), tekrarı yok
    const s1 = await sweepEvents(plan.day_before + 1_000, fcm);
    expect(s1.reminders_sent).toContain(`${id}_day_before`);
    const remPushes = fcm.sent.filter((s) => s.msg.data.type === 'event_reminder');
    expect(new Set(remPushes.map((s) => s.uid))).toEqual(new Set([O.uid, A.uid, B.uid]));
    expect(remPushes[0]?.msg.notification?.title).toBe('Yarın: Piknik');
    expect(remPushes[0]?.msg.android?.notification?.channelId).toBe('event_reminders');
    fcm.clear();
    const s2 = await sweepEvents(plan.day_before + 2_000, fcm);
    expect(s2.reminders_sent).not.toContain(`${id}_day_before`);
    expect(fcm.sent.filter((s) => s.msg.data.type === 'event_reminder' && (s.msg.data as { event_id: string }).event_id === id)).toHaveLength(0);

    // Sabah 08:00 hatırlatması
    const s3 = await sweepEvents(plan.morning + 1_000, fcm);
    expect(s3.reminders_sent).toContain(`${id}_morning`);
    expect(fcm.sent.find((s) => s.uid === A.uid && s.msg.data.type === 'event_reminder')?.msg.notification?.title).toBe('Bugün: Piknik');

    // Başlangıç + 3 sa → completed
    const s4 = await sweepEvents(startsAt + 3 * HOUR + 1_000, fcm);
    expect(s4.ticked).toContain(id);
    expect((await db().doc(`events/${id}`).get()).data()).toMatchObject({ stage: 'completed', open: false });
  }, 60_000);

  it('oylama süresi dolunca süpürücü kapatır; iptal hatırlatıcıları siler; davet ekleme izin süzgecinden geçer', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const created = await eventCreate(
      ctxOf(O, t0),
      EventCreateRequestSchema.parse({ op_id: opId(), title: 'Yürüyüş', date: date3(), time_zone: TZ, invitee_ids: [A.uid], venue_options: [...venues, { name: 'Sahil' }], vote_window_ms: 2 * HOUR }),
      fcm,
    );
    const id = created.event.event_id;
    await eventRsvp(ctxOf(A, t0 + 1), EventRsvpRequestSchema.parse({ op_id: opId(), event_id: id, round: 'initial', status: 'going' }), fcm);
    const inv = await eventInviteAdd(ctxOf(O, t0 + 2), EventInviteAddRequestSchema.parse({ op_id: opId(), event_id: id, invitee_ids: [B.uid, C.uid] }), fcm);
    expect(inv.event.invitee_ids).toEqual([A.uid, B.uid]);
    expect(inv.skipped_count).toBe(1);
    await eventAdvance(ctxOf(O, t0 + 3), EventAdvanceRequestSchema.parse({ op_id: opId(), event_id: id, action: 'open_venue_vote' }), fcm);
    await eventVote(ctxOf(A, t0 + 4), EventVoteRequestSchema.parse({ op_id: opId(), event_id: id, kind: 'venue', option_id: 'v2' }), fcm);
    // B yanıtsız: otomatik kapanmaz; süre dolunca en çok oyu alan kazanır
    const sw = await sweepEvents(t0 + 3 + 2 * HOUR + MINUTE, fcm);
    expect(sw.ticked).toContain(id);
    expect((await db().doc(`events/${id}`).get()).data()).toMatchObject({ stage: 'time_vote', venue_option_id: 'v2' });
    const c = await eventCancel(ctxOf(O, t0 + 5), { op_id: opId(), event_id: id }, fcm);
    expect(c.event.stage).toBe('cancelled');
    expect(fcm.sent.filter((s) => s.msg.data.type === 'event_cancelled').map((s) => s.uid).sort()).toEqual([A.uid, B.uid].sort());
    expect((await db().collection('event_reminders').where('event_id', '==', id).get()).size).toBe(0);
    expect(EVENT_LIMITS.maxInvitees).toBe(20);
  });

  it('arkadaşlık bitince davetli etkinlikten çıkar (callable sonrası)', async () => {
    const [P, Q] = await Promise.all([newUser('Pelin'), newUser('Kaan')]);
    await befriend(P, Q);
    const ev = await call('event_create', { op_id: opId(), title: 'Konser', date: date3(), time_zone: TZ, invitee_ids: [Q.uid] }, P);
    const id = ev.event.event_id as string;
    const fid = (await db().collection('friendships').where('member_ids', 'array-contains', P.uid).get()).docs[0]!.id;
    await call('friendship_remove', { op_id: opId(), friendship_id: fid }, P);
    const after = await waitFor(async () => {
      const d = (await db().doc(`events/${id}`).get()).data();
      return d && !(d.member_ids as string[]).includes(Q.uid) ? d : null;
    });
    expect(after.invitee_ids).toEqual([]);
  }, 30_000);
});

describe('Faz 7 gizlilik: pil paylaşımı ve "yola çıktı"', () => {
  it('privacy_settings_set: Firestore + RTDB aynası; kapalıyken düşük pil bildirimi bastırılır', async () => {
    const [S, R] = await Promise.all([newUser('Selin', 'female', { batteryShare: false }), newUser('Rıza')]);
    await befriend(S, R);
    expect((await db().doc(`users/${S.uid}`).get()).get('privacy')).toBeUndefined();
    const session = await start(S, [R]);
    const fcm = fakeFcm();
    const r = await batteryLowNotify(ctxOf(S), { op_id: opId(), session_id: session.session_id, battery_pct: 10 }, fcm);
    expect(r).toMatchObject({ status: 'suppressed', receivers: 0 });
    expect(fcm.sent).toHaveLength(0);

    const on = await call('privacy_settings_set', { op_id: opId(), battery_share: true }, S);
    expect(on.privacy).toMatchObject({ battery_share: true, movement_alerts: true });
    expect((await rtdb().ref(`privacy/${S.uid}/battery_share`).once('value')).val()).toBe(true);
    const r2 = await batteryLowNotify(ctxOf(S), { op_id: opId(), session_id: session.session_id, battery_pct: 10 }, fcm);
    expect(r2.status).toBe('notified');

    const off = await call('privacy_settings_set', { op_id: opId(), battery_share: false }, S);
    expect(off.privacy.battery_share).toBe(false);
    expect((await rtdb().ref(`privacy/${S.uid}/battery_share`).once('value')).val()).toBe(false);
    // Hiç ayar verilmezse şema reddeder
    expect((await callError('privacy_settings_set', { op_id: opId() }, S)).details?.code).toBe('invalid_argument');
  }, 30_000);

  it('movement_report: etkin paylaşımın alıcılarına heads-up, soğuma, alıcı tercihi', async () => {
    const [M, R1, R2] = await Promise.all([newUser('Mehmet', 'male'), newUser('Rana'), newUser('Rüya')]);
    await Promise.all([befriend(M, R1), befriend(M, R2)]);
    const fcm = fakeFcm();
    const now = Date.now();
    expect((await movementReport(ctxOf(M, now), { op_id: opId(), kind: 'departed', at: now }, fcm)).status).toBe('no_recipients');
    await start(M, [R1, R2]);
    await call('privacy_settings_set', { op_id: opId(), movement_alerts: false }, R2);
    const r = await movementReport(ctxOf(M, now + 1), { op_id: opId(), kind: 'departed', at: now }, fcm);
    expect(r).toMatchObject({ status: 'sent', notified_count: 1 });
    expect(fcm.sent.map((s) => s.uid)).toEqual([R1.uid]);
    expect(fcm.sent[0]?.msg.notification).toEqual({ title: 'Mehmet yola çıktı', body: 'Canlı konumunu haritada görebilirsin' });
    expect(fcm.sent[0]?.msg.android?.notification?.channelId).toBe('movement');
    expect(JSON.stringify(fcm.sent[0]?.msg)).not.toMatch(/"lat"|"lng"/);
    expect((await movementReport(ctxOf(M, now + 2), { op_id: opId(), kind: 'departed', at: now + 2 }, fcm)).status).toBe('cooldown');
    expect((await movementReport(ctxOf(M, now + 31 * MINUTE), { op_id: opId(), kind: 'departed', at: now }, fcm)).status).toBe('stale');
  }, 30_000);
});
