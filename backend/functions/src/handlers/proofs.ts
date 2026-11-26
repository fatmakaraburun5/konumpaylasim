/**
 * Faz 9: tek kullanımlık anlık fotoğraf ispatı (docs/PHASE9.md §1, core `proof.ts`).
 *
 * Callable'lar: `proof_create`, `proof_get` (okuma; op_id yok), `proof_delete` (onaydan muaf).
 *
 *  - YALNIZCA KAMERA: şema `source: 'camera'` ister; sunucu çekimin taze olmasını şart koşar (`isFreshCapture`, en çok
 *    2 dk önce) → `proof_stale_capture`. JPEG imzası + SOF boyutu = beyan, ≤ 1600 px, ≤ 600 KB; APPn / COM (EXIF, GPS)
 *    atılır (`validateProofJpeg`) → bozuksa `proof_invalid` (`extra.reason`). Görünmezken `invisible_mode`.
 *  - Bayt Storage `proofs/{uid}/{proof_id}.jpg` nesnesindedir (İSTEMCİYE TAMAMEN KAPALI; indirme token'ı yok). Kayıt
 *    Firestore `photo_proofs/{proof_id}` (istemciye kapalı). Nesne transaction'dan ÖNCE yüklenir; transaction düşerse
 *    silinir (aynı op_id tekrarında yükleme yapılmaz).
 *  - Kullanıcı başına 1 etkin fotoğraf: yenisi eskisini `replaced` ile bitirir ve eski nesne hemen silinir. Günde 30
 *    (`proof_limit_reached`).
 *  - `proof_get`: bayt yalnızca core `canViewProof` izin verirse gelir: sahibi ya da sahibinden ŞU AN etkin canlı
 *    paylaşım alan kişi (paylaşım Faz 8 `location_view` iziyle açılır; izin geri alınınca / engelde biter) ve sahibi
 *    görünmez değil. Erişimi olmayan `proof_not_found` (varlık sızmaz), süresi dolan `proof_expired`.
 *  - Silme zinciri (1 sa): Cloud Tasks `{proof_id}` görevi `expires_at` anında (`handleProofExpiryTask`), dakikalık
 *    süpürücü yedeği (`sweepExpiredProofs`: süresi dolan etkinler + silinememiş nesneler), Firestore TTL `purge_at`
 *    (= bitiş + 1 gün), Storage yaşam döngüsü (`backend/storage.lifecycle.json`, `proofs/` ≥ 1 gün). Erken bitiş:
 *    `proof_delete`, yeni fotoğraf, görünmez ol (access.ts), açık rızayı geri çek (access.ts), hesap silme (user.ts).
 */
