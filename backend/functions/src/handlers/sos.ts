/**
 * Faz 4: tam konumlu acil durum (SOS) ve acil durum kişileri.
 *
 * Callable'lar: `emergency_contacts_set`, `sos_send`, `sos_update`, `sos_resolve`, `sos_ack`. Veri Firestore
 * `sos_alerts/{sos_id}` (core `SosAlert` + `purge_at`); yalnızca bu callable'lar yazar, gönderen ve `recipient_ids`
 * okur (firestore.rules).
 *
 *  - Acil kişiler: `users/{uid}.emergency_contacts`, en çok 5, sıra korunur; yalnızca kabul edilmiş ve engelsiz
 *    arkadaşlar tutulur (diğerleri sessizce atılır). Arkadaşlık bitince (kaldırma / engel) iki listeden de çıkar
 *    (graph.ts `readPairF4Cleanup`). SOS gönderilirken liste YENİDEN süzülür: arkadaşlığı biten kişiye gitmez.
 *  - `sos_send`: geçerli kişi yoksa `no_emergency_contacts`. Saatte `SOS_LIMITS.maxSendsPerHour` → `rate_limited`.
 *    Aynı kullanıcının aktif SOS'u varsa yenisi açılmaz: mevcut belge yeni konum / pil / rota ile güncellenir,
 *    alıcılara yeniden push gider ve aynı `sos_id` döner. Adres istemciden gelmezse en çok 2 sn sunucuda aranır
 *    (önbellek → Google; kota yok, hata yutulur → null). `maps_url` = core `sosMapsUrl`.
 *  - `sos_update`: yalnızca gönderen, yalnızca aktifken (`sos_not_active`); `updateMinIntervalMs`'den sık çağrı hata
 *    değildir, mevcut belge döner. Push YOK.
 *  - `sos_resolve`: yalnızca gönderen; aktifse `resolved / safe` + alıcılara "güvende" push. Zaten çözülmüşse
 *    mevcut belge döner (idempotent).
 *  - `sos_ack`: yalnızca alıcı; `acks.{uid} = now`. Her alıcının İLK onayında gönderene push. [Varsayım] Onay
 *    `updated_at`'i değiştirmez (gönderenin konum tazeleme aralığı onaydan etkilenmesin).
 *  - Belgeyi göremeyen biri için (yok / gönderen değil / alıcı değil) hepsi AYNI `sos_not_active`: var olup olmadığı
 *    sızmaz.
 *  - Push başarısızlığı callable'ı bozmaz (`runOp` `after`, en iyi çaba).
 */
import {
  CALLABLES,
  type EmergencyContactsSetRequestSchema,
  type EmergencyContactsSetResponse,
  type EpochMs,
  HOUR,
  SOS_LIMITS,
  SOS_MESSAGE,
  type SosAckRequestSchema,
  type SosAlert,
  type SosAlertResponse,
  type SosLocation,
  type SosResolveRequestSchema,
  type SosSendRequestSchema,
  type SosSendResponse,
  type SosUpdateRequestSchema,
  type UserId,
  geocodeCell,
  sosMapsUrl,
} from '@konum/core';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS } from '../config';
import { COL, type SosAlertDoc, type UserDoc, purgeAt, refs, toSosAlert } from '../docs';
import { fail } from '../errors';
import { canShare, readCaller, readPairStates } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import {
  type PushMessage,
  type PushSender,
  buildSosAckPush,
  buildSosPush,
  buildSosResolvedPush,
  sendPushToUser,
} from '../push';
import { assertDocId, isServerUid, unique } from '../util';
import { sosAddressLookup } from './maps';

export interface SosDeps {
  /** Testler sahte gönderici verir; varsayılan FCM. */
  send?: PushSender;
  /** Adres araması (testler sahte verir); varsayılan `sosAddressLookup` (önbellek → Google, ≤ 2 sn). */
  address?: (p: { lat: number; lng: number }, now: EpochMs) => Promise<string | null>;
}

const lookupAddress = (deps: SosDeps) => deps.address ?? ((p, now) => sosAddressLookup(p, now, undefined, SOS_LIMITS.addressTimeoutMs));

