/**
 * Faz 8: yönlü izinler, görünmez mod ve Güvenlik Sözleşmesi / KVKK onayı (docs/PHASE8.md §1–§4) —
 * `permission_request_send`, `permission_request_respond`, `permission_set`, `invisible_set`, `consent_accept`,
 * `consent_withdraw`.
 *
 * İzinler (`permission_grants/{granter}_{grantee}`, core `access.ts`):
 *  - Belge yönlüdür; A'nın B'ye verdiği izin B'nin A'ya izin verdiği anlamına gelmez. Tek taraflı onaydan ters yönde
 *    yetki doğmaz. Belge geçişleri core'un saf fonksiyonlarıyladır (`withGranted`, `withRevoked`,
 *    `withPendingRequest`, `withResponse`, `planPermissionRequest`): backend ve demo aynı geçişi uygular.
 *  - Bilgi sızmaz: belge grantee'ye de açıktır, bu yüzden ret anları (`declined_at`) belgeye BOŞ yazılır ve
 *    `permission_declines/{granter}_{grantee}` belgesinde tutulur (yalnızca granter okur: "İzin istekleri" kartı
 *    reddettiklerini gizler). Salt ret izin belgesine HİÇ dokunmaz: reddedilen kapsam isteyenin gördüğü `pending`
 *    içinde süresi dolana kadar kalır. Ret soğumasındaki yeniden istek de yazılır ama granter'a gizli kalır ve push
 *    yoktur (core `planPermissionRequest` → `hidden`). Retde ve geri almada push yoktur.
 *  - Geri alma (`permission_set(granted:false)`) onaysız da çalışır ve zincirleme temizliği (core `REVOKE_EFFECTS`)
 *    AYNI transaction'da yapar: `location_view` → granter→grantee paylaşımı `stopped_by_sender` ile biter, grantee
 *    granter'ın yer notu kitlesinden, bölge `start_share` kurallarından ve favorilerinden çıkar; `zone_notify` →
 *    granter, grantee'nin `notify` kurallarının alıcılarından çıkar.
 *
 * Görünmez mod (`users/{uid}.invisible`, core `invisible.ts`):
 *  - Açınca (onaysız da çalışır): etkin giden paylaşımların anlık görüntüsü alınır, hepsi `stopped_by_sender` ile
 *    biter (ACL mezar taşı → canlı kopya silinir → RTDB yazıları kurallarca reddedilir), etkin QR bağlantıları biter
 *    (geri yüklenmez). Arkadaşa "görünmez oldu" denmez.
 *  - Kapatınca: YALNIZCA `restore_receiver_ids` içindeki, anlık görüntüde olan, süresi dolmamış, hâlâ arkadaş +
 *    `location_view` izni olan alıcılarla eski bitiş saatine kadar (`custom_until`, süresizse `indefinite`) yeniden
 *    başlar. Seçim yoksa hiçbir şey başlamaz; anlık görüntü silinir.
 *
 * Onay (`users/{uid}/consents/{version}` + `users/{uid}.consent`, core `consent.ts`):
 *  - `consent_accept`: istemcinin sürümü ve metin özeti güncel olanla aynı olmalı (gösterilen = onaylanan); değilse
 *    `consent_required` (`extra.current_version`). Aynı sürüm zaten onaylıysa kayıt değişmez (ilk onay anı korunur);
 *    geri çekilmiş sürüm yeniden onaylanırsa önceki onay ve geri çekme anı `history`ye taşınır (üzerine yazılmaz).
 *  - `consent_withdraw`: tüm giden paylaşımlar ve bağlantılar biter, aktif SOS kapanır, yer notları silinir, önerdiği
 *    buluşmalar iptal olur; kayda `withdrawn_at` yazılır, `users.consent = null`.
 */
