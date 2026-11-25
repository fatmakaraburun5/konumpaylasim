/**
 * Faz 6 oturum servisleri (sharingCoordinator `startSessionServices` içinden başlatılır):
 *
 *   widgetStore.hydrate                         → widgetSync (depolar → snapshot → yerel widget; yazma/yenileme kısıtı)
 *   friendsStore (fotoğraflar)                  → küçük boy ön belleğe (`Image.prefetch`, harita pini / liste)
 *   favoriler / arkadaş fotoğrafları değişince  → widget avatar dosyaları (`syncWidgetAvatars`)
 *   profil `favorite_ids` değişince             → favoritesStore iyimser kopyası bırakılır
 *   açılış / favori değişimi / ön plana dönüş   → widget token'ı (gerekirse al / yenile)
 *   ön plana dönüş                              → widget olayları (`consumeEvents`) → quickShareStore.last + eşitleme
 *   push (önde)                                  → `widget_refresh` / `quick_share_started` → eşitleme
 *   push (önde) Faz 5 `zone_event`               → widget yer etiketi (bölge adı)
 *
 * Çıkış: `resetF6State` (önce koordinatörün `onSignedOut`'u). Token iptali çıkıştan ÖNCE, kimlik varken
 * (`onBeforeSignOut`): sunucu bu cihazın token'ını geçersiz kılar, ardından yerel kimlik bilgisi silinir.
 */
import { QUICK_SHARE_NOTIFICATION, type OutgoingShareView, type SessionId, type UserId } from '@konum/core';
import { Image } from 'expo-image';
import { AppState, Platform } from 'react-native';
import { authStore, onBeforeSignOut } from '../state/authStore';
import { currentFavoriteIds, favoritesStore } from '../state/favoritesStore';
import { friendsStore, selectFriends } from '../state/friendsStore';
import { profileStore } from '../state/profileStore';
import { quickShareStore } from '../state/quickShareStore';
import { sharingStore } from '../state/sharingStore';
import { widgetStore } from '../state/widgetStore';
import { setF5ZoneEventTap } from './f5Services';
import * as Notifications from './notifications/expoNotifications';
import { parseF6Data, setF6Handlers, type F6PushEvent } from './notifications/f6Push';
import { consumeEvents, type WidgetQuickShareEvent } from './widgets/widgetBridge';
import { clearWidgetsOnSignOut, noteZonePlace, requestWidgetSync, syncWidgetAvatars, widgetSync, widgetTokens } from './widgets/widgetSync';

/** Avatar indirmelerini birleştirme süresi (arkadaş listesi ilk yüklenirken birkaç anlık görüntü gelir). */
const AVATAR_DEBOUNCE_MS = 1_500;
/** En çok bu kadar küçük fotoğraf ön belleğe alınır. [Varsayım] */
const PREFETCH_MAX = 60;

/** Push önde alındı (saf yönlendirme; testlerde de kullanılır). */
export function handleF6Received(ev: F6PushEvent): void {
  if (ev.type === 'quick_share_started') {
    const share = Object.values(sharingStore.getState().state.shares).find((s) => s.share_id === ev.share_id);
    quickShareStore.getState().recordWidgetEvent({
      to: share?.receiver_id ?? null,
      to_name: ev.to_name,
      status: 'started',
      at: Date.now(),
      expires_at: ev.expires_at,
      source: 'widget',
    });
  }
  requestWidgetSync('push');
}

/** Widget uzantısının kaydettiği olaylar → son sonuç (yalnızca en yenisi). */
export function applyWidgetEvents(events: readonly WidgetQuickShareEvent[]): void {
  let latest: WidgetQuickShareEvent | null = null;
  for (const e of events) if (!latest || e.at > latest.at) latest = e;
  if (!latest) return;
  quickShareStore.getState().recordWidgetEvent({
    to: latest.to_uid,
    ...(latest.to_name ? { to_name: latest.to_name } : {}),
    status: latest.status,
    at: latest.at,
    expires_at: latest.expires_at ?? null,
    source: 'widget',
    ...(latest.error ? { error: latest.error } : {}),
  });
}

