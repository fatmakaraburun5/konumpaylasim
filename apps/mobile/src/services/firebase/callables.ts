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
} from '@konum/core';
import { z } from 'zod';
import { KonumError, toKonumError } from '../../lib/errors';
import {
  FriendRequestSendResponseSchema,
  OkResponseSchema,
  ShareExtendResponseSchema,
  ShareRevokeResponseSchema,
  ShareStartResponseSchema,
  ShareStopResponseSchema,
  UserBootstrapRequestSchema,
  UserBootstrapResponseSchema,
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

export function userBootstrap(input: { display_name?: string; time_zone: string; op_id?: string }) {
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
