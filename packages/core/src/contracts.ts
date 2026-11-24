/**
 * İstemci ↔ sunucu sözleşmeleri. Taşımadan bağımsızdır: bugün Firebase callable + RTDB/Firestore
 * dinleyicileri, yarın bir WebSocket ağ geçidi aynı şekilleri taşıyabilir.
 *
 * Sürümleme: alanlar yalnızca EKLENİR; bilinmeyen alan ve olay türleri yok sayılır.
 * Kırıcı değişiklik = yeni callable adı (`share_start_v2`).
 *
 * Her komut bir `op_id` (UUID v4) taşır: sunucu `ops/{uid}_{op_id}` ile tekilleştirir,
 * ağ kopup tekrar denenen istek ikinci kez uygulanmaz.
 */
import { z } from 'zod';
import { SHARE_MODES, type DurationChoice, type ShareMode } from './duration';
import { LINK_HASH_RE, LINK_LIMITS, LINK_TOKEN_RE, type LinkShareView } from './link';
import { GEOHASH_RE, TRAVEL_MODES, type TravelMode } from './mapsPolicy';
import type { LinkEndReason, LinkId, SessionId, ShareEndReason, ShareId, UserId } from './model';
import type { OutgoingShareView } from './sharing';
import type { EpochMs } from './time';

export const CALLABLES = {
  userBootstrap: 'user_bootstrap',
  inviteCodeRegenerate: 'invite_code_regenerate',
  friendRequestSend: 'friend_request_send',
  friendRequestRespond: 'friend_request_respond',
  friendRequestCancel: 'friend_request_cancel',
  friendshipRemove: 'friendship_remove',
  userBlock: 'user_block',
  userUnblock: 'user_unblock',
  shareStart: 'share_start',
  shareExtend: 'share_extend',
  shareStop: 'share_stop',
  shareRevoke: 'share_revoke',
  locationRequestSend: 'location_request_send',
  locationRequestRespond: 'location_request_respond',
  accountDelete: 'account_delete',
  // Faz 2
  linkShareCreate: 'link_share_create',
  linkShareExtend: 'link_share_extend',
  linkShareStop: 'link_share_stop',
  routeCompute: 'route_compute',
  geocodeReverse: 'geocode_reverse',
  // Faz 3
  batteryLowNotify: 'battery_low_notify',
  // Faz 4
  pingSend: 'ping_send',
  placeNoteUpsert: 'place_note_upsert',
  placeNoteDelete: 'place_note_delete',
  emergencyContactsSet: 'emergency_contacts_set',
  sosSend: 'sos_send',
  sosUpdate: 'sos_update',
  sosResolve: 'sos_resolve',
  sosAck: 'sos_ack',
  // Faz 5
  zoneUpsert: 'zone_upsert',
  zoneDelete: 'zone_delete',
  zoneEventReport: 'zone_event_report',
  meetupSuggest: 'meetup_suggest',
  meetupShare: 'meetup_share',
  meetupRespond: 'meetup_respond',
  meetupCancel: 'meetup_cancel',
} as const;

export type CallableName = (typeof CALLABLES)[keyof typeof CALLABLES];

