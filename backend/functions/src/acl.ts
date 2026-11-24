/**
 * RTDB yetki aynası: `share_acl/{share_id}` ve canlı kopyanın kesilmesi.
 *
 * Firestore `location_shares` doğrudur; ACL ondan türetilmiş, SÜRÜMLÜ bir aynadır.
 *  - Ayna yazması bir RTDB transaction'ıdır ve yalnızca gelen `version` saklanandan BÜYÜKSE uygulanır:
 *    geç gelen eski bir "aç" yazısı yeni bir "kapat" kararını ezemez.
 *  - Paylaşım bitince düğüm silinmez; `{status: 'ended', version, ended_at}` mezar taşı yazılır.
 *    Mezar taşları 7 gün sonra bakım işinde silinir [Varsayım]; hesap silmede hemen silinir.
 *  - Aktif ACL `share_mode` ve `expires_at` taşır: kural, paketteki iki alanı da bunlarla eşitler.
 *  - Kesme sırası: Firestore commit → ACL mezar taşı → `live_locations/{receiver}/{share}` silme.
 *    Mezar taşından sonra gönderenin yazmaları kural gereği reddedilir; silme alıcıda `child_removed` tetikler.
 *    Gönderen istemcinin iş birliği gerekmez.
 *  - Ayna kaybına karşı üç katman: (1) her durum değişikliğiyle AYNI transaction'da `acl_pending` işareti,
 *    ayna uygulanınca silinir; (2) `onDocumentWritten` uzlaştırıcısı (retry: true); (3) bakım işinde
 *    bekleyen işaretler + RTDB'deki tüm aktif ACL'lerin Firestore ile denetimi (bkz. handlers/sweeper.ts).
 *
 * RTDB transaction notu: güncelleme fonksiyonu önce yerel önbellekle (çoğu zaman null) çağrılır. null görünce
 * `undefined` (vazgeç) dönmek sunucudaki gerçek değeri hiç görmeden bitirir; bu yüzden "dokunma" için null'da
 * `null` (boş yazma) döneriz: sunucuda veri varsa transaction gerçek değerle yeniden çalışır.
 */
import { type EpochMs, type LocationShare, type ShareAcl, type ShareMode, PATHS, livePath } from '@konum/core';
import type { Transaction } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { rtdb } from './admin';
import { type AclPendingDoc, type ShareDoc, refs } from './docs';

export type AclSource = Pick<
  LocationShare,
  'share_id' | 'sender_id' | 'receiver_id' | 'status' | 'share_mode' | 'expires_at' | 'ended_at' | 'end_reason' | 'version'
> &
  Partial<Pick<LocationShare, 'started_at'>>;

/**
 * RTDB'de saklanan hâl: aktif ACL ya da mezar taşı (`sender_id`/`receiver_id` yok).
 * core `ShareAcl` + `share_mode` (paket bağlama) + `ended_at` (mezar taşı temizliği). → core_requests
 */
export type StoredAcl = Partial<ShareAcl> & {
  status: ShareAcl['status'];
  version: number;
  share_mode?: ShareMode;
  ended_at?: EpochMs;
  /**
   * Faz 3: oturum başlangıcı. Kural, çevrimdışı kuyruktan (`q: 1`) gelen canlı noktayı ve `live_trail` noktasını
   * bundan eski kabul etmez (önceki oturumun / paylaşım dışı dönemin konumu sızmasın). Faz 3 öncesi aynalarda yok:
   * kural `exists()` ile korunur, bir sonraki sürümde yazılır.
   */
  started_at?: EpochMs;
};

/** RTDB null saklamaz: süresiz paylaşımda `expires_at` alanı hiç yazılmaz. */
export function aclValue(s: AclSource, now: EpochMs = Date.now()): StoredAcl {
  if (s.status === 'active') {
    const v: StoredAcl = {
      sender_id: s.sender_id,
      receiver_id: s.receiver_id,
      status: 'active',
      share_mode: s.share_mode,
      version: s.version,
    };
    if (s.expires_at !== null) v.expires_at = s.expires_at;
    if (typeof s.started_at === 'number') v.started_at = s.started_at;
    return v;
  }
  return { status: 'ended', version: s.version, ended_at: s.ended_at ?? now };
}

/**
 * Sürüm korumalı ayna yazması. `current`: transaction sonrası düğümün gerçek hâli;
 * `created`: düğüm yoktu ve bu yazma oluşturdu.
 */
