/**
 * Faz 8 servisleri.
 *
 * Modül düzeyi (`installF8Guards`, sharingCoordinator yüklenince bir kez; oturum servisleri BAŞLAMADAN da çalışır):
 *   authStore profili → `publishHold`:
 *     - güncel onay yok (`clientConsentRequired`) → onay kapısı anahtarı (yayın yok), onaylanınca kalkar; onaylı
 *       sürüm de kaydedilir (başsız bağlam sürüm yükseltmesini kayıttan anlar)
 *     - çıkışta saklanan onaylanmamış görünmez niyeti (aynı hesap) geri gelir ve aynı op_id ile yeniden gönderilir
 *     - `profile.invisible` → invisibleStore.applyServer (başka cihazdan görünmez olunduysa da yayın kesilir)
 *   anahtar kapanınca (`isPublishHeld`) konum hattı hemen budanır (`applyPublishHold`).
 *
 * Oturum (`startF8Services`, sharingCoordinator `startSessionServices` içinden):
 *   Firestore permission_grants (granter == ben / grantee == ben) → grantsStore.setSnapshot
 *   Push (önde) `permission_request` / `permission_granted` → yerel bildirim (push.ts); dokunma → Arkadaşlar
 *   Açılış / bağlantı geldi → onaylanmamış görünmez niyeti aynı op_id ile yeniden gönderilir
 */
import { clientConsentRequired, type UserId } from '@konum/core';
import { authStore, type AuthState } from '../state/authStore';
import { consentStore } from '../state/consentStore';
import { friendsStore, selectFriends } from '../state/friendsStore';
import { grantsStore } from '../state/grantsStore';
import { invisibleStore } from '../state/invisibleStore';
import { clearPublishHold, hydratePublishHold, isPublishHeld, onPublishHoldChange, setConsentHold, takePendingInvisible } from '../state/publishHold';
import { listenGrants } from './firebase/grantsRepo';
import { applyPublishHold } from './location/pipeline';
import * as Notifications from './notifications/expoNotifications';
import { routeF8Open, setF8Handlers, type F8PushEvent } from './notifications/f8Push';
import { resilientListener, type ResilientListener } from './resilientListener';

/** Arkadaşın görünen adı (push metni için); yoksa null. */
export function friendNameOf(uid: UserId): string | null {
  const name = selectFriends(friendsStore.getState()).find((f) => f.uid === uid)?.displayName?.trim();
  return name ? name : null;
}

/** Bildirime dokunma: izin isteği → Arkadaşlar ekranı, istek öne çıkar. */
export function handleF8Open(ev: F8PushEvent): void {
  if (ev.type === 'permission_request') grantsStore.getState().focusRequest(ev.from);
  openFriends();
}

/** Önde alındı: dinleyici zaten güncelliyor; yerel bildirimi push.ts gösterir. */
export function handleF8Received(_ev: F8PushEvent): void {
  // bilerek boş
}

function openFriends(): void {
  try {
    // Gecikmeli: servis katmanı yönlendiriciye derleme zamanında bağlanmasın (testler, başsız bağlam).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { router } = require('expo-router') as { router?: { push: (href: string) => void } };
    router?.push('/friends');
  } catch {
    // yönlendirici yok (test / başsız)
  }
}

let guardsInstalled = false;

function syncFromProfile(s: Pick<AuthState, 'uid' | 'status' | 'profile'>): void {
  const uid = s.uid;
  if (!uid || !s.profile || (s.status !== 'ready' && s.status !== 'needsProfile')) return;
  const consent = s.profile.consent ?? null;
  void setConsentHold(uid, clientConsentRequired(consent), consent?.version ?? null).catch(() => undefined);
  const restored = takePendingInvisible(uid);
  invisibleStore.getState().applyServer(uid, s.profile.invisible ?? null);
  // Onaydan muaf: onay kapısı açıkken de gönderilir.
  if (restored) void invisibleStore.getState().retryPending();
}

/** Bir kez: profil → kesme anahtarı; anahtar kapanınca konum hattı budanır. */
export function installF8Guards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  onPublishHoldChange(() => {
    if (isPublishHeld()) void applyPublishHold().catch(() => undefined);
  });
  // Önce diskteki niyet (başsız görevin yazdığı da) belleğe gelsin; sonra profil izlenir.
  void hydratePublishHold()
    .catch(() => undefined)
    .then(() => {
      syncFromProfile(authStore.getState());
      authStore.subscribe((s, prev) => {
        if (s.profile !== prev.profile || s.status !== prev.status || s.uid !== prev.uid) syncFromProfile(s);
      });
    });
}

/**
 * Bağlantı geldi / ön plana dönüldü (sharingCoordinator; onay kapısı açıkken de): bekleyen görünmez olma isteği ve ağ
 * hatasında kalan konum izni geri almaları aynı op_id ile (ikisi de onaydan muaf).
 */
export function onF8Connected(): void {
  void invisibleStore.getState().retryPending();
  void grantsStore.getState().retryPendingRevokes();
}

export function startF8Services(uid: UserId): () => void {
  const listeners: ResilientListener[] = [];
  listeners.push(
    resilientListener('permission_grants', (h) =>
      listenGrants(
        uid,
        (docs) => {
          h.ok();
          grantsStore.getState().setSnapshot(uid, docs);
        },
        h.error,
      ),
    ),
  );

  setF8Handlers({ received: handleF8Received, open: handleF8Open });
  const responseSub = Notifications.addNotificationResponseReceivedListener((r) => {
    routeF8Open(r.notification.request.content.data as Record<string, unknown> | undefined);
  });
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) routeF8Open(last.notification.request.content.data as Record<string, unknown> | undefined);
  } catch {
    // yerel modül yok (ör. test)
  }

  void hydratePublishHold().then(() => invisibleStore.getState().retryPending()).catch(() => undefined);

  return () => {
    listeners.forEach((l) => l.dispose());
    responseSub.remove();
    setF8Handlers(null);
  };
}

/** Çıkışta: kesme anahtarı (bellek + disk) ve Faz 8 bellek durumu silinir. */
export async function resetF8State(): Promise<void> {
  await clearPublishHold().catch(() => undefined);
  grantsStore.getState().reset();
  invisibleStore.getState().reset();
  consentStore.getState().reset();
}
