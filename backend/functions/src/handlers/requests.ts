/**
 * Konum istekleri: location_request_send / location_request_respond.
 *
 *  - Çift başına tek kayıt: `location_requests/{requester}_{target}`; aynı anda bir bekleyen istek.
 *  - Aynı çift için iki istek arasında 10 dk, kullanıcı başına günde 30 istek. [Varsayım]
 *  - Yanıtlanmayan istek 15 dk sonra `expired` (süre dolumu taraması). [Varsayım]
 *  - Push yalnızca `{type: 'location_request', request_id}` taşır; koordinat yok.
 *  - Kabul: hedef → isteyen paylaşımı (varsayılan 1 saat) ve istek AYNI transaction'da güncellenir.
 *    Hedef isteyene zaten EN AZ o kadar süren (ya da süresiz) aktif bir paylaşım yapıyorsa paylaşıma dokunulmaz;
 *    daha kısaysa aynı oturumda daha geç bitişe uzatılır (oturum ve başlangıç korunur). Kabul asla kısaltmaz.
 *  - Faz 8: kabul, hedef → isteyen `location_view` iznini de AYNI transaction'da yazar (`via:'location_request'`);
 *    ters yön (isteyen → hedef) ASLA yazılmaz. Hedef görünmezse kabul `invisible_mode` (ret her zaman çalışır).
 */
import {
  CALLABLES,
  DAY,
  type EpochMs,
  type LocationRequestRespondSchema,
  type LocationRequestSendSchema,
  type ResolvedDuration,
  canShareLocation,
  emptyGrantDoc,
  hasGrant,
  isInvisible,
  requestId,
  shareId,
  withGranted,
} from '@konum/core';
import type { z } from 'zod';
import { readAclVersions } from '../acl';
import type { CallCtx } from '../callable';
import { DEFAULT_REQUEST_DURATION, DEFAULT_TIME_ZONE, LIMITS } from '../config';
import { type FriendshipDoc, type RequestDoc, type ShareDoc, purgeAt, refs, toView } from '../docs';
import { fail } from '../errors';
import { callerAccess, isFriend, pairInput, readCaller } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { buildLocationRequestPush, sendPushToUser } from '../push';
import type { LocationRequestRespondResponse, LocationRequestSendResponse } from '../schemas';
import { assertDocId, assertUid, isServerUid, newSessionId, resolveForZone } from '../util';
import { buildActiveShare, readStartCandidates } from './shares';

export async function locationRequestSend(
  ctx: CallCtx,
  data: z.output<typeof LocationRequestSendSchema>,
): Promise<LocationRequestSendResponse> {
  assertUid(data.target_id, 'target_id');
  if (data.target_id === ctx.uid) throw fail('invalid_argument');
  const id = requestId(ctx.uid, data.target_id);

  return runOp(ctx, data.op_id, CALLABLES.locationRequestSend, data, async (tx) => {
    await readCaller(tx, ctx.uid);
    const [fSnap, b1, b2, reqSnap] = await tx.getAll(
      refs.friendship(ctx.uid, data.target_id),
      refs.block(ctx.uid, data.target_id),
      refs.block(data.target_id, ctx.uid),
      refs.request(ctx.uid, data.target_id),
    );
    const friendship = fSnap?.exists ? (fSnap.data() as FriendshipDoc) : null;
    if (!isFriend({ friendship, blocked: Boolean(b1?.exists || b2?.exists) })) throw fail('not_friends');

    const existing = reqSnap?.exists ? (reqSnap.data() as RequestDoc) : null;
    if (existing && existing.status === 'pending' && existing.expires_at > ctx.now) {
      // Zaten bekleyen istek var: yeni push yok, aynı istek döner.
      const response: LocationRequestSendResponse = {
        request_id: id,
        status: 'pending',
        expires_at: existing.expires_at,
        server_now: ctx.now,
      };
      return { response };
    }
    if (existing && ctx.now - existing.created_at < LIMITS.locationRequestCooldownMs) {
      throw fail('rate_limited', {
        extra: { retry_after_ms: existing.created_at + LIMITS.locationRequestCooldownMs - ctx.now },
      });
    }
    const rl = await readRateLimit(tx, ctx.uid, 'location_request', LIMITS.locationRequestPerDay, DAY, ctx.now);

    // --- yazmalar ---
    const doc: RequestDoc = {
      request_id: id,
      requester_id: ctx.uid,
      target_id: data.target_id,
      status: 'pending',
      created_at: ctx.now,
      expires_at: ctx.now + LIMITS.locationRequestTtlMs,
      responded_at: null,
      share_id: null,
      updated_at: ctx.now,
      purge_at: null,
    };
    tx.set(refs.requestById(id), doc);
    writeRateLimit(tx, rl, DAY);

    const requesterName = friendship?.member_profiles?.[ctx.uid]?.display_name ?? '';
    const response: LocationRequestSendResponse = {
      request_id: id,
      status: 'pending',
      expires_at: doc.expires_at,
      server_now: ctx.now,
    };
    return {
      response,
      after: async () => {
        await sendPushToUser(data.target_id, buildLocationRequestPush(requesterName, id));
      },
    };
  });
}