/** Firestore koleksiyonları ve RTDB yolları tek yerde. */
export const PATHS = {
  user: (uid: UserId) => `users/${uid}`,
  friendships: 'friendships',
  shares: 'location_shares',
  share: (id: ShareId) => `location_shares/${id}`,
  requests: 'location_requests',
  deviceTokens: (uid: UserId) => `devices/${uid}/tokens`,
  /** RTDB: alıcının gelen kutusu (yalnızca kendisi okur). */
  liveInbox: (receiverId: UserId) => `live_locations/${receiverId}`,
  /** RTDB: yetki aynası (istemciye kapalı). */
  shareAcl: (id: ShareId) => `share_acl/${id}`,
  /** RTDB: sunucu saat farkı. */
  serverTimeOffset: '.info/serverTimeOffset',
  /** RTDB, Faz 2: bağlantı ile paylaşımın canlı kopyası (gönderen yazar, token'ı bilen okur). */
  linkLive: (tokenHash: string) => `link_live/${tokenHash}`,
  // --- Faz 2 ---
  /** Firestore: bağlantı paylaşımları (yalnızca gönderen okur, callable yazar). */
  linkShares: 'link_shares',
  linkShare: (id: LinkId) => `link_shares/${id}`,
  /** RTDB: bağlantı yetki aynası (istemciye kapalı). */
  linkAcl: (tokenHash: string) => `link_acl/${tokenHash}`,
  /** Firestore: Routes API sunucu önbelleği (yalnızca sunucu), anahtar `routeCacheKey`. */
  routeCache: (key: string) => `route_cache/${key}`,
  /** Firestore: ters geocode önbelleği (yalnızca sunucu), anahtar geohash hücresi. */
  geocodeCache: (cell: string) => `geocode_cache/${cell}`,
  /** Firestore: kullanıcı başına günlük Maps sayacı (yalnızca sunucu), `day` = `quotaDay(now)`. */
  mapsQuota: (uid: UserId, day: string) => `maps_quota/${uid}_${day}`,
  // --- Faz 3 ---
  /** RTDB: alıcının çevrimdışı iz kutusu `live_trail/{receiver}/{share_id}/{point_id}` (gönderen yazar, alıcı okur). */
  liveTrail: (receiverId: UserId) => `live_trail/${receiverId}`,
  /** Firestore: oturum başına düşük pil tetikleyici durumu (yalnızca sunucu). */
  batteryAlert: (uid: UserId, sessionId: SessionId) => `battery_alerts/${uid}_${sessionId}`,
  // --- Faz 4 ---
  /** RTDB: alıcının ping kutusu `ping_inbox/{to}/{ping_id}` (yalnızca sunucu yazar; alıcı okur ve siler). */
  pingInbox: (receiverId: UserId) => `ping_inbox/${receiverId}`,
  /** Firestore: yer notları (callable yazar; sahibi ve `visible_to` okur). */
  placeNotes: 'place_notes',
  placeNote: (id: string) => `place_notes/${id}`,
  /** Firestore: acil durum uyarıları (callable yazar; gönderen ve `recipient_ids` okur). */
  sosAlerts: 'sos_alerts',
  sosAlert: (id: string) => `sos_alerts/${id}`,
  /** Firestore: kullanıcının acil durum kişileri `users/{uid}.emergency_contacts` (yalnızca callable yazar). */
  // --- Faz 5 ---
  /** Firestore: kayıtlı bölgeler + kurallar (YALNIZCA sahibi okur, callable yazar). Koordinat hassas. */
  zones: (uid: UserId) => `users/${uid}/zones`,
  zone: (uid: UserId, zoneId: string) => `users/${uid}/zones/${zoneId}`,
  /** Firestore: bölge olay kaydı (yalnızca sahibi okur, 30 gün TTL). */
  zoneEvents: (uid: UserId) => `users/${uid}/zone_events`,
  /** Firestore: sunucu tarafı bölge soğuma durumu (yalnızca sunucu) `zone_cooldowns/{uid}_{zone_id}_{transition}`. */
  zoneCooldown: (uid: UserId, zoneId: string, transition: string) => `zone_cooldowns/${uid}_${zoneId}_${transition}`,
  /** Firestore: paylaşılan buluşma önerileri (gönderen + alıcılar okur, callable yazar). */
  meetups: 'meetups',
  meetup: (id: string) => `meetups/${id}`,
  /** Firestore: buluşma önerisi sunucu önbelleği (yalnızca sunucu), anahtar `meetupCacheKey`. */
  meetupCache: (key: string) => `meetup_cache/${key}`,
} as const;

const opId = z.uuid();
const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const DurationChoiceSchema: z.ZodType<DurationChoice> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), preset: z.enum(['m15', 'h1', 'h8']) }),
  z.object({ kind: z.literal('end_of_day') }),
  z.object({ kind: z.literal('custom_minutes'), minutes: z.number().int().positive() }),
  z.object({ kind: z.literal('custom_until'), until: z.number().int().positive() }),
  z.object({ kind: z.literal('weekly') }),
  z.object({ kind: z.literal('indefinite') }),
]);

// --- share_start -----------------------------------------------------------

