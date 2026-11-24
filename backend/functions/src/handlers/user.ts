/**
 * Hesap: user_bootstrap, invite_code_regenerate, account_delete; pasif hesap süreci (geri dönüştürülmüş numara).
 *
 * 2nd gen'de Auth `onCreate` tetikleyicisi olmadığı için ilk girişte istemci `user_bootstrap` çağırır.
 * [Varsayım: doğrulanmalı] (Identity Platform blocking function'ları ayrı bir seçenek.)
 * Uygulama her açılışta (oturum durumu değişince) `user_bootstrap` çağırır: bu çağrı aynı zamanda etkinlik
 * kalp atışıdır (`users.last_active_at`).
 */
import {
  CALLABLES,
  DAY,
  E164_RE,
  type EpochMs,
  PATHS,
  generateInviteCode,
} from '@konum/core';
import { type Query, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { applyShareEffects, deleteAclNode, reconcileShare } from '../acl';
import { adminAuth, db, rtdb } from '../admin';
import type { CallCtx } from '../callable';
import { DEFAULT_DISPLAY_NAME, LIMITS, avatarBuckets } from '../config';
import {
  COL,
  type DeletedUserDoc,
  type FriendshipDoc,
  type IndexDoc,
  type InactivityState,
  type UserDoc,
  type UserPrivateDoc,
  isUsableProfile,
  publicProfile,
  purgeAt,
  refs,
} from '../docs';
import { fail } from '../errors';
import { needsProfile } from '../graph';
import { activeShareIdsOf, endSharesById } from '../lifecycle';
import { applyLinkEffects, deleteLinkAclNode, reconcileLink } from '../linkAcl';
import { activeLinkIdsOf, endLinksById } from './links';
import { deletePlaceNotesOf } from './notes';
import { deletePingsOf } from './ping';
import { closeSosForDeletedAccount, removeFromEmergencyContacts } from './sos';
import { deleteMeetupsOf } from './meetup';
import { deleteZonesOf } from './zones';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import type {
  AccountDeleteResponse,
  AccountDeleteSchema,
  InviteCodeRegenerateResponse,
  InviteCodeRegenerateSchema,
  UserBootstrapResponse,
  UserBootstrapSchema,
} from '../schemas';
import { isAlreadyExists, nodeRandom } from '../util';

// ---------------------------------------------------------------------------
// avatar adresi
// ---------------------------------------------------------------------------

/**
 * Yalnızca projenin Storage kovasındaki `avatars/{uid}/...` nesnesi:
 * `https://firebasestorage.googleapis.com/v0/b/{kova}/o/avatars%2F{uid}%2F{dosya}?alt=media&token=...`.
 * [Varsayım: doğrulanmalı] Storage kuralları `avatars/{uid}/**` yazmasını yalnızca sahibine açmalı (Faz 1'de
 * istemci avatar yüklemiyor; bu kapı sonraki sürüm için).
 */
export function assertAvatarUrl(url: string, uid: string): void {
  const bad = () => fail('invalid_argument', { message: 'Avatar adresi geçersiz', extra: { field: 'avatar_url' } });
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw bad();
  }
  if (u.protocol !== 'https:' || u.hostname !== 'firebasestorage.googleapis.com' || u.port || u.username || u.password) throw bad();
  const m = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(u.pathname);
  if (!m?.[1] || !m[2]) throw bad();
  let bucket: string;
  let object: string;
  try {
    bucket = decodeURIComponent(m[1]);
    object = decodeURIComponent(m[2]);
  } catch {
    throw bad();
  }
  if (!avatarBuckets().includes(bucket)) throw bad();
  const prefix = `avatars/${uid}/`;
  const file = object.slice(prefix.length);
  if (!object.startsWith(prefix) || !/^[A-Za-z0-9._-]{1,100}$/.test(file) || file.includes('..')) throw bad();
}

// ---------------------------------------------------------------------------
// user_bootstrap
// ---------------------------------------------------------------------------

