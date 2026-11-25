/**
 * Faz 6: uygulama durumu → ana ekran / kilit ekranı widget'ları.
 *
 *   authStore · friendsStore · favoritesStore · incomingStore · sharingStore · permissionsStore · widgetStore
 *     → `readWidgetSyncState()` → `selectWidgetInput()` (saf; web demosu da kullanır) → core `buildWidgetSnapshot`
 *     → core `widgetSnapshotChanged` + `widgetSyncDecision` (yazma ≥ 60 sn, yenileme ≥ 5 dk; büyük değişim hemen)
 *     → widgetBridge `setSnapshot(json)` → `reload()`
 *
 *  - Favori fotoğrafları: küçük boy indirilir → `saveAvatar(uid, dosya)` (120 px, paylaşılan alan) → snapshot'ta
 *    yalnızca DOSYA ADI. Favoriden çıkan / fotoğrafı değişen kişinin dosyası silinir / yenilenir.
 *  - Token yaşam döngüsü (`createWidgetTokenManager`): oturum açıkken ve favori varken `widget_token_issue`
 *    (cihaza özel; bitişe 7 günden az kaldıysa ön planda yenilenir) → `setQuickShareCredential`. Çıkışta önce
 *    `widget_token_revoke` (kimlik varken), sonra yerel kimlik bilgisi + snapshot temizlenir.
 *  - `widget_refresh` push'u ve uygulamanın ön plana dönüşü `requestSync('push' | 'foreground')` ile kısıtlamayı
 *    aşan bir yenileme yapar (push, dinleyiciden önce gelebilir: kısa süre sonra bir kez daha).
 * Ham koordinat, token ve URL snapshot'a GİRMEZ (core widget.ts gizlilik kuralları).
 */
import {
  buildWidgetSnapshot,
  HOUR,
  isExpired,
  selectPublishTargets,
  WIDGET_LIMITS,
  WIDGET_QUICK_SHARE_ENDPOINT,
  widgetSnapshotChanged,
  widgetSyncDecision,
  widgetTokenNeedsRefresh,
  type EpochMs,
  type Gender,
  type UserId,
  type WidgetBuildInput,
  type WidgetFriendInput,
  type WidgetSnapshot,
  type ZoneTrigger,
} from '@konum/core';
import { now as serverClockNow } from '../../lib/clock';
import { toKonumError } from '../../lib/errors';
import type { ShareDoc } from '../../lib/schemas';
import { authStore } from '../../state/authStore';
import { currentFavoriteIds, favoritesStore } from '../../state/favoritesStore';
import { avatarRecyclingKey, friendsStore, selectFriends } from '../../state/friendsStore';
import { incomingStore, selectVisibleIncoming, type IncomingFriendLocation } from '../../state/incomingStore';
import { permissionsStore } from '../../state/permissionsStore';
import { sharingStore } from '../../state/sharingStore';
import { widgetStore, type WidgetTokenMeta } from '../../state/widgetStore';
import { widgetApi, type WidgetApi } from '../firebase/callables';
import { geocodeRepo } from '../maps/geocodeRepo';
import { getDeviceId } from './deviceId';
import { downloadWidgetAvatar } from './widgetAvatarFiles';
import * as bridgeModule from './widgetBridge';

export type WidgetBridgeLike = Pick<
  typeof bridgeModule,
  'setSnapshot' | 'reload' | 'saveAvatar' | 'removeAvatar' | 'setQuickShareCredential' | 'consumeEvents' | 'capabilities' | 'isWidgetModuleAvailable'
>;

// ---------------------------------------------------------------------------
// Saf: durum → buildWidgetSnapshot girdisi
// ---------------------------------------------------------------------------

export interface WidgetSyncFriend {
  uid: UserId;
  displayName: string;
  gender: Gender | null;
  /** Fotoğraf sürüm anahtarı (avatar dosyasının geçerliliği için); fotoğraf yoksa null. */
  photoKey: string | null;
}

