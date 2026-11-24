/**
 * Bakım işleri: süre dolumu görevi, dakikalık süre dolumu taraması ve ACL uzlaştırma / denetim.
 *
 * Asıl yazma kesmesi RTDB kuralındadır: `expires_at > now` olmadıkça yazma reddedilir, yani gönderen tam
 * süresinde yazamaz. Son paketi `expires_at` anında Cloud Tasks görevi siler (`handleExpiryTask`); dakikalık tarama
 * Firestore'u `expired` ile kapatan yedektir. Okuma yalnızca kimliğe bağlı olduğundan görev çalışana kadar (tipik
 * birkaç saniye, görev başarısızsa ≤ 1 dk) eski alıcı son paketi okuyabilir (bkz. tasks.ts).
 *
 * ACL onarımı (fail-open kalmasın, BACKEND_SPEC §4):
 *  1. `acl_pending` işaretleri: 60 sn'den eski işaret = commit sonrası ayna kaybolmuş → belgeden yeniden uygula.
 *  2. Tam denetim (her 5 dk [Varsayım]): RTDB'deki TÜM aktif ACL'ler Firestore ile karşılaştırılır; belge yoksa,
 *     aktif değilse ya da sürümü farklıysa uzlaştırılır (mezar taşı / güncel hâl). Gönderenin iş birliği gerekmez.
 *  3. 7 günden eski mezar taşları silinir (KVKK asgari veri). [Varsayım]
 *
 * Faz 2 bağlantıları (`link_shares` / `link_acl`): süresi dolanlar `expired` ile kapatılır ve `link_live` silinir
 * (okuma kuralı süreyi zaten keser), eski `link_acl_pending` işaretleri (eski token özeti dahil) uygulanır, her
 * 5 dk aktif bağlantı ACL'leri denetlenir ve 7 günden eski bağlantı mezar taşları silinir.
 *
 * Faz 4: süresi geçen `ping_inbox` kayıtları (`ping_expiry` dizininden), süresi geçen `place_notes` belgeleri silinir;
 * `SOS_LIMITS.activeMaxMs`'i aşan aktif SOS `resolved / timeout` olur.
 *
 * Faz 5: süresi geçen `meetups` (iptal edilenler dahil) ve `meetup_cache` belgeleri silinir (TTL yedek).
 *
 * Bu modül firebase-functions tetikleyicilerine bağlı değildir: testler `sweepExpired({ now })` ve
 * `handleExpiryTask(data, now)` ile enjekte edilen saatle doğrudan çağırır.
 */
import { type EpochMs, PATHS } from '@konum/core';
import * as logger from 'firebase-functions/logger';
import { type StoredAcl, applyShareEffect, applyShareEffects, reconcileShare } from '../acl';
import { db, rtdb } from '../admin';
import { LIMITS } from '../config';
import {
  type AclPendingDoc,
  COL,
  type LinkAclPendingDoc,
  type LinkShareDoc,
  type RequestDoc,
  type ShareDoc,
  purgeAt,
  refs,
} from '../docs';
import { endSharesById } from '../lifecycle';
import { type StoredLinkAcl, applyLinkEffect, closeLinkHash, reconcileLink } from '../linkAcl';
import type { ExpiryTaskData } from '../tasks';
import { chunk } from '../util';
import { sweepExpiredLinks } from './links';
import { sweepExpiredPlaceNotes } from './notes';
import { sweepExpiredPings } from './ping';
import { timeoutActiveSos } from './sos';
import { sweepExpiredMeetups } from './meetup';

export interface SweepOptions {
  /** Enjekte edilebilir saat (testler); varsayılan `Date.now()`. */
  now?: EpochMs;
  batchSize?: number;
  maxBatches?: number;
  /** Tam ACL denetimi + mezar taşı temizliği. Varsayılan açık; dakikalık zamanlayıcı 5 dk'da bir açar. */
  audit?: boolean;
}

