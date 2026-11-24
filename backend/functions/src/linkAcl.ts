/**
 * Faz 2: bağlantı (QR) yetki aynası `link_acl/{token_hash}` ve token sahibinin okuduğu `link_live/{token_hash}`.
 *
 * Faz 1 `acl.ts` ile aynı ilkeler (bkz. orada):
 *  - Firestore `link_shares/{link_id}` doğrudur; ACL ondan türetilen SÜRÜMLÜ bir aynadır. Ayna yazması RTDB
 *    transaction'ıdır ve yalnızca gelen `version` saklanandan BÜYÜKSE uygulanır.
 *  - Bitişte düğüm silinmez: `{status:'ended', version, ended_at, end_reason}` mezar taşı. 7 gün sonra bakımda
 *    silinir [Varsayım]; hesap silmede hemen silinir (mezar taşı bile bırakılmaz).
 *  - Aktif ACL: `sender_id` (yazma kuralı), `share_mode` + `expires_at` (paket bağlama ve okuma kuralı) ve
 *    `link_id` (denetim: hash → belge). İstemciye TAMAMEN kapalıdır; core `LinkAcl` + sunucu alanları.
 *  - Kesme sırası: Firestore commit → ACL mezar taşı → `link_live/{hash}` silme. Mezar taşından sonra okuma
 *    kuralı (ACL aktif ve süresi dolmamış) yeni okumayı reddeder; silme açık dinleyiciye `null` gönderir
 *    ("Paylaşım sona erdi"). Gönderenin iş birliği gerekmez.
 *  - Süre dolumunda okuma kuralın kendisi keser (`expires_at > now`): Faz 1'deki "son paket penceresi" yoktur.
 *  - Ayna kaybına karşı üç katman: aynı transaction'da `link_acl_pending/{link_id}` işareti, `link_acl_reconciler`
 *    tetikleyicisi (retry: true) ve bakım işi (eski işaretler + tüm aktif bağlantı ACL'lerinin denetimi).
 *
 * Token yenileme (yalnızca yanıtı kaybolan `link_share_create` tekrarında, bkz. handlers/links.ts): belge yeni
 * `token_hash` alır; eski özetin ACL'si mezar taşına çevrilir ve eski `link_live` silinir.
 */
import { type EpochMs, type LinkEndReason, type LinkShare, type ShareMode, PATHS, isLinkTokenHash } from '@konum/core';
import type { Transaction } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { rtdb } from './admin';
import { type LinkAclPendingDoc, type LinkShareDoc, refs } from './docs';

export type LinkAclSource = Pick<
  LinkShare,
  'link_id' | 'sender_id' | 'token_hash' | 'status' | 'share_mode' | 'expires_at' | 'ended_at' | 'end_reason' | 'version'
> &
  Partial<Pick<LinkShare, 'started_at'>>;

/** RTDB'de saklanan hâl: aktif ACL ya da mezar taşı (mezar taşında `sender_id` / `link_id` yok). */
export interface StoredLinkAcl {
  status: 'active' | 'ended';
  version: number;
  sender_id?: string;
  link_id?: string;
  share_mode?: ShareMode;
  expires_at?: EpochMs;
  ended_at?: EpochMs;
  end_reason?: LinkEndReason;
  /** Faz 3: kuyruktan (`q: 1`) gelen nokta bundan eski olamaz (kural `exists()` ile korunur). */
  started_at?: EpochMs;
}

const aclRef = (hash: string) => rtdb().ref(PATHS.linkAcl(hash));
const liveRef = (hash: string) => rtdb().ref(PATHS.linkLive(hash));

function assertHash(hash: string): void {
  // RTDB yolu enjeksiyonuna karşı: özet her zaman 64 hex (sunucu üretir).
  if (!isLinkTokenHash(hash)) throw new Error('geçersiz token_hash');
}

/** RTDB null saklamaz: süresiz bağlantıda `expires_at` alanı hiç yazılmaz. */
export function linkAclValue(s: LinkAclSource, now: EpochMs = Date.now()): StoredLinkAcl {
  if (s.status === 'active') {
    const v: StoredLinkAcl = {
      status: 'active',
      sender_id: s.sender_id,
      link_id: s.link_id,
      share_mode: s.share_mode,
      version: s.version,
    };
    if (s.expires_at !== null) v.expires_at = s.expires_at;
    if (typeof s.started_at === 'number') v.started_at = s.started_at;
    return v;
  }
  const t: StoredLinkAcl = { status: 'ended', version: s.version, ended_at: s.ended_at ?? now };
  if (s.end_reason) t.end_reason = s.end_reason;
  return t;
}

