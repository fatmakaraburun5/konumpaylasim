/**
 * "Konum İste" oturum servisleri (sharingCoordinator `startSessionServices` içinden).
 *
 *  - Firestore `location_requests` (iki yön) → locationRequestStore.setSnapshot
 *  - Bildirim kategorisi `LOCATION_REQUEST`: "Onayla" (uygulamayı açar → süre seçici) / "Reddet" (uygulamayı açar,
 *    istek hemen reddedilir; ret onaydan muaftır). Dokunma → haritadaki istek kartı.
 *  - Yanıt bildirimi (isteyene) → Arkadaşlar; onaylandıysa harita.
 */
import { LOCATION_REQUEST_NOTIFICATION, LOCATION_REQUEST_TEXT, type UserId } from '@konum/core';
import { locationRequestStore } from '../state/locationRequestStore';
import { listenLocationRequests } from './firebase/requestsRepo';
import * as Notifications from './notifications/expoNotifications';
import {
  routeLocationRequestResponse,
  setLocationRequestHandler,
  type LocationRequestAction,
  type LocationRequestPushEvent,
} from './notifications/locationRequestPush';
import { resilientListener } from './resilientListener';

let categoryRegistered = false;

/** iOS + Android eylem düğmeleri (web demo kabuğu da aynı kategoriyi çizer). */
export async function registerLocationRequestCategory(): Promise<void> {
  if (categoryRegistered) return;
  categoryRegistered = true;
  await Notifications.setNotificationCategoryAsync(LOCATION_REQUEST_NOTIFICATION.category, [
    { identifier: LOCATION_REQUEST_NOTIFICATION.approveAction, buttonTitle: LOCATION_REQUEST_TEXT.approve, options: { opensAppToForeground: true } },
    { identifier: LOCATION_REQUEST_NOTIFICATION.rejectAction, buttonTitle: LOCATION_REQUEST_TEXT.reject, options: { opensAppToForeground: true, isDestructive: true } },
  ]).catch(() => {
    categoryRegistered = false;
  });
}

function go(href: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { router } = require('expo-router') as { router?: { push: (h: string) => void } };
    router?.push(href);
  } catch {
    // yönlendirici yok (test / başsız)
  }
}

export function handleLocationRequestResponse(ev: LocationRequestPushEvent, action: LocationRequestAction): void {
  const store = locationRequestStore.getState();
  if (ev.type === 'location_request_answered') {
    go(ev.status === 'approved' ? '/' : '/friends');
    return;
  }
  if (action === 'reject') {
    void store.reject(ev.requestId);
    return;
  }
  go('/');
  if (action === 'approve') store.openApprove(ev.requestId);
}

export function startLocationRequestServices(uid: UserId): () => void {
  const listener = resilientListener('location_requests', (h) =>
    listenLocationRequests(
      uid,
      (docs) => {
        h.ok();
        locationRequestStore.getState().setSnapshot(uid, docs);
      },
      h.error,
    ),
  );
  void registerLocationRequestCategory();
  setLocationRequestHandler(handleLocationRequestResponse);
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    routeLocationRequestResponse(r.notification.request.content.data as Record<string, unknown> | undefined, r.actionIdentifier);
  });
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) routeLocationRequestResponse(last.notification.request.content.data as Record<string, unknown> | undefined, last.actionIdentifier);
  } catch {
    // yerel modül yok (ör. test)
  }
  return () => {
    listener.dispose();
    sub.remove();
    setLocationRequestHandler(null);
  };
}

export function resetLocationRequestState(): void {
  locationRequestStore.getState().reset();
}
