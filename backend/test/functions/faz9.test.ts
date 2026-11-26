/**
 * Faz 9: anlık kamera fotoğrafı (erişim, 1 saatlik silme zinciri, kaldırma, görünmez mod), 200 m yaklaşma tek seferlik
 * bildirimi ve Güvenli Dönüş (başlat / son uyarı / sunucu alarmı → SOS `origin:'safe_return'`, check-in, uzatma sınırı,
 * süpürücü yedeği, onayı geri çekme). İşleyiciler sahte FCM ile doğrudan çağrılır; birkaç çağrı Functions emülatörü
 * üzerinden (dışa aktarım, şema, onay muafiyeti ve hata eşlemesi).
 */
import {
  APPROACH_LIMITS,
  ApproachReportRequestSchema,
  MINUTE,
  PATHS,
  PROOF_LIMITS,
  ProofCreateRequestSchema,
  SAFE_RETURN_LIMITS,
  SafeReturnCheckInRequestSchema,
  SafeReturnStartRequestSchema,
  SafeReturnUpdateRequestSchema,
  base64ToBytes,
  bytesToBase64,
  sosMapsUrl,
} from '@konum/core';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminStorage, db } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import { approachReport } from '../../functions/src/handlers/approach';
import { handleProofExpiryTask, proofBucket, proofCreate, proofDelete, proofGet, sweepExpiredProofs } from '../../functions/src/handlers/proofs';
import {
  safeReturnCancel,
  safeReturnCheckIn,
  safeReturnExtend,
  safeReturnStart,
  safeReturnUpdate,
  tickSafeReturn,
} from '../../functions/src/handlers/safeReturn';
import { sosResolve } from '../../functions/src/handlers/sos';
import { sweepExpired } from '../../functions/src/handlers/sweeper';
import type { PushMessage, PushSender } from '../../functions/src/push';
import { type TestUser, call, callError, cleanupRulesEnv, clientFirestore, newUser, opId } from '../helpers/emulator';
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

const ctxOf = (u: TestUser, now = Date.now()): CallCtx => ({ uid: u.uid, phone_e164: null, now });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { details?: { code?: string } }) => e.details?.code ?? String(e));
const hasStorage = Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST);

/** SOI + APP0 + APP1(EXIF/GPS) + COM + SOF0(w×h) + SOS + veri + EOI (core testindeki gibi). */
function fakeJpeg(width = 640, height = 480): Uint8Array {
  const seg = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
  const exif = Array.from('Exif\0\0GPS-41.0,29.0').map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, exif),
    ...seg(0xfe, [0x68, 0x69]),
    ...seg(0xc0, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12, 0x34, 0x56,
    0xff, 0xd9,
  ]);
}

const proofIn = (now: number, over: Record<string, unknown> = {}) =>
  ProofCreateRequestSchema.parse({
    op_id: opId(),
    source: 'camera',
    jpeg_b64: bytesToBase64(fakeJpeg()),
    width: 640,
    height: 480,
    captured_at: now - 5_000,
    caption: '☕ Mekana geçtim, masamız burası',
    position: { lat: 41.0082381234, lng: 28.9783591234, accuracy: 12.4 },
    ...over,
  });

const fixAt = (t: number, battery = 23) => ({ lat: 41.008238, lng: 28.978359, accuracy: 12, timestamp: t, battery_pct: battery, is_charging: false });
const startIn = (now: number, contacts: string[], over: Record<string, unknown> = {}) =>
  SafeReturnStartRequestSchema.parse({
    op_id: opId(),
    duration_min: 15,
    destination: { kind: 'zone', name: 'Ev', zone_id: null },
    contact_ids: contacts,
    fix: fixAt(now - 2_000),
    time_zone: 'Europe/Istanbul',
    ...over,
  });
const idIn = (id: string) => ({ op_id: opId(), safe_return_id: id });
const objectExists = async (path: string) => (await adminStorage().bucket(proofBucket()).file(path).exists())[0];

let A: TestUser; // Ayşe (paylaşan / Güvenli Dönüş sahibi)
let B: TestUser; // Bora: canlı paylaşım alıcısı + acil kişi
let C: TestUser; // Can: arkadaş, paylaşım YOK, acil kişi değil
let X: TestUser; // yabancı
let sessionId: string;