/** Aktif SOS belgesi TTL ile silinmesin: önce süpürücü kapatır (`activeMaxMs`), sonra biten belge payı. */
const activePurgeAt = (now: EpochMs): Timestamp => Timestamp.fromMillis(now + SOS_LIMITS.activeMaxMs + LIMITS.sosEndedTtlMs);
const endedPurgeAt = (now: EpochMs): Timestamp => Timestamp.fromMillis(now + LIMITS.sosEndedTtlMs);

/** Saatin ilerisindeki ölçüm anı sunucu saatine kırpılır (kart "x dk önce" gösterir). */
const clampLocation = (l: SosLocation, now: EpochMs): SosLocation => ({ ...l, timestamp: Math.min(l.timestamp, now) });

const cleanAddress = (s: string | null | undefined): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t.slice(0, 200) : null;
};

/** Gönderen için hâlâ geçerli (kabul edilmiş + engelsiz arkadaş) acil kişiler; sıra korunur. */
async function validContacts(tx: FirebaseFirestore.Transaction, me: UserId, ids: readonly UserId[]): Promise<UserId[]> {
  const list = unique(ids).filter((u) => u !== me && isServerUid(u));
  const pairs = await readPairStates(tx, me, list);
  return list.filter((_, i) => {
    const p = pairs[i];
    return p !== undefined && canShare(p);
  });
}

async function pushAll(uids: readonly UserId[], msg: PushMessage, send: PushSender, what: string): Promise<void> {
  const res = await Promise.allSettled(uids.map((u) => send(u, msg)));
  const failed = res.filter((r) => r.status === 'rejected').length;
  if (failed) logger.warn(`${what}: bazı alıcılara gönderilemedi`, { failed, total: res.length });
}

// ---------------------------------------------------------------------------
// emergency_contacts_set
// ---------------------------------------------------------------------------

export async function emergencyContactsSet(
  ctx: CallCtx,
  data: z.output<typeof EmergencyContactsSetRequestSchema>,
): Promise<EmergencyContactsSetResponse> {
  return runOp(ctx, data.op_id, CALLABLES.emergencyContactsSet, data, async (tx) => {
    await readCaller(tx, ctx.uid);
    const kept = (await validContacts(tx, ctx.uid, data.contact_ids)).slice(0, SOS_LIMITS.maxContacts);
    tx.update(refs.user(ctx.uid), { emergency_contacts: kept });
    return { response: { contact_ids: kept, server_now: ctx.now } };
  });
}

// ---------------------------------------------------------------------------
// sos_send
// ---------------------------------------------------------------------------

export async function sosSend(ctx: CallCtx, data: z.output<typeof SosSendRequestSchema>, deps: SosDeps = {}): Promise<SosSendResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const location = clampLocation(data.location, now);
  // Adres transaction DIŞINDA (ağ çağrısı yeniden denenen transaction'a girmesin); en çok ~2 sn, hata → null.
  const address = cleanAddress(data.address) ?? (await lookupAddress(deps)(location, now).catch(() => null));
  const newId = refs.newSosAlert().id;

  return runOp(ctx, data.op_id, CALLABLES.sosSend, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const rate = await readRateLimit(tx, ctx.uid, 'sos_send', SOS_LIMITS.maxSendsPerHour, HOUR, now);
    const recipients = await validContacts(tx, ctx.uid, me.emergency_contacts ?? []);
    if (recipients.length === 0) throw fail('no_emergency_contacts');
    const activeSnap = await tx.get(
      db().collection(COL.sosAlerts).where('sender_id', '==', ctx.uid).where('status', '==', 'active').limit(1),
    );
    const current = activeSnap.docs[0]?.data() as SosAlertDoc | undefined;

    const common = {
      sender_name: me.display_name ?? '',
      recipient_ids: recipients,
      location,
      address,
      maps_url: sosMapsUrl(location.lat, location.lng),
      battery_pct: data.battery_pct ?? null,
      is_charging: data.is_charging ?? null,
      route: data.route ? { destination_label: data.route.destination_label ?? null, eta_s: data.route.eta_s, distance_m: data.route.distance_m } : null,
      updated_at: now,
    };
    let doc: SosAlertDoc;
    if (current) {
      // Aktif SOS varken yeni basış: aynı uyarı tazelenir ve yeniden push edilir.
      doc = { ...current, ...common, update_count: (current.update_count ?? 0) + 1 };
      tx.update(refs.sosAlert(current.sos_id), { ...common, update_count: doc.update_count });
    } else {
      doc = {
        sos_id: newId,
        sender_id: ctx.uid,
        status: 'active',
        resolve_reason: null,
        message: SOS_MESSAGE,
        created_at: now,
        resolved_at: null,
        acks: {},
        update_count: 0,
        ...common,
        purge_at: activePurgeAt(now),
      };
      tx.set(refs.sosAlert(newId), doc);
    }
    writeRateLimit(tx, rate, HOUR);

    const sos = toSosAlert(doc);
    const response: SosSendResponse = { sos, recipients: recipients.length, server_now: now };
    return { response, after: () => pushAll(recipients, buildSosPush(sos), send, 'sos_send') };
  });
}

