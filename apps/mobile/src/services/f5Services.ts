/**
 * Faz 5 oturum servisleri (sharingCoordinator `startSessionServices` içinden başlatılır):
 *
 *   Firestore users/{ben}/zones                 → zonesStore.setZones + zoneMonitor.syncZones (OS bölge kaydı)
 *   Firestore users/{ben}/zone_events (son 20)  → zonesStore.setServerEvents
 *   Firestore meetups (from == ben / to ∋ ben)  → meetupStore.applySent / applyReceived (+ yeni öneri → kart)
 *   locationStore.myPosition (ön plan izleme)   → tüm bölgelerin sapma filtresi (ek GPS yok)
 *   İzin isteği / ön plana dönüş                 → izinler tazelenir, OS kaydı yeniden denenir, bekleyen raporlar
 *   Push (önde)                                  → `meetup` → meetupStore.focus
 *   Bildirime dokunma                            → `zone_event` → göndereni haritada vurgula, `meetup*` → kart
 *   5 sn'lik tik                                 → süresi geçen / iptal edilen öneriler gizlenir
 *
 * Dinleyiciler hata verirse geri çekilmeli yeniden abone olur (`resilientListener`); sağlık şeridine bağlanmaz.
 */
import type { UserId } from '@konum/core';
import { AppState } from 'react-native';
import { locationStore } from '../state/locationStore';
import { meetupStore } from '../state/meetupStore';
import { permissionsStore } from '../state/permissionsStore';
import { pingStore } from '../state/pingStore';
import { onZoneMonitoringRequest, RECENT_EVENTS_MAX, zonesStore } from '../state/zonesStore';
import { listenMeetups } from './firebase/meetupsRepo';
import { listenZoneEvents, listenZones } from './firebase/zonesRepo';
import { zoneMonitor } from './location/zoneMonitor';
import * as Notifications from './notifications/expoNotifications';
import { routeF5Open, setF5Handlers, type F5PushEvent } from './notifications/f5Push';
import { resilientListener, type ResilientListener } from './resilientListener';

const TICK_MS = 5_000;

/** Push önde alındı (saf; testlerde de kullanılır). */
export function handleF5Received(ev: F5PushEvent): void {
  if (ev.type === 'meetup') meetupStore.getState().focus(ev.meetup_id);
}

/** Bildirime dokunma → depo. Bölge olayında koordinat yoktur: gönderen canlı paylaşıyorsa pini vurgulanır. */
export function handleF5Open(ev: F5PushEvent): void {
  switch (ev.type) {
    case 'zone_event':
      pingStore.getState().highlightFrom(ev.from, 'here');
      return;
    case 'meetup':
    case 'meetup_response':
      meetupStore.getState().focus(ev.meetup_id);
      return;
  }
}

/** Bağlantı geldi (sharingCoordinator `.info/connected`): kuyruktaki bölge olayları aynı op_id ile gönderilir. */
export function onF5Connected(): void {
  void zoneMonitor.flushReports();
}

export function startF5Services(uid: UserId): () => void {
  const listeners: ResilientListener[] = [];
  const unsubs: (() => void)[] = [];
  zoneMonitor.setForeground(true);

  const resync = () => void zoneMonitor.syncZones(Object.values(zonesStore.getState().zones)).catch(() => undefined);

  listeners.push(
    resilientListener('zones', (h) =>
      listenZones(
        uid,
        (list) => {
          h.ok();
          zonesStore.getState().setZones(list); // → aşağıdaki abonelik OS kaydını yeniler
        },
        h.error,
      ),
    ),
  );
  listeners.push(
    resilientListener('zone_events', (h) =>
      listenZoneEvents(
        uid,
        RECENT_EVENTS_MAX,
        (list) => {
          h.ok();
          zonesStore.getState().setServerEvents(list);
        },
        h.error,
      ),
    ),
  );
  listeners.push(
    resilientListener('meetups', (h) =>
      listenMeetups(uid, {
        onSent: (list) => {
          h.ok();
          meetupStore.getState().applySent(list);
        },
        onReceived: (list) => {
          h.ok();
          meetupStore.getState().applyReceived(list);
        },
        onError: h.error,
      }),
    ),
  );

  // Callable yanıtıyla eklenen / silinen bölge de OS kaydına hemen yansısın (dinleyiciyi beklemeden).
  let lastZonesRef = zonesStore.getState().zones;
  unsubs.push(
    zonesStore.subscribe((s) => {
      if (s.zones === lastZonesRef) return;
      lastZonesRef = s.zones;
      resync();
    }),
  );

  // Ön plan örnekleri → bölge filtresi (yalnızca yeni ölçüm).
  let lastTs = locationStore.getState().myPosition?.timestamp ?? 0;
  unsubs.push(
    locationStore.subscribe((s) => {
      const p = s.myPosition;
      if (!p || p.timestamp <= lastTs) return;
      lastTs = p.timestamp;
      if (Object.keys(zonesStore.getState().zones).length === 0) return;
      void zoneMonitor.feedRaw([{ latitude: p.lat, longitude: p.lng, accuracy: p.accuracy, speed: null, heading: null, timestamp: p.timestamp, mocked: null }], 'foreground');
    }),
  );

  unsubs.push(
    onZoneMonitoringRequest(() => {
      void permissionsStore
        .getState()
        .refresh()
        .catch(() => undefined)
        .finally(resync);
    }),
  );
  let lastBg = permissionsStore.getState().background;
  unsubs.push(
    permissionsStore.subscribe((s) => {
      if (s.background === lastBg) return;
      lastBg = s.background;
      resync();
    }),
  );
  const appSub = AppState.addEventListener('change', (st) => {
    if (st !== 'active') return;
    // Ayarlar'dan "Her zaman" verilmiş olabilir: kaydı yeniden dene; kuyruktaki olayları gönder.
    resync();
    void zoneMonitor.flushReports();
  });

  const timer = setInterval(() => meetupStore.getState().tick(), TICK_MS);

  setF5Handlers({ received: handleF5Received, open: handleF5Open });
  const responseSub = Notifications.addNotificationResponseReceivedListener((r) => {
    routeF5Open(r.notification.request.content.data as Record<string, unknown> | undefined);
  });
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) routeF5Open(last.notification.request.content.data as Record<string, unknown> | undefined);
  } catch {
    // yerel modül yok (ör. test)
  }

  void zoneMonitor.flushReports();

  return () => {
    listeners.forEach((l) => l.dispose());
    unsubs.forEach((u) => u());
    appSub.remove();
    clearInterval(timer);
    responseSub.remove();
    setF5Handlers(null);
    zoneMonitor.setForeground(false);
  };
}

/** Çıkışta: OS bölge kaydı kalkar, kalıcı bölge durumu ve Faz 5 bellek durumu silinir. */
export async function resetF5State(): Promise<void> {
  await zoneMonitor.stop().catch(() => undefined);
  zonesStore.getState().reset();
  meetupStore.getState().reset();
}
