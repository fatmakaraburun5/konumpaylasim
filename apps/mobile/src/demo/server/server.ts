/**
 * Bellek içi demo sunucusu (yalnızca web önizlemesi).
 *
 * Gerçek backend'in (Cloud Functions + Firestore + RTDB kuralları) davranışını, uygulamanın gördüğü
 * sözleşmeler düzeyinde taklit eder:
 *  - callable'lar: user_bootstrap, share_start / extend / stop / revoke, friend_request_send / respond /
 *    cancel, friendship_remove. Girdi core zod şemalarıyla doğrulanır, süreler core `resolveDuration` /
 *    `extendExpiry` ile hesaplanır, kimlikler core `shareId` / `friendshipId` ile üretilir. Her çağrı
 *    150–400 ms gecikir ve `op_id` ile tekilleştirilir.
 *  - dinleyiciler: profil, arkadaşlıklar (bekleyen dahil), giden istekler, giden / gelen paylaşımlar,
 *    canlı gelen kutusu. Değişiklikler commit sonrası eşzamansız iletilir.
 *  - RTDB çok yollu yazma: `database.rules.json`'daki `live_locations` kuralı birebir uygulanır
 *    (gönderen aktif ve süresi dolmamış paylaşımın sahibi mi, zorunlu / izinli alanlar, zaman penceresi,
 *    share_mode ve expires_at ACL ile aynı mı). Bir yol reddedilirse tüm yazma reddedilir.
 *  - süpürücü (1 sn): süresi dolan paylaşımı `expired` ile bitirir ve alıcı kopyasını siler; botları yürütür.
 *
 * Faz 2 (backend `handlers/links.ts`, `linkAcl.ts`, `handlers/maps.ts` ile aynı sözleşme):
 *  - `link_share_create / extend / stop`: token `crypto.getRandomValues` (32 bayt) + core `encodeLinkToken`;
 *    sunucu YALNIZCA `linkTokenHash(token)` saklar, düz token ve URL (core `buildLinkUrl`, `LINK_DOMAIN_DEFAULT`)
 *    yalnızca create yanıtında döner, op kaydına girmez. Yanıtı kaybolan create tekrarında token YENİLENİR.
 *    Durdurma / süre dolumu sırası: kayıt → `link_acl` mezar taşı → `link_live` silme (açık izleyici anında görür).
 *  - `link_live/{hash}`: `database.rules.json` kuralı (yazma: ACL aktif + gönderen + alanlar; okuma: ACL aktif ve
 *    süresi dolmamış, kimlik gerekmez). Kural sonradan reddederse açık dinleyici `permission_denied` alır.
 *  - `route_compute` / `geocode_reverse`: önbellek (core `routeCacheKey` 5 dk, uid kapsamlı; `geocodeCell` 30 gün)
 *    → günlük kota (core `MAPS_DAILY_LIMITS`) → sahte Google (`fakeGoogle.ts`, Google JSON biçimi) → core
 *    `parseRoutesResponse` / `parseReverseGeocodeResponse`. Önbellek isabeti kota yemez. Demo panelinden
 *    "Google yanıt vermesin" açılınca önbellekte olmayan her istek `maps_unavailable` alır.
 *
 * Faz 3 (backend `database.rules.json` + `handlers/battery.ts` ile aynı sözleşme):
 *  - Paketler isteğe bağlı `hb`, `q`, `recorded_at` taşır. `q === 1` (çevrimdışı kuyruk) iken zaman penceresi 24 sa'e
 *    genişler AMA nokta düğümdekinden yeni ve ACL `started_at`'ten eski olmamalıdır.
 *  - `live_trail/{receiver}/{share_id}/{point_id}`: kuyruk noktalarının izi (yalnızca alıcı okur, paylaşım bitince silinir).
 *  - `battery_low_notify`: core `lowBatteryTrigger` oturum başına; alıcıya "Ayşe Yılmaz'ın pili azaldı" push'u (koordinat YOK).
 *  - Botlar: paketlerde matris `hb`'si; Ayşe'nin pili %14'e düşer (push + seyrek güncelleme), Mehmet'in bağlantısı kopar
 *    (demo süreyi atlar: son paket ~1 saat önceye çekilir).
 *
 * Faz 4 (backend `handlers/ping.ts`, `notes.ts`, `sos.ts` + kurallarla aynı anlam):
 *  - `ping_send`: kabul edilmiş arkadaş, çift başına 20 sn soğuma, saatlik tavan → RTDB `ping_inbox/{to}/{id}` + push.
 *  - `place_note_upsert / delete`: Firestore `place_notes` (sahibi + `visible_to` okur), en çok 20 aktif not.
 *  - `emergency_contacts_set`, `sos_send / update / resolve / ack`: Firestore `sos_alerts`; tam konum + adres (önbellek /
 *    sahte Google, kota dışı) + harita bağlantısı + pil + rota; alıcılara yüksek öncelikli push. Aktif SOS varken yeni
 *    gönderim aynı belgeyi günceller. Bot alıcılar birkaç saniye sonra "Gördüm" der (gönderene push).
 *  - Canlı paketlerde isteğe bağlı durum notu (`note` 1..60 + `note_exp`, ikisi birlikte); `link_live`'a not gitmez.
 *  - Demo paneli: Ayşe / Mehmet ping, Ayşe durum notu, park yeri notu, Ayşe SOS + "güvende".
 *
 * Faz 5 (backend `zone_*` / `meetup_*` callable'larıyla aynı anlam; SPEC "Callable'lar"):
 *  - `zone_upsert / delete`: `users/{uid}/zones` (yalnızca sahibi okur), en çok 15 bölge, kural alıcıları kabul edilmiş
 *    arkadaşlar (diğerleri SESSİZCE düşer, alıcısız kural silinir), düzenlemede `created_at` korunur.
 *  - `zone_event_report`: eski olay `stale`, kapalı bölge `disabled`, kural penceresi (`localClock`, bölgenin dilimi)
 *    `outside_window`, aynı bölge + yön 5 dk `cooldown`, günlük 60 `daily_limit`; notify → alıcılara `zone_event` push'u
 *    (koordinat YOK), start_share → yanıtta. Her olay `zone_events`'e loglanır.
 *  - `meetup_suggest`: merkez + yayılım → too_close / too_far → önbellek (10 dk, kota yemez) → günlük kota → "Google yanıt
 *    vermesin" (places_unavailable) → sahte Places (`fakePlaces.ts`) → en yakın K → mod başına sahte Route Matrix →
 *    `rankMeetupCandidates`; boş hücre `fallbackEta` (estimated). `meetup_share / respond / cancel`: `meetups` + push.
 *  - Demo paneli: Ayşe eve vardı (bot kuralı → bana zone_event), Ayşe buluşma noktası önersin (bana meetup → kart).
 *
 * Faz 6 (backend `handlers/user.ts`, `favorites.ts`, `widget.ts` ile aynı anlam; SPEC §1–2):
 *  - Profiller `gender` (bot: Ayşe / Zeynep / Elif kadın, Mehmet / Can erkek) ve çizim avatar taşır (`avatars.ts`;
 *    gerçek kişi fotoğrafı YOK, Can fotoğrafsız → baş harfler). Arkadaş kopyası (`member_profiles`) ad + fotoğraf +
 *    cinsiyet; bekleyen istek kopyası yalnızca ad. Okumada Storage adresleri yerel `blob:` / `data:` adresine çözülür.
 *  - `user_bootstrap`: profil OLUŞTURULURKEN (demo: ilk kez ad verilirken) `gender` zorunlu → `gender_required`;
 *    sonra verilmezse kalır, `null` reddedilir. `avatar_url` + `avatar_thumb_url` üretim biçimli Storage adresi, aynı
 *    sürümün `_160` kardeşi (core `checkAvatarPair`); fotoğraf değişince eski sürümün iki nesnesi silinir.
 *  - `storageUpload / storageDelete`: `storage.rules` (yalnızca sahibi, `AVATAR_FILE_RE`, image/jpeg, boyut sınırları).
 *  - `favorites_set`: kabul edilmiş arkadaş olmayanlar sessizce düşer (core `sanitizeFavorites`); arkadaşlık
 *    kaldırılınca iki tarafın listesinden de çıkar.
 *  - `widget_token_issue / revoke`: token yalnızca yanıtta (op kaydına girmez, her çağrı aynı cihazın eskisini iptal
 *    edip YENİSİNİ verir), sunucu sha256 özetini saklar; günde 20 üretim, en çok 5 aktif cihaz.
 *  - `widget_quick_share` (OTURUMSUZ, yetki = token): token_invalid → token_expired → not_favorite → not_friend →
 *    rate_limited (token başına saatte 6 başarılı çağrı) → core `quickShareExpiry` (started / extended /
 *    already_active). `op_id` token başına tekilleştirilir. Sonra gönderene `resume_tracking` + görünür
 *    `quick_share_started` push'u (koordinat YOK).
 *  - `widget_refresh` (yalnızca veri): bir paylaşımın aktifliği değişince, alıcı göndereni favorilerinde tutuyorsa.
 *  - Demo paneli: token'ın sunucuda süresi dolsun, hız sınırı dolsun, favorileri boşalt / geri yükle.
 *
 * Faz 8 (backend `handlers/access.ts` ve daraltılan Faz 1–6 işleyicileriyle aynı anlam; docs/PHASE8.md §3–§4, §6):
 *  - Arkadaşlık izin DEĞİLDİR: her etkileşim yönlü `permission_grants/{granter}_{grantee}` kaydına dayanır (core
 *    `access.ts`; `areFriends` tek başına hiçbir yetki vermez). Belge geçişleri core'un saf fonksiyonlarıyla
 *    (`withGranted`, `withRevoked`, `withPendingRequest`, `withResponse`, `planPermissionRequest`). Ret anları
 *    belgede BOŞ, sunucuya özel tabloda (`perm_declines`) tutulur; soğumadaki istek sessizce `sent` döner.
 *  - Onay kapısı: güncel `CONSENT_VERSION` onaylanmadan koruyucu olmayan her callable `consent_required` (op tekrarından
 *    ÖNCE; core `consentExemptCall`). `consent_accept` sürüm + özet uyuşmazsa `consent_required`.
 *  - Görünmez mod: `invisible_set(true)` giden paylaşımların anlık görüntüsünü alıp hepsini `stopped_by_sender` ile
 *    bitirir, QR bağlantılarını kapatır; görünmezken RTDB yazıları reddedilir, paylaşım / uzatma / bağlantı / hızlı
 *    paylaşım `invisible_mode`, bölge olayı `suppressed:'invisible'`. Görünür olunca yalnızca seçilenler geri gelir.
 *  - Tohum (`withPhase8`): Ayşe / Mehmet / Zeynep bana `location_view` vermiş (`migration`), Can vermemiş; benim
 *    kimseye iznim yok; acil kişi listeleri `sos_alert`; benim onayım YOK (kapı görünür). Botlar bana yalnızca
 *    `location_view` izni varken paylaşır; isteğime 6 sn sonra yanıt verir (Can izin verir ve 1 saat paylaşır).
 *
 * Faz 7 (backend `handlers/events.ts`, `handlers/privacy.ts` ile aynı anlam; docs/PHASE7.md):
 *  - `event_create … event_cancel`: core `createEventDoc` / `reduceEvent` (saf durum makinesi). Davet yalnızca bana
 *    `meetup_invite` vermiş arkadaşlara (`canInvite`); diğerleri sessizce düşer, SAYISI döner. Etkiler → bildirim kutusu
 *    (`users/{uid}/notices`, 30 gün) + push; hatırlatıcılar `event_reminders` (1 gün önce, gün sabahı 08:00).
 *  - Süpürücü: oylama süresi / gün sonu / tamamlanma `tick`'i, zamanı gelen hatırlatmalar (2 sa'ten geç kalan `stale`).
 *  - Botlar üye olduğu etkinlikte birkaç saniye sonra yanıt verir (Can "Katılamayacağım" + not), mekan önerir, oy verir,
 *    son onayı verir; bot sahibi mekan oylamasını açar ve eşitlikte kazananı seçer.
 *  - `privacy_settings_set`: `users/{uid}.privacy` (+ RTDB aynası anlamı): pil paylaşımı KAPALIYKEN canlı paketlerde
 *    `battery_pct` / `is_charging` reddedilir ve `battery_low_notify` `suppressed` döner. Botlar pil paylaşır.
 *  - `movement_report`: etkin paylaşımlarımın alıcılarına (tercihi açık olanlara) "yola çıktı"; 30 dk soğuma.
 *  - Tohum (`withPhase7`): Ayşe / Mehmet / Zeynep bana `meetup_invite` vermiş (etkinliğe davet edilebilirler), Can vermemiş.
 *
 * Durum tarayıcıda `localStorage`'a yazılır (erişilemezse yalnızca bellekte kalır). Sunucu saati = cihaz saati.
 */
import {
  EmergencyContactsSetRequestSchema,
  geohashEncode,
  isSosActive,
  NOTE_LIMITS,
  PING_LIMITS,
  pingHourBucket,
  pingPushText,
  PingSendRequestSchema,
  PlaceNoteDeleteRequestSchema,
  PlaceNoteUpsertRequestSchema,
  sanitizeNoteText,
  SOS_LIMITS,
  SOS_MESSAGE,
  sosAckPushText,
  SosAckRequestSchema,
  sosHourBucket,
  sosMapsUrl,
  sosPushText,
  sosResolvedPushText,
  SosResolveRequestSchema,
  SosSendRequestSchema,
  SosUpdateRequestSchema,
  statusNoteExtras,
  PACKET_NOTE_MAX_CHARS,
  type PingKind,
  type PingSendResponse,
  type PlaceNote,
  type PlaceNoteDeleteResponse,
  type PlaceNoteUpsertResponse,
  type SosAlert,
  type SosAlertResponse,
  type SosLocation,
  type SosRoute,
  type SosSendResponse,
  type StatusNote,
  BatteryLowNotifyRequestSchema,
  buildPackets,
  canExtend,
  lowBatteryPushText,
  lowBatteryTrigger,
  PACKET_LIMITS,
  selectTrackingPlan,
  TRAIL_FIELDS,
  type BatteryLowNotifyResponse,
  type LowBatteryState,
  type MotionState,
  type PacketExtras,
  type PushData,
  DAY,
  DurationError,
  encodeLinkToken,
  extendExpiry,
  formatInviteCode,
  geocodeCell,
  geocodeQueryPoint,
  GeocodeReverseRequestSchema,
  GEOCODE_POLICY,
  isLinkTokenHash,
  LINK_DOMAIN_DEFAULT,
  LINK_LIMITS,
  LINK_LIVE_FIELDS,
  LINK_TOKEN_BYTES,
  LinkShareCreateRequestSchema,
  LinkShareExtendRequestSchema,
  LinkShareStopRequestSchema,
  linkTokenHash,
  MAPS_DAILY_LIMITS,
  parseReverseGeocodeResponse,
  parseRoutesResponse,
  quotaDay,
  buildLinkUrl,
  routeCacheKey,
  RouteComputeRequestSchema,
  routesRequestBody,
  ROUTE_POLICY,
  FriendRequestRespondSchema,
  FriendRequestSendSchema,
  friendshipId,
  HOUR,
  maskPhone,
  MINUTE,
  normalizeInviteCode,
  offsetFnForTimeZone,
  resolveDuration,
  SECOND,
  SERVER_TIMESTAMP,
  ShareExtendRequestSchema,
  ShareRevokeRequestSchema,
  shareId,
  ShareStartRequestSchema,
  ShareStopRequestSchema,
  sortedPair,
  toFanoutUpdate,
  uuidV4,
  type DurationChoice,
  type EpochMs,
  type ErrorCode,
  type Friendship,
  type LatLng,
  type LinkEndReason,
  type LinkShareCreateResponse,
  type LinkShareUpdateResponse,
  type LinkShareView,
  type MapsQuotaKind,
  type OutgoingShareView,
  type ShareEndReason,
  type ShareMode,
  type UserId,
  type UserProfile,
} from '@konum/core';
import {
  fallbackEta,
  isMeetupActive,
  localClock,
  matchZoneRules,
  MEETUP_LIMITS,
  meetupCacheKey,
  meetupCenter,
  MeetupCancelRequestSchema,
  meetupPushText,
  MeetupRespondRequestSchema,
  meetupResponsePushText,
  meetupScore,
  MeetupShareRequestSchema,
  meetupSpreadM,
  MeetupSuggestRequestSchema,
  nearestCandidates,
  parsePlacesNearbyResponse,
  parseRouteMatrixResponse,
  placesNearbyRequestBody,
  rankMeetupCandidates,
  routeMatrixRequestBody,
  searchRadiusM,
  ZONE_EVENT_LOG_TTL_MS,
  ZONE_LIMITS,
  ZoneDeleteRequestSchema,
  ZoneEventReportRequestSchema,
  zoneEventPushText,
  ZoneUpsertRequestSchema,
  type Meetup,
  type MeetupCategory,
  type MeetupEta,
  type MeetupParticipant,
  type MeetupResponse,
  type MeetupSuggestion,
  type MeetupSuggestResponse,
  type TravelMode,
  type Zone,
  type ZoneDeleteResponse,
  type ZoneEventLog,
  type ZoneEventReportResponse,
  type ZoneRule,
  type ZoneTrigger,
  type ZoneUpsertResponse,
} from '@konum/core';
import {
  avatarObjectPathFromUrl,
  avatarObjectPaths,
  checkAvatarPair,
  FavoritesSetRequestSchema,
  generateWidgetToken,
  isGender,
  parseAvatarObjectPath,
  ProfileFieldsF6Schema,
  QUICK_SHARE_LIMITS,
  quickShareExpiry,
  quickSharePushText,
  resolveProfileGender,
  sanitizeFavorites,
  WIDGET_QUICK_SHARE_ENDPOINT,
  WidgetQuickShareRequestSchema,
  WidgetTokenIssueRequestSchema,
  widgetTokenHash,
  WidgetTokenRevokeRequestSchema,
  type FavoritesSetResponse,
  type Gender,
  type PublicProfile,
  type WidgetQuickShareResponse,
  type WidgetTokenIssueResponse,
  type WidgetTokenRevokeResponse,
} from '@konum/core';
import {
  canInvite,
  canPing,
  canRequestPermission,
  canSendSos,
  canShareLocation,
  canZoneNotify,
  CONSENT_VERSION,
  ConsentAcceptRequestSchema,
  consentExemptCall,
  withConsentHistory,
  consentRequired,
  ConsentWithdrawSchema,
  emptyGrantDoc,
  grantedScopes,
  grantId,
  hasGrant,
  INVISIBLE_SNAPSHOT_MAX,
  InvisibleSetRequestSchema,
  isCurrentConsent,
  isInvisible,
  meetupEtaAllowed,
  noteAudienceAllowed,
  pendingScopes,
  liveRequestScopes,
  PERMISSION_REQUESTS_PER_DAY,
  permissionGrantedText,
  permissionRequestText,
  PermissionRequestRespondSchema,
  PermissionRequestSendSchema,
  PermissionSetSchema,
  pingLocationAllowed,
  planInvisibleOn,
  planInvisibleRestore,
  planPermissionRequest,
  REVOKE_EFFECTS,
  withGranted,
  withPendingRequest,
  withResponse,
  withRevoked,
  type AccessScope,
  type ConsentAcceptResponse,
  type ConsentRecord,
  type ConsentWithdrawResponse,
  type GrantVia,
  type InvisibleSetResponse,
  type InvisibleState,
  type PairAccessInput,
  type PermissionGrantDoc,
  type PermissionRequestRespondResponse,
  type PermissionRequestSendResponse,
  type PermissionSetResponse,
  type ProfileConsent,
  type RequestableScope,
} from '@konum/core';
import {
  effectiveRequestStatus as lrEffectiveStatus,
  LOCATION_REQUEST_LIMITS,
  LocationRequestCancelSchema,
  LocationRequestRespondSchema,
  LocationRequestSendSchema,
  locationRequestAnsweredText,
  locationRequestPushText,
  requestId as locationRequestId,
  type LocationRequestCancelResponse,
  type LocationRequestRespondResponse,
  type LocationRequestSendResponse,
  type LocationRequestStatus,
} from '@konum/core';
import {
  addDaysToDate,
  createEventDoc,
  EVENT_LIMITS,
  EVENT_REMINDER_KINDS,
  EVENT_REMINDER_MAX_LATENESS_MS,
  EventAdvanceRequestSchema,
  EventCancelRequestSchema,
  eventCancelledPushText,
  EventCreateRequestSchema,
  EventInviteAddRequestSchema,
  eventInvitePushText,
  eventNextActionAt,
  eventReminderId,
  eventReminderPlan,
  eventReminderPushText,
  eventReminderRecipients,
  EventRsvpRequestSchema,
  eventRsvpPushText,
  eventStagePushText,
  eventTally,
  EventTimeOptionsSetRequestSchema,
  EventUpdateRequestSchema,
  EventVenueProposeRequestSchema,
  EventVenueRemoveRequestSchema,
  EventVoteRequestSchema,
  isActiveEventStage,
  localDateOf,
  localDateTimeToEpoch,
  MOVEMENT_LIMITS,
  movementPushText,
  MovementReportRequestSchema,
  NOTICE_LIST_LIMIT,
  NOTICE_RETENTION_MS,
  parsePrivacy,
  PrivacySettingsSetRequestSchema,
  reduceEvent,
  type EventAction,
  type EventCtx,
  type EventDoc,
  type EventEffect,
  type EventNotice,
  type EventNoticeType,
  type EventReminderKind,
  type EventResponse,
  type EventResult,
  type EventVenueInput,
  type MovementReportResponse,
  type PrivacySettings,
  type PrivacySettingsResponse,
} from '@konum/core';
import { z } from 'zod';
import { botAvatarUrls, DEMO_STORAGE_BUCKET, DEMO_STORAGE_HOST, DemoAvatarStore, DemoStorageError, uriToDataUrl } from './avatars';
import { fakeComputeRoutes, fakeReverseGeocode } from './fakeGoogle';
import { fakePlacesNearby, fakeRouteMatrix } from './fakePlaces';
import { demoCurrentUid } from '../web/session';
import { safeStorage } from './storage';
import {
  AYSE_PATH,
  DEMO_ME,
  DEMO_ME_FAVORITES,
  DEMO_ME_INVITE,
  DEMO_ME_NAME,
  EXTRA_SPOTS,
  jitter,
  MEHMET_SPOT,
  NAME_POOL,
  NAME_POOL_GENDER,
  PEOPLE,
  pointAlong,
  ZEYNEP_SPOT,
} from './world';

export const DEMO_STORAGE_KEY = 'konum.demo.server.v1';
const DB_VERSION = 3;

// --- kayıt şekilleri -------------------------------------------------------------------------

interface UserRec {
  uid: UserId;
  display_name: string;
  invite_code: string;
  created_at: EpochMs;
  time_zone: string;
  // --- Faz 6 (eski kayıtlarda yok: `withPhase6` tamamlar) ---
  /** `null` yalnızca Faz 6 öncesi (eski) hesap ya da henüz adı verilmemiş demo hesabı. */
  gender: Gender | null;
  /** Üretim biçimli Storage adresleri (okumada yerel adrese çözülür). */
  avatar_url: string | null;
  avatar_thumb_url: string | null;
  avatar_version: number | null;
  /** Sıralı favoriler (yalnızca sahibi okur). */
  favorite_ids: UserId[];
  // --- Faz 8 (eski kayıtlarda yok: `withPhase8` tamamlar) ---
  invisible: InvisibleState | null;
  consent: ProfileConsent | null;
  /** Görünmez moddan son çıkış anı (backend `users.visible_since`; bu andan önceki bölge olayı düşer). */
  visible_since?: EpochMs | null;
  // --- Faz 7 (eski kayıtlarda yok: `withPhase7` tamamlar) ---
  /** `users/{uid}.privacy` (+ RTDB aynası `privacy/{uid}`); `null` = hiç ayarlanmadı (varsayılan: pil KAPALI). */
  privacy?: PrivacySettings | null;
}

/** Firestore `widget_tokens/{sha256(token)}` (istemciye tamamen kapalı; düz token SAKLANMAZ). */
interface WidgetTokenRec {
  uid: UserId;
  device_id: string;
  created_at: EpochMs;
  expires_at: EpochMs;
  last_used_at: EpochMs | null;
  uses: { window_start: EpochMs; count: number };
  revoked: boolean;
  revoked_at: EpochMs | null;
}

interface FriendshipRec extends Friendship {
  target_id: UserId;
  accepted_at: EpochMs | null;
}

interface OutgoingRec {
  id: string;
  via: 'invite_code' | 'phone';
  label: string;
  created_at: EpochMs;
  expires_at: EpochMs;
  friendship_id: string | null;
  /** Demo: hedef bu anda isteği kendiliğinden kabul eder. */
  auto_accept_at: EpochMs | null;
}

interface ShareRec {
  share_id: string;
  session_id: string;
  audience: 'friend';
  sender_id: UserId;
  receiver_id: UserId;
  status: 'active' | 'ended';
  share_mode: ShareMode;
  started_at: EpochMs;
  expires_at: EpochMs | null;
  ended_at: EpochMs | null;
  end_reason: ShareEndReason | null;
  version: number;
  extended_count: number;
  in_response_to: string | null;
  updated_at: EpochMs;
}

/** RTDB `share_acl/{id}`: aktif kayıt ya da `{status:'ended', version, ended_at}` mezar taşı. */
interface AclRec {
  status: 'active' | 'ended';
  version: number;
  sender_id?: UserId;
  receiver_id?: UserId;
  share_mode?: ShareMode;
  expires_at?: EpochMs;
  /** Faz 3: aktif aynada paylaşımın başlangıcı (kuyruk noktası bundan eski olamaz). */
  started_at?: EpochMs;
  ended_at?: EpochMs;
}

/** Firestore `link_shares/{link_id}` (core `LinkShare`; düz token YOK, yalnızca özet). */
interface LinkRec {
  link_id: string;
  session_id: string;
  audience: 'link';
  sender_id: UserId;
  token_hash: string;
  status: 'active' | 'ended';
  share_mode: ShareMode;
  started_at: EpochMs;
  expires_at: EpochMs | null;
  ended_at: EpochMs | null;
  end_reason: LinkEndReason | null;
  version: number;
  extended_count: number;
  updated_at: EpochMs;
}

/** RTDB `link_acl/{token_hash}`: aktif kayıt ya da mezar taşı (backend `StoredLinkAcl`). İstemciye kapalı. */
interface LinkAclRec {
  status: 'active' | 'ended';
  version: number;
  sender_id?: UserId;
  link_id?: string;
  share_mode?: ShareMode;
  expires_at?: EpochMs;
  /** Faz 3 (bkz. AclRec). */
  started_at?: EpochMs;
  ended_at?: EpochMs;
  end_reason?: LinkEndReason;
}

/** Firestore `route_cache/{routeCacheKey(..., uid)}` (yalnızca sunucu). */
interface RouteCacheRec {
  uid: UserId;
  distance_m: number;
  duration_s: number;
  polyline: string;
  computed_at: EpochMs;
  expire_at: EpochMs;
}

/** Firestore `geocode_cache/{geohash7}` (kullanıcılar arası paylaşılır: Google'a hücre merkezi sorulur). */
interface GeocodeCacheRec {
  label: string | null;
  created_at: EpochMs;
  expire_at: EpochMs;
}

/** `maps_quota/{uid}_{gün}`: Google'a giden çağrılar (kota) + demo paneli için önbellek isabetleri. */
interface MapsQuotaRec {
  route: number;
  geocode: number;
  route_hits: number;
  geocode_hits: number;
  /** Faz 5: buluşma noktası sorguları (Places + matris) ve önbellek isabetleri. */
  meetup?: number;
  meetup_hits?: number;
}

/** Faz 5: `zone_events` kaydı (+ demo kimliği). */
interface ZoneEventRec extends ZoneEventLog {
  id: string;
  purge_at: EpochMs;
}

type BotKind = 'walker' | 'heartbeat' | 'stale' | 'idle';

/** Faz 3: düşük pil tetikleyicisi oturum başına (backend `battery_alerts/{uid}_{session_id}`). */
interface BatteryAlertRec {
  uid: UserId;
  session_id: string;
  state: LowBatteryState;
  /** 24 sa içindeki bildirim anları (oturum başına ≤ 6). */
  sent: EpochMs[];
}

/** Demo paneli: en son giden düşük pil bildirimi (benim pilim azaldığında alıcılarıma). */
export interface DemoBatteryNotice {
  at: EpochMs;
  pct: number;
  receivers: string[];
  title: string;
  body: string;
}

/** FCM benzeri demo push'u (yalnızca uygulama açıkken dinleyiciye gider). */
export interface DemoPushMessage {
  notification?: { title: string; body: string };
  data: Record<string, string>;
}

interface BotRec {
  uid: UserId;
  kind: BotKind;
  battery: number;
  charging: boolean;
  /** Yürüyüşün başladığı an (konum = yol üzerinde geçen süre × hız). */
  walk_origin: EpochMs;
  /** Bir sonraki paket anı. */
  next_at: EpochMs;
  spot: LatLng;
  /** Faz 3: bağlantısı koptu (paket göndermiyor; "Mehmet'in bağlantısı kopsun"). */
  offline?: boolean;
}

interface Db {
  v: number;
  seeded_at: EpochMs;
  users: Record<UserId, UserRec>;
  invites: Record<string, UserId>;
  friendships: Record<string, FriendshipRec>;
  outgoing: Record<UserId, Record<string, OutgoingRec>>;
  shares: Record<string, ShareRec>;
  acl: Record<string, AclRec>;
  /** RTDB `live_locations/{receiver}/{share_id}` (server_ts çözülmüş). */
  live: Record<UserId, Record<string, Record<string, unknown>>>;
  ops: Record<string, { at: EpochMs; response: unknown }>;
  bots: Record<UserId, BotRec>;
  name_seq: number;
  // --- Faz 2 (eski kayıtlarda yok: `withPhase2` tamamlar) ---
  links: Record<string, LinkRec>;
  link_acl: Record<string, LinkAclRec>;
  /** RTDB `link_live/{token_hash}` (server_ts çözülmüş). */
  link_live: Record<string, Record<string, unknown>>;
  route_cache: Record<string, RouteCacheRec>;
  geocode_cache: Record<string, GeocodeCacheRec>;
  maps_quota: Record<string, MapsQuotaRec>;
  /** Demo paneli: "Google yanıt vermesin" (anahtar yok / Google hatası benzetimi). */
  maps_down: boolean;
  // --- Faz 3 (eski kayıtlarda yok: `withPhase3` tamamlar) ---
  phase3: boolean;
  /** RTDB `live_trail/{receiver}/{share_id}/{point_id}` (server_ts çözülmüş). */
  trail: Record<UserId, Record<string, Record<string, Record<string, unknown>>>>;
  battery_alerts: Record<string, BatteryAlertRec>;
  battery_notice: DemoBatteryNotice | null;
  // --- Faz 4 (eski kayıtlarda yok: `withPhase4` tamamlar) ---
  phase4: boolean;
  /** RTDB `ping_inbox/{to}/{ping_id}` (null alanlar yazılmaz). */
  ping_inbox: Record<UserId, Record<string, Record<string, unknown>>>;
  /** Çift başına son ping (`{from}_{to}`) ve saatlik sayaç (`{uid}_{saat}`). */
  ping_pair: Record<string, EpochMs>;
  ping_hour: Record<string, number>;
  /** Firestore `place_notes/{note_id}`. */
  place_notes: Record<string, PlaceNote>;
  /** Firestore `sos_alerts/{sos_id}` + saatlik sayaç. */
  sos: Record<string, SosAlert>;
  sos_hour: Record<string, number>;
  /** Demo: bot alıcının otomatik "Gördüm" anı (`{sos_id}|{uid}` → an). */
  sos_auto_ack: Record<string, EpochMs>;
  /** `users/{uid}.emergency_contacts`. */
  emergency: Record<UserId, UserId[]>;
  /** Bot durum notları (bot paketlerine eklenir). */
  bot_notes: Record<UserId, StatusNote>;
  // --- Faz 5 (eski kayıtlarda yok: `withPhase5` tamamlar) ---
  /** Firestore `users/{uid}/zones/{zone_id}`. */
  zones: Record<UserId, Record<string, Zone>>;
  /** Firestore `users/{uid}/zone_events` (en yeni önde). */
  zone_events: Record<UserId, ZoneEventRec[]>;
  /** `zone_cooldowns/{uid}_{zone_id}_{transition}` → son bildirim anı; günlük sayaç `{uid}_{gün}`. */
  zone_cooldowns: Record<string, EpochMs>;
  zone_daily: Record<string, number>;
  /** Firestore `meetups/{meetup_id}` ve `meetup_cache/{key}`. */
  meetups: Record<string, Meetup>;
  meetup_cache: Record<string, { response: MeetupSuggestResponse; expire_at: EpochMs }>;
  /** Demo: bot alıcının otomatik "Geliyorum" anı (`{meetup_id}|{uid}` → an). */
  meetup_auto: Record<string, EpochMs>;
  // --- Faz 6 (eski kayıtlarda yok: `withPhase6` tamamlar) ---
  phase6: boolean;
  /** Firestore `widget_tokens/{sha256Hex(token)}`. */
  widget_tokens: Record<string, WidgetTokenRec>;
  /** Günlük token üretim sayacı `{uid}_{gün}` (backend `rate_limits/..._widget_token`). */
  widget_issue: Record<string, number>;
  /** `widget_quick_share` op kaydı `{token_hash}:{op_id}` (token başına tekilleştirme). */
  widget_ops: Record<string, { at: EpochMs; response: WidgetQuickShareResponse }>;
  // --- Faz 8 (eski kayıtlarda yok: `withPhase8` tamamlar) ---
  phase8: boolean;
  /** Firestore `permission_grants/{granter}_{grantee}` (`declined_at` her zaman boş yazılır). */
  grants: Record<string, PermissionGrantDoc>;
  /** Sunucuya özel ret anları (`permission_declines/{granter}_{grantee}`): isteyene sızmaz. */
  perm_declines: Record<string, PermissionGrantDoc['declined_at']>;
  /** Günlük izin isteği sayacı `{uid}_{gün}`. */
  perm_day: Record<string, number>;
  /** Demo: bot granter'ın isteğime otomatik yanıt anı (`{granter}_{grantee}` → an). */
  perm_auto: Record<string, EpochMs>;
  /** `users/{uid}/consents/{version}`. */
  consents: Record<UserId, Record<string, ConsentRecord>>;
  // --- Konum İste (eski kayıtlarda yok: `withPhase8` tamamlar) ---
  /** Firestore `location_requests/{requester}_{target}`. */
  loc_requests: Record<string, LocReqRec>;
  /** Günlük konum isteği sayacı `{uid}_{gün}`. */
  loc_req_day: Record<string, number>;
  /** Demo: bot hedefin isteğime otomatik yanıt anı (istek kimliği → an). */
  loc_req_auto: Record<string, EpochMs>;
  // --- Faz 7 (eski kayıtlarda yok: `withPhase7` tamamlar) ---
  phase7: boolean;
  /** Firestore `events/{event_id}`. */
  events: Record<string, EventDoc>;
  /** `event_reminders/{event_id}_{kind}` (istemciye kapalı). */
  event_reminders: Record<string, EventReminderRec>;
  /** `users/{uid}/notices` (en yeni önde, 30 gün). */
  notices: Record<UserId, EventNotice[]>;
  /** Saatlik / günlük etkinlik sayaçları `{uid}_{tür}_{pencere}`. */
  event_rate: Record<string, number>;
  /** Demo: bot üyenin bir sonraki etkinlik adımı (`{event_id}|{uid}` → an). */
  event_auto: Record<string, EpochMs>;
  /** `movement_cooldowns/{uid}` → son "yola çıktı" bildirimi anı. */
  movement_cooldown: Record<UserId, EpochMs>;
  /** Demo paneli: en son "yola çıktı" raporum. */
  movement_last: { at: EpochMs; status: MovementReportResponse['status']; notified: number } | null;
}

