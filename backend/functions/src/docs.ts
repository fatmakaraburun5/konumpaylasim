/**
 * Firestore belge şekilleri (core `model.ts` + yalnızca sunucunun kullandığı ek alanlar) ve referanslar.
 *
 * Ek alanlar:
 *  - `updated_at` (epoch ms): son değişiklik anı.
 *  - `purge_at` (Firestore Timestamp): TTL politikası alanı. Firestore TTL yalnızca Timestamp türünü
 *    kabul ettiği için "tüm zamanlar epoch ms" kuralının TEK istisnasıdır; istemci bu alanı okumaz.
 *
 * Yalnızca sunucuya açık ek koleksiyonlar (kurallarda izin yok):
 *  - `acl_pending/{share_id}`            ACL aynası henüz uygulanmamış paylaşım sürümü (uzlaştırıcı işareti)
 *  - `deleted_users/{uid}`               silinen hesap (hayalet profil ve geç çağrı engeli)
 *  - `phone_blocks/{blocker}_{hmac}`     engellenen telefonun HMAC'i (hesap silip yeniden kayıtla engeli aşmayı keser)
 *  - `outgoing_request_links/{uid}_{oid}` giden istek kaydı → arkadaşlık belgesi (hedef uid'i içerdiği için gizli)
 *  - Faz 2: `link_acl_pending/{link_id}`   bağlantı ACL aynası henüz uygulanmamış sürüm (`acl_pending` ile aynı görev)
 *  - Faz 2: `route_cache/{key}`, `geocode_cache/{cell}` Google yanıt önbellekleri (`expire_at` TTL)
 *  - Faz 2: `maps_quota/{uid}_{gün}`, `maps_budget/{gün}_{parça}` günlük Maps sayaçları; `config/maps` bütçe / kapatma
 *  - Faz 3: `battery_alerts/{uid}_{session_id}` düşük pil bildirimi durumu (bir kez / yeniden kurma; `purge_at` TTL)
 *
 * Faz 2'de gönderenin okuyabildiği koleksiyon:
 *  - `link_shares/{link_id}` bağlantı (QR) paylaşımları (yalnızca `sender_id == ben` sorgusuyla)
 *
 * İstemcinin okuyabildiği ek koleksiyon:
 *  - `users/{uid}/outgoing_requests/{oid}` giden arkadaşlık istekleri (maskeli etiket; hedef uid'i YOK)
 */
import {
  type EpochMs,
  type Friendship,
  type LinkEndReason,
  type LinkShare,
  type LinkShareView,
  type LocationRequest,
  type LocationShare,
  type OutgoingShareView,
  type PublicProfile,
  type UserId,
  type UserProfile,
  PATHS,
  blockId,
  friendshipId,
  requestId,
  shareId,
} from '@konum/core';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from './admin';
import { LIMITS } from './config';

export interface ShareDoc extends LocationShare {
  updated_at: EpochMs;
  purge_at?: Timestamp | null;
  /** Faz 3: duraksama bekçisinin dürtme kaydı (yalnızca sunucu yazar; sürüm DEĞİŞMEZ). */
  stall_nudges?: StallNudges | null;
}

/**
 * Faz 3 duraksama dönemi kaydı (`location_shares/{id}.stall_nudges`). Yeni bir paket (`last_seen_ts` değişti)
 * dönemi kapatır; bir sonraki duraksama sayacı sıfırdan başlatır.
 */
export interface StallNudges {
  /** Bu dönemde gönderilen dürtme sayısı (sessiz + görünür). */
  count: number;
  /** Görünür bildirim sayısı. */
  visible: number;
  first_at: EpochMs;
  last_at: EpochMs;
  /** Dönem başındaki son paketin `server_ts` değeri (paket yoksa `started_at`). */
  last_seen_ts: EpochMs;
  /** Gönderen yeniden yayınladı (dönem kapandı). */
  recovered_at?: EpochMs | null;
}

