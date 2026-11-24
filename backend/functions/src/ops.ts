/**
 * Tekilleştirme (idempotency) ve hız sınırı.
 *
 * Her komut `op_id` (UUID v4) taşır. İlk başarılı çalıştırmanın yanıtı `ops/{uid}_{op_id}` belgesine,
 * durum değişikliğiyle AYNI Firestore transaction'ında yazılır: ya ikisi birden olur ya hiçbiri.
 * Aynı `op_id` ile gelen tekrar, saklanan yanıtı döndürür ve işlemi ikinci kez uygulamaz.
 * Kayıt isteğin kanonik özetini (`req_hash`) da tutar: aynı op_id BAŞKA bir istekle gelirse sessizce eski yanıt
 * dönmez, `invalid_argument` verilir (istemci hatası görünür olsun).
 *
 * Paylaşım değişiklikleri (`shareEffects`) aynı transaction'da `acl_pending` işareti bırakır; commit sonrası
 * ayna uygulanınca işaret silinir. Ayna başarısız olursa işaret kalır ve bakım işi onarır.
 */
import type { CallableName, EpochMs, UserId } from '@konum/core';
import { type Transaction, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { type AclSource, applyShareEffects, reapplyShareEffects, writeAclPending } from './acl';
import { db } from './admin';
import type { CallCtx } from './callable';
import { LIMITS } from './config';
import { refs } from './docs';
import { fail } from './errors';
import { scheduleExpiryTasks } from './tasks';
import { canonicalJson, sha256Hex } from './util';

export interface OpOutcome<R> {
  response: R;
  /** Commit sonrası RTDB'ye yansıtılacak paylaşımların yeni hâli. */
  shareEffects?: AclSource[];
  /** Commit sonrası, yalnızca ilk çalıştırmada, en iyi çabayla (ör. push). */
  after?: () => Promise<void>;
}

/** core callable adları (Faz 3 `battery_low_notify` dahil). */
export type OpName = CallableName;

interface OpRecord {
  uid: UserId;
  op: OpName;
  req_hash: string;
  response: unknown;
  share_ids: string[];
  created_at: EpochMs;
  purge_at: Timestamp;
}

/** `op_id` alanı hariç doğrulanmış isteğin özeti. */
export function requestHash(op: OpName, input: unknown): string {
  const { op_id: _omit, ...rest } = (input ?? {}) as Record<string, unknown>;
  return sha256Hex(`${op}:${canonicalJson(rest)}`);
}

/**
 * `body` bir Firestore transaction'ı içinde çalışır: ÖNCE tüm okumalar, SONRA yazmalar.
 * Transaction yeniden denenebilir; `body` transaction dışına yan etki yapmamalıdır.
 */
export async function runOp<R>(
  ctx: CallCtx,
  opId: string,
  op: OpName,
  input: unknown,
  body: (tx: Transaction) => Promise<OpOutcome<R>>,
): Promise<R> {
  const opRef = refs.op(ctx.uid, opId);
  const reqHash = requestHash(op, input);
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    if (snap.exists) {
      const rec = snap.data() as OpRecord;
      if (rec.op !== op || (rec.req_hash !== undefined && rec.req_hash !== reqHash)) {
        throw fail('invalid_argument', { message: 'Bu op_id başka bir istekle kullanılmış', extra: { field: 'op_id' } });
      }
      return { replayed: true as const, response: rec.response as R, shareIds: rec.share_ids ?? [] };
    }
    const r = await body(tx);
    const effects = r.shareEffects ?? [];
    for (const s of effects) writeAclPending(tx, s, ctx.now);
    const rec: OpRecord = {
      uid: ctx.uid,
      op,
      req_hash: reqHash,
      response: r.response,
      share_ids: effects.map((s) => s.share_id),
      created_at: ctx.now,
      purge_at: Timestamp.fromMillis(ctx.now + LIMITS.opRecordTtlMs),
    };
    tx.set(opRef, rec);
    return { replayed: false as const, response: r.response, effects, after: r.after };
  });

  try {
    if (out.replayed) await reapplyShareEffects(out.shareIds);
    else await applyShareEffects(out.effects);
  } catch (err) {
    // Firestore commit oldu, ayna yazılamadı: istemci aynı op_id ile tekrar desin; acl_pending işareti kalır.
    logger.error(`${op}: commit sonrası ayna hatası`, { err: String(err) });
    throw fail('unavailable');
  }

  if (!out.replayed) {
    // Süre dolumunda son paketi silecek görevler (en iyi çaba; dakikalık tarama yedektir).
    await scheduleExpiryTasks(out.effects);
    if (out.after) {
      try {
        await out.after();
      } catch (err) {
        logger.warn(`${op}: commit sonrası en iyi çaba adımı başarısız`, { err: String(err) });
      }
    }
  }
  return out.response;
}

// ---------------------------------------------------------------------------
// Hız sınırı: sabit pencere sayacı `rate_limits/{uid}_{key}` (istemciye kapalı).
// Transaction içinde: `readRateLimit` okuma aşamasında, `writeRateLimit` yazma aşamasında.
// ---------------------------------------------------------------------------

export interface RateLimitState {
  ref: FirebaseFirestore.DocumentReference;
  window_start: EpochMs;
  count: number;
}

export async function readRateLimit(
  tx: Transaction,
  uid: UserId,
  key: string,
  limit: number,
  windowMs: number,
  now: EpochMs,
): Promise<RateLimitState> {
  const ref = refs.rateLimit(uid, key);
  const snap = await tx.get(ref);
  const d = snap.data() as { window_start?: number; count?: number } | undefined;
  const inWindow = d?.window_start !== undefined && now - d.window_start < windowMs;
  const state: RateLimitState = {
    ref,
    window_start: inWindow ? (d.window_start as number) : now,
    count: inWindow ? (d.count ?? 0) : 0,
  };
  if (state.count >= limit) {
    throw fail('rate_limited', { extra: { retry_after_ms: state.window_start + windowMs - now } });
  }
  return state;
}

export function writeRateLimit(tx: Transaction, s: RateLimitState, windowMs: number): void {
  tx.set(s.ref, {
    window_start: s.window_start,
    count: s.count + 1,
    purge_at: Timestamp.fromMillis(s.window_start + windowMs + LIMITS.opRecordTtlMs),
  });
}