export const ShareStartRequestSchema = z.object({
  op_id: opId,
  receiver_ids: z.array(uid).min(1).max(20),
  duration: DurationChoiceSchema,
  /** IANA saat dilimi (gün sonu hesabı için), örn. "Europe/Istanbul". */
  time_zone: z.string().min(1).max(64),
  /** Bir konum isteğine yanıt olarak başlatıldıysa. */
  in_response_to: z.string().max(300).nullable().default(null),
});
export type ShareStartRequest = z.input<typeof ShareStartRequestSchema>;

export interface ShareStartResponse {
  session_id: SessionId;
  shares: OutgoingShareView[];
  /** Arkadaş olmayan / engelli alıcılar hata vermez, yalnızca atlanır (bilgi sızmaz). */
  skipped_receiver_ids: UserId[];
  server_now: EpochMs;
}

// --- share_extend ----------------------------------------------------------

export const ShareExtendRequestSchema = z.object({
  op_id: opId,
  session_id: z.string().min(1).max(64),
  minutes: z.union([z.literal(30), z.literal(60)]),
});
export type ShareExtendRequest = z.input<typeof ShareExtendRequestSchema>;

export interface ShareExtendResponse {
  session_id: SessionId;
  shares: OutgoingShareView[];
  expires_at: EpochMs;
  share_mode: ShareMode;
  server_now: EpochMs;
}

// --- share_stop (gönderen) / share_revoke (alıcı) --------------------------

export const ShareStopRequestSchema = z.object({
  op_id: opId,
  session_id: z.string().min(1).max(64),
  /** Verilmezse oturumdaki tüm alıcılar. */
  receiver_ids: z.array(uid).max(20).optional(),
});
export type ShareStopRequest = z.input<typeof ShareStopRequestSchema>;

export interface ShareStopResponse {
  session_id: SessionId;
  shares: OutgoingShareView[];
  server_now: EpochMs;
}

/** Alıcı "artık görmek istemiyorum" der: gönderenin paylaşımı `revoked_by_receiver` ile biter. */
export const ShareRevokeRequestSchema = z.object({
  op_id: opId,
  sender_id: uid,
});
export type ShareRevokeRequest = z.input<typeof ShareRevokeRequestSchema>;

// --- location_request ------------------------------------------------------

export const LocationRequestSendSchema = z.object({ op_id: opId, target_id: uid });
export type LocationRequestSend = z.input<typeof LocationRequestSendSchema>;

export const LocationRequestRespondSchema = z.object({
  op_id: opId,
  request_id: z.string().min(1).max(300),
  accept: z.boolean(),
  /** Kabulde paylaşım süresi; varsayılan 1 saat. */
  duration: DurationChoiceSchema.optional(),
  time_zone: z.string().min(1).max(64).optional(),
});
export type LocationRequestRespond = z.input<typeof LocationRequestRespondSchema>;

// --- arkadaşlık ------------------------------------------------------------

export const FriendRequestSendSchema = z.discriminatedUnion('via', [
  z.object({ op_id: opId, via: z.literal('invite_code'), invite_code: z.string().min(4).max(16) }),
  z.object({ op_id: opId, via: z.literal('phone'), phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/) }),
]);
export type FriendRequestSend = z.input<typeof FriendRequestSendSchema>;

/** Telefonla aramada kayıtlı olsun olmasın yanıt AYNIDIR: numara taraması engellenir. */
export interface FriendRequestSendResponse {
  status: 'sent';
  server_now: EpochMs;
}

export const FriendRequestRespondSchema = z.object({
  op_id: opId,
  friendship_id: z.string().min(1).max(300),
  accept: z.boolean(),
});

// --- Faz 2: bağlantı (QR) ile paylaşım -----------------------------------------

const linkIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const epochMs = z.number().int().nonnegative();
const shareModeSchema = z.enum(SHARE_MODES as [ShareMode, ...ShareMode[]]);
const LINK_END_REASONS = ['stopped_by_sender', 'expired', 'account_deleted'] as const satisfies readonly LinkEndReason[];

