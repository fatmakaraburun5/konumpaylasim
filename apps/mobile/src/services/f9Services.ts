/**
 * Faz 9 servisleri (docs/PHASE9.md).
 *
 * Oturum (`startF9Services`, sharingCoordinator `startSessionServices` içinden):
 *   Açılış                                → proof / destination / safeReturn / smsFallback depoları diskten; bekleyen
 *                                           yaklaşma raporu ve varış check-in'i (`f9Hooks.flushPending`)
 *   Firestore safe_returns (owner == ben) → safeReturnStore.applyDocs (yerel bildirimler + başsız kayıt)
 *   Fotoğraf / hedef değişti               → hemen yayın (`publishNow`: paket `photo_*` / `dest_*`)
 *   incomingStore paketleri               → proofStore.syncFriendRefs (kalkan / süresi dolan fotoğraf silinir)
 *   Ön plan konumu (locationStore)         → son doğrulanmış konum (`konum.bg.lastFix.v1`); paylaşım yokken Güvenli
 *                                           Dönüş konum tazeleme + varış (paylaşım varken konum hattı yapar)
 *   Her `PROOF_LIMITS.cacheSweepMs` ve öne gelince → süresi dolan fotoğraflar silinir; Güvenli Dönüş her saniye
 *                                           (yalnızca etkin ve öndeyken) `tick`
 *   Tüm arkadaş paylaşımları bitince       → hedef temizlenir (yalnızca ön planda; arka planda hedef kayıtta kalır
 *                                           ama oturum olmadığı için rapor / paket alanı üretilmez)
 *   Push / bildirim dokunuşu               → yaklaşma / başladı: göndereni haritada vurgula; "Güvende misin?" ve yerel
 *                                           Güvenli Dönüş hatırlatıcıları → `SAFE_RETURN_ROUTE`; eylemler
 *                                           (Güvendeyim / +15 dk) → safeReturnActions
 * Bağlantı geldi (`onF9Connected`) → bekleyen yaklaşma raporu / varış check-in'i aynı op_id ile.
 * Çıkış (`resetF9State`) → depolar, fotoğraf önbelleği, SMS yedeği tercihi ve Güvenli Dönüş yerel bildirimleri silinir.
 */
import { batteryPct, NOTIFICATION_CATEGORIES_F9, PROOF_LIMITS, selectPublishTargets, visibleProofRef, type EpochMs, type UserId } from '@konum/core';
import { AppState } from 'react-native';
import { getServerOffsetMs, now as serverNow } from '../lib/clock';
import { destinationStore, onDestinationChange } from '../state/destinationStore';
import { incomingStore } from '../state/incomingStore';
import { locationStore } from '../state/locationStore';
import { pingStore } from '../state/pingStore';
import { onProofChange, proofStore } from '../state/proofStore';
import { safeReturnStore } from '../state/safeReturnStore';
import { sharingStore } from '../state/sharingStore';
import { smsFallbackStore } from '../state/smsFallbackStore';
import { listenSafeReturns } from './firebase/safeReturnRepo';
import { readDeviceStatus } from './location/deviceStatus';
import { f9Hooks } from './location/f9Hooks';
import { recordLastFix } from './location/lastFix';
import * as Notifications from './notifications/expoNotifications';
import { routeF9Open, setF9Handlers, type F9PushEvent } from './notifications/f9Push';
import { handleSafeReturnResponse } from './notifications/safeReturnActions';
import { cancelSafeReturnLocal } from './notifications/safeReturnNotifications';
import { resilientListener, type ResilientListener } from './resilientListener';

/** Güvenli Dönüş ekranının yolu (arayüz `app/(main)/safe-return.tsx`). */
export const SAFE_RETURN_ROUTE = '/safe-return';