export interface SweepResult {
  ended_share_ids: string[];
  expired_request_ids: string[];
  /** Bekleyen işaret ya da denetim sonucu yeniden uygulanan paylaşımlar. */
  reconciled_share_ids: string[];
  purged_tombstones: number;
  /** Faz 2: süresi dolan bağlantılar, onarılan bağlantı ACL'leri, silinen bağlantı mezar taşları. */
  ended_link_ids: string[];
  reconciled_link_ids: string[];
  purged_link_tombstones: number;
  /** Faz 4: süresi geçen pingler (RTDB), silinen yer notları, süre aşımıyla kapanan SOS'lar. */
  purged_pings: number;
  purged_place_notes: number;
  timed_out_sos_ids: string[];
  /** Faz 5: silinen süresi geçmiş buluşma önerileri ve öneri önbelleği belgeleri. */
  purged_meetups: number;
  purged_meetup_cache: number;
}

export async function sweepExpired(opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const batchSize = opts.batchSize ?? LIMITS.sweepBatchSize;
  const maxBatches = opts.maxBatches ?? LIMITS.sweepMaxBatches;
  const result: SweepResult = {
    ended_share_ids: [],
    expired_request_ids: [],
    reconciled_share_ids: [],
    purged_tombstones: 0,
    ended_link_ids: [],
    reconciled_link_ids: [],
    purged_link_tombstones: 0,
    purged_pings: 0,
    purged_place_notes: 0,
    timed_out_sos_ids: [],
    purged_meetups: 0,
    purged_meetup_cache: 0,
  };

  // --- paylaşımlar: (status, expires_at) bileşik dizini ---
  for (let i = 0; i < maxBatches; i++) {
    const snap = await db()
      .collection(COL.shares)
      .where('status', '==', 'active')
      .where('expires_at', '<=', now)
      .orderBy('expires_at')
      .limit(batchSize)
      .get();
    if (snap.empty) break;
    const ended = await endSharesById(
      snap.docs.map((d) => d.id),
      (s: ShareDoc) => (s.status === 'active' && s.expires_at !== null && s.expires_at <= now ? 'expired' : null),
      now,
      batchSize,
    );
    result.ended_share_ids.push(...ended.map((e) => e.share_id));
    try {
      await applyShareEffects(ended);
    } catch (err) {
      // Firestore kapandı; acl_pending işareti kalır, aşağıdaki adım ve uzlaştırıcı tetikleyici onarır.
      logger.error('tarama: ACL aynası uygulanamadı', { err: String(err) });
    }
    if (snap.size < batchSize || ended.length === 0) break;
  }

  // --- konum istekleri: 15 dk sonra expired ---
  for (let i = 0; i < maxBatches; i++) {
    const snap = await db()
      .collection(COL.requests)
      .where('status', '==', 'pending')
      .where('expires_at', '<=', now)
      .orderBy('expires_at')
      .limit(batchSize)
      .get();
    if (snap.empty) break;
    const expired = await db().runTransaction(async (tx) => {
      const fresh = await tx.getAll(...snap.docs.map((d) => d.ref));
      const ids: string[] = [];
      for (const d of fresh) {
        const r = d.data() as RequestDoc | undefined;
        if (!r || r.status !== 'pending' || r.expires_at > now) continue;
        tx.update(d.ref, { status: 'expired', updated_at: now, purge_at: purgeAt(now) });
        ids.push(d.id);
      }
      return ids;
    });
    result.expired_request_ids.push(...expired);
    if (snap.size < batchSize || expired.length === 0) break;
  }

  // --- Faz 2: bağlantılar (okuma kuralı süreyi zaten keser; bu adım belgeyi kapatır ve son paketi siler) ---
  result.ended_link_ids.push(...(await sweepExpiredLinks(now, batchSize, maxBatches)));

  // --- Faz 4: ping kutusu, yer notları, SOS süre aşımı (her biri bağımsız; biri düşerse diğerleri sürer) ---
  const [pings, notes, sos] = await Promise.allSettled([sweepExpiredPings(now), sweepExpiredPlaceNotes(now), timeoutActiveSos(now)]);
  if (pings.status === 'fulfilled') result.purged_pings = pings.value;
  else logger.error('tarama: pingler silinemedi', { err: String(pings.reason) });
  if (notes.status === 'fulfilled') result.purged_place_notes = notes.value;
  else logger.error('tarama: yer notları silinemedi', { err: String(notes.reason) });
  if (sos.status === 'fulfilled') result.timed_out_sos_ids = sos.value;
  else logger.error('tarama: SOS süre aşımı uygulanamadı', { err: String(sos.reason) });

  // --- Faz 5: buluşma önerileri ve öneri önbelleği ---
  try {
    const m = await sweepExpiredMeetups(now);
    result.purged_meetups = m.meetups;
    result.purged_meetup_cache = m.cache;
  } catch (err) {
    logger.error('tarama: buluşma önerileri silinemedi', { err: String(err) });
  }

  // --- ACL onarımı ---
  result.reconciled_share_ids.push(...(await reconcilePendingAcls(now, batchSize * maxBatches)));
  result.reconciled_link_ids.push(...(await reconcilePendingLinkAcls(now, batchSize * maxBatches)));
  if (opts.audit ?? true) {
    result.reconciled_share_ids.push(...(await auditActiveAcls(now)));
    result.purged_tombstones = await purgeAclTombstones(now);
    result.reconciled_link_ids.push(...(await auditActiveLinkAcls(now)));
    result.purged_link_tombstones = await purgeLinkAclTombstones(now);
  }
  return result;
}