/**
 * Faz 3 `battery_alerts/{uid}_{session_id}`: düşük pil tetikleyicisinin SUNUCU durumu (core `LowBatteryState`
 * + kimlikler). Yalnızca sunucu okur/yazar.
 */
export interface BatteryAlertDoc {
  uid: UserId;
  session_id: string;
  armed: boolean;
  fired_at: EpochMs | null;
  fired: number;
  last_pct: number | null;
  /** Son 24 saatteki bildirim anları (günlük tavan). */
  recent_fired_at: EpochMs[];
  updated_at: EpochMs;
  purge_at: Timestamp;
}

export interface FriendshipDoc extends Friendship {
  accepted_at: EpochMs | null;
  /**
   * İsteğin hedefi (isteyen OLMAYAN üye). Bekleyen istek yalnızca hedefe görünür; sorgu:
   * `target_id == ben && status == 'pending'`. (core Friendship'te yok → core_requests)
   */
  target_id?: UserId;
}

export type InactivityState = 'active' | 'incoming_cut' | 'graph_reset';

/** `users/{uid}`: core UserProfile + sunucu alanları (sahibi okur). */
export interface UserDoc extends UserProfile {
  /** Son uygulama etkinliği (user_bootstrap kalp atışı). */
  last_active_at?: EpochMs;
  /** Pasif hesap süreci (geri dönüştürülmüş numara savunması). */
  inactivity_state?: InactivityState;
  /** account_delete başladı: yeni paylaşım/istek kabul edilmez. */
  deleting?: boolean;
}

export interface BlockDoc {
  blocker_id: UserId;
  blocked_id: UserId;
  created_at: EpochMs;
}

export interface PhoneBlockDoc {
  blocker_id: UserId;
  /** `blocks/{blocker}_{blocked}` kimliği (engel kaldırılınca birlikte silinir). */
  block_id: string;
  created_at: EpochMs;
}

export interface RequestDoc extends LocationRequest {
  updated_at: EpochMs;
  purge_at?: Timestamp | null;
}

export interface UserPrivateDoc {
  phone_e164: string;
  created_at: EpochMs;
  updated_at: EpochMs;
  /** Kimlik belirtecindeki son `auth_time` (epoch ms): yeni SMS girişini ayırt etmek için. */
  last_auth_time?: EpochMs;
}

/** `phone_index/{e164}` ve `invite_codes/{code}`. */
export interface IndexDoc {
  user_id: UserId;
  created_at: EpochMs;
}

export interface DeviceTokenDoc {
  token: string;
  platform: 'ios' | 'android';
  updated_at: EpochMs;
}

/** İstemciye açık giden istek kaydı: hedef kayıtlı olsun olmasın, engelli olsun olmasın AYNI şekil. */
export interface OutgoingRequestDoc {
  id: string;
  via: 'invite_code' | 'phone';
  /** Maskeli telefon (`+90 5•• ••• 45 67`) ya da davet kodu (`LOC-7KQ 2MX`). */
  label: string;
  created_at: EpochMs;
  expires_at: EpochMs;
  purge_at: Timestamp;
}

/** Sunucuya özel: giden istek → arkadaşlık belgesi (yalnızca belge gerçekten bu istekle oluştuysa). */
export interface OutgoingLinkDoc {
  requester_id: UserId;
  outgoing_id: string;
  friendship_id: string | null;
  created_at: EpochMs;
  purge_at: Timestamp;
}

export interface AclPendingDoc {
  share_id: string;
  version: number;
  updated_at: EpochMs;
}

/** `link_shares/{link_id}`: core LinkShare + sunucu alanları. Düz token SAKLANMAZ. */
export interface LinkShareDoc extends LinkShare {
  updated_at: EpochMs;
  purge_at?: Timestamp | null;
}