/**
 * Süre seçenekleri Faz 1 ile aynı motoru kullanır (`resolveDuration`): 15 dk, 1 saat, 8 saat,
 * gün sonu, haftalık, süresiz (arayüzde `LINK_DURATION_OPTIONS`).
 */
export const LinkShareCreateRequestSchema = z.object({
  op_id: opId,
  duration: DurationChoiceSchema,
  /** Gün sonu hesabı için IANA saat dilimi. [Varsayım] Verilmezse Europe/Istanbul. */
  time_zone: z.string().min(1).max(64).default('Europe/Istanbul'),
});
export type LinkShareCreateRequest = z.input<typeof LinkShareCreateRequestSchema>;

export const LinkShareViewSchema: z.ZodType<LinkShareView> = z.object({
  link_id: linkIdSchema,
  session_id: z.string().min(1).max(64),
  token_hash: z.string().regex(LINK_HASH_RE),
  status: z.enum(['active', 'ended']),
  share_mode: shareModeSchema,
  started_at: epochMs,
  expires_at: epochMs.nullable(),
  end_reason: z.enum(LINK_END_REASONS).nullable().catch(null),
  version: z.number().int().nonnegative(),
  extended_count: z.number().int().nonnegative(),
});

/**
 * `token` YALNIZCA bu yanıtta döner; sunucu düz token'ı saklamaz (ne `link_shares`'ta ne `ops` kaydında).
 * İstemci güvenli depoda tutar (QR'ı yeniden göstermek için). Kaybolursa bağlantı durdurulup yenisi açılır.
 * Yanıtı kaybolan oluşturma aynı `op_id` ile tekrarlanırsa ve bağlantı hâlâ aktifse sunucu TOKEN YENİLER:
 * aynı `link_id`, yeni `token` / `token_hash` / `url`, `version + 1`; eski özet hemen kapanır (mezar taşı).
 * Bu yüzden yayıncı `token_hash`'i her zaman son yanıttan / `link_shares` belgesinden almalıdır.
 * Bağlantı bitmişse tekrar `share_not_active` döner.
 */
export interface LinkShareCreateResponse extends LinkShareView {
  token: string;
  /** `buildLinkUrl(domain, token)`: QR'ın içeriği. */
  url: string;
  server_now: EpochMs;
}

export const LinkShareCreateResponseSchema: z.ZodType<LinkShareCreateResponse> = z.object({
  link_id: linkIdSchema,
  session_id: z.string().min(1).max(64),
  token_hash: z.string().regex(LINK_HASH_RE),
  status: z.enum(['active', 'ended']),
  share_mode: shareModeSchema,
  started_at: epochMs,
  expires_at: epochMs.nullable(),
  end_reason: z.enum(LINK_END_REASONS).nullable().catch(null),
  version: z.number().int().nonnegative(),
  extended_count: z.number().int().nonnegative(),
  token: z.string().regex(LINK_TOKEN_RE),
  url: z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/s\/[A-Za-z0-9_-]{43}$/),
  server_now: epochMs,
});

/** Faz 1 uzatma kuralı: yeni bitiş = max(bitiş, şimdi) + adım, en çok şimdi + 7 gün (`extendExpiry`). */
export const LinkShareExtendRequestSchema = z.object({
  op_id: opId,
  link_id: linkIdSchema,
  minutes: z.union([z.literal(30), z.literal(60)]),
});
export type LinkShareExtendRequest = z.input<typeof LinkShareExtendRequestSchema>;

/** Durdurma: Firestore commit → `link_acl` mezar taşı → `link_live` silinir (aynı çağrıda). */
export const LinkShareStopRequestSchema = z.object({
  op_id: opId,
  link_id: linkIdSchema,
});
export type LinkShareStopRequest = z.input<typeof LinkShareStopRequestSchema>;

/** Uzatma ve durdurma yanıtı: güncel görünüm + sunucu saati. */
export interface LinkShareUpdateResponse extends LinkShareView {
  server_now: EpochMs;
}
export type LinkShareExtendResponse = LinkShareUpdateResponse;
export type LinkShareStopResponse = LinkShareUpdateResponse;