export async function mirrorAcl(s: AclSource): Promise<{ applied: boolean; created: boolean; current: StoredAcl | null }> {
  const next = aclValue(s);
  let created = false;
  const res = await rtdb()
    .ref(PATHS.shareAcl(s.share_id))
    .transaction(
      (cur: StoredAcl | null) => {
        created = false;
        if (cur && typeof cur.version === 'number' && cur.version >= s.version) return undefined; // daha yeni/eşit: dokunma
        // Hesap silmede mezar taşı bırakılmaz (uid çifti tutulmasın); account_delete düğümleri siler.
        if (!cur && s.status === 'ended' && s.end_reason === 'account_deleted') return null;
        created = cur === null;
        return next;
      },
      undefined,
      false,
    );
  return { applied: res.committed && (created || res.snapshot.val() !== null), created: res.committed && created, current: (res.snapshot.val() as StoredAcl | null) ?? null };
}

/** Faz 3: `live_trail/{receiver_id}/{share_id}` (çevrimdışı dönemin noktaları; core `liveTrailPath` öneki). */
export const trailPath = (receiverId: string, id: string): string => `live_trail/${receiverId}/${id}`;

/**
 * Canlı kopya + Faz 3 iz düğümü TEK atomik çok yollu silmeyle kaldırılır: paylaşım bitince (durdurma, geri alma,
 * süre dolumu, arkadaşlık bitişi, engel, hesap silme) alıcıda ne son konum ne de çevrimdışı güzergâh kalır.
 */
export async function removeLiveCopy(receiverId: string, id: string): Promise<void> {
  await rtdb()
    .ref()
    .update({ [livePath(receiverId, id)]: null, [trailPath(receiverId, id)]: null });
}

/** Transaction içinde (yazma aşaması): ayna bu sürüme gelene kadar duracak işaret. */
export function writeAclPending(tx: Transaction, s: Pick<AclSource, 'share_id' | 'version'>, now: EpochMs): void {
  tx.set(refs.aclPending(s.share_id), { share_id: s.share_id, version: s.version, updated_at: now } satisfies AclPendingDoc);
}

/** Ayna `version` (ya da daha yenisi) uygulandıktan sonra: işaret yalnızca hâlâ eski/eşit sürümdeyse silinir. */
export async function clearAclPending(id: string, version: number): Promise<void> {
  try {
    const ref = refs.aclPending(id);
    const snap = await ref.get();
    if (!snap.exists) return;
    const m = snap.data() as AclPendingDoc;
    if (typeof m.version === 'number' && m.version > version) return;
    // Arada yeni bir işaret yazıldıysa (updateTime değişti) silme başarısız olur ve işaret kalır: doğru davranış.
    await ref.delete({ lastUpdateTime: snap.updateTime });
  } catch (err) {
    logger.debug('acl_pending silinemedi (bakım işi temizler)', { id, err: String(err) });
  }
}

/**
 * Aktif ACL değişince (uzatma, yeni oturum) alıcıdaki son paketin `expires_at` / `share_mode` alanları ACL'ye
 * eşitlenir: alıcı yeni bitişi gönderenin bir sonraki paketini beklemeden görür (arka planda bu 10 dk'yı
 * bulabilir) ve saklanan paket hiçbir an ACL ile çelişmez. Kural da her yazmada birleşik paketi ACL ile eşitler.
 */
