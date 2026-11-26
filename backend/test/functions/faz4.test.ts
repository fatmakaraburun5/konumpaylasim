/**
 * Faz 4: ping ("Buradayım / Yoldayım"), yer notları ve tam konumlu SOS. İşleyiciler test sürecinde sahte FCM
 * göndericisiyle doğrudan çağrılır (bildirim içeriği görülsün); birkaç çağrı Functions emülatörü üzerinden gider
 * (dışa aktarım, şema ve hata eşlemesi).
 */
import {
  MINUTE,
  PING_LIMITS,
  SOS_LIMITS,
  SOS_MESSAGE,
  SosSendRequestSchema,
  SosUpdateRequestSchema,
  friendshipId,
  parsePing,
  sosMapsUrl,
} from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import { placeNoteDelete, placeNoteUpsert } from '../../functions/src/handlers/notes';
import { pingSend } from '../../functions/src/handlers/ping';
import { emergencyContactsSet, sosAck, sosResolve, sosSend, sosUpdate } from '../../functions/src/handlers/sos';
import { sweepExpired } from '../../functions/src/handlers/sweeper';
import type { PushMessage, PushSender } from '../../functions/src/push';
import { type TestUser, call, callError, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';
import { befriend } from '../review/helpers';

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
const here = (now: number) => ({ lat: 41.008238, lng: 28.978359, accuracy: 9, timestamp: now - 5_000 });
/** Doğrudan işleyici çağrısında zod varsayılanları (callable sarmalayıcısı da aynı şemayı uygular). */
const sendIn = (x: unknown) => SosSendRequestSchema.parse(x);
const updIn = (x: unknown) => SosUpdateRequestSchema.parse(x);
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { details?: { code?: string } }) => e.details?.code ?? String(e));

let A: TestUser; // Ayşe
let B: TestUser; // Bora
let C: TestUser; // Can
let X: TestUser; // yabancı

beforeAll(async () => {
  [A, B, C, X] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Xenon')]);
  await befriend(A, B);
  await befriend(A, C);
});

describe('ping_send', () => {
  it('mutlu yol: alıcı kutusuna kayıt + koordinatsız push; aynı çifte soğuma; eski konum atılır', async () => {
    const fcm = fakeFcm();
    const now = Date.now();
    const r = await pingSend(ctxOf(A, now), { op_id: opId(), to: B.uid, kind: 'here', location: here(now), eta_s: 300 }, fcm);
    expect(r.expires_at).toBe(now + PING_LIMITS.ttlMs);
    const rec = parsePing((await rtdb().ref(`ping_inbox/${B.uid}/${r.ping_id}`).once('value')).val(), r.ping_id);
    expect(rec).toMatchObject({ from: A.uid, kind: 'here', sent_at: now, eta_s: null, location: { lat: 41.008238, accuracy: 9 } });
    expect(fcm.sent).toHaveLength(1);
    expect(fcm.sent[0]?.uid).toBe(B.uid);
    expect(fcm.sent[0]?.msg.data).toEqual({ type: 'ping', ping_id: r.ping_id, from: A.uid, kind: 'here' });
    expect(fcm.sent[0]?.msg.notification).toEqual({ title: 'Ayşe', body: '📍 Buradayım' });
    expect(JSON.stringify(fcm.sent[0]?.msg)).not.toMatch(/41\.00|28\.97|"lat"/);

    // Aynı çifte 20 sn içinde ikinci ping: rate_limited.
    expect(await codeOf(pingSend(ctxOf(A, now + 1_000), { op_id: opId(), to: B.uid, kind: 'on_way', location: null, eta_s: null }, fcm))).toBe('rate_limited');

    // Başka alıcıya, 10 dk eski konumla "Yoldayım": konum atılır, ETA kalır.
    const old = { ...here(now), timestamp: now - 10 * MINUTE };
    const r2 = await pingSend(ctxOf(A, now), { op_id: opId(), to: C.uid, kind: 'on_way', location: old, eta_s: 720 }, fcm);
    const rec2 = parsePing((await rtdb().ref(`ping_inbox/${C.uid}/${r2.ping_id}`).once('value')).val(), r2.ping_id);
    expect(rec2).toMatchObject({ kind: 'on_way', location: null, eta_s: 720 });
    expect(fcm.sent[1]?.msg.notification?.body).toContain('Yoldayım · yaklaşık');

    // Süpürücü süresi geçen pingi siler.
    const sw = await sweepExpired({ now: now + PING_LIMITS.ttlMs + 1, audit: false });
    expect(sw.purged_pings).toBeGreaterThanOrEqual(2);
    expect((await rtdb().ref(`ping_inbox/${B.uid}/${r.ping_id}`).once('value')).exists()).toBe(false);
  });

  it('arkadaş değil / kendisi: not_friends (callable üzerinden)', async () => {
    const e = await callError('ping_send', { op_id: opId(), to: X.uid, kind: 'here' }, A);
    expect(e.details?.code).toBe('not_friends');
    expect((await callError('ping_send', { op_id: opId(), to: A.uid, kind: 'here' }, A)).details?.code).toBe('not_friends');
    // Callable mutlu yol (dışa aktarım + şema varsayılanları).
    const ok = await call('ping_send', { op_id: opId(), to: A.uid, kind: 'on_way', eta_s: 60 }, C);
    expect(typeof ok.ping_id).toBe('string');
  });
});