export interface WidgetSyncState {
  now: EpochMs;
  signedIn: boolean;
  me: { display_name: string } | null;
  favoriteIds: readonly UserId[];
  friends: readonly WidgetSyncFriend[];
  /** Gösterilebilir gelen konumlar (core `selectVisibleIncoming`). */
  incoming: readonly Pick<IncomingFriendLocation, 'senderId' | 'location' | 'verified'>[];
  /** Aktif gelen paylaşım belgeleri (konum henüz gelmemiş olabilir); gizlenen ("görmeyi bırak") hariç. */
  incomingShares: readonly Pick<ShareDoc, 'sender_id' | 'status' | 'expires_at' | 'share_mode' | 'started_at'>[];
  /** Benim aktif yayın hedeflerim (durdurulanlar hariç). */
  outgoing: readonly { receiver_id: UserId; expires_at: EpochMs | null }[];
  /** Kısa yer etiketi (bölge adı / önbellekteki kısa adres); yoksa null. */
  places: Readonly<Record<UserId, string | null>>;
  /** Paylaşılan alandaki avatar dosyaları (anahtarıyla). */
  avatarFiles: Readonly<Record<UserId, { key: string; file: string }>>;
  tokenExpiresAt: EpochMs | null;
  bgLocationOk: boolean;
  lockScreenDetails: boolean;
}

export function selectWidgetInput(s: WidgetSyncState): WidgetBuildInput {
  const favs = new Set(s.favoriteIds);
  const friends: WidgetFriendInput[] = [];
  for (const f of s.friends) {
    if (!favs.has(f.uid)) continue;
    const loc = s.incoming.find((i) => i.senderId === f.uid);
    const share = s.incomingShares.find((d) => d.sender_id === f.uid && d.status === 'active' && !isExpired(d, s.now));
    const file = s.avatarFiles[f.uid];
    friends.push({
      uid: f.uid,
      display_name: f.displayName,
      gender: f.gender,
      // Dosya yalnızca güncel fotoğraf sürümüne aitse (kaldırılan / değişen fotoğraf widget'ta kalmasın).
      avatar_file: file && f.photoKey !== null && file.key === f.photoKey ? file.file : null,
      incoming: loc
        ? {
            active: true,
            paused: loc.verified?.status === 'offline_suspected',
            last_seen_at: loc.location.timestamp,
            battery_pct: loc.location.battery_pct,
            place: s.places[f.uid] ?? null,
          }
        : share
          ? { active: true, last_seen_at: null }
          : null,
    });
  }
  return {
    now: s.now,
    signed_in: s.signedIn,
    me: s.me,
    favorite_ids: s.favoriteIds,
    friends,
    outgoing: s.outgoing.map((o) => ({ receiver_id: o.receiver_id, status: 'active' as const, expires_at: o.expires_at })),
    quick: { token_expires_at: s.tokenExpiresAt, bg_location_ok: s.bgLocationOk },
    privacy: { lock_screen_details: s.lockScreenDetails },
  };
}

/**
 * Faz 5 bölge olayı push'undan (önde alınan `zone_event`) kısa yer etiketi: arkadaş bölgeye vardı → bölge adı,
 * ayrıldı → silinir. Yalnızca bellekte, en çok `ZONE_PLACE_TTL_MS`. [Varsayım: 6 sa] Koordinat yok.
 */
const ZONE_PLACE_TTL_MS = 6 * HOUR;
const zonePlaces = new Map<UserId, { label: string; at: EpochMs }>();

export function noteZonePlace(from: UserId, zoneName: string, transition: ZoneTrigger, at: EpochMs = serverClockNow()): void {
  if (transition === 'arrive') zonePlaces.set(from, { label: zoneName, at });
  else zonePlaces.delete(from);
}

export function clearZonePlaces(): void {
  zonePlaces.clear();
}

function zonePlaceOf(uid: UserId, now: EpochMs): string | null {
  const z = zonePlaces.get(uid);
  if (!z) return null;
  if (now - z.at > ZONE_PLACE_TTL_MS) {
    zonePlaces.delete(uid);
    return null;
  }
  return z.label;
}