import {
  CALLABLES,
  type ConsentAcceptRequestSchema,
  type ConsentAcceptResponse,
  type ConsentRecord,
  type ConsentWithdrawResponse,
  type ConsentWithdrawSchema,
  DAY,
  DurationError,
  type DurationChoice,
  type EpochMs,
  INVISIBLE_SNAPSHOT_MAX,
  type InvisibleSetRequestSchema,
  type InvisibleSetResponse,
  type InvisibleState,
  PERMISSION_REQUEST_DECLINE_COOLDOWN_MS,
  PERMISSION_REQUEST_PAIR_COOLDOWN_MS,
  PERMISSION_REQUEST_TTL_MS,
  PERMISSION_REQUESTS_PER_DAY,
  type PermissionGrantDoc,
  type PermissionRequestRespondResponse,
  type PermissionRequestRespondSchema,
  type PermissionRequestSendResponse,
  type PermissionRequestSendSchema,
  type PermissionSetResponse,
  type PermissionSetSchema,
  type ProfileConsent,
  REVOKE_EFFECTS,
  type ResolvedDuration,
  type UserId,
  canRequestPermission,
  canShareLocation,
  emptyGrantDoc,
  grantedScopes,
  hasGrant,
  isCurrentConsent,
  isInvisible,
  isMeetupActive,
  planInvisibleOn,
  planInvisibleRestore,
  planPermissionRequest,
  shareId,
  withGranted,
  withPendingRequest,
  withConsentHistory,
  withResponse,
  withRevoked,
} from '@konum/core';
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { type AclSource, readAclVersions } from '../acl';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { DEFAULT_TIME_ZONE } from '../config';
import {
  COL,
  type LinkShareDoc,
  type MeetupDoc,
  type PermissionDeclineDoc,
  type PlaceNoteDoc,
  type ShareDoc,
  type UserDoc,
  endedLink,
  endedShare,
  favoriteIdsOf,
  linkEndFields,
  refs,
  toView,
} from '../docs';
import { fail } from '../errors';
import { callerAccess, consentFail, endFields, isFriend, pairInput, readCaller, readPairStates } from '../graph';
import { applyLinkEffects, writeLinkAclPending } from '../linkAcl';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushSender, buildPermissionGrantedPush, buildPermissionRequestPush, sendPushToUser } from '../push';
import { assertUid, resolveForZone, unique } from '../util';
import { type StartCandidate, readStartCandidates, writeShareStarts } from './shares';
import { readActiveSosOf, pushSosResolved, writeSosResolved } from './sos';
import { readZoneRecipientStrip, writePairZoneCleanup } from './zones';

export interface AccessDeps {
  /** Testler sahte gönderici verir; varsayılan FCM. */
  send?: PushSender;
}

/** Günlük izin isteği sayacı: `rate_limits/{uid}_permission_request`. */
const REQUEST_RATE_KEY = 'permission_request';

/** İstemciye açık belge: ret anları ASLA yazılmaz (isteyene "reddedildin" sızmasın). */
const clientDoc = (d: PermissionGrantDoc): PermissionGrantDoc => ({ ...d, declined_at: {} });

const declinesOf = (snap: FirebaseFirestore.DocumentSnapshot | undefined): PermissionGrantDoc['declined_at'] =>
  ((snap?.data() as PermissionDeclineDoc | undefined)?.declined_at ?? {}) as PermissionGrantDoc['declined_at'];

/**
 * `permission_declines/{granter}_{grantee}`: ret anları (soğuma + granter kartında gizleme). Reddedilen kapsam istemci
 * belgesinde bekleyen istek olarak 48 saate kadar durduğu için kayıt en az o kadar yaşar.
 */
const declineDoc = (granter: UserId, grantee: UserId, declined_at: PermissionGrantDoc['declined_at'], now: EpochMs): PermissionDeclineDoc => ({
  granter_id: granter,
  grantee_id: grantee,
  declined_at,
  updated_at: now,
  purge_at: Timestamp.fromMillis(now + Math.max(PERMISSION_REQUEST_DECLINE_COOLDOWN_MS, PERMISSION_REQUEST_TTL_MS) + DAY),
});

/** Süresi dolmuş ama taranmamış paylaşım / bağlantı: neden "expired" kalır (doğru metin için). */
const stopReason = (s: { expires_at: EpochMs | null }, now: EpochMs) =>
  s.expires_at !== null && s.expires_at <= now ? ('expired' as const) : ('stopped_by_sender' as const);

function assertPeer(ctx: CallCtx, id: string, field: string): UserId {
  assertUid(id, field);
  if (id === ctx.uid) throw fail('invalid_argument', { extra: { field } });
  return id;
}

