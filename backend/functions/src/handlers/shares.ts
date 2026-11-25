/**
 * Paylaşım yaşam döngüsü: share_start, share_extend, share_stop, share_revoke.
 *
 * Kurallar:
 *  - Paylaşım belgesi yönlüdür ve çift başına tektir: `location_shares/{sender}_{receiver}`.
 *  - Her değişiklik `version + 1`; RTDB `share_acl` aynası bu sürümle eski yazmaları reddeder.
 *  - Arkadaş olmayan / engelli alıcı hata vermez, sessizce atlanır (nedeni söylenmez).
 *  - Süre her zaman SUNUCUDA hesaplanır; istemcinin önizlemesi bilgilendirme amaçlıdır.
 */
import {
  CALLABLES,
  type EpochMs,
  type ResolvedDuration,
  type ShareEndReason,
  type ShareExtendRequestSchema,
  type ShareExtendResponse,
  type ShareRevokeRequestSchema,
  type ShareStartRequestSchema,
  type ShareStartResponse,
  type ShareStopRequestSchema,
  type ShareStopResponse,
  type UserId,
  canExtend,
  extendExpiry,
  shareId,
} from '@konum/core';
import type { Transaction } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { type AclSource, readAclVersions } from '../acl';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { COL, type RequestDoc, type ShareDoc, endedShare, purgeAt, refs, toView } from '../docs';
import { fail } from '../errors';
import { type PairState, canShare, endFields, readCaller, readPairStates } from '../graph';
import { runOp } from '../ops';
import type { ShareRevokeResponse } from '../schemas';
import { assertDocId, assertUid, newSessionId, resolveForZone, unique } from '../util';

// ---------------------------------------------------------------------------
// Ortak: yeni aktif paylaşım belgesi
// ---------------------------------------------------------------------------

export interface StartCandidate {
  receiver_id: UserId;
  pair: PairState;
  existing: ShareDoc | null;
}

/** Transaction okuma aşaması: alıcı başına arkadaşlık, iki yönlü engel ve mevcut paylaşım. */
export async function readStartCandidates(tx: Transaction, sender: UserId, receivers: readonly UserId[]): Promise<StartCandidate[]> {
  if (receivers.length === 0) return [];
  const shareSnaps = await tx.getAll(...receivers.map((r) => refs.share(sender, r)));
  const pairs = await readPairStates(tx, sender, receivers);
  return receivers.map((receiver_id, i) => ({
    receiver_id,
    pair: pairs[i] as PairState,
    existing: shareSnaps[i]?.exists ? (shareSnaps[i]?.data() as ShareDoc) : null,
  }));
}

/**
 * Upsert edilecek aktif paylaşım. Sürüm = max(belge, ACL) + 1: belge TTL ile silinmiş olsa bile
 * aynadaki mezar taşı yeni "aç" yazısını reddetmez.
 */
export function buildActiveShare(
  sender: UserId,
  c: StartCandidate,
  resolved: ResolvedDuration,
  sessionId: string,
  now: EpochMs,
  aclVersion: number,
  inResponseTo: string | null,
): ShareDoc {
  const id = shareId(sender, c.receiver_id);
  return {
    share_id: id,
    session_id: sessionId,
    audience: 'friend',
    sender_id: sender,
    receiver_id: c.receiver_id,
    status: 'active',
    share_mode: resolved.share_mode,
    started_at: now,
    expires_at: resolved.expires_at,
    ended_at: null,
    end_reason: null,
    version: Math.max(c.existing?.version ?? 0, aclVersion) + 1,
    extended_count: 0,
    in_response_to: inResponseTo,
    updated_at: now,
    purge_at: null,
  };
}

/** Ortak başlatma adımının sonucu. */
export interface ShareStartWrite {
  session_id: string;
  started: ShareDoc[];
  /** `canShare` olmayan (arkadaş değil / engelli) adaylar. */
  skipped: UserId[];
}

/**
 * `share_start` ve Faz 6 widget hızlı paylaşımının (`widget_quick_share`, "started" dalı) ORTAK iç fonksiyonu:
 * okuma aşamasında `readStartCandidates` ile okunan adaylardan paylaşabilenlere yeni aktif paylaşım yazar (yeni
 * oturum kimliği), diğerlerini `skipped` olarak döndürür. Transaction YAZMA aşamasında çağrılır.
 */