/** Aktif ve süresi dolmamış paylaşım `resolved` kadar (ya da daha uzun) sürüyor mu? */
function lastsAtLeast(s: ShareDoc, resolved: ResolvedDuration): boolean {
  if (s.expires_at === null) return true;
  if (resolved.expires_at === null) return false;
  return s.expires_at >= resolved.expires_at;
}

const isLive = (s: ShareDoc | null, now: EpochMs): s is ShareDoc =>
  Boolean(s && s.status === 'active' && (s.expires_at === null || s.expires_at > now));

export async function locationRequestRespond(
  ctx: CallCtx,
  data: z.output<typeof LocationRequestRespondSchema>,
): Promise<LocationRequestRespondResponse> {
  // request_id = {requester}_{target}; hedef ben olmalıyım.
  assertDocId(data.request_id, 'request_id');
  const suffix = `_${ctx.uid}`;
  const requester = data.request_id.endsWith(suffix) ? data.request_id.slice(0, -suffix.length) : '';
  if (!isServerUid(requester)) {
    throw fail('invalid_argument', { httpsCode: 'not-found', message: 'İstek bulunamadı' });
  }
  const resolved = data.accept
    ? resolveForZone(data.duration ?? DEFAULT_REQUEST_DURATION, data.time_zone ?? DEFAULT_TIME_ZONE, ctx.now)
    : null;
  const aclVersions = data.accept ? await readAclVersions([shareId(ctx.uid, requester)]) : new Map<string, number>();

  return runOp(ctx, data.op_id, CALLABLES.locationRequestRespond, data, async (tx) => {
    const reqRef = refs.requestById(data.request_id);
    const snap = await tx.get(reqRef);
    const req = snap.exists ? (snap.data() as RequestDoc) : null;
    if (!req || req.target_id !== ctx.uid || req.requester_id !== requester) {
      throw fail('invalid_argument', { httpsCode: 'not-found', message: 'İstek bulunamadı' });
    }
    if (req.status !== 'pending') {
      throw fail('invalid_argument', { httpsCode: 'failed-precondition', message: 'İstek artık geçerli değil', extra: { status: req.status } });
    }
    if (req.expires_at <= ctx.now) throw fail('already_expired', { message: 'İsteğin süresi doldu' });

    if (!data.accept || !resolved) {
      tx.update(reqRef, { status: 'declined', responded_at: ctx.now, updated_at: ctx.now, purge_at: purgeAt(ctx.now) });
      const response: LocationRequestRespondResponse = {
        request_id: req.request_id,
        status: 'declined',
        session_id: null,
        share: null,
        server_now: ctx.now,
      };
      return { response };
    }

    const me = await readCaller(tx, ctx.uid);
    if (isInvisible(me)) throw fail('invisible_mode');
    const [cand] = await readStartCandidates(tx, ctx.uid, [requester]);
    if (!cand || !isFriend(cand.pair)) throw fail('not_friends');

    // --- yazmalar: izin + paylaşım + istek tek transaction'da ---
    // Kabul = hedef (ben) → isteyen `location_view` izni. Ters yön yazılmaz.
    if (!hasGrant(cand.pair.grantOut, 'location_view')) {
      const grant = withGranted(cand.pair.grantOut ?? emptyGrantDoc(ctx.uid, requester, ctx.now), ['location_view'], 'location_request', ctx.now);
      tx.set(refs.grant(ctx.uid, requester), { ...grant, declined_at: {} });
      cand.pair.grantOut = grant;
    }
    if (!canShareLocation(pairInput(cand.pair, callerAccess(me)))) throw fail('not_permitted');
    const current = isLive(cand.existing, ctx.now) ? cand.existing : null;
    let share: ShareDoc;
    let changed = true;
    if (current && lastsAtLeast(current, resolved)) {
      // Zaten en az bu kadar paylaşılıyor: kabul paylaşımı kısaltmaz, oturumu da değiştirmez.
      share = current;
      changed = false;
    } else if (current) {
      // Daha kısa aktif paylaşım: aynı oturumda daha geç bitişe uzat.
      share = {
        ...current,
        share_mode: resolved.share_mode,
        expires_at: resolved.expires_at,
        version: current.version + 1,
        updated_at: ctx.now,
        in_response_to: req.request_id,
      };
      tx.update(refs.shareById(share.share_id), {
        share_mode: share.share_mode,
        expires_at: share.expires_at,
        version: share.version,
        updated_at: share.updated_at,
        in_response_to: share.in_response_to,
      });
    } else {
      share = buildActiveShare(
        ctx.uid,
        cand,
        resolved,
        newSessionId(),
        ctx.now,
        aclVersions.get(shareId(ctx.uid, requester)) ?? 0,
        req.request_id,
      );
      tx.set(refs.shareById(share.share_id), share);
    }
    tx.update(reqRef, {
      status: 'accepted',
      responded_at: ctx.now,
      share_id: share.share_id,
      updated_at: ctx.now,
      purge_at: purgeAt(ctx.now),
    });
    const response: LocationRequestRespondResponse = {
      request_id: req.request_id,
      status: 'accepted',
      session_id: share.session_id,
      share: toView(share),
      server_now: ctx.now,
    };
    return { response, shareEffects: changed ? [share] : [] };
  });
}