/**
 * `link_acl_pending/{link_id}`: bağlantı ACL aynası bu sürüme gelene kadar duran işaret.
 * `stale_token_hash`: token yenilendiyse (yanıtı kaybolan oluşturma tekrarı) kapatılması gereken eski özet.
 */
export interface LinkAclPendingDoc {
  link_id: string;
  version: number;
  updated_at: EpochMs;
  stale_token_hash?: string;
}

export interface DeletedUserDoc {
  deleted_at: EpochMs;
  purge_at: Timestamp;
}

export const COL = {
  users: 'users',
  usersPrivate: 'users_private',
  phoneIndex: 'phone_index',
  inviteCodes: 'invite_codes',
  friendships: PATHS.friendships,
  blocks: 'blocks',
  phoneBlocks: 'phone_blocks',
  shares: PATHS.shares,
  requests: PATHS.requests,
  ops: 'ops',
  rateLimits: 'rate_limits',
  devices: 'devices',
  aclPending: 'acl_pending',
  deletedUsers: 'deleted_users',
  outgoingRequests: 'outgoing_requests',
  outgoingLinks: 'outgoing_request_links',
  // Faz 2
  linkShares: PATHS.linkShares,
  linkAclPending: 'link_acl_pending',
  routeCache: 'route_cache',
  geocodeCache: 'geocode_cache',
  mapsQuota: 'maps_quota',
  mapsBudget: 'maps_budget',
  config: 'config',
  // Faz 3
  batteryAlerts: 'battery_alerts',
} as const;

export const refs = {
  user: (uid: UserId) => db().collection(COL.users).doc(uid),
  userPrivate: (uid: UserId) => db().collection(COL.usersPrivate).doc(uid),
  phoneIndex: (e164: string) => db().collection(COL.phoneIndex).doc(e164),
  inviteCode: (code: string) => db().collection(COL.inviteCodes).doc(code),
  friendship: (a: UserId, b: UserId) => db().collection(COL.friendships).doc(friendshipId(a, b)),
  friendshipById: (id: string) => db().collection(COL.friendships).doc(id),
  block: (blocker: UserId, blocked: UserId) => db().collection(COL.blocks).doc(blockId(blocker, blocked)),
  phoneBlock: (blocker: UserId, phoneHmac: string) => db().collection(COL.phoneBlocks).doc(`${blocker}_${phoneHmac}`),
  share: (sender: UserId, receiver: UserId) => db().collection(COL.shares).doc(shareId(sender, receiver)),
  shareById: (id: string) => db().collection(COL.shares).doc(id),
  request: (requester: UserId, target: UserId) => db().collection(COL.requests).doc(requestId(requester, target)),
  requestById: (id: string) => db().collection(COL.requests).doc(id),
  op: (uid: UserId, opId: string) => db().collection(COL.ops).doc(`${uid}_${opId}`),
  rateLimit: (uid: UserId, key: string) => db().collection(COL.rateLimits).doc(`${uid}_${key}`),
  deviceTokens: (uid: UserId) => db().collection(PATHS.deviceTokens(uid)),
  aclPending: (id: string) => db().collection(COL.aclPending).doc(id),
  deletedUser: (uid: UserId) => db().collection(COL.deletedUsers).doc(uid),
  outgoingRequests: (uid: UserId) => refs.user(uid).collection(COL.outgoingRequests),
  outgoingRequest: (uid: UserId, oid: string) => refs.user(uid).collection(COL.outgoingRequests).doc(oid),
  outgoingLink: (uid: UserId, oid: string) => db().collection(COL.outgoingLinks).doc(`${uid}_${oid}`),
  // Faz 2
  linkShare: (id: string) => db().doc(PATHS.linkShare(id)),
  newLinkShare: () => db().collection(COL.linkShares).doc(),
  linkAclPending: (id: string) => db().collection(COL.linkAclPending).doc(id),
  routeCache: (key: string) => db().doc(PATHS.routeCache(key)),
  geocodeCache: (cell: string) => db().doc(PATHS.geocodeCache(cell)),
  mapsQuota: (uid: UserId, day: string) => db().doc(PATHS.mapsQuota(uid, day)),
  mapsBudget: (day: string, shard: number) => db().collection(COL.mapsBudget).doc(`${day}_${shard}`),
  mapsConfig: () => db().collection(COL.config).doc('maps'),
  // Faz 3
  batteryAlert: (uid: UserId, sessionId: string) => db().collection(COL.batteryAlerts).doc(`${uid}_${sessionId}`),
} as const;