import { randomBytes } from 'node:crypto';
import {
  CALLABLES,
  DAY,
  HOUR,
  PATHS,
  PROOF_LIMITS,
  type EpochMs,
  type ProofCreateRequestSchema,
  type ProofCreateResponse,
  type ProofDeleteRequestSchema,
  type ProofDeleteResponse,
  type ProofEndReason,
  type ProofGetRequestSchema,
  type ProofGetResponse,
  type UserId,
  canViewProof,
  isFreshCapture,
  isInvisible,
  proofExpiresAt,
  roundCoord,
  sanitizeProofCaption,
  toProofView,
  validateProofJpeg,
} from '@konum/core';
import { HttpsError } from 'firebase-functions/https';
import { type Transaction, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { adminStorage, db } from '../admin';
import type { CallCtx } from '../callable';
import { IS_EMULATOR, IS_LOCAL_TEST, LIMITS, avatarBuckets, projectId } from '../config';
import { COL, type PhotoProofDoc, type ShareDoc, type UserDoc, refs } from '../docs';
import { fail } from '../errors';
import { readCaller } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { scheduleProofExpiryTask } from '../tasks';

/** `proof_get` kullanıcı başına saatlik üst sınır (tam boy görüntüleyici + küçük resim yenilemeleri). [Varsayım] */
export const PROOF_GET_PER_HOUR = 240;

/** 20 karakter base64url (core `PROOF_ID_RE`; paket kuralı da bu biçimi ister). */
export const newProofId = (): string => randomBytes(15).toString('base64url');

/** Fotoğrafların kovası: FIREBASE_CONFIG.storageBucket ya da projenin varsayılanı. Belgeye yazılır (okuma/silme aynı kova). */
export function proofBucket(): string {
  return avatarBuckets()[0] ?? `${projectId()}.firebasestorage.app`;
}

const proofPurgeAt = (expiresAt: EpochMs): Timestamp => Timestamp.fromMillis(expiresAt + PROOF_LIMITS.purgeAfterMs);

const fileOf = (d: Pick<PhotoProofDoc, 'storage_bucket' | 'storage_path'>) => adminStorage().bucket(d.storage_bucket).file(d.storage_path);

async function putProofObject(bucket: string, path: string, bytes: Uint8Array): Promise<void> {
  try {
    await adminStorage()
      .bucket(bucket)
      .file(path)
      .save(Buffer.from(bytes), { contentType: 'image/jpeg', resumable: false, metadata: { cacheControl: 'private, no-store' } });
  } catch (err) {
    logger.error('anlık fotoğraf yüklenemedi', { err: String(err) });
    throw fail('unavailable');
  }
}

/** Nesneyi siler ve belgeye `object_deleted` yazar. En iyi çaba: hata loglanır, süpürücü yeniden dener. */
export async function deleteProofObjects(docs: readonly Pick<PhotoProofDoc, 'proof_id' | 'storage_bucket' | 'storage_path'>[]): Promise<number> {
  let n = 0;
  await Promise.all(
    docs.map(async (d) => {
      try {
        await fileOf(d).delete({ ignoreNotFound: true });
        await refs
          .photoProof(d.proof_id)
          .update({ object_deleted: true })
          .catch((err: { code?: number }) => {
            if (err.code !== 5) throw err; // belge yoksa (hesap silme) önemsiz
          });
        n++;
      } catch (err) {
        logger.warn('anlık fotoğraf nesnesi silinemedi (süpürücü yeniden dener)', { proof_id: d.proof_id, err: String(err) });
      }
    }),
  );
  return n;
}

/** Okuma aşaması: kullanıcının etkin fotoğrafları (`(owner_id, state)` dizini). */
export async function readActiveProofsOf(tx: Transaction, uid: UserId): Promise<PhotoProofDoc[]> {
  const snap = await tx.get(db().collection(COL.photoProofs).where('owner_id', '==', uid).where('state', '==', 'active'));
  return snap.docs.map((d) => d.data() as PhotoProofDoc).filter((d) => d.owner_id === uid && d.state === 'active');
}

/** Yazma aşaması: fotoğrafları bitirir (nesne commit SONRASI `deleteProofObjects` ile silinir). */
export function writeEndProofs(tx: Transaction, docs: readonly PhotoProofDoc[], reason: ProofEndReason, now: EpochMs): PhotoProofDoc[] {
  const out: PhotoProofDoc[] = [];
  for (const d of docs) {
    if (d.state !== 'active') continue;
    // Süresi zaten dolmuşsa neden `expired` kalır (kayıt özetinde doğru görünsün).
    const why: ProofEndReason = d.expires_at <= now ? 'expired' : reason;
    tx.update(refs.photoProof(d.proof_id), { state: 'ended', end_reason: why, ended_at: now });
    out.push({ ...d, state: 'ended', end_reason: why, ended_at: now });
  }
  return out;
}

// ---------------------------------------------------------------------------
// proof_create
// ---------------------------------------------------------------------------

export async function proofCreate(ctx: CallCtx, data: z.output<typeof ProofCreateRequestSchema>): Promise<ProofCreateResponse> {
  const now = ctx.now;
  if (!isFreshCapture(data.captured_at, now)) throw fail('proof_stale_capture');
  const v = validateProofJpeg(data.jpeg_b64, { width: data.width, height: data.height });
  if (!v.ok) throw fail('proof_invalid', { extra: { reason: v.reason } });
  const caption = sanitizeProofCaption(data.caption);
  const position = data.position
    ? { lat: roundCoord(data.position.lat), lng: roundCoord(data.position.lng), accuracy: data.position.accuracy === null ? null : Math.round(data.position.accuracy) }
    : null;

  const id = newProofId();
  const bucket = proofBucket();
  const path = PATHS.proofObject(ctx.uid, id);
  // Aynı op_id tekrarı: saklanan yanıt döner, yeniden yükleme yok.
  const replay = (await refs.op(ctx.uid, data.op_id).get()).exists;
  if (!replay) await putProofObject(bucket, path, v.bytes);

  let replaced: PhotoProofDoc[] = [];
  try {
    const res = await runOp(ctx, data.op_id, CALLABLES.proofCreate, data, async (tx) => {
      replaced = [];
      const me = await readCaller(tx, ctx.uid);
      let rate;
      try {
        rate = await readRateLimit(tx, ctx.uid, 'proof_create', PROOF_LIMITS.perDay, DAY, now);
      } catch (err) {
        if (err instanceof HttpsError && (err.details as { code?: string } | undefined)?.code === 'rate_limited') {
          throw fail('proof_limit_reached', { extra: { retry_after_ms: (err.details as { retry_after_ms?: number }).retry_after_ms } });
        }
        throw err;
      }
      const active = await readActiveProofsOf(tx, ctx.uid);
      if (isInvisible(me)) throw fail('invisible_mode');
      // --- yazmalar ---
      replaced = writeEndProofs(tx, active, 'replaced', now);
      const expires_at = proofExpiresAt(now);
      const d: PhotoProofDoc = {
        proof_id: id,
        owner_id: ctx.uid,
        caption,
        source: 'camera',
        width: v.width,
        height: v.height,
        bytes: v.bytes.length,
        position,
        captured_at: Math.min(data.captured_at, now),
        created_at: now,
        expires_at,
        state: 'active',
        end_reason: null,
        ended_at: null,
        object_deleted: false,
        storage_path: path,
        storage_bucket: bucket,
        purge_at: proofPurgeAt(expires_at),
      };
      tx.set(refs.photoProof(id), d);
      writeRateLimit(tx, rate, DAY);
      const response: ProofCreateResponse = { proof: toProofView(d), replaced_proof_id: replaced[0]?.proof_id ?? null, server_now: now };
      return {
        response,
        after: async () => {
          await Promise.all([deleteProofObjects(replaced), scheduleProofExpiryTask({ proof_id: id, expires_at })]);
        },
      };
    });
    // Eşzamanlı aynı op_id: başka bir çağrının yanıtı döndüyse bizim yüklediğimiz nesne artık sahipsiz.
    if (!replay && res.proof.proof_id !== id) await deleteProofObjects([{ proof_id: id, storage_bucket: bucket, storage_path: path }]);
    return res;
  } catch (err) {
    // Kayıt yazılmadıysa (sınır, onay, görünmez, yarış) yüklenen nesne sahipsiz kalmasın.
    if (!replay) {
      const committed = await refs
        .photoProof(id)
        .get()
        .then((s) => s.exists)
        .catch(() => true);
      if (!committed) await fileOf({ storage_bucket: bucket, storage_path: path }).delete({ ignoreNotFound: true }).catch(() => undefined);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// proof_get
// ---------------------------------------------------------------------------

/** Sahibinden izleyiciye etkin (süresi dolmamış) canlı paylaşım var mı ve sahibi görünmez mi? */
async function viewerAccess(owner: UserId, viewer: UserId, now: EpochMs): Promise<{ share: boolean; ownerInvisible: boolean }> {
  const [shareSnap, ownerSnap] = await db().getAll(refs.share(owner, viewer), refs.user(owner));
  const s = shareSnap?.data() as ShareDoc | undefined;
  const u = ownerSnap?.data() as UserDoc | undefined;
  return {
    share: Boolean(s && s.sender_id === owner && s.receiver_id === viewer && s.status === 'active' && (s.expires_at === null || s.expires_at > now)),
    ownerInvisible: !u || Boolean(u.deleting) || isInvisible(u),
  };
}

export async function proofGet(ctx: CallCtx, data: z.output<typeof ProofGetRequestSchema>): Promise<ProofGetResponse> {
  const now = ctx.now;
  const raw = (await refs.photoProof(data.proof_id).get()).data() as PhotoProofDoc | undefined;
  const proof = raw && raw.owner_id === data.owner_id && raw.proof_id === data.proof_id ? raw : null;
  const acc = proof && proof.owner_id !== ctx.uid ? await viewerAccess(proof.owner_id, ctx.uid, now) : { share: false, ownerInvisible: false };
  const access = canViewProof({ proof, viewerId: ctx.uid, now, hasActiveShareFromOwner: acc.share, ownerInvisible: acc.ownerInvisible });
  if (access === 'not_found' || !proof) throw fail('proof_not_found');
  if (access === 'expired') throw fail('proof_expired');
  await db().runTransaction(async (tx) => {
    const rate = await readRateLimit(tx, ctx.uid, 'proof_get', PROOF_GET_PER_HOUR, HOUR, now);
    writeRateLimit(tx, rate, HOUR);
  });
  let bytes: Buffer;
  try {
    [bytes] = await fileOf(proof).download();
  } catch (err) {
    if ((err as { code?: number }).code === 404) throw fail('proof_expired');
    logger.error('anlık fotoğraf okunamadı', { err: String(err) });
    throw fail('unavailable');
  }
  return { proof: toProofView(proof), jpeg_b64: bytes.toString('base64'), server_now: now };
}

// ---------------------------------------------------------------------------
// proof_delete (onaydan muaf: kullanıcı kendi fotoğrafını her zaman kaldırır)
// ---------------------------------------------------------------------------

export async function proofDelete(ctx: CallCtx, data: z.output<typeof ProofDeleteRequestSchema>): Promise<ProofDeleteResponse> {
  const now = ctx.now;
  return runOp<ProofDeleteResponse>(ctx, data.op_id, CALLABLES.proofDelete, data, async (tx) => {
    const snap = await tx.get(refs.photoProof(data.proof_id));
    await readCaller(tx, ctx.uid, { consent: false });
    const d = snap.data() as PhotoProofDoc | undefined;
    if (!d || d.owner_id !== ctx.uid) throw fail('proof_not_found');
    if (d.state !== 'active') {
      return {
        response: { proof_id: d.proof_id, deleted: false, server_now: now },
        after: d.object_deleted ? undefined : async () => void (await deleteProofObjects([d])),
      };
    }
    const ended = writeEndProofs(tx, [d], 'deleted', now);
    return { response: { proof_id: d.proof_id, deleted: true, server_now: now }, after: async () => void (await deleteProofObjects(ended)) };
  });
}

// ---------------------------------------------------------------------------
// Süre dolumu: Cloud Tasks görevi + dakikalık süpürücü yedeği
// ---------------------------------------------------------------------------

/** Etkin fotoğrafı (süresi dolduysa) kendi transaction'ında `ended / expired` yapar. */
async function expireProof(id: string, now: EpochMs): Promise<PhotoProofDoc | null> {
  return db().runTransaction(async (tx) => {
    const d = (await tx.get(refs.photoProof(id))).data() as PhotoProofDoc | undefined;
    if (!d || d.state !== 'active' || d.expires_at > now) return null;
    return writeEndProofs(tx, [d], 'expired', now)[0] ?? null;
  });
}

export type ProofTaskOutcome = 'expired' | 'not_active' | 'missing' | 'early';

/** `{proof_id}` görevi: `expires_at` anında nesneyi siler, kaydı bitirir. En çok 30 sn erken gelirse bekler. */
export async function handleProofExpiryTask(data: { proof_id: string }, now: EpochMs = Date.now()): Promise<ProofTaskOutcome> {
  const d = (await refs.photoProof(data.proof_id).get()).data() as PhotoProofDoc | undefined;
  if (!d) return 'missing';
  if (d.state !== 'active') {
    if (!d.object_deleted) await deleteProofObjects([d]);
    return 'not_active';
  }
  let at = now;
  if (d.expires_at > at) {
    const wait = d.expires_at - at;
    if (wait > LIMITS.expiryTaskMaxEarlyWaitMs) return 'early';
    await new Promise((r) => setTimeout(r, wait + 5));
    at = Math.max(Date.now(), d.expires_at);
  }
  const ended = await expireProof(d.proof_id, at);
  if (ended) await deleteProofObjects([ended]);
  return ended ? 'expired' : 'not_active';
}

/**
 * Dakikalık yedek: süresi dolan etkin fotoğrafları bitirir ve nesnesini siler; bitmiş ama nesnesi silinememiş
 * kayıtları yeniden dener. Bitirilen / silinen kayıt sayısını döndürür.
 */
export async function sweepExpiredProofs(now: EpochMs, max: number = LIMITS.f4SweepMax): Promise<number> {
  const col = db().collection(COL.photoProofs);
  const [due, orphan] = await Promise.all([
    col.where('state', '==', 'active').where('expires_at', '<=', now).orderBy('expires_at').limit(max).get(),
    col.where('state', '==', 'ended').where('object_deleted', '==', false).limit(max).get(),
  ]);
  let n = 0;
  for (const s of due.docs) {
    const ended = await expireProof(s.id, now).catch((err) => {
      logger.error('anlık fotoğraf süresi uygulanamadı', { err: String(err) });
      return null;
    });
    if (ended) n += (await deleteProofObjects([ended])) > 0 ? 1 : 0;
  }
  const left = orphan.docs.map((d) => d.data() as PhotoProofDoc).filter((d) => d.state === 'ended' && !d.object_deleted);
  if (left.length) n += await deleteProofObjects(left);
  return n;
}

/** Hesap silme: kayıtlar ve `proofs/{uid}/` klasörü (tüm olası kovalarda; en iyi çaba). */
export async function deleteProofsOf(uid: UserId): Promise<number> {
  const snap = await db().collection(COL.photoProofs).where('owner_id', '==', uid).get();
  const buckets = new Set([...avatarBuckets(), ...snap.docs.map((d) => (d.data() as PhotoProofDoc).storage_bucket).filter(Boolean)]);
  // Emülatörde Storage emülatörü yoksa nesne silme atlanır (avatarlar gibi); kayıtlar yine silinir.
  if ((IS_EMULATOR || IS_LOCAL_TEST) && !process.env.FIREBASE_STORAGE_EMULATOR_HOST) buckets.clear();
  for (const bucket of buckets) {
    try {
      await adminStorage().bucket(bucket).deleteFiles({ prefix: `${PATHS.proofFolder(uid)}/`, force: true });
    } catch (err) {
      if ((err as { code?: number }).code !== 404) logger.warn('anlık fotoğraf klasörü silinemedi', { bucket, err: String(err) });
    }
  }
  if (!snap.empty) {
    const writer = db().bulkWriter();
    for (const d of snap.docs) void writer.delete(d.ref);
    await writer.close();
  }
  return snap.size;
}