export const LinkShareUpdateResponseSchema: z.ZodType<LinkShareUpdateResponse> = z.object({
  link_id: linkIdSchema,
  session_id: z.string().min(1).max(64),
  token_hash: z.string().regex(LINK_HASH_RE),
  status: z.enum(['active', 'ended']),
  share_mode: shareModeSchema,
  started_at: epochMs,
  expires_at: epochMs.nullable(),
  end_reason: z.enum(LINK_END_REASONS).nullable().catch(null),
  version: z.number().int().nonnegative(),
  extended_count: z.number().int().nonnegative(),
  server_now: epochMs,
});
export const LinkShareExtendResponseSchema = LinkShareUpdateResponseSchema;
export const LinkShareStopResponseSchema = LinkShareUpdateResponseSchema;

// --- Faz 2: rota (Routes API, sunucu üzerinden) ----------------------------------

const LatLngSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/** İstemci yalnızca `shouldRecomputeRoute` true iken çağırır (bkz. `mapsPolicy.ts`). */
export const RouteComputeRequestSchema = z.object({
  op_id: opId,
  origin: LatLngSchema,
  destination: LatLngSchema,
  travel_mode: z.enum(TRAVEL_MODES as [TravelMode, ...TravelMode[]]),
});
export type RouteComputeRequest = z.input<typeof RouteComputeRequestSchema>;

export interface RouteComputeResponse {
  distance_m: number;
  duration_s: number;
  /** Google encoded polyline (1e5); `decodePolyline` ile çözülür. Boş olabilir. */
  polyline: string;
  /** Sunucu önbelleğinden mi döndü (kota sayılmaz). */
  cached: boolean;
  /** Rotanın Google'dan alındığı an (önbellekten dönse de ilk hesap anı). */
  computed_at: EpochMs;
}

export const RouteComputeResponseSchema: z.ZodType<RouteComputeResponse> = z.object({
  distance_m: z.number().nonnegative(),
  duration_s: z.number().nonnegative(),
  polyline: z.string().max(100_000),
  cached: z.boolean(),
  computed_at: epochMs,
});

// --- Faz 2: ters geocode (adres metni, sunucu üzerinden) -------------------------

/** İstemci yalnızca `shouldReverseGeocode` true iken çağırır. Sunucu hücre merkezini sorar. */
export const GeocodeReverseRequestSchema = LatLngSchema;
export type GeocodeReverseRequest = z.input<typeof GeocodeReverseRequestSchema>;

export interface GeocodeReverseResponse {
  /** Kısa adres ("Moda Caddesi, Kadıköy"); null = adres yok (deniz, kır). */
  label: string | null;
  /** geohash (GEOCODE_POLICY.cellPrecision); istemci önbelleği de bu anahtarla tutar. */
  cell: string;
  cached: boolean;
}

export const GeocodeReverseResponseSchema: z.ZodType<GeocodeReverseResponse> = z.object({
  label: z.string().max(300).nullable(),
  cell: z.string().regex(GEOHASH_RE),
  cached: z.boolean(),
});

// --- Faz 3: düşük pil bildirimi ------------------------------------------------

/** Oturum kimliği: sunucu üretir (UUID v4); belge kimliğine girdiği için `/` vb. kabul edilmez. */
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/**
 * `battery_low_notify`: gönderen istemci, core `lowBatteryTrigger` durumu DEĞİŞTİĞİNDE çağırır (OTURUM başına):
 *  - `fire: true` olduğunda (pil ≤ %15, şarjda değil) → oturumun alıcılarına FCM (koordinat YOK; sunucu aynı saf
 *    tetikleyiciyi `battery_alerts/{uid}_{session_id}` durumuyla uygular: düşüş başına bir kez, ≥ 30 dk ara,
 *    oturum başına 24 sa'te ≤ 6);
 *  - tetikleyici yeniden kurulduğunda (pil ≥ %20 ya da şarj) ve bu oturumda bildirim gittiyse → sunucu durumu yeniden kurulur.
 * Ara değerlerde çağırmak gerekmez. Bağlantı (QR) izleyicilerine push gitmez (`link_live.battery_pct` rozeti yeterli).
 * Aynı `op_id` sunucuda bir kez uygulanır: çevrimdışı kuyruk aynı `op_id` ile yeniden dener.
 */