/** Biten belgeler için TTL anı. [Varsayım] 7 gün. */
export const purgeAt = (now: EpochMs): Timestamp => Timestamp.fromMillis(now + LIMITS.endedDocTtlMs);

export function toView(s: ShareDoc): OutgoingShareView {
  return {
    share_id: s.share_id,
    session_id: s.session_id,
    receiver_id: s.receiver_id,
    status: s.status,
    share_mode: s.share_mode,
    started_at: s.started_at,
    expires_at: s.expires_at,
    end_reason: s.end_reason,
    version: s.version,
  };
}

export function publicProfile(u: Pick<UserProfile, 'display_name' | 'avatar_url'> | undefined): PublicProfile {
  return { display_name: u?.display_name ?? '', avatar_url: u?.avatar_url ?? null };
}

/**
 * Bekleyen istekte hedefe gösterilen isteyen profili: yalnızca ad. Avatar adresi kabulden önce
 * kopyalanmaz (yabancının resmi hedef cihazda istek kartı çizilirken yüklenmesin). Kabulde güncel profil yazılır.
 */
export function pendingProfile(u: Pick<UserProfile, 'display_name'> | undefined): PublicProfile {
  return { display_name: u?.display_name ?? '', avatar_url: null };
}

/** Profil eksikse ya da hesap siliniyorsa false (yeni paylaşım / istek yok). */
export const isUsableProfile = (u: UserDoc | undefined): u is UserDoc => Boolean(u && !u.deleting);

/** Bir paylaşımı sonlandıran güncelleme (sürüm +1). Belge zaten bitmişse null. */
export function endedShare(s: ShareDoc, reason: LocationShare['end_reason'], now: EpochMs): ShareDoc | null {
  if (s.status !== 'active') return null;
  return {
    ...s,
    status: 'ended',
    ended_at: now,
    end_reason: reason,
    version: s.version + 1,
    updated_at: now,
    purge_at: purgeAt(now),
  };
}

// ---------------------------------------------------------------------------
// Faz 2: bağlantı paylaşımı
// ---------------------------------------------------------------------------

export function toLinkView(l: LinkShare): LinkShareView {
  return {
    link_id: l.link_id,
    session_id: l.session_id,
    token_hash: l.token_hash,
    status: l.status,
    share_mode: l.share_mode,
    started_at: l.started_at,
    expires_at: l.expires_at,
    end_reason: l.end_reason,
    version: l.version,
    extended_count: l.extended_count,
  };
}

/** Bağlantıyı sonlandıran güncelleme (sürüm +1). Zaten bitmişse null. */
export function endedLink(l: LinkShareDoc, reason: LinkEndReason, now: EpochMs): LinkShareDoc | null {
  if (l.status !== 'active') return null;
  return {
    ...l,
    status: 'ended',
    ended_at: now,
    end_reason: reason,
    version: l.version + 1,
    updated_at: now,
    purge_at: purgeAt(now),
  };
}

/** Bitirme alanları (yalnızca değişenler). */
export function linkEndFields(e: LinkShareDoc) {
  return {
    status: e.status,
    ended_at: e.ended_at,
    end_reason: e.end_reason,
    version: e.version,
    updated_at: e.updated_at,
    purge_at: e.purge_at ?? null,
  };
}