/** Backend `EventReminderDoc` (TTL alanı yok). */
interface EventReminderRec {
  event_id: string;
  kind: EventReminderKind;
  due_at: EpochMs;
  /** Planlandığı andaki başlangıç: değiştiyse hatırlatma geçersiz. */
  starts_at: EpochMs;
  sent: boolean;
  sent_at: EpochMs | null;
  outcome: 'sent' | 'stale' | null;
}

interface LocReqRec {
  request_id: string;
  requester_id: UserId;
  target_id: UserId;
  status: LocationRequestStatus;
  created_at: EpochMs;
  expires_at: EpochMs;
  responded_at: EpochMs | null;
  share_id: string | null;
  updated_at: EpochMs;
}

/** Faz 1'de kaydedilmiş demo durumuna Faz 2 alanlarını ekler (demo verisi silinmeden). */
function withPhase2(db: Db): Db {
  db.links ??= {};
  db.link_acl ??= {};
  db.link_live ??= {};
  db.route_cache ??= {};
  db.geocode_cache ??= {};
  db.maps_quota ??= {};
  db.maps_down ??= false;
  return db;
}

/**
 * Faz 3 kaydına Faz 4 alanlarını ekler. Ayşe ve Mehmet'in acil kişisi benim (Ayşe SOS senaryosu); benim acil
 * kişilerim BOŞ başlar (ilk SOS'ta seçim ekranı görünsün).
 */
function withPhase4(db: Db): Db {
  db.ping_inbox ??= {};
  db.ping_pair ??= {};
  db.ping_hour ??= {};
  db.place_notes ??= {};
  db.sos ??= {};
  db.sos_hour ??= {};
  db.sos_auto_ack ??= {};
  db.emergency ??= {};
  db.bot_notes ??= {};
  if (!db.phase4) {
    db.phase4 = true;
    db.emergency[PEOPLE.ayse.uid] ??= [DEMO_ME];
    db.emergency[PEOPLE.mehmet.uid] ??= [DEMO_ME];
  }
  return db;
}

/** Faz 4 kaydına Faz 5 alanlarını ekler (demo verisi silinmeden). */
function withPhase5(db: Db): Db {
  db.zones ??= {};
  db.zone_events ??= {};
  db.zone_cooldowns ??= {};
  db.zone_daily ??= {};
  db.meetups ??= {};
  db.meetup_cache ??= {};
  db.meetup_auto ??= {};
  return db;
}

/** Kişinin demo cinsiyeti (bot / isim havuzu); bilinmiyorsa null. */
function demoGenderOf(uid: UserId, name: string): Gender | null {
  const p = Object.values(PEOPLE).find((x) => x.uid === uid);
  return p?.gender ?? NAME_POOL_GENDER[name] ?? null;
}

/**
 * Faz 5 kaydına Faz 6 alanlarını ekler (demo verisi silinmeden): botlara cinsiyet + çizim avatar, benim favorilerim
 * (Ayşe, Mehmet, Zeynep). Benim cinsiyetim eski kayıtta `null` kalır (eski hesap: uygulama cinsiyet seçimi ister).
 */
function withPhase6(db: Db): Db {
  db.widget_tokens ??= {};
  db.widget_issue ??= {};
  db.widget_ops ??= {};
  for (const u of Object.values(db.users)) {
    u.gender ??= u.uid === DEMO_ME ? null : demoGenderOf(u.uid, u.display_name);
    u.avatar_url ??= null;
    u.avatar_thumb_url ??= null;
    u.avatar_version ??= null;
    u.favorite_ids ??= [];
  }
  if (!db.phase6) {
    db.phase6 = true;
    for (const u of Object.values(db.users)) {
      if (u.uid === DEMO_ME || u.avatar_url) continue;
      const a = botAvatarUrls(u.uid);
      if (a) Object.assign(u, a);
    }
    const me = db.users[DEMO_ME];
    if (me && me.favorite_ids.length === 0) {
      me.favorite_ids = DEMO_ME_FAVORITES.filter((id) => db.friendships[friendshipId(DEMO_ME, id)]?.status === 'accepted');
    }
    // Kabul edilmiş arkadaşlıklardaki profil kopyaları yeni alanlarla tazelenir (bekleyenler yalnızca ad).
    for (const f of Object.values(db.friendships)) {
      for (const m of Object.keys(f.member_profiles)) {
        const u = db.users[m];
        const cur = f.member_profiles[m] as Partial<PublicProfile> & { display_name: string };
        f.member_profiles[m] =
          f.status === 'accepted' && u
            ? { display_name: cur.display_name || u.display_name, avatar_url: u.avatar_url, gender: u.gender, avatar_thumb_url: u.avatar_thumb_url }
            : { display_name: cur.display_name, avatar_url: null, gender: null, avatar_thumb_url: null };
      }
    }
  }
  return db;
}

/** Faz 2 kaydına Faz 3 alanlarını ekler. Düşük pil hikâyesi artık Ayşe'nin: Mehmet'in pili %47'ye alınır. */
function withPhase3(db: Db): Db {
  db.trail ??= {};
  db.battery_alerts ??= {};
  db.battery_notice ??= null;
  if (!db.phase3) {
    db.phase3 = true;
    const m = db.bots[PEOPLE.mehmet.uid];
    if (m && m.battery === 14) m.battery = MEHMET_BATTERY;
  }
  return db;
}

/** Botlara / sanal kişilere güncel onay (benim onayım YOK: kapı görünür). */
function demoConsentOf(uid: UserId, at: EpochMs): ProfileConsent | null {
  return uid === DEMO_ME ? null : { version: CONSENT_VERSION, accepted_at: at };
}

/** İzin yazar (sunucu adına, tohum / göç). Kendisine izin yazılmaz. */
function seedGrant(db: Db, granter: UserId, grantee: UserId, scope: AccessScope, via: GrantVia, now: EpochMs): void {
  if (granter === grantee) return;
  const id = grantId(granter, grantee);
  const cur = db.grants[id] ?? emptyGrantDoc(granter, grantee, now);
  if (hasGrant(cur, scope)) return;
  db.grants[id] = withGranted(cur, [scope], via, now);
}

/**
 * Faz 6 kaydına Faz 8 alanlarını ekler (demo verisi silinmeden; DB_VERSION değişmez). Göç: YALNIZCA botların etkin
 * paylaşımları için gönderen → alıcı `location_view` (`migration`; benim başlattığım eski paylaşıma benim adıma izin
 * yazılmaz, gerçek backend'deki gibi uzatılamaz ve geri yüklenmez), Ayşe / Mehmet / Zeynep → ben `location_view`, acil
 * kişi listeleri → `sos_alert` (`emergency_contact`). Benim onayım boş kalır (kapı görünür), botlarınki günceldir.
 */
function withPhase8(db: Db): Db {
  db.grants ??= {};
  db.perm_declines ??= {};
  db.perm_day ??= {};
  db.perm_auto ??= {};
  db.consents ??= {};
  db.loc_requests ??= {};
  db.loc_req_day ??= {};
  db.loc_req_auto ??= {};
  for (const u of Object.values(db.users)) {
    u.invisible ??= null;
    if (u.consent === undefined) u.consent = demoConsentOf(u.uid, u.created_at);
  }
  if (!db.phase8) {
    db.phase8 = true;
    const now = Date.now();
    for (const sh of Object.values(db.shares)) {
      if (sh.sender_id !== DEMO_ME && sh.status === 'active' && (sh.expires_at === null || sh.expires_at > now)) seedGrant(db, sh.sender_id, sh.receiver_id, 'location_view', 'migration', now);
    }
    for (const id of [PEOPLE.ayse.uid, PEOPLE.mehmet.uid, PEOPLE.zeynep.uid]) {
      if (db.friendships[friendshipId(id, DEMO_ME)]?.status === 'accepted') seedGrant(db, id, DEMO_ME, 'location_view', 'migration', now);
    }
    for (const [owner, list] of Object.entries(db.emergency ?? {})) for (const c of list) seedGrant(db, owner, c, 'sos_alert', 'emergency_contact', now);
  }
  return db;
}

/**
 * Faz 8 kaydına Faz 7 alanlarını ekler (demo verisi silinmeden; DB_VERSION değişmez). Botlar pil paylaşır (demo onayı),
 * benim tercihim boş (varsayılan: pil KAPALI, "yola çıktı" AÇIK; ilk açılış akışı sorar). Tohum: Ayşe / Mehmet / Zeynep
 * bana `meetup_invite` vermiş (etkinliğe davet edilebilirler), Can vermemiş (seçicide "izin iste").
 */
function withPhase7(db: Db): Db {
  db.events ??= {};
  db.event_reminders ??= {};
  db.notices ??= {};
  db.event_rate ??= {};
  db.event_auto ??= {};
  db.movement_cooldown ??= {};
  db.movement_last ??= null;
  for (const u of Object.values(db.users)) {
    if (u.privacy !== undefined) continue;
    u.privacy = u.uid === DEMO_ME ? null : { battery_share: true, movement_alerts: true, updated_at: u.created_at };
  }
  if (!db.phase7) {
    db.phase7 = true;
    const now = Date.now();
    for (const id of [PEOPLE.ayse.uid, PEOPLE.mehmet.uid, PEOPLE.zeynep.uid]) {
      if (db.friendships[friendshipId(id, DEMO_ME)]?.status === 'accepted') seedGrant(db, id, DEMO_ME, 'meetup_invite', 'migration', now);
    }
  }
  return db;
}

// --- hata modeli -----------------------------------------------------------------------------

/** Firebase `HttpsError` benzeri: istemci `details.code` → core ERROR_CODES eşlemesini kullanır. */
export class DemoHttpsError extends Error {
  readonly code: string;
  /** Backend `ErrorDetails` gibi: `code` + ekler (ör. `event_vote_tie` → `leaders`). */
  readonly details: { code: ErrorCode; [extra: string]: unknown };
  constructor(code: ErrorCode, message?: string, extra: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = 'DemoHttpsError';
    this.code = `functions/${TRANSPORT[code]}`;
    this.details = { ...extra, code };
  }
}

const TRANSPORT: Record<ErrorCode, string> = {
  invalid_argument: 'invalid-argument',
  invalid_duration: 'invalid-argument',
  not_friends: 'failed-precondition',
  share_not_active: 'failed-precondition',
  already_expired: 'failed-precondition',
  rate_limited: 'resource-exhausted',
  unauthenticated: 'unauthenticated',
  unavailable: 'unavailable',
  internal: 'internal',
  // Faz 2
  link_not_found: 'not-found',
  link_limit_reached: 'resource-exhausted',
  maps_unavailable: 'unavailable',
  quota_exceeded: 'resource-exhausted',
  route_not_found: 'not-found',
  // Faz 4
  no_emergency_contacts: 'failed-precondition',
  sos_not_active: 'failed-precondition',
  note_not_found: 'not-found',
  note_limit_reached: 'resource-exhausted',
  // Faz 5
  zone_not_found: 'not-found',
  zone_limit_reached: 'resource-exhausted',
  meetup_not_found: 'not-found',
  // Faz 6
  gender_required: 'invalid-argument',
  token_invalid: 'unauthenticated',
  token_expired: 'unauthenticated',
  not_favorite: 'failed-precondition',
  not_friend: 'failed-precondition',
  // Faz 8
  not_permitted: 'failed-precondition',
  invisible_mode: 'failed-precondition',
  consent_required: 'failed-precondition',
  permission_cooldown: 'resource-exhausted',
  // Faz 7
  event_not_found: 'not-found',
  event_not_owner: 'permission-denied',
  event_stage_mismatch: 'failed-precondition',
  event_not_eligible: 'failed-precondition',
  event_options_invalid: 'invalid-argument',
  event_vote_tie: 'failed-precondition',
  event_no_attendees: 'failed-precondition',
  event_date_invalid: 'invalid-argument',
  event_note_too_long: 'invalid-argument',
  event_invitee_limit: 'resource-exhausted',
  event_started: 'failed-precondition',
  event_limit_reached: 'resource-exhausted',
};

/** RTDB kural reddi (RNFB `database/permission-denied` ile aynı biçim). */
export class DemoPermissionDenied extends Error {
  readonly code = 'database/permission-denied';
  constructor(reason: string) {
    super(`PERMISSION_DENIED: ${reason}`);
    this.name = 'DemoPermissionDenied';
  }
}

const fail = (code: ErrorCode, message?: string, extra?: Record<string, unknown>): never => {
  throw new DemoHttpsError(code, message, extra);
};

// --- yardımcılar -----------------------------------------------------------------------------

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const randomHex32 = () => uuidV4().replace(/-/g, '');
/**
 * Backend `outgoingId(uid, via, değer)` gibi deterministik 32 hex: aynı kişiye tekrar istek aynı kaydı tazeler.
 * (Kriptografik değil; yalnızca demo kimliği.)
 */
function stableHex32(input: string): string {
  let out = '';
  for (let round = 0; out.length < 32; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 32);
}
const randomBetween = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const otherMember = (f: Friendship, uid: UserId): UserId => (f.member_ids[0] === uid ? f.member_ids[1] : f.member_ids[0]);

const DEFAULT_TZ = 'Europe/Istanbul';

// --- Faz 7 demo verisi -------------------------------------------------------------------------

/** Botların etkinliğe önerdiği mekan (davetli başına bir öneri). */
const BOT_EVENT_VENUES: Record<string, EventVenueInput> = {
  ayse: { name: 'Moda Sahili Çay Bahçesi', address: 'Caferağa, Moda Cd., Kadıköy', location: { lat: 40.9819, lng: 29.0254 }, place_id: null },
  mehmet: { name: 'Kadıköy Çarşı Kahvecisi', address: 'Osmanağa, Güneşli Bahçe Sk., Kadıköy', location: { lat: 40.9905, lng: 29.0275 }, place_id: null },
  zeynep: { name: 'Yeldeğirmeni Kitap Kafe', address: 'Rasimpaşa, Karakolhane Cd., Kadıköy', location: { lat: 40.9958, lng: 29.0305 }, place_id: null },
};
/** "Ayşe etkinliğe davet etsin": Ayşe'nin hazır 3 mekanı. */
const AYSE_EVENT_VENUES: EventVenueInput[] = [
  { name: 'Moda Sahili Çay Bahçesi', address: 'Caferağa, Moda Cd., Kadıköy', location: { lat: 40.9819, lng: 29.0254 }, place_id: null },
  { name: 'Yeldeğirmeni Kitap Kafe', address: 'Rasimpaşa, Karakolhane Cd., Kadıköy', location: { lat: 40.9958, lng: 29.0305 }, place_id: null },
  { name: 'Kadıköy Çarşı Kahvecisi', address: 'Osmanağa, Güneşli Bahçe Sk., Kadıköy', location: { lat: 40.9905, lng: 29.0275 }, place_id: null },
];
/** Can her davete "Katılamayacağım" der (300 karakterlik not örneği). */
const CAN_EVENT_NOTE = 'Bu hafta sonu ailemin yanındayım, kusura bakmayın. Fotoğrafları gruba atarsanız çok sevinirim, bir dahakini ben ayarlıyorum!';
/** Bot sahibin "saat ekle" adayları (yerel dakika). */
const BOT_TIME_CANDIDATES = [10 * 60, 12 * 60 + 30, 15 * 60, 18 * 60 + 30, 20 * 60, 21 * 60 + 30];

/** Etkinlik etkisinden doğan tek gönderim (bildirim kutusu + push). */
interface EventOutgoing {
  to: UserId[];
  type: EventNoticeType;
  text: { title: string; body: string };
  data: Record<string, string> & { event_id: string };
}
/** Backend `LIMITS.linkCreatePerHour` ile aynı. [Varsayım] */
const LINK_CREATE_PER_HOUR = 20;
/** Faz 6: backend `WIDGET_TOKEN_LIMITS` ile aynı (günlük üretim, aynı anda aktif cihaz). [Varsayım] */
const WIDGET_TOKEN_ISSUE_PER_DAY = 20;
const WIDGET_TOKEN_MAX_ACTIVE = 5;

/** `ops` kaydındaki create yanıtı: düz token ve URL olmadan (backend `storedCreate`). */
function storedLinkCreate(r: LinkShareCreateResponse): Record<string, unknown> {
  const { token: _token, url: _url, ...rest } = r;
  return { ...rest, token_omitted: true };
}
const OUTGOING_TTL_MS = 30 * DAY;
const AUTO_ACCEPT_MS = 6 * SECOND;
const WALK_SPEED_MPS = 1.25;
const WALKER_INTERVAL_MS = 5 * SECOND;
/** Mehmet telefonunu cebinde unutmuş: seyrek nabız; arada "Az önce" görünür. */
const HEARTBEAT_INTERVAL_MS = 12 * MINUTE;
/** Faz 3: bot pilleri (Mehmet artık düşük pilde değil; düşük pil senaryosu Ayşe'nin). */
const MEHMET_BATTERY = 47;
export const AYSE_BATTERY = 64;
export const AYSE_LOW_BATTERY = 14;
/**
 * Faz 3 "Mehmet'in bağlantısı kopsun": son paketi bu kadar geriye çekilir (demo bekleme süresini atlar).
 * Mehmet hareketsiz, arka planda: hb 15 dk → 4·hb + 30 sn = 60,5 dk sonra "Bağlantısı kopmuş olabilir".
 */
const MEHMET_OFFLINE_AGE_MS = 63 * MINUTE;
/** Faz 3: `live_trail` noktalarının saklama süresi (backend TTL önerisi 24 sa). */
const TRAIL_TTL_MS = DAY;
/** Dünyanın tazelendiği yaş: bot paylaşımları yeniden başlatılır (uzun aradan sonra açılınca boş harita olmasın). */
const WORLD_REFRESH_MS = 6 * HOUR;
/** Faz 8 demo: "Sözleşme güncellendi" düğmesi onayımı bu eski sürüme çeker (kapı "Metin güncellendi" ile açılır). */
export const DEMO_OLD_CONSENT_VERSION = '2026-06-01';

export interface QueryHandle {
  unsubscribe: () => void;
}

interface Sub {
  compute: () => unknown;
  cb: (v: unknown) => void;
  last: string | null;
  live: boolean;
}

export interface DemoSnapshot {
  /** Benim alıcılara teslim edilmiş son konum kopyalarım (sunucuda ne var). */
  myDeliveries: { receiverId: UserId; name: string; timestamp: EpochMs; battery: number | null; expiresAt: EpochMs | null }[];
  myActiveShares: number;
  ayseSharing: boolean;
  mehmetSharing: boolean;
  /** Faz 2: aktif QR bağlantılarım ve izleyicide açık dinleyici sayısı (token sahipleri). */
  myActiveLinks: number;
  linkViewers: number;
  /** Faz 2: "Google yanıt vermesin" açık mı, bugünkü (UTC) Maps sayaçları (benim). */
  mapsDown: boolean;
  maps: { route: number; routeHits: number; geocode: number; geocodeHits: number; routeLimit: number; geocodeLimit: number };
  /** Faz 3: süren tüm giden hedeflerim (arkadaş + bağlantı, süresizler dahil). */
  myLiveTargets: number;
  ayseBattery: number | null;
  mehmetOffline: boolean;
  /** Benim pilim azaldığında alıcılarıma giden son bildirim. */
  batteryNotice: DemoBatteryNotice | null;
  /** "Alıcı tarafı" önizlemesi: bir alıcının sunucudaki kopyası (canlı düğüm + eşitlenen iz). */
  receiverView: { receiverId: UserId; name: string; live: Record<string, unknown>; trail: Record<string, unknown>[] } | null;
  /** Faz 4: acil kişilerim (adlar), son SOS'um, Ayşe'nin SOS / not durumu, bana görünür yer notu ve ping sayısı. */
  f4: {
    myEmergencyContacts: string[];
    mySos: { status: 'active' | 'resolved'; recipients: number; acks: number; updates: number } | null;
    ayseSosActive: boolean;
    ayseNote: boolean;
    placeNotesForMe: number;
    pingsForMe: number;
  };
  /** Faz 5: demo Ev bölgem, son bölge olayım, aktif buluşma önerileri ve bugünkü öneri kotası. */
  f5: {
    homeZone: { zone_id: string; name: string; center: LatLng; radius_m: number; rules: number; enabled: boolean } | null;
    myZones: number;
    lastZoneEvent: { zone_name: string; transition: ZoneTrigger; at: EpochMs; notified: number; suppressed: string | null } | null;
    activeMeetups: number;
    meetupQueries: number;
    meetupHits: number;
    meetupLimit: number;
  };
  /** Faz 6: cinsiyetim / fotoğrafım, favorilerim (adlar, widget sırası), aktif widget token'ım ve bu saatteki kullanım. */
  f6: {
    myGender: Gender | null;
    myPhoto: boolean;
    favorites: string[];
    activeWidgetTokens: number;
    quickSharesThisHour: number;
  };
  /**
   * Faz 8: görünmez miyim, konumumun şu an teslim edildiği kişiler ("Arkadaşlarım beni görüyor mu?"; görünmezken 0),
   * izin özetleri (adlar), bekleyen istekler ve onay durumum.
   */
  f8: {
    myInvisible: boolean;
    myDeliveriesCount: number;
    seesMe: string[];
    /** Benim konum izni verdiklerim / bana konum izni verenler. */
    givenLocation: string[];
    receivedLocation: string[];
    grants: { given: number; received: number };
    pendingIncoming: number;
    pendingOutgoing: number;
    ayseGrantsMe: boolean;
    mehmetGrantsPing: boolean;
    consent: { version: string; current: boolean } | null;
  };
  /** Faz 7: etkinlik sayıları, gizlilik tercihlerim ve son "yola çıktı" raporum. */
  f7: {
    activeEvents: number;
    pendingReminders: number;
    nextReminderAt: EpochMs | null;
    privacy: PrivacySettings;
    lastMovement: { at: EpochMs; status: MovementReportResponse['status']; notified: number } | null;
    movementCooldownLeftMs: number;
  };
}

/** Faz 6: widget önizlemesinin ham kaynağı (`widgetSource`). Avatar adresi yerel (gösterilebilir) adrestir. */
export interface DemoWidgetSource {
  profile: { display_name: string; gender: Gender | null } | null;
  favorite_ids: UserId[];
  friends: {
    uid: UserId;
    display_name: string;
    gender: Gender | null;
    avatar_thumb_url: string | null;
    avatar_version: number | null;
    incoming: { active: boolean; last_seen_at: EpochMs | null; battery_pct: number | null; position: LatLng | null } | null;
  }[];
  outgoing: { receiver_id: UserId; status: 'active' | 'ended'; expires_at: EpochMs | null }[];
  tokens: { device_id: string; expires_at: EpochMs; revoked: boolean; uses: { window_start: EpochMs; count: number } }[];
}

export class DemoServer {
  private db: Db;
  private subs = new Set<Sub>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** `reset()` sonrası: hiçbir şey diske yazılmaz (sayfa yenilenirken `pagehide` eski durumu geri yazmasın). */
  private disposed = false;
  private lastPrune = 0;
  /** Açık `link_live` dinleyicileri (demo paneli: "izleyici açık"). */
  private linkListeners = 0;
  /** Faz 3: FCM benzeri push dinleyicileri (uygulama `registerPushToken` ile abone olur). */
  private pushListeners = new Map<UserId, Set<(m: DemoPushMessage) => void>>();
  /** Faz 6: sahte Storage (yüklenen avatarlar; ana durumdan ayrı anahtarda). */
  private avatars = new DemoAvatarStore();