export const BatteryLowNotifyRequestSchema = z.object({
  op_id: opId,
  session_id: sessionIdSchema,
  battery_pct: z.number().int().min(0).max(100),
  is_charging: z.boolean().optional(),
});
export type BatteryLowNotifyRequest = z.input<typeof BatteryLowNotifyRequestSchema>;

export const BATTERY_LOW_NOTIFY_STATUSES = ['notified', 'rearmed', 'suppressed', 'noop'] as const;

export interface BatteryLowNotifyResponse {
  /**
   * `notified`: alıcılara bildirim kuyruğa alındı; `rearmed`: durum yeniden kuruldu; `suppressed`: bu düşüş için
   * zaten bildirildi / 30 dk koruması / günlük tavan; `noop`: eşik dışı okuma (durum değişmedi).
   */
  status: (typeof BATTERY_LOW_NOTIFY_STATUSES)[number];
  /** Sunucu durumundaki `armed` (bir sonraki ≤ %15 okumada bildirim gider mi). */
  armed: boolean;
  /** Bildirim giden aktif alıcı sayısı. */
  receivers: number;
  server_now: EpochMs;
}

export const BatteryLowNotifyResponseSchema: z.ZodType<BatteryLowNotifyResponse> = z.object({
  status: z.enum(BATTERY_LOW_NOTIFY_STATUSES),
  armed: z.boolean(),
  receivers: z.number().int().nonnegative(),
  server_now: z.number().int().nonnegative(),
});

// --- hata modeli -------------------------------------------------------------