/**
 * İdempotent: `users/{uid}`, `users_private/{uid}.phone_e164` (kimlik belirtecinden),
 * `phone_index/{e164}` ve `invite_codes/{code}` tek transaction'da. Kod tekilliğini `create()` garanti eder;
 * `ALREADY_EXISTS` olursa yeni kodla yeniden denenir.
 * Silinmiş hesabın (hâlâ geçerli ID token'ı ile) profili yeniden oluşturulamaz (`deleted_users`).
 */
export async function userBootstrap(ctx: CallCtx, data: z.output<typeof UserBootstrapSchema>): Promise<UserBootstrapResponse> {
  const phone = ctx.phone_e164;
  if (!phone || !E164_RE.test(phone)) throw fail('unauthenticated', { message: 'Telefon doğrulaması gerekli' });
  if (data.avatar_url) assertAvatarUrl(data.avatar_url, ctx.uid);

  // Geri dönüştürülmüş numara savunması: uzun süre pasif kalmış hesaba girişte önce sosyal grafik / gelen
  // paylaşımlar kesilir (zamanlanmış iş henüz çalışmadıysa). Ayrıntı: `sweepInactive`.
  await guardDormantAccount(ctx);

  for (let attempt = 1; ; attempt++) {
    const code = generateInviteCode(nodeRandom);
    try {
      const res = await db().runTransaction(async (tx) => {
        const [userSnap, privSnap, phoneSnap, deletedSnap] = await tx.getAll(
          refs.user(ctx.uid),
          refs.userPrivate(ctx.uid),
          refs.phoneIndex(phone),
          refs.deletedUser(ctx.uid),
        );
        if (deletedSnap?.exists) throw fail('unauthenticated', { message: 'Hesap silindi' });
        const priv = privSnap?.data() as UserPrivateDoc | undefined;
        // Telefon değiştiyse eski indeks yalnızca bana aitse silinir.
        const oldIdxSnap = priv && priv.phone_e164 !== phone ? await tx.get(refs.phoneIndex(priv.phone_e164)) : null;
        let user = userSnap?.data() as UserDoc | undefined;
        if (user?.deleting) throw fail('unauthenticated', { message: 'Hesap silindi' });
        const needsCode = !user?.invite_code;

        // --- yazmalar ---
        let created = false;
        let profileChanged = false;
        if (!user) {
          user = {
            user_id: ctx.uid,
            display_name: data.display_name ?? DEFAULT_DISPLAY_NAME,
            avatar_url: data.avatar_url ?? null,
            invite_code: code,
            created_at: ctx.now,
            rtdb_instance: 0,
            last_active_at: ctx.now,
            inactivity_state: 'active',
          };
          tx.create(refs.user(ctx.uid), user);
          created = true;
        } else {
          const patch: Partial<UserDoc> = {};
          if (data.display_name !== undefined && data.display_name !== user.display_name) patch.display_name = data.display_name;
          if (data.avatar_url !== undefined && data.avatar_url !== user.avatar_url) patch.avatar_url = data.avatar_url;
          if (needsCode) patch.invite_code = code;
          // Kalp atışı: en çok saatte bir yazılır. [Varsayım]
          if (user.inactivity_state !== 'active' || !user.last_active_at || ctx.now - user.last_active_at >= LIMITS.lastActiveWriteEveryMs) {
            patch.last_active_at = ctx.now;
            patch.inactivity_state = 'active';
          }
          if (Object.keys(patch).length > 0) {
            tx.update(refs.user(ctx.uid), patch);
            user = { ...user, ...patch };
            profileChanged = patch.display_name !== undefined || patch.avatar_url !== undefined;
          }
        }
        if (needsCode) tx.create(refs.inviteCode(code), { user_id: ctx.uid, created_at: ctx.now } satisfies IndexDoc);

        const authTime = ctx.auth_time ?? priv?.last_auth_time;
        if (!priv || priv.phone_e164 !== phone || (authTime !== undefined && authTime !== priv.last_auth_time)) {
          const next: UserPrivateDoc = { phone_e164: phone, created_at: priv?.created_at ?? ctx.now, updated_at: ctx.now };
          if (authTime !== undefined && authTime !== null) next.last_auth_time = authTime;
          tx.set(refs.userPrivate(ctx.uid), next);
        }
        if (oldIdxSnap?.exists && (oldIdxSnap.data() as IndexDoc).user_id === ctx.uid) tx.delete(oldIdxSnap.ref);
        const idx = phoneSnap?.data() as IndexDoc | undefined;
        // [Varsayım] Numara başka bir (silinmiş / eski) hesaba işaret ediyorsa yeni hesaba devredilir:
        // Firebase Auth'ta bir numara aynı anda tek hesaptadır.
        if (!idx || idx.user_id !== ctx.uid) tx.set(refs.phoneIndex(phone), { user_id: ctx.uid, created_at: ctx.now } satisfies IndexDoc);

        return { user, created, profileChanged };
      });
      if (res.profileChanged) await propagateProfile(ctx.uid, res.user);
      return { user: toProfile(res.user), created: res.created, server_now: ctx.now };
    } catch (err) {
      if (isAlreadyExists(err) && attempt < LIMITS.inviteCodeAttempts) continue;
      throw err;
    }
  }
}

