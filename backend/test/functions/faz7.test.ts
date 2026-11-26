/**
 * Faz 7: Etkinlik Alanı (tek seferde oylama, sonuçların düzenleyene toplu bildirimi, hatırlatıcılar, bildirim kutusu),
 * gizlilik tercihleri (pil paylaşımı RTDB aynası) ve "yola çıktı" bildirimi. İşleyiciler sahte FCM ile doğrudan
 * çağrılır; birkaç çağrı Functions emülatörü üzerinden (dışa aktarım, şema, onay kapısı ve hata eşlemesi).
 */
import {
  EVENT_LIMITS,
  EventCreateRequestSchema,
  EventFinalizeRequestSchema,
  EventInviteAddRequestSchema,
  EventOptionsSetRequestSchema,
  EventRespondRequestSchema,
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
  eventCancel,
  eventCreate,
  eventFinalize,
  eventInviteAdd,
  eventOptionsSet,
  eventRespond,
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
const detailsOf = (p: Promise<unknown>) => p.then(() => null, (e: { details?: Record<string, unknown> }) => e.details ?? null);
const date3 = () => addDaysToDate(localDateOf(Date.now(), offsetAt), 3);
const stageOf = (s: { msg: PushMessage }) => (s.msg.data as { notice?: string }).notice;

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
/** Oluşturma isteği: 2 mekan + 10:00 / 14:00 varsayılan. */
const createReq = (over: Record<string, unknown>) =>
  EventCreateRequestSchema.parse({ op_id: opId(), title: 'Kahvaltı', date: date3(), time_zone: TZ, venue_options: venues, time_minutes: [600, 840], ...over });
const respondReq = (event_id: string, over: Record<string, unknown>) => EventRespondRequestSchema.parse({ op_id: opId(), event_id, ...over });

describe('event_create: davet yalnızca meetup_invite izni verenlere', () => {
  it('izinsiz / yabancı sessizce düşer, sayısı döner; davetlilere push + bildirim kutusu', async () => {
    const fcm = fakeFcm();
    const now = Date.now();
    const r = await eventCreate(ctxOf(O, now), createReq({ invitee_ids: [A.uid, B.uid, C.uid, X.uid] }), fcm);
    expect(r.event.invitee_ids).toEqual([A.uid, B.uid]);
    expect(r.skipped_count).toBe(2);
    expect(r.event.names).toMatchObject({ [O.uid]: 'Erim', [A.uid]: 'Ayşe', [B.uid]: 'Bora' });
    expect(r.event.venue_options.map((v) => v.option_id)).toEqual(['v1', 'v2']);
    expect(r.event.time_options.map((t) => t.minute_of_day)).toEqual([600, 840]);
    expect(new Set(fcm.sent.map((s) => s.uid))).toEqual(new Set([A.uid, B.uid]));
    expect(fcm.sent[0]?.msg.data).toEqual({ type: 'event_invite', event_id: r.event.event_id, from: O.uid });
    expect(fcm.sent[0]?.msg.notification?.body).toContain('Erim seni “Kahvaltı” etkinliğine davet etti');
    expect(fcm.sent[0]?.msg.notification?.body).toContain('Katılımını, mekanı ve saati işaretle');
    expect(fcm.sent[0]?.msg.android?.notification?.channelId).toBe('events');
    const stored = (await db().doc(`events/${r.event.event_id}`).get()).data();
    expect(stored).toMatchObject({ open: true, stage: 'voting', member_ids: [O.uid, A.uid, B.uid], answers: {}, results_at: null });
    expect(stored?.next_action_at).toBe(r.event.respond_by);
    const notices = await db().collection(`users/${A.uid}/notices`).where('event_id', '==', r.event.event_id).get();
    expect(notices.docs.map((d) => d.get('type'))).toEqual(['event_invite']);

    // Hiç izinli yoksa: arkadaş var → not_permitted, yoksa not_friends
    expect(await codeOf(eventCreate(ctxOf(O), createReq({ title: 'X', invitee_ids: [C.uid] })))).toBe('not_permitted');
    expect(await codeOf(eventCreate(ctxOf(O), createReq({ title: 'X', invitee_ids: [X.uid] })))).toBe('not_friends');
  });

  it('callable: mekan ve saat zorunlu, geçersiz tarih; 301 karakterlik not reddedilir; kuralda yalnızca üyeler okur', async () => {
    const base = { op_id: opId(), title: 'Sinema', date: date3(), time_zone: TZ, invitee_ids: [A.uid] };
    expect((await callError('event_create', { ...base, time_minutes: [1200] }, O)).details?.code).toBe('invalid_argument');
    expect((await callError('event_create', { ...base, op_id: opId(), venue_options: venues }, O)).details?.code).toBe('invalid_argument');
    const past = addDaysToDate(localDateOf(Date.now(), offsetAt), -1);
    const e = await callError('event_create', { ...base, op_id: opId(), date: past, venue_options: venues, time_minutes: [1200] }, O);
    expect(e.details?.code).toBe('event_date_invalid');
    const ok = await call('event_create', { ...base, op_id: opId(), venue_options: venues, time_minutes: [1200] }, O);
    const id = ok.event.event_id as string;
    const long = await callError('event_respond', { op_id: opId(), event_id: id, status: 'not_going', note: 'a'.repeat(301) }, A);
    expect(long.details?.code).toBe('event_note_too_long');
    // İki mekan varken mekan seçmeden "Katılacağım" olmaz (saat tek: otomatik)
    const noVenue = await callError('event_respond', { op_id: opId(), event_id: id, status: 'going' }, A);
    expect(noVenue.details).toMatchObject({ code: 'event_options_invalid', reason: 'venue_required' });
    const stranger = await callError('event_respond', { op_id: opId(), event_id: id, status: 'going', venue_option_id: 'v1' }, X);
    expect(stranger.details?.code).toBe('event_not_found');
    const mine = await call('event_respond', { op_id: opId(), event_id: id, status: 'going', venue_option_id: 'v2' }, A);
    expect(mine.event.answers[A.uid]).toMatchObject({ status: 'going', venue_option_id: 'v2', time_option_id: ok.event.time_options[0].option_id });
    // Tek davetli yanıtladı → sonuç bildirimi (sahibin kutusunda)
    expect(mine.event).toMatchObject({ results_reason: 'all_answered' });
    const ownerNotices = await db().collection(`users/${O.uid}/notices`).where('event_id', '==', id).get();
    expect(ownerNotices.docs.map((d) => [d.get('type'), d.get('title')])).toEqual([['event_stage', 'Sonuçlar hazır: Sinema']]);

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

describe('tek seferde yanıt → sonuçlar düzenleyene → onay → hatırlatıcılar', () => {
  it('tam akış', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const date = date3();
    const created = await eventCreate(
      ctxOf(O, t0),
      createReq({ title: 'Piknik', date, invitee_ids: [A.uid, B.uid], venue_options: [...venues, { name: 'Fenerbahçe Parkı' }] }),
      fcm,
    );
    const id = created.event.event_id;
    const [t10, t14] = created.event.time_options.map((t) => t.option_id);
    fcm.clear();

    // A tek seferde: katılacak + mekan + saat. Sonuç bildirimi henüz yok, sahibe tek tek push GİTMEZ.
    const ra = await eventRespond(ctxOf(A, t0 + 1), respondReq(id, { status: 'going', venue_option_id: 'v1', time_option_id: t10 }), fcm);
    expect(ra.event.answers[A.uid]).toMatchObject({ status: 'going', venue_option_id: 'v1', time_option_id: t10, note: null });
    expect(fcm.sent).toHaveLength(0);
    expect(await codeOf(eventRespond(ctxOf(O, t0 + 1), respondReq(id, { status: 'going', venue_option_id: 'v1', time_option_id: t10 }), fcm))).toBe('invalid_argument');

    // B (son davetli) katılamayacak + not → sahibe TEK "Sonuçlar hazır"
    const rb = await eventRespond(ctxOf(B, t0 + 2), respondReq(id, { status: 'not_going', note: 'O gün şehir dışındayım', venue_option_id: 'v2' }), fcm);
    expect(rb.event.answers[B.uid]).toMatchObject({ status: 'not_going', note: 'O gün şehir dışındayım', venue_option_id: null, time_option_id: null });
    expect(rb.event).toMatchObject({ stage: 'voting', results_reason: 'all_answered', results_at: t0 + 2 });
    expect(fcm.sent.map((s) => [s.uid, s.msg.data])).toEqual([[O.uid, { type: 'event_stage', event_id: id, notice: 'results' }]]);
    expect(fcm.sent[0]?.msg.notification).toEqual({ title: 'Sonuçlar hazır: Piknik', body: '2 katılacak · 1 katılamayacak · Mekan: Moda Kahve (1 oy) · Saat: 10:00 (1 oy)' });
    fcm.clear();

    // Sonuçlardan SONRA yanıt değişikliği sahibe tek tek bildirilir
    await eventRespond(ctxOf(B, t0 + 3), respondReq(id, { status: 'going', venue_option_id: 'v2', time_option_id: t14 }), fcm);
    expect(fcm.sent.map((s) => [s.uid, s.msg.data])).toEqual([[O.uid, { type: 'event_rsvp', event_id: id, by: B.uid, status: 'going' }]]);
    expect(fcm.sent[0]?.msg.notification?.body).toBe('Bora katılacak · Kadıköy Fırın · 14:00');
    fcm.clear();

    // Onay: yalnızca sahip; eşitlikte kazananı seçmeden olmaz
    expect(await codeOf(eventFinalize(ctxOf(A, t0 + 4), EventFinalizeRequestSchema.parse({ op_id: opId(), event_id: id }), fcm))).toBe('event_not_owner');
    const tie = await detailsOf(eventFinalize(ctxOf(O, t0 + 4), EventFinalizeRequestSchema.parse({ op_id: opId(), event_id: id }), fcm));
    expect(tie).toMatchObject({ code: 'event_vote_tie', venue_leaders: ['v1', 'v2'], time_leaders: [t10, t14] });
    expect(await codeOf(eventFinalize(ctxOf(O, t0 + 4), EventFinalizeRequestSchema.parse({ op_id: opId(), event_id: id, venue_option_id: 'v3', time_option_id: t10 }), fcm))).toBe(
      'event_options_invalid',
    );
    const fin = await eventFinalize(ctxOf(O, t0 + 5), EventFinalizeRequestSchema.parse({ op_id: opId(), event_id: id, venue_option_id: 'v1', time_option_id: t10 }), fcm);
    const startsAt = localDateTimeToEpoch(date, 600, offsetAt);
    expect(fin.event).toMatchObject({ stage: 'final', venue_option_id: 'v1', time_option_id: t10, starts_at: startsAt, respond_by: null });
    // Kesinleşme bildirimi TÜM davetlilere
    const finals = fcm.sent.filter((s) => s.msg.data.type === 'event_stage' && stageOf(s) === 'final');
    expect(new Set(finals.map((s) => s.uid))).toEqual(new Set([A.uid, B.uid]));
    expect(finals[0]?.msg.notification?.title).toBe('Kesinleşti: Piknik');
    const rems = await db().collection('event_reminders').where('event_id', '==', id).get();
    const plan = Object.fromEntries(rems.docs.map((d) => [d.get('kind'), d.get('due_at')]));
    expect(plan).toEqual({ day_before: startsAt - 24 * HOUR, morning: localDateTimeToEpoch(date, 480, offsetAt) });
    fcm.clear();

    // final: B katılımını değiştirir (oylar donar) → sahibe event_rsvp
    const late = await eventRespond(ctxOf(B, t0 + 6), respondReq(id, { status: 'not_going', note: 'İşim çıktı' }), fcm);
    expect(late.event.answers[B.uid]).toMatchObject({ status: 'not_going', note: 'İşim çıktı', venue_option_id: 'v2', time_option_id: t14 });
    expect(fcm.sent.map((s) => [s.uid, s.msg.notification?.body])).toEqual([[O.uid, 'Bora katılamayacak: “İşim çıktı”']]);
    fcm.clear();

    // Süpürücü: 1 gün önce hatırlatması bir kez gider (sahip + katılanlar; B artık katılmıyor), tekrarı yok
    const s1 = await sweepEvents(plan.day_before + 1_000, fcm);
    expect(s1.reminders_sent).toContain(`${id}_day_before`);
    const remPushes = fcm.sent.filter((s) => s.msg.data.type === 'event_reminder');
    expect(new Set(remPushes.map((s) => s.uid))).toEqual(new Set([O.uid, A.uid]));
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

  it('yanıt süresi dolunca süpürücü sonuçları gönderir; seçenek değişince etkilenen bilgilendirilir; iptal; gün sonu expired', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const created = await eventCreate(ctxOf(O, t0), createReq({ title: 'Yürüyüş', invitee_ids: [A.uid], vote_window_ms: 2 * HOUR }), fcm);
    const id = created.event.event_id;
    const [t10] = created.event.time_options.map((t) => t.option_id);
    expect(created.event.respond_by).toBe(t0 + 2 * HOUR);
    const inv = await eventInviteAdd(ctxOf(O, t0 + 1), EventInviteAddRequestSchema.parse({ op_id: opId(), event_id: id, invitee_ids: [B.uid, C.uid] }), fcm);
    expect(inv.event.invitee_ids).toEqual([A.uid, B.uid]);
    expect(inv.skipped_count).toBe(1);
    await eventRespond(ctxOf(A, t0 + 2), respondReq(id, { status: 'going', venue_option_id: 'v1', time_option_id: t10 }), fcm);
    fcm.clear();

    // B yanıtsız: sonuç bildirimi süre dolunca gider ("1 yanıt vermedi")
    const sw = await sweepEvents(t0 + 2 * HOUR + MINUTE, fcm);
    expect(sw.ticked).toContain(id);
    expect((await db().doc(`events/${id}`).get()).data()).toMatchObject({ stage: 'voting', results_reason: 'deadline' });
    const res = fcm.sent.filter((s) => s.msg.data.type === 'event_stage' && (s.msg.data as { event_id: string }).event_id === id);
    expect(res.map((s) => [s.uid, stageOf(s)])).toEqual([[O.uid, 'results']]);
    expect(res[0]?.msg.notification?.body).toBe('2 katılacak · 1 yanıt vermedi · Mekan: Moda Kahve (1 oy) · Saat: 10:00 (1 oy)');
    fcm.clear();

    // Seçenekler değişti: Moda Kahve kaldırıldı → A'nın mekan seçimi sıfırlanır, A'ya haber
    const os = await eventOptionsSet(
      ctxOf(O, t0 + 3),
      EventOptionsSetRequestSchema.parse({ op_id: opId(), event_id: id, venues: [{ name: 'Kadıköy Fırın' }, { name: 'Sahil' }], minutes: [600, 840] }),
      fcm,
    );
    expect(os.event.venue_options.map((v) => [v.option_id, v.name])).toEqual([
      ['v2', 'Kadıköy Fırın'],
      ['v5', 'Sahil'],
    ]);
    expect(os.event.answers[A.uid]).toMatchObject({ venue_option_id: null, time_option_id: t10 });
    expect(fcm.sent.map((s) => [s.uid, stageOf(s)])).toEqual([[A.uid, 'options_changed']]);
    fcm.clear();

    const c = await eventCancel(ctxOf(O, t0 + 4), { op_id: opId(), event_id: id }, fcm);
    expect(c.event.stage).toBe('cancelled');
    expect(fcm.sent.filter((s) => s.msg.data.type === 'event_cancelled').map((s) => s.uid).sort()).toEqual([A.uid, B.uid].sort());
    expect((await db().collection('event_reminders').where('event_id', '==', id).get()).size).toBe(0);

    // Kimse onaylamazsa son saat seçeneği geçince (en geç gün sonunda) expired
    const other = await eventCreate(ctxOf(O, t0), createReq({ title: 'Sinema', invitee_ids: [A.uid], time_minutes: [1380] }), fcm);
    const startsAt = other.event.time_options[0]!.starts_at;
    const sw2 = await sweepEvents(startsAt - 1, fcm);
    expect(sw2.ticked).toContain(other.event.event_id); // yanıt süresi doldu → sonuç bildirimi
    expect((await db().doc(`events/${other.event.event_id}`).get()).data()).toMatchObject({ stage: 'voting', results_reason: 'deadline' });
    const sw3 = await sweepEvents(startsAt + 1, fcm);
    expect(sw3.ticked).toContain(other.event.event_id);
    expect((await db().doc(`events/${other.event.event_id}`).get()).data()).toMatchObject({ stage: 'expired', open: false });
    expect(EVENT_LIMITS.maxInvitees).toBe(20);
  });

  it('arkadaşlık bitince davetli etkinlikten çıkar (callable sonrası)', async () => {
    const [P, Q] = await Promise.all([newUser('Pelin'), newUser('Kaan')]);
    await befriend(P, Q);
    const ev = await call('event_create', { op_id: opId(), title: 'Konser', date: date3(), time_zone: TZ, invitee_ids: [Q.uid], venue_options: venues, time_minutes: [1200] }, P);
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
