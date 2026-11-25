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
 *  - Faz 8 (core `canSendSos`): SOS yalnızca `sos_alert` izni olan arkadaşlara gider. Bu izni `emergency_contacts_set`
 *    yazar (seçilen her kişiye `via:'emergency_contact'`) ve listeden çıkanlardan siler; istenemez, `permission_set`
 *    ile değişmez. Faz 8 öncesi listeler için `sos_send` / `sos_update` ilk kullanımda `via:'migration'` yazar
 *    (`sosAudience`). Görünmezken SOS GİDER ve görünmez mod geri yükleme yapmadan (anlık görüntü silinerek) kapanır.
 *  - Aktif SOS'un alıcıları canlı tutulur: `sos_update` her güncellemede listeyi geçerli alıcılarla KESİŞTİRİR;
 *    `emergency_contacts_set`, arkadaşlık kaldırma / engelleme (graph.ts `readPairF4Cleanup`), grafik sıfırlama
 *    (`pruneSosForGraphReset`) ve onayı geri çekme (access.ts, SOS kapanır) alıcıyı hemen çıkarır.
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
  type PermissionGrantDoc,
  type UserId,
  canSendSos,
  emptyGrantDoc,
  geocodeCell,
  hasGrant,
  isInvisible,
  sosMapsUrl,
  withGranted,
  withRevoked,
} from '@konum/core';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS } from '../config';
import { COL, type SosAlertDoc, type UserDoc, purgeAt, refs, toSosAlert } from '../docs';
import { fail } from '../errors';
import { type PairState, assertConsent, isFriend, pairInput, readCaller, readPairStates } from '../graph';
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

/** Aday kişiler ve çift durumları (arkadaşlık + iki yönlü izin), sıra korunur. */
async function contactPairs(tx: FirebaseFirestore.Transaction, me: UserId, ids: readonly UserId[]): Promise<{ id: UserId; pair: PairState | undefined }[]> {
  const list = unique(ids).filter((u) => u !== me && isServerUid(u));
  const pairs = await readPairStates(tx, me, list);
  return list.map((id, i) => ({ id, pair: pairs[i] }));
}

/**
 * SOS alıcıları: hâlâ arkadaş VE `sos_alert` izni olan acil kişiler (core `canSendSos`); sıra korunur.
 *
 * Göç (Faz 8 öncesi liste): `emergency_contacts` yalnızca sahibince (`emergency_contacts_set`) ayarlanır ve Faz 8'den
 * beri `sos_alert` iziyle EŞZAMANLI tutulur (listeden çıkan / arkadaşlığı biten kişinin izni de silinir; sosyal grafik
 * sıfırlanınca liste de boşalır). Listede olup arkadaş olan ama izni olmayan kişi bu yüzden yalnızca Faz 8 öncesi
 * kayıttan kalır: sahibinin o zamanki seçimidir. Bu kişiler için `sos_alert` (`via:'migration'`) aynı transaction'da
 * yazılır (`migrate`) ve kişi alıcı sayılır; aksi hâlde eski kullanıcı acil durumda `no_emergency_contacts` alırdı.
 */
interface SosAudience {
  recipients: UserId[];
  migrate: { id: UserId; grant: PermissionGrantDoc | null }[];
}

async function sosAudience(tx: FirebaseFirestore.Transaction, me: UserId, ids: readonly UserId[]): Promise<SosAudience> {
  const pairs = await contactPairs(tx, me, ids);
  const out: SosAudience = { recipients: [], migrate: [] };
  for (const { id, pair } of pairs) {
    if (!pair || !isFriend(pair)) continue;
    let grant = pair.grantOut;
    if (!hasGrant(grant, 'sos_alert')) {
      out.migrate.push({ id, grant });
      grant = withGranted(grant ?? emptyGrantDoc(me, id, 0), ['sos_alert'], 'migration', 0);
    }
    if (canSendSos(pairInput({ ...pair, grantOut: grant }, { invisible: false, consent: true }))) out.recipients.push(id);
  }
  return out;
}

/** Yazma aşaması: göç izinleri (`sos_alert`, `via:'migration'`); ret anları istemci belgesine yazılmaz. */
function writeSosMigration(tx: FirebaseFirestore.Transaction, me: UserId, a: SosAudience, now: EpochMs): void {
  for (const m of a.migrate) {
    tx.set(refs.grant(me, m.id), { ...withGranted(m.grant ?? emptyGrantDoc(me, m.id, now), ['sos_alert'], 'migration', now), declined_at: {} });
  }
}