export function writeShareStarts(
  tx: Transaction,
  sender: UserId,
  cands: readonly StartCandidate[],
  resolved: ResolvedDuration,
  now: EpochMs,
  aclVersions: ReadonlyMap<string, number>,
  inResponseTo: (receiver: UserId) => string | null = () => null,
): ShareStartWrite {
  const sessionId = newSessionId();
  const started: ShareDoc[] = [];
  const skipped: UserId[] = [];
  for (const c of cands) {
    if (!canShare(c.pair)) {
      skipped.push(c.receiver_id);
      continue;
    }
    const doc = buildActiveShare(sender, c, resolved, sessionId, now, aclVersions.get(shareId(sender, c.receiver_id)) ?? 0, inResponseTo(c.receiver_id));
    tx.set(refs.shareById(doc.share_id), doc);
    started.push(doc);
  }
  return { session_id: sessionId, started, skipped };
}

// ---------------------------------------------------------------------------
// share_start
// ---------------------------------------------------------------------------

export async function shareStart(ctx: CallCtx, data: z.output<typeof ShareStartRequestSchema>): Promise<ShareStartResponse> {
  const resolved = resolveForZone(data.duration, data.time_zone, ctx.now);
  if (data.in_response_to) assertDocId(data.in_response_to, 'in_response_to');
  for (const r of data.receiver_ids) assertUid(r, 'receiver_ids');
  const requested = unique(data.receiver_ids);
  const candidates = requested.filter((r) => r !== ctx.uid);
  const aclVersions = await readAclVersions(candidates.map((r) => shareId(ctx.uid, r)));

  return runOp(ctx, data.op_id, CALLABLES.shareStart, data, async (tx) => {
    // Profil yoksa / hesap siliniyorsa yeni paylaşım yok (silinen hesabın geçerli token'ıyla hayalet paylaşım).
    await readCaller(tx, ctx.uid);
    const cands = await readStartCandidates(tx, ctx.uid, candidates);

    // Bir konum isteğine yanıt olarak başlatıldıysa isteği de aynı transaction'da kapat.
    let request: RequestDoc | null = null;
    if (data.in_response_to) {
      const snap = await tx.get(refs.requestById(data.in_response_to));
      const r = snap.data() as RequestDoc | undefined;
      if (r && r.target_id === ctx.uid && r.status === 'pending' && r.expires_at > ctx.now) request = r;
    }

    // --- yazmalar ---
    const w = writeShareStarts(tx, ctx.uid, cands, resolved, ctx.now, aclVersions, (receiver) =>
      request && request.requester_id === receiver ? request.request_id : null,
    );
    const started = w.started;
    const skipped: UserId[] = [...requested.filter((r) => r === ctx.uid), ...w.skipped];
    if (request && started.some((s) => s.receiver_id === request.requester_id)) {
      tx.update(refs.requestById(request.request_id), {
        status: 'accepted',
        responded_at: ctx.now,
        share_id: shareId(ctx.uid, request.requester_id),
        updated_at: ctx.now,
        purge_at: purgeAt(ctx.now),
      });
    }

    const response: ShareStartResponse = {
      session_id: w.session_id,
      shares: started.map(toView),
      skipped_receiver_ids: skipped,
      server_now: ctx.now,
    };
    return { response, shareEffects: started };
  });
}

// ---------------------------------------------------------------------------
// share_extend
// ---------------------------------------------------------------------------

