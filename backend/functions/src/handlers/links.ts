/**
 * Faz 2: bağlantı (QR) ile paylaşım: link_share_create, link_share_extend, link_share_stop ve toplu bitirme.
 *
 * Kurallar:
 *  - Token SUNUCUDA üretilir: `crypto.randomBytes(32)` → base64url (43 karakter, 256 bit). Firestore'a, `ops`
 *    kaydına ve loglara YALNIZCA `token_hash` = sha256Hex(token) yazılır. Düz token ve URL yalnızca o çağrının
 *    yanıtında bir kez döner; gönderen cihaz güvenli depoda tutar.
 *  - Yanıtı kaybolan oluşturma (aynı `op_id` ile tekrar): düz token saklanmadığı için aynı token yeniden
 *    verilemez. Bağlantı hâlâ aktifse TOKEN YENİLENİR: yeni rastgele token, yeni `token_hash`, `version + 1`;
 *    eski özetin ACL'si mezar taşı olur ve eski `link_live` silinir. Eski token'ı kimse görmemiştir (yanıt
 *    istemciye ulaşmadı), bu yüzden kimse kesintiye uğramaz. [Varsayım] Bağlantı bitmişse `share_not_active`
 *    (istemci yeni `op_id` ile yeniden oluşturur).
 *  - Süre Faz 1 motoruyla SUNUCUDA çözülür (`resolveDuration`); uzatma Faz 1 kuralıyla (`extendExpiry`):
 *    yeni bitiş = max(bitiş, şimdi) + 30/60 dk, en çok şimdi + 7 gün.
 *  - Kullanıcı başına aynı anda en çok `LINK_LIMITS.maxActivePerUser` aktif bağlantı (`link_limit_reached`) ve
 *    saatte `LIMITS.linkCreatePerHour` oluşturma (`rate_limited`). Sayım transaction içindedir; aynı
 *    `rate_limits` belgesi eşzamanlı oluşturmaları sıraya sokar.
 *  - Var olmayan ve başkasına ait bağlantı AYNI yanıtı alır (`link_not_found`): kimlik taraması yok.
 *  - Durdurma sırası: Firestore commit → `link_acl` mezar taşı → `link_live` silme; hepsi callable dönmeden.
 */
import { randomBytes } from 'node:crypto';
import {
  CALLABLES,
  type CallableName,
  type EpochMs,
  HOUR,
  LINK_LIMITS,
  LINK_TOKEN_BYTES,
  type LinkEndReason,
  type LinkShareCreateRequestSchema,
  type LinkShareCreateResponse,
  type LinkShareExtendRequestSchema,
  type LinkShareStopRequestSchema,
  type LinkShareUpdateResponse,
  buildLinkUrl,
  canExtend,
  encodeLinkToken,
  extendExpiry,
  isInvisible,
  linkTokenHash,
} from '@konum/core';
import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS, linkDomain } from '../config';
import { COL, type LinkShareDoc, endedLink, linkEndFields, refs, toLinkView } from '../docs';
import { fail } from '../errors';
import { readCaller } from '../graph';
import {
  type LinkAclSource,
  applyLinkEffects,
  closeLinkHash,
  reapplyLinkEffects,
  writeLinkAclPending,
} from '../linkAcl';
import { readRateLimit, requestHash, writeRateLimit } from '../ops';
import { scheduleLinkExpiryTasks } from '../tasks';
import { chunk, newSessionId, resolveForZone, unique } from '../util';

/** Sunucu token'ı: 32 bayt kriptografik rastgele → base64url. */
export const newLinkToken = (): string => encodeLinkToken(new Uint8Array(randomBytes(LINK_TOKEN_BYTES)));

// ---------------------------------------------------------------------------
// Tekilleştirme (ops.ts `runOp` ile aynı kayıt, bağlantı yan etkileriyle)
// ---------------------------------------------------------------------------

interface LinkOpRecord {
  uid: string;
  op: CallableName;
  req_hash: string;
  /** Saklanan yanıt: oluşturmada `token` ve `url` YOK (`token_omitted: true`). */
  response: unknown;
  link_ids: string[];
  created_at: EpochMs;
  updated_at?: EpochMs;
  purge_at: Timestamp;
}

interface LinkOpOutcome<R> {
  response: R;
  /** `ops` kaydına yazılacak yanıt (verilmezse `response`). */
  stored?: unknown;
  effects: LinkShareDoc[];
  /** Commit sonrası kapatılacak eski token özetleri (token yenileme). */
  closeHashes?: { hash: string; version: number }[];
}

/**
 * `body` / `onReplay` Firestore transaction'ı içinde çalışır (önce okumalar, sonra yazmalar). `onReplay` null
 * dönerse saklanan yanıt aynen döner ve güncel belgeler yeniden uygulanır.
 */