// ---------------------------------------------------------------------------
// permission_request_send (grantee → granter: "bana şu izni ver")
// ---------------------------------------------------------------------------

export async function permissionRequestSend(
  ctx: CallCtx,
  data: z.output<typeof PermissionRequestSendSchema>,
  deps: AccessDeps = {},
): Promise<PermissionRequestSendResponse> {
  const send = deps.send ?? sendPushToUser;
  const target = assertPeer(ctx, data.target_id, 'target_id');
  const now = ctx.now;

  return runOp(ctx, data.op_id, CALLABLES.permissionRequestSend, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const [pair] = await readPairStates(tx, ctx.uid, [target]);
    if (!canRequestPermission(pairInput(pair, callerAccess(me)))) throw fail('not_friends');
    const declSnap = await tx.get(refs.permissionDecline(target, ctx.uid));
    // Hedefin bana verdiği belge (granter = hedef). Soğuma için sunucuya özel ret anları birleştirilir.
    const current = pair?.grantIn ?? null;
    const plan = planPermissionRequest(current ? { ...current, declined_at: declinesOf(declSnap) } : null, data.scopes, now);
    const answer = (status: PermissionRequestSendResponse['status']) => ({ response: { status, server_now: now } });

    switch (plan.kind) {
      case 'already_granted':
        return answer('already_granted');
      case 'noop':
        // Hepsi zaten bekliyor ya da ret soğumasında: yazma / push yok, yanıt yine `sent` (ret sızmaz).
        return answer('sent');
      case 'cooldown': {
        const at = current?.pending?.requested_at ?? now;
        throw fail('permission_cooldown', { extra: { retry_after_ms: Math.max(0, at + PERMISSION_REQUEST_PAIR_COOLDOWN_MS - now) } });
      }
      case 'send': {
        const rl = await readRateLimit(tx, ctx.uid, REQUEST_RATE_KEY, PERMISSION_REQUESTS_PER_DAY, DAY, now);
        // --- yazmalar ---
        // İsteyen her durumda aynı şeyi görür (bekleyen istek yazılır, sınırlar aynı işler). Reddedilmiş / ret
        // soğumasındaki kapsamlar granter'a gizli kalır: sunucuya özel ret anı yeni istek anına taşınır, push gitmez.
        const next = withPendingRequest(current ?? emptyGrantDoc(target, ctx.uid, now), plan.scopes, now);
        tx.set(refs.grant(target, ctx.uid), clientDoc(next));
        if (plan.hidden.length > 0) {
          const declined_at = { ...declinesOf(declSnap) };
          for (const sc of plan.hidden) declined_at[sc] = now;
          tx.set(refs.permissionDecline(target, ctx.uid), declineDoc(target, ctx.uid, declined_at, now));
        }
        writeRateLimit(tx, rl, DAY);
        const name = me.display_name ?? '';
        return {
          ...answer('sent'),
          after:
            plan.added.length > 0
              ? async () => {
                  await send(target, buildPermissionRequestPush(name, ctx.uid, plan.live));
                }
              : undefined,
        };
      }
    }
  });
}

// ---------------------------------------------------------------------------
// permission_request_respond (granter: "şunları ver, gerisini reddet" [+ şimdi paylaş])
// ---------------------------------------------------------------------------