export async function shareExtend(ctx: CallCtx, data: z.output<typeof ShareExtendRequestSchema>): Promise<ShareExtendResponse> {
  return runOp(ctx, data.op_id, CALLABLES.shareExtend, data, async (tx) => {
    const snap = await tx.get(
      db().collection(COL.shares).where('sender_id', '==', ctx.uid).where('session_id', '==', data.session_id),
    );
    const active = snap.docs.map((d) => d.data() as ShareDoc).filter((s) => s.status === 'active');
    if (active.length === 0) throw fail('share_not_active');
    const extendable = active.filter((s) => canExtend(s, ctx.now));
    if (extendable.length === 0) {
      if (active.some((s) => s.expires_at !== null && s.expires_at <= ctx.now)) throw fail('already_expired');
      throw fail('invalid_duration', { message: 'Süresiz paylaşım uzatılamaz' });
    }

    const updated: ShareDoc[] = extendable.map((s) => {
      const r = extendExpiry(s, data.minutes, ctx.now);
      return {
        ...s,
        share_mode: r.share_mode,
        expires_at: r.expires_at,
        version: s.version + 1,
        extended_count: s.extended_count + 1,
        updated_at: ctx.now,
      };
    });
    for (const u of updated) {
      tx.update(refs.shareById(u.share_id), {
        share_mode: u.share_mode,
        expires_at: u.expires_at,
        version: u.version,
        extended_count: u.extended_count,
        updated_at: u.updated_at,
      });
    }
    const first = updated[0] as ShareDoc;
    const response: ShareExtendResponse = {
      session_id: data.session_id,
      shares: updated.map(toView),
      expires_at: Math.max(...updated.map((u) => u.expires_at as number)),
      share_mode: first.share_mode,
      server_now: ctx.now,
    };
    return { response, shareEffects: updated };
  });
}

// ---------------------------------------------------------------------------
// share_stop (gönderen)
// ---------------------------------------------------------------------------

export async function shareStop(ctx: CallCtx, data: z.output<typeof ShareStopRequestSchema>): Promise<ShareStopResponse> {
  return runOp(ctx, data.op_id, CALLABLES.shareStop, data, async (tx) => {
    const snap = await tx.get(
      db().collection(COL.shares).where('sender_id', '==', ctx.uid).where('session_id', '==', data.session_id),
    );
    const only = data.receiver_ids ? new Set(data.receiver_ids) : null;
    const targets = snap.docs.map((d) => d.data() as ShareDoc).filter((s) => !only || only.has(s.receiver_id));

    const after: ShareDoc[] = [];
    const ended: ShareDoc[] = [];
    for (const s of targets) {
      // Süresi zaten dolmuş ama taranmamış paylaşım: neden "expired" kalır (doğru metin için).
      const reason: ShareEndReason = s.expires_at !== null && s.expires_at <= ctx.now ? 'expired' : 'stopped_by_sender';
      const e = endedShare(s, reason, ctx.now);
      if (e) {
        tx.update(refs.shareById(s.share_id), endFields(e));
        ended.push(e);
        after.push(e);
      } else {
        after.push(s);
      }
    }
    const response: ShareStopResponse = { session_id: data.session_id, shares: after.map(toView), server_now: ctx.now };
    // Zaten bitmiş olanlar da yeniden uygulanır (idempotent): canlı kopya kaldıysa silinir.
    return { response, shareEffects: after };
  });
}

// ---------------------------------------------------------------------------
// share_revoke (alıcı): gönderen → ben paylaşımını kapatır
// ---------------------------------------------------------------------------

export async function shareRevoke(ctx: CallCtx, data: z.output<typeof ShareRevokeRequestSchema>): Promise<ShareRevokeResponse> {
  assertUid(data.sender_id, 'sender_id');
  if (data.sender_id === ctx.uid) throw fail('invalid_argument');
  const id = shareId(data.sender_id, ctx.uid);
  return runOp(ctx, data.op_id, CALLABLES.shareRevoke, data, async (tx) => {
    const snap = await tx.get(refs.shareById(id));
    const effects: AclSource[] = [];
    if (snap.exists) {
      const s = snap.data() as ShareDoc;
      const e = endedShare(s, 'revoked_by_receiver', ctx.now);
      if (e) tx.update(refs.shareById(id), endFields(e));
      effects.push(e ?? s);
    }
    // Paylaşım hiç yoksa da aynı yanıt: alıcı, gönderenin durumunu bu çağrıdan öğrenemez.
    const response: ShareRevokeResponse = { share_id: id, status: 'ended', server_now: ctx.now };
    return { response, shareEffects: effects };
  });
}

// Toplu bitirme (süre dolumu, hesap silme): bkz. ../lifecycle.ts
export { endSharesById } from '../lifecycle';