export interface F9ServiceContext {
  /** Bu açılışta sunucunun doğruladığı yayın hedefi var mı (konum hattı Güvenli Dönüş'ü zaten işler). */
  hasLiveTargets: () => boolean;
  /** Tek ölçüm alıp hemen yayınla (paket alanları değişti). */
  publishNow: () => void;
}

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

/** Bildirime dokunma. */
export function handleF9Open(ev: F9PushEvent, nav: (href: string) => void = navigate): void {
  switch (ev.type) {
    case 'approach':
    case 'safe_return_started':
      pingStore.getState().highlightFrom(ev.from, 'on_way');
      return;
    case 'safe_return_ended':
      return;
    case 'safe_return_due':
      safeReturnStore.getState().tick();
      nav(SAFE_RETURN_ROUTE);
      return;
  }
}

/** Önde alındı: yerel bildirimi push.ts gösterir; durum dinleyicilerden gelir. */
export function handleF9Received(ev: F9PushEvent): void {
  if (ev.type === 'approach') pingStore.getState().highlightFrom(ev.from, 'on_way');
  else if (ev.type === 'safe_return_due') safeReturnStore.getState().tick();
}

const ACTIONS = new Set<string>([NOTIFICATION_CATEGORIES_F9.actionSafe, NOTIFICATION_CATEGORIES_F9.actionExtend]);

/** Bildirim yanıtı (ön plan dinleyicisi / soğuk açılış): eylem → safeReturnActions; dokunma → ekran. */
export async function handleF9NotificationResponse(r: Notifications.NotificationResponse, nav: (href: string) => void = navigate): Promise<void> {
  if (ACTIONS.has(r.actionIdentifier)) {
    await handleSafeReturnResponse(r).catch(() => null);
    return;
  }
  const data = r.notification.request.content.data as Record<string, unknown> | undefined;
  if (data?.type === 'safe_return_local') {
    nav(SAFE_RETURN_ROUTE);
    return;
  }
  routeF9Open(data);
}

/** Paketlerdeki arkadaş fotoğraf referansları (gönderen başına; süresi dolmuşsa null). */
export function friendProofRefs(locations: Record<string, { sender_id: UserId; photo_id?: string; photo_exp?: EpochMs }>, now: EpochMs) {
  const refs: Record<UserId, { photo_id: string; photo_exp: EpochMs } | null> = {};
  for (const loc of Object.values(locations)) {
    const ref = visibleProofRef(loc, now);
    if (ref || !(loc.sender_id in refs)) refs[loc.sender_id] = ref;
  }
  return refs;
}

/** Bağlantı geldi: bekleyen yaklaşma raporu ve varış check-in'i (aynı op_id). */
export function onF9Connected(): void {
  void f9Hooks.flushPending(serverNow()).catch(() => undefined);
}