/** Bildirim yanıtının bu işleyicinin okuduğu kısmı (expo-notifications `NotificationResponse` ile uyumlu). */
export interface QuickShareResponseLike {
  actionIdentifier: string;
  notification: { request: { content: { data?: unknown } } };
}

export interface QuickShareStopDeps {
  shares: () => readonly Pick<OutgoingShareView, 'share_id' | 'session_id' | 'receiver_id' | 'status'>[];
  stop: (sessionId: SessionId) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** Soğuk açılışta paylaşım listesi sunucudan gelene kadar en çok bekleme. [Varsayım: 5 sn] */
  waitMs: number;
}

const defaultStopDeps: QuickShareStopDeps = {
  shares: () => Object.values(sharingStore.getState().state.shares),
  stop: (sessionId) => sharingStore.getState().stop(sessionId),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  waitMs: 5_000,
};

/**
 * `quick_share_started` bildirimindeki "Durdur" eylemi (iOS kategori `QUICK_SHARE`). Oturum YALNIZCA bu kişiye
 * açıksa `share_stop` (sharingStore.stop: durdurma niyeti kalıcı, çevrimdışında yeniden denenir). Çok kişilik
 * oturumda herkesi kapatmamak için durdurulmaz (`not_solo`): uygulama açılır, haritadaki paylaşım kartı görünür.
 * Bildirime düz dokunuş (eylem değil) yalnızca uygulamayı açar → null.
 */
export async function handleQuickShareResponse(
  r: QuickShareResponseLike,
  deps: QuickShareStopDeps = defaultStopDeps,
): Promise<'stopped' | 'not_solo' | 'not_found' | 'failed' | null> {
  if (r.actionIdentifier !== QUICK_SHARE_NOTIFICATION.stopAction) return null;
  const ev = parseF6Data(r.notification.request.content.data as Record<string, unknown> | undefined);
  if (!ev || ev.type !== 'quick_share_started') return null;
  const find = () => deps.shares().find((s) => s.share_id === ev.share_id && s.status === 'active') ?? null;
  let share = find();
  for (let waited = 0; !share && waited < deps.waitMs; waited += 250) {
    await deps.sleep(250);
    share = find();
  }
  if (!share) return 'not_found';
  const sessionId = share.session_id;
  const others = deps.shares().some((s) => s.session_id === sessionId && s.status === 'active' && s.receiver_id !== share.receiver_id);
  if (others) return 'not_solo';
  return (await deps.stop(sessionId)) ? 'stopped' : 'failed';
}

let categoryRegistered = false;

/** iOS: `QUICK_SHARE` kategorisi + "Durdur" (uygulamayı öne getirir; Faz 1 SHARE_EXPIRING eylemleriyle aynı gerekçe). */
async function registerQuickShareCategory(): Promise<void> {
  if (categoryRegistered || Platform.OS === 'web') return;
  categoryRegistered = true;
  await Notifications.setNotificationCategoryAsync(QUICK_SHARE_NOTIFICATION.category, [
    { identifier: QUICK_SHARE_NOTIFICATION.stopAction, buttonTitle: 'Durdur', options: { opensAppToForeground: true, isDestructive: true } },
  ]).catch(() => {
    categoryRegistered = false;
  });
}

