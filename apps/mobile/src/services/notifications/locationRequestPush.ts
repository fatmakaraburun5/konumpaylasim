/**
 * "Konum İste" push verisi (core `PUSH_TYPES_LOCATION_REQUEST`) — platformdan bağımsız, saf yardımcılar.
 *
 *  - `location_request` (hedefe): "Can konumunu paylaşmanı istiyor". Eylemli bildirim (kategori `LOCATION_REQUEST`):
 *    "Onayla" uygulamayı açar ve süre seçiciyi gösterir; "Reddet" isteği uygulama içinde hemen reddeder; dokunma
 *    uygulama içi istek kartını öne çıkarır.
 *    iOS: APNs alert + `category` (sistem gösterir). Android: FCM yalnızca veri taşır, eylemler yerel bildirimde
 *    çalıştığı için bildirimi uygulama gösterir (önde ve arka planda, `locationRequestLocalContent`).
 *  - `location_request_answered` (isteyene): onay ya da sade ret metni (neden söylenmez). Koordinat yok.
 */
import { LOCATION_REQUEST_NOTIFICATION, PUSH_TYPES_LOCATION_REQUEST, locationRequestAnsweredText, locationRequestPushText, type UserId } from '@konum/core';
import type { F4PushLike } from './f4Push';

export type LocationRequestPushType = (typeof PUSH_TYPES_LOCATION_REQUEST)[number];

export type LocationRequestPushEvent =
  | { type: 'location_request'; requestId: string; from: UserId }
  | { type: 'location_request_answered'; requestId: string; by: UserId; status: 'approved' | 'rejected' };

/** Bildirim yanıtı: dokunma, "Onayla" ya da "Reddet". */
export type LocationRequestAction = 'open' | 'approve' | 'reject';

export const isLocationRequestPushType = (t: unknown): t is LocationRequestPushType =>
  typeof t === 'string' && (PUSH_TYPES_LOCATION_REQUEST as readonly string[]).includes(t);

const uidOf = (v: unknown): UserId | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null);
const reqIdOf = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,260}$/.test(v) ? v : null);

export function parseLocationRequestData(data: Record<string, unknown> | null | undefined): LocationRequestPushEvent | null {
  if (!data || !isLocationRequestPushType(data.type)) return null;
  const requestId = reqIdOf(data.request_id);
  if (!requestId) return null;
  if (data.type === 'location_request') {
    const from = uidOf(data.from);
    return from ? { type: 'location_request', requestId, from } : null;
  }
  const by = uidOf(data.by);
  const status = data.status === 'approved' || data.status === 'rejected' ? data.status : null;
  return by && status ? { type: 'location_request_answered', requestId, by, status } : null;
}

export interface LocationRequestLocalContent {
  title: string;
  body: string;
  channelId: string;
  data: Record<string, string>;
  /** Yalnızca gelen istekte: Onayla / Reddet eylemleri. */
  categoryIdentifier: string | null;
}

/** Yerel bildirim içeriği (Android her durumda, iOS yalnızca önde). `nameOf` arkadaş adını verir. */
export function locationRequestLocalContent(m: F4PushLike, nameOf: (uid: UserId) => string | null): LocationRequestLocalContent | null {
  const ev = parseLocationRequestData(m.data);
  if (!ev) return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (typeof v === 'string') data[k] = v;
  const fallback =
    ev.type === 'location_request' ? locationRequestPushText(nameOf(ev.from)) : locationRequestAnsweredText(nameOf(ev.by), ev.status);
  const title = m.notification?.title ?? (typeof m.data?.title === 'string' ? m.data.title : fallback.title);
  const body = m.notification?.body ?? (typeof m.data?.body === 'string' ? m.data.body : fallback.body);
  return {
    title,
    body,
    channelId: LOCATION_REQUEST_NOTIFICATION.channelId,
    data,
    categoryIdentifier: ev.type === 'location_request' ? LOCATION_REQUEST_NOTIFICATION.category : null,
  };
}

/** expo-notifications eylem kimliği → eylem. */
export function actionOf(actionIdentifier: string | null | undefined): LocationRequestAction {
  if (actionIdentifier === LOCATION_REQUEST_NOTIFICATION.approveAction) return 'approve';
  if (actionIdentifier === LOCATION_REQUEST_NOTIFICATION.rejectAction) return 'reject';
  return 'open';
}

// --- yönlendirme ---------------------------------------------------------------------------------

export type LocationRequestHandler = (ev: LocationRequestPushEvent, action: LocationRequestAction) => void;

let handler: LocationRequestHandler | null = null;
let pending: { ev: LocationRequestPushEvent; action: LocationRequestAction } | null = null;

export function setLocationRequestHandler(h: LocationRequestHandler | null): void {
  handler = h;
  if (h && pending) {
    const p = pending;
    pending = null;
    h(p.ev, p.action);
  }
}

/** Bildirim yanıtı (soğuk açılışta işleyici kurulana kadar bekletilir). Dönen: bu türden miydi. */
export function routeLocationRequestResponse(data: Record<string, unknown> | null | undefined, actionIdentifier?: string | null): boolean {
  const ev = parseLocationRequestData(data);
  if (!ev) return false;
  const action = actionOf(actionIdentifier);
  if (handler) handler(ev, action);
  else pending = { ev, action };
  return true;
}