export function startF9Services(uid: UserId, ctx: F9ServiceContext): () => void {
  let disposed = false;
  const unsubs: (() => void)[] = [];
  const listeners: ResilientListener[] = [];

  void (async () => {
    await Promise.all([
      proofStore.getState().hydrate(),
      destinationStore.getState().hydrate(),
      safeReturnStore.getState().hydrate(),
      smsFallbackStore.getState().hydrate(),
    ]).catch(() => undefined);
    if (disposed) return;
    void smsFallbackStore.getState().refreshAvailability().catch(() => undefined);
    onF9Connected();
  })();

  listeners.push(
    resilientListener('safe_returns', (h) =>
      listenSafeReturns(
        uid,
        (docs) => {
          h.ok();
          safeReturnStore.getState().applyDocs(docs);
        },
        h.error,
      ),
    ),
  );

  // Paket alanları değişti → hemen yayın (publishNow yalnızca canlı hedef varken yayınlar).
  unsubs.push(onProofChange(() => ctx.publishNow()));
  unsubs.push(onDestinationChange(() => ctx.publishNow()));

  // Arkadaş fotoğrafları: paketten kalkan / süresi dolan kopya silinir.
  const syncRefs = () => proofStore.getState().syncFriendRefs(friendProofRefs(incomingStore.getState().locations, serverNow()));
  unsubs.push(
    incomingStore.subscribe((s, prev) => {
      if (s.locations !== prev.locations) syncRefs();
    }),
  );

  // Ön plan konumu → son doğrulanmış konum; paylaşım yokken Güvenli Dönüş.
  unsubs.push(
    locationStore.subscribe((s, prev) => {
      const p = s.myPosition;
      if (!p || p === prev.myPosition || disposed) return;
      const offset = getServerOffsetMs();
      void recordLastFix({ latitude: p.lat, longitude: p.lng, accuracy: p.accuracy, timestamp: p.timestamp }, offset, uid);
      if (ctx.hasLiveTargets() || !safeReturnStore.getState().current || safeReturnStore.getState().current?.status !== 'active') return;
      void readDeviceStatus()
        .catch(() => ({ batteryLevel: null, isCharging: null }))
        .then((d) =>
          f9Hooks.onSafeReturnSample({
            uid,
            sample: { lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? 10_000, speed_mps: null, timestamp: Math.round(p.timestamp + offset) },
            activity: 'unknown',
            now: serverNow(),
            battery_pct: batteryPct(d.batteryLevel),
            is_charging: d.isCharging ?? null,
          }),
        )
        .catch(() => undefined);
    }),
  );

  // Tüm arkadaş paylaşımları bitti → hedef temizlenir.
  let friendTargets = selectPublishTargets(sharingStore.getState().state).length;
  unsubs.push(
    sharingStore.subscribe((s) => {
      const n = selectPublishTargets(s.state).length;
      if (friendTargets > 0 && n === 0 && destinationStore.getState().destination) void destinationStore.getState().clear().catch(() => undefined);
      friendTargets = n;
    }),
  );

  // Zamanlayıcılar: fotoğraf süpürme, Güvenli Dönüş geri sayımı (yalnızca etkin ve öndeyken).
  const sweep = setInterval(() => {
    void proofStore.getState().tick().catch(() => undefined);
    syncRefs();
  }, PROOF_LIMITS.cacheSweepMs);
  const second = setInterval(() => {
    if (AppState.currentState !== 'active') return;
    const cur = safeReturnStore.getState().current;
    if (cur && (cur.status === 'active' || safeReturnStore.getState().phase !== 'idle')) safeReturnStore.getState().tick();
  }, 1_000);
  const appState = AppState.addEventListener('change', (st) => {
    if (st !== 'active' || disposed) return;
    void proofStore.getState().tick().catch(() => undefined);
    safeReturnStore.getState().tick();
    void smsFallbackStore.getState().refreshAvailability().catch(() => undefined);
    onF9Connected();
  });

  setF9Handlers({ received: handleF9Received, open: (ev) => handleF9Open(ev) });
  const responseSub = Notifications.addNotificationResponseReceivedListener((r) => {
    void handleF9NotificationResponse(r);
  });
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) void handleF9NotificationResponse(last);
  } catch {
    // yerel modül yok (ör. test)
  }

  return () => {
    disposed = true;
    listeners.forEach((l) => l.dispose());
    unsubs.forEach((u) => u());
    clearInterval(sweep);
    clearInterval(second);
    appState.remove();
    responseSub.remove();
    setF9Handlers(null);
  };
}

/** Çıkışta: Faz 9 bellek durumu, fotoğraf önbelleği, SMS yedeği tercihi ve yerel bildirimler (kayıtlar `clearBackgroundState` ile). */
export async function resetF9State(): Promise<void> {
  await Promise.all([
    proofStore.getState().reset().catch(() => undefined),
    destinationStore.getState().reset().catch(() => undefined),
    safeReturnStore.getState().reset().catch(() => undefined),
    smsFallbackStore.getState().reset().catch(() => undefined),
  ]);
  await cancelSafeReturnLocal(null).catch(() => undefined);
}