describe('place_note_upsert / place_note_delete', () => {
  it('oluştur → düzenle (created_at korunur) → başkası düzenleyemez/silemez → sil → tekrar silme idempotent', async () => {
    const now = Date.now();
    const created = await placeNoteUpsert(ctxOf(A, now), {
      op_id: opId(),
      note_id: null,
      emoji: '🅿️',
      text: '  Park   yeri burası ',
      position: { lat: 41, lng: 29, accuracy: 6 },
      visible_to: [B.uid, X.uid, A.uid, B.uid],
      duration_ms: 4 * 60 * MINUTE,
    });
    const n = created.note;
    expect(n).toMatchObject({ owner_id: A.uid, emoji: '🅿️', text: 'Park yeri burası', visible_to: [B.uid], created_at: now, expires_at: now + 4 * 60 * MINUTE });
    const stored = (await db().doc(`place_notes/${n.note_id}`).get()).data();
    expect(stored?.purge_at).toBeDefined();

    const edited = await placeNoteUpsert(ctxOf(A, now + 1_000), {
      op_id: opId(),
      note_id: n.note_id,
      emoji: null,
      text: 'Anahtar burada',
      position: { lat: 41, lng: 29, accuracy: null },
      visible_to: [],
      duration_ms: 30 * MINUTE,
    });
    expect(edited.note).toMatchObject({ note_id: n.note_id, created_at: now, updated_at: now + 1_000, text: 'Anahtar burada', visible_to: [], expires_at: now + 1_000 + 30 * MINUTE });

    const foreign = { op_id: opId(), note_id: n.note_id, emoji: null, text: 'x', position: { lat: 1, lng: 1, accuracy: null }, visible_to: [], duration_ms: 30 * MINUTE };
    expect(await codeOf(placeNoteUpsert(ctxOf(B), foreign))).toBe('note_not_found');
    expect(await codeOf(placeNoteDelete(ctxOf(B), { op_id: opId(), note_id: n.note_id }))).toBe('note_not_found');
    expect(await codeOf(placeNoteUpsert(ctxOf(A), { ...foreign, op_id: opId(), note_id: null, text: '   ' }))).toBe('invalid_argument');

    expect(await placeNoteDelete(ctxOf(A), { op_id: opId(), note_id: n.note_id })).toMatchObject({ deleted: true });
    const again = await call('place_note_delete', { op_id: opId(), note_id: n.note_id }, A);
    expect(again).toMatchObject({ note_id: n.note_id, deleted: false });
  });
});

