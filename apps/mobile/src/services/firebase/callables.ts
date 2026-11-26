/**
 * Cloud Functions callable sarmalayıcıları (bölge: europe-west1).
 *
 *  - Her komut bir `op_id` (core `uuidV4`) taşır; aynı op_id ile tekrar deneme sunucuda bir kez uygulanır.
 *  - Girdi göndermeden ÖNCE core zod şemalarıyla doğrulanır (bozuk istek ağa çıkmaz).
 *  - `HttpsError.details.code` → core `ERROR_CODES` (bkz. lib/errors.ts).
 *  - Yanıtlar yerel şemalarla doğrulanır (core yanıt şeması sağlamıyor → core_requests).
 *    Faz 2 callable'larının (bağlantı, rota, adres) yanıt şemaları core'dan gelir.
 */
import {
  CALLABLES,
  GeocodeReverseRequestSchema,
  GeocodeReverseResponseSchema,
  LinkShareCreateRequestSchema,
  LinkShareCreateResponseSchema,
  LinkShareExtendRequestSchema,
  LinkShareExtendResponseSchema,
  LinkShareStopRequestSchema,
  LinkShareStopResponseSchema,
  RouteComputeRequestSchema,
  RouteComputeResponseSchema,
  FriendRequestRespondSchema,
  FriendRequestSendSchema,
  ShareExtendRequestSchema,
  ShareRevokeRequestSchema,
  ShareStartRequestSchema,
  ShareStopRequestSchema,
  uuidV4,
  type CallableName,
  BatteryLowNotifyRequestSchema,
  BatteryLowNotifyResponseSchema,
  type BatteryLowNotifyRequest,
  type BatteryLowNotifyResponse,
  type DurationChoice,
  type ExtensionMinutes,
  type FriendRequestSendResponse,
  type GeocodeReverseResponse,
  type LatLng,
  type LinkShareCreateResponse,
  type LinkShareExtendResponse,
  type LinkShareStopResponse,
  type RouteComputeResponse,
  type TravelMode,
  type ShareExtendResponse,
  type ShareStartRequest,
  type ShareStartResponse,
  type ShareStopResponse,
  type UserId,
  // Faz 4
  EmergencyContactsSetRequestSchema,
  EmergencyContactsSetResponseSchema,
  PingSendRequestSchema,
  PingSendResponseSchema,
  PlaceNoteDeleteRequestSchema,
  PlaceNoteDeleteResponseSchema,
  PlaceNoteUpsertRequestSchema,
  PlaceNoteUpsertResponseSchema,
  SosAckRequestSchema,
  SosAlertResponseSchema,
  SosResolveRequestSchema,
  SosSendRequestSchema,
  SosSendResponseSchema,
  SosUpdateRequestSchema,
  type EmergencyContactsSetRequest,
  type EmergencyContactsSetResponse,
  type PingSendRequest,
  type PingSendResponse,
  type PlaceNoteDeleteRequest,
  type PlaceNoteDeleteResponse,
  type PlaceNoteUpsertRequest,
  type PlaceNoteUpsertResponse,
  type SosAckRequest,
  type SosAlertResponse,
  type SosResolveRequest,
  type SosSendRequest,
  type SosSendResponse,
  type SosUpdateRequest,
  // Faz 5
  MeetupCancelRequestSchema,
  MeetupRespondRequestSchema,
  MeetupResponseSchema,
  MeetupShareRequestSchema,
  MeetupSuggestRequestSchema,
  MeetupSuggestResponseSchema,
  ZoneDeleteRequestSchema,
  ZoneDeleteResponseSchema,
  ZoneEventReportRequestSchema,
  ZoneEventReportResponseSchema,
  ZoneUpsertRequestSchema,
  ZoneUpsertResponseSchema,
  type MeetupCancelRequest,
  type MeetupRespondRequest,
  type MeetupResponse,
  type MeetupShareRequest,
  type MeetupSuggestRequest,
  type MeetupSuggestResponse,
  type ZoneDeleteRequest,
  type ZoneDeleteResponse,
  type ZoneEventReportRequest,
  type ZoneEventReportResponse,
  type ZoneUpsertRequest,
  type ZoneUpsertResponse,
  // Faz 6
  FavoritesSetRequestSchema,
  FavoritesSetResponseSchema,
  WidgetTokenIssueRequestSchema,
  WidgetTokenIssueResponseSchema,
  WidgetTokenRevokeRequestSchema,
  WidgetTokenRevokeResponseSchema,
  type FavoritesSetResponse,
  type Gender,
  type WidgetTokenIssueResponse,
  type WidgetTokenRevokeResponse,
  // Faz 8
  ConsentAcceptRequestSchema,
  ConsentWithdrawSchema,
  InvisibleSetRequestSchema,
  PermissionRequestRespondSchema,
  PermissionRequestSendSchema,
  PermissionSetSchema,
  type ConsentAcceptRequest,
  type ConsentAcceptResponse,
  type ConsentWithdrawResponse,
  type InvisibleSetRequest,
  type InvisibleSetResponse,
  type PermissionRequestRespondRequest,
  type PermissionRequestRespondResponse,
  type PermissionRequestSendRequest,
  type PermissionRequestSendResponse,
  type PermissionSetRequest,
  type PermissionSetResponse,
  LocationRequestCancelSchema,
  LocationRequestRespondSchema,
  LocationRequestSendSchema,
  type LocationRequestCancelResponse,
  type LocationRequestRespondResponse,
  type LocationRequestSendResponse,
  EventCancelRequestSchema,
  EventCreateRequestSchema,
  EventFinalizeRequestSchema,
  EventInviteAddRequestSchema,
  EventOptionsSetRequestSchema,
  EventRespondRequestSchema,
  EventResponseSchema,
  EventUpdateRequestSchema,
  MovementReportRequestSchema,
  MovementReportResponseSchema,
  PrivacySettingsResponseSchema,
  PrivacySettingsSetRequestSchema,
  type EventCancelRequest,
  type EventCreateRequest,
  type EventFinalizeRequest,
  type EventInviteAddRequest,
  type EventOptionsSetRequest,
  type EventRespondRequest,
  type EventResponse,
  type EventUpdateRequest,
  type MovementReportRequest,
  type MovementReportResponse,
  type PrivacySettingsResponse,
  type PrivacySettingsSetRequest,
  // Faz 9
  ApproachReportRequestSchema,
  ApproachReportResponseSchema,
  ProofCreateRequestSchema,
  ProofCreateResponseSchema,
  ProofDeleteRequestSchema,
  ProofDeleteResponseSchema,
  ProofGetRequestSchema,
  ProofGetResponseSchema,
  SafeReturnCheckInRequestSchema,
  SafeReturnIdRequestSchema,
  SafeReturnResponseSchema,
  SafeReturnStartRequestSchema,
  SafeReturnUpdateRequestSchema,
  type ApproachReportRequest,
  type ApproachReportResponse,
  type ProofCreateRequest,
  type ProofCreateResponse,
  type ProofDeleteRequest,
  type ProofDeleteResponse,
  type ProofGetRequest,
  type ProofGetResponse,
  type SafeReturnCancelRequest,
  type SafeReturnCheckInRequest,
  type SafeReturnExtendRequest,
  type SafeReturnResponse,
  type SafeReturnStartRequest,
  type SafeReturnUpdateRequest,
} from '@konum/core';
import { z } from 'zod';
import { KonumError, toKonumError } from '../../lib/errors';
import {
  ConsentAcceptResponseSchema,
  ConsentWithdrawResponseSchema,
  FriendRequestSendResponseSchema,
  InvisibleSetResponseSchema,
  OkResponseSchema,
  PermissionRequestRespondResponseSchema,
  PermissionRequestSendResponseSchema,
  PermissionSetResponseSchema,
  ShareExtendResponseSchema,
  ShareRevokeResponseSchema,
  ShareStartResponseSchema,
  ShareStopResponseSchema,
  UserBootstrapRequestSchema,
  UserBootstrapResponseSchema,
  LocationRequestCancelResponseSchema,
  LocationRequestRespondResponseSchema,
  LocationRequestSendResponseSchema,
} from '../../lib/schemas';
import { defaultCallTransport, type CallTransport } from './callTransport';