async function runLinkOp<R>(
  ctx: CallCtx,
  opId: string,
  op: CallableName,
  input: unknown,
  body: (tx: Transaction) => Promise<LinkOpOutcome<R>>,
  onReplay?: (tx: Transaction, rec: LinkOpRecord) => Promise<LinkOpOutcome<R> | null>,
): Promise<R> {
  const opRef = refs.op(ctx.uid, opId);
  const reqHash = requestHash(op, input);
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    let r: LinkOpOutcome<R>;
    if (snap.exists) {
      const rec = snap.data() as LinkOpRecord;
      if (rec.op !== op || (rec.req_hash !== undefined && rec.req_hash !== reqHash)) {
        throw fail('invalid_argument', { message: 'Bu op_id başka bir istekle kullanılmış', extra: { field: 'op_id' } });
      }
      const again = onReplay ? await onReplay(tx, rec) : null;
      if (!again) return { replayed: true as const, response: rec.response as R, linkIds: rec.link_ids ?? [] };
      r = again;
      tx.update(opRef, { response: r.stored ?? r.response, updated_at: ctx.now });
    } else {
      r = await body(tx);
      const rec: LinkOpRecord = {
        uid: ctx.uid,
        op,
        req_hash: reqHash,
        response: r.stored ?? r.response,
        link_ids: unique(r.effects.map((e) => e.link_id)),
        created_at: ctx.now,
        purge_at: Timestamp.fromMillis(ctx.now + LIMITS.opRecordTtlMs),
      };
      tx.set(opRef, rec);
    }
    // Her işlem tek bağlantıya dokunur: bağlantı başına tek işaret (eski özet varsa işarette taşınır).
    const staleHash = r.closeHashes?.[0]?.hash;
    for (const e of r.effects) writeLinkAclPending(tx, e, ctx.now, staleHash);
    return { replayed: false as const, response: r.response, effects: r.effects, closeHashes: r.closeHashes ?? [] };
  });

  try {
    if (out.replayed) {
      await reapplyLinkEffects(out.linkIds);
    } else {
      for (const c of out.closeHashes) await closeLinkHash(c.hash, c.version, 'stopped_by_sender', ctx.now);
      await applyLinkEffects(out.effects);
    }
  } catch (err) {
    // Firestore commit oldu, ayna yazılamadı: istemci aynı op_id ile tekrar desin; işaret kalır, bakım onarır.
    logger.error(`${op}: commit sonrası bağlantı aynası hatası`, { err: String(err) });
    throw fail('unavailable');
  }
  if (!out.replayed) await scheduleLinkExpiryTasks(out.effects);
  return out.response;
}

/** `ops` kaydındaki oluşturma yanıtı: düz token ve URL olmadan. */
function storedCreate(l: LinkShareDoc, now: EpochMs) {
  return { ...toLinkView(l), server_now: now, token_omitted: true };
}

function createResponse(l: LinkShareDoc, token: string, now: EpochMs): LinkShareCreateResponse {
  return { ...toLinkView(l), token, url: buildLinkUrl(linkDomain(), token), server_now: now };
}

const isLive = (l: Pick<LinkShareDoc, 'status' | 'expires_at'>, now: EpochMs): boolean =>
  l.status === 'active' && (l.expires_at === null || l.expires_at > now);

// ---------------------------------------------------------------------------
// link_share_create
// ---------------------------------------------------------------------------

