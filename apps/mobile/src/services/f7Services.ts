/**
 * Faz 7 servisleri.
 *
 * Modül düzeyi (`installF7Guards`, sharingCoordinator yüklenince bir kez):
 *   authStore profili → gizlilik tercihinin başsız kopyası (`persist.savePrivacy`): konum hattı (arka plan görevi
 *   dahil) pil alanlarını yalnızca `battery_share === true` iken yayınlar. Profil yoksa / başka hesapsa kopya kapalı.
 *
 * Oturum (`startF7Services`, sharingCoordinator `startSessionServices` içinden):
 *   Firestore events (member_ids ∋ ben)  → eventsStore.setEvents
 *   Firestore users/{ben}/notices        → eventsStore.setNotices (uygulama içi bildirim kutusu)
 *   Push (önde) event_* / movement       → yerel bildirim (push.ts); dokunma → `/events/{id}` ya da haritada vurgu
 */
import { parsePrivacy, type UserId } from '@konum/core';
import { authStore, type AuthState } from '../state/authStore';
import { eventsStore } from '../state/eventsStore';
import { savePrivacy } from '../state/persist';
import { pingStore } from '../state/pingStore';
import { privacyStore } from '../state/privacyStore';
import { listenEvents, listenNotices } from './firebase/eventsRepo';
import * as Notifications from './notifications/expoNotifications';
import { f7EventRoute, routeF7Open, setF7Handlers, type F7PushEvent } from './notifications/f7Push';
import { resilientListener, type ResilientListener } from './resilientListener';

function navigate(href: string): void {
  try {
    // Gecikmeli: servis katmanı yönlendiriciye derleme zamanında bağlanmasın (testler, başsız bağlam).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { router } = require('expo-router') as { router?: { push: (href: string) => void } };
    router?.push(href);
  } catch {
    // yönlendirici yok (test / başsız)
  }
}

/** Bildirime dokunma: etkinlik → etkinlik ekranı; "yola çıktı" → göndereni haritada vurgula (koordinat push'ta yok). */
export function handleF7Open(ev: F7PushEvent, nav: (href: string) => void = navigate): void {
  if (ev.type === 'movement') {
    pingStore.getState().highlightFrom(ev.from, 'on_way');
    return;
  }
  eventsStore.getState().focus(ev.event_id);
  const href = f7EventRoute(ev);
  if (href) nav(href);
}

/** Önde alındı: dinleyiciler zaten güncelliyor; yerel bildirimi push.ts gösterir. */
export function handleF7Received(ev: F7PushEvent): void {
  if (ev.type === 'movement') pingStore.getState().highlightFrom(ev.from, 'on_way');
}

let guardsInstalled = false;

function syncPrivacy(s: Pick<AuthState, 'uid' | 'status' | 'profile'>): void {
  if (!s.uid || !s.profile || (s.status !== 'ready' && s.status !== 'needsProfile')) return;
  const p = parsePrivacy(s.profile.privacy);
  void savePrivacy({ uid: s.uid, battery_share: p.battery_share, movement_alerts: p.movement_alerts }).catch(() => undefined);
}

/** Bir kez: profil gizlilik tercihi → başsız kopya. */
export function installF7Guards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  syncPrivacy(authStore.getState());
  authStore.subscribe((s, prev) => {
    if (s.profile !== prev.profile || s.status !== prev.status || s.uid !== prev.uid) syncPrivacy(s);
  });
}

export function startF7Services(uid: UserId): () => void {
  const listeners: ResilientListener[] = [];
  void eventsStore.getState().hydrateSeen(uid);
  listeners.push(
    resilientListener('events', (h) =>
      listenEvents(
        uid,
        (list) => {
          h.ok();
          eventsStore.getState().setEvents(uid, list);
        },
        h.error,
      ),
    ),
    resilientListener('notices', (h) =>
      listenNotices(
        uid,
        (list) => {
          h.ok();
          eventsStore.getState().setNotices(uid, list);
        },
        h.error,
      ),
    ),
  );

  setF7Handlers({ received: handleF7Received, open: (ev) => handleF7Open(ev) });
  const responseSub = Notifications.addNotificationResponseReceivedListener((r) => {
    routeF7Open(r.notification.request.content.data as Record<string, unknown> | undefined);
  });
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) routeF7Open(last.notification.request.content.data as Record<string, unknown> | undefined);
  } catch {
    // yerel modül yok (ör. test)
  }

  return () => {
    listeners.forEach((l) => l.dispose());
    responseSub.remove();
    setF7Handlers(null);
  };
}

/** Çıkışta: bellek durumu (başsız gizlilik kopyası `clearBackgroundState` ile silinir). */
export async function resetF7State(): Promise<void> {
  eventsStore.getState().reset();
  privacyStore.getState().reset();
  await savePrivacy(null).catch(() => undefined);
}
