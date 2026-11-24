/**
 * Faz 4 oturum servisleri (sharingCoordinator `startSessionServices` içinden başlatılır):
 *
 *   RTDB ping_inbox/{ben}                         → pingStore.upsertIncoming / removeIncoming (+ pin vurgusu)
 *   Firestore place_notes (sahibi ∪ görünür)      → notesStore.setPlaceNotes
 *   Firestore sos_alerts (gönderen / alıcı)       → sosStore.applySent / applyReceived (+ yeni SOS → tam ekran)
 *   Firestore users/{ben}.emergency_contacts      → sosStore.setContactsFromProfile
 *   Durum notu değişti                            → canlı hedef varsa HEMEN bir paket (ctx.publishNow)
 *   2 sn'lik tik                                  → süresi geçen ping / not / SOS budanır; ön plandayken aktif SOS
 *                                                   konumu `updateMinIntervalMs`'de bir tazelenir (sos_update)
 *   Bildirime dokunma (FCM + yerel)               → `sos` → sosStore.focus, `ping` → göndereni vurgula
 *
 * Dinleyiciler hata verirse geri çekilmeli yeniden abone olur (`resilientListener`); sağlık şeridine bağlanmaz
 * (Faz 4 kuralları dağıtılmamışsa harita "eşitlenemiyor" uyarısı göstermesin).
 */
import type { UserId } from '@konum/core';
import { AppState } from 'react-native';
import { notesStore, onStatusChange } from '../state/notesStore';
import { pingStore } from '../state/pingStore';
import { sosStore } from '../state/sosStore';
import { listenPingInbox } from './firebase/pingInboxRepo';
import { listenPlaceNotes } from './firebase/placeNotesRepo';
import { listenEmergencyContacts } from './firebase/profileRepo';
import { listenSosAlerts } from './firebase/sosRepo';
import * as Notifications from './notifications/expoNotifications';
import { routeF4Open, setF4OpenHandler, type F4PushEvent } from './notifications/f4Push';
import { resilientListener, type ResilientListener } from './resilientListener';

export interface F4Context {
  /** Bu açılışta sunucunun doğruladığı canlı yayın hedefi var mı. */
  hasLiveTargets: () => boolean;
  /** Tek ölçüm alıp hemen yayınla (durum notu değişti). */
  publishNow: () => void;
}

const TICK_MS = 2_000;

/** Bildirime dokunma → depo (saf; testlerde de kullanılır). */
export function handleF4Open(ev: F4PushEvent): void {
  switch (ev.type) {
    case 'sos':
    case 'sos_resolved':
      sosStore.getState().focus(ev.sos_id);
      return;
    case 'ping':
      pingStore.getState().highlightFrom(ev.from, ev.kind);
      return;
    case 'sos_ack':
      // Gönderen kendi SOS ekranını zaten görür (sosStore.outgoing); ek odak yok.
      return;
  }
}

export function startF4Services(uid: UserId, ctx: F4Context): () => void {
  const listeners: ResilientListener[] = [];
  const unsubs: (() => void)[] = [];

  listeners.push(
    resilientListener('ping_inbox', (h) =>
      listenPingInbox(uid, {
        onUpsert: (p) => {
          h.ok();
          pingStore.getState().upsertIncoming(p);
        },
        onRemove: (id) => pingStore.getState().removeIncoming(id),
        onError: h.error,
      }),
    ),
  );
  listeners.push(
    resilientListener('place_notes', (h) =>
      listenPlaceNotes(
        uid,
        (list) => {
          h.ok();
          notesStore.getState().setPlaceNotes(list);
        },
        h.error,
      ),
    ),
  );
  listeners.push(
    resilientListener('sos_alerts', (h) =>
      listenSosAlerts(uid, {
        onSent: (list) => {
          h.ok();
          sosStore.getState().applySent(list);
        },
        onReceived: (list) => {
          h.ok();
          sosStore.getState().applyReceived(list);
        },
        onError: h.error,
      }),
    ),
  );
  listeners.push(
    resilientListener('emergency_contacts', (h) =>
      listenEmergencyContacts(
        uid,
        (ids) => {
          h.ok();
          sosStore.getState().setContactsFromProfile(ids);
        },
        h.error,
      ),
    ),
  );

  void notesStore.getState().hydrate();
  unsubs.push(
    onStatusChange(() => {
      if (ctx.hasLiveTargets()) ctx.publishNow();
    }),
  );

  const timer = setInterval(() => {
    pingStore.getState().tick();
    notesStore.getState().tick();
    sosStore.getState().tick();
    if (AppState.currentState === 'active') void sosStore.getState().updateTick();
  }, TICK_MS);

  setF4OpenHandler(handleF4Open);
  const responseSub = Notifications.addNotificationResponseReceivedListener((r) => {
    routeF4Open(r.notification.request.content.data as Record<string, unknown> | undefined);
  });
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) routeF4Open(last.notification.request.content.data as Record<string, unknown> | undefined);
  } catch {
    // yerel modül yok (ör. test)
  }

  return () => {
    listeners.forEach((l) => l.dispose());
    unsubs.forEach((u) => u());
    clearInterval(timer);
    responseSub.remove();
    setF4OpenHandler(null);
  };
}

/** Çıkışta: Faz 4 bellek durumu silinir (kalıcı durum notu `clearBackgroundState` ile silinir). */
export function resetF4Stores(): void {
  pingStore.getState().reset();
  notesStore.getState().reset();
  sosStore.getState().reset();
}