export function startF6Services(uid: UserId): () => void {
  let disposed = false;
  const unsubs: (() => void)[] = [];

  const ensureToken = () => void widgetTokens.ensure(uid, currentFavoriteIds().length > 0).catch(() => undefined);

  let avatarTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleAvatars = () => {
    if (avatarTimer) clearTimeout(avatarTimer);
    avatarTimer = setTimeout(() => {
      avatarTimer = null;
      if (!disposed) void syncWidgetAvatars().catch(() => undefined);
    }, AVATAR_DEBOUNCE_MS);
  };

  const pullWidgetEvents = async () => {
    const events = await consumeEvents().catch(() => [] as WidgetQuickShareEvent[]);
    if (disposed) return;
    applyWidgetEvents(events);
  };

  void widgetStore
    .getState()
    .hydrate()
    .then(async () => {
      if (disposed) return;
      widgetSync.start();
      await pullWidgetEvents();
      ensureToken();
      scheduleAvatars();
    });

  // Küçük fotoğraflar: harita pinleri ve liste ilk çizimde boş kalmasın (Android pin görüntüsü yüklenmeden donar).
  const prefetched = new Set<string>();
  const prefetch = () => {
    if (Platform.OS === 'web') return; // demo adresleri yereldir (avatarUri.web.ts)
    const urls: string[] = [];
    for (const f of selectFriends(friendsStore.getState())) {
      const u = f.avatarThumbUrl ?? f.avatarUrl;
      if (u && !prefetched.has(u) && prefetched.size + urls.length < PREFETCH_MAX) urls.push(u);
    }
    if (urls.length === 0) return;
    urls.forEach((u) => prefetched.add(u));
    void Image.prefetch(urls, 'memory-disk').catch(() => undefined);
  };
  prefetch();

  let lastFriendships = friendsStore.getState().friendships;
  unsubs.push(
    friendsStore.subscribe((s) => {
      if (s.friendships === lastFriendships) return;
      lastFriendships = s.friendships;
      prefetch();
      scheduleAvatars();
    }),
  );

  let lastFavKey = currentFavoriteIds().join(',');
  const onFavoritesMaybeChanged = () => {
    const key = currentFavoriteIds().join(',');
    if (key === lastFavKey) return;
    lastFavKey = key;
    scheduleAvatars();
    ensureToken();
  };
  let lastServerFavs = authStore.getState().profile?.favorite_ids;
  unsubs.push(
    authStore.subscribe((s) => {
      const favs = s.profile?.favorite_ids;
      if (favs === lastServerFavs) return;
      lastServerFavs = favs;
      favoritesStore.getState().profileChanged();
      onFavoritesMaybeChanged();
    }),
  );
  unsubs.push(favoritesStore.subscribe((s, p) => (s.optimistic !== p.optimistic ? onFavoritesMaybeChanged() : undefined)));

  const appSub = AppState.addEventListener('change', (st) => {
    if (st !== 'active' || disposed) return;
    void pullWidgetEvents().then(() => {
      if (disposed) return;
      requestWidgetSync('foreground');
      ensureToken();
    });
  });

  setF6Handlers({ received: handleF6Received });
  void registerQuickShareCategory();
  const responseSub = Notifications.addNotificationResponseReceivedListener((r) => void handleQuickShareResponse(r).catch(() => undefined));
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) void handleQuickShareResponse(last).catch(() => undefined);
  } catch {
    // yerel modül yok (ör. test)
  }
  setF5ZoneEventTap((ev) => {
    noteZonePlace(ev.from, ev.zone_name, ev.transition);
    if (widgetSync.isRunning()) widgetSync.syncNow();
  });

  return () => {
    disposed = true;
    unsubs.forEach((u) => u());
    appSub.remove();
    if (avatarTimer) clearTimeout(avatarTimer);
    avatarTimer = null;
    setF6Handlers(null);
    setF5ZoneEventTap(null);
    responseSub.remove();
    widgetSync.stop();
  };
}

/** Çıkıştan ÖNCE (kimlik varken): bu cihazın widget token'ı sunucuda iptal edilir. Hata çıkışı engellemez. */
onBeforeSignOut(() => widgetTokens.revoke());

/** Çıkışta: widget "Giriş yap" çizer, yerel kimlik bilgisi + avatarlar silinir, Faz 6 bellek durumu boşalır. */
export async function resetF6State(): Promise<void> {
  await clearWidgetsOnSignOut().catch(() => undefined);
  favoritesStore.getState().reset();
  profileStore.getState().reset();
  quickShareStore.getState().reset();
}