/** Dakikalık zamanlayıcı: tam denetim yalnızca her `aclAuditEveryMinutes` dakikada bir. */
export const isAuditSlot = (scheduledAt: EpochMs): boolean =>
  Math.floor(scheduledAt / 60_000) % LIMITS.aclAuditEveryMinutes === 0;

/** Uygulanamamış (eski) `acl_pending` işaretlerini belgeden yeniden uygular. */
export async function reconcilePendingAcls(now: EpochMs, max = 2_000): Promise<string[]> {
  const snap = await db()
    .collection(COL.aclPending)
    .where('updated_at', '<=', now - LIMITS.aclPendingGraceMs)
    .orderBy('updated_at')
    .limit(max)
    .get();
  const done: string[] = [];
  for (const part of chunk(snap.docs, 20)) {
    const res = await Promise.allSettled(
      part.map(async (d) => {
        const m = d.data() as AclPendingDoc;
        await reconcileShare(m.share_id ?? d.id, undefined, now);
        return m.share_id ?? d.id;
      }),
    );
    for (const r of res) {
      if (r.status === 'fulfilled') done.push(r.value);
      else logger.error('bekleyen ACL uzlaştırılamadı', { err: String(r.reason) });
    }
  }
  if (done.length) logger.warn('kaybolan ACL aynaları onarıldı', { count: done.length });
  return done;
}

/**
 * Tam denetim: RTDB'deki aktif ACL'ler (`.indexOn: status`) sayfa sayfa okunur, Firestore belgeleriyle
 * karşılaştırılır. ACL ↔ belge tutarsızsa `reconcileShare` (belge doğrudur; belge yoksa fail-closed).
 */
export async function auditActiveAcls(now: EpochMs): Promise<string[]> {
  const fixed: string[] = [];
  let startKey: string | null = null;
  for (let page = 0; page < LIMITS.aclAuditMaxPages; page++) {
    let q = rtdb().ref('share_acl').orderByChild('status');
    q = startKey === null ? q.equalTo('active') : q.startAt('active', startKey).endAt('active');
    const snap = await q.limitToFirst(LIMITS.aclAuditPageSize + (startKey === null ? 0 : 1)).once('value');
    const entries: [string, StoredAcl][] = [];
    snap.forEach((c) => {
      if (c.key && c.key !== startKey) entries.push([c.key, c.val() as StoredAcl]);
    });
    if (entries.length === 0) break;
    for (const part of chunk(entries, 100)) {
      const docs = await db().getAll(...part.map(([id]) => refs.shareById(id)));
      const suspicious = part.filter(([, acl], i) => {
        const d = docs[i]?.data() as ShareDoc | undefined;
        return !d || d.status !== 'active' || d.version !== acl.version;
      });
      const res = await Promise.allSettled(suspicious.map(([id]) => reconcileShare(id, undefined, now).then(() => id)));
      for (const r of res) {
        if (r.status === 'fulfilled') fixed.push(r.value);
        else logger.error('ACL denetimi: uzlaştırılamadı', { err: String(r.reason) });
      }
    }
    startKey = entries[entries.length - 1]?.[0] ?? null;
    if (entries.length < LIMITS.aclAuditPageSize) break;
  }
  if (fixed.length) logger.warn('ACL denetimi tutarsızlık düzeltti', { count: fixed.length });
  return fixed;
}