beforeAll(async () => {
  [A, B, C, X] = await Promise.all([newUser('Ayşe'), newUser('Bora', 'male'), newUser('Can', 'male'), newUser('Xenon')]);
  await befriend(A, B);
  await befriend(A, C);
  await call('emergency_contacts_set', { op_id: opId(), contact_ids: [B.uid] }, A);
  sessionId = (await start(A, [B])).session_id;
});

// ---------------------------------------------------------------------------
// Anlık fotoğraf
// ---------------------------------------------------------------------------

describe.skipIf(!hasStorage)('proof_create / proof_get / proof_delete', () => {
  it('yalnızca kamera + taze çekim; EXIF atılır; paylaşım alıcısı görür, diğerleri "bulunamadı"', async () => {
    const now = Date.now();
    expect(await codeOf(proofCreate(ctxOf(A, now), proofIn(now, { captured_at: now - PROOF_LIMITS.captureMaxAgeMs - 1_000 })))).toBe('proof_stale_capture');
    expect(await codeOf(proofCreate(ctxOf(A, now), proofIn(now, { width: 641 })))).toBe('proof_invalid');
    // Galeri kaynağı şemada yok (callable): invalid_argument.
    const gallery = await callError('proof_create', { ...proofIn(now), source: 'gallery' }, A);
    expect(gallery.details?.code).toBe('invalid_argument');

    const r = await proofCreate(ctxOf(A, now), proofIn(now));
    expect(r.proof).toMatchObject({ owner_id: A.uid, caption: '☕ Mekana geçtim, masamız burası', width: 640, height: 480, expires_at: now + PROOF_LIMITS.ttlMs });
    expect(r.proof.proof_id).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect(r.proof.position).toEqual({ lat: 41.008238, lng: 28.978359, accuracy: 12 });
    expect(r.replaced_proof_id).toBeNull();
    const stored = (await db().doc(PATHS.photoProof(r.proof.proof_id)).get()).data();
    expect(stored).toMatchObject({ state: 'active', source: 'camera', object_deleted: false, storage_path: PATHS.proofObject(A.uid, r.proof.proof_id) });
    expect(await objectExists(PATHS.proofObject(A.uid, r.proof.proof_id))).toBe(true);

    // Alıcı (etkin paylaşım) callable ile baytı alır: EXIF / COM yok, APP0 var.
    const got = await call('proof_get', { owner_id: A.uid, proof_id: r.proof.proof_id }, B);
    const bytes = base64ToBytes(got.jpeg_b64 as string) as Uint8Array;
    const has = (m: number) => Array.from(bytes).some((b, i) => b === 0xff && bytes[i + 1] === m);
    expect([has(0xe0), has(0xe1), has(0xfe)]).toEqual([true, false, false]);
    expect(got.proof.proof_id).toBe(r.proof.proof_id);
    // Sahibi görür; paylaşımı olmayan arkadaş ve yabancı "bulunamadı" (varlık sızmaz); yanlış sahip de öyle.
    expect((await proofGet(ctxOf(A), { owner_id: A.uid, proof_id: r.proof.proof_id })).jpeg_b64).toBe(got.jpeg_b64);
    expect((await callError('proof_get', { owner_id: A.uid, proof_id: r.proof.proof_id }, C)).details?.code).toBe('proof_not_found');
    expect(await codeOf(proofGet(ctxOf(X), { owner_id: A.uid, proof_id: r.proof.proof_id }))).toBe('proof_not_found');
    expect(await codeOf(proofGet(ctxOf(B), { owner_id: C.uid, proof_id: r.proof.proof_id }))).toBe('proof_not_found');
    // Kayıt istemciye tamamen kapalı (sahibi dahil).
    await assertFails((await clientFirestore(A.uid)).doc(PATHS.photoProof(r.proof.proof_id)).get());

    // Yeni fotoğraf eskisinin yerine geçer: eski nesne hemen silinir, eskisi "süresi doldu".
    const r2 = await proofCreate(ctxOf(A), proofIn(Date.now(), { caption: 'Trafik tamamen kilit' }));
    expect(r2.replaced_proof_id).toBe(r.proof.proof_id);
    expect((await db().doc(PATHS.photoProof(r.proof.proof_id)).get()).data()).toMatchObject({ state: 'ended', end_reason: 'replaced', object_deleted: true });
    expect(await objectExists(PATHS.proofObject(A.uid, r.proof.proof_id))).toBe(false);
    expect(await codeOf(proofGet(ctxOf(B), { owner_id: A.uid, proof_id: r.proof.proof_id }))).toBe('proof_expired');

    // Sahip kaldırır (callable, onaydan muaf yol): alıcı "süresi doldu", başkası silemez.
    expect((await callError('proof_delete', { op_id: opId(), proof_id: r2.proof.proof_id }, B)).details?.code).toBe('proof_not_found');
    const del = await call('proof_delete', { op_id: opId(), proof_id: r2.proof.proof_id }, A);
    expect(del).toMatchObject({ proof_id: r2.proof.proof_id, deleted: true });
    expect(await objectExists(PATHS.proofObject(A.uid, r2.proof.proof_id))).toBe(false);
    expect(await codeOf(proofGet(ctxOf(B), { owner_id: A.uid, proof_id: r2.proof.proof_id }))).toBe('proof_expired');
    expect((await proofDelete(ctxOf(A), { op_id: opId(), proof_id: r2.proof.proof_id })).deleted).toBe(false);
  });

  it('1 saat: görev tam zamanında siler; görev kaçarsa dakikalık süpürücü siler', async () => {
    const now = Date.now();
    const p = await proofCreate(ctxOf(A, now), proofIn(now));
    const path = PATHS.proofObject(A.uid, p.proof.proof_id);
    expect(await handleProofExpiryTask({ proof_id: p.proof.proof_id }, now + 10 * MINUTE)).toBe('early');
    expect(await codeOf(proofGet(ctxOf(B), { owner_id: A.uid, proof_id: p.proof.proof_id }))).toBe('ok');
    expect(await codeOf(proofGet(ctxOf(A, p.proof.expires_at + 1), { owner_id: A.uid, proof_id: p.proof.proof_id }))).toBe('proof_expired');
    expect(await handleProofExpiryTask({ proof_id: p.proof.proof_id }, p.proof.expires_at + 1)).toBe('expired');
    expect((await db().doc(PATHS.photoProof(p.proof.proof_id)).get()).data()).toMatchObject({ state: 'ended', end_reason: 'expired', object_deleted: true });
    expect(await objectExists(path)).toBe(false);

    const q = await proofCreate(ctxOf(A), proofIn(Date.now()));
    // (sweepExpired'ın tamamı 1 sa ileri saatle paylaşımları da bitirirdi; fotoğraf adımı doğrudan çağrılır.)
    expect(await sweepExpiredProofs(q.proof.expires_at + 1)).toBeGreaterThanOrEqual(1);
    expect((await db().doc(PATHS.photoProof(q.proof.proof_id)).get()).data()).toMatchObject({ state: 'ended', end_reason: 'expired', object_deleted: true });
    expect(await objectExists(PATHS.proofObject(A.uid, q.proof.proof_id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 200 m yaklaşma
// ---------------------------------------------------------------------------

describe('approach_report', () => {
  const reportIn = (over: Record<string, unknown> = {}) =>
    ApproachReportRequestSchema.parse({
      op_id: opId(),
      session_ids: [sessionId],
      dest_key: '0123456789abcdef',
      dest_name: 'Ev',
      dest_kind: 'zone',
      distance_m: 180,
      eta_min: 1,
      at: Date.now() - 1_000,
      ...over,
    });

  it('oturum + hedef başına TEK bildirim; koordinatsız, movement kanalında; eski rapor stale', async () => {
    const fcm = fakeFcm();
    const r = await approachReport(ctxOf(A), reportIn(), fcm);
    expect(r).toMatchObject({ status: 'sent', notified_count: 1 });
    expect(fcm.sent.map((s) => s.uid)).toEqual([B.uid]);
    const msg = fcm.sent[0]!.msg;
    expect(msg.data).toEqual({ type: 'approach', from: A.uid, dest_name: 'Ev', eta_min: '1' });
    expect(msg.notification).toEqual({ title: 'Ayşe: Neredeyse vardım (1 dk)', body: 'Ev · yaklaşık 180 m kaldı' });
    expect(msg.android).toMatchObject({ priority: 'high', ttl: APPROACH_LIMITS.pushTtlMs, notification: { channelId: 'movement' } });
    expect(JSON.stringify(msg)).not.toMatch(/"lat"|"lng"|41\.00/);
    expect((await db().doc(PATHS.approachMark(A.uid, sessionId, '0123456789abcdef')).get()).exists).toBe(true);

    fcm.clear();
    expect((await approachReport(ctxOf(A), reportIn(), fcm)).status).toBe('already_sent');
    expect(fcm.sent).toHaveLength(0);
    // Yeni hedef = yeni tek hak; bilinmeyen oturum yok sayılır.
    expect((await approachReport(ctxOf(A), reportIn({ dest_key: 'fedcba9876543210', dest_name: 'İş' }), fcm)).status).toBe('sent');
    expect((await approachReport(ctxOf(A), reportIn({ session_ids: ['nope-session'], dest_key: 'aaaaaaaaaaaaaaaa' }), fcm)).status).toBe('no_recipients');
    // Callable: 2 dk'dan eski rapor `stale` (push yok, işaret yok).
    const stale = await call('approach_report', { ...reportIn({ dest_key: 'bbbbbbbbbbbbbbbb' }), at: Date.now() - APPROACH_LIMITS.maxReportAgeMs - 5_000 }, A);
    expect(stale.status).toBe('stale');
    expect((await db().doc(PATHS.approachMark(A.uid, sessionId, 'bbbbbbbbbbbbbbbb')).get()).exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Güvenli Dönüş
// ---------------------------------------------------------------------------

describe('Güvenli Dönüş', () => {
  const address = async () => 'Moda, Kadıköy';

  it('başlat → son uyarı (sahibe push) → süre dolunca sunucu alarmı: SOS origin safe_return, son konum + pil', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    // İzinsiz arkadaş (C) ve yabancı (X) sessizce düşer; hiç kalmazsa no_emergency_contacts.
    expect(await codeOf(safeReturnStart(ctxOf(A, t0), startIn(t0, [C.uid, X.uid]), fcm))).toBe('no_emergency_contacts');
    const s = (await safeReturnStart(ctxOf(A, t0), startIn(t0, [B.uid, C.uid, X.uid]), fcm)).safe_return;
    expect(s).toMatchObject({ owner_id: A.uid, contact_ids: [B.uid], status: 'active', due_at: t0 + 15 * MINUTE, grace_until: t0 + 15 * MINUTE + SAFE_RETURN_LIMITS.graceMs });
    expect(fcm.sent.map((x) => [x.uid, x.msg.data.type])).toEqual([[B.uid, 'safe_return_started']]);
    expect(fcm.sent[0]!.msg.android?.notification?.channelId).toBe('safe_return');
    expect(JSON.stringify(fcm.sent[0]!.msg)).not.toMatch(/"lat"|41\.00/);
    expect(await codeOf(safeReturnStart(ctxOf(A, t0), startIn(t0, [B.uid]), fcm))).toBe('safe_return_active');
    // Kayıt yalnızca sahibine açık.
    await assertSucceeds((await clientFirestore(A.uid)).doc(PATHS.safeReturn(s.safe_return_id)).get());
    await assertFails((await clientFirestore(B.uid)).doc(PATHS.safeReturn(s.safe_return_id)).get());

    // Son konum tazeleme: çok sık → rate_limited, 60 sn sonra kabul.
    const up = (t: number, b: number) => SafeReturnUpdateRequestSchema.parse({ ...idIn(s.safe_return_id), fix: fixAt(t, b) });
    expect(await codeOf(safeReturnUpdate(ctxOf(A, t0 + 10_000), up(t0 + 10_000, 22)))).toBe('rate_limited');
    expect((await safeReturnUpdate(ctxOf(A, t0 + 70_000), up(t0 + 70_000, 21))).safe_return.last_fix.battery_pct).toBe(21);

    fcm.clear();
    expect(await tickSafeReturn(s.safe_return_id, s.due_at - 1, { send: fcm.send })).toBe('noop');
    expect(await tickSafeReturn(s.safe_return_id, s.due_at, { send: fcm.send })).toBe('due');
    expect(fcm.sent.map((x) => [x.uid, x.msg.data.type])).toEqual([[A.uid, 'safe_return_due']]);
    expect(fcm.sent[0]!.msg.notification).toEqual({ title: 'Güvende misin?', body: 'Güvenli Dönüş süren doldu. 2 dk içinde "Güvendeyim" demezsen Bora uyarılacak.' });
    expect(fcm.sent[0]!.msg.apns?.payload?.aps).toMatchObject({ category: 'SAFE_RETURN', 'interruption-level': 'time-sensitive' });
    expect(await tickSafeReturn(s.safe_return_id, s.due_at + 1_000, { send: fcm.send })).toBe('noop');

    fcm.clear();
    expect(await tickSafeReturn(s.safe_return_id, s.grace_until, { send: fcm.send, address })).toBe('alarm');
    const sr = (await db().doc(PATHS.safeReturn(s.safe_return_id)).get()).data();
    expect(sr).toMatchObject({ status: 'alarm' });
    const sos = (await db().doc(PATHS.sosAlert(sr?.sos_id as string)).get()).data();
    expect(sos).toMatchObject({
      sender_id: A.uid,
      status: 'active',
      origin: 'safe_return',
      recipient_ids: [B.uid],
      battery_pct: 21,
      address: 'Moda, Kadıköy',
      maps_url: sosMapsUrl(41.008238, 28.978359),
      safe_return: { safe_return_id: s.safe_return_id, destination_name: 'Ev', duration_min: 15, due_at: s.due_at },
    });
    expect(sos?.message).toContain('Güvenli Dönüş süresi doldu: Ev hedefine 15 dk içinde varmadım');
    expect(fcm.sent.map((x) => x.uid)).toEqual([B.uid]);
    expect(fcm.sent[0]!.msg.data).toEqual({ type: 'sos', sos_id: sr?.sos_id, sender_id: A.uid, origin: 'safe_return' });
    expect(fcm.sent[0]!.msg.android?.notification?.channelId).toBe('sos_alarm');
    expect(fcm.sent[0]!.msg.notification?.title).toBe("ACİL: Ayşe Güvenli Dönüş'te yanıt vermedi");
    // İkinci tick (görev + süpürücü yarışı) etkisiz; alarmdan sonra check-in yok (SOS "Güvendeyim" kapatır).
    expect(await tickSafeReturn(s.safe_return_id, s.grace_until + 60_000, { send: fcm.send, address })).toBe('not_active');
    expect(await codeOf(safeReturnCheckIn(ctxOf(A), SafeReturnCheckInRequestSchema.parse({ ...idIn(s.safe_return_id), reason: 'safe' })))).toBe('safe_return_not_active');
    // Alıcı SOS kaydını okuyabilir (sos_alerts kuralı).
    await assertSucceeds((await clientFirestore(B.uid)).doc(PATHS.sosAlert(sr?.sos_id as string)).get());
    await sosResolve(ctxOf(A), { op_id: opId(), sos_id: sr?.sos_id as string }, { send: fcm.send });
  });

  it('"Güvendeyim" alarmı önler; kişilere bitiş bildirimi', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const s = (await safeReturnStart(ctxOf(A, t0), startIn(t0, [B.uid]), fcm)).safe_return;
    fcm.clear();
    // Onaydan muaf callable yolu.
    const r = await call('safe_return_check_in', { ...idIn(s.safe_return_id), reason: 'safe', fix: null }, A);
    expect(r.safe_return).toMatchObject({ status: 'checked_in' });
    expect(await tickSafeReturn(s.safe_return_id, s.grace_until + 1, { send: fcm.send, address })).toBe('not_active');
    const sos = await db().collection('sos_alerts').where('sender_id', '==', A.uid).where('status', '==', 'active').get();
    expect(sos.empty).toBe(true);
  });

  it('uzatma +15 dk, toplam ≤ 3 sa; iptal kişilere bildirilir', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const s = (await safeReturnStart(ctxOf(A, t0), startIn(t0, [B.uid], { duration_min: 60 }), fcm)).safe_return;
    let due = s.due_at;
    for (let i = 0; i < 8; i++) {
      const r = await safeReturnExtend(ctxOf(A, t0), idIn(s.safe_return_id));
      expect(r.safe_return.due_at).toBe(due + SAFE_RETURN_LIMITS.extendMs);
      due = r.safe_return.due_at;
    }
    expect(due - t0).toBe(SAFE_RETURN_LIMITS.maxTotalMs);
    expect(await codeOf(safeReturnExtend(ctxOf(A, t0), idIn(s.safe_return_id)))).toBe('safe_return_extend_limit');
    fcm.clear();
    const c = await safeReturnCancel(ctxOf(A), idIn(s.safe_return_id), fcm);
    expect(c.safe_return.status).toBe('cancelled');
    expect(fcm.sent.map((x) => [x.uid, x.msg.data.type, (x.msg.data as { reason?: string }).reason])).toEqual([[B.uid, 'safe_return_ended', 'cancelled']]);
    expect(await codeOf(safeReturnExtend(ctxOf(A), idIn(s.safe_return_id)))).toBe('safe_return_not_active');
    // Başkasının kaydı görünmez.
    expect(await codeOf(safeReturnCancel(ctxOf(B), idIn(s.safe_return_id)))).toBe('safe_return_not_active');
  });

  it('görev kaçarsa dakikalık süpürücü alarmı açar (uygulama kapalı / çevrimdışı)', async () => {
    const fcm = fakeFcm();
    const t0 = Date.now();
    const s = (await call('safe_return_start', startIn(t0, [B.uid]), A)).safe_return;
    const r = await sweepExpired({ now: s.grace_until + 1_000, audit: false, safeReturn: { send: fcm.send, address } });
    expect(r.safe_return_alarm_ids).toContain(s.safe_return_id);
    const sr = (await db().doc(PATHS.safeReturn(s.safe_return_id)).get()).data();
    expect(sr).toMatchObject({ status: 'alarm' });
    expect(fcm.sent.some((x) => x.uid === B.uid && x.msg.data.type === 'sos')).toBe(true);
    await sosResolve(ctxOf(A), { op_id: opId(), sos_id: sr?.sos_id as string }, { send: fcm.send });
  });
});

// ---------------------------------------------------------------------------
// Zincirleme: görünmez mod ve açık rızayı geri çekme
// ---------------------------------------------------------------------------

describe('zincirleme', () => {
  it.skipIf(!hasStorage)('görünmez ol: fotoğraf biter, Güvenli Dönüş DURMAZ; rızayı geri çek: ikisi de biter', async () => {
    const [D, E] = await Promise.all([newUser('Deniz'), newUser('Ece')]);
    await befriend(D, E);
    await call('emergency_contacts_set', { op_id: opId(), contact_ids: [E.uid] }, D);
    await start(D, [E]);
    const p = await proofCreate(ctxOf(D), proofIn(Date.now()));
    const s = (await safeReturnStart(ctxOf(D), startIn(Date.now(), [E.uid]), fakeFcm())).safe_return;
    await call('invisible_set', { op_id: opId(), invisible: true }, D);
    expect((await db().doc(PATHS.photoProof(p.proof.proof_id)).get()).data()).toMatchObject({ state: 'ended', end_reason: 'invisible', object_deleted: true });
    expect((await db().doc(PATHS.safeReturn(s.safe_return_id)).get()).data()).toMatchObject({ status: 'active' });
    // Görünmezken yeni fotoğraf yok.
    expect(await codeOf(proofCreate(ctxOf(D), proofIn(Date.now())))).toBe('invisible_mode');
    await call('invisible_set', { op_id: opId(), invisible: false }, D);
    const p2 = await proofCreate(ctxOf(D), proofIn(Date.now()));

    await call('consent_withdraw', { op_id: opId() }, D);
    expect((await db().doc(PATHS.photoProof(p2.proof.proof_id)).get()).data()).toMatchObject({ state: 'ended', end_reason: 'consent_withdrawn' });
    expect((await db().doc(PATHS.safeReturn(s.safe_return_id)).get()).data()).toMatchObject({ status: 'cancelled' });
    // Onaysız: başlatma kapalı, iptal / check-in açık (muaf); biten kayıt not_active.
    expect((await callError('safe_return_start', startIn(Date.now(), [E.uid]), D)).details?.code).toBe('consent_required');
    expect((await callError('safe_return_cancel', idIn(s.safe_return_id), D)).details?.code).toBe('safe_return_not_active');
  });
});