describe('SOS', () => {
  it('acil kişi yokken no_emergency_contacts; kişi listesi yalnızca arkadaşları tutar', async () => {
    const loc = here(Date.now());
    const e = await callError('sos_send', { op_id: opId(), location: loc }, A);
    expect(e.status).toBe('FAILED_PRECONDITION');
    expect(e.details?.code).toBe('no_emergency_contacts');
    const r = await call('emergency_contacts_set', { op_id: opId(), contact_ids: [C.uid, X.uid, A.uid, B.uid, C.uid] }, A);
    expect(r.contact_ids).toEqual([C.uid, B.uid]);
    expect((await db().doc(`users/${A.uid}`).get()).get('emergency_contacts')).toEqual([C.uid, B.uid]);
  });

  it('gönder → tekrar gönder (aynı sos_id) → gördüm → güncelle → güvendeyim', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    await emergencyContactsSet(ctxOf(A, t0), { op_id: opId(), contact_ids: [B.uid, C.uid] });
    const address = async () => 'Sultanahmet, Fatih/İstanbul';
    const sent = await sosSend(
      ctxOf(A, t0),
      { op_id: opId(), location: here(t0), battery_pct: 23, is_charging: false, route: { destination_label: 'Ev', eta_s: 900, distance_m: 4200 }, address: null },
      { send: fcm.send, address },
    );
    const s = sent.sos;
    expect(sent.recipients).toBe(2);
    expect(s).toMatchObject({
      sender_id: A.uid,
      sender_name: 'Ayşe',
      recipient_ids: [B.uid, C.uid],
      status: 'active',
      message: SOS_MESSAGE,
      location: { lat: 41.008238, lng: 28.978359, accuracy: 9 },
      address: 'Sultanahmet, Fatih/İstanbul',
      maps_url: sosMapsUrl(41.008238, 28.978359),
      battery_pct: 23,
      route: { destination_label: 'Ev', eta_s: 900, distance_m: 4200 },
      acks: {},
      update_count: 0,
    });
    expect(new Set(fcm.sent.map((x) => x.uid))).toEqual(new Set([B.uid, C.uid]));
    const push = fcm.sent[0]?.msg as PushMessage;
    expect(push.data).toEqual({ type: 'sos', sos_id: s.sos_id, sender_id: A.uid });
    expect(push.notification?.title).toBe('ACİL: Ayşe tehlikede');
    expect(push.android).toMatchObject({ priority: 'high', notification: { channelId: 'sos_alarm', visibility: 'public', sound: 'sos_alarm' } });
    expect(push.apns?.payload?.aps).toMatchObject({ 'interruption-level': 'time-sensitive', sound: 'sos_alarm.wav' });

    // Aktifken tekrar gönderim: yeni belge açılmaz, aynı sos_id tazelenir ve yeniden push edilir.
    const again = await sosSend(ctxOf(A, t0 + 2_000), sendIn({ op_id: opId(), location: { ...here(t0 + 2_000), lat: 41.01 }, address: 'Eminönü' }), fcm);
    expect(again.sos).toMatchObject({ sos_id: s.sos_id, update_count: 1, address: 'Eminönü', location: { lat: 41.01 } });
    expect(fcm.sent).toHaveLength(4);

    // Gördüm: yalnızca alıcı; ilk onayda gönderene push, tekrar onayda yok.
    const ack = await sosAck(ctxOf(B, t0 + 3_000), { op_id: opId(), sos_id: s.sos_id }, fcm);
    expect(ack.sos.acks).toEqual({ [B.uid]: t0 + 3_000 });
    expect(fcm.sent[4]).toMatchObject({ uid: A.uid, msg: { data: { type: 'sos_ack', sos_id: s.sos_id, by: B.uid }, notification: { title: 'Bora uyarını gördü' } } });
    await sosAck(ctxOf(B, t0 + 4_000), { op_id: opId(), sos_id: s.sos_id }, fcm);
    expect(fcm.sent).toHaveLength(5);
    expect(await codeOf(sosAck(ctxOf(X), { op_id: opId(), sos_id: s.sos_id }, fcm))).toBe('sos_not_active');

    // Güncelleme: çok sık → mevcut hâl (hata değil); aralık dolunca konum + sayaç; push yok.
    const tooSoon = await sosUpdate(ctxOf(A, t0 + 5_000), updIn({ op_id: opId(), sos_id: s.sos_id, location: here(t0 + 5_000) }), { address });
    expect(tooSoon.sos.update_count).toBe(1);
    const t1 = t0 + 2_000 + SOS_LIMITS.updateMinIntervalMs;
    const upd = await sosUpdate(ctxOf(A, t1), updIn({ op_id: opId(), sos_id: s.sos_id, location: { ...here(t1), accuracy: 4 }, battery_pct: 21 }), { address });
    expect(upd.sos).toMatchObject({ update_count: 2, battery_pct: 21, location: { accuracy: 4 }, acks: { [B.uid]: t0 + 3_000 } });
    expect(await codeOf(sosUpdate(ctxOf(B, t1 + SOS_LIMITS.updateMinIntervalMs), updIn({ op_id: opId(), sos_id: s.sos_id, location: here(t1) })))).toBe('sos_not_active');
    expect(fcm.sent).toHaveLength(5);

    // Güvendeyim: çözülür, alıcılara "güvende" push; tekrar çağrı mevcut belgeyi döndürür; sonra güncelleme reddedilir.
    const res = await sosResolve(ctxOf(A, t1 + 1_000), { op_id: opId(), sos_id: s.sos_id }, fcm);
    expect(res.sos).toMatchObject({ status: 'resolved', resolve_reason: 'safe', resolved_at: t1 + 1_000 });
    const resolvedPushes = fcm.sent.slice(5);
    expect(new Set(resolvedPushes.map((x) => x.uid))).toEqual(new Set([B.uid, C.uid]));
    expect(resolvedPushes[0]?.msg.data).toEqual({ type: 'sos_resolved', sos_id: s.sos_id, sender_id: A.uid });
    expect(resolvedPushes[0]?.msg.notification?.title).toBe('Ayşe güvende');
    const res2 = await call('sos_resolve', { op_id: opId(), sos_id: s.sos_id }, A);
    expect(res2.sos.status).toBe('resolved');
    expect(fcm.sent).toHaveLength(7);
    expect((await callError('sos_update', { op_id: opId(), sos_id: s.sos_id, location: here(Date.now()) }, A)).details?.code).toBe('sos_not_active');
  });

  it('arkadaşlık bitince kişi acil listeden çıkar; geçerli kişi kalmazsa no_emergency_contacts', async () => {
    const [S, R] = await Promise.all([newUser('Selin'), newUser('Rana')]);
    await befriend(S, R);
    await call('emergency_contacts_set', { op_id: opId(), contact_ids: [R.uid] }, S);
    await call('emergency_contacts_set', { op_id: opId(), contact_ids: [S.uid] }, R);
    await call('friendship_remove', { op_id: opId(), friendship_id: friendshipId(S.uid, R.uid) }, R);
    expect((await db().doc(`users/${S.uid}`).get()).get('emergency_contacts')).toEqual([]);
    expect((await db().doc(`users/${R.uid}`).get()).get('emergency_contacts')).toEqual([]);
    expect((await callError('sos_send', { op_id: opId(), location: here(Date.now()) }, S)).details?.code).toBe('no_emergency_contacts');
  });
});