// ---------------------------------------------------------------------------
// sos_update
// ---------------------------------------------------------------------------

const notActive = () => fail('sos_not_active');

/** Gönderenin aktif SOS'u (yoksa / başkasınınsa / bittiyse / süresi aştıysa `sos_not_active`). */
function requireOwnActive(d: SosAlertDoc | undefined, uid: UserId, now: EpochMs): SosAlertDoc {
  if (!d || d.sender_id !== uid || d.status !== 'active' || now - d.created_at > SOS_LIMITS.activeMaxMs) throw notActive();
  return d;
}

export async function sosUpdate(ctx: CallCtx, data: z.output<typeof SosUpdateRequestSchema>, deps: SosDeps = {}): Promise<SosAlertResponse> {
  assertDocId(data.sos_id, 'sos_id');
  const now = ctx.now;
  const location = clampLocation(data.location, now);
  const ref = refs.sosAlert(data.sos_id);
  // Adres yalnızca hücre değiştiyse (ön okuma, transaction dışı; yetki transaction'da yeniden denetlenir).
  const pre = (await ref.get()).data() as SosAlertDoc | undefined;
  let address: string | null | undefined;
  if (pre && pre.sender_id === ctx.uid && pre.status === 'active' && now - pre.updated_at >= SOS_LIMITS.updateMinIntervalMs) {
    if (geocodeCell(pre.location) !== geocodeCell(location)) address = await lookupAddress(deps)(location, now).catch(() => null);
  }

  return runOp(ctx, data.op_id, CALLABLES.sosUpdate, data, async (tx) => {
    const d = requireOwnActive((await tx.get(ref)).data() as SosAlertDoc | undefined, ctx.uid, now);
    // Çok sık: hata değil, mevcut hâl döner (istemci bir sonraki aralıkta yeniden dener).
    if (now - d.updated_at < SOS_LIMITS.updateMinIntervalMs) return { response: { sos: toSosAlert(d), server_now: now } };
    const sameCell = geocodeCell(d.location) === geocodeCell(location);
    const patch = {
      location,
      address: sameCell ? d.address : (address ?? null),
      maps_url: sosMapsUrl(location.lat, location.lng),
      battery_pct: data.battery_pct ?? null,
      is_charging: data.is_charging ?? null,
      route: data.route ? { destination_label: data.route.destination_label ?? null, eta_s: data.route.eta_s, distance_m: data.route.distance_m } : null,
      updated_at: now,
      update_count: (d.update_count ?? 0) + 1,
    };
    tx.update(ref, patch);
    return { response: { sos: toSosAlert({ ...d, ...patch }), server_now: now } };
  });
}

// ---------------------------------------------------------------------------
// sos_resolve
// ---------------------------------------------------------------------------

export async function sosResolve(ctx: CallCtx, data: z.output<typeof SosResolveRequestSchema>, deps: SosDeps = {}): Promise<SosAlertResponse> {
  assertDocId(data.sos_id, 'sos_id');
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const ref = refs.sosAlert(data.sos_id);
  return runOp(ctx, data.op_id, CALLABLES.sosResolve, data, async (tx) => {
    const d = (await tx.get(ref)).data() as SosAlertDoc | undefined;
    if (!d || d.sender_id !== ctx.uid) throw notActive();
    if (d.status !== 'active') return { response: { sos: toSosAlert(d), server_now: now } };
    const patch = { status: 'resolved' as const, resolve_reason: 'safe' as const, resolved_at: now, updated_at: now, purge_at: endedPurgeAt(now) };
    tx.update(ref, patch);
    const sos: SosAlert = toSosAlert({ ...d, ...patch });
    return {
      response: { sos, server_now: now },
      after: () => pushAll(sos.recipient_ids, buildSosResolvedPush(sos.sender_name, sos.sos_id, sos.sender_id), send, 'sos_resolve'),
    };
  });
}