/** Sürüm korumalı ayna yazması (bkz. acl.ts `mirrorAcl`). */
export async function mirrorLinkAcl(
  s: LinkAclSource,
): Promise<{ applied: boolean; created: boolean; current: StoredLinkAcl | null }> {
  assertHash(s.token_hash);
  const next = linkAclValue(s);
  let created = false;
  const res = await aclRef(s.token_hash).transaction(
    (cur: StoredLinkAcl | null) => {
      created = false;
      if (cur && typeof cur.version === 'number' && cur.version >= s.version) return undefined; // daha yeni/eşit: dokunma
      // Hesap silmede mezar taşı bırakılmaz; account_delete düğümleri zaten siler.
      if (!cur && s.status === 'ended' && s.end_reason === 'account_deleted') return null;
      created = cur === null;
      return next;
    },
    undefined,
    false,
  );
  const current = (res.snapshot.val() as StoredLinkAcl | null) ?? null;
  return { applied: res.committed && (created || current !== null), created: res.committed && created, current };
}

export async function removeLinkLive(hash: string): Promise<void> {
  assertHash(hash);
  await liveRef(hash).remove();
}

/**
 * Uzatmada saklanan paketin `expires_at` / `share_mode` alanları ACL'ye eşitlenir. Aksi hâlde web haritası
 * eski bitişi görür ve `linkViewState` gönderenin bir sonraki paketine kadar "sona erdi" gösterebilir.
 */
export async function alignLinkLive(s: LinkAclSource): Promise<void> {
  if (s.status !== 'active') return;
  await liveRef(s.token_hash).transaction(
    (cur: Record<string, unknown> | null) => {
      if (!cur) return null; // kopya yok: boş yazma (sunucuda varsa gerçek değerle yeniden çalışır)
      const same = cur.share_mode === s.share_mode && (s.expires_at === null ? cur.expires_at === undefined : cur.expires_at === s.expires_at);
      if (same) return undefined;
      const next: Record<string, unknown> = { ...cur, share_mode: s.share_mode };
      if (s.expires_at === null) delete next.expires_at;
      else next.expires_at = s.expires_at;
      return next;
    },
    undefined,
    false,
  );
}

/** Transaction yazma aşamasında: ayna bu sürüme gelene kadar duracak işaret. */
export function writeLinkAclPending(
  tx: Transaction,
  s: Pick<LinkAclSource, 'link_id' | 'version'>,
  now: EpochMs,
  staleTokenHash?: string,
): void {
  const m: LinkAclPendingDoc = { link_id: s.link_id, version: s.version, updated_at: now };
  if (staleTokenHash) m.stale_token_hash = staleTokenHash;
  tx.set(refs.linkAclPending(s.link_id), m);
}

/** Ayna `version` (ya da daha yenisi) uygulandıktan sonra işareti siler (yalnızca hâlâ eski/eşit sürümdeyse). */
export async function clearLinkAclPending(linkId: string, version: number): Promise<void> {
  try {
    const ref = refs.linkAclPending(linkId);
    const snap = await ref.get();
    if (!snap.exists) return;
    const m = snap.data() as LinkAclPendingDoc;
    if (typeof m.version === 'number' && m.version > version) return;
    await ref.delete({ lastUpdateTime: snap.updateTime });
  } catch (err) {
    logger.debug('link_acl_pending silinemedi (bakım işi temizler)', { link_id: linkId, err: String(err) });
  }
}

/**
 * Bir token özetini belgeye bakmadan kapatır (token yenilendi, belge silindi ya da denetimde sahipsiz ACL).
 * Aktif değilse dokunmaz. Kapattıysa `link_live` de silinir. Sonuç: kapattı mı.
 */
export async function closeLinkHash(
  hash: string,
  version: number,
  reason: LinkEndReason,
  now: EpochMs = Date.now(),
): Promise<boolean> {
  assertHash(hash);
  let closed = false;
  const res = await aclRef(hash).transaction(
    (cur: StoredLinkAcl | null) => {
      closed = false;
      if (!cur) return null; // düğüm yok: boş yazma (dokunma)
      if (cur.status !== 'active') return undefined;
      closed = true;
      return { status: 'ended', version: Math.max(cur.version ?? 0, version), ended_at: now, end_reason: reason } satisfies StoredLinkAcl;
    },
    undefined,
    false,
  );
  if (res.committed && closed) {
    await removeLinkLive(hash);
    return true;
  }
  // Mezar taşı zaten varsa son paket de kalmamalı (idempotent).
  const cur = res.snapshot.val() as StoredLinkAcl | null;
  if (cur && cur.status !== 'active') await removeLinkLive(hash);
  return false;
}