  constructor() {
    this.db = this.load() ?? this.seed(Date.now());
    if (Date.now() - this.db.seeded_at > WORLD_REFRESH_MS) this.refreshBots(Date.now());
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), SECOND);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => this.flush());
    }
  }

  // --- kalıcılık ------------------------------------------------------------------------------

  private load(): Db | null {
    const raw = safeStorage.get(DEMO_STORAGE_KEY);
    if (!raw) return null;
    try {
      const db = JSON.parse(raw) as Db;
      if (!db || db.v !== DB_VERSION || !db.users || !db.users[DEMO_ME]) return null;
      const cutoff = Date.now() - DAY;
      for (const [k, op] of Object.entries(db.ops)) if (op.at < cutoff) delete db.ops[k];
      return withPhase7(withPhase8(withPhase6(withPhase5(withPhase4(withPhase3(withPhase2(db)))))));
    } catch {
      return null;
    }
  }

  private flush(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.disposed) return;
    safeStorage.set(DEMO_STORAGE_KEY, JSON.stringify(this.db));
  }

  /** Değişikliği yayınla: dinleyicileri tazele, diske yaz (gecikmeli). */
  private commit(): void {
    if (this.disposed) return;
    if (!this.notifyTimer) this.notifyTimer = setTimeout(() => this.notify(), randomBetween(15, 45));
    if (!this.persistTimer) this.persistTimer = setTimeout(() => this.flush(), 300);
  }

  private notify(): void {
    this.notifyTimer = null;
    for (const s of this.subs) this.deliver(s);
  }

  private deliver(s: Sub): void {
    if (!s.live) return;
    let value: unknown;
    try {
      value = s.compute();
    } catch {
      return;
    }
    const key = JSON.stringify(value);
    if (key === s.last) return;
    s.last = key;
    s.cb(clone(value));
  }

  /** Sorgu aboneliği: ilk değer kısa bir "ağ" gecikmesiyle, sonrakiler yalnızca değişince gelir. */
  subscribe<T>(compute: () => T, cb: (v: T) => void): () => void {
    const sub: Sub = { compute, cb: cb as (v: unknown) => void, last: null, live: true };
    this.subs.add(sub);
    const t = setTimeout(() => this.deliver(sub), randomBetween(60, 180));
    return () => {
      sub.live = false;
      clearTimeout(t);
      this.subs.delete(sub);
    };
  }

  // --- dünya ----------------------------------------------------------------------------------

  private seed(now: EpochMs): Db {
    const db: Db = {
      v: DB_VERSION,
      seeded_at: now,
      users: {},
      invites: {},
      friendships: {},
      outgoing: {},
      shares: {},
      acl: {},
      live: {},
      ops: {},
      bots: {},
      name_seq: 0,
      links: {},
      link_acl: {},
      link_live: {},
      route_cache: {},
      geocode_cache: {},
      maps_quota: {},
      maps_down: false,
      phase3: true,
      trail: {},
      battery_alerts: {},
      battery_notice: null,
      phase4: false,
      ping_inbox: {},
      ping_pair: {},
      ping_hour: {},
      place_notes: {},
      sos: {},
      sos_hour: {},
      sos_auto_ack: {},
      emergency: {},
      bot_notes: {},
      zones: {},
      zone_events: {},
      zone_cooldowns: {},
      zone_daily: {},
      meetups: {},
      meetup_cache: {},
      meetup_auto: {},
      phase6: false,
      widget_tokens: {},
      widget_issue: {},
      widget_ops: {},
      phase8: false,
      grants: {},
      perm_declines: {},
      perm_day: {},
      perm_auto: {},
      consents: {},
      loc_requests: {},
      loc_req_day: {},
      loc_req_auto: {},
      phase7: false,
      events: {},
      event_reminders: {},
      notices: {},
      event_rate: {},
      event_auto: {},
      movement_cooldown: {},
      movement_last: null,
    };
    this.db = db;
    withPhase4(db);
    // Ben: görünen ad boş, ilk girişte ad ekranı açılır (ad alanında "Deniz Kaya" hazır gelir).
    this.addUser(DEMO_ME, '', DEMO_ME_INVITE, now - 30 * DAY);
    for (const p of Object.values(PEOPLE)) this.addUser(p.uid, p.name, p.invite, now - 60 * DAY);
    // Arkadaşlarım: profil kopyalarında benim adım "Deniz Kaya" (ad ekranında değişirse güncellenir).
    const friendsOf: [UserId, number][] = [
      [PEOPLE.ayse.uid, 21],
      [PEOPLE.mehmet.uid, 14],
      [PEOPLE.zeynep.uid, 9],
      [PEOPLE.can.uid, 3],
    ];
    for (const [uid, daysAgo] of friendsOf) this.makeFriends(DEMO_ME, uid, now - daysAgo * DAY, DEMO_ME_NAME);
    // Bekleyen istek: Elif beni davet koduyla eklemek istiyor.
    this.addPendingRequest(PEOPLE.elif.uid, DEMO_ME, now - 25 * MINUTE);
    // Faz 6: bot cinsiyetleri + çizim avatarlar, benim favorilerim (Ayşe, Mehmet, Zeynep).
    withPhase6(db);

    db.bots[PEOPLE.ayse.uid] = { uid: PEOPLE.ayse.uid, kind: 'walker', battery: 64, charging: false, walk_origin: now - 9 * MINUTE, next_at: now, spot: AYSE_PATH[0] as LatLng };
    db.bots[PEOPLE.mehmet.uid] = { uid: PEOPLE.mehmet.uid, kind: 'heartbeat', battery: MEHMET_BATTERY, charging: false, walk_origin: now, next_at: now + 8 * MINUTE, spot: MEHMET_SPOT };
    db.bots[PEOPLE.zeynep.uid] = { uid: PEOPLE.zeynep.uid, kind: 'stale', battery: 41, charging: false, walk_origin: now, next_at: Number.MAX_SAFE_INTEGER, spot: ZEYNEP_SPOT };
    db.bots[PEOPLE.can.uid] = { uid: PEOPLE.can.uid, kind: 'idle', battery: 88, charging: true, walk_origin: now, next_at: Number.MAX_SAFE_INTEGER, spot: EXTRA_SPOTS[0] as LatLng };
    // Faz 8: Ayşe / Mehmet / Zeynep bana konum izni vermiş, Can vermemiş; benim kimseye iznim yok, onayım yok.
    withPhase8(db);
    // Faz 7: botlar pil paylaşır, Ayşe / Mehmet / Zeynep bana etkinlik daveti izni vermiş.
    withPhase7(db);
    this.seedBotShares(now);
    return db;
  }

  /** Bot paylaşımları ve son paketleri (tohumlama: kural dışı, sunucu adına doğrudan yazılır). */
  private seedBotShares(now: EpochMs): void {
    const ayse = PEOPLE.ayse.uid;
    const mehmet = PEOPLE.mehmet.uid;
    const zeynep = PEOPLE.zeynep.uid;
    this.startBotShare(ayse, { kind: 'preset', preset: 'h8' }, now - 50 * MINUTE);
    this.startBotShare(mehmet, { kind: 'weekly' }, now - 2 * DAY);
    this.startBotShare(zeynep, { kind: 'preset', preset: 'h8' }, now - 150 * MINUTE);
    const bots = this.db.bots;
    if (bots[ayse]) {
      bots[ayse].walk_origin = now - 9 * MINUTE;
      bots[ayse].next_at = now;
    }
    if (bots[mehmet]) bots[mehmet].next_at = now + 8 * MINUTE;
    this.seedPacket(zeynep, ZEYNEP_SPOT, now - 2 * HOUR - 4 * MINUTE, 41, null);
    this.seedPacket(mehmet, MEHMET_SPOT, now - 4 * MINUTE, bots[mehmet]?.battery ?? MEHMET_BATTERY, 0, this.botHb(mehmet));
    this.botPublish(ayse, now, true);
  }

  private refreshBots(now: EpochMs): void {
    this.db.seeded_at = now;
    this.seedBotShares(now);
    this.commit();
  }

  private addUser(uid: UserId, name: string, invite: string, createdAt: EpochMs): UserRec {
    const u: UserRec = {
      uid,
      display_name: name,
      invite_code: invite,
      created_at: createdAt,
      time_zone: DEFAULT_TZ,
      gender: uid === DEMO_ME ? null : demoGenderOf(uid, name),
      avatar_url: null,
      avatar_thumb_url: null,
      avatar_version: null,
      favorite_ids: [],
      invisible: null,
      consent: demoConsentOf(uid, createdAt),
    };
    this.db.users[uid] = u;
    this.db.invites[invite] = uid;
    return u;
  }

  /** Kabul edilmiş arkadaşlıktaki profil kopyası (Faz 6: fotoğraf + cinsiyet; adresler saklanan üretim biçimi). */
  private publicProfile(uid: UserId, fallbackName?: string): PublicProfile {
    const u = this.db.users[uid];
    return {
      display_name: u?.display_name || fallbackName || '',
      avatar_url: u?.avatar_url ?? null,
      gender: u?.gender ?? null,
      avatar_thumb_url: u?.avatar_url ? (u.avatar_thumb_url ?? null) : null,
    };
  }

  /** Bekleyen istek kopyası: YALNIZCA ad (SPEC §1.1; fotoğraf ve cinsiyet kabulden sonra yayılır). */
  private pendingProfile(uid: UserId): PublicProfile {
    return { display_name: this.db.users[uid]?.display_name ?? '', avatar_url: null, gender: null, avatar_thumb_url: null };
  }

  /** Okuma: Storage adreslerini tarayıcının gösterebileceği yerel adrese çevirir (bkz. `avatars.ts`). */
  private resolvedProfile(p: PublicProfile): PublicProfile {
    const main = this.avatars.resolve(p.avatar_url);
    return { ...p, avatar_url: main, avatar_thumb_url: main ? (this.avatars.resolve(p.avatar_thumb_url) ?? main) : null };
  }

  private makeFriends(a: UserId, b: UserId, at: EpochMs, nameForA?: string): FriendshipRec {
    const id = friendshipId(a, b);
    const f: FriendshipRec = {
      id,
      member_ids: sortedPair(a, b),
      status: 'accepted',
      requested_by: b,
      via: 'invite_code',
      member_profiles: { [a]: this.publicProfile(a, nameForA), [b]: this.publicProfile(b) },
      created_at: at,
      updated_at: at,
      target_id: a,
      accepted_at: at,
    };
    this.db.friendships[id] = f;
    return f;
  }

  private addPendingRequest(from: UserId, to: UserId, at: EpochMs): FriendshipRec {
    const id = friendshipId(from, to);
    const f: FriendshipRec = {
      id,
      member_ids: sortedPair(from, to),
      status: 'pending',
      requested_by: from,
      via: 'invite_code',
      member_profiles: { [from]: this.pendingProfile(from) },
      created_at: at,
      updated_at: at,
      target_id: to,
      accepted_at: null,
    };
    this.db.friendships[id] = f;
    const target = this.db.users[to];
    const oid = stableHex32(`${from}|invite_code|${target?.invite_code ?? to}`);
    (this.db.outgoing[from] ??= {})[oid] = {
      id: oid,
      via: 'invite_code',
      label: formatInviteCode(target?.invite_code ?? DEMO_ME_INVITE),
      created_at: at,
      expires_at: at + OUTGOING_TTL_MS,
      friendship_id: id,
      auto_accept_at: null,
    };
    return f;
  }

  private areFriends(a: UserId, b: UserId): boolean {
    if (a === b) return false;
    return this.db.friendships[friendshipId(a, b)]?.status === 'accepted';
  }

  // --- Faz 8: yönlü izinler -------------------------------------------------------------------------

  /** `granter`ın `grantee`ye verdiği izin belgesi (yoksa null). */
  private grantOf(granter: UserId, grantee: UserId): PermissionGrantDoc | null {
    if (granter === grantee) return null;
    return this.db.grants[grantId(granter, grantee)] ?? null;
  }

  /** Çiftin sunucu durumu (X = eylemi yapan). Core `access.ts` koşulları bununla değerlendirilir. */
  private pair(x: UserId, y: UserId): PairAccessInput {
    const ux = this.db.users[x];
    return {
      friend: this.areFriends(x, y),
      grantXtoY: this.grantOf(x, y),
      grantYtoX: this.grantOf(y, x),
      invisibleX: isInvisible(ux),
      consentX: !consentRequired(ux?.consent),
    };
  }

  private grantScope(granter: UserId, grantee: UserId, scope: AccessScope, via: GrantVia, now: EpochMs): void {
    seedGrant(this.db, granter, grantee, scope, via, now);
  }

  /** Çiftin iki yöndeki izin belgeleri silinir (arkadaşlık bitti). */
  private dropPairGrants(a: UserId, b: UserId): void {
    for (const id of [grantId(a, b), grantId(b, a)]) {
      delete this.db.grants[id];
      delete this.db.perm_declines[id];
      delete this.db.perm_auto[id];
    }
  }

  /** `owner`ın `action` kurallarından `other` çıkar; alıcısı kalmayan kural silinir. */
  private stripZoneRecipient(owner: UserId, other: UserId, action: ZoneRule['action'], now: EpochMs): void {
    for (const z of Object.values(this.db.zones[owner] ?? {})) {
      if (!z.rules.some((r) => r.action === action && r.recipient_ids.includes(other))) continue;
      z.rules = z.rules
        .map((r) => (r.action === action ? { ...r, recipient_ids: r.recipient_ids.filter((u) => u !== other) } : r))
        .filter((r) => r.recipient_ids.length > 0);
      z.updated_at = now;
    }
  }

  /** Geri alma zinciri (core `REVOKE_EFFECTS`; granter = G, grantee = E). Alıcıya neden söylenmez. */
  private applyRevokeEffects(g: UserId, e: UserId, scope: AccessScope, now: EpochMs): void {
    for (const effect of REVOKE_EFFECTS[scope]) {
      switch (effect) {
        case 'end_shares': {
          const sh = this.db.shares[shareId(g, e)];
          if (sh) this.endShare(sh, sh.expires_at !== null && sh.expires_at <= now ? 'expired' : 'stopped_by_sender', now);
          break;
        }
        case 'remove_from_note_audience':
          for (const n of Object.values(this.db.place_notes)) {
            if (n.owner_id === g && n.visible_to.includes(e)) n.visible_to = n.visible_to.filter((u) => u !== e);
          }
          break;
        case 'remove_from_zone_start_share':
          this.stripZoneRecipient(g, e, 'start_share', now);
          break;
        case 'remove_from_favorites': {
          const u = this.db.users[g];
          if (u) u.favorite_ids = (u.favorite_ids ?? []).filter((x) => x !== e);
          break;
        }
        case 'remove_from_zone_notify':
          this.stripZoneRecipient(e, g, 'notify', now);
          break;
      }
    }
  }

  /** İzni kaldırır + zincir. Dönen: kaldırıldı mı. */
  private revokeScope(granter: UserId, grantee: UserId, scope: AccessScope, now: EpochMs): boolean {
    const cur = this.grantOf(granter, grantee);
    if (!cur || !hasGrant(cur, scope)) return false;
    this.db.grants[grantId(granter, grantee)] = withRevoked(cur, [scope], now);
    this.applyRevokeEffects(granter, grantee, scope, now);
    return true;
  }

  /**
   * Firestore `permission_grants where granter_id == uid` ∪ `where grantee_id == uid` (ret anları boş), granter olduğum
   * belgelere `permission_declines where granter_id == uid` birleşir (mobil `grantsRepo` ile aynı): kartım reddettiğim
   * kapsamları göstermez; isteyen tarafın belgesinde ret anı yoktur.
   */
  grantsOf(uid: UserId): PermissionGrantDoc[] {
    return Object.values(this.db.grants)
      .filter((d) => d.granter_id === uid || d.grantee_id === uid)
      .sort((a, b) => `${a.granter_id}_${a.grantee_id}`.localeCompare(`${b.granter_id}_${b.grantee_id}`))
      .map((d) => ({ ...d, declined_at: d.granter_id === uid ? { ...(this.db.perm_declines[grantId(d.granter_id, d.grantee_id)] ?? {}) } : {} }));
  }

  private nextVirtualName(): string {
    const used = new Set(Object.values(this.db.users).map((u) => u.display_name));
    for (let i = 0; i < NAME_POOL.length; i++) {
      const name = NAME_POOL[(this.db.name_seq + i) % NAME_POOL.length] as string;
      if (!used.has(name)) {
        this.db.name_seq += i + 1;
        return name;
      }
    }
    this.db.name_seq += 1;
    return `${NAME_POOL[this.db.name_seq % NAME_POOL.length]} ${this.db.name_seq}`;
  }

  private createVirtualUser(invite: string, now: EpochMs): UserRec {
    const uid = `u${randomHex32().slice(0, 10)}`;
    const u = this.addUser(uid, this.nextVirtualName(), invite, now - 40 * DAY);
    const spot = EXTRA_SPOTS[Object.keys(this.db.bots).length % EXTRA_SPOTS.length] as LatLng;
    this.db.bots[uid] = { uid, kind: 'idle', battery: 70, charging: false, walk_origin: now, next_at: Number.MAX_SAFE_INTEGER, spot };
    return u;
  }

  private randomInviteCode(): string {
    for (;;) {
      const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      let body = '';
      for (let i = 0; i < 6; i++) body += alphabet[Math.floor(Math.random() * alphabet.length)];
      const code = `LOC-${body}`;
      if (!this.db.invites[code]) return code;
    }
  }

  // --- paylaşım çekirdeği ------------------------------------------------------------------------

  private toView(s: ShareRec): OutgoingShareView {
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

  /** ACL aynası + alıcıdaki son paketin expires_at / share_mode hizalaması (backend `alignLiveCopy`). */
  private mirrorAcl(s: ShareRec): void {
    if (s.status === 'active') {
      const acl: AclRec = { status: 'active', version: s.version, sender_id: s.sender_id, receiver_id: s.receiver_id, share_mode: s.share_mode, started_at: s.started_at };
      if (s.expires_at !== null) acl.expires_at = s.expires_at;
      this.db.acl[s.share_id] = acl;
      const copy = this.db.live[s.receiver_id]?.[s.share_id];
      if (copy) {
        copy.share_mode = s.share_mode;
        if (s.expires_at === null) delete copy.expires_at;
        else copy.expires_at = s.expires_at;
      }
    } else {
      this.db.acl[s.share_id] = { status: 'ended', version: s.version, ended_at: s.ended_at ?? Date.now() };
      const inbox = this.db.live[s.receiver_id];
      if (inbox) delete inbox[s.share_id];
      // Faz 3 (backend `removeLiveCopy`): canlı kopya + iz tek atomik silmeyle kalkar.
      this.removeTrail(s.receiver_id, s.share_id);
    }
  }

  private removeTrail(receiver: UserId, id: string): void {
    const t = this.db.trail[receiver];
    if (!t || !t[id]) return;
    delete t[id];
    if (Object.keys(t).length === 0) delete this.db.trail[receiver];
  }

  private endShare(s: ShareRec, reason: ShareEndReason, now: EpochMs): boolean {
    if (s.status !== 'active') {
      // Zaten bitmiş: canlı kopya kaldıysa yine de silinir (idempotent).
      const inbox = this.db.live[s.receiver_id];
      if (inbox) delete inbox[s.share_id];
      this.removeTrail(s.receiver_id, s.share_id);
      return false;
    }
    s.status = 'ended';
    s.end_reason = reason;
    s.ended_at = now;
    s.version += 1;
    s.updated_at = now;
    this.mirrorAcl(s);
    this.widgetRefresh(s);
    return true;
  }

  /**
   * Faz 6 (backend `notifyWidgetRefresh`): paylaşımın AKTİFLİĞİ değişti → alıcı göndereni favorilerinde tutuyorsa
   * yalnızca veri `widget_refresh` push'u (widget yenilenir). Koordinat yok.
   */
  private widgetRefresh(s: ShareRec): void {
    const receiver = this.db.users[s.receiver_id];
    if (!receiver || !(receiver.favorite_ids ?? []).includes(s.sender_id)) return;
    const data: Extract<PushData, { type: 'widget_refresh' }> = { type: 'widget_refresh', from: s.sender_id };
    this.push(s.receiver_id, { data });
  }

  private startShare(sender: UserId, receiver: UserId, sessionId: string, mode: ShareMode, expiresAt: EpochMs | null, now: EpochMs): ShareRec {
    const id = shareId(sender, receiver);
    const prev = this.db.shares[id];
    const wasActive = prev?.status === 'active';
    const version = Math.max(prev?.version ?? 0, this.db.acl[id]?.version ?? 0) + 1;
    const s: ShareRec = {
      share_id: id,
      session_id: sessionId,
      audience: 'friend',
      sender_id: sender,
      receiver_id: receiver,
      status: 'active',
      share_mode: mode,
      started_at: now,
      expires_at: expiresAt,
      ended_at: null,
      end_reason: null,
      version,
      extended_count: 0,
      in_response_to: null,
      updated_at: now,
    };
    this.db.shares[id] = s;
    this.mirrorAcl(s);
    if (!wasActive) this.widgetRefresh(s);
    return s;
  }

  private startBotShare(bot: UserId, duration: DurationChoice, startedAt: EpochMs): ShareRec | null {
    // Faz 8: bot bana yalnızca `location_view` izni varken (ve görünür + onaylıyken) paylaşır.
    if (!canShareLocation(this.pair(bot, DEMO_ME))) return null;
    const r = resolveDuration(duration, startedAt, offsetFnForTimeZone(DEFAULT_TZ));
    return this.startShare(bot, DEMO_ME, uuidV4(), r.share_mode, r.expires_at, startedAt);
  }

  private seedPacket(bot: UserId, at: LatLng, timestamp: EpochMs, battery: number, speed: number | null, hb?: number): void {
    const s = this.db.shares[shareId(bot, DEMO_ME)];
    if (!s || s.status !== 'active') return;
    const [packet] = buildPackets(
      { lat: at.lat, lng: at.lng, accuracy: 12, speed_mps: speed, heading: null, timestamp, mocked: false },
      { batteryLevel: battery / 100, isCharging: false },
      bot,
      [{ share_id: s.share_id, receiver_id: DEMO_ME, share_mode: s.share_mode, expires_at: s.expires_at }],
      Date.now(),
      undefined,
      hb !== undefined ? { hb } : {},
    );
    if (!packet) return;
    for (const [path, value] of Object.entries(toFanoutUpdate([packet]))) {
      const [, receiver, id] = path.split('/');
      if (!receiver || !id) continue;
      (this.db.live[receiver] ??= {})[id] = { ...(value as Record<string, unknown>), server_ts: timestamp };
    }
  }

  /**
   * Bot paketi: uygulamanın kendi yayıncısıyla aynı yoldan (core buildPackets → toFanoutUpdate → kural denetimi).
   * Dönen değer: gelen kutusuna yazıldı mı. Paylaşımı olmayan bot da bir sonraki ana ertelenir (süpürücü
   * her saniye boşuna "değişti" demesin).
   */
  /**
   * Faz 3: botun hareket durumu ve uygulama evresi → core matris satırı (paketteki `hb` + gönderim aralığı).
   * Ayşe haritaya bakarak yürüyor (ön plan: 5 sn, hb 1 dk; düşük pilde 10 sn, hb 2 dk); Mehmet'in telefonu
   * masada, ekran kilitli (arka plan, hareketsiz: GPS kapalı, hb 15 dk).
   */
  private botPlan(botId: UserId) {
    const bot = this.db.bots[botId];
    const walker = bot?.kind === 'walker';
    const motion: MotionState = walker ? 'walking' : 'stationary';
    return selectTrackingPlan({
      hasActiveOutgoingShare: true,
      appPhase: walker ? 'foreground' : 'background',
      motion,
      batteryPct: bot?.battery ?? null,
      isCharging: bot?.charging ?? false,
      canUseGeofence: true,
    });
  }

  private botHb(botId: UserId): number {
    return this.botPlan(botId).row.heartbeatMs;
  }

  /** Botun bir sonraki paket aralığı (matris satırından; Faz 1 sabitleri alt sınır). */
  private botIntervalMs(bot: BotRec): number {
    const row = this.botPlan(bot.uid).row;
    if (bot.kind === 'walker') return Math.max(WALKER_INTERVAL_MS, row.sendMinIntervalMs);
    if (bot.kind === 'heartbeat') return Math.max(HEARTBEAT_INTERVAL_MS, row.heartbeatMs);
    return Number.MAX_SAFE_INTEGER;
  }

  private botPublish(botId: UserId, now: EpochMs, force = false): boolean {
    const bot = this.db.bots[botId];
    if (!bot) return false;
    if (!force && now < bot.next_at) return false;
    if (bot.offline) {
      bot.next_at = Number.MAX_SAFE_INTEGER;
      return false;
    }
    const s = this.db.shares[shareId(botId, DEMO_ME)];
    if (!s || s.status !== 'active' || !hasGrant(this.grantOf(botId, DEMO_ME), 'location_view')) {
      bot.next_at = now + this.botIntervalMs(bot);
      return false;
    }
    let at: LatLng = bot.spot;
    let speed: number | null = 0;
    let heading: number | null = null;
    let accuracy = 14;
    if (bot.kind === 'walker') {
      const p = pointAlong(AYSE_PATH, ((now - bot.walk_origin) / 1000) * WALK_SPEED_MPS, false);
      const j = jitter(Math.floor(now / 1000), 2);
      at = { lat: p.lat + j.lat, lng: p.lng + j.lng };
      speed = WALK_SPEED_MPS + ((Math.floor(now / 1000) % 7) - 3) * 0.05;
      heading = p.heading;
      accuracy = 6 + (Math.floor(now / 1000) % 5);
      bot.next_at = now + this.botIntervalMs(bot);
    } else {
      const j = jitter(Math.floor(now / 60_000), 4);
      at = { lat: bot.spot.lat + j.lat, lng: bot.spot.lng + j.lng };
      bot.next_at = now + this.botIntervalMs(bot);
    }
    const extras: PacketExtras = { hb: this.botHb(botId), ...statusNoteExtras(this.db.bot_notes[botId], now) };
    const packets = buildPackets(
      { lat: Math.round(at.lat * 1e6) / 1e6, lng: Math.round(at.lng * 1e6) / 1e6, accuracy, speed_mps: speed, heading, timestamp: now, mocked: false },
      { batteryLevel: bot.battery / 100, isCharging: bot.charging },
      botId,
      [{ share_id: s.share_id, receiver_id: DEMO_ME, share_mode: s.share_mode, expires_at: s.expires_at }],
      now,
      bot.kind === 'walker' ? 'walking' : 'still',
      extras,
    );
    try {
      this.applyFanoutNow(toFanoutUpdate(packets), botId, now);
      return true;
    } catch {
      // kural reddi (ör. tam bu an süresi doldu): bot sessizce atlar
      return false;
    }
  }

  // --- süpürücü -----------------------------------------------------------------------------------

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const s of Object.values(this.db.shares)) {
      if (s.status === 'active' && s.expires_at !== null && s.expires_at <= now) {
        this.endShare(s, 'expired', now);
        changed = true;
      }
    }
    for (const [owner, list] of Object.entries(this.db.outgoing)) {
      for (const o of Object.values(list)) {
        if (o.expires_at <= now) {
          delete list[o.id];
          changed = true;
          continue;
        }
        if (o.auto_accept_at !== null && o.auto_accept_at <= now) {
          o.auto_accept_at = null;
          const f = o.friendship_id ? this.db.friendships[o.friendship_id] : undefined;
          if (f && f.status === 'pending' && f.requested_by === owner) this.acceptFriendship(f, now);
          delete list[o.id];
          changed = true;
        }
      }
    }
    for (const bot of Object.values(this.db.bots)) {
      if (bot.next_at <= now) {
        this.botPublish(bot.uid, now);
        changed = true; // next_at ilerledi (kalıcı durum değişti)
      }
    }
    // Faz 2: süresi dolan bağlantı (backend süre dolumu görevi + tarama): `expired`, mezar taşı, link_live silinir.
    for (const l of Object.values(this.db.links)) {
      if (l.status === 'active' && l.expires_at !== null && l.expires_at <= now) {
        this.endLink(l, 'expired', now);
        changed = true;
      }
    }
    if (this.sweepPhase4(now)) changed = true;
    if (this.sweepPhase5(now)) changed = true;
    if (this.sweepPhase8(now)) changed = true;
    if (this.sweepLocationRequests(now)) changed = true;
    if (this.sweepPhase7(now)) changed = true;
    if (now - this.lastPrune > MINUTE) {
      this.lastPrune = now;
      if (this.prunePhase2(now)) changed = true;
      if (this.prunePhase6(now)) changed = true;
      if (this.prunePhase7(now)) changed = true;
    }
    if (changed) this.commit();
  }

  /** Eski Faz 2 kayıtları (TTL alanlarının karşılığı): biten bağlantı 1 gün, mezar taşı 1 gün, önbellekler süresiyle. */
  private prunePhase2(now: EpochMs): boolean {
    let changed = false;
    for (const l of Object.values(this.db.links)) {
      if (l.status === 'ended' && (l.ended_at ?? now) < now - DAY) {
        delete this.db.links[l.link_id];
        changed = true;
      }
    }
    for (const [hash, acl] of Object.entries(this.db.link_acl)) {
      if (acl.status === 'ended' && (acl.ended_at ?? now) < now - DAY) {
        delete this.db.link_acl[hash];
        changed = true;
      }
    }
    const drop = <T,>(rec: Record<string, T>, gone: (k: string, v: T) => boolean) => {
      for (const [k, v] of Object.entries(rec)) {
        if (!gone(k, v)) continue;
        delete rec[k];
        changed = true;
      }
    };
    // Faz 3: 24 sa'ten eski iz noktaları (backend bekçi turu) ve eski düşük pil durumları.
    for (const [receiver, byShare] of Object.entries(this.db.trail)) {
      for (const [id, pts] of Object.entries(byShare)) {
        for (const [pid, p] of Object.entries(pts)) {
          if (typeof p.timestamp === 'number' && p.timestamp < now - TRAIL_TTL_MS) {
            delete pts[pid];
            changed = true;
          }
        }
        if (Object.keys(pts).length === 0) delete byShare[id];
      }
      if (Object.keys(byShare).length === 0) delete this.db.trail[receiver];
    }
    drop(this.db.battery_alerts, (_k, r) => (r.sent[r.sent.length - 1] ?? r.state.firedAt ?? now) < now - 2 * DAY);
    drop(this.db.route_cache, (_k, r) => r.expire_at <= now);
    drop(this.db.geocode_cache, (_k, r) => r.expire_at <= now);
    const today = quotaDay(now);
    drop(this.db.maps_quota, (k) => !k.endsWith(`_${today}`));
    return changed;
  }

  private acceptFriendship(f: FriendshipRec, now: EpochMs): void {
    f.status = 'accepted';
    f.accepted_at = now;
    f.updated_at = now;
    for (const m of f.member_ids) f.member_profiles[m] = this.publicProfile(m);
    // İsteyenin giden kaydı kalkar.
    const list = this.db.outgoing[f.requested_by];
    if (list) for (const o of Object.values(list)) if (o.friendship_id === f.id) delete list[o.id];
  }

  // --- RTDB çok yollu yazma (kurallar) -----------------------------------------------------------

  /** `writeFanout` karşılığı: kısa gecikme, sonra kural denetimi ve atomik uygulama. */
  async applyFanout(map: Record<string, unknown>, authUid: UserId | null): Promise<void> {
    await new Promise((r) => setTimeout(r, randomBetween(40, 120)));
    this.applyFanoutNow(map, authUid, Date.now());
  }

  private applyFanoutNow(map: Record<string, unknown>, authUid: UserId | null, now: EpochMs): void {
    if (!authUid) throw new DemoPermissionDenied('auth == null');
    // Faz 8: görünmez kullanıcının konum yazısı kurallarca reddedilir (silme serbest).
    if (isInvisible(this.db.users[authUid]) && Object.values(map).some((v) => v !== null && v !== undefined)) {
      throw new DemoPermissionDenied('görünmez mod: konum yazılamaz');
    }
    const writes: { receiver: UserId; id: string; value: Record<string, unknown> | null }[] = [];
    const linkWrites: { hash: string; value: Record<string, unknown> | null }[] = [];
    const trailWrites: { receiver: UserId; id: string; point: string; value: Record<string, unknown> | null }[] = [];
    for (const [path, value] of Object.entries(map)) {
      const lm = /^\/?link_live\/([^/]+)$/.exec(path);
      if (lm) {
        linkWrites.push({ hash: lm[1] as string, value: this.checkLinkLiveWrite(lm[1] as string, value, authUid, now, path) });
        continue;
      }
      // Faz 3: çevrimdışı iz (`live_trail/{receiver}/{share_id}/{point_id}`); üst düğüme toplu yazma reddedilir.
      const tm = /^\/?live_trail\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
      if (tm) {
        const [receiver, id, point] = [tm[1] as string, tm[2] as string, tm[3] as string];
        trailWrites.push({ receiver, id, point, value: this.checkTrailWrite(receiver, id, point, value, authUid, now, path) });
        continue;
      }
      const m = /^\/?live_locations\/([^/]+)\/([^/]+)$/.exec(path);
      if (!m) throw new DemoPermissionDenied(`yazma izni yok: ${path}`);
      const receiver = m[1] as string;
      const id = m[2] as string;
      const acl = this.db.acl[id];
      if (!acl || acl.status !== 'active' || acl.sender_id !== authUid || acl.receiver_id !== receiver) {
        throw new DemoPermissionDenied(`paylaşım aktif değil: ${path}`);
      }
      if (value === null || value === undefined) {
        writes.push({ receiver, id, value: null });
        continue;
      }
      if (acl.expires_at !== undefined && acl.expires_at <= now) throw new DemoPermissionDenied(`süre doldu: ${path}`);
      const v = { ...(value as Record<string, unknown>) };
      const sv = v.server_ts as { '.sv'?: unknown } | undefined;
      if (!sv || sv['.sv'] !== SERVER_TIMESTAMP['.sv']) throw new DemoPermissionDenied('server_ts sunucu zamanı olmalı');
      v.server_ts = now;
      this.validatePacket(v, id, authUid, acl, now, path, this.db.live[receiver]?.[id] ?? null);
      writes.push({ receiver, id, value: v });
    }
    // Çok yollu yazma atomiktir: buraya kadar hiçbir yol reddedilmediyse hepsi uygulanır.
    for (const w of writes) {
      const inbox = (this.db.live[w.receiver] ??= {});
      if (w.value === null) delete inbox[w.id];
      else inbox[w.id] = w.value;
    }
    for (const w of linkWrites) {
      if (w.value === null) delete this.db.link_live[w.hash];
      else this.db.link_live[w.hash] = w.value;
    }
    for (const w of trailWrites) {
      if (w.value === null) {
        const pts = this.db.trail[w.receiver]?.[w.id];
        if (pts) delete pts[w.point];
      } else ((this.db.trail[w.receiver] ??= {})[w.id] ??= {})[w.point] = w.value;
    }
    this.commit();
  }

  /**
   * Faz 3: `database.rules.json` → `live_trail/$receiver_id/$share_id/$point_id` (yazma: ACL aktif + gönderen +
   * alıcı + süresi dolmamış; alanlar core `TRAIL_FIELDS`; `q === 1`; zaman penceresi 24 sa ve ≥ ACL `started_at`).
   */
  private checkTrailWrite(
    receiver: UserId,
    id: string,
    point: string,
    value: unknown,
    auth: UserId,
    now: EpochMs,
    path: string,
  ): Record<string, unknown> | null {
    const deny = (why: string): never => {
      throw new DemoPermissionDenied(`${why}: ${path}`);
    };
    const acl = this.db.acl[id];
    if (!acl || acl.status !== 'active' || acl.sender_id !== auth || acl.receiver_id !== receiver) deny('paylaşım aktif değil');
    const a = acl as AclRec;
    if (a.expires_at !== undefined && a.expires_at <= now) deny('süre doldu');
    if (value === null || value === undefined) return null;
    if (!/^[0-9]{13}-[0-9]{3}$/.test(point)) deny('point_id');
    const v = { ...(value as Record<string, unknown>) };
    const sv = v.server_ts as { '.sv'?: unknown } | undefined;
    if (!sv || sv['.sv'] !== SERVER_TIMESTAMP['.sv']) deny('server_ts sunucu zamanı olmalı');
    v.server_ts = now;
    for (const k of ['v', 'lat', 'lng', 'accuracy', 'timestamp', 'recorded_at', 'q', 'server_ts']) if (!(k in v)) deny(`eksik alan ${k}`);
    const allowed = new Set<string>(TRAIL_FIELDS);
    for (const k of Object.keys(v)) if (!allowed.has(k)) deny(`izinsiz alan ${k}`);
    const num = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? (v[k] as number) : deny(`${k} sayı olmalı`));
    if (v.v !== 1 || v.q !== 1) deny('v / q');
    const lat = num('lat');
    const lng = num('lng');
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) deny('koordinat');
    const acc = num('accuracy');
    if (acc < 0 || acc > 1000) deny('accuracy');
    if ('battery_pct' in v) {
      // Faz 7 kuralı: `privacy/{auth.uid}/battery_share === true` değilse pil alanı yazılamaz.
      if (!this.batteryShareOf(auth)) deny('pil paylaşımı kapalı');
      const b = num('battery_pct');
      if (!Number.isInteger(b) || b < 0 || b > 100) deny('battery_pct');
    }
    const ts = num('timestamp');
    if (!Number.isInteger(ts) || ts < now - PACKET_LIMITS.maxQueuedSampleAgeMs || ts > now + 60_000) deny('timestamp penceresi');
    if (a.started_at !== undefined && ts < a.started_at) deny('paylaşımdan eski nokta');
    const rec = num('recorded_at');
    if (!Number.isInteger(rec) || rec < PACKET_LIMITS.minRecordedAtMs || rec > now + PACKET_LIMITS.maxRecordedAheadMs) deny('recorded_at');
    return v;
  }

  /**
   * `database.rules.json` → `link_live/$token_hash` `.write` + alan `.validate` kuralları. Dönen: yazılacak değer
   * (server_ts çözülmüş) ya da silme için null. Reddedilirse `DemoPermissionDenied` (yazmanın tamamı düşer).
   */
  private checkLinkLiveWrite(hash: string, value: unknown, auth: UserId, now: EpochMs, path: string): Record<string, unknown> | null {
    const deny = (why: string): never => {
      throw new DemoPermissionDenied(`${why}: ${path}`);
    };
    const acl = isLinkTokenHash(hash) ? this.db.link_acl[hash] : undefined;
    if (!acl || acl.status !== 'active' || acl.sender_id !== auth) deny('bağlantı aktif değil');
    const a = acl as LinkAclRec;
    if (value === null || value === undefined) return null;
    if (a.expires_at !== undefined && a.expires_at <= now) deny('bağlantının süresi doldu');
    const v = { ...(value as Record<string, unknown>) };
    const sv = v.server_ts as { '.sv'?: unknown } | undefined;
    if (!sv || sv['.sv'] !== SERVER_TIMESTAMP['.sv']) deny('server_ts sunucu zamanı olmalı');
    v.server_ts = now;
    for (const k of ['v', 'lat', 'lng', 'accuracy', 'timestamp', 'server_ts', 'sender_name', 'share_mode']) if (!(k in v)) deny(`eksik alan ${k}`);
    const allowed = new Set<string>(LINK_LIVE_FIELDS);
    for (const k of Object.keys(v)) if (!allowed.has(k)) deny(`izinsiz alan ${k}`);
    const num = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? (v[k] as number) : deny(`${k} sayı olmalı`));
    if (v.v !== 1) deny('v');
    const lat = num('lat');
    const lng = num('lng');
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) deny('koordinat');
    const acc = num('accuracy');
    if (acc < 0 || acc > 1000) deny('accuracy');
    if ('heading' in v) {
      const h = num('heading');
      if (h < 0 || h >= 360) deny('heading');
    }
    if ('speed_mps' in v) {
      const sp = num('speed_mps');
      if (sp < 0 || sp > 120) deny('speed_mps');
    }
    if ('battery_pct' in v) {
      // Faz 7 kuralı: `privacy/{auth.uid}/battery_share === true` değilse pil alanı yazılamaz.
      if (!this.batteryShareOf(auth)) deny('pil paylaşımı kapalı');
      const b = num('battery_pct');
      if (!Number.isInteger(b) || b < 0 || b > 100) deny('battery_pct');
    }
    this.validateF3Fields(v, deny, false);
    const ts = num('timestamp');
    if (!Number.isInteger(ts) || ts > now + 60_000) deny('timestamp penceresi');
    // RTDB kuralıyla aynı: 2 dk'lık taze pencere yalnızca kuyruk dışı (q !== 1) noktalar için; kuyruk noktası her
    // yaşta "düğümden yeni" ve "paylaşımdan sonra" olmalı (eski kuyruk noktası yeni canlıyı ezmesin).
    if (v.q === 1) {
      const cur = this.db.link_live[hash];
      if (ts < now - PACKET_LIMITS.maxQueuedSampleAgeMs) deny('timestamp penceresi');
      if (cur && typeof cur.timestamp === 'number' && ts <= cur.timestamp) deny('kuyruk noktası canlı noktadan eski');
      if (a.started_at !== undefined && ts < a.started_at) deny('paylaşımdan eski nokta');
    } else if (ts < now - 120_000) deny('timestamp penceresi');
    if (typeof v.sender_name !== 'string' || v.sender_name.length < 1 || v.sender_name.length > 80) deny('sender_name');
    if (!['timed', 'until_end_of_day', 'weekly', 'indefinite'].includes(v.share_mode as string)) deny('share_mode');
    if (v.share_mode !== a.share_mode) deny('share_mode ACL ile aynı değil');
    if (a.expires_at !== undefined) {
      if (v.expires_at !== a.expires_at) deny('expires_at ACL ile aynı değil');
    } else if ('expires_at' in v) deny('süresiz bağlantıda expires_at olmamalı');
    return v;
  }

  private validatePacket(
    v: Record<string, unknown>,
    id: string,
    auth: UserId,
    acl: AclRec,
    now: EpochMs,
    path: string,
    existing: Record<string, unknown> | null,
  ): void {
    const deny = (why: string): never => {
      throw new DemoPermissionDenied(`${why}: ${path}`);
    };
    const required = ['v', 'share_id', 'sender_id', 'lat', 'lng', 'accuracy', 'activity_state', 'timestamp', 'share_mode', 'server_ts'];
    for (const k of required) if (!(k in v)) deny(`eksik alan ${k}`);
    // Faz 3: isteğe bağlı `hb`, `q`, `recorded_at` (core DELIVERED_OPTIONAL_F3_FIELDS); Faz 4: `note`, `note_exp`.
    const allowed = new Set([...required, 'speed_mps', 'heading', 'battery_pct', 'is_charging', 'expires_at', 'hb', 'q', 'recorded_at', 'note', 'note_exp']);
    for (const k of Object.keys(v)) if (!allowed.has(k)) deny(`izinsiz alan ${k}`);
    const num = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? (v[k] as number) : deny(`${k} sayı olmalı`));
    if (v.v !== 1) deny('v');
    if (v.share_id !== id) deny('share_id');
    if (v.sender_id !== auth) deny('sender_id');
    const lat = num('lat');
    const lng = num('lng');
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) deny('koordinat');
    const acc = num('accuracy');
    if (acc < 0 || acc > 1000) deny('accuracy');
    if ('speed_mps' in v) {
      const sp = num('speed_mps');
      if (sp < 0 || sp > 120) deny('speed_mps');
    }
    if ('heading' in v) {
      const h = num('heading');
      if (h < 0 || h >= 360) deny('heading');
    }
    if ('battery_pct' in v) {
      // Faz 7 kuralı: `privacy/{auth.uid}/battery_share === true` değilse pil alanı yazılamaz.
      if (!this.batteryShareOf(auth)) deny('pil paylaşımı kapalı');
      const b = num('battery_pct');
      if (!Number.isInteger(b) || b < 0 || b > 100) deny('battery_pct');
    }
    if ('is_charging' in v && (!this.batteryShareOf(auth) || typeof v.is_charging !== 'boolean')) deny('is_charging');
    if (!['still', 'walking', 'running', 'cycling', 'automotive', 'unknown'].includes(v.activity_state as string)) deny('activity_state');
    this.validateF3Fields(v, deny, true);
    // Faz 4 (RTDB kuralı): `note` 1..60 karakter ve `note_exp` sayı; ikisi birlikte.
    if ('note' in v || 'note_exp' in v) {
      if (!('note' in v) || !('note_exp' in v)) deny('note ve note_exp birlikte olmalı');
      if (typeof v.note !== 'string' || v.note.length < 1 || v.note.length > PACKET_NOTE_MAX_CHARS) deny('note');
      num('note_exp');
    }
    const ts = num('timestamp');
    if (!Number.isInteger(ts) || ts > now + 60_000) deny('timestamp penceresi');
    // Faz 3 (RTDB kuralıyla aynı): kuyruktan gelen nokta (q: 1) 24 sa'e kadar eski olabilir, ama HER YAŞTA düğümdekinden
    // yeni ve paylaşımdan sonra olmalı; 2 dk'lık taze pencere yalnızca kuyruk dışı noktalar için.
    if (v.q === 1) {
      if (ts < now - PACKET_LIMITS.maxQueuedSampleAgeMs) deny('timestamp penceresi');
      if (existing && typeof existing.timestamp === 'number' && ts <= existing.timestamp) deny('kuyruk noktası canlı noktadan eski');
      if (acl.started_at !== undefined && ts < acl.started_at) deny('paylaşımdan eski nokta');
    } else if (ts < now - 120_000) deny('timestamp penceresi');
    if (!['timed', 'until_end_of_day', 'weekly', 'indefinite'].includes(v.share_mode as string)) deny('share_mode');
    if (v.share_mode !== acl.share_mode) deny('share_mode ACL ile aynı değil');
    if (acl.expires_at !== undefined) {
      if (v.expires_at !== acl.expires_at) deny('expires_at ACL ile aynı değil');
    } else if ('expires_at' in v) deny('süresiz paylaşımda expires_at olmamalı');
  }

  /** Faz 3 alanları (`hb` 10 sn–6 sa tam sayı, `q === 1`, `recorded_at` yalnızca arkadaş paketinde). */
  private validateF3Fields(v: Record<string, unknown>, deny: (why: string) => never, withRecordedAt: boolean): void {
    const int = (k: string) => (typeof v[k] === 'number' && Number.isInteger(v[k]) ? (v[k] as number) : deny(`${k} tam sayı olmalı`));
    if ('hb' in v) {
      const hb = int('hb');
      if (hb < PACKET_LIMITS.minHeartbeatMs || hb > PACKET_LIMITS.maxHeartbeatMs) deny('hb');
    }
    if ('q' in v && v.q !== 1) deny('q');
    if ('recorded_at' in v) {
      if (!withRecordedAt) deny('izinsiz alan recorded_at');
      const r = int('recorded_at');
      if (r < PACKET_LIMITS.minRecordedAtMs || r > Date.now() + PACKET_LIMITS.maxRecordedAheadMs) deny('recorded_at');
    }
  }

  // --- okuma (dinleyiciler) ----------------------------------------------------------------------

  /** `users/{uid}` (yalnızca sahibi okur). Faz 6: cinsiyet, avatar (yerel adrese çözülmüş), sürüm, favoriler. */
  profileOf(uid: UserId): UserProfile | null {
    const u = this.db.users[uid];
    if (!u) return null;
    const main = this.avatars.resolve(u.avatar_url);
    return {
      user_id: uid,
      display_name: u.display_name,
      avatar_url: main,
      invite_code: u.invite_code,
      created_at: u.created_at,
      rtdb_instance: 0,
      gender: u.gender ?? null,
      avatar_thumb_url: main ? (this.avatars.resolve(u.avatar_thumb_url) ?? main) : null,
      avatar_version: main ? (u.avatar_version ?? null) : null,
      favorite_ids: [...(u.favorite_ids ?? [])],
      invisible: u.invisible ?? null,
      consent: u.consent ?? null,
      privacy: u.privacy ?? null,
    };
  }

  friendshipsOf(uid: UserId): FriendshipRec[] {
    return Object.values(this.db.friendships)
      .filter((f) => (f.status === 'accepted' && f.member_ids.includes(uid)) || (f.status === 'pending' && f.target_id === uid))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => ({
        ...f,
        member_profiles: Object.fromEntries(Object.entries(f.member_profiles).map(([m, p]) => [m, this.resolvedProfile(p)])),
      }));
  }

  outgoingRequestsOf(uid: UserId): { id: string; via: 'invite_code' | 'phone'; label: string; created_at: EpochMs; expires_at: EpochMs }[] {
    return Object.values(this.db.outgoing[uid] ?? {}).map((o) => ({ id: o.id, via: o.via, label: o.label, created_at: o.created_at, expires_at: o.expires_at }));
  }

  sharesWhere(field: 'sender_id' | 'receiver_id', uid: UserId): ShareRec[] {
    return Object.values(this.db.shares)
      .filter((s) => s[field] === uid)
      .sort((a, b) => a.share_id.localeCompare(b.share_id));
  }

  inboxOf(uid: UserId): Record<string, Record<string, unknown>> {
    return this.db.live[uid] ?? {};
  }

  /** Faz 3: `live_trail/{uid}` (okuma kuralı: yalnızca alıcı). */
  trailOf(uid: UserId): Record<string, Record<string, Record<string, unknown>>> {
    return this.db.trail[uid] ?? {};
  }

  /** Faz 3: push aboneliği (FCM token kaydı karşılığı). Dönen fonksiyon aboneliği kapatır. */
  subscribePush(uid: UserId, cb: (m: DemoPushMessage) => void): () => void {
    const set = this.pushListeners.get(uid) ?? new Set();
    set.add(cb);
    this.pushListeners.set(uid, set);
    return () => {
      set.delete(cb);
    };
  }

  private push(uid: UserId, m: DemoPushMessage): void {
    const set = this.pushListeners.get(uid);
    if (!set || set.size === 0) return;
    // FCM gecikmesi
    setTimeout(() => {
      for (const cb of [...set]) {
        try {
          cb(clone(m));
        } catch {
          // dinleyici hatası sunucuyu etkilemez
        }
      }
    }, randomBetween(250, 700));
  }

  /** Firestore `link_shares where sender_id == uid` (kural: yalnızca gönderen okur). */
  linksWhere(uid: UserId): LinkRec[] {
    return Object.values(this.db.links)
      .filter((l) => l.sender_id === uid)
      .sort((a, b) => a.started_at - b.started_at || a.link_id.localeCompare(b.link_id));
  }

  /** `link_live/$token_hash` `.read` kuralı: kimlik gerekmez; ACL aktif ve süresi dolmamış olmalı. */
  private linkReadAllowed(hash: string, now: EpochMs): boolean {
    if (!isLinkTokenHash(hash)) return false;
    const acl = this.db.link_acl[hash];
    return !!acl && acl.status === 'active' && (acl.expires_at === undefined || acl.expires_at > now);
  }

  /**
   * Token sahibinin RTDB dinleyicisi (`onValue(link_live/{hash})`). İzin yoksa (ya da sonradan kalkarsa:
   * mezar taşı, süre dolumu) dinleyici `permission_denied` ile iptal edilir; izin varken düğüm silinirse `null`.
   */
  listenLinkLive(hash: string, onValue: (v: Record<string, unknown> | null) => void, onDenied: () => void): () => void {
    let open = true;
    this.linkListeners++;
    this.commit();
    const close = () => {
      if (!open) return;
      open = false;
      this.linkListeners--;
      unsub();
      this.commit();
    };
    const unsub = this.subscribe(
      () => (this.linkReadAllowed(hash, Date.now()) ? { ok: true as const, value: this.db.link_live[hash] ?? null } : { ok: false as const }),
      (r) => {
        if (!open) return;
        if (r.ok) onValue(r.value);
        else {
          close();
          onDenied();
        }
      },
    );
    return close;
  }

  // --- callable'lar ----------------------------------------------------------------------------

  async call(name: string, payload: unknown, authUid: UserId | null): Promise<unknown> {
    await new Promise((r) => setTimeout(r, randomBetween(150, 400)));
    // Faz 6: widget uzantısı / AppWidget alıcısı oturumsuz çağırır; yetki = token (op_id token başına).
    if (name === 'widget_quick_share') {
      const r = this.widgetQuickShareCall(payload, Date.now());
      this.commit();
      return clone(r);
    }
    if (!authUid) fail('unauthenticated');
    const uid = authUid as UserId;
    // Faz 8 onay ön kapısı (backend `consentGate`): koruyucu işlemler ve user_bootstrap muaf; op tekrarından ÖNCE.
    if (!consentExemptCall(name, payload) && consentRequired(this.db.users[uid]?.consent)) fail('consent_required');
    const opId = (payload as { op_id?: unknown } | null)?.op_id;
    const opKey = typeof opId === 'string' ? `${uid}:${name}:${opId}` : null;
    const now = Date.now();
    const replay = opKey ? this.db.ops[opKey] : undefined;
    // Faz 6: token üretimi op kaydına girmez; her çağrı (aynı op_id dahil) yeni token verir (backend ile aynı).
    if (name === 'widget_token_issue') {
      const r = this.widgetTokenIssueCall(payload, uid, now);
      this.commit();
      return clone(r);
    }
    if (opKey && replay) {
      if (name !== 'link_share_create') return clone(replay.response);
      // Yanıtı kaybolan create: düz token saklanmadığı için token YENİLENİR (backend ile aynı).
      const renewed = this.linkCreateReplay(replay.response, uid, now);
      this.db.ops[opKey] = { at: replay.at, response: storedLinkCreate(renewed) };
      this.commit();
      return clone(renewed);
    }
    const response = this.dispatch(name, payload, uid, now);
    // Op kaydına düz token ve URL GİRMEZ.
    if (opKey) this.db.ops[opKey] = { at: now, response: name === 'link_share_create' ? storedLinkCreate(response as LinkShareCreateResponse) : clone(response) };
    this.commit();
    return clone(response);
  }

  private dispatch(name: string, payload: unknown, uid: UserId, now: EpochMs): unknown {
    switch (name) {
      case 'user_bootstrap':
        return this.userBootstrap(payload, uid, now);
      case 'share_start':
        return this.shareStartCall(payload, uid, now);
      case 'share_extend':
        return this.shareExtendCall(payload, uid, now);
      case 'share_stop':
        return this.shareStopCall(payload, uid, now);
      case 'share_revoke':
        return this.shareRevokeCall(payload, uid, now);
      case 'friend_request_send':
        return this.friendRequestSend(payload, uid, now);
      case 'friend_request_respond':
        return this.friendRequestRespond(payload, uid, now);
      case 'friend_request_cancel':
        return this.friendRequestCancel(payload, uid, now);
      case 'friendship_remove':
        return this.friendshipRemove(payload, uid, now);
      case 'invite_code_regenerate':
        return this.inviteCodeRegenerate(uid, now);
      case 'link_share_create':
        return this.linkShareCreate(payload, uid, now);
      case 'link_share_extend':
        return this.linkShareExtend(payload, uid, now);
      case 'link_share_stop':
        return this.linkShareStop(payload, uid, now);
      case 'route_compute':
        return this.routeCompute(payload, uid, now);
      case 'geocode_reverse':
        return this.geocodeReverse(payload, uid, now);
      case 'battery_low_notify':
        return this.batteryLowNotify(payload, uid, now);
      // Faz 4
      case 'ping_send':
        return this.pingSendCall(payload, uid, now);
      case 'place_note_upsert':
        return this.placeNoteUpsertCall(payload, uid, now);
      case 'place_note_delete':
        return this.placeNoteDeleteCall(payload, uid, now);
      case 'emergency_contacts_set':
        return this.emergencyContactsSetCall(payload, uid, now);
      case 'sos_send':
        return this.sosSendCall(payload, uid, now);
      case 'sos_update':
        return this.sosUpdateCall(payload, uid, now);
      case 'sos_resolve':
        return this.sosResolveCall(payload, uid, now);
      case 'sos_ack':
        return this.sosAckCall(payload, uid, now);
      // Faz 5
      case 'zone_upsert':
        return this.zoneUpsertCall(payload, uid, now);
      case 'zone_delete':
        return this.zoneDeleteCall(payload, uid, now);
      case 'zone_event_report':
        return this.zoneEventReportCall(payload, uid, now);
      case 'meetup_suggest':
        return this.meetupSuggestCall(payload, uid, now);
      case 'meetup_share':
        return this.meetupShareCall(payload, uid, now);
      case 'meetup_respond':
        return this.meetupRespondCall(payload, uid, now);
      case 'meetup_cancel':
        return this.meetupCancelCall(payload, uid, now);
      // Faz 6
      case 'favorites_set':
        return this.favoritesSetCall(payload, uid, now);
      case 'widget_token_revoke':
        return this.widgetTokenRevokeCall(payload, uid, now);
      // Faz 8
      case 'permission_request_send':
        return this.permissionRequestSendCall(payload, uid, now);
      case 'permission_request_respond':
        return this.permissionRequestRespondCall(payload, uid, now);
      case 'permission_set':
        return this.permissionSetCall(payload, uid, now);
      case 'invisible_set':
        return this.invisibleSetCall(payload, uid, now);
      case 'consent_accept':
        return this.consentAcceptCall(payload, uid, now);
      case 'consent_withdraw':
        return this.consentWithdrawCall(payload, uid, now);
      // Konum İste
      case 'location_request_send':
        return this.locationRequestSendCall(payload, uid, now);
      case 'location_request_respond':
        return this.locationRequestRespondCall(payload, uid, now);
      case 'location_request_cancel':
        return this.locationRequestCancelCall(payload, uid, now);
      // Faz 7
      case 'event_create':
        return this.eventCreateCall(payload, uid, now);
      case 'event_rsvp': {
        const d = this.parse(EventRsvpRequestSchema, payload);
        return this.mutateEvent(d.event_id, uid, now, { type: 'rsvp', round: d.round, status: d.status, note: d.note });
      }
      case 'event_venue_propose': {
        const d = this.parse(EventVenueProposeRequestSchema, payload);
        return this.mutateEvent(d.event_id, uid, now, { type: 'venue_propose', venue: d.venue });
      }
      case 'event_venue_remove': {
        const d = this.parse(EventVenueRemoveRequestSchema, payload);
        return this.mutateEvent(d.event_id, uid, now, { type: 'venue_remove', option_id: d.option_id });
      }
      case 'event_vote': {
        const d = this.parse(EventVoteRequestSchema, payload);
        return this.mutateEvent(d.event_id, uid, now, { type: 'vote', kind: d.kind, option_id: d.option_id });
      }
      case 'event_advance': {
        const d = this.parse(EventAdvanceRequestSchema, payload);
        const action: EventAction =
          d.action === 'open_venue_vote'
            ? { type: 'open_venue_vote', vote_window_ms: d.vote_window_ms }
            : { type: 'close_vote', kind: d.action === 'close_venue_vote' ? 'venue' : 'time', tie_break_option_id: d.tie_break_option_id };
        return this.mutateEvent(d.event_id, uid, now, action);
      }
      case 'event_time_options_set': {
        const d = this.parse(EventTimeOptionsSetRequestSchema, payload);
        return this.mutateEvent(d.event_id, uid, now, { type: 'time_options_set', minutes: d.minutes });
      }
      case 'event_update': {
        const d = this.parse(EventUpdateRequestSchema, payload);
        return this.mutateEvent(d.event_id, uid, now, {
          type: 'update',
          ...(d.title !== undefined ? { title: d.title } : {}),
          ...(d.description !== undefined ? { description: d.description } : {}),
          ...(d.date !== undefined ? { date: d.date } : {}),
        });
      }
      case 'event_invite_add':
        return this.eventInviteAddCall(payload, uid, now);
      case 'event_cancel': {
        const d = this.parse(EventCancelRequestSchema, payload);
        return this.mutateEvent(d.event_id, uid, now, { type: 'cancel' });
      }
      case 'privacy_settings_set':
        return this.privacySettingsSetCall(payload, uid, now);
      case 'movement_report':
        return this.movementReportCall(payload, uid, now);
      default:
        return fail('invalid_argument', `Demo sunucusunda yok: ${name}`);
    }
  }

  private parse<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
    const r = schema.safeParse(payload);
    if (!r.success) fail('invalid_argument');
    return (r as { data: z.output<S> }).data;
  }

  /**
   * Faz 6 (backend `userBootstrap`): `gender` profil OLUŞTURULURKEN zorunlu. Demo hesabı tohumda adsız hazır
   * bekler; bu yüzden "oluşturma" = kayıt yok YA DA ilk kez ad veriliyor (ad ekranı). Sonraki çağrılarda verilmezse
   * mevcut değer kalır (eski hesapta `null` → uygulama cinsiyet seçimi ister), `null` şemada reddedilir.
   * `avatar_url` / `avatar_thumb_url`: demo kovasındaki `avatars/{uid}/...` adresi, küçük boy aynı sürümün `_160`
   * kardeşi; `avatar_url: null` fotoğrafı kaldırır. Değişen ad / fotoğraf / cinsiyet arkadaş kopyalarına yayılır.
   */
  private userBootstrap(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(
      z
        .object({
          op_id: z.uuid().optional(),
          display_name: z.string().trim().min(1).max(40).optional(),
          time_zone: z.string().min(1).max(64),
          avatar_url: z.url({ protocol: /^https$/ }).max(2048).nullable().optional(),
        })
        .extend(ProfileFieldsF6Schema.shape),
      payload,
    );
    if (data.avatar_url) this.assertAvatarUrl(data.avatar_url, uid, 'main');
    if (data.avatar_thumb_url) this.assertAvatarUrl(data.avatar_thumb_url, uid, 'thumb');
    if (checkAvatarPair(data.avatar_url, data.avatar_thumb_url, uid) !== 'ok') fail('invalid_argument', 'Küçük avatar ana avatarla eşleşmiyor');
    let u = this.db.users[uid];
    const creating = !u || (data.display_name !== undefined && !u.display_name.trim() && u.gender === null);
    const g = resolveProfileGender(isGender(u?.gender) ? (u?.gender ?? null) : null, data.gender, creating);
    if (!g.ok) return fail('gender_required');
    const created = !u;
    if (!u) u = this.addUser(uid, '', this.randomInviteCode(), now);
    u.time_zone = data.time_zone;
    let changed = false;
    if (data.display_name && data.display_name !== u.display_name) {
      u.display_name = data.display_name;
      changed = true;
    }
    if (g.changed) {
      u.gender = g.gender;
      changed = true;
    }
    if (data.avatar_url !== undefined) {
      const thumb = data.avatar_url ? (data.avatar_thumb_url ?? null) : null;
      const version = data.avatar_url ? (parseAvatarObjectPath(avatarObjectPathFromUrl(data.avatar_url) ?? '')?.version ?? null) : null;
      if (data.avatar_url !== u.avatar_url || thumb !== u.avatar_thumb_url) {
        const oldVersion = u.avatar_version;
        u.avatar_url = data.avatar_url;
        u.avatar_thumb_url = thumb;
        u.avatar_version = version;
        changed = true;
        // Önceki sürümün iki nesnesi silinir (en iyi çaba; backend `deleteAvatarObjects`).
        if (oldVersion !== null && oldVersion !== version) {
          const old = avatarObjectPaths(uid, oldVersion);
          this.avatars.remove(old.main, 'server');
          this.avatars.remove(old.thumb, 'server');
        }
      }
    }
    if (changed) {
      // Kabul edilmiş arkadaşlıklardaki profil kopyaları güncellenir (bekleyen istek kopyası yalnızca ad).
      for (const f of Object.values(this.db.friendships)) {
        if (!f.member_profiles[uid]) continue;
        f.member_profiles[uid] = f.status === 'accepted' ? this.publicProfile(uid) : this.pendingProfile(uid);
      }
    }
    return { user: this.profileOf(uid), created, server_now: now };
  }

  /** Backend `assertAvatarUrl`: yalnızca demo kovasındaki `avatars/{uid}/{sürüm}(_160).jpg` (serbest https yok). */
  private assertAvatarUrl(url: string, uid: UserId, kind: 'main' | 'thumb'): void {
    const m = /^https:\/\/([^/?#:@]+)\/v0\/b\/([^/?#]+)\/o\/([^/?#]+)(?:\?[^#]*)?$/.exec(url);
    if (!m || m[1] !== DEMO_STORAGE_HOST || decodeURIComponent(m[2] ?? '') !== DEMO_STORAGE_BUCKET) fail('invalid_argument', 'Avatar adresi geçersiz');
    const ref = parseAvatarObjectPath(avatarObjectPathFromUrl(url) ?? '');
    if (!ref || ref.uid !== uid || ref.thumb !== (kind === 'thumb')) fail('invalid_argument', 'Avatar adresi geçersiz');
  }

  private shareStartCall(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(ShareStartRequestSchema, payload);
    if (isInvisible(this.db.users[uid])) fail('invisible_mode');
    let resolved: { share_mode: ShareMode; expires_at: EpochMs | null };
    try {
      resolved = resolveDuration(data.duration, now, offsetFnForTimeZone(data.time_zone));
    } catch (e) {
      if (e instanceof DurationError) fail('invalid_duration', e.message);
      throw e;
    }
    const sessionId = uuidV4();
    const started: ShareRec[] = [];
    const skipped: UserId[] = [];
    const needsGrant: UserId[] = [];
    for (const r of [...new Set(data.receiver_ids)]) {
      if (!this.areFriends(uid, r)) {
        skipped.push(r);
        continue;
      }
      // Faz 8: alıcıda `location_view` yoksa bayrakla aynı işlemde yazılır (`share`), değilse yalnızca çağırana döner.
      if (!hasGrant(this.grantOf(uid, r), 'location_view')) {
        if (!data.grant_location_view) {
          needsGrant.push(r);
          continue;
        }
        this.grantScope(uid, r, 'location_view', 'share', now);
      }
      started.push(this.startShare(uid, r, sessionId, resolved.share_mode, resolved.expires_at, now));
    }
    return { session_id: sessionId, shares: started.map((s) => this.toView(s)), skipped_receiver_ids: skipped, needs_grant_receiver_ids: needsGrant, server_now: now };
  }

  private shareExtendCall(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(ShareExtendRequestSchema, payload);
    if (isInvisible(this.db.users[uid])) fail('invisible_mode');
    const active = Object.values(this.db.shares).filter((s) => s.sender_id === uid && s.session_id === data.session_id && s.status === 'active');
    if (active.length === 0) fail('share_not_active');
    // Faz 8: uzatma da paylaşımdır; alıcı başına izin yeniden doğrulanır.
    const allowed = active.filter((s) => canShareLocation(this.pair(uid, s.receiver_id)));
    if (allowed.length === 0) fail('not_permitted');
    const extendable = allowed.filter((s) => canExtend(s, now));
    if (extendable.length === 0) {
      if (allowed.some((s) => s.expires_at !== null && s.expires_at <= now)) fail('already_expired');
      fail('invalid_duration', 'Süresiz paylaşım uzatılamaz');
    }
    for (const s of extendable) {
      const r = extendExpiry(s, data.minutes, now);
      s.share_mode = r.share_mode;
      s.expires_at = r.expires_at;
      s.version += 1;
      s.extended_count += 1;
      s.updated_at = now;
      this.mirrorAcl(s);
    }
    const first = extendable[0] as ShareRec;
    return {
      session_id: data.session_id,
      shares: extendable.map((s) => this.toView(s)),
      expires_at: Math.max(...extendable.map((s) => s.expires_at as number)),
      share_mode: first.share_mode,
      server_now: now,
    };
  }

  private shareStopCall(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(ShareStopRequestSchema, payload);
    const only = data.receiver_ids ? new Set(data.receiver_ids) : null;
    const targets = Object.values(this.db.shares).filter((s) => s.sender_id === uid && s.session_id === data.session_id && (!only || only.has(s.receiver_id)));
    for (const s of targets) {
      const reason: ShareEndReason = s.expires_at !== null && s.expires_at <= now ? 'expired' : 'stopped_by_sender';
      this.endShare(s, reason, now);
    }
    return { session_id: data.session_id, shares: targets.map((s) => this.toView(s)), server_now: now };
  }

  private shareRevokeCall(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(ShareRevokeRequestSchema, payload);
    if (data.sender_id === uid) fail('invalid_argument');
    const id = shareId(data.sender_id, uid);
    const s = this.db.shares[id];
    if (s) this.endShare(s, 'revoked_by_receiver', now);
    return { share_id: id, status: 'ended', server_now: now };
  }

  private friendRequestSend(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(FriendRequestSendSchema, payload);
    let target: UserRec | undefined;
    let label: string;
    if (data.via === 'invite_code') {
      const code = normalizeInviteCode(data.invite_code);
      if (!code) return fail('invalid_argument');
      label = formatInviteCode(code);
      const known = this.db.invites[code];
      // Demo: tanınmayan her geçerli kod yeni (sanal) bir kişiye aittir.
      target = known ? this.db.users[known] : this.createVirtualUser(code, now);
    } else {
      label = maskPhone(data.phone_e164);
      target = this.createVirtualUser(this.randomInviteCode(), now);
    }
    const response = { status: 'sent' as const, server_now: now };
    if (!target || target.uid === uid) return response;
    const fid = friendshipId(uid, target.uid);
    const existing = this.db.friendships[fid];
    if (existing?.status === 'pending' && existing.requested_by === target.uid) {
      // Karşılıklı istek: hemen kabul.
      this.acceptFriendship(existing, now);
      return response;
    }
    const oid = stableHex32(`${uid}|${data.via}|${data.via === 'invite_code' ? label : data.phone_e164}`);
    let friendship: string | null = null;
    if (!existing) {
      const f: FriendshipRec = {
        id: fid,
        member_ids: sortedPair(uid, target.uid),
        status: 'pending',
        requested_by: uid,
        via: data.via,
        member_profiles: { [uid]: this.pendingProfile(uid) },
        created_at: now,
        updated_at: now,
        target_id: target.uid,
        accepted_at: null,
      };
      this.db.friendships[fid] = f;
      friendship = fid;
    } else if (existing.status === 'pending' && existing.requested_by === uid) friendship = fid;
    (this.db.outgoing[uid] ??= {})[oid] = {
      id: oid,
      via: data.via,
      label,
      created_at: now,
      expires_at: now + OUTGOING_TTL_MS,
      friendship_id: friendship,
      auto_accept_at: friendship ? now + AUTO_ACCEPT_MS : null,
    };
    return response;
  }

  private friendRequestRespond(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(FriendRequestRespondSchema, payload);
    const f = this.db.friendships[data.friendship_id];
    if (!f || f.status !== 'pending' || f.target_id !== uid) return { friendship_id: data.friendship_id, status: data.accept ? 'accepted' : 'declined', server_now: now };
    if (data.accept) this.acceptFriendship(f, now);
    else {
      delete this.db.friendships[f.id];
      const list = this.db.outgoing[f.requested_by];
      if (list) for (const o of Object.values(list)) if (o.friendship_id === f.id) o.friendship_id = null;
    }
    return { friendship_id: f.id, status: data.accept ? 'accepted' : 'declined', server_now: now };
  }

  private friendRequestCancel(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(z.object({ op_id: z.uuid(), outgoing_id: z.string().regex(/^[0-9a-f]{32}$/) }), payload);
    const list = this.db.outgoing[uid];
    const o = list?.[data.outgoing_id];
    if (list && o) {
      delete list[o.id];
      const f = o.friendship_id ? this.db.friendships[o.friendship_id] : undefined;
      if (f && f.status === 'pending' && f.requested_by === uid) delete this.db.friendships[f.id];
    }
    return { outgoing_id: data.outgoing_id, status: 'cancelled', server_now: now };
  }

  private friendshipRemove(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(z.object({ op_id: z.uuid(), friendship_id: z.string().min(1).max(300) }), payload);
    const f = this.db.friendships[data.friendship_id];
    const response = { friendship_id: data.friendship_id, status: 'removed' as const, server_now: now };
    if (!f || !f.member_ids.includes(uid)) return response;
    const other = otherMember(f, uid);
    delete this.db.friendships[f.id];
    // Faz 4: iki tarafın acil kişi listesinden de çıkar.
    for (const [a, b] of [[uid, other], [other, uid]] as const) {
      const list = this.db.emergency[a];
      if (list) this.db.emergency[a] = list.filter((x) => x !== b);
      // Faz 6: iki tarafın favori listesinden de çıkar.
      const ua = this.db.users[a];
      if (ua) ua.favorite_ids = (ua.favorite_ids ?? []).filter((x) => x !== b);
      // Faz 5: iki tarafın bölge kurallarından karşı taraf çıkarılır (alıcısız kural silinir).
      this.dropZoneRecipient(a, b, now);
      // Faz 8: karşı taraf aktif SOS'un alıcılarından çıkar.
      this.pruneSosRecipients(a, (r) => r !== b, now);
    }
    for (const id of [shareId(uid, other), shareId(other, uid)]) {
      const s = this.db.shares[id];
      if (s) this.endShare(s, 'friendship_removed', now);
    }
    // Konum İste: iki yöndeki bekleyen istek iptal.
    for (const id of [locationRequestId(uid, other), locationRequestId(other, uid)]) {
      const r = this.db.loc_requests[id];
      if (r && r.status === 'pending') Object.assign(r, { status: 'cancelled', responded_at: now, updated_at: now });
    }
    // Faz 8: iki yöndeki izin belgeleri silinir.
    this.dropPairGrants(uid, other);
    // Faz 7: birinin sahibi, diğerinin davetlisi olduğu etkin etkinliklerden davetli çıkar.
    this.removePairFromEvents(uid, other, now);
    return response;
  }

  private inviteCodeRegenerate(uid: UserId, now: EpochMs) {
    const u = this.db.users[uid];
    if (!u) return fail('unauthenticated');
    delete this.db.invites[u.invite_code];
    u.invite_code = this.randomInviteCode();
    this.db.invites[u.invite_code] = uid;
    return { invite_code: u.invite_code, server_now: now };
  }

  // --- Faz 3: düşük pil bildirimi -----------------------------------------------------------------

  /** `battery_low_notify` (backend `handlers/battery.ts`): oturumun göndereni ve aktif paylaşımı olmalı. */
  private batteryLowNotify(payload: unknown, uid: UserId, now: EpochMs): BatteryLowNotifyResponse {
    const req = this.parse(BatteryLowNotifyRequestSchema, payload);
    const shares = Object.values(this.db.shares).filter(
      (s) => s.sender_id === uid && s.session_id === req.session_id && s.status === 'active' && (s.expires_at === null || s.expires_at > now),
    );
    if (shares.length === 0) fail('share_not_active');
    // Faz 7: pil paylaşımı kapalıysa (varsayılan) alıcıya düşük pil bildirimi GİTMEZ; tetikleyici durumu değişmez.
    if (!this.batteryShareOf(uid)) {
      return { status: 'suppressed', armed: this.db.battery_alerts[`${uid}_${req.session_id}`]?.state.armed ?? true, receivers: 0, server_now: now };
    }
    return this.applyBatteryAlert(uid, req.session_id, req.battery_pct, req.is_charging ?? false, shares, now);
  }

  /**
   * Sunucu aynı saf tetikleyiciyi (core `lowBatteryTrigger`) oturum durumuyla uygular: düşüş başına bir kez, 30 dk
   * tak-çıkar koruması, oturum başına 24 sa'te ≤ 6. Bildirim alıcı başına; metin core `lowBatteryPushText`.
   */
  private applyBatteryAlert(uid: UserId, sessionId: string, pct: number, charging: boolean, shares: ShareRec[], now: EpochMs): BatteryLowNotifyResponse {
    const key = `${uid}_${sessionId}`;
    const prev = this.db.battery_alerts[key] ?? null;
    const r = lowBatteryTrigger(prev?.state ?? null, pct, charging, now);
    const sent = (prev?.sent ?? []).filter((t) => t > now - DAY);
    let status: BatteryLowNotifyResponse['status'] = 'noop';
    let receivers = 0;
    if (r.fire) {
      if (sent.length >= 6) status = 'suppressed';
      else {
        status = 'notified';
        sent.push(now);
        const name = this.db.users[uid]?.display_name ?? '';
        const text = lowBatteryPushText(name, pct);
        const data: Extract<PushData, { type: 'battery_low' }> = { type: 'battery_low', share_id: '', battery_pct: String(Math.round(pct)) };
        for (const s of shares) {
          receivers++;
          this.push(s.receiver_id, { notification: text, data: { ...data, share_id: s.share_id } });
        }
        if (uid === DEMO_ME) {
          this.db.battery_notice = {
            at: now,
            pct: Math.round(pct),
            receivers: shares.map((s) => this.db.users[s.receiver_id]?.display_name ?? s.receiver_id),
            title: text.title,
            body: text.body,
          };
        }
      }
    } else if (prev && !prev.state.armed && r.state.armed) status = 'rearmed';
    else if (pct <= 15 && !charging) status = 'suppressed';
    this.db.battery_alerts[key] = { uid, session_id: sessionId, state: r.state, sent };
    return { status, armed: r.state.armed, receivers, server_now: now };
  }

  // --- Faz 4: ping, notlar, SOS -----------------------------------------------------------------

  /** Süpürücü (her saniye): süresi geçen ping / yer notu silinir, 24 sa'i aşan SOS `timeout`, bot "Gördüm"leri. */
  private sweepPhase4(now: EpochMs): boolean {
    let changed = false;
    for (const [to, inbox] of Object.entries(this.db.ping_inbox)) {
      for (const [id, p] of Object.entries(inbox)) {
        if (typeof p.expires_at === 'number' && p.expires_at <= now) {
          delete inbox[id];
          changed = true;
        }
      }
      if (Object.keys(inbox).length === 0) delete this.db.ping_inbox[to];
    }
    for (const n of Object.values(this.db.place_notes)) {
      if (n.expires_at <= now) {
        delete this.db.place_notes[n.note_id];
        changed = true;
      }
    }
    for (const a of Object.values(this.db.sos)) {
      if (a.status === 'active' && now - a.created_at > SOS_LIMITS.activeMaxMs) {
        this.resolveSos(a, 'timeout', now, false);
        changed = true;
      } else if (a.status === 'resolved' && a.resolved_at !== null && now - a.resolved_at > 2 * DAY) {
        delete this.db.sos[a.sos_id];
        changed = true;
      }
    }
    for (const [key, at] of Object.entries(this.db.sos_auto_ack)) {
      if (at > now) continue;
      delete this.db.sos_auto_ack[key];
      const [sosId, who] = key.split('|');
      const a = sosId ? this.db.sos[sosId] : undefined;
      if (a && who && a.status === 'active') this.ackSos(a, who, now);
      changed = true;
    }
    return changed;
  }

  private nameOf(uid: UserId): string {
    return this.db.users[uid]?.display_name || 'Arkadaşın';
  }

  private pingSendCall(payload: unknown, uid: UserId, now: EpochMs): PingSendResponse {
    const req = this.parse(PingSendRequestSchema, payload);
    return this.pingSendNow(uid, req, now);
  }

  /** Backend `ping_send`: arkadaşlık (sızdırmadan `not_friends`), soğuma, saatlik tavan, eski konum → null. */
  private pingSendNow(
    from: UserId,
    req: { to: UserId; kind: PingKind; location: { lat: number; lng: number; accuracy: number; timestamp: number } | null; eta_s: number | null },
    now: EpochMs,
  ): PingSendResponse {
    if (req.to === from || !this.areFriends(from, req.to)) fail('not_friends');
    // Faz 8: alıcının bana `ping` izni şart; konum yalnızca `location_view` (ben → o) varken ve görünürken.
    const access = this.pair(from, req.to);
    if (!canPing(access)) fail('not_permitted');
    const pairKey = `${from}_${req.to}`;
    const last = this.db.ping_pair[pairKey];
    if (last !== undefined && now - last < PING_LIMITS.perPairCooldownMs) fail('rate_limited');
    const hourKey = `${from}_${pingHourBucket(now)}`;
    const count = this.db.ping_hour[hourKey] ?? 0;
    if (count >= PING_LIMITS.perUserPerHour) fail('rate_limited');
    // "Yoldayım" ETA'sı da konumdan türer: konumla aynı koşulda (location_view ∧ görünür) kalır.
    const locationAllowed = pingLocationAllowed(access);
    const location = req.location && req.location.timestamp >= now - PING_LIMITS.maxLocationAgeMs && locationAllowed ? req.location : null;
    const etaS = locationAllowed && req.kind === 'on_way' ? req.eta_s : null;
    const ping_id = `p${randomHex32().slice(0, 19)}`;
    const expires_at = now + PING_LIMITS.ttlMs;
    // RTDB null saklamaz: boş alanlar yazılmaz (okuma tarafı null yapar).
    const rec: Record<string, unknown> = { ping_id, from, kind: req.kind, sent_at: now, expires_at };
    if (location) rec.location = location;
    if (etaS !== null) rec.eta_s = etaS;
    (this.db.ping_inbox[req.to] ??= {})[ping_id] = rec;
    this.db.ping_pair[pairKey] = now;
    this.db.ping_hour[hourKey] = count + 1;
    const data: Extract<PushData, { type: 'ping' }> = { type: 'ping', ping_id, from, kind: req.kind };
    this.push(req.to, { notification: pingPushText(this.nameOf(from), req.kind, etaS), data });
    return { ping_id, expires_at, server_now: now };
  }

  pingInboxOf(uid: UserId): Record<string, Record<string, unknown>> {
    return this.db.ping_inbox[uid] ?? {};
  }

  /** RTDB kuralı: yalnızca alıcı kendi kutusundan SİLER. */
  deletePing(uid: UserId, pingId: string, authUid: UserId | null): void {
    if (!authUid || authUid !== uid) throw new DemoPermissionDenied(`yazma izni yok: ping_inbox/${uid}/${pingId}`);
    const inbox = this.db.ping_inbox[uid];
    if (!inbox || !inbox[pingId]) return;
    delete inbox[pingId];
    this.commit();
  }

  private placeNoteUpsertCall(payload: unknown, uid: UserId, now: EpochMs): PlaceNoteUpsertResponse {
    const req = this.parse(PlaceNoteUpsertRequestSchema, payload);
    return { note: clone(this.upsertNote(uid, req, now)), server_now: now };
  }

  /** Backend `place_note_upsert`: metin temizlenir, `visible_to` yalnızca kabul edilmiş arkadaşlar (sessizce süzülür). */
  private upsertNote(
    owner: UserId,
    req: { note_id: string | null; emoji: string | null; text: string; position: { lat: number; lng: number; accuracy: number | null }; visible_to: UserId[]; duration_ms: number },
    now: EpochMs,
  ): PlaceNote {
    const text = sanitizeNoteText(req.text);
    if (!text) return fail('invalid_argument');
    const emoji = req.emoji ? sanitizeNoteText(req.emoji, NOTE_LIMITS.maxEmojiChars) : null;
    // Faz 8: yalnızca sahibin `location_view` izni verdiği arkadaşlar (diğerleri sessizce düşer).
    const visible_to = [...new Set(req.visible_to)]
      .filter((u) => u !== owner && this.areFriends(owner, u) && noteAudienceAllowed(this.pair(owner, u)))
      .slice(0, NOTE_LIMITS.maxAudience);
    const position = { lat: req.position.lat, lng: req.position.lng, accuracy: req.position.accuracy };
    if (req.note_id) {
      const cur = this.db.place_notes[req.note_id];
      if (!cur || cur.owner_id !== owner) return fail('note_not_found');
      const next: PlaceNote = { ...cur, emoji, text, position, visible_to, updated_at: now, expires_at: now + req.duration_ms };
      this.db.place_notes[cur.note_id] = next;
      return next;
    }
    const active = Object.values(this.db.place_notes).filter((n) => n.owner_id === owner && n.expires_at > now).length;
    if (active >= NOTE_LIMITS.maxActivePlaceNotes) fail('note_limit_reached');
    const note: PlaceNote = {
      note_id: `n${randomHex32().slice(0, 19)}`,
      owner_id: owner,
      emoji,
      text,
      position,
      visible_to,
      created_at: now,
      updated_at: now,
      expires_at: now + req.duration_ms,
    };
    this.db.place_notes[note.note_id] = note;
    return note;
  }

  private placeNoteDeleteCall(payload: unknown, uid: UserId, now: EpochMs): PlaceNoteDeleteResponse {
    const req = this.parse(PlaceNoteDeleteRequestSchema, payload);
    const n = this.db.place_notes[req.note_id];
    if (!n) return { note_id: req.note_id, deleted: false, server_now: now };
    if (n.owner_id !== uid) fail('note_not_found');
    delete this.db.place_notes[req.note_id];
    return { note_id: req.note_id, deleted: true, server_now: now };
  }

  /** Firestore `place_notes where owner_id == uid` ∪ `where visible_to array-contains uid` (TTL silmeden önce süresi geçen de gelir). */
  placeNotesFor(uid: UserId): PlaceNote[] {
    return Object.values(this.db.place_notes)
      .filter((n) => n.owner_id === uid || n.visible_to.includes(uid))
      .sort((a, b) => a.note_id.localeCompare(b.note_id));
  }

  private emergencyContactsSetCall(payload: unknown, uid: UserId, now: EpochMs) {
    const req = this.parse(EmergencyContactsSetRequestSchema, payload);
    const contact_ids = [...new Set(req.contact_ids)].filter((c) => c !== uid && this.areFriends(uid, c)).slice(0, SOS_LIMITS.maxContacts);
    // Faz 8: seçilen her kişiye `sos_alert` (`emergency_contact`), listeden çıkanlardan silinir.
    for (const old of this.db.emergency[uid] ?? []) if (!contact_ids.includes(old)) this.revokeScope(uid, old, 'sos_alert', now);
    for (const c of contact_ids) this.grantScope(uid, c, 'sos_alert', 'emergency_contact', now);
    this.db.emergency[uid] = contact_ids;
    // Aktif SOS: listeden çıkan kişi tam konumu okumayı hemen bırakır (yeni kişi sessizce eklenmez).
    this.pruneSosRecipients(uid, (r) => contact_ids.includes(r), now);
    return { contact_ids, server_now: now };
  }

  /** Backend `writeSosRecipientPrune`: gönderenin aktif SOS'larının alıcıları `keep` ile süzülür. */
  private pruneSosRecipients(sender: UserId, keep: (uid: UserId) => boolean, now: EpochMs): void {
    for (const a of Object.values(this.db.sos)) {
      if (a.sender_id !== sender || a.status !== 'active') continue;
      const next = a.recipient_ids.filter(keep);
      if (next.length !== a.recipient_ids.length) this.db.sos[a.sos_id] = { ...a, recipient_ids: next, updated_at: now };
    }
  }

  /**
   * Backend `sosAudience`: listedeki ve hâlâ arkadaş olan kişiler; Faz 8 öncesi listeden kalan (arkadaş ama
   * `sos_alert` izni yok) kişiye ilk kullanımda `via:'migration'` yazılır.
   */
  private sosAudience(uid: UserId, now: EpochMs, migrate: boolean): UserId[] {
    const out: UserId[] = [];
    for (const c of this.db.emergency[uid] ?? []) {
      if (c === uid || !this.areFriends(uid, c)) continue;
      const migratable = !hasGrant(this.grantOf(uid, c), 'sos_alert');
      // Göç izni yalnızca yazma adımında (`migrate`); okuma adımında göçe uygun kişi de alıcı sayılır.
      if (migratable && migrate) this.grantScope(uid, c, 'sos_alert', 'migration', now);
      if ((migratable && !migrate) || canSendSos(this.pair(uid, c))) out.push(c);
    }
    return out;
  }

  emergencyContactsOf(uid: UserId): UserId[] {
    return [...(this.db.emergency[uid] ?? [])];
  }

  /** Sunucu tarafı adres: geocode önbelleği → sahte Google (kota uygulanmaz); hata yutulur → null. */
  private sosAddress(loc: { lat: number; lng: number }, now: EpochMs): string | null {
    try {
      const cell = geocodeCell(loc);
      const hit = this.db.geocode_cache[cell];
      if (hit && hit.expire_at > now) return hit.label;
      if (this.db.maps_down) return null;
      const parsed = parseReverseGeocodeResponse(fakeReverseGeocode(geocodeQueryPoint(cell)));
      if (!parsed.ok) return null;
      this.db.geocode_cache[cell] = { label: parsed.label, created_at: now, expire_at: now + GEOCODE_POLICY.cacheTtlMs };
      return parsed.label;
    } catch {
      return null;
    }
  }

  private sosSendCall(payload: unknown, uid: UserId, now: EpochMs): SosSendResponse {
    const req = this.parse(SosSendRequestSchema, payload);
    return this.sosSendNow(uid, req, now, false);
  }

  /**
   * Backend `sos_send`: acil kişiler (arkadaşlığı geçerli olanlar) boşsa `no_emergency_contacts`; saatlik tavan;
   * aktif SOS varsa YENİSİ açılmaz, mevcut olan yeni konumla güncellenip tekrar push edilir (aynı sos_id).
   */
  private sosSendNow(
    uid: UserId,
    req: { location: SosLocation; battery_pct: number | null; is_charging: boolean | null; route: SosRoute | null; address: string | null },
    now: EpochMs,
    demoBypassLimit: boolean,
  ): SosSendResponse {
    // Faz 8: yalnızca `sos_alert` izni olan arkadaşlar (core `canSendSos`; eski liste için göç); görünmez mod SOS'u
    // engellemez.
    const recipients = this.sosAudience(uid, now, false);
    if (recipients.length === 0) fail('no_emergency_contacts');
    const hourKey = `${uid}_${sosHourBucket(now)}`;
    const count = this.db.sos_hour[hourKey] ?? 0;
    if (!demoBypassLimit && count >= SOS_LIMITS.maxSendsPerHour) fail('rate_limited');
    this.db.sos_hour[hourKey] = count + 1;
    this.sosAudience(uid, now, true);
    const address = req.address ?? this.sosAddress(req.location, now);
    const existing = Object.values(this.db.sos).find((a) => a.sender_id === uid && a.status === 'active');
    let alert: SosAlert;
    if (existing) {
      alert = {
        ...existing,
        recipient_ids: recipients,
        location: req.location,
        address,
        maps_url: sosMapsUrl(req.location.lat, req.location.lng),
        battery_pct: req.battery_pct,
        is_charging: req.is_charging,
        route: req.route,
        updated_at: now,
        update_count: existing.update_count + 1,
      };
    } else {
      alert = {
        sos_id: `s${randomHex32().slice(0, 19)}`,
        sender_id: uid,
        sender_name: this.nameOf(uid),
        recipient_ids: recipients,
        status: 'active',
        resolve_reason: null,
        message: SOS_MESSAGE,
        location: req.location,
        address,
        maps_url: sosMapsUrl(req.location.lat, req.location.lng),
        battery_pct: req.battery_pct,
        is_charging: req.is_charging,
        route: req.route,
        created_at: now,
        updated_at: now,
        resolved_at: null,
        acks: {},
        update_count: 0,
      };
    }
    this.db.sos[alert.sos_id] = alert;
    // Faz 8: görünmezken SOS gider ve görünmez mod GERİ YÜKLEMESİZ kapanır.
    const sender = this.db.users[uid];
    if (sender && isInvisible(sender)) {
      sender.invisible = null;
      sender.visible_since = now;
    }
    const text = sosPushText(alert);
    const data: Extract<PushData, { type: 'sos' }> = { type: 'sos', sos_id: alert.sos_id, sender_id: uid };
    for (const r of recipients) {
      this.push(r, { notification: text, data });
      // Demo: bot alıcı birkaç saniye sonra "Gördüm" der.
      if (r !== DEMO_ME && this.db.bots[r] && alert.acks[r] === undefined) this.db.sos_auto_ack[`${alert.sos_id}|${r}`] = now + randomBetween(4_000, 9_000);
    }
    return { sos: clone(alert), recipients: recipients.length, server_now: now };
  }

  /** Gönderen değilse / aktif değilse `sos_not_active` (başkasının SOS'unun varlığı sızmaz). */
  private ownActiveSos(uid: UserId, sosId: string): SosAlert {
    const a = this.db.sos[sosId];
    if (!a || a.sender_id !== uid || a.status !== 'active') return fail('sos_not_active');
    return a;
  }

  private sosUpdateCall(payload: unknown, uid: UserId, now: EpochMs): SosAlertResponse {
    const req = this.parse(SosUpdateRequestSchema, payload);
    const cur = this.ownActiveSos(uid, req.sos_id);
    // Faz 8: alıcılar geçerli kişilerle KESİŞİR (çıkan / engellenen / arkadaşlığı biten yeni konumu almaz).
    const valid = new Set(this.sosAudience(uid, now, false));
    const recipient_ids = cur.recipient_ids.filter((r) => valid.has(r));
    const a: SosAlert = recipient_ids.length === cur.recipient_ids.length ? cur : { ...cur, recipient_ids };
    this.db.sos[a.sos_id] = a;
    // Çok sık güncelleme: hata değil, mevcut belge döner.
    if (now - a.updated_at < SOS_LIMITS.updateMinIntervalMs) return { sos: clone(a), server_now: now };
    const next: SosAlert = {
      ...a,
      location: req.location,
      maps_url: sosMapsUrl(req.location.lat, req.location.lng),
      battery_pct: req.battery_pct,
      is_charging: req.is_charging,
      route: req.route,
      updated_at: now,
      update_count: a.update_count + 1,
    };
    this.db.sos[a.sos_id] = next;
    return { sos: clone(next), server_now: now };
  }

  private resolveSos(a: SosAlert, reason: SosAlert['resolve_reason'], now: EpochMs, notify: boolean): SosAlert {
    const next: SosAlert = { ...a, status: 'resolved', resolve_reason: reason, resolved_at: now, updated_at: now };
    this.db.sos[a.sos_id] = next;
    for (const k of Object.keys(this.db.sos_auto_ack)) if (k.startsWith(`${a.sos_id}|`)) delete this.db.sos_auto_ack[k];
    if (notify) {
      const data: Extract<PushData, { type: 'sos_resolved' }> = { type: 'sos_resolved', sos_id: a.sos_id, sender_id: a.sender_id };
      for (const r of a.recipient_ids) this.push(r, { notification: sosResolvedPushText(a.sender_name), data });
    }
    return next;
  }

  private sosResolveCall(payload: unknown, uid: UserId, now: EpochMs): SosAlertResponse {
    const req = this.parse(SosResolveRequestSchema, payload);
    const a = this.db.sos[req.sos_id];
    if (!a || a.sender_id !== uid) return fail('sos_not_active');
    if (a.status !== 'active') return { sos: clone(a), server_now: now };
    return { sos: clone(this.resolveSos(a, 'safe', now, true)), server_now: now };
  }

  /** İlk "Gördüm"de gönderene push. */
  private ackSos(a: SosAlert, uid: UserId, now: EpochMs): SosAlert {
    if (a.acks[uid] !== undefined) return a;
    const next: SosAlert = { ...a, acks: { ...a.acks, [uid]: now } };
    this.db.sos[a.sos_id] = next;
    const data: Extract<PushData, { type: 'sos_ack' }> = { type: 'sos_ack', sos_id: a.sos_id, by: uid };
    this.push(a.sender_id, { notification: sosAckPushText(this.nameOf(uid)), data });
    return next;
  }

  private sosAckCall(payload: unknown, uid: UserId, now: EpochMs): SosAlertResponse {
    const req = this.parse(SosAckRequestSchema, payload);
    const a = this.db.sos[req.sos_id];
    if (!a || !a.recipient_ids.includes(uid)) return fail('sos_not_active');
    return { sos: clone(this.ackSos(a, uid, now)), server_now: now };
  }

  /** Firestore `sos_alerts where sender_id == uid` / `where recipient_ids array-contains uid`. */
  sosAlertsWhere(field: 'sender_id' | 'recipient_ids', uid: UserId): SosAlert[] {
    return Object.values(this.db.sos)
      .filter((a) => (field === 'sender_id' ? a.sender_id === uid : a.recipient_ids.includes(uid)))
      .sort((a, b) => a.created_at - b.created_at);
  }

  // --- Faz 5: bölgeler (geofence) ve buluşma noktası ------------------------------------------------

  /** Süpürücü: süresi geçen buluşma önerileri (1 gün sonra), önbellek, eski bölge olayları ve soğumalar. */
  private sweepPhase5(now: EpochMs): boolean {
    let changed = false;
    for (const m of Object.values(this.db.meetups)) {
      if (m.expires_at + DAY <= now) {
        delete this.db.meetups[m.meetup_id];
        changed = true;
      }
    }
    for (const [k, c] of Object.entries(this.db.meetup_cache)) {
      if (c.expire_at <= now) {
        delete this.db.meetup_cache[k];
        changed = true;
      }
    }
    for (const [uid, list] of Object.entries(this.db.zone_events)) {
      const kept = list.filter((e) => e.purge_at > now);
      if (kept.length !== list.length) {
        this.db.zone_events[uid] = kept;
        changed = true;
      }
    }
    for (const [k, at] of Object.entries(this.db.zone_cooldowns)) {
      if (now - at > DAY) {
        delete this.db.zone_cooldowns[k];
        changed = true;
      }
    }
    for (const [key, at] of Object.entries(this.db.meetup_auto)) {
      if (at > now) continue;
      delete this.db.meetup_auto[key];
      const [id, who] = key.split('|');
      const m = id ? this.db.meetups[id] : undefined;
      if (m && who && m.to.includes(who) && isMeetupActive(m, now) && !m.responses[who]) {
        m.responses = { ...m.responses, [who]: 'accepted' };
        const data: Extract<PushData, { type: 'meetup_response' }> = { type: 'meetup_response', meetup_id: m.meetup_id, by: who, response: 'accepted' };
        this.push(m.from, { notification: meetupResponsePushText(this.nameOf(who), 'accepted', m.place), data });
      }
      changed = true;
    }
    return changed;
  }

  /** Arkadaşlık bitti: `owner`'ın kurallarından `other` çıkar; alıcısı kalmayan kural silinir. */
  private dropZoneRecipient(owner: UserId, other: UserId, now: EpochMs): void {
    for (const z of Object.values(this.db.zones[owner] ?? {})) {
      if (!z.rules.some((r) => r.recipient_ids.includes(other))) continue;
      z.rules = z.rules.map((r) => ({ ...r, recipient_ids: r.recipient_ids.filter((u) => u !== other) })).filter((r) => r.recipient_ids.length > 0);
      z.updated_at = now;
    }
  }

  zonesOf(uid: UserId): Zone[] {
    return Object.values(this.db.zones[uid] ?? {}).sort((a, b) => a.created_at - b.created_at);
  }

  zoneEventsOf(uid: UserId, max: number): ZoneEventLog[] {
    return (this.db.zone_events[uid] ?? []).slice(0, max).map(({ id: _id, purge_at: _p, ...e }) => e);
  }

  /** Firestore `meetups where from == uid` / `where to array-contains uid`. */
  meetupsWhere(field: 'from' | 'to', uid: UserId): Meetup[] {
    return Object.values(this.db.meetups)
      .filter((m) => (field === 'from' ? m.from === uid : m.to.includes(uid)))
      .sort((a, b) => b.created_at - a.created_at);
  }

  private zoneUpsertCall(payload: unknown, uid: UserId, now: EpochMs): ZoneUpsertResponse {
    const req = this.parse(ZoneUpsertRequestSchema, payload);
    return this.upsertZone(uid, req, now);
  }

  private upsertZone(uid: UserId, req: z.output<typeof ZoneUpsertRequestSchema>, now: EpochMs): ZoneUpsertResponse {
    const name = sanitizeNoteText(req.name, ZONE_LIMITS.nameMaxChars);
    if (!name) return fail('invalid_argument');
    const mine = (this.db.zones[uid] ??= {});
    const existing = req.zone_id ? mine[req.zone_id] : undefined;
    if (req.zone_id && !existing) return fail('zone_not_found');
    if (!existing && Object.keys(mine).length >= ZONE_LIMITS.maxZones) return fail('zone_limit_reached');
    const dropped = new Set<UserId>();
    const rules: ZoneRule[] = [];
    for (const r of req.rules) {
      // Faz 8: bildirim alıcısı bana `zone_notify` vermiş olmalı; paylaşım alıcısına benim `location_view` iznim
      // olmalı (kayıtta görünmezlik denetlenmez: kural ileride çalışır).
      const kept = [...new Set(r.recipient_ids)].filter((u) => {
        const access = { ...this.pair(uid, u), invisibleX: false };
        const ok = u !== uid && (r.action === 'notify' ? canZoneNotify(access) : canShareLocation(access));
        if (!ok) dropped.add(u);
        return ok;
      });
      // Alıcısı kalmayan kural silinir.
      if (kept.length > 0) rules.push({ ...r, recipient_ids: kept });
    }
    const zone: Zone = {
      zone_id: existing?.zone_id ?? `z${randomHex32().slice(0, 19)}`,
      owner_id: uid,
      kind: req.kind,
      name,
      emoji: req.emoji ? sanitizeNoteText(req.emoji, 8) : null,
      center: { lat: Math.round(req.center.lat * 1e6) / 1e6, lng: Math.round(req.center.lng * 1e6) / 1e6 },
      radius_m: Math.round(req.radius_m),
      rules,
      enabled: req.enabled,
      time_zone: req.time_zone,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    mine[zone.zone_id] = zone;
    return { zone, dropped_recipient_ids: [...dropped], server_now: now };
  }

  private zoneDeleteCall(payload: unknown, uid: UserId, now: EpochMs): ZoneDeleteResponse {
    const req = this.parse(ZoneDeleteRequestSchema, payload);
    const mine = this.db.zones[uid] ?? {};
    const deleted = !!mine[req.zone_id];
    delete mine[req.zone_id];
    for (const t of ['arrive', 'leave']) delete this.db.zone_cooldowns[`${uid}_${req.zone_id}_${t}`];
    return { zone_id: req.zone_id, deleted, server_now: now };
  }

  private zoneEventReportCall(payload: unknown, uid: UserId, now: EpochMs): ZoneEventReportResponse {
    const req = this.parse(ZoneEventReportRequestSchema, payload);
    return this.zoneEventNow(uid, req.zone_id, req.transition, req.occurred_at, now);
  }

  /** Backend `zone_event_report` (koordinat almaz, push'a ve loga koordinat girmez). */
  private zoneEventNow(uid: UserId, zoneId: string, transition: ZoneTrigger, occurredAt: EpochMs, now: EpochMs): ZoneEventReportResponse {
    const zone = this.db.zones[uid]?.[zoneId];
    if (!zone) return fail('zone_not_found');
    const occurred = occurredAt > now + MINUTE ? now : occurredAt;
    const respond = (r: Omit<ZoneEventReportResponse, 'server_now'>): ZoneEventReportResponse => {
      const list = (this.db.zone_events[uid] ??= []);
      list.unshift({ id: randomHex32().slice(0, 20), zone_id: zoneId, transition, occurred_at: occurred, notified: r.notified, suppressed: r.suppressed, purge_at: now + ZONE_EVENT_LOG_TTL_MS });
      if (list.length > 200) list.length = 200;
      return { ...r, server_now: now };
    };
    // Faz 8: görünmezken (ya da görünmezken olmuş) hiçbir olay bildirilmez / paylaşım açmaz.
    const visibleSince = this.db.users[uid]?.visible_since;
    if (isInvisible(this.db.users[uid]) || (typeof visibleSince === 'number' && occurred < visibleSince)) {
      return respond({ notified: 0, start_share: [], suppressed: 'invisible' });
    }
    if (now - occurred > ZONE_LIMITS.maxEventAgeMs) return respond({ notified: 0, start_share: [], suppressed: 'stale' });
    if (!zone.enabled) return respond({ notified: 0, start_share: [], suppressed: 'disabled' });
    const offsetMin = offsetFnForTimeZone(zone.time_zone)(occurred);
    const rules = matchZoneRules(zone, transition, localClock(occurred, offsetMin));
    if (rules.length === 0) return respond({ notified: 0, start_share: [], suppressed: 'outside_window' });
    const start_share = rules
      .filter((r) => r.action === 'start_share' && r.share_duration)
      .map((r) => ({
        rule_id: r.rule_id,
        recipient_ids: r.recipient_ids.filter((u) => canShareLocation(this.pair(uid, u))),
        duration: r.share_duration as DurationChoice,
      }))
      .filter((r) => r.recipient_ids.length > 0);
    const notifyTo = [...new Set(rules.filter((r) => r.action === 'notify').flatMap((r) => r.recipient_ids))].filter((u) => canZoneNotify(this.pair(uid, u)));
    if (notifyTo.length === 0) return respond({ notified: 0, start_share, suppressed: null });
    const cdKey = `${uid}_${zoneId}_${transition}`;
    const last = this.db.zone_cooldowns[cdKey];
    if (last !== undefined && now - last < ZONE_LIMITS.serverCooldownMs) return respond({ notified: 0, start_share, suppressed: 'cooldown' });
    const dayKey = `${uid}_${quotaDay(now)}`;
    const today = this.db.zone_daily[dayKey] ?? 0;
    if (today >= ZONE_LIMITS.maxEventsPerDay) return respond({ notified: 0, start_share, suppressed: 'daily_limit' });
    const text = zoneEventPushText(this.nameOf(uid), zone.name, transition);
    const data: Extract<PushData, { type: 'zone_event' }> = { type: 'zone_event', from: uid, zone_name: zone.name, transition };
    for (const to of notifyTo) this.push(to, { notification: text, data });
    this.db.zone_cooldowns[cdKey] = now;
    this.db.zone_daily[dayKey] = today + 1;
    return respond({ notified: notifyTo.length, start_share, suppressed: null });
  }

  private midpointSuggestion(center: LatLng, participants: readonly MeetupParticipant[]): MeetupSuggestion {
    const etas: MeetupEta[] = participants.map((p) => ({ key: p.key, ...fallbackEta(p.position, center, p.mode), estimated: true }));
    return {
      place: { place_id: null, name: 'Orta nokta', address: null, location: center, primary_type: null, category: 'midpoint' },
      etas,
      ...meetupScore(etas),
    };
  }

  private meetupSuggestCall(payload: unknown, uid: UserId, now: EpochMs): MeetupSuggestResponse {
    const req = this.parse(MeetupSuggestRequestSchema, payload);
    const keys = req.participants.map((p) => p.key);
    if (new Set(keys).size !== keys.length || !keys.includes('me')) return fail('invalid_argument');
    return this.suggestMeetup(uid, req.participants, req.category, now);
  }

  /** Backend `meetup_suggest` (SPEC sırası: yedekler → önbellek → kota → anahtar → Places → matris → sıralama). */
  private suggestMeetup(uid: UserId, participants: readonly MeetupParticipant[], category: MeetupCategory, now: EpochMs): MeetupSuggestResponse {
    const points = participants.map((p) => p.position);
    const center = meetupCenter(points);
    const spread = meetupSpreadM(center, points);
    const radius = searchRadiusM(spread);
    const out = (suggestions: MeetupSuggestion[], fallback: MeetupSuggestResponse['fallback'], cached = false): MeetupSuggestResponse => ({
      center,
      search_radius_m: radius,
      suggestions,
      fallback,
      cached,
      server_now: now,
    });
    const midpoint = () => [this.midpointSuggestion(center, participants)];
    if (spread * 2 < MEETUP_LIMITS.tooCloseM) return out(midpoint(), 'too_close');
    if (spread > MEETUP_LIMITS.maxSpreadM) return out([], 'too_far');
    // Backend `meetupCacheDocId` gibi: önbellek kullanıcıya ve katılımcı ANAHTARLARINA özel. Yanıttaki ETA anahtarları
    // çağırana göredir ('me'); aynı hücrelerdeki başka bir çağıranın (ör. bot) isteği bu kaydı kullanmamalı.
    const keyed = participants.map((p) => `${p.key}@${geohashEncode(p.position.lat, p.position.lng, 6)}:${p.mode}`).sort();
    const key = `${uid}|${meetupCacheKey(center, category, participants)}|${keyed.join(',')}`;
    const hit = this.db.meetup_cache[key];
    const q = this.quota(uid, now);
    if (hit && hit.expire_at > now) {
      q.meetup_hits = (q.meetup_hits ?? 0) + 1;
      return { ...clone(hit.response), cached: true, server_now: now };
    }
    if ((q.meetup ?? 0) >= MEETUP_LIMITS.perUserDailyLimit) return out(midpoint(), 'quota_exceeded');
    if (this.db.maps_down) return out(midpoint(), 'places_unavailable');
    q.meetup = (q.meetup ?? 0) + 1;
    const placesRes = fakePlacesNearby(placesNearbyRequestBody(center, radius, category));
    if (placesRes.status !== 200) return out(midpoint(), 'places_unavailable');
    const places = parsePlacesNearbyResponse(placesRes.json, category);
    if (places.length === 0) return out(midpoint(), 'no_results');
    const top = nearestCandidates(places, center);
    // Mod başına tek matris (aynı moddaki katılımcılar kaynak, adaylar hedef).
    const cells = new Map<string, { duration_s: number; distance_m: number } | null>();
    const modes = [...new Set(participants.map((p) => p.mode))] as TravelMode[];
    for (const mode of modes) {
      const origins = participants.filter((p) => p.mode === mode);
      const r = fakeRouteMatrix(routeMatrixRequestBody(origins.map((p) => p.position), top.map((t) => t.location), mode));
      const grid = r.status === 200 ? parseRouteMatrixResponse(r.json, origins.length, top.length) : [];
      origins.forEach((p, oi) => top.forEach((_t, di) => cells.set(`${p.key}|${di}`, grid[oi]?.[di] ?? null)));
    }
    const candidates = top.map((place, di) => ({
      place,
      etas: participants.map((p): MeetupEta => {
        const c = cells.get(`${p.key}|${di}`);
        return c ? { key: p.key, duration_s: c.duration_s, distance_m: c.distance_m, estimated: false } : { key: p.key, ...fallbackEta(p.position, place.location, p.mode), estimated: true };
      }),
    }));
    const res = out(rankMeetupCandidates(candidates, participants.map((p) => p.key), center), null);
    this.db.meetup_cache[key] = { response: clone(res), expire_at: now + MEETUP_LIMITS.cacheTtlMs };
    return res;
  }

  private meetupShareCall(payload: unknown, uid: UserId, now: EpochMs): MeetupResponse {
    const req = this.parse(MeetupShareRequestSchema, payload);
    return { meetup: this.shareMeetup(uid, req, now), server_now: now };
  }

  /** Backend `meetup_share`: alıcılar kabul edilmiş arkadaş (değilse sessizce düşer), 'me' → gönderenin uid'i. */
  private shareMeetup(uid: UserId, req: z.output<typeof MeetupShareRequestSchema>, now: EpochMs): Meetup {
    const candidates = [...new Set(req.to)].filter((u) => u !== uid && this.areFriends(uid, u));
    // Faz 8: alıcı bana `meetup_invite` vermiş olmalı (arkadaş ama izinsizse `not_permitted`).
    const to = candidates.filter((u) => canInvite(this.pair(uid, u)));
    if (to.length === 0) return fail(candidates.length > 0 ? 'not_permitted' : 'not_friends');
    // ETA konumdan türer: yalnızca BENİM ETA'm kalır ve o da yalnızca TÜM alıcılara `location_view` iznim varsa ve
    // görünürsem. Başka katılımcının ETA'sı hiç saklanmaz (backend ile aynı): kalıp kalmaması onun görünmezliğini ya da
    // izinlerini öneren kişiye sızdırırdı.
    const myEtaOk = to.every((y) => meetupEtaAllowed(this.pair(uid, y)));
    const etaKept = (key: UserId): boolean => key === uid && myEtaOk;
    const m: Meetup = {
      meetup_id: `m${randomHex32().slice(0, 19)}`,
      from: uid,
      from_name: this.nameOf(uid),
      to,
      place: req.place,
      etas: req.etas.map((e) => ({ ...e, key: e.key === 'me' ? uid : e.key })).filter((e) => etaKept(e.key)),
      meet_at: req.meet_at,
      note: req.note ? sanitizeNoteText(req.note, 120) : null,
      responses: {},
      status: 'active',
      created_at: now,
      expires_at: now + MEETUP_LIMITS.shareTtlMs,
    };
    this.db.meetups[m.meetup_id] = m;
    const data: Extract<PushData, { type: 'meetup' }> = { type: 'meetup', meetup_id: m.meetup_id, from: uid };
    for (const r of to) {
      this.push(r, { notification: meetupPushText(m.from_name, m.place), data });
      // Demo: bot alıcılar birkaç saniye sonra "Geliyorum" der.
      if (this.db.bots[r]) this.db.meetup_auto[`${m.meetup_id}|${r}`] = now + 6 * SECOND;
    }
    return m;
  }

  private meetupRespondCall(payload: unknown, uid: UserId, now: EpochMs): MeetupResponse {
    const req = this.parse(MeetupRespondRequestSchema, payload);
    const m = this.db.meetups[req.meetup_id];
    if (!m || !m.to.includes(uid) || !isMeetupActive(m, now)) return fail('meetup_not_found');
    m.responses = { ...m.responses, [uid]: req.response };
    const data: Extract<PushData, { type: 'meetup_response' }> = { type: 'meetup_response', meetup_id: m.meetup_id, by: uid, response: req.response };
    this.push(m.from, { notification: meetupResponsePushText(this.nameOf(uid), req.response, m.place), data });
    return { meetup: m, server_now: now };
  }

  private meetupCancelCall(payload: unknown, uid: UserId, now: EpochMs): MeetupResponse {
    const req = this.parse(MeetupCancelRequestSchema, payload);
    const m = this.db.meetups[req.meetup_id];
    if (!m || m.from !== uid) return fail('meetup_not_found');
    // [Varsayım] Alıcılara push yok; kart dinleyiciyle kapanır.
    m.status = 'cancelled';
    return { meetup: m, server_now: now };
  }

  // --- Faz 6: favoriler, widget token'ları, tek tuşla paylaşım, avatar Storage ------------------------

  /** Faz 8: favori = tek tuşla paylaşım hedefi → yalnızca `location_view` izni verdiğim kabul edilmiş arkadaşlar. */
  private acceptedFriendIds(uid: UserId): Set<UserId> {
    const out = new Set<UserId>();
    for (const f of Object.values(this.db.friendships)) {
      if (f.status !== 'accepted' || !f.member_ids.includes(uid)) continue;
      const other = otherMember(f, uid);
      if (hasGrant(this.grantOf(uid, other), 'location_view')) out.add(other);
    }
    return out;
  }

  /** `favorites_set`: tüm liste; kabul edilmiş arkadaş olmayanlar SESSİZCE düşer (core `sanitizeFavorites`). */
  private favoritesSetCall(payload: unknown, uid: UserId, _now: EpochMs): FavoritesSetResponse {
    const req = this.parse(FavoritesSetRequestSchema, payload);
    const u = this.db.users[uid];
    if (!u) return fail('unauthenticated');
    u.favorite_ids = sanitizeFavorites(req.favorite_ids, this.acceptedFriendIds(uid));
    return { favorite_ids: [...u.favorite_ids] };
  }

  private newWidgetToken(): string {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (!c?.getRandomValues) return fail('internal', 'Güvenli rastgele sayı üreteci yok');
    return generateWidgetToken((n) => c.getRandomValues!(new Uint8Array(n)));
  }

  /**
   * `widget_token_issue` (oturum): aynı cihazın eski token'ları + 5 aktif cihaz sınırını aşan en eskiler iptal, yeni
   * token (30 gün). Düz token yalnızca yanıtta; sunucuda `widgetTokenHash(token)` anahtarı. Günde en çok 20 üretim.
   */
  private widgetTokenIssueCall(payload: unknown, uid: UserId, now: EpochMs): WidgetTokenIssueResponse {
    const req = this.parse(WidgetTokenIssueRequestSchema, payload);
    if (!this.db.users[uid]) return fail('unauthenticated');
    const dayKey = `${uid}_${quotaDay(now)}`;
    const issued = this.db.widget_issue[dayKey] ?? 0;
    if (issued >= WIDGET_TOKEN_ISSUE_PER_DAY) fail('rate_limited');
    const live = Object.values(this.db.widget_tokens).filter((t) => t.uid === uid && !t.revoked && t.expires_at > now);
    const same = live.filter((t) => t.device_id === req.device_id);
    const others = live.filter((t) => t.device_id !== req.device_id).sort((a, b) => b.created_at - a.created_at);
    for (const t of [...same, ...others.slice(Math.max(0, WIDGET_TOKEN_MAX_ACTIVE - 1))]) {
      t.revoked = true;
      t.revoked_at = now;
    }
    const token = this.newWidgetToken();
    const expires_at = now + QUICK_SHARE_LIMITS.tokenTtlMs;
    this.db.widget_tokens[widgetTokenHash(token)] = {
      uid,
      device_id: req.device_id,
      created_at: now,
      expires_at,
      last_used_at: null,
      uses: { window_start: now, count: 0 },
      revoked: false,
      revoked_at: null,
    };
    this.db.widget_issue[dayKey] = issued + 1;
    return { token, expires_at, endpoint_path: WIDGET_QUICK_SHARE_ENDPOINT };
  }

  /** `widget_token_revoke` (oturum): `device_id` ya da `null` = tüm cihazlar (çıkış). */
  private widgetTokenRevokeCall(payload: unknown, uid: UserId, now: EpochMs): WidgetTokenRevokeResponse {
    const req = this.parse(WidgetTokenRevokeRequestSchema, payload);
    let revoked = 0;
    for (const t of Object.values(this.db.widget_tokens)) {
      if (t.uid !== uid || t.revoked || (req.device_id !== null && t.device_id !== req.device_id)) continue;
      t.revoked = true;
      t.revoked_at = now;
      revoked++;
    }
    return { revoked };
  }

  /**
   * `widget_quick_share` (OTURUMSUZ; yetki = token). Sıra backend ile aynı: token yok / iptal → `token_invalid`;
   * süresi dolmuş → `token_expired`; profil yok → `token_invalid`; hedef favori değil (ya da kendisi) →
   * `not_favorite`; kabul edilmiş arkadaş değil → `not_friend`; token başına saatte 6 BAŞARILI çağrı →
   * `rate_limited`. Karar core `quickShareExpiry`; yeni paylaşım `share_start` ile aynı iç fonksiyondan
   * (`startShare`). Sonra gönderene sessiz `resume_tracking` + görünür `quick_share_started`.
   */
  private widgetQuickShareCall(payload: unknown, now: EpochMs): WidgetQuickShareResponse {
    const req = this.parse(WidgetQuickShareRequestSchema, payload);
    const hash = widgetTokenHash(req.token);
    const tok = this.db.widget_tokens[hash];
    if (!tok || tok.revoked) return fail('token_invalid');
    if (tok.expires_at <= now) return fail('token_expired');
    const opKey = `${hash}:${req.op_id}`;
    const replay = this.db.widget_ops[opKey];
    if (replay) return clone(replay.response);
    const owner = tok.uid;
    const user = this.db.users[owner];
    if (!user) return fail('token_invalid');
    // Faz 8 (backend sırası): onay → görünmez değil → favori → arkadaş → `location_view` izni.
    if (consentRequired(user.consent)) fail('consent_required');
    if (isInvisible(user)) fail('invisible_mode');
    const to = req.to_uid;
    if (to === owner || !(user.favorite_ids ?? []).includes(to)) fail('not_favorite');
    if (!this.areFriends(owner, to)) fail('not_friend');
    if (!canShareLocation(this.pair(owner, to))) fail('not_permitted');
    const uses = now - tok.uses.window_start < HOUR ? { ...tok.uses } : { window_start: now, count: 0 };
    if (uses.count >= QUICK_SHARE_LIMITS.perTokenPerHour) {
      fail('rate_limited', `Tekrar denemek için ${Math.ceil((uses.window_start + HOUR - now) / MINUTE)} dk`);
    }
    const id = shareId(owner, to);
    const current = this.db.shares[id] ?? null;
    const decision = quickShareExpiry(current, now);

    // --- yazmalar ---
    tok.uses = { window_start: uses.window_start, count: uses.count + 1 };
    tok.last_used_at = now;
    let share: ShareRec;
    if (decision.status === 'started') {
      share = this.startShare(owner, to, uuidV4(), decision.share_mode, decision.expires_at, now);
    } else {
      share = current as ShareRec;
      if (decision.status === 'extended') {
        share.share_mode = decision.share_mode;
        share.expires_at = decision.expires_at;
        share.version += 1;
        share.extended_count += 1;
        share.updated_at = now;
        this.mirrorAcl(share);
      }
    }
    const toName = (this.db.friendships[friendshipId(owner, to)]?.member_profiles[to]?.display_name || this.nameOf(to)).slice(0, 80);
    const res: WidgetQuickShareResponse = { status: decision.status, share_id: share.share_id, expires_at: share.expires_at, to_name: toName };
    this.db.widget_ops[opKey] = { at: now, response: clone(res) };
    const wake: Extract<PushData, { type: 'resume_tracking' }> = { type: 'resume_tracking', session_ids: share.session_id, level: '1' };
    this.push(owner, { data: wake });
    const visible: Extract<PushData, { type: 'quick_share_started' }> = {
      type: 'quick_share_started',
      share_id: share.share_id,
      to_name: toName,
      expires_at: share.expires_at === null ? '' : String(share.expires_at),
    };
    this.push(owner, { notification: quickSharePushText(toName, decision.status), data: visible });
    return res;
  }

  /** Süpürücü (dakikada bir): 1 günden eski op kayıtları, iptal / süresi dolmuş token'lar (backend TTL `purge_at`). */
  private prunePhase6(now: EpochMs): boolean {
    let changed = false;
    for (const [k, op] of Object.entries(this.db.widget_ops)) {
      if (op.at < now - DAY) {
        delete this.db.widget_ops[k];
        changed = true;
      }
    }
    for (const [k, t] of Object.entries(this.db.widget_tokens)) {
      const deadAt = t.revoked ? (t.revoked_at ?? now) : t.expires_at;
      if (deadAt + DAY < now) {
        delete this.db.widget_tokens[k];
        changed = true;
      }
    }
    const today = quotaDay(now);
    for (const k of Object.keys(this.db.widget_issue)) {
      if (!k.endsWith(`_${today}`)) {
        delete this.db.widget_issue[k];
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Sahte Storage yüklemesi (RNFB `ref(path).putFile` / `putString` karşılığı): `storage.rules` uygulanır, dönen
   * indirme adresi üretim biçimidir. `source`: base64 JPEG veri adresi ya da `blob:` adresi (web görüntü
   * düzenleyicisinin çıktısı). Kural reddi `DemoStorageError` (`storage/unauthorized`).
   */
  async storageUpload(path: string, source: string, contentType: string, authUid: UserId | null): Promise<{ download_url: string; size: number }> {
    await new Promise((r) => setTimeout(r, randomBetween(250, 700)));
    const dataUrl = await uriToDataUrl(source);
    return this.avatars.put(path, dataUrl, contentType, authUid, Date.now(), uuidV4());
  }

  /**
   * Uygulamanın web yükleyicisinin (`services/profile/avatarUpload.web.ts`) beklediği kısa yol: oturumdaki demo
   * kullanıcısı adına `storageUpload` (kurallar aynı). Dönen: indirme adresi.
   */
  async putAvatarObject(path: string, dataUri: string): Promise<string> {
    return (await this.storageUpload(path, dataUri, 'image/jpeg', demoCurrentUid())).download_url;
  }

  /** Sahte Storage silme (yalnızca sahibi). Nesne yoksa sessizce geçer. */
  async storageDelete(path: string, authUid: UserId | null): Promise<void> {
    await new Promise((r) => setTimeout(r, randomBetween(80, 200)));
    if (!authUid) throw new DemoStorageError('storage/unauthenticated');
    this.avatars.remove(path, authUid);
  }

  /** Saklanan Storage adresi → tarayıcının gösterebileceği yerel adres (yoksa null). */
  resolveAvatarUrl(url: string | null | undefined): string | null {
    return this.avatars.resolve(url);
  }

  /** Demo paneli / test: Storage'da nesne var mı. */
  storageHas(path: string): boolean {
    return this.avatars.has(path);
  }

  /**
   * Widget önizlemesinin ham kaynağı (demo paneli `buildWidgetSnapshot` girdisini bundan kurar): profil, favoriler,
   * arkadaşlar (cinsiyet, yerel küçük avatar, bana paylaşımı + son paketi), giden paylaşımlarım, token'larım.
   */
  widgetSource(uid: UserId): DemoWidgetSource {
    const now = Date.now();
    const u = this.db.users[uid];
    const friends: DemoWidgetSource['friends'] = [];
    for (const f of Object.values(this.db.friendships)) {
      if (f.status !== 'accepted' || !f.member_ids.includes(uid)) continue;
      const other = otherMember(f, uid);
      const p = this.resolvedProfile(f.member_profiles[other] ?? this.publicProfile(other));
      const inc = this.db.shares[shareId(other, uid)];
      const active = !!inc && inc.status === 'active' && (inc.expires_at === null || inc.expires_at > now);
      const live = active && inc ? this.db.live[uid]?.[inc.share_id] : undefined;
      friends.push({
        uid: other,
        display_name: p.display_name || this.nameOf(other),
        gender: p.gender,
        avatar_thumb_url: p.avatar_thumb_url,
        avatar_version: this.db.users[other]?.avatar_version ?? null,
        incoming: active
          ? {
              active: true,
              last_seen_at: typeof live?.timestamp === 'number' ? live.timestamp : null,
              battery_pct: typeof live?.battery_pct === 'number' ? live.battery_pct : null,
              position: typeof live?.lat === 'number' && typeof live?.lng === 'number' ? { lat: live.lat, lng: live.lng } : null,
            }
          : null,
      });
    }
    return {
      profile: u ? { display_name: u.display_name, gender: u.gender ?? null } : null,
      favorite_ids: [...(u?.favorite_ids ?? [])],
      friends: friends.sort((a, b) => a.display_name.localeCompare(b.display_name, 'tr')),
      outgoing: Object.values(this.db.shares)
        .filter((s) => s.sender_id === uid)
        .map((s) => ({ receiver_id: s.receiver_id, status: s.status, expires_at: s.expires_at })),
      tokens: Object.values(this.db.widget_tokens)
        .filter((t) => t.uid === uid)
        .map((t) => ({ device_id: t.device_id, expires_at: t.expires_at, revoked: t.revoked, uses: { ...t.uses } })),
    };
  }

  /** Widget yer etiketi: hücre önbelleği ya da sahte Google (kota dışı, sunucu içi); ilk virgüle kadar kısa adres. */
  placeLabelAt(p: LatLng): string | null {
    const cell = geocodeCell(p);
    const hit = this.db.geocode_cache[cell];
    let label: string | null;
    if (hit) label = hit.label;
    else {
      const parsed = parseReverseGeocodeResponse(fakeReverseGeocode(geocodeQueryPoint(cell)));
      label = parsed.ok ? parsed.label : null;
    }
    return label ? (label.split(',')[0]?.trim() || null) : null;
  }

  /** Demo paneli "Widget oturumu sunucuda dolsun": token'larımın süresi sunucuda dolar (istemci bilmez). */
  expireWidgetTokens(uid: UserId, deviceId: string | null): number {
    const now = Date.now();
    let n = 0;
    for (const t of Object.values(this.db.widget_tokens)) {
      if (t.uid !== uid || t.revoked || t.expires_at <= now || (deviceId !== null && t.device_id !== deviceId)) continue;
      t.expires_at = now - 1;
      n++;
    }
    if (n) this.commit();
    return n;
  }

  /** Demo paneli "Hız sınırı dolsun": token'larımın bu saatlik penceresi 6/6 olur. */
  exhaustWidgetTokens(uid: UserId, deviceId: string | null): number {
    const now = Date.now();
    let n = 0;
    for (const t of Object.values(this.db.widget_tokens)) {
      if (t.uid !== uid || t.revoked || t.expires_at <= now || (deviceId !== null && t.device_id !== deviceId)) continue;
      t.uses = { window_start: now, count: QUICK_SHARE_LIMITS.perTokenPerHour };
      n++;
    }
    if (n) this.commit();
    return n;
  }

  /** Demo paneli: favorilerimi sunucu adına ayarlar (`favorites_set` ile aynı temizlik). Dönen: saklanan liste. */
  setFavoritesOf(uid: UserId, ids: readonly UserId[]): UserId[] {
    const u = this.db.users[uid];
    if (!u) return [];
    u.favorite_ids = sanitizeFavorites(ids, this.acceptedFriendIds(uid));
    this.commit();
    return [...u.favorite_ids];
  }

  private f6View(): DemoSnapshot['f6'] {
    const now = Date.now();
    const me = this.db.users[DEMO_ME];
    const mine = Object.values(this.db.widget_tokens).filter((t) => t.uid === DEMO_ME && !t.revoked && t.expires_at > now);
    return {
      myGender: me?.gender ?? null,
      myPhoto: !!me?.avatar_url,
      favorites: (me?.favorite_ids ?? []).map((id) => this.nameOf(id)),
      activeWidgetTokens: mine.length,
      quickSharesThisHour: mine.reduce((n, t) => n + (now - t.uses.window_start < HOUR ? t.uses.count : 0), 0),
    };
  }

  // --- Faz 2: bağlantı (QR) paylaşımı -------------------------------------------------------------

  private linkView(l: LinkRec): LinkShareView {
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

  /**
   * `link_acl/{hash}` aynası (backend `mirrorLinkAcl` + `alignLinkLive` / `removeLinkLive`), sürüm korumalı.
   * Bitişte sıra: mezar taşı → `link_live` silme. Açık izleyiciler commit sonrası aynı anda görür.
   */
  private mirrorLinkAcl(l: LinkRec, now: EpochMs): void {
    const cur = this.db.link_acl[l.token_hash];
    if (cur && cur.version > l.version) return;
    if (l.status === 'active') {
      const acl: LinkAclRec = { status: 'active', version: l.version, sender_id: l.sender_id, link_id: l.link_id, share_mode: l.share_mode, started_at: l.started_at };
      if (l.expires_at !== null) acl.expires_at = l.expires_at;
      this.db.link_acl[l.token_hash] = acl;
      const copy = this.db.link_live[l.token_hash];
      if (copy) {
        copy.share_mode = l.share_mode;
        if (l.expires_at === null) delete copy.expires_at;
        else copy.expires_at = l.expires_at;
      }
    } else {
      const t: LinkAclRec = { status: 'ended', version: l.version, ended_at: l.ended_at ?? now };
      if (l.end_reason) t.end_reason = l.end_reason;
      this.db.link_acl[l.token_hash] = t;
      delete this.db.link_live[l.token_hash];
    }
  }

  /** Eski özeti kapatır (token yenileme): mezar taşı + canlı kopya silinir. */
  private closeLinkHash(hash: string, version: number, now: EpochMs): void {
    this.db.link_acl[hash] = { status: 'ended', version, ended_at: now, end_reason: 'stopped_by_sender' };
    delete this.db.link_live[hash];
  }

  private endLink(l: LinkRec, reason: LinkEndReason, now: EpochMs): boolean {
    if (l.status !== 'active') {
      this.mirrorLinkAcl(l, now); // idempotent: kalan ACL / canlı kopya kapanır
      return false;
    }
    l.status = 'ended';
    l.end_reason = reason;
    l.ended_at = now;
    l.version += 1;
    l.updated_at = now;
    this.mirrorLinkAcl(l, now);
    return true;
  }

  private isLinkLive(l: LinkRec, now: EpochMs): boolean {
    return l.status === 'active' && (l.expires_at === null || l.expires_at > now);
  }

  /** Sunucu token'ı: 32 bayt kriptografik rastgele (crypto.getRandomValues) → core base64url. */
  private newToken(): string {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (!c?.getRandomValues) return fail('internal', 'Güvenli rastgele sayı üreteci yok');
    return encodeLinkToken(c.getRandomValues(new Uint8Array(LINK_TOKEN_BYTES)));
  }

  /** Firestore otomatik kimliği gibi: 20 karakter [A-Za-z0-9]. */
  private newLinkId(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    const bytes = c?.getRandomValues ? c.getRandomValues(new Uint8Array(20)) : Uint8Array.from({ length: 20 }, () => Math.floor(Math.random() * 256));
    let id = '';
    for (const b of bytes) id += alphabet[b % alphabet.length];
    return this.db.links[id] ? this.newLinkId() : id;
  }

  private linkCreateResponse(l: LinkRec, token: string, now: EpochMs): LinkShareCreateResponse {
    return { ...this.linkView(l), token, url: buildLinkUrl(LINK_DOMAIN_DEFAULT, token), server_now: now };
  }

  private linkShareCreate(payload: unknown, uid: UserId, now: EpochMs): LinkShareCreateResponse {
    const data = this.parse(LinkShareCreateRequestSchema, payload);
    let resolved: { share_mode: ShareMode; expires_at: EpochMs | null };
    try {
      resolved = resolveDuration(data.duration, now, offsetFnForTimeZone(data.time_zone));
    } catch (e) {
      if (e instanceof DurationError) fail('invalid_duration', e.message);
      throw e;
    }
    if (!this.db.users[uid]) fail('unauthenticated');
    if (isInvisible(this.db.users[uid])) fail('invisible_mode');
    const mine = Object.values(this.db.links).filter((l) => l.sender_id === uid);
    if (mine.filter((l) => this.isLinkLive(l, now)).length >= LINK_LIMITS.maxActivePerUser) fail('link_limit_reached');
    if (mine.filter((l) => l.started_at > now - HOUR).length >= LINK_CREATE_PER_HOUR) fail('rate_limited');
    const token = this.newToken();
    const l: LinkRec = {
      link_id: this.newLinkId(),
      session_id: uuidV4(),
      audience: 'link',
      sender_id: uid,
      token_hash: linkTokenHash(token),
      status: 'active',
      share_mode: resolved.share_mode,
      started_at: now,
      expires_at: resolved.expires_at,
      ended_at: null,
      end_reason: null,
      version: 1,
      extended_count: 0,
      updated_at: now,
    };
    this.db.links[l.link_id] = l;
    // ACL yanıttan ÖNCE yazılır: gönderenin ilk konum örneği hemen kabul edilsin.
    this.mirrorLinkAcl(l, now);
    return this.linkCreateResponse(l, token, now);
  }

  private linkCreateReplay(stored: unknown, uid: UserId, now: EpochMs): LinkShareCreateResponse {
    const linkId = (stored as { link_id?: unknown } | null)?.link_id;
    const cur = typeof linkId === 'string' ? this.db.links[linkId] : undefined;
    if (!cur || cur.sender_id !== uid || !this.isLinkLive(cur, now)) return fail('share_not_active');
    const staleHash = cur.token_hash;
    const token = this.newToken();
    cur.token_hash = linkTokenHash(token);
    cur.version += 1;
    cur.updated_at = now;
    this.closeLinkHash(staleHash, cur.version, now);
    this.mirrorLinkAcl(cur, now);
    return this.linkCreateResponse(cur, token, now);
  }

  /** Gönderenin kendi bağlantısı; yok ya da başkasınınsa AYNI hata (kimlik taraması yok). */
  private ownLink(uid: UserId, linkId: string): LinkRec {
    const l = this.db.links[linkId];
    if (!l || l.sender_id !== uid) return fail('link_not_found');
    return l;
  }

  private linkShareExtend(payload: unknown, uid: UserId, now: EpochMs): LinkShareUpdateResponse {
    const data = this.parse(LinkShareExtendRequestSchema, payload);
    if (isInvisible(this.db.users[uid])) fail('invisible_mode');
    const l = this.ownLink(uid, data.link_id);
    if (l.status !== 'active') fail('share_not_active');
    if (!canExtend(l, now)) {
      if (l.expires_at !== null && l.expires_at <= now) fail('already_expired');
      fail('invalid_duration', 'Süresiz paylaşım uzatılamaz');
    }
    const r = extendExpiry(l, data.minutes, now);
    l.share_mode = r.share_mode;
    l.expires_at = r.expires_at;
    l.version += 1;
    l.extended_count += 1;
    l.updated_at = now;
    this.mirrorLinkAcl(l, now);
    return { ...this.linkView(l), server_now: now };
  }

  private linkShareStop(payload: unknown, uid: UserId, now: EpochMs): LinkShareUpdateResponse {
    const data = this.parse(LinkShareStopRequestSchema, payload);
    const l = this.ownLink(uid, data.link_id);
    // Süresi dolmuş ama taranmamış: neden "expired" kalır (doğru metin için).
    const reason: LinkEndReason = l.expires_at !== null && l.expires_at <= now ? 'expired' : 'stopped_by_sender';
    this.endLink(l, reason, now);
    return { ...this.linkView(l), server_now: now };
  }

  // --- Faz 2: Maps vekili (route_compute, geocode_reverse) ----------------------------------------

  private quota(uid: UserId, now: EpochMs): MapsQuotaRec {
    return (this.db.maps_quota[`${uid}_${quotaDay(now)}`] ??= { route: 0, geocode: 0, route_hits: 0, geocode_hits: 0 });
  }

  /** Google çağrısından ÖNCE bir birim ayırır (backend `reserveMapsQuota`; başarısız çağrı birimi geri vermez). */
  private reserveQuota(uid: UserId, kind: MapsQuotaKind, now: EpochMs): void {
    const q = this.quota(uid, now);
    if (q[kind] >= MAPS_DAILY_LIMITS[kind]) fail('quota_exceeded');
    q[kind] += 1;
  }

  private routeCompute(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(RouteComputeRequestSchema, payload);
    const key = routeCacheKey(data.origin, data.destination, data.travel_mode, now, uid);
    // 1. Önbellek (kota sayılmaz).
    const hit = this.db.route_cache[key];
    if (hit && hit.uid === uid && hit.expire_at > now) {
      this.quota(uid, now).route_hits += 1;
      return { distance_m: hit.distance_m, duration_s: hit.duration_s, polyline: hit.polyline, cached: true, computed_at: hit.computed_at };
    }
    // 2. Anahtar / Google erişimi, 3. kota.
    if (this.db.maps_down) fail('maps_unavailable');
    this.reserveQuota(uid, 'route', now);
    // 4. "Google" (backend gibi: DRIVE'da Essentials SKU, FieldMask yalnızca süre + mesafe + çizgi).
    const body = routesRequestBody(data.origin, data.destination, data.travel_mode, { drivePreference: 'TRAFFIC_UNAWARE' });
    const r = fakeComputeRoutes(body);
    if (r.status === 400 || r.status === 404) fail('route_not_found');
    if (r.status !== 200) fail('maps_unavailable');
    const parsed = parseRoutesResponse(r.json);
    if (!parsed) return fail('route_not_found');
    this.db.route_cache[key] = { uid, ...parsed, computed_at: now, expire_at: now + ROUTE_POLICY.cacheTtlMs };
    return { distance_m: parsed.distance_m, duration_s: parsed.duration_s, polyline: parsed.polyline, cached: false, computed_at: now };
  }

  private geocodeReverse(payload: unknown, uid: UserId, now: EpochMs) {
    const data = this.parse(GeocodeReverseRequestSchema, payload);
    const cell = geocodeCell(data);
    const hit = this.db.geocode_cache[cell];
    if (hit && hit.expire_at > now) {
      this.quota(uid, now).geocode_hits += 1;
      return { label: hit.label, cell, cached: true };
    }
    if (this.db.maps_down) fail('maps_unavailable');
    this.reserveQuota(uid, 'geocode', now);
    // Google'a kullanıcının tam konumu değil HÜCRE MERKEZİ sorulur.
    const parsed = parseReverseGeocodeResponse(fakeReverseGeocode(geocodeQueryPoint(cell)));
    if (!parsed.ok) return fail('maps_unavailable');
    this.db.geocode_cache[cell] = { label: parsed.label, created_at: now, expire_at: now + GEOCODE_POLICY.cacheTtlMs };
    return { label: parsed.label, cell, cached: false };
  }

  // --- demo kontrolleri (yan panel) ------------------------------------------------------------

  /**
   * "Bitişe 2 dk kalsın": aktif paylaşımlarımın bitişini öne çeker. Toplam süre korunur
   * (başlangıç da aynı kadar geri alınır), böylece uyarı anı (core extendPromptAt) hemen geçmiş olur.
   * Dönen değer: kısaltılan paylaşım sayısı.
   */
  shortenMyActiveShares(remainingMs: number): number {
    const now = Date.now();
    let n = 0;
    for (const s of Object.values(this.db.shares)) {
      if (s.sender_id !== DEMO_ME || s.status !== 'active' || s.expires_at === null) continue;
      const delta = s.expires_at - now - remainingMs;
      if (delta <= 0) continue;
      s.expires_at -= delta;
      s.started_at -= delta;
      if (s.share_mode === 'until_end_of_day' || s.share_mode === 'weekly') s.share_mode = 'timed';
      s.version += 1;
      s.updated_at = now;
      this.mirrorAcl(s);
      n++;
    }
    // Faz 2: QR bağlantılarım da (süresiz olanlar hariç). ACL + link_live expires_at hizalanır.
    for (const l of Object.values(this.db.links)) {
      if (l.sender_id !== DEMO_ME || !this.isLinkLive(l, now) || l.expires_at === null) continue;
      const delta = l.expires_at - now - remainingMs;
      if (delta <= 0) continue;
      l.expires_at -= delta;
      l.started_at -= delta;
      if (l.share_mode === 'until_end_of_day' || l.share_mode === 'weekly') l.share_mode = 'timed';
      l.version += 1;
      l.updated_at = now;
      this.mirrorLinkAcl(l, now);
      n++;
    }
    if (n) this.commit();
    return n;
  }

  myShortenableShares(): number {
    const now = Date.now();
    const shares = Object.values(this.db.shares).filter((s) => s.sender_id === DEMO_ME && s.status === 'active' && s.expires_at !== null && s.expires_at > now).length;
    const links = Object.values(this.db.links).filter((l) => l.sender_id === DEMO_ME && this.isLinkLive(l, now) && l.expires_at !== null).length;
    return shares + links;
  }

  /**
   * "Bağlantıyı sunucudan iptal et": en yeni aktif bağlantımı sunucu tarafında bitirir (başka cihazdan
   * "Paylaşımı durdur" ile aynı yol: kayıt → mezar taşı → link_live silme). Dönen: iptal edildi mi.
   */
  revokeLatestLink(): boolean {
    const now = Date.now();
    const live = Object.values(this.db.links)
      .filter((l) => l.sender_id === DEMO_ME && this.isLinkLive(l, now))
      .sort((a, b) => b.started_at - a.started_at);
    const l = live[0];
    if (!l) return false;
    this.endLink(l, 'stopped_by_sender', now);
    this.commit();
    return true;
  }

  /** "Google yanıt vermesin": önbellekte olmayan route_compute / geocode_reverse → maps_unavailable. */
  setMapsDown(down: boolean): void {
    this.db.maps_down = down;
    this.commit();
  }

  isSharingWithMe(bot: UserId): boolean {
    const s = this.db.shares[shareId(bot, DEMO_ME)];
    return !!s && s.status === 'active' && (s.expires_at === null || s.expires_at > Date.now());
  }

  botStopSharing(bot: UserId): boolean {
    const s = this.db.shares[shareId(bot, DEMO_ME)];
    if (!s) return false;
    const ok = this.endShare(s, 'stopped_by_sender', Date.now());
    this.commit();
    return ok;
  }

  /** Bot bana yeni bir paylaşım başlatır (1 saat) ve hemen taze bir paket gönderir. */
  botStartSharing(bot: UserId): boolean {
    // Faz 8: bot bana yalnızca `location_view` izni varken paylaşır.
    const ok = this.botShareNow(bot, Date.now());
    if (ok) this.commit();
    return ok;
  }

  /** "Arkadaşlık isteği gelsin": önce Elif (değilse yeni bir sanal kişi) bana istek gönderir. */
  incomingFriendRequest(): string {
    const now = Date.now();
    const elif = PEOPLE.elif.uid;
    const fid = friendshipId(elif, DEMO_ME);
    let from: UserId = elif;
    if (this.db.friendships[fid]) from = this.createVirtualUser(this.randomInviteCode(), now).uid;
    this.addPendingRequest(from, DEMO_ME, now);
    this.commit();
    return this.db.users[from]?.display_name ?? 'Biri';
  }

  // --- Faz 3 demo paneli ------------------------------------------------------------------------

  /**
   * "Ayşe'nin pili %14'e düşsün": Ayşe'nin pili değişir, telefonu hemen yeni paket yayınlar (pil değişti) ve
   * düşük pil tetikleyicisi değişince `battery_low_notify` çağırır → bana push. Dönen: bildirim durumu.
   */
  setAyseBattery(pct: number): BatteryLowNotifyResponse['status'] | 'not_sharing' {
    const now = Date.now();
    const bot = this.db.bots[PEOPLE.ayse.uid];
    if (!bot) return 'not_sharing';
    bot.battery = Math.max(0, Math.min(100, Math.round(pct)));
    bot.charging = false;
    const s = this.db.shares[shareId(PEOPLE.ayse.uid, DEMO_ME)];
    if (!s || s.status !== 'active' || (s.expires_at !== null && s.expires_at <= now)) {
      this.commit();
      return 'not_sharing';
    }
    this.botPublish(PEOPLE.ayse.uid, now, true);
    const r = this.applyBatteryAlert(PEOPLE.ayse.uid, s.session_id, bot.battery, false, [s], now);
    this.commit();
    return r.status;
  }

  /**
   * "Mehmet'in bağlantısı kopsun": Mehmet'in telefonu çekim alanı dışında, paket gelmiyor. Demo bekleme süresini
   * atlar: son paketi ~1 saat önceye çekilir (hb 15 dk → 4·hb + 30 sn aşıldı). Paylaşım yoksa / çok yeniyse
   * haftalık paylaşım 2 gün önce başlamış gibi kurulur.
   */
  mehmetDisconnect(): boolean {
    const now = Date.now();
    const id = PEOPLE.mehmet.uid;
    const bot = this.db.bots[id];
    if (!bot || !this.areFriends(id, DEMO_ME)) return false;
    let s = this.db.shares[shareId(id, DEMO_ME)];
    const at = now - MEHMET_OFFLINE_AGE_MS;
    if (!s || s.status !== 'active' || (s.expires_at !== null && s.expires_at <= now) || s.started_at > at) {
      s = this.startBotShare(id, { kind: 'weekly' }, now - 2 * DAY) ?? undefined;
      if (!s) return false;
    }
    bot.offline = true;
    bot.kind = 'heartbeat';
    bot.next_at = Number.MAX_SAFE_INTEGER;
    this.seedPacket(id, bot.spot, at, bot.battery, 0, this.botHb(id));
    this.commit();
    return true;
  }

  /** Mehmet'in bağlantısı geri gelir: hemen taze paket. */
  mehmetReconnect(): boolean {
    const bot = this.db.bots[PEOPLE.mehmet.uid];
    if (!bot) return false;
    bot.offline = false;
    const ok = this.botPublish(PEOPLE.mehmet.uid, Date.now(), true);
    this.commit();
    return ok;
  }

  // --- Faz 4 demo paneli ------------------------------------------------------------------------

  /** Botun şu anki konumu: bana giden canlı paketi, yoksa durduğu yer. */
  private botPosition(bot: UserId): { lat: number; lng: number; accuracy: number } {
    const live = this.db.live[DEMO_ME]?.[shareId(bot, DEMO_ME)];
    if (live && typeof live.lat === 'number' && typeof live.lng === 'number') {
      return { lat: live.lat, lng: live.lng, accuracy: typeof live.accuracy === 'number' ? live.accuracy : 12 };
    }
    const b = this.db.bots[bot];
    const at = b?.kind === 'walker' ? (AYSE_PATH[2] as LatLng) : (b?.spot ?? MEHMET_SPOT);
    return { lat: at.lat, lng: at.lng, accuracy: 10 };
  }

  /** "Ayşe 'Buradayım' göndersin" / "Mehmet 'Yoldayım'": bot bana ping atar (demo: soğuma atlanır). Dönen: gönderildi mi. */
  botPing(bot: UserId, kind: PingKind, etaS: number | null = null): boolean {
    const now = Date.now();
    if (!this.areFriends(bot, DEMO_ME)) return false;
    delete this.db.ping_pair[`${bot}_${DEMO_ME}`];
    const pos = this.botPosition(bot);
    try {
      this.pingSendNow(bot, { to: DEMO_ME, kind, location: kind === 'here' || etaS !== null ? { ...pos, timestamp: now } : null, eta_s: etaS }, now);
    } catch {
      return false;
    }
    this.commit();
    return true;
  }

  /** Bot durum notu (null = kaldır); bot hemen yeni paket yayınlar. Dönen: bana canlı paylaşıyor mu. */
  setBotStatusNote(bot: UserId, note: { emoji: string | null; text: string; ms: number } | null): boolean {
    const now = Date.now();
    if (note) this.db.bot_notes[bot] = { emoji: note.emoji, text: note.text, expires_at: now + note.ms };
    else delete this.db.bot_notes[bot];
    const sharing = this.isSharingWithMe(bot);
    const b = this.db.bots[bot];
    if (sharing && b && !b.offline) this.botPublish(bot, now, true);
    this.commit();
    return sharing;
  }

  hasBotStatusNote(bot: UserId): boolean {
    const n = this.db.bots[bot] ? this.db.bot_notes[bot] : undefined;
    return !!n && n.expires_at > Date.now();
  }

  /** "Ayşe park yeri notu paylaşsın": bulunduğu yerde, yalnızca bana görünür, 4 saat (varsa aynı notu tazeler). */
  botPlaceNote(bot: UserId): boolean {
    const now = Date.now();
    if (!this.areFriends(bot, DEMO_ME)) return false;
    const pos = this.botPosition(bot);
    const existing = Object.values(this.db.place_notes).find((n) => n.owner_id === bot && n.text === 'Park yeri burası' && n.expires_at > now);
    this.upsertNote(
      bot,
      { note_id: existing?.note_id ?? null, emoji: '🅿️', text: 'Park yeri burası', position: { lat: pos.lat - 0.0004, lng: pos.lng + 0.0003, accuracy: 8 }, visible_to: [DEMO_ME], duration_ms: 4 * HOUR },
      now,
    );
    this.commit();
    return true;
  }

  /**
   * "Ayşe SOS göndersin": acil kişisi benim; tam konum (±6 m), adres, pil %23, bana doğru rota. Dönen: sos_id
   * ya da gönderilemedi (arkadaş değil).
   */
  botSos(bot: UserId): string | null {
    const now = Date.now();
    if (!this.areFriends(bot, DEMO_ME)) return null;
    const list = this.db.emergency[bot] ?? [];
    if (!list.includes(DEMO_ME)) this.db.emergency[bot] = [DEMO_ME, ...list].slice(0, SOS_LIMITS.maxContacts);
    // Faz 8: acil kişi seçimi `sos_alert` izni demektir (emergency_contacts_set ile aynı).
    this.grantScope(bot, DEMO_ME, 'sos_alert', 'emergency_contact', now);
    const b = this.db.bots[bot];
    if (b) {
      b.battery = 23;
      b.charging = false;
    }
    const pos = this.botPosition(bot);
    try {
      const r = this.sosSendNow(
        bot,
        {
          location: { lat: pos.lat, lng: pos.lng, accuracy: 6, timestamp: now },
          battery_pct: 23,
          is_charging: false,
          route: { destination_label: this.nameOf(DEMO_ME), eta_s: 9 * 60, distance_m: 1_800 },
          address: null,
        },
        now,
        true,
      );
      if (b && this.isSharingWithMe(bot) && !b.offline) this.botPublish(bot, now, true);
      this.commit();
      return r.sos.sos_id;
    } catch {
      return null;
    }
  }

  /** "Ayşe güvende": botun aktif SOS'u `safe` ile kapanır, bana "güvende" push'u. Dönen: kapatılacak SOS var mıydı. */
  botSosResolve(bot: UserId): boolean {
    const a = Object.values(this.db.sos).find((x) => x.sender_id === bot && isSosActive(x));
    if (!a) return false;
    this.resolveSos(a, 'safe', Date.now(), true);
    this.commit();
    return true;
  }

  private f4View(): DemoSnapshot['f4'] {
    const now = Date.now();
    const ayse = PEOPLE.ayse.uid;
    const mine = Object.values(this.db.sos)
      .filter((a) => a.sender_id === DEMO_ME)
      .sort((a, b) => b.created_at - a.created_at)[0];
    return {
      myEmergencyContacts: (this.db.emergency[DEMO_ME] ?? []).map((u) => this.nameOf(u)),
      mySos: mine ? { status: mine.status, recipients: mine.recipient_ids.length, acks: Object.keys(mine.acks).length, updates: mine.update_count } : null,
      ayseSosActive: Object.values(this.db.sos).some((a) => a.sender_id === ayse && isSosActive(a)),
      ayseNote: this.hasBotStatusNote(ayse),
      placeNotesForMe: Object.values(this.db.place_notes).filter((n) => n.expires_at > now && (n.owner_id === DEMO_ME || n.visible_to.includes(DEMO_ME))).length,
      pingsForMe: Object.keys(this.db.ping_inbox[DEMO_ME] ?? {}).length,
    };
  }

  // --- Faz 5 demo paneli ------------------------------------------------------------------------

  /** Demo Ev bölgem (ad "Ev", tür home). */
  private myHomeZone(): Zone | null {
    return Object.values(this.db.zones[DEMO_ME] ?? {}).find((z) => z.kind === 'home') ?? null;
  }

  /**
   * "Ev bölgemi buraya kaydet (demo)": verilen noktada 150 m Ev bölgesi + "Vardığımda Ayşe'ye bildir" + "Çıkınca Ayşe
   * ile 1 saat paylaş" (her gün, gün boyu). Varsa aynı bölge güncellenir. Dönen: bölge ya da null (Ayşe arkadaş değil).
   */
  saveDemoHomeZone(at: LatLng): Zone | null {
    const now = Date.now();
    const ayse = PEOPLE.ayse.uid;
    if (!this.areFriends(DEMO_ME, ayse)) return null;
    const existing = this.myHomeZone();
    const res = this.upsertZone(
      DEMO_ME,
      {
        op_id: uuidV4(),
        zone_id: existing?.zone_id ?? null,
        kind: 'home',
        name: 'Ev',
        emoji: '🏠',
        center: at,
        radius_m: ZONE_LIMITS.defaultRadiusM,
        rules: [
          { rule_id: uuidV4(), trigger: 'arrive', action: 'notify', recipient_ids: [ayse], share_duration: null, days_mask: 127, window: null, enabled: true },
          { rule_id: uuidV4(), trigger: 'leave', action: 'start_share', recipient_ids: [ayse], share_duration: { kind: 'preset', preset: 'h1' }, days_mask: 127, window: null, enabled: true },
        ],
        enabled: true,
        time_zone: this.db.users[DEMO_ME]?.time_zone ?? DEFAULT_TZ,
      },
      now,
    );
    // Yeni kurulumda eski soğumalar senaryoyu bastırmasın.
    for (const t of ['arrive', 'leave']) delete this.db.zone_cooldowns[`${DEMO_ME}_${res.zone.zone_id}_${t}`];
    this.commit();
    return res.zone;
  }

  /** "Ayşe eve vardı": Ayşe'nin Ev bölgesi (kuralı: vardığımda Deniz'e bildir) → bana `zone_event` push'u. */
  botZoneArrive(bot: UserId): ZoneEventReportResponse | null {
    const now = Date.now();
    if (!this.areFriends(bot, DEMO_ME)) return null;
    const existing = Object.values(this.db.zones[bot] ?? {}).find((z) => z.kind === 'home');
    // Faz 8: kural her seferinde yeniden yazılır (alıcı izni sonradan verildiyse kural geri gelsin; izinsizse düşer).
    const at = existing?.center ?? this.db.bots[bot]?.spot ?? (AYSE_PATH[0] as LatLng);
    const home = this.upsertZone(
      bot,
      {
        op_id: uuidV4(),
        zone_id: existing?.zone_id ?? null,
        kind: 'home',
        name: 'Ev',
        emoji: '🏠',
        center: { lat: at.lat, lng: at.lng },
        radius_m: ZONE_LIMITS.defaultRadiusM,
        rules: [{ rule_id: uuidV4(), trigger: 'arrive', action: 'notify', recipient_ids: [DEMO_ME], share_duration: null, days_mask: 127, window: null, enabled: true }],
        enabled: true,
        time_zone: DEFAULT_TZ,
      },
      now,
    ).zone;
    // Demo: tekrar denenebilsin diye sunucu soğuması atlanır (filtre ve kurallar aynı).
    delete this.db.zone_cooldowns[`${bot}_${home.zone_id}_arrive`];
    try {
      const r = this.zoneEventNow(bot, home.zone_id, 'arrive', now, now);
      this.commit();
      return r;
    } catch {
      return null;
    }
  }

  /** "Ayşe buluşma noktası önersin": Ayşe + ben (`myPos`) için kafe önerisi → ilki bana paylaşılır (push + kart). */
  botMeetupSuggest(bot: UserId, myPos: LatLng): string | null {
    const now = Date.now();
    if (!this.areFriends(bot, DEMO_ME)) return null;
    const pos = this.botPosition(bot);
    try {
      const participants: MeetupParticipant[] = [
        { key: 'me', position: { lat: pos.lat, lng: pos.lng }, mode: 'WALK' },
        { key: DEMO_ME, position: { lat: myPos.lat, lng: myPos.lng }, mode: 'WALK' },
      ];
      const res = this.suggestMeetup(bot, participants, 'cafe', now);
      const best = res.suggestions[0];
      if (!best) return null;
      const m = this.shareMeetup(
        bot,
        { op_id: uuidV4(), to: [DEMO_ME], place: best.place, etas: best.etas, meet_at: now + 30 * MINUTE, note: 'Kahve içelim mi? ☕' },
        now,
      );
      this.commit();
      return m.meetup_id;
    } catch {
      return null;
    }
  }

  private f5View(): DemoSnapshot['f5'] {
    const now = Date.now();
    const home = this.myHomeZone();
    const last = (this.db.zone_events[DEMO_ME] ?? [])[0];
    const q = this.db.maps_quota[`${DEMO_ME}_${quotaDay(now)}`];
    return {
      homeZone: home ? { zone_id: home.zone_id, name: home.name, center: home.center, radius_m: home.radius_m, rules: home.rules.length, enabled: home.enabled } : null,
      myZones: Object.keys(this.db.zones[DEMO_ME] ?? {}).length,
      lastZoneEvent: last
        ? { zone_name: this.db.zones[DEMO_ME]?.[last.zone_id]?.name ?? 'Bölge', transition: last.transition, at: last.occurred_at, notified: last.notified, suppressed: last.suppressed }
        : null,
      activeMeetups: Object.values(this.db.meetups).filter((m) => isMeetupActive(m, now) && (m.from === DEMO_ME || m.to.includes(DEMO_ME))).length,
      meetupQueries: q?.meetup ?? 0,
      meetupHits: q?.meetup_hits ?? 0,
      meetupLimit: MEETUP_LIMITS.perUserDailyLimit,
    };
  }

  // --- Faz 8: izin istekleri, kişi izinleri, görünmez mod, onay ------------------------------------

  /** Backend `permission_request_send`. Yanıt her zaman `sent` | `already_granted` (ret soğuması sızmaz). */
  private permissionRequestSendCall(payload: unknown, uid: UserId, now: EpochMs): PermissionRequestSendResponse {
    const req = this.parse(PermissionRequestSendSchema, payload);
    return this.permissionRequestNow(uid, req.target_id, req.scopes, now);
  }

  private permissionRequestNow(uid: UserId, target: UserId, scopes: readonly RequestableScope[], now: EpochMs): PermissionRequestSendResponse {
    if (target === uid) fail('invalid_argument');
    if (!canRequestPermission(this.pair(uid, target))) fail('not_friends');
    // Hedefin bana verdiği belge (granter = hedef); soğuma için sunucuya özel ret anları birleştirilir.
    const id = grantId(target, uid);
    const current = this.db.grants[id] ?? null;
    const plan = planPermissionRequest(current ? { ...current, declined_at: this.db.perm_declines[id] ?? {} } : null, scopes, now);
    const answer = (status: PermissionRequestSendResponse['status']): PermissionRequestSendResponse => ({ status, server_now: now });
    if (plan.kind === 'already_granted') return answer('already_granted');
    // Hepsi zaten (isteyenin gördüğü) bekleyen istekte: yazma / push yok, yanıt yine `sent`.
    if (plan.kind === 'noop') return answer('sent');
    if (plan.kind === 'cooldown') return fail('permission_cooldown');
    const dayKey = `${uid}_${quotaDay(now)}`;
    const count = this.db.perm_day[dayKey] ?? 0;
    if (count >= PERMISSION_REQUESTS_PER_DAY) fail('rate_limited');
    this.db.perm_day[dayKey] = count + 1;
    this.db.grants[id] = withPendingRequest(current ?? emptyGrantDoc(target, uid, now), plan.scopes, now);
    // Reddedilmiş / ret soğumasındaki kapsamlar granter'a gizli kalır (ret anı yeni istek anına taşınır), push yok.
    if (plan.hidden.length > 0) {
      const declined = { ...(this.db.perm_declines[id] ?? {}) };
      for (const sc of plan.hidden) declined[sc] = now;
      this.db.perm_declines[id] = declined;
    }
    if (plan.added.length === 0) return answer('sent');
    const data: Extract<PushData, { type: 'permission_request' }> = { type: 'permission_request', from: uid, scopes: plan.live.join(',') };
    this.push(target, { notification: { title: 'İzin isteği', body: permissionRequestText(this.db.users[uid]?.display_name || 'Bir arkadaşın', plan.live) }, data });
    // Demo: bot granter 6 sn sonra yanıt verir (sweepPhase8).
    if (target !== DEMO_ME && this.db.bots[target]) this.db.perm_auto[id] = now + AUTO_ACCEPT_MS;
    return answer('sent');
  }

  private grantedPush(to: UserId, by: UserId, scopes: readonly AccessScope[]): void {
    const data: Extract<PushData, { type: 'permission_granted' }> = { type: 'permission_granted', by, scopes: scopes.join(',') };
    this.push(to, { notification: { title: 'İzin verildi', body: permissionGrantedText(this.db.users[by]?.display_name || 'Arkadaşın', scopes) }, data });
  }

  /** Backend `permission_request_respond` (çağıran = granter). Retde push yok. */
  private permissionRequestRespondCall(payload: unknown, uid: UserId, now: EpochMs): PermissionRequestRespondResponse {
    const req = this.parse(PermissionRequestRespondSchema, payload);
    const requester = req.requester_id;
    if (requester === uid) fail('invalid_argument');
    if (!this.areFriends(uid, requester)) fail('not_friends');
    let resolved: { share_mode: ShareMode; expires_at: EpochMs | null } | null = null;
    if (req.share) {
      try {
        resolved = resolveDuration(req.share.duration, now, offsetFnForTimeZone(req.share.time_zone));
      } catch (e) {
        if (e instanceof DurationError) fail('invalid_duration', e.message);
        throw e;
      }
    }
    const id = grantId(uid, requester);
    const base = this.db.grants[id] ?? emptyGrantDoc(uid, requester, now);
    const r = withResponse({ ...base, declined_at: this.db.perm_declines[id] ?? {} }, req.grant_scopes, now, 'request');
    // Salt ret istemci belgesine dokunmaz (isteyen "bekliyor" görmeye devam eder); ret anları ayrı kayıtta.
    if (r.granted.length > 0) this.db.grants[id] = { ...r.doc, declined_at: {} };
    if (r.declined.length > 0) this.db.perm_declines[id] = r.doc.declined_at;
    let share: PermissionRequestRespondResponse['share'] = null;
    let share_skipped: PermissionRequestRespondResponse['share_skipped'] = null;
    if (resolved) {
      if (!hasGrant(this.grantOf(uid, requester), 'location_view')) share_skipped = 'no_location_view';
      else if (isInvisible(this.db.users[uid])) share_skipped = 'invisible';
      else {
        const sessionId = uuidV4();
        const sh = this.startShare(uid, requester, sessionId, resolved.share_mode, resolved.expires_at, now);
        share = { session_id: sessionId, shares: [this.toView(sh)] };
      }
    }
    if (r.granted.length > 0) this.grantedPush(requester, uid, r.granted);
    return { granted_scopes: r.granted, declined_scopes: r.declined, share, share_skipped, server_now: now };
  }

  /** Backend `permission_set`: açmak arkadaşlık + onay ister; kapatmak her zaman çalışır ve zinciri uygular. */
  private permissionSetCall(payload: unknown, uid: UserId, now: EpochMs): PermissionSetResponse {
    const req = this.parse(PermissionSetSchema, payload);
    const grantee = req.grantee_id;
    if (grantee === uid) fail('invalid_argument');
    if (req.granted) {
      if (!this.areFriends(uid, grantee)) fail('not_friends');
      this.grantScope(uid, grantee, req.scope, 'manual', now);
    } else {
      this.revokeScope(uid, grantee, req.scope, now);
    }
    return { grantee_id: grantee, scopes: grantedScopes(this.grantOf(uid, grantee)), server_now: now };
  }

  /** Giden etkin paylaşımlar ve bağlantılar `stopped_by_sender` ile biter (görünmez ol, onayı geri çek). */
  private endOutgoing(uid: UserId, now: EpochMs): { shares: ShareRec[]; links: number } {
    const shares = Object.values(this.db.shares).filter((sh) => sh.sender_id === uid && sh.status === 'active');
    for (const sh of shares) this.endShare(sh, sh.expires_at !== null && sh.expires_at <= now ? 'expired' : 'stopped_by_sender', now);
    let links = 0;
    for (const l of Object.values(this.db.links)) {
      if (l.sender_id === uid && this.isLinkLive(l, now) && this.endLink(l, 'stopped_by_sender', now)) links++;
    }
    return { shares, links };
  }

  /** Backend `invisible_set`. Arkadaşa "görünmez oldu" denmez; görünür olunca yalnızca seçilenler geri gelir. */
  private invisibleSetCall(payload: unknown, uid: UserId, now: EpochMs): InvisibleSetResponse {
    const req = this.parse(InvisibleSetRequestSchema, payload);
    const me = this.db.users[uid];
    if (!me) return fail('unauthenticated');
    const prev = me.invisible?.on ? me.invisible : null;
    if (req.invisible) {
      const active = Object.values(this.db.shares).filter((sh) => sh.sender_id === uid && sh.status === 'active');
      const fresh = planInvisibleOn(active, now);
      // Zaten görünmezse eski anlık görüntü korunur (yalnızca yeni kişiler eklenir).
      const kept = prev?.snapshot ?? [];
      const snapshot = [...kept, ...fresh.filter((f) => !kept.some((k) => k.receiver_id === f.receiver_id))].slice(0, INVISIBLE_SNAPSHOT_MAX);
      const ended = this.endOutgoing(uid, now);
      me.invisible = { on: true, since: prev?.since ?? now, snapshot, links_ended: (prev?.links_ended ?? 0) + ended.links };
      return { invisible: true, restored_receiver_ids: [], skipped_receiver_ids: [], server_now: now };
    }
    const restoreIds = [...new Set(req.restore_receiver_ids ?? [])].filter((id) => id !== uid);
    const snapshot = prev?.snapshot ?? [];
    if (me.invisible) me.visible_since = now;
    me.invisible = null;
    const plan = planInvisibleRestore(snapshot, restoreIds, now, (id) => canShareLocation(this.pair(uid, id)));
    const skipped = new Set<UserId>(plan.skipped_receiver_ids);
    const restored: UserId[] = [];
    // Aynı bitiş = aynı oturum.
    const sessions = new Map<string, string>();
    for (const { entry, duration } of plan.restore) {
      let resolved: { share_mode: ShareMode; expires_at: EpochMs | null };
      try {
        resolved = resolveDuration(duration, now, offsetFnForTimeZone(DEFAULT_TZ));
      } catch {
        skipped.add(entry.receiver_id);
        continue;
      }
      const key = `${resolved.share_mode}:${resolved.expires_at ?? 'none'}`;
      const sid = sessions.get(key) ?? uuidV4();
      sessions.set(key, sid);
      this.startShare(uid, entry.receiver_id, sid, resolved.share_mode, resolved.expires_at, now);
      restored.push(entry.receiver_id);
    }
    return { invisible: false, restored_receiver_ids: restored, skipped_receiver_ids: [...skipped].filter((id) => !restored.includes(id)), server_now: now };
  }

  /** Backend `consent_accept`: gösterilen metin = onaylanan metin (sürüm + özet), değilse `consent_required`. */
  private consentAcceptCall(payload: unknown, uid: UserId, now: EpochMs): ConsentAcceptResponse {
    const req = this.parse(ConsentAcceptRequestSchema, payload);
    if (!isCurrentConsent(req)) fail('consent_required');
    const me = this.db.users[uid];
    if (!me) return fail('unauthenticated');
    if (me.consent?.version === req.version) return { consent: { ...me.consent }, server_now: now };
    const consent: ProfileConsent = { version: req.version, accepted_at: now };
    const recs = (this.db.consents[uid] ??= {});
    // Ekleme amaçlı (backend ile aynı): önceki onay + geri çekme anı geçmişe taşınır.
    const history = withConsentHistory(recs[req.version]);
    recs[req.version] = {
      user_id: uid,
      version: req.version,
      text_sha256: req.text_sha256,
      scrolled_to_bottom: true,
      accepted_at: now,
      platform: req.platform,
      app_version: req.app_version,
      withdrawn_at: null,
      ...(history.length ? { history } : {}),
    };
    me.consent = consent;
    return { consent, server_now: now };
  }

  /**
   * Backend `consent_withdraw`: giden paylaşımlar ve bağlantılar biter, aktif SOS kapanır, yer notları silinir,
   * önerilen buluşmalar iptal olur; kayda `withdrawn_at`, profil onayı boşalır.
   */
  private consentWithdrawCall(payload: unknown, uid: UserId, now: EpochMs): ConsentWithdrawResponse {
    this.parse(ConsentWithdrawSchema, payload);
    const me = this.db.users[uid];
    if (!me) return fail('unauthenticated');
    const ended = this.endOutgoing(uid, now);
    // Aktif SOS kapanır ("güvende" push'u), yer notları silinir, önerdiğim etkin buluşmalar iptal olur.
    for (const a of Object.values(this.db.sos)) if (a.sender_id === uid && a.status === 'active') this.resolveSos(a, 'safe', now, true);
    for (const n of Object.values(this.db.place_notes)) if (n.owner_id === uid) delete this.db.place_notes[n.note_id];
    for (const m of Object.values(this.db.meetups)) if (m.from === uid && isMeetupActive(m, now)) m.status = 'cancelled';
    const rec = me.consent ? this.db.consents[uid]?.[me.consent.version] : undefined;
    if (rec) rec.withdrawn_at = now;
    me.consent = null;
    return { consent: null, shares_ended: ended.shares.length, links_ended: ended.links, server_now: now };
  }

  /** Demo: botlar isteğime 6 sn sonra yanıt verir (hepsini verir); Can konum izni verince 1 saat paylaşır. */
  private sweepPhase8(now: EpochMs): boolean {
    let changed = false;
    for (const [id, at] of Object.entries(this.db.perm_auto)) {
      if (at > now) continue;
      delete this.db.perm_auto[id];
      changed = true;
      const doc = this.db.grants[id];
      if (!doc || !this.areFriends(doc.granter_id, doc.grantee_id)) continue;
      const full = { ...doc, declined_at: this.db.perm_declines[id] ?? {} };
      const pending = liveRequestScopes(full, now);
      if (pending.length === 0) continue;
      const r = withResponse(full, pending, now, 'request');
      if (r.granted.length === 0) continue;
      this.db.grants[id] = { ...r.doc, declined_at: {} };
      this.grantedPush(doc.grantee_id, doc.granter_id, r.granted);
      if (doc.granter_id === PEOPLE.can.uid && doc.grantee_id === DEMO_ME && r.granted.includes('location_view')) this.botShareNow(doc.granter_id, now);
    }
    const today = quotaDay(now);
    for (const k of Object.keys(this.db.perm_day)) {
      if (k.endsWith(`_${today}`)) continue;
      delete this.db.perm_day[k];
      changed = true;
    }
    return changed;
  }

  /** Bot bana 1 saatlik paylaşım başlatır (izin şart) ve hemen bir paket gönderir. Dönen: başladı mı. */
  private botShareNow(bot: UserId, now: EpochMs): boolean {
    const s = this.startBotShare(bot, { kind: 'preset', preset: 'h1' }, now);
    if (!s) return false;
    const b = this.db.bots[bot];
    if (b && b.kind === 'walker') b.walk_origin = now - 3 * MINUTE;
    // Hareketsiz bot (Can) paylaşırken seyrek nabız gönderir.
    if (b && b.kind === 'idle') b.kind = 'heartbeat';
    if (b) b.offline = false;
    this.botPublish(bot, now, true);
    return true;
  }


  // --- Konum İste (backend `handlers/requests.ts` ile aynı anlam) -----------------------------------

  /** Firestore `location_requests where requester_id == uid` ∪ `where target_id == uid`. */
  locationRequestsOf(uid: UserId): LocReqRec[] {
    return Object.values(this.db.loc_requests)
      .filter((r) => r.requester_id === uid || r.target_id === uid)
      .sort((a, b) => a.request_id.localeCompare(b.request_id))
      .map((r) => ({ ...r }));
  }

  private liveShare(sender: UserId, receiver: UserId, now: EpochMs): ShareRec | null {
    const s = this.db.shares[shareId(sender, receiver)];
    return s && s.status === 'active' && (s.expires_at === null || s.expires_at > now) ? s : null;
  }

  private locationRequestSendCall(payload: unknown, uid: UserId, now: EpochMs): LocationRequestSendResponse {
    const req = this.parse(LocationRequestSendSchema, payload);
    return this.locationRequestNow(uid, req.target_id, now);
  }

  private locationRequestNow(uid: UserId, target: UserId, now: EpochMs): LocationRequestSendResponse {
    if (target === uid) fail('invalid_argument');
    if (!this.areFriends(uid, target)) fail('not_friends');
    const id = locationRequestId(uid, target);
    if (this.liveShare(target, uid, now)) return { request_id: id, status: 'already_sharing', expires_at: null, server_now: now };
    const existing = this.db.loc_requests[id];
    if (existing && existing.status === 'pending' && existing.expires_at > now) {
      return { request_id: id, status: 'pending', expires_at: existing.expires_at, server_now: now };
    }
    if (existing && now - existing.created_at < LOCATION_REQUEST_LIMITS.pairCooldownMs) {
      fail('rate_limited');
    }
    const dayKey = `${uid}_${quotaDay(now)}`;
    const count = this.db.loc_req_day[dayKey] ?? 0;
    if (count >= LOCATION_REQUEST_LIMITS.perDay) fail('rate_limited');
    this.db.loc_req_day[dayKey] = count + 1;
    const rec: LocReqRec = {
      request_id: id,
      requester_id: uid,
      target_id: target,
      status: 'pending',
      created_at: now,
      expires_at: now + LOCATION_REQUEST_LIMITS.ttlMs,
      responded_at: null,
      share_id: null,
      updated_at: now,
    };
    this.db.loc_requests[id] = rec;
    const text = locationRequestPushText(this.db.users[uid]?.display_name);
    const data: Extract<PushData, { type: 'location_request' }> = { type: 'location_request', request_id: id, from: uid, title: text.title, body: text.body };
    this.push(target, { notification: text, data });
    if (target !== DEMO_ME && this.db.bots[target]) this.db.loc_req_auto[id] = now + AUTO_ACCEPT_MS;
    return { request_id: id, status: 'pending', expires_at: rec.expires_at, server_now: now };
  }

  private answeredPush(rec: LocReqRec, status: 'approved' | 'rejected'): void {
    const text = locationRequestAnsweredText(this.db.users[rec.target_id]?.display_name, status);
    const data: Extract<PushData, { type: 'location_request_answered' }> = { type: 'location_request_answered', request_id: rec.request_id, by: rec.target_id, status };
    this.push(rec.requester_id, { notification: text, data });
  }

  private locationRequestRespondCall(payload: unknown, uid: UserId, now: EpochMs): LocationRequestRespondResponse {
    const req = this.parse(LocationRequestRespondSchema, payload);
    const rec = this.db.loc_requests[req.request_id];
    if (!rec || rec.target_id !== uid) return fail('invalid_argument', 'İstek bulunamadı');
    if (rec.status !== 'pending') return fail('invalid_argument', 'İstek artık geçerli değil');
    if (rec.expires_at <= now) return fail('already_expired', 'İsteğin süresi doldu');
    if (!req.accept) {
      Object.assign(rec, { status: 'rejected', responded_at: now, updated_at: now });
      this.answeredPush(rec, 'rejected');
      return { request_id: rec.request_id, status: 'rejected', session_id: null, share: null, server_now: now };
    }
    return this.approveLocationRequest(rec, req.duration ?? { kind: 'preset', preset: 'h1' }, req.time_zone ?? DEFAULT_TZ, now);
  }

  private approveLocationRequest(rec: LocReqRec, duration: DurationChoice, tz: string, now: EpochMs): LocationRequestRespondResponse {
    const uid = rec.target_id;
    const requester = rec.requester_id;
    if (isInvisible(this.db.users[uid])) fail('invisible_mode');
    if (!this.areFriends(uid, requester)) fail('not_friends');
    let resolved: { share_mode: ShareMode; expires_at: EpochMs | null };
    try {
      resolved = resolveDuration(duration, now, offsetFnForTimeZone(tz));
    } catch (e) {
      if (e instanceof DurationError) fail('invalid_duration', e.message);
      throw e;
    }
    // Kabul = hedef → isteyen `location_view` (ters yön yazılmaz).
    if (!hasGrant(this.grantOf(uid, requester), 'location_view')) this.grantScope(uid, requester, 'location_view', 'location_request', now);
    if (!canShareLocation(this.pair(uid, requester))) fail('not_permitted');
    const current = this.liveShare(uid, requester, now);
    let share: ShareRec;
    if (current && (current.expires_at === null || (resolved.expires_at !== null && current.expires_at >= resolved.expires_at))) {
      share = current; // kabul asla kısaltmaz
    } else if (current) {
      Object.assign(current, { share_mode: resolved.share_mode, expires_at: resolved.expires_at, version: current.version + 1, updated_at: now, in_response_to: rec.request_id });
      this.mirrorAcl(current);
      share = current;
    } else {
      share = this.startShare(uid, requester, uuidV4(), resolved.share_mode, resolved.expires_at, now);
      share.in_response_to = rec.request_id;
    }
    Object.assign(rec, { status: 'approved', responded_at: now, share_id: share.share_id, updated_at: now });
    this.answeredPush(rec, 'approved');
    return { request_id: rec.request_id, status: 'approved', session_id: share.session_id, share: this.toView(share), server_now: now };
  }

  private locationRequestCancelCall(payload: unknown, uid: UserId, now: EpochMs): LocationRequestCancelResponse {
    const req = this.parse(LocationRequestCancelSchema, payload);
    const rec = this.db.loc_requests[req.request_id];
    if (!rec || rec.requester_id !== uid) return fail('invalid_argument', 'İstek bulunamadı');
    if (rec.status === 'pending') Object.assign(rec, { status: lrEffectiveStatus(rec, now) === 'expired' ? 'expired' : 'cancelled', responded_at: now, updated_at: now });
    return { status: rec.status, server_now: now } as LocationRequestCancelResponse;
  }

  /** Süresi dolan istek `expired`; bot hedefler isteğime 6 sn sonra yanıt verir (Zeynep reddeder, diğerleri 1 saat onaylar). */
  private sweepLocationRequests(now: EpochMs): boolean {
    let changed = false;
    for (const r of Object.values(this.db.loc_requests)) {
      if (r.status === 'pending' && r.expires_at <= now) {
        Object.assign(r, { status: 'expired', updated_at: now });
        changed = true;
      }
    }
    for (const [id, at] of Object.entries(this.db.loc_req_auto)) {
      if (at > now) continue;
      delete this.db.loc_req_auto[id];
      changed = true;
      const r = this.db.loc_requests[id];
      if (!r || r.status !== 'pending') continue;
      const rejects = r.target_id === PEOPLE.zeynep.uid || isInvisible(this.db.users[r.target_id]);
      if (rejects) {
        Object.assign(r, { status: 'rejected', responded_at: now, updated_at: now });
        this.answeredPush(r, 'rejected');
        continue;
      }
      try {
        this.approveLocationRequest(r, { kind: 'preset', preset: 'h1' }, DEFAULT_TZ, now);
        const b = this.db.bots[r.target_id];
        if (b) {
          if (b.kind === 'walker') b.walk_origin = now - 3 * MINUTE;
          if (b.kind === 'idle') b.kind = 'heartbeat';
          b.offline = false;
        }
        this.botPublish(r.target_id, now, true);
      } catch {
        // izin / arkadaşlık değiştiyse yanıt yok (istek süresi dolunca expired olur)
      }
    }
    const today = quotaDay(now);
    for (const k of Object.keys(this.db.loc_req_day)) {
      if (k.endsWith(`_${today}`)) continue;
      delete this.db.loc_req_day[k];
      changed = true;
    }
    return changed;
  }

  /** Demo paneli: "Mehmet konumunu istiyor" — Mehmet bana konum isteği gönderir (bekleme atlanır). */
  friendRequestsMyLocation(who: 'mehmet' | 'ayse' | 'can' = 'mehmet'): boolean {
    const now = Date.now();
    const from = PEOPLE[who].uid;
    if (!this.areFriends(from, DEMO_ME)) return false;
    const id = locationRequestId(from, DEMO_ME);
    const prev = this.db.loc_requests[id];
    if (prev && prev.status !== 'pending') delete this.db.loc_requests[id];
    // Ben ona zaten paylaşıyorsam istek oluşmaz: demo için önce o paylaşım biter.
    const mine = this.liveShare(DEMO_ME, from, now);
    if (mine) this.endShare(mine, 'stopped_by_sender', now);
    try {
      this.locationRequestNow(from, DEMO_ME, now);
    } catch {
      return false;
    }
    this.commit();
    return true;
  }

  // --- Faz 8 demo paneli ------------------------------------------------------------------------

  /** "Can konumunu görmek istiyor": Can bana `location_view` isteği gönderir (push + "İzin istekleri" kartı). */
  canRequestsMyLocation(): boolean {
    const now = Date.now();
    const can = PEOPLE.can.uid;
    if (!this.areFriends(can, DEMO_ME)) return false;
    const id = grantId(DEMO_ME, can);
    if (hasGrant(this.db.grants[id], 'location_view')) return false;
    // Demo: tekrar denenebilsin diye soğuma ve eski ret anı atlanır.
    delete this.db.perm_declines[id];
    const cur = this.db.grants[id];
    if (cur?.pending) this.db.grants[id] = { ...cur, pending: null };
    try {
      this.permissionRequestNow(can, DEMO_ME, ['location_view'], now);
    } catch {
      return false;
    }
    this.commit();
    return true;
  }

  ayseGrantsMe(): boolean {
    return hasGrant(this.grantOf(PEOPLE.ayse.uid, DEMO_ME), 'location_view');
  }

  /**
   * "Ayşe iznini geri alsın": Ayşe bana verdiği konum iznini kaldırır → paylaşımı sıradan bir durdurma gibi biter
   * (bana neden söylenmez). İzin yokken basılırsa Ayşe izni yeniden verir ve paylaşır. Dönen: yeni durum.
   */
  ayseRevokes(): 'revoked' | 'granted' | null {
    const now = Date.now();
    const ayse = PEOPLE.ayse.uid;
    if (!this.areFriends(ayse, DEMO_ME)) return null;
    if (this.ayseGrantsMe()) {
      this.revokeScope(ayse, DEMO_ME, 'location_view', now);
      this.commit();
      return 'revoked';
    }
    this.grantScope(ayse, DEMO_ME, 'location_view', 'manual', now);
    this.botShareNow(ayse, now);
    this.commit();
    return 'granted';
  }

  /** "Mehmet sana ping izni versin": Mehmet bana `ping` izni verir (bana "Mehmet sana izin verdi: …" push'u). */
  mehmetGrantsPing(): boolean {
    const now = Date.now();
    const mehmet = PEOPLE.mehmet.uid;
    if (!this.areFriends(mehmet, DEMO_ME) || hasGrant(this.grantOf(mehmet, DEMO_ME), 'ping')) return false;
    this.grantScope(mehmet, DEMO_ME, 'ping', 'manual', now);
    this.grantedPush(DEMO_ME, mehmet, ['ping']);
    this.commit();
    return true;
  }

  /** "Sözleşme güncellendi (yeniden onay)": onayım eski sürüme çekilir → uygulama "Metin güncellendi" kapısını açar. */
  bumpConsent(): void {
    const me = this.db.users[DEMO_ME];
    if (!me) return;
    me.consent = { version: DEMO_OLD_CONSENT_VERSION, accepted_at: me.consent?.accepted_at ?? Date.now() - 30 * DAY };
    this.commit();
  }

  /** Onayımı tamamen siler (ilk açılış kapısı). */
  resetConsent(): void {
    const me = this.db.users[DEMO_ME];
    if (!me) return;
    me.consent = null;
    this.commit();
  }

  private f8View(): DemoSnapshot['f8'] {
    const now = Date.now();
    const me = this.db.users[DEMO_ME];
    const seesMe = Object.entries(this.db.live)
      .filter(([r, inbox]) => r !== DEMO_ME && !!inbox[shareId(DEMO_ME, r)])
      .map(([r]) => this.nameOf(r))
      .sort((a, b) => a.localeCompare(b, 'tr'));
    const docs = Object.values(this.db.grants);
    const names = (list: PermissionGrantDoc[], pick: (d: PermissionGrantDoc) => UserId) => list.map((d) => this.nameOf(pick(d))).sort((a, b) => a.localeCompare(b, 'tr'));
    return {
      myInvisible: isInvisible(me),
      myDeliveriesCount: seesMe.length,
      seesMe,
      givenLocation: names(docs.filter((d) => d.granter_id === DEMO_ME && hasGrant(d, 'location_view')), (d) => d.grantee_id),
      receivedLocation: names(docs.filter((d) => d.grantee_id === DEMO_ME && hasGrant(d, 'location_view')), (d) => d.granter_id),
      grants: {
        given: docs.filter((d) => d.granter_id === DEMO_ME && grantedScopes(d).length > 0).length,
        received: docs.filter((d) => d.grantee_id === DEMO_ME && grantedScopes(d).length > 0).length,
      },
      pendingIncoming: docs.filter((d) => d.granter_id === DEMO_ME && liveRequestScopes({ ...d, declined_at: this.db.perm_declines[grantId(d.granter_id, d.grantee_id)] ?? {} }, now).length > 0).length,
      pendingOutgoing: docs.filter((d) => d.grantee_id === DEMO_ME && pendingScopes(d, now).length > 0).length,
      ayseGrantsMe: this.ayseGrantsMe(),
      mehmetGrantsPing: hasGrant(this.grantOf(PEOPLE.mehmet.uid, DEMO_ME), 'ping'),
      consent: me?.consent ? { version: me.consent.version, current: !consentRequired(me.consent) } : null,
    };
  }

  private receiverView(): DemoSnapshot['receiverView'] {
    const candidates = [PEOPLE.ayse.uid, ...Object.keys(this.db.live).filter((r) => r !== DEMO_ME && r !== PEOPLE.ayse.uid).sort()];
    for (const r of candidates) {
      const id = shareId(DEMO_ME, r);
      const live = this.db.live[r]?.[id];
      if (!live) continue;
      const trail = Object.entries(this.db.trail[r]?.[id] ?? {})
        .map(([pid, p]): Record<string, unknown> => ({ id: pid, ...p }))
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      return { receiverId: r, name: this.db.users[r]?.display_name ?? r, live, trail };
    }
    return null;
  }


  // --- Faz 7: gizlilik ayarları ve "yola çıktı" ---------------------------------------------------

  /** RTDB aynası `privacy/{uid}/battery_share` (kural girdisi): yalnızca açıkça açılmışsa true. */
  private batteryShareOf(uid: UserId): boolean {
    return parsePrivacy(this.db.users[uid]?.privacy).battery_share;
  }

  /** Backend `privacySettingsSet`: verilmeyen alan korunur; kapatmak onaysız da yapılabilir (call() kapısı). */
  private privacySettingsSetCall(payload: unknown, uid: UserId, now: EpochMs): PrivacySettingsResponse {
    const d = this.parse(PrivacySettingsSetRequestSchema, payload);
    const u = this.db.users[uid];
    if (!u) return fail('unauthenticated');
    const prev = parsePrivacy(u.privacy);
    const next: PrivacySettings = { battery_share: d.battery_share ?? prev.battery_share, movement_alerts: d.movement_alerts ?? prev.movement_alerts, updated_at: now };
    u.privacy = next;
    return { privacy: { ...next }, server_now: now };
  }

  private movementReportCall(payload: unknown, uid: UserId, now: EpochMs): MovementReportResponse {
    const d = this.parse(MovementReportRequestSchema, payload);
    const r = this.movementNow(uid, d.at, now);
    if (uid === DEMO_ME) this.db.movement_last = { at: now, status: r.status, notified: r.notified_count };
    return r;
  }

  /**
   * Backend `movementReport`: alıcılar = şu an ETKİN paylaşımlarımın alıcıları ve "yola çıktı" tercihi açık olanlar.
   * Görünmezken / geç rapor / 30 dk soğuma / alıcı yoksa bildirim gitmez. Push'ta koordinat YOK.
   */
  private movementNow(uid: UserId, at: EpochMs, now: EpochMs): MovementReportResponse {
    const done = (status: MovementReportResponse['status'], n = 0): MovementReportResponse => ({ status, notified_count: n, server_now: now });
    const me = this.db.users[uid];
    if (!me) return fail('unauthenticated');
    if (isInvisible(me)) return done('invisible');
    if (now - at > MOVEMENT_LIMITS.maxReportAgeMs || at > now + MOVEMENT_LIMITS.maxReportAgeMs) return done('stale');
    const last = this.db.movement_cooldown[uid] ?? null;
    if (last !== null && now - last < MOVEMENT_LIMITS.cooldownMs) return done('cooldown');
    const receivers = [
      ...new Set(
        Object.values(this.db.shares)
          .filter((s) => s.sender_id === uid && s.status === 'active' && (s.expires_at === null || s.expires_at > now))
          .map((s) => s.receiver_id),
      ),
    ];
    const to = receivers.filter((r) => parsePrivacy(this.db.users[r]?.privacy).movement_alerts);
    if (to.length === 0) return done('no_recipients');
    this.db.movement_cooldown[uid] = now;
    const data: Extract<PushData, { type: 'movement' }> = { type: 'movement', from: uid, kind: 'departed' };
    for (const r of to) this.push(r, { notification: movementPushText(me.display_name, 'departed'), data });
    return done('sent', to.length);
  }

  // --- Faz 7: etkinlikler -------------------------------------------------------------------------

  /** Firestore `events where member_ids array-contains uid orderBy updated_at desc limit 50`. */
  eventsOf(uid: UserId): EventDoc[] {
    return Object.values(this.db.events)
      .filter((e) => e.member_ids.includes(uid))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 50);
  }

  /** `users/{uid}/notices orderBy created_at desc limit NOTICE_LIST_LIMIT` (30 gün). */
  noticesOf(uid: UserId): EventNotice[] {
    const cutoff = Date.now() - NOTICE_RETENTION_MS;
    return (this.db.notices[uid] ?? []).filter((n) => n.created_at > cutoff).slice(0, NOTICE_LIST_LIMIT);
  }

  private eventCtx(doc: Pick<EventDoc, 'time_zone'>, now: EpochMs): EventCtx {
    return { now, offsetAt: offsetFnForTimeZone(doc.time_zone) };
  }

  /** Saatlik / günlük sayaç (backend `rate_limits`): doluysa `rate_limited`; dönen fonksiyon BAŞARIDA sayar. */
  private eventRate(uid: UserId, kind: 'create' | 'action', limit: number, windowMs: number, now: EpochMs): () => void {
    const key = `${uid}_${kind}_${Math.floor(now / windowMs)}`;
    const n = this.db.event_rate[key] ?? 0;
    if (n >= limit) fail('rate_limited');
    return () => {
      this.db.event_rate[key] = n + 1;
    };
  }

  private eventFail(r: Extract<EventResult, { ok: false }>): never {
    return fail(r.error, undefined, r.extra);
  }

  /** Davet edilebilirler (Faz 8 `canInvite`): bana `meetup_invite` vermiş, kabul edilmiş arkadaşlar. */
  private eventInvitees(owner: UserId, candidates: readonly UserId[]): { allowed: UserId[]; anyFriend: boolean } {
    const list = [...new Set(candidates)].filter((u) => u !== owner && this.db.users[u]);
    const friends = list.filter((u) => this.areFriends(owner, u));
    return { allowed: friends.filter((u) => canInvite(this.pair(owner, u))), anyFriend: friends.length > 0 };
  }

  private eventCreateCall(payload: unknown, uid: UserId, now: EpochMs): EventResponse {
    return this.createEventAs(uid, this.parse(EventCreateRequestSchema, payload), now);
  }

  private createEventAs(uid: UserId, d: z.output<typeof EventCreateRequestSchema>, now: EpochMs): EventResponse {
    const counted = this.eventRate(uid, 'create', EVENT_LIMITS.createsPerDay, DAY, now);
    const active = Object.values(this.db.events).filter((e) => e.owner_id === uid && isActiveEventStage(e.stage)).length;
    if (active >= EVENT_LIMITS.maxActivePerOwner) fail('event_limit_reached');
    const { allowed, anyFriend } = this.eventInvitees(uid, d.invitee_ids);
    if (allowed.length === 0) fail(anyFriend ? 'not_permitted' : 'not_friends');
    const names: Record<UserId, string> = {};
    for (const u of [uid, ...allowed]) names[u] = this.db.users[u]?.display_name ?? '';
    const id = `e${randomHex32().slice(0, 19)}`;
    const r = createEventDoc(
      id,
      uid,
      {
        title: d.title,
        description: d.description,
        date: d.date,
        time_zone: d.time_zone,
        invitee_ids: allowed,
        names,
        venue_options: d.venue_options,
        time_minutes: d.time_minutes,
        vote_window_ms: d.vote_window_ms,
      },
      { now, offsetAt: offsetFnForTimeZone(d.time_zone) },
    );
    if (!r.ok) return this.eventFail(r);
    counted();
    this.commitEvent(r.doc, r.effects, now);
    const asked = [...new Set(d.invitee_ids)].filter((u) => u !== uid).length;
    return { event: clone(r.doc), skipped_count: asked - allowed.length, server_now: now };
  }

  /** Backend `mutateEvent`: üye değilse / yoksa AYNI `event_not_found`; değişiklik yoksa yazma ve bildirim yok. */
  private mutateEvent(eventId: string, uid: UserId, now: EpochMs, action: EventAction, skipped = 0): EventResponse {
    const doc = this.db.events[eventId];
    if (!doc || !doc.member_ids.includes(uid)) return fail('event_not_found');
    const counted = this.eventRate(uid, 'action', EVENT_LIMITS.actionsPerHour, HOUR, now);
    const r = reduceEvent(doc, uid, action, this.eventCtx(doc, now));
    if (!r.ok) return this.eventFail(r);
    counted();
    if (r.changed) this.commitEvent(r.doc, r.effects, now);
    return { event: clone(r.doc), skipped_count: skipped, server_now: now };
  }

  private eventInviteAddCall(payload: unknown, uid: UserId, now: EpochMs): EventResponse {
    const d = this.parse(EventInviteAddRequestSchema, payload);
    const doc = this.db.events[d.event_id];
    if (!doc || !doc.member_ids.includes(uid)) return fail('event_not_found');
    if (doc.owner_id !== uid) return fail('event_not_owner');
    const fresh = [...new Set(d.invitee_ids)].filter((u) => u !== doc.owner_id && !doc.invitee_ids.includes(u));
    const { allowed, anyFriend } = this.eventInvitees(uid, fresh);
    if (fresh.length > 0 && allowed.length === 0) return fail(anyFriend ? 'not_permitted' : 'not_friends');
    const names: Record<UserId, string> = {};
    for (const u of allowed) names[u] = this.db.users[u]?.display_name ?? '';
    return this.mutateEvent(d.event_id, uid, now, { type: 'invite_add', invitee_ids: allowed, names }, fresh.length - allowed.length);
  }

  /** Belge + hatırlatıcılar + bildirim kutusu + push (backend `commitResult`); sonra bot adımları planlanır. */
  private commitEvent(doc: EventDoc, effects: readonly EventEffect[], now: EpochMs): void {
    this.db.events[doc.event_id] = clone(doc);
    this.writeEventReminders(doc, effects);
    for (const o of this.eventOutgoing(doc, effects)) this.deliverEventNotice(o, now);
    this.scheduleEventBots(doc, now);
  }

  /** Backend `eventOutgoing`: alıcılar üyelerle sınırlı ve tekil; metinler core push metinleri. */
  private eventOutgoing(doc: EventDoc, effects: readonly EventEffect[]): EventOutgoing[] {
    const members = new Set(doc.member_ids);
    const ownerName = doc.names[doc.owner_id] ?? '';
    const out: EventOutgoing[] = [];
    for (const e of effects) {
      if (e.type === 'reminders') continue;
      const to = [...new Set(e.to)].filter((u) => members.has(u));
      if (to.length === 0) continue;
      const id = doc.event_id;
      switch (e.type) {
        case 'invite':
          out.push({ to, type: 'event_invite', text: eventInvitePushText(ownerName, doc), data: { type: 'event_invite', event_id: id, from: doc.owner_id } });
          break;
        case 'stage':
          out.push({ to, type: 'event_stage', text: eventStagePushText(e.notice, doc), data: { type: 'event_stage', event_id: id, notice: e.notice } });
          break;
        case 'rsvp':
          out.push({
            to,
            type: 'event_rsvp',
            text: eventRsvpPushText(doc.names[e.by] ?? '', doc, e.status, e.note),
            data: { type: 'event_rsvp', event_id: id, by: e.by, round: e.round, status: e.status },
          });
          break;
        case 'cancelled':
          out.push({ to, type: 'event_cancelled', text: eventCancelledPushText(ownerName, doc), data: { type: 'event_cancelled', event_id: id } });
          break;
      }
    }
    return out;
  }

  private deliverEventNotice(o: EventOutgoing, now: EpochMs): void {
    for (const u of o.to) {
      const notice: EventNotice = { notice_id: `n${randomHex32().slice(0, 19)}`, type: o.type, event_id: o.data.event_id, title: o.text.title, body: o.text.body, created_at: now };
      this.db.notices[u] = [notice, ...(this.db.notices[u] ?? [])].slice(0, NOTICE_LIST_LIMIT * 2);
      this.push(u, { notification: o.text, data: o.data });
    }
  }

  /** Backend `writeReminders`: listede olmayan türler iptal, olanlar (yeniden) planlanır. */
  private writeEventReminders(doc: EventDoc, effects: readonly EventEffect[]): void {
    const eff = [...effects].reverse().find((e): e is Extract<EventEffect, { type: 'reminders' }> => e.type === 'reminders');
    if (!eff) return;
    for (const kind of EVENT_REMINDER_KINDS) {
      const id = eventReminderId(doc.event_id, kind);
      const item = eff.items.find((i) => i.kind === kind);
      if (!item || doc.starts_at === null) {
        delete this.db.event_reminders[id];
        continue;
      }
      this.db.event_reminders[id] = { event_id: doc.event_id, kind, due_at: item.due_at, starts_at: doc.starts_at, sent: false, sent_at: null, outcome: null };
    }
  }

  /** Backend `fireReminder`: etkinlik hâlâ `final` ve başlangıç aynıysa; 2 sa'ten geç kalan `stale`. */
  private fireEventReminder(id: string, now: EpochMs): void {
    const rem = this.db.event_reminders[id];
    if (!rem || rem.sent) return;
    const doc = this.db.events[rem.event_id];
    if (!doc || doc.stage !== 'final' || doc.starts_at !== rem.starts_at) {
      delete this.db.event_reminders[id];
      return;
    }
    if (now - rem.due_at > EVENT_REMINDER_MAX_LATENESS_MS || now >= doc.starts_at) {
      Object.assign(rem, { sent: true, sent_at: now, outcome: 'stale' });
      return;
    }
    this.deliverEventNotice(
      {
        to: eventReminderRecipients(doc),
        type: 'event_reminder',
        text: eventReminderPushText(rem.kind, doc),
        data: { type: 'event_reminder', event_id: doc.event_id, kind: rem.kind },
      },
      now,
    );
    Object.assign(rem, { sent: true, sent_at: now, outcome: 'sent' });
  }

  /** Sistem eylemi (tick / üye çıkarma): değiştiyse yazar ve bildirir. */
  private applyEventSystem(eventId: string, action: EventAction, now: EpochMs): boolean {
    const doc = this.db.events[eventId];
    if (!doc) return false;
    const r = reduceEvent(doc, 'system', action, this.eventCtx(doc, now));
    if (!r.ok || !r.changed) return false;
    this.commitEvent(r.doc, r.effects, now);
    return true;
  }

  /** Backend `removePairFromEvents`: sahibi biri, davetlisi diğeri olan etkin etkinliklerden davetli çıkar. */
  private removePairFromEvents(a: UserId, b: UserId, now: EpochMs): void {
    for (const doc of Object.values(this.db.events)) {
      if (!isActiveEventStage(doc.stage) || !doc.member_ids.includes(a) || !doc.member_ids.includes(b)) continue;
      const target = doc.owner_id === a ? b : doc.owner_id === b ? a : null;
      if (target) this.applyEventSystem(doc.event_id, { type: 'remove_member', uid: target }, now);
    }
  }

  /** Süpürücü: aşama süreleri, hatırlatmalar, bot adımları. */
  private sweepPhase7(now: EpochMs): boolean {
    let changed = false;
    for (const doc of Object.values(this.db.events)) {
      if (!isActiveEventStage(doc.stage)) continue;
      const at = eventNextActionAt(doc);
      if (at !== null && at <= now && this.applyEventSystem(doc.event_id, { type: 'tick' }, now)) changed = true;
    }
    for (const [id, rem] of Object.entries(this.db.event_reminders)) {
      if (rem.sent || rem.due_at > now) continue;
      this.fireEventReminder(id, now);
      changed = true;
    }
    for (const [key, at] of Object.entries(this.db.event_auto)) {
      if (at > now) continue;
      delete this.db.event_auto[key];
      changed = true;
      const [id, bot] = key.split('|');
      const doc = id ? this.db.events[id] : undefined;
      if (!doc || !bot) continue;
      const action = this.botEventAction(doc, bot, now);
      if (!action) continue;
      const r = reduceEvent(doc, bot, action, this.eventCtx(doc, now));
      if (r.ok && r.changed) this.commitEvent(r.doc, r.effects, now);
    }
    return changed;
  }

  private prunePhase7(now: EpochMs): boolean {
    let changed = false;
    for (const doc of Object.values(this.db.events)) {
      if (isActiveEventStage(doc.stage) || (doc.ended_at ?? doc.updated_at) + EVENT_LIMITS.retentionMs > now) continue;
      delete this.db.events[doc.event_id];
      changed = true;
    }
    for (const [id, rem] of Object.entries(this.db.event_reminders)) {
      if (rem.starts_at + DAY > now && this.db.events[rem.event_id]) continue;
      delete this.db.event_reminders[id];
      changed = true;
    }
    const cutoff = now - NOTICE_RETENTION_MS;
    for (const [uid, list] of Object.entries(this.db.notices)) {
      const kept = list.filter((n) => n.created_at > cutoff);
      if (kept.length === list.length) continue;
      this.db.notices[uid] = kept;
      changed = true;
    }
    for (const key of Object.keys(this.db.event_rate)) {
      const parts = key.split('_');
      const win = parts[parts.length - 2] === 'create' ? DAY : HOUR;
      if ((Number(parts[parts.length - 1]) + 1) * win > now) continue;
      delete this.db.event_rate[key];
      changed = true;
    }
    for (const [uid, at] of Object.entries(this.db.movement_cooldown)) {
      if (now - at <= MOVEMENT_LIMITS.cooldownMs) continue;
      delete this.db.movement_cooldown[uid];
      changed = true;
    }
    return changed;
  }

  /** Demo: bot üyelerin sıradaki adımı (varsa) birkaç saniye sonraya planlanır. */
  private scheduleEventBots(doc: EventDoc, now: EpochMs): void {
    if (!isActiveEventStage(doc.stage)) return;
    doc.member_ids.forEach((u, i) => {
      if (!this.db.bots[u]) return;
      const key = `${doc.event_id}|${u}`;
      if (this.db.event_auto[key] !== undefined || !this.botEventAction(doc, u, now)) return;
      this.db.event_auto[key] = now + (4 + ((i * 3) % 7)) * SECOND;
    });
  }

  /**
   * Demo botunun etkinlikteki sıradaki adımı: davetli yanıt verir (Can "Katılamayacağım" + not), bir mekan önerir, oy
   * verir, son onayı verir. Bot sahip: herkes yanıtlayınca mekan oylamasını açar, oy verir, eşitlikte ilk lideri seçer,
   * saat seçeneği yoksa ekler. Yapacak bir şey yoksa null.
   */
  private botEventAction(doc: EventDoc, bot: UserId, now: EpochMs): EventAction | null {
    const isOwner = bot === doc.owner_id;
    const going = isOwner || doc.rsvp[bot]?.status === 'going';
    const seed = [...bot].reduce((a, c) => a + c.charCodeAt(0), 0);
    switch (doc.stage) {
      case 'rsvp': {
        if (isOwner) {
          const ready =
            doc.venue_options.length === EVENT_LIMITS.venueOptions && doc.invitee_ids.every((u) => doc.rsvp[u]) && doc.invitee_ids.some((u) => doc.rsvp[u]?.status === 'going');
          return ready ? { type: 'open_venue_vote', vote_window_ms: null } : null;
        }
        if (!doc.rsvp[bot]) {
          return bot === PEOPLE.can.uid ? { type: 'rsvp', round: 'initial', status: 'not_going', note: CAN_EVENT_NOTE } : { type: 'rsvp', round: 'initial', status: 'going', note: null };
        }
        const venue = BOT_EVENT_VENUES[bot];
        const free = doc.venue_options.length < EVENT_LIMITS.venueOptions;
        const fresh = venue && !doc.venue_options.some((o) => o.proposed_by === bot || o.name.toLocaleLowerCase('tr') === venue.name.toLocaleLowerCase('tr'));
        return going && free && venue && fresh ? { type: 'venue_propose', venue } : null;
      }
      case 'venue_vote':
      case 'time_vote': {
        const kind = doc.stage === 'venue_vote' ? 'venue' : 'time';
        if (kind === 'time' && doc.stage_deadline_at === null) {
          if (!isOwner) return null;
          const offsetAt = offsetFnForTimeZone(doc.time_zone);
          const minutes = BOT_TIME_CANDIDATES.filter((m) => localDateTimeToEpoch(doc.date, m, offsetAt) >= now + EVENT_LIMITS.minLeadMs + 5 * MINUTE).slice(0, 3);
          return minutes.length >= EVENT_LIMITS.minTimeOptions ? { type: 'time_options_set', minutes } : null;
        }
        if (!going) return null;
        const t = eventTally(doc, kind, now);
        const ids = Object.keys(t.counts);
        const votes = kind === 'venue' ? doc.venue_votes : doc.time_votes;
        if (!votes[bot] && ids.length > 0) return { type: 'vote', kind, option_id: ids[seed % ids.length] as string };
        if (isOwner && t.eligible > 0 && t.total === t.eligible && t.leaders.length > 1) return { type: 'close_vote', kind, tie_break_option_id: t.leaders[0] ?? null };
        return null;
      }
      case 'final': {
        if (isOwner || doc.final_rsvp[bot] || (doc.starts_at !== null && now >= doc.starts_at)) return null;
        const first = doc.rsvp[bot];
        return first?.status === 'not_going' ? { type: 'rsvp', round: 'final', status: 'not_going', note: first.note } : { type: 'rsvp', round: 'final', status: 'going', note: null };
      }
      default:
        return null;
    }
  }

  // --- Faz 7 demo paneli --------------------------------------------------------------------------

  /** "Ayşe etkinliğe davet etsin": yarın için 3 mekanlı, 2 saat seçenekli etkinlik; bana davet. Dönen: hata kodu ya da kimlik. */
  botCreateEvent(bot: UserId): { ok: true; event_id: string } | { ok: false; code: ErrorCode } {
    const now = Date.now();
    const tz = this.db.users[bot]?.time_zone ?? DEFAULT_TZ;
    const date = addDaysToDate(localDateOf(now, offsetFnForTimeZone(tz)), 1);
    try {
      const r = this.createEventAs(
        bot,
        {
          op_id: uuidV4(),
          title: 'Moda’da kahvaltı',
          description: 'Uzun zamandır toplanamadık. Yarın kahvaltıda buluşalım mı? Mekanı ve saati birlikte seçelim.',
          date,
          time_zone: tz,
          invitee_ids: [DEMO_ME],
          venue_options: AYSE_EVENT_VENUES.map((v) => ({ name: v.name, address: v.address ?? null, location: v.location ?? null, place_id: v.place_id ?? null })),
          time_minutes: [10 * 60, 11 * 60 + 30],
          vote_window_ms: 2 * HOUR,
        },
        now,
      );
      this.commit();
      return { ok: true, event_id: r.event.event_id };
    } catch (e) {
      return { ok: false, code: e instanceof DemoHttpsError ? e.details.code : 'internal' };
    }
  }

  /** "Hatırlatmayı şimdi gönder": üyesi olduğum her kesinleşmiş etkinliğin sıradaki hatırlatması hemen gider. */
  fireMyEventRemindersNow(): number {
    const now = Date.now();
    const next = new Map<string, string>();
    for (const [id, rem] of Object.entries(this.db.event_reminders)) {
      const doc = this.db.events[rem.event_id];
      if (rem.sent || !doc || !doc.member_ids.includes(DEMO_ME)) continue;
      const cur = next.get(rem.event_id);
      if (!cur || (this.db.event_reminders[cur]?.due_at ?? Infinity) > rem.due_at) next.set(rem.event_id, id);
    }
    for (const id of next.values()) this.fireEventReminder(id, now);
    if (next.size) this.commit();
    return next.size;
  }

  /** "Mehmet yola çıksın": botun hareket raporu (demo: soğuma sıfırlanır). */
  botDeparture(bot: UserId): MovementReportResponse['status'] {
    const now = Date.now();
    delete this.db.movement_cooldown[bot];
    const r = this.movementNow(bot, now, now);
    this.commit();
    return r.status;
  }

  private f7View(): DemoSnapshot['f7'] {
    const now = Date.now();
    const mine = Object.values(this.db.events).filter((e) => e.member_ids.includes(DEMO_ME));
    const pending = Object.values(this.db.event_reminders).filter((r) => !r.sent && mine.some((e) => e.event_id === r.event_id));
    const nextRem = pending.sort((a, b) => a.due_at - b.due_at)[0] ?? null;
    return {
      activeEvents: mine.filter((e) => isActiveEventStage(e.stage)).length,
      pendingReminders: pending.length,
      nextReminderAt: nextRem?.due_at ?? null,
      privacy: parsePrivacy(this.db.users[DEMO_ME]?.privacy),
      lastMovement: this.db.movement_last,
      movementCooldownLeftMs: Math.max(0, (this.db.movement_cooldown[DEMO_ME] ?? 0) + MOVEMENT_LIMITS.cooldownMs - now),
    };
  }

  snapshot(): DemoSnapshot {
    const deliveries: DemoSnapshot['myDeliveries'] = [];
    for (const [receiver, inbox] of Object.entries(this.db.live)) {
      if (receiver === DEMO_ME) continue; // kendi gelen kutum (botların paketleri)
      const copy = inbox[shareId(DEMO_ME, receiver)];
      if (!copy) continue;
      deliveries.push({
        receiverId: receiver,
        name: this.db.users[receiver]?.display_name ?? receiver,
        timestamp: copy.timestamp as number,
        battery: typeof copy.battery_pct === 'number' ? copy.battery_pct : null,
        expiresAt: typeof copy.expires_at === 'number' ? copy.expires_at : null,
      });
    }
    deliveries.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    const now = Date.now();
    const q = this.db.maps_quota[`${DEMO_ME}_${quotaDay(now)}`];
    return {
      myDeliveries: deliveries,
      myActiveShares: this.myShortenableShares(),
      ayseSharing: this.isSharingWithMe(PEOPLE.ayse.uid),
      mehmetSharing: this.isSharingWithMe(PEOPLE.mehmet.uid),
      myActiveLinks: Object.values(this.db.links).filter((l) => l.sender_id === DEMO_ME && this.isLinkLive(l, now)).length,
      linkViewers: this.linkListeners,
      myLiveTargets:
        Object.values(this.db.shares).filter((s) => s.sender_id === DEMO_ME && s.status === 'active' && (s.expires_at === null || s.expires_at > now)).length +
        Object.values(this.db.links).filter((l) => l.sender_id === DEMO_ME && this.isLinkLive(l, now)).length,
      ayseBattery: this.db.bots[PEOPLE.ayse.uid]?.battery ?? null,
      mehmetOffline: this.db.bots[PEOPLE.mehmet.uid]?.offline === true,
      batteryNotice: this.db.battery_notice,
      receiverView: this.receiverView(),
      f4: this.f4View(),
      f5: this.f5View(),
      f6: this.f6View(),
      f7: this.f7View(),
      f8: this.f8View(),
      mapsDown: this.db.maps_down,
      maps: {
        route: q?.route ?? 0,
        routeHits: q?.route_hits ?? 0,
        geocode: q?.geocode ?? 0,
        geocodeHits: q?.geocode_hits ?? 0,
        routeLimit: MAPS_DAILY_LIMITS.route,
        geocodeLimit: MAPS_DAILY_LIMITS.geocode,
      },
    };
  }

  /** Demo sunucusunu sıfırlar (kalıcı durum silinir; uygulama tarafını kabuk temizler). */
  reset(): void {
    this.disposed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    for (const s of this.subs) s.live = false;
    this.subs.clear();
    safeStorage.remove(DEMO_STORAGE_KEY);
    this.avatars.reset();
  }
}
