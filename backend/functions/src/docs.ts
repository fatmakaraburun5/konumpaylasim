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
 *  - Faz 4 (RTDB): `ping_expiry/{ping_id}` = `{to, from, expires_at}` süpürücü dizini (`ping_inbox` iki seviyeli olduğu
 *    için süresi geçen pingler buradan bulunur; istemciye kapalı)
 *
 * Faz 2'de gönderenin okuyabildiği koleksiyon:
 *  - `link_shares/{link_id}` bağlantı (QR) paylaşımları (yalnızca `sender_id == ben` sorgusuyla)
 *
 * İstemcinin okuyabildiği ek koleksiyon:
 *  - `users/{uid}/outgoing_requests/{oid}` giden arkadaşlık istekleri (maskeli etiket; hedef uid'i YOK)
 *
 * Faz 4 (yalnızca callable yazar):
 *  - `place_notes/{note_id}` yer notları (sahibi ve `visible_to` okur)
 *  - `sos_alerts/{sos_id}` acil durum uyarıları (gönderen ve `recipient_ids` okur)
 *  - `users/{uid}.emergency_contacts` acil durum kişileri (sahibi okur)
 *  - RTDB `ping_inbox/{to}/{ping_id}` (alıcı okur ve siler)
 *
 * Faz 5 (yalnızca callable yazar):
 *  - `users/{uid}/zones/{zone_id}` kayıtlı bölgeler + kurallar (core `Zone`; YALNIZCA sahibi okur, koordinat hassas)
 *  - `users/{uid}/zone_events/{op_id}` bölge olay kaydı (core `ZoneEventLog` + `purge_at`, 30 gün; sahibi okur)
 *  - `meetups/{meetup_id}` paylaşılan buluşma önerileri (core `Meetup` + `purge_at`; `from` ve `to` okur)
 *  - yalnızca sunucu: `zone_cooldowns/{uid}_{zone_id}_{transition}` (son bildirim anı), `meetup_cache/{anahtar}`
 *    (öneri yanıtı önbelleği; kullanıcıya özel, `expire_at` TTL), `maps_quota/{uid}_{gün}.meetup` sayacı
 *
 * Faz 6:
 *  - `users/{uid}`: `gender`, `avatar_thumb_url`, `avatar_version` (`user_bootstrap` yazar), `favorite_ids`
 *    (`favorites_set` yazar; arkadaşlık bitince / hesap silinince sunucu temizler). Belge yalnızca sahibine açık.
 *  - yalnızca sunucu: `widget_tokens/{sha256Hex(token)}` (widget hızlı paylaşım token'ı; düz token YOK; `purge_at` TTL)
 *  - Storage `avatars/{uid}/{version}.jpg` + `{version}_160.jpg` (storage.rules: yalnızca sahibi yazar / siler)
 */
import {
  type EpochMs,
  type Meetup,
  type MeetupSuggestResponse,
  type Zone,
  type ZoneEventLog,
  type ZoneTrigger,
  type Friendship,
  type LinkEndReason,
  type LinkShare,
  type LinkShareView,
  type LocationRequest,
  type LocationShare,
  type OutgoingShareView,
  type PlaceNote,
  type PublicProfile,
  type SosAlert,
  type UserId,
  type UserProfile,
  PATHS,
  blockId,
  isGender,
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
  /** Faz 4: acil durum kişileri (en çok 5, sıralı; yalnızca `emergency_contacts_set` yazar). */
  emergency_contacts?: UserId[];
}

/**
 * Faz 6 `widget_tokens/{sha256Hex(token)}` (yalnızca sunucu; kurallarda kapalı). Düz token SAKLANMAZ.
 * `uses`: token başına saatlik sabit pencere sayacı (`QUICK_SHARE_LIMITS.perTokenPerHour`).
 */
export interface WidgetTokenDoc {
  uid: UserId;
  device_id: string;
  created_at: EpochMs;
  expires_at: EpochMs;
  last_used_at: EpochMs | null;
  uses: { window_start: EpochMs; count: number };
  revoked: boolean;
  revoked_at?: EpochMs | null;
  /** TTL: bitişten 1 gün sonra ya da iptalden 1 gün sonra. */
  purge_at: Timestamp;
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

// ---------------------------------------------------------------------------
// Faz 4: yer notları, acil durum, ping
// ---------------------------------------------------------------------------

/** `place_notes/{note_id}`: core PlaceNote + TTL alanı (istemci `purge_at`'i okumaz). */
export interface PlaceNoteDoc extends PlaceNote {
  purge_at: Timestamp;
}

/** `sos_alerts/{sos_id}`: core SosAlert + TTL alanı. */
export interface SosAlertDoc extends SosAlert {
  purge_at: Timestamp;
}

/** RTDB `ping_expiry/{ping_id}`: süpürücü ve hesap silme dizini (yalnızca sunucu). */
export interface PingExpiryEntry {
  to: UserId;
  from: UserId;
  expires_at: EpochMs;
}

export function toPlaceNote(d: PlaceNoteDoc | PlaceNote): PlaceNote {
  return {
    note_id: d.note_id,
    owner_id: d.owner_id,
    emoji: d.emoji ?? null,
    text: d.text,
    position: { lat: d.position.lat, lng: d.position.lng, accuracy: d.position.accuracy ?? null },
    visible_to: [...(d.visible_to ?? [])],
    created_at: d.created_at,
    updated_at: d.updated_at,
    expires_at: d.expires_at,
  };
}

export function toSosAlert(d: SosAlertDoc | SosAlert): SosAlert {
  return {
    sos_id: d.sos_id,
    sender_id: d.sender_id,
    sender_name: d.sender_name,
    recipient_ids: [...(d.recipient_ids ?? [])],
    status: d.status,
    resolve_reason: d.resolve_reason ?? null,
    message: d.message,
    location: { lat: d.location.lat, lng: d.location.lng, accuracy: d.location.accuracy, timestamp: d.location.timestamp },
    address: d.address ?? null,
    maps_url: d.maps_url,
    battery_pct: d.battery_pct ?? null,
    is_charging: d.is_charging ?? null,
    route: d.route
      ? { destination_label: d.route.destination_label ?? null, eta_s: d.route.eta_s, distance_m: d.route.distance_m }
      : null,
    created_at: d.created_at,
    updated_at: d.updated_at,
    resolved_at: d.resolved_at ?? null,
    acks: { ...(d.acks ?? {}) },
    update_count: d.update_count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Faz 5: bölgeler, bölge olayları, buluşma önerileri
// ---------------------------------------------------------------------------

/** `users/{uid}/zones/{zone_id}`: core Zone (ek alan yok; istemci `parseZone` ile okur). */
export type ZoneDoc = Zone;

/** `users/{uid}/zone_events/{op_id}`: core ZoneEventLog + TTL. Koordinat YOK. */
export interface ZoneEventDoc extends ZoneEventLog {
  /** Olay raporunun sunucuya geldiği an. */
  reported_at: EpochMs;
  purge_at: Timestamp;
}

/** `zone_cooldowns/{uid}_{zone_id}_{transition}` (yalnızca sunucu): son bildirim / paylaşım tetik anı. */
export interface ZoneCooldownDoc {
  uid: UserId;
  zone_id: string;
  transition: ZoneTrigger;
  last_at: EpochMs;
  purge_at: Timestamp;
}

/** `meetups/{meetup_id}`: core Meetup + TTL. */
export interface MeetupDoc extends Meetup {
  updated_at: EpochMs;
  purge_at: Timestamp;
}

/** `meetup_cache/{anahtar}` (yalnızca sunucu): kullanıcıya özel öneri yanıtı. */
export interface MeetupCacheDoc {
  uid: UserId;
  response: Omit<MeetupSuggestResponse, 'cached' | 'server_now'>;
  created_at: EpochMs;
  /** Süpürücü sorgusu için epoch ms (tek alanlı otomatik dizin). */
  expires_at: EpochMs;
  /** TTL politikası alanı. */
  expire_at: Timestamp;
}

export function toZone(d: ZoneDoc): Zone {
  return {
    zone_id: d.zone_id,
    owner_id: d.owner_id,
    kind: d.kind,
    name: d.name,
    emoji: d.emoji ?? null,
    center: { lat: d.center.lat, lng: d.center.lng },
    radius_m: d.radius_m,
    rules: (d.rules ?? []).map((r) => ({
      rule_id: r.rule_id,
      trigger: r.trigger,
      action: r.action,
      recipient_ids: [...r.recipient_ids],
      share_duration: r.share_duration ?? null,
      days_mask: r.days_mask,
      window: r.window ? { from_min: r.window.from_min, to_min: r.window.to_min } : null,
      enabled: r.enabled,
    })),
    enabled: d.enabled,
    time_zone: d.time_zone,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

export function toMeetup(d: MeetupDoc | Meetup): Meetup {
  return {
    meetup_id: d.meetup_id,
    from: d.from,
    from_name: d.from_name,
    to: [...(d.to ?? [])],
    place: {
      place_id: d.place.place_id ?? null,
      name: d.place.name,
      address: d.place.address ?? null,
      location: { lat: d.place.location.lat, lng: d.place.location.lng },
      primary_type: d.place.primary_type ?? null,
      category: d.place.category,
    },
    etas: (d.etas ?? []).map((e) => ({ key: e.key, duration_s: e.duration_s, distance_m: e.distance_m, estimated: e.estimated })),
    meet_at: d.meet_at ?? null,
    note: d.note ?? null,
    responses: { ...(d.responses ?? {}) },
    status: d.status,
    created_at: d.created_at,
    expires_at: d.expires_at,
  };
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
  // Faz 4
  placeNotes: PATHS.placeNotes,
  sosAlerts: PATHS.sosAlerts,
  // Faz 5 (zones / zone_events, users/{uid} alt koleksiyonlarıdır)
  zones: 'zones',
  zoneEvents: 'zone_events',
  zoneCooldowns: 'zone_cooldowns',
  meetups: PATHS.meetups,
  meetupCache: 'meetup_cache',
  // Faz 6
  widgetTokens: PATHS.widgetTokens,
} as const;

/** Faz 4 RTDB yolları. */
export const RTDB_F4 = {
  pingInbox: (to: UserId) => PATHS.pingInbox(to),
  ping: (to: UserId, pingId: string) => `${PATHS.pingInbox(to)}/${pingId}`,
  pingExpiryRoot: 'ping_expiry',
  pingExpiry: (pingId: string) => `ping_expiry/${pingId}`,
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
  // Faz 4
  placeNote: (id: string) => db().doc(PATHS.placeNote(id)),
  newPlaceNote: () => db().collection(COL.placeNotes).doc(),
  sosAlert: (id: string) => db().doc(PATHS.sosAlert(id)),
  newSosAlert: () => db().collection(COL.sosAlerts).doc(),
  // Faz 5
  zones: (uid: UserId) => db().collection(PATHS.zones(uid)),
  zone: (uid: UserId, zoneId: string) => db().doc(PATHS.zone(uid, zoneId)),
  zoneEvents: (uid: UserId) => db().collection(PATHS.zoneEvents(uid)),
  zoneEvent: (uid: UserId, id: string) => db().collection(PATHS.zoneEvents(uid)).doc(id),
  zoneCooldown: (uid: UserId, zoneId: string, transition: ZoneTrigger) => db().doc(PATHS.zoneCooldown(uid, zoneId, transition)),
  meetup: (id: string) => db().doc(PATHS.meetup(id)),
  newMeetup: () => db().collection(COL.meetups).doc(),
  meetupCache: (key: string) => db().doc(PATHS.meetupCache(key)),
  // Faz 6
  widgetToken: (tokenHash: string) => db().doc(PATHS.widgetToken(tokenHash)),
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

/**
 * Arkadaşlara kopyalanan profil. Faz 6: cinsiyet (çerçeve rengi) ve 160 px küçük avatar da kopyalanır.
 * Eski (Faz 6 öncesi) belgelerde alanlar yoksa `null` (istemci gri çerçeve + ana boy / baş harf gösterir).
 */
export function publicProfile(
  u: (Pick<UserProfile, 'display_name' | 'avatar_url'> & Partial<Pick<UserProfile, 'gender' | 'avatar_thumb_url'>>) | undefined,
): PublicProfile {
  const avatar = u?.avatar_url ?? null;
  return {
    display_name: u?.display_name ?? '',
    avatar_url: avatar,
    gender: isGender(u?.gender) ? u.gender : null,
    // Ana fotoğraf yoksa küçük boy da yok (yarım kalmış güncelleme kopyaya sızmasın).
    avatar_thumb_url: avatar ? (u?.avatar_thumb_url ?? null) : null,
  };
}

/**
 * Bekleyen istekte hedefe gösterilen isteyen profili: yalnızca ad. Avatar adresi (ve Faz 6 cinsiyeti) kabulden önce
 * kopyalanmaz (yabancının resmi hedef cihazda istek kartı çizilirken yüklenmesin). Kabulde güncel profil yazılır.
 */
export function pendingProfile(u: Pick<UserProfile, 'display_name'> | undefined): PublicProfile {
  return { display_name: u?.display_name ?? '', avatar_url: null, gender: null, avatar_thumb_url: null };
}

/** Eski belgelerde eksik Faz 6 alanları: favori listesi (yalnızca dizi olarak okunur). */
export const favoriteIdsOf = (u: Partial<Pick<UserProfile, 'favorite_ids'>> | undefined): UserId[] =>
  Array.isArray(u?.favorite_ids) ? u.favorite_ids.filter((x): x is UserId => typeof x === 'string') : [];

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