/** 7 günden eski mezar taşlarını siler (`.indexOn: ended_at`). Belge de yoksa sürüm 1'den başlamak güvenlidir. */
export async function purgeAclTombstones(now: EpochMs, max = 1_000): Promise<number> {
  const cutoff = now - LIMITS.aclTombstoneTtlMs;
  const snap = await rtdb().ref('share_acl').orderByChild('ended_at').startAt(1).endAt(cutoff).limitToFirst(max).once('value');
  const ids: string[] = [];
  snap.forEach((c) => {
    if (c.key) ids.push(c.key);
  });
  let purged = 0;
  for (const part of chunk(ids, 50)) {
    const res = await Promise.all(
      part.map(async (id) => {
        let removed = false;
        const r = await rtdb()
          .ref(PATHS.shareAcl(id))
          .transaction(
            (cur: StoredAcl | null) => {
              removed = false;
              if (!cur) return null;
              if (cur.status !== 'ended' || typeof cur.ended_at !== 'number' || cur.ended_at > cutoff) return undefined;
              removed = true;
              return null;
            },
            undefined,
            false,
          );
        return r.committed && removed;
      }),
    );
    purged += res.filter(Boolean).length;
  }
  return purged;
}

// ---------------------------------------------------------------------------
// Faz 2: bağlantı ACL onarımı (`link_acl/{token_hash}`)
// ---------------------------------------------------------------------------

/** Uygulanamamış (eski) `link_acl_pending` işaretlerini belgeden yeniden uygular (eski token özeti dahil). */
export async function reconcilePendingLinkAcls(now: EpochMs, max = 2_000): Promise<string[]> {
  const snap = await db()
    .collection(COL.linkAclPending)
    .where('updated_at', '<=', now - LIMITS.aclPendingGraceMs)
    .orderBy('updated_at')
    .limit(max)
    .get();
  const done: string[] = [];
  for (const part of chunk(snap.docs, 20)) {
    const res = await Promise.allSettled(
      part.map(async (d) => {
        const m = d.data() as LinkAclPendingDoc;
        const id = m.link_id ?? d.id;
        if (m.stale_token_hash) await closeLinkHash(m.stale_token_hash, m.version ?? 0, 'stopped_by_sender', now);
        await reconcileLink(id, undefined, now);
        return id;
      }),
    );
    for (const r of res) {
      if (r.status === 'fulfilled') done.push(r.value);
      else logger.error('bekleyen bağlantı ACL uzlaştırılamadı', { err: String(r.reason) });
    }
  }
  if (done.length) logger.warn('kaybolan bağlantı ACL aynaları onarıldı', { count: done.length });
  return done;
}

/**
 * Tam denetim: RTDB'deki aktif bağlantı ACL'leri sayfa sayfa okunur ve `link_id` ile belgeye bakılır. Belge yoksa,
 * aktif değilse, sürümü ya da `token_hash` değeri farklıysa: belge bu özete aitse belgeden uygulanır, değilse
 * özet doğrudan kapatılır (fail-closed). Sonuç: düzeltilen token özetleri.
 */