/** Callable `HttpsError.details.code` alanı. */
export const ERROR_CODES = {
  invalid_argument: { retryable: false, message: 'Geçersiz istek' },
  invalid_duration: { retryable: false, message: 'Süre geçersiz' },
  not_friends: { retryable: false, message: 'Bu kişiyle arkadaş değilsiniz' },
  share_not_active: { retryable: false, message: 'Paylaşım artık aktif değil' },
  already_expired: { retryable: false, message: 'Paylaşımın süresi doldu, yeniden başlatın' },
  rate_limited: { retryable: true, message: 'Çok sık denediniz, biraz bekleyin' },
  unauthenticated: { retryable: false, message: 'Oturum süreniz doldu, tekrar giriş yapın' },
  unavailable: { retryable: true, message: 'Bağlantı yok, tekrar deneniyor' },
  internal: { retryable: true, message: 'Bir şeyler ters gitti' },
  // Faz 2
  link_not_found: { retryable: false, message: 'Bağlantı bulunamadı' },
  link_limit_reached: { retryable: false, message: `Aynı anda en fazla ${LINK_LIMITS.maxActivePerUser} bağlantı paylaşabilirsin` },
  maps_unavailable: { retryable: true, message: 'Harita servisine şu an ulaşılamıyor' },
  quota_exceeded: { retryable: false, message: 'Bugünlük rota ve adres sorgu sınırına ulaşıldı' },
  route_not_found: { retryable: false, message: 'Bu iki nokta arasında rota bulunamadı' },
  // Faz 4
  no_emergency_contacts: { retryable: false, message: 'Önce acil durum kişilerini seç' },
  sos_not_active: { retryable: false, message: 'Acil durum uyarısı artık aktif değil' },
  note_not_found: { retryable: false, message: 'Not bulunamadı' },
  note_limit_reached: { retryable: false, message: 'Aynı anda en fazla 20 yer notun olabilir' },
  // Faz 5
  zone_not_found: { retryable: false, message: 'Bölge bulunamadı' },
  zone_limit_reached: { retryable: false, message: 'En fazla 15 bölge kaydedebilirsin' },
  meetup_not_found: { retryable: false, message: 'Buluşma önerisi bulunamadı ya da süresi doldu' },
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

// --- istemcinin dinlediği "olaylar" (Firestore / RTDB değişikliklerinden türetilir) --

export type ClientEvent =
  | { type: 'share.started'; share: OutgoingShareView }
  | { type: 'share.extended'; share: OutgoingShareView }
  | { type: 'share.ended'; share_id: ShareId; reason: ShareEndReason }
  | { type: 'location.updated'; share_id: ShareId; sender_id: UserId }
  | { type: 'location.removed'; share_id: ShareId; sender_id: UserId }
  | { type: 'location_request.received'; request_id: string; requester_id: UserId }
  | { type: 'friend_request.received'; friendship_id: string; from: UserId }
  // Faz 2
  | { type: 'link.started'; link: LinkShareView }
  | { type: 'link.extended'; link: LinkShareView }
  | { type: 'link.ended'; link_id: LinkId; reason: LinkEndReason };

/** FCM data mesajı: KOORDİNAT TAŞIMAZ. */
export type PushData =
  | { type: 'location_request'; request_id: string }
  | { type: 'friend_request'; friendship_id: string }
  | { type: 'share_started'; share_id: string }
  | { type: 'share_ending_soon'; session_id: string }
  // Faz 2
  | { type: 'link_ending_soon'; link_id: string }
  // Faz 3 (FCM gereği değerler string)
  /** Alıcıya, görünür: gönderenin pili %15 altına indi. `battery_pct` "14" gibi tam sayı metni. */
  | { type: 'battery_low'; share_id: string; battery_pct: string }
  /** Gönderenin KENDİ cihazına, yalnızca veri (sessiz uyandırma). `session_ids` virgülle ayrılır; `level` "1" | "2". */
  | { type: 'resume_tracking'; session_ids: string; level: string }
  /** Gönderenin kendi cihazına, görünür: "Konum paylaşımın duraksadı. Devam etmek için dokun." */
  | { type: 'tracking_stalled'; session_ids: string }
  // Faz 4
  /** Alıcıya, görünür: "Ayşe · 📍 Buradayım". `kind` = PingKind. Konum push'ta YOK, `ping_inbox`'tan okunur. */
  | { type: 'ping'; ping_id: string; from: string; kind: string }
  /** Alıcıya, kritik/yüksek öncelik: acil durum. Gövde adres + doğruluk + pil; koordinat `sos_alerts`'tan okunur. */
  | { type: 'sos'; sos_id: string; sender_id: string }
  /** Alıcıya, görünür: gönderen "Güvendeyim" dedi. */
  | { type: 'sos_resolved'; sos_id: string; sender_id: string }
  /** Gönderene, görünür: alıcı uyarıyı gördü. */
  | { type: 'sos_ack'; sos_id: string; by: string }
  // Faz 5
  /** Kural alıcısına, görünür: "Erim · Ev konumuna vardı". Koordinat YOK, yalnızca bölge adı. */
  | { type: 'zone_event'; from: string; zone_name: string; transition: string }
  /** Alıcıya, görünür: buluşma noktası önerisi. Yer adı gövdede; konum `meetups`'tan okunur. */
  | { type: 'meetup'; meetup_id: string; from: string }
  /** Önerene, görünür: alıcı yanıt verdi. `response` = accepted | declined. */
  | { type: 'meetup_response'; meetup_id: string; by: string; response: string };

/** Faz 3 FCM veri türleri (istemci işleyicileri ve sözleşme testi için). */
export const PUSH_TYPES_F3 = ['battery_low', 'resume_tracking', 'tracking_stalled'] as const satisfies readonly PushData['type'][];

/** Faz 4 FCM veri türleri. */
export const PUSH_TYPES_F4 = ['ping', 'sos', 'sos_resolved', 'sos_ack'] as const satisfies readonly PushData['type'][];

/**
 * Faz 4 bildirim kanalları (Android kanal kimliği = iOS kategori kimliği).
 *  - `sos`: Android IMPORTANCE_MAX, rahatsız etme modunu aşma (kullanıcı izni), alarm sesi, kilit ekranında herkese açık;
 *    iOS `interruption-level: critical` (Apple Critical Alerts yetkisi onaylanırsa) yoksa `time-sensitive`.
 *  - `ping`: Android IMPORTANCE_HIGH; iOS `active`.
 */
export const NOTIFICATION_CHANNELS_F4 = { sos: 'sos', ping: 'ping' } as const;

/** Faz 5 FCM veri türleri. */
export const PUSH_TYPES_F5 = ['zone_event', 'meetup', 'meetup_response'] as const satisfies readonly PushData['type'][];