export async function permissionRequestRespond(
  ctx: CallCtx,
  data: z.output<typeof PermissionRequestRespondSchema>,
  deps: AccessDeps = {},
): Promise<PermissionRequestRespondResponse> {
  const send = deps.send ?? sendPushToUser;
  const requester = assertPeer(ctx, data.requester_id, 'requester_id');
  const now = ctx.now;
  const resolved = data.share ? resolveForZone(data.share.duration, data.share.time_zone, now) : null;
  const aclVersions = resolved ? await readAclVersions([shareId(ctx.uid, requester)]) : new Map<string, number>();

  return runOp(ctx, data.op_id, CALLABLES.permissionRequestRespond, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const [cand] = await readStartCandidates(tx, ctx.uid, [requester]);
    const declRef = refs.permissionDecline(ctx.uid, requester);
    const declSnap = await tx.get(declRef);
    if (!cand || !isFriend(cand.pair)) throw fail('not_friends');

    const base = cand.pair.grantOut ?? emptyGrantDoc(ctx.uid, requester, now);
    const r = withResponse({ ...base, declined_at: declinesOf(declSnap) }, data.grant_scopes, now, 'request');

    // --- yazmalar ---
    // İstemci belgesi YALNIZCA bir şey verildiyse yazılır; salt ret belgeye hiç dokunmaz (isteyen "bekliyor" görmeye
    // devam eder, sürüm / zaman damgası değişmez). Ret anları sunucuya özel kayda (granter okuyabilir) yazılır.
    if (r.granted.length > 0) tx.set(refs.grant(ctx.uid, requester), clientDoc(r.doc));
    if (r.declined.length > 0) tx.set(declRef, declineDoc(ctx.uid, requester, r.doc.declined_at, now));

    let share: PermissionRequestRespondResponse['share'] = null;
    let share_skipped: PermissionRequestRespondResponse['share_skipped'] = null;
    let started: ShareDoc[] = [];
    if (resolved) {
      if (!hasGrant(r.doc, 'location_view')) share_skipped = 'no_location_view';
      else if (isInvisible(me)) share_skipped = 'invisible';
      else {
        const w = writeShareStarts(tx, me, [{ ...cand, pair: { ...cand.pair, grantOut: r.doc } }], resolved, now, aclVersions);
        started = w.started;
        if (started.length > 0) share = { session_id: w.session_id, shares: started.map(toView) };
      }
    }

    const response: PermissionRequestRespondResponse = {
      granted_scopes: r.granted,
      declined_scopes: r.declined,
      share,
      share_skipped,
      server_now: now,
    };
    const name = me.display_name ?? '';
    return {
      response,
      shareEffects: started,
      // Retde push YOK (isteyen reddedildiğini bildirimle öğrenmez).
      after:
        r.granted.length > 0
          ? async () => {
              await send(requester, buildPermissionGrantedPush(name, ctx.uid, r.granted));
            }
          : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// permission_set (granter'ın doğrudan anahtarı; geri alma onaysız da çalışır)
// ---------------------------------------------------------------------------

export async function permissionSet(ctx: CallCtx, data: z.output<typeof PermissionSetSchema>): Promise<PermissionSetResponse> {
  const grantee = assertPeer(ctx, data.grantee_id, 'grantee_id');
  const now = ctx.now;
  const scope = data.scope;

  return runOp(ctx, data.op_id, CALLABLES.permissionSet, data, async (tx) => {
    // Açmak onay ister; kapatmak (koruyucu işlem) istemez.
    const me = await readCaller(tx, ctx.uid, { consent: data.granted });
    const [pair] = await readPairStates(tx, ctx.uid, [grantee]);
    const current = pair?.grantOut ?? null;
    const answer = (doc: PermissionGrantDoc | null): PermissionSetResponse => ({ grantee_id: grantee, scopes: grantedScopes(doc), server_now: now });

    if (data.granted) {
      if (!isFriend(pair)) throw fail('not_friends');
      if (hasGrant(current, scope)) return { response: answer(current) };
      const next = withGranted(current ?? emptyGrantDoc(ctx.uid, grantee, now), [scope], 'manual', now);
      tx.set(refs.grant(ctx.uid, grantee), clientDoc(next));
      return { response: answer(next) };
    }

    if (!current || !hasGrant(current, scope)) return { response: answer(current) };
    const effects = REVOKE_EFFECTS[scope];

    // --- okumalar (zincirleme temizlik) ---
    const shareSnap = effects.includes('end_shares') ? await tx.get(refs.share(ctx.uid, grantee)) : null;
    const notes = effects.includes('remove_from_note_audience')
      ? await tx.get(db().collection(COL.placeNotes).where('owner_id', '==', ctx.uid).where('visible_to', 'array-contains', grantee))
      : null;
    const startStrip = effects.includes('remove_from_zone_start_share') ? await readZoneRecipientStrip(tx, ctx.uid, grantee, 'start_share') : null;
    const notifyStrip = effects.includes('remove_from_zone_notify') ? await readZoneRecipientStrip(tx, grantee, ctx.uid, 'notify') : null;

    // --- yazmalar ---
    const next = withRevoked(current, [scope], now);
    tx.set(refs.grant(ctx.uid, grantee), clientDoc(next));
    const ended: AclSource[] = [];
    if (shareSnap?.exists) {
      const s = shareSnap.data() as ShareDoc;
      // Alıcıya "iznini geri aldı" denmez: paylaşım sıradan bir durdurma gibi biter.
      const e = endedShare(s, stopReason(s, now), now);
      if (e) {
        tx.update(refs.shareById(s.share_id), endFields(e));
        ended.push(e);
      }
    }
    for (const d of notes?.docs ?? []) {
      if ((d.data() as PlaceNoteDoc).owner_id === ctx.uid) tx.update(d.ref, { visible_to: FieldValue.arrayRemove(grantee) });
    }
    if (startStrip) writePairZoneCleanup(tx, startStrip, now);
    if (notifyStrip) writePairZoneCleanup(tx, notifyStrip, now);
    if (effects.includes('remove_from_favorites') && favoriteIdsOf(me).includes(grantee)) {
      tx.update(refs.user(ctx.uid), { favorite_ids: FieldValue.arrayRemove(grantee) });
    }
    return { response: answer(next), shareEffects: ended };
  });
}

// ---------------------------------------------------------------------------
// Ortak: giden etkin paylaşımlar ve bağlantılar (görünmez ol, onayı geri çek)
// ---------------------------------------------------------------------------

interface OutgoingActive {
  shares: ShareDoc[];
  links: { ref: FirebaseFirestore.DocumentReference; doc: LinkShareDoc }[];
}

async function readOutgoingActive(tx: Transaction, uid: UserId): Promise<OutgoingActive> {
  const [s, l] = await Promise.all([
    tx.get(db().collection(COL.shares).where('sender_id', '==', uid).where('status', '==', 'active')),
    tx.get(db().collection(COL.linkShares).where('sender_id', '==', uid).where('status', '==', 'active')),
  ]);
  return {
    shares: s.docs.map((d) => d.data() as ShareDoc).filter((x) => x.sender_id === uid && x.status === 'active'),
    links: l.docs.map((d) => ({ ref: d.ref, doc: d.data() as LinkShareDoc })).filter((x) => x.doc.sender_id === uid && x.doc.status === 'active'),
  };
}

/** Yazma aşaması: hepsini `stopped_by_sender` ile bitirir (bağlantı ACL işaretiyle birlikte). */
function endOutgoing(tx: Transaction, o: OutgoingActive, now: EpochMs): { shares: ShareDoc[]; links: LinkShareDoc[] } {
  const shares: ShareDoc[] = [];
  const links: LinkShareDoc[] = [];
  for (const s of o.shares) {
    const e = endedShare(s, stopReason(s, now), now);
    if (!e) continue;
    tx.update(refs.shareById(s.share_id), endFields(e));
    shares.push(e);
  }
  for (const l of o.links) {
    const e = endedLink(l.doc, stopReason(l.doc, now), now);
    if (!e) continue;
    tx.update(l.ref, linkEndFields(e));
    writeLinkAclPending(tx, e, now);
    links.push(e);
  }
  return { shares, links };
}

/** Commit sonrası bağlantı aynası (link_acl mezar taşı → link_live silinir). Hata: istemci aynı op_id ile yineler. */
async function applyEndedLinks(op: string, links: readonly LinkShareDoc[]): Promise<void> {
  if (links.length === 0) return;
  try {
    await applyLinkEffects(links);
  } catch (err) {
    // İşaret (`link_acl_pending`) kaldı; uzlaştırıcı ve bakım işi de onarır.
    logger.error(`${op}: bağlantı aynası uygulanamadı`, { err: String(err) });
    throw fail('unavailable');
  }
}

// ---------------------------------------------------------------------------
// invisible_set
// ---------------------------------------------------------------------------

export async function invisibleSet(ctx: CallCtx, data: z.output<typeof InvisibleSetRequestSchema>): Promise<InvisibleSetResponse> {
  const now = ctx.now;
  const restoreIds = data.invisible ? [] : unique(data.restore_receiver_ids ?? []).filter((id) => id !== ctx.uid);
  for (const id of restoreIds) assertUid(id, 'restore_receiver_ids');
  const aclVersions = restoreIds.length ? await readAclVersions(restoreIds.map((r) => shareId(ctx.uid, r))) : new Map<string, number>();
  let endedLinks: LinkShareDoc[] = [];

  const response = await runOp(ctx, data.op_id, CALLABLES.invisibleSet, data, async (tx) => {
    endedLinks = [];
    // Görünmez olmak koruyucu işlemdir (onaysız da çalışır); görünür olup paylaşımı yeniden başlatmak onay ister.
    const me = await readCaller(tx, ctx.uid, { consent: !data.invisible });
    const prev = me.invisible?.on ? me.invisible : null;

    if (data.invisible) {
      const out = await readOutgoingActive(tx, ctx.uid);
      // Zaten görünmezse eski anlık görüntü korunur (yalnızca yeni kişiler eklenir).
      const fresh = planInvisibleOn(out.shares, now);
      const kept = prev?.snapshot ?? [];
      const snapshot = [...kept, ...fresh.filter((f) => !kept.some((k) => k.receiver_id === f.receiver_id))].slice(0, INVISIBLE_SNAPSHOT_MAX);
      // --- yazmalar ---
      const ended = endOutgoing(tx, out, now);
      endedLinks = ended.links;
      const state: InvisibleState = { on: true, since: prev?.since ?? now, snapshot, links_ended: (prev?.links_ended ?? 0) + ended.links.length };
      tx.update(refs.user(ctx.uid), { invisible: state });
      const r: InvisibleSetResponse = { invisible: true, restored_receiver_ids: [], skipped_receiver_ids: [], server_now: now };
      return { response: r, shareEffects: ended.shares };
    }

    // --- görünür ol: yalnızca seçilenler, anlık görüntüdeki eski bitişe kadar ---
    const snapshot = prev?.snapshot ?? [];
    const inSnapshot = restoreIds.filter((id) => snapshot.some((e) => e.receiver_id === id));
    const cands = await readStartCandidates(tx, ctx.uid, inSnapshot);
    const candOf = new Map(cands.map((c) => [c.receiver_id, c] as const));
    const visible = { ...callerAccess(me), invisible: false };
    const plan = planInvisibleRestore(snapshot, restoreIds, now, (id) => canShareLocation(pairInput(candOf.get(id)?.pair, visible)));
    const skipped = new Set<UserId>(plan.skipped_receiver_ids);
    // Süre gruplaması (aynı bitiş = aynı oturum); süre hesaplanamazsa (sınır dışı) atlanır.
    const groups = new Map<string, { resolved: ResolvedDuration; cands: StartCandidate[] }>();
    for (const { entry, duration } of plan.restore) {
      const resolved = resolveRestore(duration, now);
      const cand = candOf.get(entry.receiver_id);
      if (!resolved || !cand) {
        skipped.add(entry.receiver_id);
        continue;
      }
      const key = `${resolved.share_mode}:${resolved.expires_at ?? 'none'}`;
      const g = groups.get(key) ?? { resolved, cands: [] };
      g.cands.push(cand);
      groups.set(key, g);
    }

    // --- yazmalar ---
    if (me.invisible) tx.update(refs.user(ctx.uid), { invisible: null, visible_since: now });
    const meVisible: UserDoc = { ...me, invisible: null };
    const started: ShareDoc[] = [];
    for (const g of groups.values()) {
      const w = writeShareStarts(tx, meVisible, g.cands, g.resolved, now, aclVersions);
      started.push(...w.started);
      for (const id of [...w.skipped, ...w.needs_grant]) skipped.add(id);
    }
    const restored = started.map((s) => s.receiver_id);
    const r: InvisibleSetResponse = {
      invisible: false,
      restored_receiver_ids: restored,
      skipped_receiver_ids: [...skipped].filter((id) => !restored.includes(id)),
      server_now: now,
    };
    return { response: r, shareEffects: started };
  });

  await applyEndedLinks(CALLABLES.invisibleSet, endedLinks);
  return response;
}

function resolveRestore(duration: DurationChoice, now: EpochMs): ResolvedDuration | null {
  try {
    return resolveForZone(duration, DEFAULT_TIME_ZONE, now);
  } catch (err) {
    if (err instanceof DurationError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// consent_accept / consent_withdraw
// ---------------------------------------------------------------------------

export async function consentAccept(ctx: CallCtx, data: z.output<typeof ConsentAcceptRequestSchema>): Promise<ConsentAcceptResponse> {
  // Gösterilen metin = onaylanan metin: sürüm ya da özet eskiyse yeniden onay ekranı.
  if (!isCurrentConsent(data)) throw consentFail();
  const now = ctx.now;
  return runOp(ctx, data.op_id, CALLABLES.consentAccept, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid, { consent: false });
    if (me.consent?.version === data.version) return { response: { consent: me.consent, server_now: now } };
    // Ekleme amaçlı: aynı sürüm geri çekilip yeniden onaylanıyorsa önceki onay + geri çekme anı geçmişe taşınır.
    const prevSnap = await tx.get(refs.consent(ctx.uid, data.version));
    const history = withConsentHistory(prevSnap.exists ? (prevSnap.data() as ConsentRecord) : null);
    const consent: ProfileConsent = { version: data.version, accepted_at: now };
    const record: ConsentRecord = {
      user_id: ctx.uid,
      version: data.version,
      text_sha256: data.text_sha256,
      scrolled_to_bottom: true,
      accepted_at: now,
      platform: data.platform,
      app_version: data.app_version,
      withdrawn_at: null,
      ...(history.length ? { history } : {}),
    };
    tx.set(refs.consent(ctx.uid, data.version), record);
    tx.update(refs.user(ctx.uid), { consent });
    return { response: { consent, server_now: now } };
  });
}

/**
 * Onayı geri çekmek, konumdan türeyen ve başkalarına görünen her şeyi AYNI transaction'da kapatır: giden paylaşımlar
 * ve bağlantılar biter, aktif SOS `resolved / safe` olur (alıcılara olağan "güvende" push'u), yer notları silinir,
 * önerdiği etkin buluşmalar iptal edilir (ETA'sı alıcılarda kalmaz). Sonra yalnızca koruyucu çağrılar çalışır.
 */
export async function consentWithdraw(ctx: CallCtx, data: z.output<typeof ConsentWithdrawSchema>, deps: AccessDeps = {}): Promise<ConsentWithdrawResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  let endedLinks: LinkShareDoc[] = [];
  const response = await runOp(ctx, data.op_id, CALLABLES.consentWithdraw, data, async (tx) => {
    endedLinks = [];
    const me = await readCaller(tx, ctx.uid, { consent: false });
    const out = await readOutgoingActive(tx, ctx.uid);
    const recRef = me.consent?.version ? refs.consent(ctx.uid, me.consent.version) : null;
    const recSnap = recRef ? await tx.get(recRef) : null;
    const sos = await readActiveSosOf(tx, ctx.uid);
    const [notes, meetups] = await Promise.all([
      tx.get(db().collection(COL.placeNotes).where('owner_id', '==', ctx.uid)),
      tx.get(db().collection(COL.meetups).where('from', '==', ctx.uid)),
    ]);
    // --- yazmalar ---
    const ended = endOutgoing(tx, out, now);
    endedLinks = ended.links;
    const resolved = sos.map((d) => writeSosResolved(tx, d, now));
    for (const d of notes.docs) if ((d.data() as PlaceNoteDoc).owner_id === ctx.uid) tx.delete(d.ref);
    for (const d of meetups.docs) {
      const m = d.data() as MeetupDoc;
      if (m.from === ctx.uid && isMeetupActive(m, now)) tx.update(d.ref, { status: 'cancelled', updated_at: now });
    }
    if (recRef && recSnap?.exists) tx.update(recRef, { withdrawn_at: now });
    tx.update(refs.user(ctx.uid), { consent: null });
    const r: ConsentWithdrawResponse = { consent: null, shares_ended: ended.shares.length, links_ended: ended.links.length, server_now: now };
    return {
      response: r,
      shareEffects: ended.shares,
      after: resolved.length
        ? async () => {
            await Promise.all(resolved.map((a) => pushSosResolved(a, send, 'consent_withdraw')));
          }
        : undefined,
    };
  });
  await applyEndedLinks(CALLABLES.consentWithdraw, endedLinks);
  return response;
}