/** Uygulama depolarından anlık durum (web demosu önizlemesi de bunu kullanır). */
export function readWidgetSyncState(now: EpochMs = serverClockNow()): WidgetSyncState {
  const auth = authStore.getState();
  const signedIn = auth.status === 'ready' && !!auth.uid && !!auth.profile;
  const inc = incomingStore.getState();
  const visible = signedIn ? selectVisibleIncoming(inc, now) : [];
  const incomingShares = signedIn
    ? Object.values(inc.shares).filter((d) => {
        const hiddenAt = inc.hiddenSenders[d.sender_id];
        return d.status === 'active' && !isExpired(d, now) && !(hiddenAt !== undefined && d.started_at <= hiddenAt);
      })
    : [];
  const favoriteIds = signedIn ? currentFavoriteIds() : [];
  const favSet = new Set(favoriteIds);
  const friends = signedIn
    ? selectFriends(friendsStore.getState()).map((f) => ({
        uid: f.uid,
        displayName: f.displayName,
        gender: f.gender,
        photoKey: avatarRecyclingKey(f.avatarThumbUrl ?? f.avatarUrl),
      }))
    : [];
  const places: Record<UserId, string | null> = {};
  for (const l of visible) {
    if (!favSet.has(l.senderId) || l.senderId in places) continue;
    // Önce bölge adı; sonra yalnızca önbellek (widget için ağ çağrısı yapılmaz: adres kotası). Kullanıcı kartı
    // açtıysa adres bilinir.
    places[l.senderId] = zonePlaceOf(l.senderId, now) ?? geocodeRepo.peek({ lat: l.location.lat, lng: l.location.lng }) ?? null;
  }
  const w = widgetStore.getState();
  const token = w.token && auth.uid && w.token.owner === auth.uid ? w.token.expires_at : null;
  return {
    now,
    signedIn,
    me: signedIn && auth.profile ? { display_name: auth.profile.display_name } : null,
    favoriteIds,
    friends,
    incoming: visible,
    incomingShares,
    outgoing: signedIn ? selectPublishTargets(sharingStore.getState().state).map((t) => ({ receiver_id: t.receiver_id, expires_at: t.expires_at })) : [],
    places,
    avatarFiles: w.avatarFiles,
    tokenExpiresAt: token,
    bgLocationOk: permissionsStore.getState().background === 'granted',
    lockScreenDetails: w.lockScreenDetails,
  };
}

/** Şu anki snapshot (yazmadan). */
export function currentWidgetSnapshot(now: EpochMs = serverClockNow()): WidgetSnapshot {
  return buildWidgetSnapshot(selectWidgetInput(readWidgetSyncState(now)));
}

// ---------------------------------------------------------------------------
// Eşitleyici: yazma / yenileme kısıtlaması
// ---------------------------------------------------------------------------

export interface WidgetSyncDeps {
  bridge: Pick<WidgetBridgeLike, 'setSnapshot' | 'reload'>;
  build: () => WidgetSnapshot;
  subscribe: (onChange: () => void) => () => void;
  now: () => EpochMs;
  /** Depo değişimlerini birleştirme süresi (sharingStore saniyede bir tik atar). */
  debounceMs: number;
  onWritten?: (snap: WidgetSnapshot, at: EpochMs) => void;
  /**
   * Girdi hazır mı (ör. arkadaş listesi yüklendi). Hazır değilken yazılmaz: açılışta favoriler bir an boş
   * görünüp geri gelmesin (iki gereksiz yenileme). Abonelik hazır olunca yeniden değerlendirir.
   */
  ready?: () => boolean;
}

export interface WidgetSyncController {
  start: () => void;
  stop: () => void;
  /** Hemen değerlendir; `force` = görünür fark yoksa bile yaz + yenile (push / ön plan). */
  syncNow: (opts?: { force?: boolean }) => 'none' | 'minor' | 'major';
  isRunning: () => boolean;
  lastSnapshot: () => WidgetSnapshot | null;
}

export function createWidgetSync(deps: WidgetSyncDeps): WidgetSyncController {
  let last: WidgetSnapshot | null = null;
  let lastWriteAt: EpochMs | null = null;
  let lastReloadAt: EpochMs | null = null;
  let reloadPending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let unsub: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** Yazma ve yenileme sıralı: widget yeni snapshot yazılmadan yeniden çizilmesin. */
  function emit(json: string | null, reload: boolean) {
    chain = chain
      .then(async () => {
        if (json !== null) await deps.bridge.setSnapshot(json);
        if (reload) deps.bridge.reload('all');
      })
      .catch(() => undefined);
  }

  function syncNow(opts: { force?: boolean } = {}): 'none' | 'minor' | 'major' {
    clearTimer();
    if (deps.ready && !deps.ready()) return 'none';
    const t = deps.now();
    const snap = deps.build();
    const change = widgetSnapshotChanged(last, snap);
    const d = widgetSyncDecision({ change: opts.force ? 'major' : change, now: t, last_write_at: lastWriteAt, last_reload_at: lastReloadAt });
    let reload = d.reload;
    if (d.write) {
      last = snap;
      lastWriteAt = t;
      if (!reload) reloadPending = true;
      deps.onWritten?.(snap, t);
    }
    let next = d.next_check_at;
    // Yazılmış ama yenilenmemiş küçük değişim: yenileme aralığı dolunca bir kez yenile.
    if (!reload && reloadPending) {
      const at = (lastReloadAt ?? t) + WIDGET_LIMITS.reloadMinIntervalMs;
      if (t >= at) reload = true;
      else next = next === null ? at : Math.min(next, at);
    }
    if (reload) {
      lastReloadAt = t;
      reloadPending = false;
    }
    if (d.write || reload) emit(d.write ? JSON.stringify(snap) : null, reload);
    if (next !== null && unsub) timer = setTimeout(() => syncNow(), Math.max(0, next - t));
    return change;
  }

  return {
    start: () => {
      if (unsub) return;
      unsub = deps.subscribe(() => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          if (unsub) syncNow();
        }, deps.debounceMs);
      });
      syncNow();
    },
    stop: () => {
      unsub?.();
      unsub = null;
      clearTimer();
      if (debounce) clearTimeout(debounce);
      debounce = null;
    },
    syncNow,
    isRunning: () => unsub !== null,
    lastSnapshot: () => last,
  };
}