export async function linkShareCreate(
  ctx: CallCtx,
  data: z.output<typeof LinkShareCreateRequestSchema>,
): Promise<LinkShareCreateResponse> {
  const resolved = resolveForZone(data.duration, data.time_zone, ctx.now);

  return runLinkOp<LinkShareCreateResponse>(
    ctx,
    data.op_id,
    CALLABLES.linkShareCreate,
    data,
    async (tx) => {
      const rate = await readRateLimit(tx, ctx.uid, 'link_create', LIMITS.linkCreatePerHour, HOUR, ctx.now);
      const me = await readCaller(tx, ctx.uid); // profil yoksa / hesap siliniyorsa / onay yoksa yeni bağlantı yok
      if (isInvisible(me)) throw fail('invisible_mode'); // Faz 8: görünmezken QR bağlantısı da açılmaz
      const mine = await tx.get(db().collection(COL.linkShares).where('sender_id', '==', ctx.uid).where('status', '==', 'active'));
      const active = mine.docs.map((d) => d.data() as LinkShareDoc).filter((l) => isLive(l, ctx.now));
      if (active.length >= LINK_LIMITS.maxActivePerUser) {
        throw fail('link_limit_reached', { extra: { max_active: LINK_LIMITS.maxActivePerUser } });
      }

      // --- yazmalar ---
      writeRateLimit(tx, rate, HOUR);
      const ref = refs.newLinkShare();
      const token = newLinkToken();
      const doc: LinkShareDoc = {
        link_id: ref.id,
        session_id: newSessionId(),
        audience: 'link',
        sender_id: ctx.uid,
        token_hash: linkTokenHash(token),
        status: 'active',
        share_mode: resolved.share_mode,
        started_at: ctx.now,
        expires_at: resolved.expires_at,
        ended_at: null,
        end_reason: null,
        version: 1,
        extended_count: 0,
        updated_at: ctx.now,
        purge_at: null,
      };
      tx.create(ref, doc);
      return { response: createResponse(doc, token, ctx.now), stored: storedCreate(doc, ctx.now), effects: [doc] };
    },
    // Yanıtı kaybolan tekrar: token yenilenir (düz token saklanmadığı için aynısı verilemez).
    async (tx, rec) => {
      const linkId = rec.link_ids?.[0];
      if (!linkId) throw fail('internal');
      const snap = await tx.get(refs.linkShare(linkId));
      const cur = snap.data() as LinkShareDoc | undefined;
      if (!cur || cur.sender_id !== ctx.uid || !isLive(cur, ctx.now)) throw fail('share_not_active');
      const token = newLinkToken();
      const next: LinkShareDoc = { ...cur, token_hash: linkTokenHash(token), version: cur.version + 1, updated_at: ctx.now };
      tx.update(snap.ref, { token_hash: next.token_hash, version: next.version, updated_at: next.updated_at });
      return {
        response: createResponse(next, token, ctx.now),
        stored: storedCreate(next, ctx.now),
        effects: [next],
        closeHashes: [{ hash: cur.token_hash, version: next.version }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// link_share_extend (+30 dk / +1 saat)
// ---------------------------------------------------------------------------

/** Gönderenin kendi bağlantısı; yok ya da başkasınınsa AYNI hata. */
async function readOwnLink(tx: Transaction, uid: string, linkId: string): Promise<LinkShareDoc> {
  const snap = await tx.get(refs.linkShare(linkId));
  const cur = snap.data() as LinkShareDoc | undefined;
  if (!cur || cur.sender_id !== uid) throw fail('link_not_found');
  return cur;
}

export async function linkShareExtend(
  ctx: CallCtx,
  data: z.output<typeof LinkShareExtendRequestSchema>,
): Promise<LinkShareUpdateResponse> {
  return runLinkOp<LinkShareUpdateResponse>(ctx, data.op_id, CALLABLES.linkShareExtend, data, async (tx) => {
    // Faz 8: görünmezken uzatma yok (§1.4); demo ile aynı sıra (sahiplik denetiminden önce).
    const me = await readCaller(tx, ctx.uid);
    if (isInvisible(me)) throw fail('invisible_mode');
    const cur = await readOwnLink(tx, ctx.uid, data.link_id);
    if (cur.status !== 'active') throw fail('share_not_active');
    if (!canExtend(cur, ctx.now)) {
      if (cur.expires_at !== null && cur.expires_at <= ctx.now) throw fail('already_expired');
      throw fail('invalid_duration', { message: 'Süresiz paylaşım uzatılamaz' });
    }
    const r = extendExpiry(cur, data.minutes, ctx.now);
    const next: LinkShareDoc = {
      ...cur,
      share_mode: r.share_mode,
      expires_at: r.expires_at,
      version: cur.version + 1,
      extended_count: cur.extended_count + 1,
      updated_at: ctx.now,
    };
    tx.update(refs.linkShare(cur.link_id), {
      share_mode: next.share_mode,
      expires_at: next.expires_at,
      version: next.version,
      extended_count: next.extended_count,
      updated_at: next.updated_at,
    });
    return { response: { ...toLinkView(next), server_now: ctx.now }, effects: [next] };
  });
}

// ---------------------------------------------------------------------------
// link_share_stop ("Paylaşımı Durdur")
// ---------------------------------------------------------------------------

export async function linkShareStop(
  ctx: CallCtx,
  data: z.output<typeof LinkShareStopRequestSchema>,
): Promise<LinkShareUpdateResponse> {
  return runLinkOp<LinkShareUpdateResponse>(ctx, data.op_id, CALLABLES.linkShareStop, data, async (tx) => {
    const cur = await readOwnLink(tx, ctx.uid, data.link_id);
    // Süresi dolmuş ama taranmamış: neden "expired" kalır (doğru metin için).
    const reason: LinkEndReason = cur.expires_at !== null && cur.expires_at <= ctx.now ? 'expired' : 'stopped_by_sender';
    const e = endedLink(cur, reason, ctx.now);
    if (e) tx.update(refs.linkShare(cur.link_id), linkEndFields(e));
    const after = e ?? cur;
    // Zaten bitmişse de yeniden uygulanır (idempotent): kalan ACL / canlı kopya kapanır.
    return { response: { ...toLinkView(after), server_now: ctx.now }, effects: [after] };
  });
}

// ---------------------------------------------------------------------------
// Toplu bitirme (süre dolumu görevi ve taraması, hesap silme)
// ---------------------------------------------------------------------------

/**
 * Her parça transaction içinde YENİDEN OKUNARAK bitirilir: sorgu ile commit arasında uzatılan bağlantı
 * yanlışlıkla bitirilmez. Bitirmeyle aynı transaction'da işaret yazılır.
 */
export async function endLinksById(
  ids: readonly string[],
  decide: (l: LinkShareDoc) => LinkEndReason | null,
  now: EpochMs,
  chunkSize = 100,
): Promise<LinkShareDoc[]> {
  const out: LinkShareDoc[] = [];
  for (const part of chunk(unique(ids), chunkSize)) {
    const ended = await db().runTransaction(async (tx) => {
      const snaps = await tx.getAll(...part.map((id) => refs.linkShare(id)));
      const res: LinkShareDoc[] = [];
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const l = snap.data() as LinkShareDoc;
        const reason = decide(l);
        if (!reason) continue;
        const e = endedLink(l, reason, now);
        if (!e) continue;
        tx.update(snap.ref, linkEndFields(e));
        writeLinkAclPending(tx, e, now);
        res.push(e);
      }
      return res;
    });
    out.push(...ended);
  }
  return out;
}

/** Kullanıcının aktif bağlantılarının kimlikleri. */
export async function activeLinkIdsOf(uid: string): Promise<string[]> {
  const snap = await db().collection(COL.linkShares).where('sender_id', '==', uid).where('status', '==', 'active').get();
  return snap.docs.map((d) => d.id);
}

/** Bakım ve testler: süresi dolmuş aktif bağlantıları `expired` ile bitirir ve aynayı uygular. */
export async function sweepExpiredLinks(
  now: EpochMs,
  batchSize: number = LIMITS.sweepBatchSize,
  maxBatches: number = LIMITS.sweepMaxBatches,
): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < maxBatches; i++) {
    const snap = await db()
      .collection(COL.linkShares)
      .where('status', '==', 'active')
      .where('expires_at', '<=', now)
      .orderBy('expires_at')
      .limit(batchSize)
      .get();
    if (snap.empty) break;
    const ended = await endLinksById(
      snap.docs.map((d) => d.id),
      (l) => (l.status === 'active' && l.expires_at !== null && l.expires_at <= now ? 'expired' : null),
      now,
      batchSize,
    );
    done.push(...ended.map((e) => e.link_id));
    try {
      await applyLinkEffects(ended);
    } catch (err) {
      logger.error('tarama: bağlantı ACL aynası uygulanamadı', { err: String(err) });
    }
    if (snap.size < batchSize || ended.length === 0) break;
  }
  return done;
}

// ---------------------------------------------------------------------------
// Süre dolumu görevi (Cloud Tasks, aynı kuyruk)
// ---------------------------------------------------------------------------

export type LinkExpiryTaskOutcome = 'expired' | 'stale_version' | 'not_active' | 'missing' | 'early';

/** `{link_id, version}` görevi: sürüm hâlâ geçerliyse bağlantıyı bitirir, mezar taşı yazar, `link_live`'ı siler. */
export async function handleLinkExpiryTask(
  data: { link_id: string; version: number },
  now: EpochMs = Date.now(),
): Promise<LinkExpiryTaskOutcome> {
  const snap = await refs.linkShare(data.link_id).get();
  if (!snap.exists) return 'missing';
  const l = snap.data() as LinkShareDoc;
  if (l.status !== 'active') {
    await applyLinkEffects([l]); // ayna ve canlı kopya kesin kapalı olsun (idempotent)
    return 'not_active';
  }
  if (l.version !== data.version || l.expires_at === null) return 'stale_version';
  let at = now;
  if (l.expires_at > at) {
    const wait = l.expires_at - at;
    if (wait > LIMITS.expiryTaskMaxEarlyWaitMs) return 'early';
    await new Promise((r) => setTimeout(r, wait + 5));
    at = Math.max(Date.now(), l.expires_at);
  }
  const ended = await endLinksById(
    [l.link_id],
    (d) => (d.status === 'active' && d.version === data.version && d.expires_at !== null && d.expires_at <= at ? 'expired' : null),
    at,
  );
  if (ended.length === 0) return 'stale_version';
  await applyLinkEffects(ended);
  return 'expired';
}

export type { LinkAclSource };