export type { CallTransport } from './callTransport';

/** [Varsayım] Yalnızca geçici hatalarda (unavailable / internal) aynı op_id ile yeniden deneme. */
const RETRY_BACKOFF_MS = [800, 2_500] as const;

let transport: CallTransport = defaultCallTransport;

/** Testler ve emülatör senaryoları için taşıma katmanını değiştirir. */
export function setCallTransport(next: CallTransport | null): void {
  transport = next ?? defaultCallTransport;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function invoke<Out>(name: CallableName, requestSchema: z.ZodType, input: unknown, responseSchema: z.ZodType<Out>): Promise<Out> {
  const req = requestSchema.safeParse(input);
  if (!req.success) throw new KonumError('invalid_argument');
  for (let attempt = 0; ; attempt++) {
    let data: unknown;
    try {
      data = await transport(name, req.data);
    } catch (e) {
      const err = toKonumError(e);
      const backoff = RETRY_BACKOFF_MS[attempt];
      const transient = err.code === 'unavailable' || err.code === 'internal';
      if (!transient || backoff === undefined) throw err;
      await sleep(backoff);
      continue;
    }
    const res = responseSchema.safeParse(data);
    // Beklenmeyen yanıt şekli: tekrar denemek anlamsız (sunucu sürüm uyumsuzluğu).
    if (!res.success) throw new KonumError('internal', undefined, false);
    return res.data;
  }
}

// --- paylaşım -------------------------------------------------------------------

export function shareStart(input: Omit<ShareStartRequest, 'op_id'> & { op_id?: string }): Promise<ShareStartResponse> {
  return invoke(CALLABLES.shareStart, ShareStartRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ShareStartResponseSchema);
}

export function shareExtend(input: { session_id: string; minutes: ExtensionMinutes; op_id?: string }): Promise<ShareExtendResponse> {
  return invoke(CALLABLES.shareExtend, ShareExtendRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ShareExtendResponseSchema);
}

export function shareStop(input: { session_id: string; receiver_ids?: UserId[]; op_id?: string }): Promise<ShareStopResponse> {
  return invoke(CALLABLES.shareStop, ShareStopRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ShareStopResponseSchema);
}

/** Alıcı: "Görmeyi bırak". Gönderenin paylaşımı `revoked_by_receiver` ile biter. */
export function shareRevoke(input: { sender_id: UserId; op_id?: string }) {
  return invoke(CALLABLES.shareRevoke, ShareRevokeRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ShareRevokeResponseSchema);
}

// --- kullanıcı / arkadaşlık ----------------------------------------------------------

/**
 * Faz 6: `gender` profil OLUŞTURULURKEN zorunlu (yoksa `gender_required`), sonra isteğe bağlı; `avatar_url` +
 * `avatar_thumb_url` aynı sürümün iki boyu (`null` fotoğrafı kaldırır). Verilmeyen alan sunucuda değişmez.
 */
export function userBootstrap(input: {
  display_name?: string;
  time_zone: string;
  op_id?: string;
  gender?: Gender;
  avatar_url?: string | null;
  avatar_thumb_url?: string | null;
}) {
  return invoke(CALLABLES.userBootstrap, UserBootstrapRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, UserBootstrapResponseSchema);
}

export function friendRequestSendByInviteCode(inviteCode: string): Promise<FriendRequestSendResponse> {
  return invoke(
    CALLABLES.friendRequestSend,
    FriendRequestSendSchema,
    { op_id: uuidV4(), via: 'invite_code', invite_code: inviteCode },
    FriendRequestSendResponseSchema,
  );
}

export function friendRequestRespond(friendshipId: string, accept: boolean) {
  return invoke(CALLABLES.friendRequestRespond, FriendRequestRespondSchema, { op_id: uuidV4(), friendship_id: friendshipId, accept }, OkResponseSchema);
}

/** [Varsayım] core'da şema yok: { op_id, friendship_id }. */
const FriendshipOpSchema = z.object({ op_id: z.uuid(), friendship_id: z.string().min(1).max(300) });

const OutgoingCancelSchema = z.object({ op_id: z.uuid(), outgoing_id: z.string().regex(/^[0-9a-f]{32}$/) });

/** Giden isteği iptal eder. Hedefin kim olduğu istemcide bilinmez; yalnızca giden kaydın kimliği gönderilir. */
export function friendRequestCancel(outgoingId: string) {
  return invoke(CALLABLES.friendRequestCancel, OutgoingCancelSchema, { op_id: uuidV4(), outgoing_id: outgoingId }, OkResponseSchema);
}

export function friendshipRemove(friendshipId: string) {
  return invoke(CALLABLES.friendshipRemove, FriendshipOpSchema, { op_id: uuidV4(), friendship_id: friendshipId }, OkResponseSchema);
}

// --- Faz 2: bağlantı (QR) ile paylaşım ------------------------------------------------------

/**
 * Yeni bağlantı. Düz token YALNIZCA bu yanıtta gelir (sunucu yalnızca özetini saklar); çağıran
 * token'ı güvenli depoya yazar (bkz. services/security/linkTokenVault.ts).
 */
export function linkShareCreate(input: { duration: DurationChoice; time_zone: string; op_id?: string }): Promise<LinkShareCreateResponse> {
  return invoke(CALLABLES.linkShareCreate, LinkShareCreateRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, LinkShareCreateResponseSchema);
}

export function linkShareExtend(input: { link_id: string; minutes: ExtensionMinutes; op_id?: string }): Promise<LinkShareExtendResponse> {
  return invoke(CALLABLES.linkShareExtend, LinkShareExtendRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, LinkShareExtendResponseSchema);
}

/** Sunucu: Firestore commit → `link_acl` mezar taşı → `link_live` silinir (aynı çağrıda). */
export function linkShareStop(input: { link_id: string; op_id?: string }): Promise<LinkShareStopResponse> {
  return invoke(CALLABLES.linkShareStop, LinkShareStopRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, LinkShareStopResponseSchema);
}

/** Bağlantı deposunun bağımlılığı (testlerde sahte uygulanır). */
export interface LinkApi {
  linkShareCreate: typeof linkShareCreate;
  linkShareExtend: typeof linkShareExtend;
  linkShareStop: typeof linkShareStop;
}

export const linkApi: LinkApi = { linkShareCreate, linkShareExtend, linkShareStop };

// --- Faz 2: rota ve adres (Google API anahtarı yalnızca sunucuda) ---------------------------------

/** Routes API sunucu üzerinden. İstemci yalnızca core `shouldRecomputeRoute` true iken çağırır (routesRepo). */
export function routeCompute(input: { origin: LatLng; destination: LatLng; travel_mode: TravelMode; op_id?: string }): Promise<RouteComputeResponse> {
  return invoke(CALLABLES.routeCompute, RouteComputeRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, RouteComputeResponseSchema);
}

/** Ters geocode sunucu üzerinden (sunucu hücre merkezini sorar). İstemci core `shouldReverseGeocode` ile çağırır. */
export function geocodeReverse(input: LatLng): Promise<GeocodeReverseResponse> {
  return invoke(CALLABLES.geocodeReverse, GeocodeReverseRequestSchema, { lat: input.lat, lng: input.lng }, GeocodeReverseResponseSchema);
}

/** Store'ların bağımlılık olarak aldığı paylaşım API'si (testlerde sahte uygulanır). */
export interface SharingApi {
  shareStart: typeof shareStart;
  shareExtend: typeof shareExtend;
  shareStop: typeof shareStop;
}

export const sharingApi: SharingApi = { shareStart, shareExtend, shareStop };

// --- Faz 3: düşük pil bildirimi -------------------------------------------------------------------

/**
 * `battery_low_notify` (core `CALLABLES.batteryLowNotify`, şema core `BatteryLowNotifyRequestSchema`). OTURUM başına:
 *  - core `lowBatteryTrigger` `fire: true` → alıcılara FCM (koordinat YOK; sunucu da bir kez / 30 dk kuralını uygular),
 *  - tetikleyici yeniden kurulduğunda (≥ %20 ya da şarj) ve bu oturumda bildirim gittiyse → sunucu durumu yeniden kurulur.
 * Aynı `op_id` ile tekrar sunucuda bir kez uygulanır (çevrimdışı kuyruk aynı op_id ile yeniden dener).
 */
export const BATTERY_LOW_NOTIFY: CallableName = CALLABLES.batteryLowNotify;
export { BatteryLowNotifyRequestSchema };
export type { BatteryLowNotifyRequest };

export function batteryLowNotify(input: BatteryLowNotifyRequest): Promise<BatteryLowNotifyResponse> {
  return invoke(BATTERY_LOW_NOTIFY, BatteryLowNotifyRequestSchema, input, BatteryLowNotifyResponseSchema);
}

// --- Faz 4: ping, notlar, acil durum (SOS) ---------------------------------------------------------

/**
 * Faz 4 callable'ları (core `CALLABLES.pingSend` … `sosAck`; istek/yanıt şemaları core'dan). Hepsi `op_id` taşır:
 * aynı op_id ile tekrar sunucuda bir kez uygulanır (SOS gönderimi ağ hatasında aynı op_id ile yeniden denenir).
 */
type WithOp<T extends { op_id: string }> = Omit<T, 'op_id'> & { op_id?: string };

export function pingSend(input: WithOp<PingSendRequest>): Promise<PingSendResponse> {
  return invoke(CALLABLES.pingSend, PingSendRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, PingSendResponseSchema);
}

export function placeNoteUpsert(input: WithOp<PlaceNoteUpsertRequest>): Promise<PlaceNoteUpsertResponse> {
  return invoke(CALLABLES.placeNoteUpsert, PlaceNoteUpsertRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, PlaceNoteUpsertResponseSchema);
}

export function placeNoteDelete(input: WithOp<PlaceNoteDeleteRequest>): Promise<PlaceNoteDeleteResponse> {
  return invoke(CALLABLES.placeNoteDelete, PlaceNoteDeleteRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, PlaceNoteDeleteResponseSchema);
}

export function emergencyContactsSet(input: WithOp<EmergencyContactsSetRequest>): Promise<EmergencyContactsSetResponse> {
  return invoke(
    CALLABLES.emergencyContactsSet,
    EmergencyContactsSetRequestSchema,
    { ...input, op_id: input.op_id ?? uuidV4() },
    EmergencyContactsSetResponseSchema,
  );
}

export function sosSend(input: WithOp<SosSendRequest>): Promise<SosSendResponse> {
  return invoke(CALLABLES.sosSend, SosSendRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, SosSendResponseSchema);
}

export function sosUpdate(input: WithOp<SosUpdateRequest>): Promise<SosAlertResponse> {
  return invoke(CALLABLES.sosUpdate, SosUpdateRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, SosAlertResponseSchema);
}

export function sosResolve(input: WithOp<SosResolveRequest>): Promise<SosAlertResponse> {
  return invoke(CALLABLES.sosResolve, SosResolveRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, SosAlertResponseSchema);
}

export function sosAck(input: WithOp<SosAckRequest>): Promise<SosAlertResponse> {
  return invoke(CALLABLES.sosAck, SosAckRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, SosAlertResponseSchema);
}

/** Faz 4 depolarının bağımlılıkları (testlerde sahte uygulanır). */
export interface PingApi {
  pingSend: typeof pingSend;
}
export const pingApi: PingApi = { pingSend };

export interface NotesApi {
  placeNoteUpsert: typeof placeNoteUpsert;
  placeNoteDelete: typeof placeNoteDelete;
}
export const notesApi: NotesApi = { placeNoteUpsert, placeNoteDelete };

export interface SosApi {
  emergencyContactsSet: typeof emergencyContactsSet;
  sosSend: typeof sosSend;
  sosUpdate: typeof sosUpdate;
  sosResolve: typeof sosResolve;
  sosAck: typeof sosAck;
}
export const sosApi: SosApi = { emergencyContactsSet, sosSend, sosUpdate, sosResolve, sosAck };

// --- Faz 5: bölgeler (geofence) ve buluşma noktası ---------------------------------------------------

/**
 * Faz 5 callable'ları (core `CALLABLES.zoneUpsert` … `meetupCancel`; istek/yanıt şemaları core'dan). Hepsi `op_id`
 * taşır. `zone_event_report` çevrimdışıysa zoneMonitor'ün kalıcı kuyruğundan AYNI op_id ile yeniden denenir
 * (sunucu bir kez uygular: ikinci bildirim gitmez, aynı `start_share` yanıtı döner).
 */
export function zoneUpsert(input: WithOp<ZoneUpsertRequest>): Promise<ZoneUpsertResponse> {
  return invoke(CALLABLES.zoneUpsert, ZoneUpsertRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ZoneUpsertResponseSchema);
}

export function zoneDelete(input: WithOp<ZoneDeleteRequest>): Promise<ZoneDeleteResponse> {
  return invoke(CALLABLES.zoneDelete, ZoneDeleteRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ZoneDeleteResponseSchema);
}

export function zoneEventReport(input: WithOp<ZoneEventReportRequest>): Promise<ZoneEventReportResponse> {
  return invoke(CALLABLES.zoneEventReport, ZoneEventReportRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ZoneEventReportResponseSchema);
}

export function meetupSuggest(input: WithOp<MeetupSuggestRequest>): Promise<MeetupSuggestResponse> {
  return invoke(CALLABLES.meetupSuggest, MeetupSuggestRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, MeetupSuggestResponseSchema);
}

export function meetupShare(input: WithOp<MeetupShareRequest>): Promise<MeetupResponse> {
  return invoke(CALLABLES.meetupShare, MeetupShareRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, MeetupResponseSchema);
}

export function meetupRespond(input: WithOp<MeetupRespondRequest>): Promise<MeetupResponse> {
  return invoke(CALLABLES.meetupRespond, MeetupRespondRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, MeetupResponseSchema);
}

export function meetupCancel(input: WithOp<MeetupCancelRequest>): Promise<MeetupResponse> {
  return invoke(CALLABLES.meetupCancel, MeetupCancelRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, MeetupResponseSchema);
}

/** Faz 5 depolarının bağımlılıkları (testlerde sahte uygulanır). */
export interface ZonesApi {
  zoneUpsert: typeof zoneUpsert;
  zoneDelete: typeof zoneDelete;
  zoneEventReport: typeof zoneEventReport;
}
export const zonesApi: ZonesApi = { zoneUpsert, zoneDelete, zoneEventReport };

export interface MeetupApi {
  meetupSuggest: typeof meetupSuggest;
  meetupShare: typeof meetupShare;
  meetupRespond: typeof meetupRespond;
  meetupCancel: typeof meetupCancel;
}
export const meetupApi: MeetupApi = { meetupSuggest, meetupShare, meetupRespond, meetupCancel };

// --- Faz 6: favoriler ve widget token'ı ---------------------------------------------------

/** Sıralı favori listesini yazar (en çok 4; sunucu arkadaş olmayanları atar ve son listeyi döner). */
export function favoritesSet(input: { favorite_ids: UserId[]; op_id?: string }): Promise<FavoritesSetResponse> {
  return invoke(CALLABLES.favoritesSet, FavoritesSetRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, FavoritesSetResponseSchema);
}

/** Cihaza özel widget token'ı (yalnızca bu yanıtta döner; snapshot'a girmez, yerel güvenli depoya yazılır). */
export function widgetTokenIssue(input: { device_id: string; op_id?: string }): Promise<WidgetTokenIssueResponse> {
  return invoke(CALLABLES.widgetTokenIssue, WidgetTokenIssueRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, WidgetTokenIssueResponseSchema);
}

/** `device_id: null` = tüm cihazlar (hesap güvenliği). */
export function widgetTokenRevoke(input: { device_id: string | null; op_id?: string }): Promise<WidgetTokenRevokeResponse> {
  return invoke(CALLABLES.widgetTokenRevoke, WidgetTokenRevokeRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, WidgetTokenRevokeResponseSchema);
}

export interface WidgetApi {
  widgetTokenIssue: typeof widgetTokenIssue;
  widgetTokenRevoke: typeof widgetTokenRevoke;
}
export const widgetApi: WidgetApi = { widgetTokenIssue, widgetTokenRevoke };

// --- Faz 8: yönlü izinler, görünmez mod, Güvenlik Sözleşmesi / KVKK onayı ---------------------------

/**
 * Faz 8 callable'ları (core `CALLABLES.permissionRequestSend` … `consentWithdraw`; istek şemaları core'dan, yanıt
 * şemaları yerel). Hepsi `op_id` taşır; aynı op_id ile tekrar sunucuda bir kez uygulanır (görünmez olma isteği
 * bağlantı gelince AYNI op_id ile yeniden denenir).
 *
 *  - `permission_request_send`: yanıt her zaman `sent` | `already_granted` (ret soğuması isteyene söylenmez).
 *  - `permission_request_respond`: çağıran = izni veren; `grant_scopes: []` = ret (ret push'u yok).
 *  - `permission_set`: kişi izinleri anahtarı; kapatmak onaysız da çalışır ve zincirleme temizler.
 *  - `invisible_set`: `invisible: true` onaysız da çalışır; kapatırken yalnızca seçilen alıcılar geri yüklenir.
 *  - `consent_accept`: sürüm + metin özeti güncel değilse `consent_required`.
 */
export function permissionRequestSend(input: WithOp<PermissionRequestSendRequest>): Promise<PermissionRequestSendResponse> {
  return invoke(
    CALLABLES.permissionRequestSend,
    PermissionRequestSendSchema,
    { ...input, op_id: input.op_id ?? uuidV4() },
    PermissionRequestSendResponseSchema,
  );
}

export function permissionRequestRespond(input: WithOp<PermissionRequestRespondRequest>): Promise<PermissionRequestRespondResponse> {
  return invoke(
    CALLABLES.permissionRequestRespond,
    PermissionRequestRespondSchema,
    { ...input, op_id: input.op_id ?? uuidV4() },
    PermissionRequestRespondResponseSchema,
  );
}

export function permissionSet(input: WithOp<PermissionSetRequest>): Promise<PermissionSetResponse> {
  return invoke(CALLABLES.permissionSet, PermissionSetSchema, { ...input, op_id: input.op_id ?? uuidV4() }, PermissionSetResponseSchema);
}

export function invisibleSet(input: WithOp<InvisibleSetRequest>): Promise<InvisibleSetResponse> {
  return invoke(CALLABLES.invisibleSet, InvisibleSetRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, InvisibleSetResponseSchema);
}

export function consentAccept(input: WithOp<ConsentAcceptRequest>): Promise<ConsentAcceptResponse> {
  return invoke(CALLABLES.consentAccept, ConsentAcceptRequestSchema, { ...input, op_id: input.op_id ?? uuidV4() }, ConsentAcceptResponseSchema);
}

export function consentWithdraw(input: { op_id?: string } = {}): Promise<ConsentWithdrawResponse> {
  return invoke(CALLABLES.consentWithdraw, ConsentWithdrawSchema, { op_id: input.op_id ?? uuidV4() }, ConsentWithdrawResponseSchema);
}

/** Faz 8 depolarının bağımlılıkları (testlerde sahte uygulanır). */
export interface AccessApi {
  permissionRequestSend: typeof permissionRequestSend;
  permissionRequestRespond: typeof permissionRequestRespond;
  permissionSet: typeof permissionSet;
}
export const accessApi: AccessApi = { permissionRequestSend, permissionRequestRespond, permissionSet };

export interface InvisibleApi {
  invisibleSet: typeof invisibleSet;
}
export const invisibleApi: InvisibleApi = { invisibleSet };

export interface ConsentApi {
  consentAccept: typeof consentAccept;
  consentWithdraw: typeof consentWithdraw;
}
export const consentApi: ConsentApi = { consentAccept, consentWithdraw };

// --- Konum İste (core `locationRequest.ts`) ---------------------------------------------------------

/**
 *  - `location_request_send`: hedef zaten paylaşıyorsa `already_sharing` (istek / push yok); bekleyen varsa aynısı döner.
 *  - `location_request_respond`: `accept: true` + süre → hedef → isteyen paylaşımı başlar; `accept: false` = ret
 *    (onaysız da çalışır).
 *  - `location_request_cancel`: yalnızca isteyen; idempotent.
 */
export function locationRequestSend(input: { target_id: UserId; op_id?: string }): Promise<LocationRequestSendResponse> {
  return invoke(CALLABLES.locationRequestSend, LocationRequestSendSchema, { ...input, op_id: input.op_id ?? uuidV4() }, LocationRequestSendResponseSchema);
}

export function locationRequestRespond(input: {
  request_id: string;
  accept: boolean;
  duration?: DurationChoice;
  time_zone?: string;
  op_id?: string;
}): Promise<LocationRequestRespondResponse> {
  return invoke(
    CALLABLES.locationRequestRespond,
    LocationRequestRespondSchema,
    { ...input, op_id: input.op_id ?? uuidV4() },
    LocationRequestRespondResponseSchema,
  );
}

export function locationRequestCancel(input: { request_id: string; op_id?: string }): Promise<LocationRequestCancelResponse> {
  return invoke(CALLABLES.locationRequestCancel, LocationRequestCancelSchema, { ...input, op_id: input.op_id ?? uuidV4() }, LocationRequestCancelResponseSchema);
}

export interface LocationRequestApi {
  locationRequestSend: typeof locationRequestSend;
  locationRequestRespond: typeof locationRequestRespond;
  locationRequestCancel: typeof locationRequestCancel;
}
export const locationRequestApi: LocationRequestApi = { locationRequestSend, locationRequestRespond, locationRequestCancel };

// --- Faz 7: Etkinlik Alanı, gizlilik ayarları, "yola çıktı" ----------------------------------------

/**
 * Etkinlik callable'ları (core `CALLABLES.eventCreate` … `eventCancel`; istek ve yanıt şemaları core `events.ts`).
 * Hepsi `op_id` taşır ve güncel etkinlik belgesini döner (ekran, dinleyici gelmeden yanıtla güncellenir).
 *  - `event_create` / `event_invite_add`: izin vermeyen / arkadaş olmayan sessizce atlanır (`skipped_count`).
 *  - `event_respond`: davetlinin TEK yanıtı (katılım + mekan + saat); "Katılamayacağım" onaysız da çalışır.
 *  - `event_finalize`: sahip sonucu onaylar; eşitlikte `event_vote_tie` + `venue_leaders` / `time_leaders`.
 *  - `event_options_set`: sahip mekan / saat seçeneklerini değiştirir (aynı kalanın oyu korunur).
 */
const op = <T extends { op_id?: string }>(input: T) => ({ ...input, op_id: input.op_id ?? uuidV4() });

export function eventCreate(input: WithOp<EventCreateRequest>): Promise<EventResponse> {
  return invoke(CALLABLES.eventCreate, EventCreateRequestSchema, op(input), EventResponseSchema);
}
export function eventRespond(input: WithOp<EventRespondRequest>): Promise<EventResponse> {
  return invoke(CALLABLES.eventRespond, EventRespondRequestSchema, op(input), EventResponseSchema);
}
export function eventFinalize(input: WithOp<EventFinalizeRequest>): Promise<EventResponse> {
  return invoke(CALLABLES.eventFinalize, EventFinalizeRequestSchema, op(input), EventResponseSchema);
}
export function eventOptionsSet(input: WithOp<EventOptionsSetRequest>): Promise<EventResponse> {
  return invoke(CALLABLES.eventOptionsSet, EventOptionsSetRequestSchema, op(input), EventResponseSchema);
}
export function eventUpdate(input: WithOp<EventUpdateRequest>): Promise<EventResponse> {
  return invoke(CALLABLES.eventUpdate, EventUpdateRequestSchema, op(input), EventResponseSchema);
}
export function eventInviteAdd(input: WithOp<EventInviteAddRequest>): Promise<EventResponse> {
  return invoke(CALLABLES.eventInviteAdd, EventInviteAddRequestSchema, op(input), EventResponseSchema);
}
export function eventCancel(input: WithOp<EventCancelRequest>): Promise<EventResponse> {
  return invoke(CALLABLES.eventCancel, EventCancelRequestSchema, op(input), EventResponseSchema);
}

export interface EventsApi {
  eventCreate: typeof eventCreate;
  eventRespond: typeof eventRespond;
  eventFinalize: typeof eventFinalize;
  eventOptionsSet: typeof eventOptionsSet;
  eventUpdate: typeof eventUpdate;
  eventInviteAdd: typeof eventInviteAdd;
  eventCancel: typeof eventCancel;
}
export const eventsApi: EventsApi = { eventCreate, eventRespond, eventFinalize, eventOptionsSet, eventUpdate, eventInviteAdd, eventCancel };

/**
 * İzin & Gizlilik Merkezi: pil paylaşımı (varsayılan KAPALI; sunucu RTDB kuralıyla zorlar) ve "yola çıktı" uyarıları.
 * Kapatmak onaysız da çalışır.
 */
export function privacySettingsSet(input: WithOp<PrivacySettingsSetRequest>): Promise<PrivacySettingsResponse> {
  return invoke(CALLABLES.privacySettingsSet, PrivacySettingsSetRequestSchema, op(input), PrivacySettingsResponseSchema);
}

/** Paylaşım sürerken sabit (≥ 10 dk) → hareket geçişi: etkin alıcılara "X yola çıktı" (koordinat yok, 30 dk soğuma). */
export function movementReport(input: WithOp<MovementReportRequest>): Promise<MovementReportResponse> {
  return invoke(CALLABLES.movementReport, MovementReportRequestSchema, op(input), MovementReportResponseSchema);
}

export interface PrivacyApi {
  privacySettingsSet: typeof privacySettingsSet;
}
export const privacyApi: PrivacyApi = { privacySettingsSet };

// --- Faz 9: anlık fotoğraf, 200 m yaklaşma, Güvenli Dönüş -------------------------------------------

/**
 * Anlık fotoğraf ispatı (core `proof.ts`). Bayt YALNIZCA bu callable'larla taşınır (Storage istemciye kapalı).
 *  - `proof_create`: yalnızca `source: 'camera'`; yeni fotoğraf eskisinin yerine geçer (`replaced_proof_id`).
 *  - `proof_get`: okuma (op_id yok); erişim her istekte sunucuda yeniden denetlenir.
 *  - `proof_delete`: sahip; onaydan muaf, idempotent.
 */
export function proofCreate(input: WithOp<ProofCreateRequest>): Promise<ProofCreateResponse> {
  return invoke(CALLABLES.proofCreate, ProofCreateRequestSchema, op(input), ProofCreateResponseSchema);
}
export function proofGet(input: ProofGetRequest): Promise<ProofGetResponse> {
  return invoke(CALLABLES.proofGet, ProofGetRequestSchema, input, ProofGetResponseSchema);
}
export function proofDelete(input: WithOp<ProofDeleteRequest>): Promise<ProofDeleteResponse> {
  return invoke(CALLABLES.proofDelete, ProofDeleteRequestSchema, op(input), ProofDeleteResponseSchema);
}

export interface ProofApi {
  proofCreate: typeof proofCreate;
  proofGet: typeof proofGet;
  proofDelete: typeof proofDelete;
}
export const proofApi: ProofApi = { proofCreate, proofGet, proofDelete };

/** "Neredeyse vardım (1 dk)": tetik anındaki etkin oturumlar; sunucu oturum başına tek bildirim yazar. */
export function approachReport(input: WithOp<ApproachReportRequest>): Promise<ApproachReportResponse> {
  return invoke(CALLABLES.approachReport, ApproachReportRequestSchema, op(input), ApproachReportResponseSchema);
}

export interface ApproachApi {
  approachReport: typeof approachReport;
}
export const approachApi: ApproachApi = { approachReport };

/**
 * Güvenli Dönüş (core `safeReturn.ts`). Zamanlayıcı sunucudadır; cihaz son konumu ve check-in'i bildirir.
 * `check_in` ve `cancel` onaydan muaftır.
 */
export function safeReturnStart(input: WithOp<SafeReturnStartRequest>): Promise<SafeReturnResponse> {
  return invoke(CALLABLES.safeReturnStart, SafeReturnStartRequestSchema, op(input), SafeReturnResponseSchema);
}
export function safeReturnUpdate(input: WithOp<SafeReturnUpdateRequest>): Promise<SafeReturnResponse> {
  return invoke(CALLABLES.safeReturnUpdate, SafeReturnUpdateRequestSchema, op(input), SafeReturnResponseSchema);
}
export function safeReturnCheckIn(input: WithOp<SafeReturnCheckInRequest>): Promise<SafeReturnResponse> {
  return invoke(CALLABLES.safeReturnCheckIn, SafeReturnCheckInRequestSchema, op(input), SafeReturnResponseSchema);
}
export function safeReturnExtend(input: WithOp<SafeReturnExtendRequest>): Promise<SafeReturnResponse> {
  return invoke(CALLABLES.safeReturnExtend, SafeReturnIdRequestSchema, op(input), SafeReturnResponseSchema);
}
export function safeReturnCancel(input: WithOp<SafeReturnCancelRequest>): Promise<SafeReturnResponse> {
  return invoke(CALLABLES.safeReturnCancel, SafeReturnIdRequestSchema, op(input), SafeReturnResponseSchema);
}

export interface SafeReturnApi {
  safeReturnStart: typeof safeReturnStart;
  safeReturnUpdate: typeof safeReturnUpdate;
  safeReturnCheckIn: typeof safeReturnCheckIn;
  safeReturnExtend: typeof safeReturnExtend;
  safeReturnCancel: typeof safeReturnCancel;
}
export const safeReturnApi: SafeReturnApi = { safeReturnStart, safeReturnUpdate, safeReturnCheckIn, safeReturnExtend, safeReturnCancel };