// ---------------------------------------------------------------------------
// Token yaşam döngüsü
// ---------------------------------------------------------------------------

export interface WidgetTokenDeps {
  api: WidgetApi;
  bridge: Pick<WidgetBridgeLike, 'setQuickShareCredential' | 'isWidgetModuleAvailable'>;
  deviceId: () => Promise<string>;
  now: () => EpochMs;
  getMeta: () => WidgetTokenMeta | null;
  setMeta: (m: WidgetTokenMeta | null) => void;
  setError: (e: string | null) => void;
  endpoint: () => string;
}

export interface WidgetTokenManager {
  /** Oturum açık + favori var + yerel modül var → gerekirse token al / yenile. */
  ensure: (uid: UserId, hasFavorites: boolean) => Promise<'skipped' | 'fresh' | 'issued' | 'error'>;
  /** Çıkıştan ÖNCE (kimlik varken): bu cihazın token'ını sunucuda iptal et. */
  revoke: () => Promise<void>;
  /** Yerel kimlik bilgisini ve meta veriyi sil. */
  clearLocal: () => Promise<void>;
}

export function createWidgetTokenManager(deps: WidgetTokenDeps): WidgetTokenManager {
  let inflight: Promise<'skipped' | 'fresh' | 'issued' | 'error'> | null = null;
  return {
    ensure: (uid, hasFavorites) => {
      if (inflight) return inflight;
      inflight = (async () => {
        if (!deps.bridge.isWidgetModuleAvailable() || !hasFavorites) return 'skipped' as const;
        const meta = deps.getMeta();
        if (meta && meta.owner === uid && !widgetTokenNeedsRefresh(meta.expires_at, deps.now())) return 'fresh' as const;
        try {
          const res = await deps.api.widgetTokenIssue({ device_id: await deps.deviceId() });
          await deps.bridge.setQuickShareCredential({ token: res.token, endpoint: deps.endpoint(), expires_at: res.expires_at });
          deps.setMeta({ owner: uid, expires_at: res.expires_at });
          return 'issued' as const;
        } catch (e) {
          // Eski token (varsa) bitene kadar geçerli; widget süresi dolunca uygulamayı açar.
          deps.setError(toKonumError(e).message);
          return 'error' as const;
        }
      })().finally(() => (inflight = null));
      return inflight;
    },
    revoke: async () => {
      if (!deps.getMeta()) return;
      try {
        await deps.api.widgetTokenRevoke({ device_id: await deps.deviceId() });
      } catch {
        // Çevrimdışı çıkış: sunucudaki token 30 günde kendiliğinden geçersizleşir; hesap silmede hepsi iptal edilir.
      }
    },
    clearLocal: async () => {
      await deps.bridge.setQuickShareCredential(null);
      deps.setMeta(null);
    },
  };
}

/**
 * Callable uç noktası: üretimde yalnızca ad (yerel kod `https://europe-west1-<proje>.cloudfunctions.net/<ad>`
 * kurar); emülatörde tam adres (`http://<host>:5001/<proje>/europe-west1/<ad>`).
 */
export function quickShareEndpoint(): string {
  if (typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_USE_EMULATORS === '1') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getApp } = require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
      const projectId = getApp().options.projectId;
      const host = process.env.EXPO_PUBLIC_EMULATOR_HOST || 'localhost';
      if (projectId) return `http://${host}:5001/${projectId}/europe-west1/${WIDGET_QUICK_SHARE_ENDPOINT}`;
    } catch {
      // yapılandırma yok: ada düş
    }
  }
  return WIDGET_QUICK_SHARE_ENDPOINT;
}

// ---------------------------------------------------------------------------
// Uygulama bağlaması
// ---------------------------------------------------------------------------

const bridge: WidgetBridgeLike = bridgeModule;