export async function alignLiveCopy(s: AclSource): Promise<void> {
  if (s.status !== 'active') return;
  await rtdb()
    .ref(livePath(s.receiver_id, s.share_id))
    .transaction(
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

/** Tek paylaşım için ayna + (bittiyse) canlı kopyayı silme. İdempotent. */
export async function applyShareEffect(s: AclSource): Promise<void> {
  const { current, created } = await mirrorAcl(s);
  // Ayna şu an aktif DEĞİLSE (mezar taşı yazıldı ya da zaten vardı) canlı kopya silinir.
  // Arada paylaşım yeniden başlatıldıysa (daha yüksek sürümle aktif) yeni kopyaya dokunulmaz.
  if (s.status === 'ended' && current?.status !== 'active') {
    await removeLiveCopy(s.receiver_id, s.share_id);
  }
  if (s.status === 'active' && current?.status === 'active' && current.version === s.version) {
    await alignLiveCopy(s);
  }
  if (created && s.status === 'active') {
    // Düğüm yoktu: ilk paylaşım ya da düğüm silinmişti (hesap silme / mezar taşı temizliği). Geç kalmış bir
    // "aç" yazısı sürüm koruması olmadan uygulanmış olabilir: belgeyi doğrula, aktif değilse hemen uzlaştır.
    const snap = await refs.shareById(s.share_id).get();
    const doc = snap.data() as ShareDoc | undefined;
    if (!doc || doc.status !== 'active' || doc.version !== s.version) {
      await reconcileShare(s.share_id);
      return;
    }
  }
  await clearAclPending(s.share_id, s.version);
}

/**
 * Commit sonrası yan etkiler. Hata olursa fırlatır: callable `unavailable` döner, istemci aynı
 * `op_id` ile tekrar dener (tekrar oynatma yan etkileri yeniden uygular); `onDocumentWritten` uzlaştırıcısı
 * ve bakım işi (`acl_pending`) de aynı işi bağımsız olarak yapar.
 */
export async function applyShareEffects(shares: readonly AclSource[]): Promise<void> {
  const results = await Promise.allSettled(shares.map((s) => applyShareEffect(s)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    logger.error('ACL aynası uygulanamadı', { count: failed.length, reason: String(failed[0]?.reason) });
    throw new Error('acl_mirror_failed');
  }
}

/** Güncel Firestore belgelerinden yeniden uygula (op tekrarında ve uzlaştırıcıda). */
export async function reapplyShareEffects(shareIds: readonly string[]): Promise<void> {
  const unique = [...new Set(shareIds)];
  await Promise.all(unique.map((id) => reconcileShare(id)));
}

/**
 * Uzlaştırıcı: tetikleyici olayının içeriğine değil, belgenin GÜNCEL hâline bakar
 * (olaylar geç ve sırasız gelebilir). Belge silinmişse aktif ACL kapatılır (fail-closed).
 * `before`: tetikleyicideki silinmeden önceki hâl (varsa).
 */
export async function reconcileShare(id: string, before?: Partial<ShareDoc> | null, now: EpochMs = Date.now()): Promise<void> {
  const snap = await refs.shareById(id).get();
  if (snap.exists) {
    await applyShareEffect(snap.data() as ShareDoc);
    return;
  }
  // Belge yok (TTL): aktif bir ayna kaldıysa mezar taşına çevir.
  let closed: StoredAcl | null = null;
  const res = await rtdb()
    .ref(PATHS.shareAcl(id))
    .transaction(
      (cur: StoredAcl | null) => {
        closed = null;
        if (!cur) return null; // düğüm yok: boş yazma (dokunma)
        if (cur.status !== 'active') return undefined;
        // Silinen belgeden DAHA YENİ aktif ayna: belge bu arada yeniden oluşturulmuş (share_start). Dokunma.
        if (before && typeof before.version === 'number' && cur.version > before.version) return undefined;
        closed = cur;
        // Sürüm ARTIRILMAZ: yeniden oluşturulan paylaşım max(belge, ACL) + 1 ile her zaman bunu geçer.
        return { status: 'ended', version: Math.max(cur.version, before?.version ?? 0), ended_at: now } satisfies StoredAcl;
      },
      undefined,
      false,
    );
  const prev = closed as StoredAcl | null;
  if (res.committed && prev) {
    const receiver = before?.receiver_id ?? prev.receiver_id;
    if (receiver) await removeLiveCopy(receiver, id);
  }
  if (!before) {
    // Tetikleyici dışı çağrı: ilk okuma ile transaction arasında belge yeniden oluşturulduysa güncel hâli uygula.
    const again = await refs.shareById(id).get();
    if (again.exists) {
      await applyShareEffect(again.data() as ShareDoc);
      return;
    }
  }
  await clearAclPending(id, Number.MAX_SAFE_INTEGER);
}

/**
 * Mevcut ACL sürümleri. `share_start` yeni sürümü max(belge, ACL) + 1 seçer: paylaşım belgesi
 * TTL ile silinip yeniden oluşturulsa bile sürüm geri gitmez (ayna yazması reddedilmez).
 */
export async function readAclVersions(shareIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    shareIds.map(async (id) => {
      const snap = await rtdb().ref(`${PATHS.shareAcl(id)}/version`).once('value');
      const v = snap.val();
      if (typeof v === 'number') out.set(id, v);
    }),
  );
  return out;
}

/**
 * ACL düğümünü tamamen siler (hesap silme: uid çifti tutulmaz). Aktif düğüme dokunmaz (yarış: önce uzlaştır).
 * Sonuç: silindi mi.
 */
export async function deleteAclNode(id: string): Promise<boolean> {
  let removed = false;
  const res = await rtdb()
    .ref(PATHS.shareAcl(id))
    .transaction(
      (cur: StoredAcl | null) => {
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