// ---------------------------------------------------------------------------
// sos_ack
// ---------------------------------------------------------------------------

export async function sosAck(ctx: CallCtx, data: z.output<typeof SosAckRequestSchema>, deps: SosDeps = {}): Promise<SosAlertResponse> {
  assertDocId(data.sos_id, 'sos_id');
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const ref = refs.sosAlert(data.sos_id);
  return runOp(ctx, data.op_id, CALLABLES.sosAck, data, async (tx) => {
    const [snap, meSnap] = await tx.getAll(ref, refs.user(ctx.uid));
    const d = snap?.data() as SosAlertDoc | undefined;
    if (!d || !(d.recipient_ids ?? []).includes(ctx.uid)) throw notActive();
    // Çözülmüş uyarıda ya da tekrar onayda yazma yok (kart zaten "güvende" / "gördün" gösterir).
    if (d.status !== 'active' || typeof d.acks?.[ctx.uid] === 'number') return { response: { sos: toSosAlert(d), server_now: now } };
    tx.update(ref, { [`acks.${ctx.uid}`]: now });
    const sos = toSosAlert({ ...d, acks: { ...(d.acks ?? {}), [ctx.uid]: now } });
    const name = (meSnap?.data() as UserDoc | undefined)?.display_name ?? '';
    return {
      response: { sos, server_now: now },
      after: async () => {
        await send(d.sender_id, buildSosAckPush(name, d.sos_id, ctx.uid));
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Bakım: süre aşımı ve hesap silme
// ---------------------------------------------------------------------------

/** `activeMaxMs`'i aşan aktif SOS'ları `resolved / timeout` yapar ((status, created_at) dizini). */
export async function timeoutActiveSos(now: EpochMs, max: number = LIMITS.f4SweepMax): Promise<string[]> {
  const snap = await db()
    .collection(COL.sosAlerts)
    .where('status', '==', 'active')
    .where('created_at', '<=', now - SOS_LIMITS.activeMaxMs)
    .orderBy('created_at')
    .limit(max)
    .get();
  const ids: string[] = [];
  for (const d of snap.docs) {
    const ok = await db()
      .runTransaction(async (tx) => {
        const cur = (await tx.get(d.ref)).data() as SosAlertDoc | undefined;
        if (!cur || cur.status !== 'active' || now - cur.created_at < SOS_LIMITS.activeMaxMs) return false;
        tx.update(d.ref, { status: 'resolved', resolve_reason: 'timeout', resolved_at: now, updated_at: now, purge_at: endedPurgeAt(now) });
        return true;
      })
      .catch((err) => {
        logger.error('SOS süre aşımı uygulanamadı', { err: String(err) });
        return false;
      });
    if (ok) ids.push(d.id);
  }
  return ids;
}

/** Hesap silme: gönderenin aktif SOS'ları `account_deleted` ile kapanır (push yok; belge TTL ile silinir). */
export async function closeSosForDeletedAccount(uid: UserId, now: EpochMs): Promise<number> {
  const snap = await db().collection(COL.sosAlerts).where('sender_id', '==', uid).where('status', '==', 'active').get();
  const batch = db().batch();
  for (const d of snap.docs) {
    batch.update(d.ref, { status: 'resolved', resolve_reason: 'account_deleted', resolved_at: now, updated_at: now, purge_at: purgeAt(now) });
  }
  if (!snap.empty) await batch.commit();
  return snap.size;
}

/** Hesap silme: kullanıcı başkalarının acil kişi listelerinden çıkarılır (`array-contains`, otomatik dizin). */
export async function removeFromEmergencyContacts(uid: UserId): Promise<number> {
  const snap = await db().collection(COL.users).where('emergency_contacts', 'array-contains', uid).get();
  const batch = db().batch();
  for (const d of snap.docs) batch.update(d.ref, { emergency_contacts: FieldValue.arrayRemove(uid) });
  if (!snap.empty) await batch.commit();
  return snap.size;
}