/** Gönderenin aktif SOS belgeleri (okuma aşaması; `(sender_id, status)` dizini). */
export async function readActiveSosOf(tx: FirebaseFirestore.Transaction, sender: UserId): Promise<SosAlertDoc[]> {
  const snap = await tx.get(db().collection(COL.sosAlerts).where('sender_id', '==', sender).where('status', '==', 'active'));
  return snap.docs.map((d) => d.data() as SosAlertDoc).filter((d) => d.sender_id === sender && d.status === 'active');
}

/**
 * Yazma aşaması: aktif SOS'un alıcı listesi `keep` ile kesişir (acil kişiden çıkan, engellenen ya da arkadaşlığı biten
 * kişi uyarıyı okuyamaz; kurallar `recipient_ids` ile okutur). Yeni kişi sessizce EKLENMEZ (push almadan konum akışı
 * görmesin). Değişen belge sayısını döndürür.
 */
export function writeSosRecipientPrune(tx: FirebaseFirestore.Transaction, alerts: readonly SosAlertDoc[], keep: (uid: UserId) => boolean, now: EpochMs): number {
  let n = 0;
  for (const a of alerts) {
    const next = (a.recipient_ids ?? []).filter(keep);
    if (next.length === (a.recipient_ids ?? []).length) continue;
    tx.update(refs.sosAlert(a.sos_id), { recipient_ids: next, updated_at: now });
    n++;
  }
  return n;
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
    const me = await readCaller(tx, ctx.uid);
    const old = me.emergency_contacts ?? [];
    // Seçilenler + eski liste (izni silinecekler) tek okumada.
    const all = await contactPairs(tx, ctx.uid, [...data.contact_ids, ...old]);
    // Aktif SOS: listeden çıkanlar uyarıyı (tam konum) okumayı hemen bırakır.
    const active = await readActiveSosOf(tx, ctx.uid);
    const byId = new Map(all.map((c) => [c.id, c.pair] as const));
    const kept = unique(data.contact_ids)
      .filter((u) => byId.has(u) && isFriend(byId.get(u)))
      .slice(0, SOS_LIMITS.maxContacts);
    // --- yazmalar: liste + `sos_alert` izinleri (seçilene yaz, çıkandan sil) ---
    for (const id of kept) {
      const g = byId.get(id)?.grantOut ?? null;
      if (hasGrant(g, 'sos_alert')) continue;
      tx.set(refs.grant(ctx.uid, id), { ...withGranted(g ?? emptyGrantDoc(ctx.uid, id, ctx.now), ['sos_alert'], 'emergency_contact', ctx.now), declined_at: {} });
    }
    for (const c of all) {
      if (kept.includes(c.id) || !c.pair?.grantOut || !hasGrant(c.pair.grantOut, 'sos_alert')) continue;
      tx.set(refs.grant(ctx.uid, c.id), { ...withRevoked(c.pair.grantOut, ['sos_alert'], ctx.now), declined_at: {} });
    }
    tx.update(refs.user(ctx.uid), { emergency_contacts: kept });
    writeSosRecipientPrune(tx, active, (u) => kept.includes(u), ctx.now);
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
    const audience = await sosAudience(tx, ctx.uid, me.emergency_contacts ?? []);
    const recipients = audience.recipients;
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
    writeSosMigration(tx, ctx.uid, audience, now);
    // Faz 8: görünmezken SOS gider ve görünmez mod GERİ YÜKLEMESİZ kapanır (anlık görüntü silinir).
    if (isInvisible(me)) tx.update(refs.user(ctx.uid), { invisible: null, visible_since: now });

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
    // Faz 8: alıcılar her güncellemede yeniden süzülür (acil kişiden çıkan / engellenen / arkadaşlığı biten kişi yeni
    // konumu almaz). Yalnızca KESİŞİM: listeye sonradan eklenen kişi push almadan akışa katılmaz.
    const me = await readCaller(tx, ctx.uid);
    const audience = await sosAudience(tx, ctx.uid, me.emergency_contacts ?? []);
    const recipient_ids = (d.recipient_ids ?? []).filter((u) => audience.recipients.includes(u));
    const pruned = recipient_ids.length !== (d.recipient_ids ?? []).length;
    writeSosMigration(tx, ctx.uid, { ...audience, migrate: audience.migrate.filter((m) => recipient_ids.includes(m.id)) }, now);
    // Çok sık: hata değil, mevcut hâl döner (istemci bir sonraki aralıkta yeniden dener); alıcı süzgeci yine yazılır.
    if (now - d.updated_at < SOS_LIMITS.updateMinIntervalMs) {
      if (pruned) tx.update(ref, { recipient_ids });
      return { response: { sos: toSosAlert({ ...d, recipient_ids }), server_now: now } };
    }
    const sameCell = geocodeCell(d.location) === geocodeCell(location);
    const patch = {
      recipient_ids,
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

/** Yazma aşaması: aktif SOS'u `resolved / safe` yapar (onay geri çekmede de kullanılır). */
export function writeSosResolved(tx: FirebaseFirestore.Transaction, d: SosAlertDoc, now: EpochMs): SosAlert {
  const patch = { status: 'resolved' as const, resolve_reason: 'safe' as const, resolved_at: now, updated_at: now, purge_at: endedPurgeAt(now) };
  tx.update(refs.sosAlert(d.sos_id), patch);
  return toSosAlert({ ...d, ...patch });
}

/** Commit sonrası: alıcılara "güvende" push'u (en iyi çaba). */
export const pushSosResolved = (sos: SosAlert, send: PushSender, what: string): Promise<void> =>
  pushAll(sos.recipient_ids, buildSosResolvedPush(sos.sender_name, sos.sos_id, sos.sender_id), send, what);

export async function sosResolve(ctx: CallCtx, data: z.output<typeof SosResolveRequestSchema>, deps: SosDeps = {}): Promise<SosAlertResponse> {
  assertDocId(data.sos_id, 'sos_id');
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const ref = refs.sosAlert(data.sos_id);
  // Faz 8: onaysız da çalışır (core `CONSENT_EXEMPT_CALLABLES`): kullanıcı kendi tam konum uyarısını her zaman kapatır.
  return runOp(ctx, data.op_id, CALLABLES.sosResolve, data, async (tx) => {
    const d = (await tx.get(ref)).data() as SosAlertDoc | undefined;
    if (!d || d.sender_id !== ctx.uid) throw notActive();
    if (d.status !== 'active') return { response: { sos: toSosAlert(d), server_now: now } };
    const sos = writeSosResolved(tx, d, now);
    return { response: { sos, server_now: now }, after: () => pushSosResolved(sos, send, 'sos_resolve') };
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
    assertConsent(meSnap?.data() as UserDoc | undefined);
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

/**
 * Sosyal grafik sıfırlanınca (pasif hesap, user.ts `resetSocialGraph`): kullanıcının aktif SOS'unun alıcıları boşalır
 * ve kullanıcı başkalarının aktif SOS alıcılarından çıkar (arkadaşlık kalmadı; tam konumu okumamalı). Kullanıcının
 * acil kişi listesi de boşalır (izinler zaten silindi; liste ile izin eşzamanlı kalsın, sonraki arkadaşlıkta göç
 * eski seçimi diriltmesin) ve kullanıcı başkalarının listelerinden çıkar. Tek alanlı sorgular (otomatik dizin).
 */
export async function pruneSosForGraphReset(uid: UserId, now: EpochMs): Promise<void> {
  const col = db().collection(COL.sosAlerts);
  const [own, received] = await Promise.all([col.where('sender_id', '==', uid).get(), col.where('recipient_ids', 'array-contains', uid).get()]);
  const writer = db().bulkWriter();
  for (const d of own.docs) {
    if (d.get('status') === 'active' && (d.get('recipient_ids') ?? []).length > 0) void writer.update(d.ref, { recipient_ids: [], updated_at: now });
  }
  for (const d of received.docs) {
    if (d.get('status') === 'active' && d.get('sender_id') !== uid) void writer.update(d.ref, { recipient_ids: FieldValue.arrayRemove(uid), updated_at: now });
  }
  await writer.close();
  await removeFromEmergencyContacts(uid);
  try {
    await refs.user(uid).update({ emergency_contacts: [] });
  } catch (err) {
    if ((err as { code?: number }).code !== 5) throw err; // 5 = NOT_FOUND (profil yok)
  }
}