function subscribeStores(cb: () => void): () => void {
  const subs = [
    authStore.subscribe(cb),
    friendsStore.subscribe(cb),
    favoritesStore.subscribe((s, p) => (s.optimistic !== p.optimistic ? cb() : undefined)),
    incomingStore.subscribe(cb),
    sharingStore.subscribe(cb),
    permissionsStore.subscribe(cb),
    widgetStore.subscribe((s, p) => {
      // Kendi `setWritten` yazımız döngü kurmasın.
      if (s.avatarFiles !== p.avatarFiles || s.token !== p.token || s.lockScreenDetails !== p.lockScreenDetails) cb();
    }),
  ];
  return () => subs.forEach((u) => u());
}

export const widgetSync: WidgetSyncController = createWidgetSync({
  bridge,
  build: () => currentWidgetSnapshot(),
  subscribe: subscribeStores,
  now: serverClockNow,
  debounceMs: 800,
  onWritten: (snap, at) => widgetStore.getState().setWritten(snap, at),
  ready: () => authStore.getState().status !== 'ready' || friendsStore.getState().loaded,
});

export const widgetTokens: WidgetTokenManager = createWidgetTokenManager({
  api: widgetApi,
  bridge,
  deviceId: getDeviceId,
  now: serverClockNow,
  getMeta: () => widgetStore.getState().token,
  setMeta: (m) => widgetStore.getState().setToken(m),
  setError: (e) => widgetStore.getState().setTokenError(e),
  endpoint: quickShareEndpoint,
});

let followUp: ReturnType<typeof setTimeout> | null = null;

/** Push / ön plan: kısıtlamayı aşan yenileme + dinleyiciler yetişince bir kez daha. [Varsayım: 3 sn] */
export function requestWidgetSync(_reason: 'push' | 'foreground' | 'event'): void {
  if (!widgetSync.isRunning()) {
    bridge.reload('all');
    return;
  }
  widgetSync.syncNow({ force: true });
  if (followUp) clearTimeout(followUp);
  followUp = setTimeout(() => {
    followUp = null;
    if (widgetSync.isRunning()) widgetSync.syncNow();
  }, 3_000);
}

let avatarRun: Promise<void> | null = null;

/**
 * Favori fotoğrafları: sürümü değişen / yeni favorilerin küçük boyu indirilip paylaşılan alana yazılır; favoriden
 * çıkanların dosyası silinir. Yerel modül yoksa (web, Expo Go) hiçbir şey yapılmaz.
 */
export function syncWidgetAvatars(): Promise<void> {
  if (avatarRun) return avatarRun;
  avatarRun = (async () => {
    if (!bridge.isWidgetModuleAvailable()) return;
    const s = readWidgetSyncState();
    const favs = new Set(s.favoriteIds);
    const files = widgetStore.getState().avatarFiles;
    for (const uid of Object.keys(files)) {
      if (favs.has(uid)) continue;
      await bridge.removeAvatar(uid);
      widgetStore.getState().setAvatarFile(uid, null);
    }
    const byUid = new Map(selectFriends(friendsStore.getState()).map((f) => [f.uid, f]));
    for (const uid of s.favoriteIds) {
      const f = byUid.get(uid);
      if (!f) continue;
      const url = f.avatarThumbUrl ?? f.avatarUrl;
      const key = avatarRecyclingKey(url);
      const have = widgetStore.getState().avatarFiles[uid];
      if (!url || !key) {
        if (have) {
          await bridge.removeAvatar(uid);
          widgetStore.getState().setAvatarFile(uid, null);
        }
        continue;
      }
      if (have?.key === key) continue;
      const local = await downloadWidgetAvatar(uid, url);
      const file = local ? await bridge.saveAvatar(uid, local) : null;
      if (file) widgetStore.getState().setAvatarFile(uid, { key, file });
    }
  })().finally(() => (avatarRun = null));
  return avatarRun;
}

/** Çıkış: yerel kimlik bilgisi, avatarlar ve snapshot temizlenir (widget "Giriş yap" çizer). */
export async function clearWidgetsOnSignOut(): Promise<void> {
  widgetSync.stop();
  clearZonePlaces();
  await widgetTokens.clearLocal().catch(() => undefined);
  for (const uid of Object.keys(widgetStore.getState().avatarFiles)) await bridge.removeAvatar(uid);
  const t = serverClockNow();
  const empty = buildWidgetSnapshot({ now: t, signed_in: false, me: null, favorite_ids: [], friends: [], outgoing: [], quick: { token_expires_at: null, bg_location_ok: false } });
  await bridge.setSnapshot(JSON.stringify(empty));
  bridge.reload('all');
  await widgetStore.getState().reset();
}