/** Yanıttaki profil: core UserProfile alanları (sunucu alanları istemci sözleşmesine sızmaz). */
function toProfile(u: UserDoc) {
  return {
    user_id: u.user_id,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    invite_code: u.invite_code,
    created_at: u.created_at,
    rtdb_instance: u.rtdb_instance,
  };
}

/** Görünen ad değişince KABUL EDİLMİŞ arkadaşlık belgelerindeki kopya güncellenir (en iyi çaba). */
async function propagateProfile(uid: string, user: UserDoc): Promise<void> {
  try {
    const snap = await db().collection(COL.friendships).where('member_ids', 'array-contains', uid).get();
    const writer = db().bulkWriter();
    for (const d of snap.docs) {
      const f = d.data() as FriendshipDoc;
      if (f.status === 'accepted') {
        void writer.update(d.ref, { [`member_profiles.${uid}`]: publicProfile(user) });
      } else if (f.requested_by === uid) {
        // Bekleyen istekte isteyenin yalnızca adı (avatar kabulde).
        void writer.update(d.ref, { [`member_profiles.${uid}.display_name`]: user.display_name });
      }
      // Bekleyen istekte hedefin profili bilerek yoktur (kabulde eklenir).
    }
    await writer.close();
  } catch (err) {
    logger.warn('profil kopyası güncellenemedi', { err: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Pasif hesap (geri dönüştürülmüş numara, BACKEND_SPEC risk #3)
// ---------------------------------------------------------------------------

async function deleteQuery(q: Query): Promise<number> {
  const snap = await q.get();
  if (snap.empty) return 0;
  const writer = db().bulkWriter();
  for (const d of snap.docs) void writer.delete(d.ref);
  await writer.close();
  return snap.size;
}

/** Hesabın cihazı yakın zamanda konum yayınladı mı (aktif giden paylaşımın son paketi)? */
async function publishedRecently(uid: string, now: EpochMs): Promise<boolean> {
  const out = await db().collection(COL.shares).where('sender_id', '==', uid).where('status', '==', 'active').get();
  for (const d of out.docs) {
    const s = d.data() as { receiver_id: string; share_id: string };
    const ts = (await rtdb().ref(`${PATHS.liveInbox(s.receiver_id)}/${s.share_id}/server_ts`).once('value')).val();
    if (typeof ts === 'number' && now - ts < LIMITS.recentPublishMs) return true;
  }
  return false;
}

async function setInactivityState(uid: string, state: InactivityState): Promise<void> {
  try {
    await refs.user(uid).update({ inactivity_state: state });
  } catch (err) {
    if ((err as { code?: number }).code !== 5) throw err; // 5 = NOT_FOUND (profil yok)
  }
}

/** Pasif alıcı: gelen aktif paylaşımlar biter. [Varsayım] neden `expired` (core'da `receiver_inactive` yok). */
export async function cutIncomingShares(uid: string, now: EpochMs): Promise<number> {
  const inc = await db().collection(COL.shares).where('receiver_id', '==', uid).where('status', '==', 'active').get();
  const ended = await endSharesById(inc.docs.map((d) => d.id), (s) => (s.status === 'active' ? 'expired' : null), now);
  await applyShareEffects(ended);
  return ended.length;
}

/**
 * Sosyal grafiği sıfırlar: arkadaşlıklar ve giden istekler silinir, iki yöndeki paylaşımlar
 * `friendship_removed` ile biter, bekleyen konum istekleri iptal olur. İdempotent.
 */
export async function resetSocialGraph(uid: string, now: EpochMs): Promise<void> {
  await deleteQuery(db().collection(COL.friendships).where('member_ids', 'array-contains', uid));
  await Promise.all([
    deleteQuery(db().collection(COL.outgoingLinks).where('requester_id', '==', uid)),
    db().recursiveDelete(refs.outgoingRequests(uid)),
  ]);
  const ended = await endSharesById(await activeShareIdsOf(uid), (s) => (s.status === 'active' ? 'friendship_removed' : null), now);
  await applyShareEffects(ended);
  const requests = db().collection(COL.requests);
  const pending = await Promise.all([
    requests.where('requester_id', '==', uid).where('status', '==', 'pending').get(),
    requests.where('target_id', '==', uid).where('status', '==', 'pending').get(),
  ]);
  const writer = db().bulkWriter();
  for (const d of pending.flatMap((s) => s.docs)) {
    void writer.update(d.ref, { status: 'cancelled', updated_at: now, purge_at: purgeAt(now) });
  }
  await writer.close();
  await setInactivityState(uid, 'graph_reset');
}

/**
 * user_bootstrap öncesi: hesap 180 günden uzun pasifse sosyal grafik sıfırlanır; 30 günden uzun pasifse VE
 * bu yeni bir SMS girişiyse (auth_time ilerledi) gelen paylaşımlar kesilir. [Varsayım: ürün onayı gerekli]
 */
async function guardDormantAccount(ctx: CallCtx): Promise<void> {
  const [userSnap, privSnap] = await db().getAll(refs.user(ctx.uid), refs.userPrivate(ctx.uid));
  const user = userSnap?.data() as UserDoc | undefined;
  if (!user) return;
  const lastActive = user.last_active_at ?? user.created_at;
  const idle = ctx.now - lastActive;
  const state = user.inactivity_state ?? 'active';
  if (idle >= LIMITS.inactiveGraphResetMs && state !== 'graph_reset' && !(await publishedRecently(ctx.uid, ctx.now))) {
    logger.info('pasif hesaba giriş: sosyal grafik sıfırlanıyor', { uid: ctx.uid, idle_days: Math.floor(idle / DAY) });
    await resetSocialGraph(ctx.uid, ctx.now);
    return;
  }
  const priv = privSnap?.data() as UserPrivateDoc | undefined;
  const freshSignIn = ctx.auth_time != null && priv?.last_auth_time != null && ctx.auth_time > priv.last_auth_time;
  if (idle >= LIMITS.inactiveIncomingCutMs && state === 'active' && freshSignIn) {
    logger.info('pasif hesaba yeni SMS girişi: gelen paylaşımlar kesiliyor', { uid: ctx.uid });
    await cutIncomingShares(ctx.uid, ctx.now);
  }
}

/**
 * Günlük pasif hesap taraması (zamanlanmış iş; testler `now` enjekte eder).
 *  - 30 gün: `active` → gelen paylaşımlar biter → `incoming_cut`.
 *  - 180 gün: `incoming_cut` → (yakın zamanda yayın yoksa) sosyal grafik sıfırlanır → `graph_reset`.
 */
export async function sweepInactive(opts: { now?: EpochMs; batch?: number } = {}): Promise<{ cut: string[]; reset: string[] }> {
  const now = opts.now ?? Date.now();
  const batch = opts.batch ?? LIMITS.inactiveSweepBatch;
  const out = { cut: [] as string[], reset: [] as string[] };
  const users = db().collection(COL.users);

  const cut = await users
    .where('inactivity_state', '==', 'active')
    .where('last_active_at', '<=', now - LIMITS.inactiveIncomingCutMs)
    .orderBy('last_active_at')
    .limit(batch)
    .get();
  for (const d of cut.docs) {
    await cutIncomingShares(d.id, now);
    await setInactivityState(d.id, 'incoming_cut');
    out.cut.push(d.id);
  }

  const reset = await users
    .where('inactivity_state', '==', 'incoming_cut')
    .where('last_active_at', '<=', now - LIMITS.inactiveGraphResetMs)
    .orderBy('last_active_at')
    .limit(batch)
    .get();
  for (const d of reset.docs) {
    if (await publishedRecently(d.id, now)) continue; // cihaz hâlâ yayında: pasif sayılmaz
    await resetSocialGraph(d.id, now);
    out.reset.push(d.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// invite_code_regenerate
// ---------------------------------------------------------------------------

export async function inviteCodeRegenerate(
  ctx: CallCtx,
  data: z.output<typeof InviteCodeRegenerateSchema>,
): Promise<InviteCodeRegenerateResponse> {
  for (let attempt = 1; ; attempt++) {
    const code = generateInviteCode(nodeRandom);
    try {
      return await runOp(ctx, data.op_id, CALLABLES.inviteCodeRegenerate, data, async (tx) => {
        const userSnap = await tx.get(refs.user(ctx.uid));
        const user = userSnap.data() as UserDoc | undefined;
        if (!isUsableProfile(user)) throw needsProfile();
        const rl = await readRateLimit(tx, ctx.uid, 'invite_regenerate', LIMITS.inviteRegeneratePerDay, DAY, ctx.now);
        const old = user.invite_code;
        const oldSnap = old ? await tx.get(refs.inviteCode(old)) : null;

        tx.create(refs.inviteCode(code), { user_id: ctx.uid, created_at: ctx.now } satisfies IndexDoc);
        if (oldSnap?.exists && (oldSnap.data() as IndexDoc).user_id === ctx.uid) tx.delete(oldSnap.ref);
        tx.update(refs.user(ctx.uid), { invite_code: code });
        writeRateLimit(tx, rl, DAY);
        return { response: { invite_code: code, server_now: ctx.now } };
      });
    } catch (err) {
      if (isAlreadyExists(err) && attempt < LIMITS.inviteCodeAttempts) continue;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// account_delete (kademeli silme)
// ---------------------------------------------------------------------------

/**
 * Doğası gereği idempotenttir; `ops` kaydı TUTULMAZ (silinen hesaba ait kayıt bırakmamak için).
 *
 * Sıra (yarışsız):
 *  1. Çit: `deleted_users/{uid}` + `users/{uid}.deleting` → yeni paylaşım/istek/engel ve hayalet profil yok;
 *     yenileme token'ları iptal edilir (ID token en çok ~1 sa geçerli kalır, okuyacağı veri kalmaz).
 *  2. Arkadaşlıklar ÖNCE silinir: eşzamanlı bir share_start transaction'ı ya bu silmeden önce serileşir
 *     (paylaşımı 3. adımdaki sorgu bulur) ya sonra (arkadaşlık yok → atlanır).
 *  3. İki yöndeki aktif paylaşımlar `account_deleted` ile biter → ACL mezar taşı → canlı kopya; sorgu bir kez
 *     daha tekrarlanır (geç kalanlar). Gelen kutusu silinir.
 *  4. İstekler, kendi engelleri, op kayıtları, cihazlar, giden istekler.
 *  5. Bu hesabın tüm `share_acl` düğümleri silinir (uid çifti tutulmaz).
 *  6. Profil, gizli telefon, indeksler → Auth kullanıcısı.
 *
 * Faz 2: 3. adımda aktif bağlantılar (QR) `account_deleted` ile biter → `link_acl` kapanır → `link_live` silinir
 * (açık web sekmesi "Paylaşım sona erdi" görür). 5. adımda `link_acl` düğümleri, `link_shares` belgeleri ve
 * işaretleri silinir (karşı taraf yok, geçmiş tutulmaz); `maps_quota` sayaçları ve kullanıcıya özel `route_cache`
 * kayıtları da silinir. Ortak `geocode_cache` hücre kayıtları kimseye bağlı değildir ve kalır.
 *
 * Bilerek KALANLAR [Varsayım: hukuki onay gerekli]:
 *  - Biten paylaşım belgeleri karşı tarafın geçmişi için TTL'e (7 gün) kadar kalır.
 *  - BAŞKALARININ bu hesap hakkındaki engelleri (`blocks/{diğer}_{uid}` ve telefon HMAC'i): engelleyenin
 *    güvenlik verisidir; silinirse engellenen hesabı silip aynı numarayla yeniden kayıt olarak engeli aşardı.
 */
export async function accountDelete(ctx: CallCtx, _data: z.output<typeof AccountDeleteSchema>): Promise<AccountDeleteResponse> {
  const uid = ctx.uid;
  const now = ctx.now;

  // 1. Çit
  await db().runTransaction(async (tx) => {
    const u = await tx.get(refs.user(uid));
    tx.set(refs.deletedUser(uid), { deleted_at: now, purge_at: Timestamp.fromMillis(now + LIMITS.deletedUserTtlMs) } satisfies DeletedUserDoc);
    if (u.exists) tx.update(refs.user(uid), { deleting: true });
  });
  try {
    await adminAuth().revokeRefreshTokens(uid);
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  }

  // 2. Arkadaşlıklar (bekleyenler dahil) ve giden istekler
  await Promise.all([
    deleteQuery(db().collection(COL.friendships).where('member_ids', 'array-contains', uid)),
    deleteQuery(db().collection(COL.outgoingLinks).where('requester_id', '==', uid)),
    db().recursiveDelete(refs.outgoingRequests(uid)),
  ]);

  // 3. Paylaşımlar (iki geçiş: geç kalan eşzamanlı başlatmalar için)
  for (let pass = 0; pass < 2; pass++) {
    const ids = await activeShareIdsOf(uid);
    if (ids.length === 0) break;
    const ended = await endSharesById(ids, (s) => (s.status === 'active' ? 'account_deleted' : null), now);
    await applyShareEffects(ended);
  }
  // Gelen kutusu + Faz 3 gelen iz düğümü (giden izler paylaşım bitişinde removeLiveCopy ile silindi).
  await rtdb()
    .ref()
    .update({ [PATHS.liveInbox(uid)]: null, [`live_trail/${uid}`]: null });

  // 3b. Faz 2: bağlantılar (iki geçiş, aynı nedenle)
  for (let pass = 0; pass < 2; pass++) {
    const ids = await activeLinkIdsOf(uid);
    if (ids.length === 0) break;
    const ended = await endLinksById(ids, (l) => (l.status === 'active' ? 'account_deleted' : null), now);
    await applyLinkEffects(ended);
  }

  // 4. Diğer kayıtlar
  const requests = db().collection(COL.requests);
  await Promise.all([
    deleteQuery(requests.where('requester_id', '==', uid)),
    deleteQuery(requests.where('target_id', '==', uid)),
    deleteQuery(db().collection(COL.blocks).where('blocker_id', '==', uid)),
    deleteQuery(db().collection(COL.phoneBlocks).where('blocker_id', '==', uid)),
    deleteQuery(db().collection(COL.ops).where('uid', '==', uid)),
    db().recursiveDelete(db().collection(COL.devices).doc(uid)),
    deleteQuery(db().collection(COL.mapsQuota).where('uid', '==', uid)),
    deleteQuery(db().collection(COL.routeCache).where('uid', '==', uid)),
    // Faz 3: düşük pil bildirimi durumları
    deleteQuery(db().collection(COL.batteryAlerts).where('uid', '==', uid)),
    // Faz 4: yer notları (kendi notları silinir, başkalarının not kitlesinden çıkar), ping kutusu + gönderdiği
    // pingler, aktif SOS'lar (`account_deleted`), başkalarının acil kişi listelerinden çıkarılma.
    deletePlaceNotesOf(uid),
    deletePingsOf(uid),
    closeSosForDeletedAccount(uid, now),
    removeFromEmergencyContacts(uid),
    // Faz 5: bölgeler + olay kaydı + soğuma belgeleri; gönderdiği buluşma önerileri ve öneri önbelleği silinir,
    // aldığı önerilerin alıcı listesinden çıkar.
    deleteZonesOf(uid),
    deleteMeetupsOf(uid),
  ]);

  // 5. ACL düğümleri (mezar taşları dahil): uid çifti RTDB'de kalmaz.
  const shares = db().collection(COL.shares);
  const [sent, recv] = await Promise.all([shares.where('sender_id', '==', uid).get(), shares.where('receiver_id', '==', uid).get()]);
  for (const d of [...sent.docs, ...recv.docs]) {
    if (!(await deleteAclNode(d.id))) {
      // Hâlâ aktif görünen düğüm: önce belgeden uzlaştır (bitmiş olmalı), sonra sil.
      await reconcileShare(d.id);
      await deleteAclNode(d.id);
    }
    await refs.aclPending(d.id).delete();
  }

  // 5b. Faz 2: bağlantı ACL düğümleri (mezar taşları dahil), işaretler ve belgeler.
  const links = await db().collection(COL.linkShares).where('sender_id', '==', uid).get();
  for (const d of links.docs) {
    const hash = (d.data() as { token_hash?: string }).token_hash;
    if (hash && !(await deleteLinkAclNode(hash))) {
      await reconcileLink(d.id);
      await deleteLinkAclNode(hash);
    }
    await refs.linkAclPending(d.id).delete();
    await d.ref.delete();
  }

  // 6. Profil ve indeksler
  const [userSnap, privSnap] = await db().getAll(refs.user(uid), refs.userPrivate(uid));
  const user = userSnap?.data() as UserDoc | undefined;
  const priv = privSnap?.data() as UserPrivateDoc | undefined;
  await db().runTransaction(async (tx) => {
    const [codeSnap, phoneSnap] = await tx.getAll(
      refs.inviteCode(user?.invite_code || '_'),
      refs.phoneIndex(priv?.phone_e164 || ctx.phone_e164 || '_'),
    );
    if (codeSnap?.exists && (codeSnap.data() as IndexDoc).user_id === uid) tx.delete(codeSnap.ref);
    if (phoneSnap?.exists && (phoneSnap.data() as IndexDoc).user_id === uid) tx.delete(phoneSnap.ref);
    tx.delete(refs.user(uid));
    tx.delete(refs.userPrivate(uid));
    for (const key of ['friend_request', 'location_request', 'invite_regenerate', 'link_create', 'battery_low', 'ping', 'sos_send', 'zone_event', 'meetup_share', 'meetup_respond']) tx.delete(refs.rateLimit(uid, key));
  });

  try {
    await adminAuth().deleteUser(uid);
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  }
  return { status: 'deleted', server_now: now };
}