/**
 * Tek bağlantı için ayna + (bittiyse) canlı kopyayı silme. İdempotent.
 *
 * Bağlantıda "bitti" SONDUR: biten belge yeniden açılmaz ve token yenileme yeni özetle olur. Bu yüzden belge
 * bitmişken aynı özetin ACL'si (sürümü ne olursa olsun) hâlâ aktifse kapatılır (fail-closed; Faz 1 paylaşımında
 * aynı belge yeniden başlatılabildiği için sürüm kuralı tek başına uygulanır).
 */
export async function applyLinkEffect(s: LinkAclSource): Promise<void> {
  const { current, created } = await mirrorLinkAcl(s);
  if (s.status === 'ended' && current?.status === 'active') {
    await closeLinkHash(s.token_hash, s.version, s.end_reason ?? 'stopped_by_sender');
  } else if (s.status === 'ended') {
    await removeLinkLive(s.token_hash);
  }
  if (s.status === 'active' && current?.status === 'active' && current.version === s.version) {
    await alignLinkLive(s);
  }
  if (created && s.status === 'active') {
    // Düğüm yoktu: geç kalmış bir "aç" yazısı olabilir. Belgeyi doğrula; aktif değilse hemen uzlaştır.
    const doc = (await refs.linkShare(s.link_id).get()).data() as LinkShareDoc | undefined;
    if (!doc || doc.status !== 'active' || doc.version !== s.version || doc.token_hash !== s.token_hash) {
      if (!doc || doc.token_hash !== s.token_hash) await closeLinkHash(s.token_hash, s.version, 'stopped_by_sender');
      await reconcileLink(s.link_id);
      return;
    }
  }
  await clearLinkAclPending(s.link_id, s.version);
}

/**
 * Commit sonrası yan etkiler. Hata olursa fırlatır: callable `unavailable` döner ve istemci aynı `op_id` ile
 * tekrar dener; uzlaştırıcı tetikleyici ve bakım işi de aynı işi bağımsız yapar.
 */
export async function applyLinkEffects(links: readonly LinkAclSource[]): Promise<void> {
  const results = await Promise.allSettled(links.map((s) => applyLinkEffect(s)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    logger.error('bağlantı ACL aynası uygulanamadı', { count: failed.length, reason: String(failed[0]?.reason) });
    throw new Error('link_acl_mirror_failed');
  }
}

/**
 * Uzlaştırıcı: belgenin GÜNCEL hâline bakar (olaylar geç ve sırasız gelebilir).
 *  - `before` (tetikleyici): önceki hâlin özeti güncel özetten farklıysa (token yenilendi / belge silindi)
 *    eski özet kapatılır.
 *  - Belge yoksa (TTL, hesap silme): yalnızca `before` özeti kapatılabilir; işaret temizlenir.
 */
export async function reconcileLink(
  linkId: string,
  before?: Partial<LinkShareDoc> | null,
  now: EpochMs = Date.now(),
): Promise<void> {
  const snap = await refs.linkShare(linkId).get();
  const doc = snap.exists ? (snap.data() as LinkShareDoc) : null;
  const prevHash = before?.token_hash;
  if (prevHash && isLinkTokenHash(prevHash) && (!doc || doc.token_hash !== prevHash)) {
    await closeLinkHash(prevHash, before?.version ?? 0, doc ? 'stopped_by_sender' : (before?.end_reason ?? 'expired'), now);
  }
  if (doc) {
    await applyLinkEffect(doc);
    return;
  }
  await clearLinkAclPending(linkId, Number.MAX_SAFE_INTEGER);
}

/** Op tekrarında ve bakımda: güncel belgelerden yeniden uygula. */
export async function reapplyLinkEffects(linkIds: readonly string[]): Promise<void> {
  await Promise.all([...new Set(linkIds)].map((id) => reconcileLink(id)));
}

/**
 * ACL düğümünü tamamen siler (hesap silme: uid RTDB'de kalmasın). Aktif düğüme dokunmaz. Sonuç: silindi mi.
 */
export async function deleteLinkAclNode(hash: string): Promise<boolean> {
  assertHash(hash);
  let removed = false;
  const res = await aclRef(hash).transaction(
    (cur: StoredLinkAcl | null) => {
      removed = false;
      if (!cur) return null;
      if (cur.status === 'active') return undefined;
      removed = true;
      return null;
    },
    undefined,
    false,
  );
  return res.committed && removed;
}