export async function auditActiveLinkAcls(now: EpochMs): Promise<string[]> {
  const fixed: string[] = [];
  let startKey: string | null = null;
  for (let page = 0; page < LIMITS.aclAuditMaxPages; page++) {
    let q = rtdb().ref('link_acl').orderByChild('status');
    q = startKey === null ? q.equalTo('active') : q.startAt('active', startKey).endAt('active');
    const snap = await q.limitToFirst(LIMITS.aclAuditPageSize + (startKey === null ? 0 : 1)).once('value');
    const entries: [string, StoredLinkAcl][] = [];
    snap.forEach((c) => {
      if (c.key && c.key !== startKey) entries.push([c.key, c.val() as StoredLinkAcl]);
    });
    if (entries.length === 0) break;
    for (const part of chunk(entries, 100)) {
      const withId = part.filter(([, acl]) => typeof acl.link_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(acl.link_id));
      const docs = withId.length ? await db().getAll(...withId.map(([, acl]) => refs.linkShare(acl.link_id as string))) : [];
      const byHash = new Map(withId.map(([hash], i) => [hash, docs[i]?.data() as LinkShareDoc | undefined]));
      const suspicious = part.filter(([hash, acl]) => {
        const d = byHash.get(hash);
        return !d || d.status !== 'active' || d.version !== acl.version || d.token_hash !== hash;
      });
      const res = await Promise.allSettled(
        suspicious.map(async ([hash, acl]) => {
          const d = byHash.get(hash);
          // Belge bu özete ait ve aktif: belgeden uygula. Bitmiş (bitti sondur), yok ya da başka özet: kapat.
          if (d && d.token_hash === hash && d.status === 'active') await applyLinkEffect(d);
          else await closeLinkHash(hash, Math.max(acl.version ?? 0, d?.version ?? 0), d?.end_reason ?? 'expired', now);
          return hash;
        }),
      );
      for (const r of res) {
        if (r.status === 'fulfilled') fixed.push(r.value);
        else logger.error('bağlantı ACL denetimi: uzlaştırılamadı', { err: String(r.reason) });
      }
    }
    startKey = entries[entries.length - 1]?.[0] ?? null;
    if (entries.length < LIMITS.aclAuditPageSize) break;
  }
  if (fixed.length) logger.warn('bağlantı ACL denetimi tutarsızlık düzeltti', { count: fixed.length });
  return fixed;
}

/** 7 günden eski bağlantı mezar taşlarını siler (`.indexOn: ended_at`). */
export async function purgeLinkAclTombstones(now: EpochMs, max = 1_000): Promise<number> {
  const cutoff = now - LIMITS.aclTombstoneTtlMs;
  const snap = await rtdb().ref('link_acl').orderByChild('ended_at').startAt(1).endAt(cutoff).limitToFirst(max).once('value');
  const hashes: string[] = [];
  snap.forEach((c) => {
    if (c.key) hashes.push(c.key);
  });
  let purged = 0;
  for (const part of chunk(hashes, 50)) {
    const res = await Promise.all(
      part.map(async (hash) => {
        let removed = false;
        const r = await rtdb()
          .ref(`link_acl/${hash}`)
          .transaction(
            (cur: StoredLinkAcl | null) => {
              removed = false;
              if (!cur) return null;
              if (cur.status !== 'ended' || typeof cur.ended_at !== 'number' || cur.ended_at > cutoff) return undefined;
              removed = true;
              return null;
            },
            undefined,
            false,
          );
        return r.committed && removed;
      }),
    );
    purged += res.filter(Boolean).length;
  }
  return purged;
}

// ---------------------------------------------------------------------------
// Süre dolumu görevi (Cloud Tasks)
// ---------------------------------------------------------------------------

export type ExpiryTaskOutcome = 'expired' | 'stale_version' | 'not_active' | 'missing' | 'early';

/**
 * `{share_id, version}` görevi: sürüm hâlâ geçerli ve süre dolmuşsa paylaşımı bitirir, mezar taşı yazar,
 * son paketi siler. Görev erken gelirse en çok 30 sn bekler; daha erkense hiçbir şey yapmaz (tarama yedeği).
 */
export async function handleExpiryTask(data: ExpiryTaskData, now: EpochMs = Date.now()): Promise<ExpiryTaskOutcome> {
  const snap = await refs.shareById(data.share_id).get();
  if (!snap.exists) {
    await reconcileShare(data.share_id, undefined, now);
    return 'missing';
  }
  const s = snap.data() as ShareDoc;
  if (s.status !== 'active') {
    await applyShareEffect(s); // ayna ve canlı kopya kesin kapalı olsun (idempotent)
    return 'not_active';
  }
  if (s.version !== data.version) return 'stale_version'; // uzatıldı: yeni sürümün kendi görevi var
  if (s.expires_at === null) return 'stale_version';
  let at = now;
  if (s.expires_at > at) {
    const wait = s.expires_at - at;
    if (wait > LIMITS.expiryTaskMaxEarlyWaitMs) return 'early';
    await new Promise((r) => setTimeout(r, wait + 5));
    at = Math.max(Date.now(), s.expires_at);
  }
  const ended = await endSharesById(
    [s.share_id],
    (d) => (d.status === 'active' && d.version === data.version && d.expires_at !== null && d.expires_at <= at ? 'expired' : null),
    at,
  );
  if (ended.length === 0) return 'stale_version';
  await applyShareEffects(ended);
  return 'expired';
}
