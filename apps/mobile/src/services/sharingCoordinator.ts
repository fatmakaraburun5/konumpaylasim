/**
 * Oturum açıkken çalışan bağlantılar ve yan etkiler (store → services → Firebase):
 *
 *   Firestore location_shares (sender_id == ben)  → durdurma niyeti uzlaştırma + sharingStore.applyServerShares
 *   Firestore location_shares (receiver_id == ben) → incomingStore.setShares
 *   RTDB live_locations/{ben}                       → incomingStore.upsert/removeLocation
 *   RTDB .info/serverTimeOffset                     → lib/clock (+ arka plan için kalıcı)
 *   RTDB .info/connected                            → bekleyen durdurmaları ve hatalı dinleyicileri hemen yenile
 *   Firestore friendships                           → friendsStore
 *   Faz 2: Firestore link_shares (sender_id == ben) → bağlantı durdurma niyeti uzlaştırma + linkStore.applyServerLinks
 *
 *   sharingStore + linkStore yayın hedefleri değişince → AsyncStorage (arka plan görevi okur) → konum takibi aç/kapa
 *   sharingStore oturumları + bağlantılar değişince   → "süre dolmak üzere" bildirimlerini yeniden planla
 *   AppState                                 → ön plan izleme + nabız, Android'de profil güncelleme
 *
 *   Faz 3:
 *   RTDB live_trail/{ben}                    → incomingStore.setTrail (çevrimdışı eşitlenen noktalar, kesikli çizgi)
 *   RTDB .info/connected true / ön plana dönüş → çevrimdışı kuyruğu boşalt (pipeline.flushOutbox)
 *   Durdurma niyeti / bağlantı durdurma        → kuyruktan o hedeflerin noktaları HEMEN silinir
 *   Takip başladı                             → uyarlamalı zamanlayıcı + OS etkinliği (adaptive/runtime)
 *
 *   Faz 4 (f4Services.ts): ping kutusu, yer notları, SOS uyarıları, acil kişiler, bildirim dokunuşları;
 *   durum notu değişince canlı hedef varsa hemen bir paket yayınlanır (not arkadaş paketlerine eklenir).
 *
 *   Faz 5 (f5Services.ts): bölgeler + OS bölge kaydı, bölge olayları, buluşma önerileri, ön plan örnekleri → bölge
 *   filtresi; bağlantı gelince kuyruktaki bölge olayları gönderilir.
 *
 *   Faz 6 (f6Services.ts): depolar → ana ekran / kilit ekranı widget snapshot'ı (kısıtlı yazma / yenileme), favori
 *   fotoğrafları paylaşılan alana, widget token'ı, widget olayları, fotoğraf ön belleği.
 *
 *   Faz 8 (f8Services.ts): yönlü izinler (permission_grants) → grantsStore; izin push'ları. Kesme anahtarı
 *   (`publishHold`: görünmez niyeti ya da onay kapısı) açıkken yayın hedefleri BOŞ sayılır (kalıcı hedefler boş
 *   yazılır → takip durur, ön plan yayını / nabız yok); bu cihazda konum izni geri alınan kişiye yayın hemen kesilir.
 *
 * Açılış sırası (yayın asla kullanıcının durdurduğu paylaşıma geri dönmez):
 *   1. Kalıcı durdurma niyetleri bu hesaba bağlanır ve reducer'a geri yüklenir (STOP_REQUESTED).
 *   2. Sunucu anlık görüntüsü henüz yoksa, kalıcı hedeflerdeki oturum özeti GEÇİCİ olarak gösterilir:
 *      dinleyici hata verse de kullanıcı süren paylaşımı görür ve "Durdur"a basabilir.
 *   3. Kalıcı hedefler ve konum takibi YALNIZCA gerçek bir sunucu anlık görüntüsünden sonra yeniden yazılır.
 *   4. Bekleyen durdurmalar aynı op_id ile yeniden gönderilir.
 *
 * Bağlantı hedefleri de aynı kuralla: `link_shares` anlık görüntüsü gelene kadar diskteki bağlantı hedeflerine
 * dokunulmaz (yalnızca kullanıcının durdurdukları çıkarılır); bir dinleyicinin hatası diğerinin hedeflerini
 * kalıcılaştırmasını engellemez.
 *
 * Her dinleyici hata verirse geri çekilmeli olarak yeniden abone olur (`resilientListener`);
 * hata süresince haritada uyarı şeridi görünür (`syncStatusStore`).
 */
import {
  linkSenderName,
  MINUTE,
  selectPublishTargets,
  selectSessions,
  TRACKING_PROFILES,
  publishTargetsKey,
  type LinkPublishTarget,
  type LinkShareView,
  type OutgoingShareView,
  type PublishTarget,
  type SharingState,
  type UserId,
} from '@konum/core';
import * as Notifications from './notifications/expoNotifications';
import { AppState, type AppStateStatus } from 'react-native';
import { getServerOffsetMs, now as serverClockNow, onServerOffsetChange, setServerOffsetMs } from '../lib/clock';
import type { ShareDoc } from '../lib/schemas';
import { untilClock } from '../lib/turkish';
import { authStore, onSignedOut } from '../state/authStore';
import { friendsStore } from '../state/friendsStore';
import { incomingStore } from '../state/incomingStore';
import { locationStore } from '../state/locationStore';
import { bindLinkStopsOwner, isLinkBlocked, listLinkStops, onLinkStopsChange, reconcileLinkStops } from '../state/linkStops';
import { linkStore, selectLinkSessions, selectLinkTargets, type LinkStoreState } from '../state/linkStore';
import {
  clearBackgroundState,
  clearCursor,
  inTargetsLock,
  loadTargets,
  type PersistedLinkTarget,
  type PersistedTarget,
  type PersistedTargets,
} from '../state/persist';
import { permissionFlowStore } from '../state/permissionFlowState';
import { permissionsStore } from '../state/permissionsStore';
import { sharingStore, type SharingStoreState } from '../state/sharingStore';
import {
  bindStopIntentsOwner,
  blockedShareIds,
  getStopIntent,
  isShareBlocked,
  listStopIntents,
  onStopIntentsChange,
  reconcileStopIntents,
} from '../state/stopIntents';
import { syncStatusStore, type SyncChannel } from '../state/syncStatusStore';
import { listenOutgoingLinks, recentLinks, toLinkView, type LinkDoc } from './firebase/linksRepo';
import * as LiveRepo from './firebase/liveRepo';
import { listenConnected, listenInbox, listenServerTimeOffset } from './firebase/liveRepo';
import { listenFriendships, listenOutgoingRequests } from './firebase/profileRepo';
import { listenIncomingShares, listenOutgoingShares, toOutgoingView } from './firebase/sharesRepo';
import { ensureAdaptiveRuntime, stopAdaptiveRuntime } from './location/adaptive/runtime';
import { locationEngine } from './location/ExpoLocationEngine';
import { applyTrackingNow, flushOutbox, handleSamples, resetAdaptive } from './location/pipeline';
import { outboxRepo } from './outbox/outboxRepo';
import { handleExpiryResponse, type ExtendRoutes, type ExtendViaStore } from './notifications/expiryActions';
import { cancelAllExpiryNotifications, configureNotifications, syncExpiryNotifications } from './notifications/expiryNotifications';
import { registerPushToken } from './notifications/push';
import { resilientListener, type ListenerHandlers, type ResilientListener } from './resilientListener';
import { resetF4Stores, startF4Services } from './f4Services';
import { onF5Connected, resetF5State, startF5Services } from './f5Services';
import { resetF6State, startF6Services } from './f6Services';
import { installF8Guards, onF8Connected, resetF8State, startF8Services } from './f8Services';
import { resetLocationRequestState, startLocationRequestServices } from './locationRequestServices';
import { grantsStore, isLocationRevoked } from '../state/grantsStore';
import { isPublishHeld, onPublishHoldChange } from '../state/publishHold';
import { linkTokenVault } from './security/linkTokenVault';

/**
 * Biten paylaşımlar Firestore'da bir süre mezar taşı olarak kalır (TTL 7 gün). Kartta yalnızca
 * yakın zamanda bitenler gösterilir ("Karşı taraf paylaşımı kapattı" gibi). [Varsayım] 10 dk.
 */
const RECENT_END_MS = 10 * MINUTE;
/** [Varsayım] Soğuk açılışta bildirim eylemi için ilk sunucu anlık görüntüsünü en çok bu kadar bekle. */
const COLD_START_SNAPSHOT_WAIT_MS = 6_000;

export function recentOrActive(docs: readonly ShareDoc[], now: number): ShareDoc[] {
  return docs.filter((d) =>
    d.status === 'active'
      ? d.expires_at === null || d.expires_at > now - RECENT_END_MS
      : (d.ended_at ?? d.expires_at ?? 0) > now - RECENT_END_MS,
  );
}

/** Ön plan servisi bildirimi: "2 kişiyle · 17:45'e kadar", bağlantı varsa "2 kişiyle + QR bağlantısı · …". */
export function notificationBodyFor(targets: readonly PublishTarget[], links: readonly Pick<LinkPublishTarget, 'expires_at'>[] = []): string {
  const n = new Set(targets.map((t) => t.receiver_id)).size;
  const who =
    links.length === 0
      ? `${n} kişiyle`
      : n === 0
        ? links.length === 1
          ? 'QR bağlantısıyla'
          : `${links.length} QR bağlantısıyla`
        : `${n} kişiyle + ${links.length === 1 ? 'QR bağlantısı' : `${links.length} QR bağlantısı`}`;
  const all = [...targets.map((t) => t.expires_at), ...links.map((t) => t.expires_at)];
  if (all.some((e) => e === null)) return `${who} · süresiz`;
  const last = Math.max(...(all as number[]));
  return `${who} · ${untilClock(last)}`;
}

/** Bağlantı hedeflerine oturum özeti ekler (açılışta geçici kart için). */
export function withLinkMeta(targets: readonly LinkPublishTarget[], links: Record<string, LinkShareView>): PersistedLinkTarget[] {
  return targets.map((t) => {
    const v = links[t.link_id];
    return v ? { ...t, session_id: v.session_id, started_at: v.started_at, version: v.version, extended_count: v.extended_count } : { ...t };
  });
}

/** Kalıcı bağlantı hedeflerinden geçici görünümler (oturum özeti olmayanlar atlanır). */
export function provisionalLinkViews(persisted: PersistedTargets): LinkShareView[] {
  const out: LinkShareView[] = [];
  for (const t of persisted.linkTargets) {
    if (t.session_id === undefined || t.started_at === undefined || t.version === undefined) continue;
    out.push({
      link_id: t.link_id,
      session_id: t.session_id,
      token_hash: t.token_hash,
      status: 'active',
      share_mode: t.share_mode,
      started_at: t.started_at,
      expires_at: t.expires_at,
      end_reason: null,
      version: t.version,
      extended_count: t.extended_count ?? 0,
    });
  }
  return out;
}

/** Bağlantı paketindeki görünen ad (telefon ASLA). */
const currentSenderName = () => linkSenderName(authStore.getState().profile?.display_name);

/** Yayın hedeflerine oturum özetini ekler (açılışta geçici kart için). */
export function withSessionMeta(targets: readonly PublishTarget[], state: SharingState): PersistedTarget[] {
  return targets.map((t) => {
    const s = state.shares[t.share_id];
    return s ? { ...t, session_id: s.session_id, started_at: s.started_at, version: s.version } : { ...t };
  });
}

/** Kalıcı hedeflerden geçici (sunucu onayı bekleyen) paylaşım görünümleri; oturum özeti olmayanlar atlanır. */
export function provisionalViews(persisted: PersistedTargets): OutgoingShareView[] {
  const out: OutgoingShareView[] = [];
  for (const t of persisted.targets) {
    if (t.session_id === undefined || t.started_at === undefined || t.version === undefined) continue;
    out.push({
      share_id: t.share_id,
      session_id: t.session_id,
      receiver_id: t.receiver_id,
      status: 'active',
      share_mode: t.share_mode,
      started_at: t.started_at,
      expires_at: t.expires_at,
      end_reason: null,
      version: t.version,
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Faz 8: profil → kesme anahtarı (oturum servisleri onay kapısında başlamasa da yayın kesilir).
installF8Guards();

/**
 * Faz 8: onay kapısı açıkken (oturum servisleri BAŞLAMAZ) yalnızca koruyucu, onaydan muaf istekler sürer: bekleyen
 * paylaşım / bağlantı durdurmaları, onaylanmamış görünmez olma isteği ve ağ hatasında kalan konum izni geri almaları
 * (aynı op_id) açılışta, bağlantı gelince ve ön plana dönünce yeniden gönderilir. Konum yayını yok (publishHold).
 */
export function startGateServices(uid: UserId): () => void {
  let disposed = false;
  const retry = () => {
    if (disposed) return;
    void sharingStore.getState().retryPendingStops();
    void linkStore.getState().retryPendingStops();
    onF8Connected();
  };
  void (async () => {
    await bindStopIntentsOwner(uid).catch(() => []);
    await bindLinkStopsOwner(uid).catch(() => []);
    retry();
  })();
  const unsubConnected = listenConnected((c) => {
    if (c) retry();
  });
  const appState = AppState.addEventListener('change', (st) => {
    if (st === 'active') retry();
  });
  return () => {
    disposed = true;
    unsubConnected();
    appState.remove();
  };
}

export function startSessionServices(uid: UserId): () => void {
  let disposed = false;
  const unsubs: (() => void)[] = [];
  void configureNotifications();

  // --- dinleyiciler (hata → geri çekilmeli yeniden abonelik) ------------------------------

  const listeners: ResilientListener[] = [];
  const watch = (name: SyncChannel, subscribe: (h: ListenerHandlers) => () => void) => {
    const l = resilientListener(name, subscribe, { onStatus: (_n, healthy) => syncStatusStore.getState().setHealthy(name, healthy) });
    listeners.push(l);
  };
  const resubscribeFailing = () => listeners.forEach((l) => l.resubscribeNow());

  let restored = false;
  let snapshotReceived = false;
  /** Açılışta kalıcı hedeflerden geçici oturum gösterildi mi. */
  let seeded = false;
  /** Son ham anlık görüntü: niyetler diskten yüklendikten sonra bir kez daha uzlaştırmak için. */
  let lastDocs: ShareDoc[] | null = null;
  let markFirstSnapshot: () => void = () => undefined;
  const firstSnapshot = new Promise<void>((r) => (markFirstSnapshot = r));
  /** Faz 2: bağlantı anlık görüntüsü (link_shares) — arkadaş anlık görüntüsünden bağımsız. */
  let linkSnapshotReceived = false;
  let linkSeeded = false;
  let lastLinkDocs: LinkDoc[] | null = null;
  let markFirstLinkSnapshot: () => void = () => undefined;
  const firstLinkSnapshot = new Promise<void>((r) => (markFirstLinkSnapshot = r));

  watch('offset', (h) =>
    listenServerTimeOffset((v) => {
      h.ok();
      setServerOffsetMs(v);
    }, h.error),
  );
  watch('outgoing', (h) =>
    listenOutgoingShares(
      uid,
      (docs) => {
        h.ok();
        const t = serverClockNow();
        // Ham belgelerle (süzülmemiş) durdurma niyetlerini uzlaştır: biten/yeni oturuma geçen paylaşımların
        // niyeti kalkar, hâlâ aktif olanınki kalır (yayın kapalı kalır, share_stop yeniden denenir).
        reconcileStopIntents(docs, t);
        lastDocs = docs;
        snapshotReceived = true;
        sharingStore.getState().applyServerShares(recentOrActive(docs, t).map(toOutgoingView));
        markFirstSnapshot();
      },
      h.error,
    ),
  );
  watch('links', (h) =>
    listenOutgoingLinks(
      uid,
      (docs: LinkDoc[]) => {
        h.ok();
        const t = serverClockNow();
        reconcileLinkStops(docs, t);
        lastLinkDocs = docs;
        linkSnapshotReceived = true;
        linkStore.getState().applyServerLinks(recentLinks(docs, t).map(toLinkView));
        // Biten / bu hesapta artık olmayan bağlantıların QR URL'si kasadan silinir.
        const keep = docs.filter((d) => d.status === 'active').map((d) => d.link_id);
        void linkTokenVault.retainOnly(keep).catch(() => undefined);
        markFirstLinkSnapshot();
      },
      h.error,
    ),
  );
  watch('incoming', (h) =>
    listenIncomingShares(
      uid,
      (docs) => {
        h.ok();
        incomingStore.getState().setShares(docs);
      },
      h.error,
    ),
  );
  watch('inbox', (h) =>
    listenInbox(uid, {
      onUpsert: (loc) => {
        h.ok();
        incomingStore.getState().upsertLocation(loc);
      },
      onRemove: (id) => incomingStore.getState().removeLocation(id),
      onError: h.error,
    }),
  );
  // Faz 3: çevrimdışı iz. Web demo (liveRepo.web.ts) henüz sağlamıyorsa atlanır. Sağlık şeridine BAĞLANMAZ:
  // iz kuralı dağıtılmamışsa (PERMISSION_DENIED) harita "eşitlenemiyor" uyarısı göstermesin, yalnızca yeniden denesin.
  const listenTrail = (LiveRepo as Partial<typeof LiveRepo>).listenTrail;
  if (listenTrail) {
    const trail = resilientListener('trail', (h) =>
      listenTrail(uid, {
        onTrail: (shareId, points) => {
          h.ok();
          incomingStore.getState().setTrail(shareId, points);
        },
        onRemove: (shareId) => incomingStore.getState().removeTrail(shareId),
        onError: h.error,
      }),
    );
    listeners.push(trail);
  }
  watch('friends', (h) => {
    let friendsOk = false;
    let outgoingOk = false;
    const ok = () => friendsOk && outgoingOk && h.ok();
    const unFriends = listenFriendships(
      uid,
      (list) => {
        friendsOk = true;
        ok();
        friendsStore.getState().setSnapshot(uid, list);
      },
      h.error,
    );
    const unOutgoing = listenOutgoingRequests(
      uid,
      (list) => {
        outgoingOk = true;
        ok();
        friendsStore.getState().setOutgoing(list);
      },
      h.error,
    );
    return () => {
      unFriends();
      unOutgoing();
    };
  });

  void registerPushToken(uid).then((u) => (disposed ? u() : unsubs.push(u)));

  // Faz 4: ping / not / SOS dinleyicileri. Durum notu değişince tek ölçüm alınıp hemen yayınlanır (hat notu ekler
  // ve not değiştiği için yayını zorlar).
  unsubs.push(
    startF4Services(uid, {
      hasLiveTargets: () => hasLiveTargets(),
      publishNow: () => {
        void locationEngine
          .getCurrentSample()
          .then((raw) => {
            if (raw && !disposed && hasLiveTargets()) void handleSamples([raw], 'heartbeat');
          })
          .catch(() => undefined);
      },
    }),
  );

  // Faz 5: bölgeler, bölge olayları, buluşma önerileri.
  unsubs.push(startF5Services(uid));
  // Faz 6: widget eşitleme, favori fotoğrafları, widget token'ı.
  unsubs.push(startF6Services(uid));
  // Faz 8: yönlü izinler, izin push'ları, bekleyen görünmez olma isteği.
  unsubs.push(startF8Services(uid));
  // Konum İste: gelen / giden istekler, Onayla / Reddet bildirim eylemleri.
  unsubs.push(startLocationRequestServices(uid));

  unsubs.push(
    listenConnected((c) => {
      if (!c || disposed) return;
      resubscribeFailing();
      void sharingStore.getState().retryPendingStops();
      void linkStore.getState().retryPendingStops();
      // Faz 3: bağlantı geldi → çevrimdışı kuyruğu hemen boşalt (geri çekilme beklenmez).
      void flushOutbox(true);
      // Faz 5: bekleyen bölge olayları (aynı op_id).
      onF5Connected();
      // Faz 8: onaylanmamış görünmez olma isteği (aynı op_id).
      onF8Connected();
    }),
  );

  // Faz 3: "Durdur" → o hedeflerin kuyruk noktaları HEMEN silinir (gizlilik: durdurulan paylaşıma geriye dönük veri gitmez).
  unsubs.push(
    onStopIntentsChange(() => {
      const ids = [...blockedShareIds()].map((id) => `s:${id}`);
      if (ids.length) void outboxRepo.dropTargets(ids).catch(() => undefined);
    }),
  );
  unsubs.push(
    onLinkStopsChange(() => {
      const stopped = new Set(listLinkStops().map((l) => l.link_id));
      if (stopped.size === 0) return;
      void loadTargets()
        .then((p) => outboxRepo.dropTargets(p.linkTargets.filter((t) => stopped.has(t.link_id)).map((t) => `l:${t.token_hash}`)))
        .catch(() => undefined);
    }),
  );

  // --- yayın hedefleri → kalıcı durum → konum takibi ------------------------------------

  let currentTargets: PublishTarget[] = [];
  let currentLinkTargets: LinkPublishTarget[] = [];
  let appliedKey: string | null = null;
  let applying: Promise<void> = Promise.resolve();
  /** Ön plan yayını için: bu açılışta sunucunun doğruladığı en az bir hedef var mı. */
  const hasLiveTargets = () =>
    !isPublishHeld() && ((snapshotReceived && currentTargets.length > 0) || (linkSnapshotReceived && currentLinkTargets.length > 0));

  const applyTargets = (force = false) => {
    // Kalıcı hedefler yalnızca GERÇEK sunucu anlık görüntüsünden ve niyet geri yüklemesinden sonra yazılır.
    // Arkadaş ve bağlantı listeleri ayrı ayrı: anlık görüntüsü gelmeyen liste diskte olduğu gibi kalır
    // (yalnızca kullanıcının durdurdukları çıkarılır). Önce: arka plan görevi elindeki listeyle sürer.
    if (!restored || (!snapshotReceived && !linkSnapshotReceived)) return;
    const friendPart = snapshotReceived ? publishTargetsKey(currentTargets) : 'keep';
    const linkPart = linkSnapshotReceived ? currentLinkTargets.map((t) => `${t.link_id}:${t.expires_at ?? '-'}:${t.sender_name}`).join(',') : 'keep';
    const key = `${friendPart}#${linkPart}#${getServerOffsetMs()}`;
    if (!force && key === appliedKey) return;
    appliedKey = key;
    const friends = snapshotReceived ? withSessionMeta(currentTargets, sharingStore.getState().state) : null;
    const links = linkSnapshotReceived ? withLinkMeta(currentLinkTargets, linkStore.getState().links) : null;
    applying = applying.then(() => doApply(friends, links)).catch(() => undefined);
  };

  /** `null` = o liste henüz sunucudan doğrulanmadı: diskteki hali korunur (durdurulanlar hariç). */
  async function doApply(friendsIn: PersistedTarget[] | null, linksIn: PersistedLinkTarget[] | null): Promise<void> {
    // ÖNCE kalıcılaştır (kilitli): arka plan görevinin ilk örneği güncel hedefleri görsün (ya da boş görüp dursun).
    const result = await inTargetsLock(async (latest, write) => {
      const sameUser = latest.uid === uid;
      const targets = friendsIn ?? (sameUser ? latest.targets.filter((t) => !isShareBlocked(t.share_id)) : []);
      const linkTargets = linksIn ?? (sameUser ? latest.linkTargets.filter((t) => !isLinkBlocked(t.link_id)) : []);
      const body = targets.length || linkTargets.length ? notificationBodyFor(targets, linkTargets) : '';
      await write({ uid, targets, linkTargets, serverOffsetMs: getServerOffsetMs(), notificationBody: body });
      if (targets.length > 0 || linkTargets.length > 0) return { stopped: false, body };
      await locationEngine.stopBackground().catch(() => undefined);
      return { stopped: true, body };
    });
    if (result.stopped) {
      await clearCursor().catch(() => undefined); // paylaşım bitti: kendi son konumunu diskte tutma
      // Faz 3: hareket durumu, uyku çiti ve kuyruk (kendi konum noktaların) da silinir.
      stopAdaptiveRuntime();
      await resetAdaptive().catch(() => undefined);
      await outboxRepo.purge().catch(() => undefined);
      permissionFlowStore.getState().setWentBackground(false);
      locationStore.getState().setTracking('off');
      return;
    }
    ensureAdaptiveRuntime();
    if (!locationEngine.canReconfigureNow()) return; // Android arka planda: mevcut servis sürer
    // Faz 3: core matris satırı (hareket × pil × izin) hemen uygulanır; bildirim "Konumun paylaşılıyor · 14:45'e kadar".
    const r = await applyTrackingNow();
    if (r.failed) {
      locationStore.getState().setTracking('off', 'Konum takibi başlatılamadı. Konum iznini kontrol et.');
      return;
    }
    if (r.profileId) locationStore.getState().setTracking(r.profileId);
  }

  let notifKey: string | null = null;
  /** Bildirimler oturum/bağlantı bilgisi olmadan uzlaştırılmaz: açılışta boş listeyle önceki çalıştırmanın planlı
   * uyarıları silinmesin (iki tarafın da sunucu anlık görüntüsü ya da geçici görünümü gelene kadar beklenir). */
  const syncNotifications = () => {
    if (!restored || !(snapshotReceived || seeded) || !(linkSnapshotReceived || linkSeeded)) return;
    const st = sharingStore.getState().state;
    const sessions = selectSessions(st);
    const links = selectLinkSessions(linkStore.getState());
    const nk =
      sessions.map((s) => `${s.session_id}:${s.phase}:${s.prompt_at ?? '-'}:${s.expires_at ?? '-'}`).join('|') +
      '#' +
      links.map((l) => `${l.link_id}:${l.phase}:${l.prompt_at ?? '-'}:${l.expires_at ?? '-'}`).join('|');
    if (nk === notifKey) return;
    notifKey = nk;
    void syncExpiryNotifications(sessions, st.now, getServerOffsetMs(), links).catch(() => undefined);
  };
  const onSharingState = (st: SharingStoreState) => {
    // Faz 8: görünmez / onaysızken hedef yok; konum izni bu cihazda geri alınan kişi hemen düşer.
    const grants = grantsStore.getState();
    currentTargets = isPublishHeld() ? [] : selectPublishTargets(st.state).filter((t) => !isLocationRevoked(grants, t.receiver_id));
    applyTargets();
    syncNotifications();
    syncForeground();
  };
  const onLinkState = (st: LinkStoreState) => {
    currentLinkTargets = isPublishHeld() ? [] : selectLinkTargets(st, currentSenderName());
    applyTargets();
    syncNotifications();
    syncForeground();
  };
  unsubs.push(sharingStore.subscribe(onSharingState));
  unsubs.push(linkStore.subscribe(onLinkState));
  // Faz 8: kesme anahtarı değişti → hedefler yeniden hesaplanır (görünmez olunca bu satırda yayın kesilir).
  unsubs.push(
    onPublishHoldChange(() => {
      if (disposed) return;
      onSharingState(sharingStore.getState());
      onLinkState(linkStore.getState());
    }),
  );
  let lastRevoked = grantsStore.getState().locationRevoked;
  unsubs.push(
    grantsStore.subscribe((g) => {
      if (g.locationRevoked === lastRevoked || disposed) return;
      lastRevoked = g.locationRevoked;
      onSharingState(sharingStore.getState());
    }),
  );
  // Konum izni paylaşım dışında (ör. arkadaşa dokunup rota isterken) verilirse kendi konumum hemen izlenmeye başlasın.
  let lastForeground = permissionsStore.getState().foreground;
  unsubs.push(
    permissionsStore.subscribe((p) => {
      if (p.foreground === lastForeground) return;
      lastForeground = p.foreground;
      syncForeground();
    }),
  );
  // Görünen ad değişince bağlantı paketindeki ad da güncellensin.
  unsubs.push(authStore.subscribe((a, prev) => (a.profile?.display_name !== prev.profile?.display_name ? onLinkState(linkStore.getState()) : undefined)));
  unsubs.push(onServerOffsetChange(() => applyTargets()));

  // Açılış: niyetleri geri yükle → (gerekirse) geçici oturum → bekleyen durdurmaları gönder.
  const restoredPromise = (async () => {
    try {
      await bindStopIntentsOwner(uid);
      if (disposed) return;
      if (lastDocs) reconcileStopIntents(lastDocs, serverClockNow());
      sharingStore.getState().restoreStopIntents(listStopIntents());
      await bindLinkStopsOwner(uid);
      if (disposed) return;
      if (lastLinkDocs) reconcileLinkStops(lastLinkDocs, serverClockNow());
      linkStore.getState().restoreStops(listLinkStops());
      if (!snapshotReceived || !linkSnapshotReceived) {
        const persisted = await loadTargets();
        if (!disposed && persisted.uid === uid) {
          if (!snapshotReceived) {
            const views = provisionalViews(persisted);
            if (views.length) {
              seeded = true;
              sharingStore.getState().applyServerShares(views);
            }
          }
          if (!linkSnapshotReceived) {
            const links = provisionalLinkViews(persisted);
            if (links.length) {
              linkSeeded = true;
              linkStore.getState().seedProvisional(links);
            }
          }
        }
      }
    } catch (e) {
      if (__DEV__) console.warn('[konum] açılış geri yüklemesi başarısız', e);
    } finally {
      restored = true;
    }
    if (disposed) return;
    onSharingState(sharingStore.getState());
    onLinkState(linkStore.getState());
    void sharingStore.getState().retryPendingStops();
    void linkStore.getState().retryPendingStops();
  })();

  // --- ön plan: kendi konumum, ön plan yayını, nabız ---------------------------------------

  let stopWatch: (() => void) | null = null;
  let watchStarting = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  async function startWatch() {
    if (stopWatch || watchStarting) return;
    if (permissionsStore.getState().foreground !== 'granted') return; // asla burada izin isteme
    watchStarting = true;
    try {
      const stop = await locationEngine.watchForeground(TRACKING_PROFILES.live_foreground, (raw) => {
        locationStore.getState().setMyPosition({ lat: raw.latitude, lng: raw.longitude, accuracy: raw.accuracy ?? null, timestamp: raw.timestamp });
        // Ön plan yayını yalnızca bu açılışta sunucu anlık görüntüsü geldikten sonra (geçici oturum yalnızca arayüz içindir).
        if (hasLiveTargets()) void handleSamples([raw], 'watch');
      });
      if (disposed || AppState.currentState !== 'active') stop();
      else stopWatch = stop;
    } catch {
      // izin yok / servis kapalı: harita yine de çalışır
    } finally {
      watchStarting = false;
    }
  }

  function syncForeground() {
    const active = AppState.currentState === 'active' && !disposed;
    if (active) void startWatch();
    else {
      stopWatch?.();
      stopWatch = null;
    }
    // iOS hareketsizken güncelleme vermez: ön planda nabzı JS zamanlayıcısıyla garanti et.
    const wantHeartbeat = active && hasLiveTargets();
    if (wantHeartbeat && !heartbeat) {
      heartbeat = setInterval(async () => {
        const raw = await locationEngine.getCurrentSample();
        if (raw && hasLiveTargets()) void handleSamples([raw], 'heartbeat');
      }, TRACKING_PROFILES.live_foreground.heartbeatMs);
    } else if (!wantHeartbeat && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  const onAppState = (s: AppStateStatus) => {
    if (s === 'active') {
      resubscribeFailing();
      void sharingStore.getState().retryPendingStops();
      void linkStore.getState().retryPendingStops();
      void flushOutbox(false);
      void permissionsStore
        .getState()
        .refresh()
        .then(() => {
          syncForeground();
          // Android: ön plana dönünce arka plan profilini/bildirim metnini tazele.
          applyTargets(true);
        })
        .catch(() => undefined);
    } else {
      // Faz 3: paylaşım sürerken arka plana gidildi → sonraki ön planda "Her zaman" yükseltmesi önerilebilir.
      if (s === 'background' && hasLiveTargets()) permissionFlowStore.getState().setWentBackground(true);
      syncForeground();
    }
  };
  const appStateSub = AppState.addEventListener('change', onAppState);
  void permissionsStore.getState().refresh().then(syncForeground).catch(() => undefined);
  void permissionFlowStore.getState().hydrate();

  // --- bildirim eylemleri (uygulama açıkken ya da eylemle soğuk açıldıysa) ----------------------

  const viaStore: ExtendViaStore = async (sid, minutes, opId) => {
    await restoredPromise;
    let s = sharingStore.getState().findSession(sid);
    if (!s) {
      // Soğuk açılış (iOS eylemi uygulamayı başlatır): ilk sunucu anlık görüntüsünü kısa süre bekle.
      await Promise.race([firstSnapshot, sleep(COLD_START_SNAPSHOT_WAIT_MS)]);
      s = sharingStore.getState().findSession(sid);
    }
    if (getStopIntent(sid)) return { kind: 'rejected' };
    if (!s) return { kind: 'unknown_session' };
    if (s.phase === 'stopping' || s.phase === 'ended' || s.phase === 'failed') return { kind: 'rejected' };
    const ok = await sharingStore.getState().extend(sid, minutes, opId);
    if (ok) return { kind: 'ok' };
    const after = sharingStore.getState().findSession(sid);
    if (!after || after.phase === 'stopping' || after.phase === 'ended') return { kind: 'rejected' };
    return { kind: 'failed', message: after.error?.message ?? 'Süre uzatılamadı' };
  };
  const viaLinkStore: ExtendViaStore = async (linkId, minutes, opId) => {
    await restoredPromise;
    let l = linkStore.getState().findLink(linkId);
    if (!l) {
      await Promise.race([firstLinkSnapshot, sleep(COLD_START_SNAPSHOT_WAIT_MS)]);
      l = linkStore.getState().findLink(linkId);
    }
    if (isLinkBlocked(linkId)) return { kind: 'rejected' };
    if (!l) return { kind: 'unknown_session' };
    if (l.phase === 'stopping' || l.phase === 'ended') return { kind: 'rejected' };
    const ok = await linkStore.getState().extend(linkId, minutes, opId);
    if (ok) return { kind: 'ok' };
    const after = linkStore.getState().findLink(linkId);
    if (!after || after.phase === 'stopping' || after.phase === 'ended') return { kind: 'rejected' };
    return { kind: 'failed', message: after.error?.message ?? 'Süre uzatılamadı' };
  };
  const routes: ExtendRoutes = { session: viaStore, link: viaLinkStore };
  const responseSub = Notifications.addNotificationResponseReceivedListener((r) => void handleExpiryResponse(r, routes));
  try {
    const last = Notifications.getLastNotificationResponse();
    if (last) void handleExpiryResponse(last, routes);
  } catch {
    // yerel modül yok (ör. test)
  }

  return () => {
    disposed = true;
    listeners.forEach((l) => l.dispose());
    unsubs.forEach((u) => u());
    appStateSub.remove();
    responseSub.remove();
    stopWatch?.();
    stopWatch = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    syncStatusStore.getState().reset();
  };
}

/**
 * Çıkış temizliği: yayın kesilir, kalıcı arka plan verisi ve bildirimler silinir, bellek boşaltılır.
 * Durdurma niyetleri SİLİNMEZ (bkz. stopIntents): aynı hesapla tekrar girişte sunucuya yeniden gönderilir.
 */
onSignedOut(async () => {
  await clearBackgroundState().catch(() => undefined);
  await locationEngine.stopBackground().catch(() => undefined);
  // Faz 3: çevrimdışı kuyruk (kendi konum noktaların + bekleyen düşük pil çağrısı) ve hareket durumu silinir.
  stopAdaptiveRuntime();
  await outboxRepo.purge().catch(() => undefined);
  await resetAdaptive().catch(() => undefined);
  permissionFlowStore.getState().setWentBackground(false);
  await cancelAllExpiryNotifications().catch(() => undefined);
  // QR URL'leri (token taşır) bu cihazdan silinir; bağlantı durdurma niyetleri KALIR (tekrar girişte yeniden denenir).
  await linkTokenVault.clear().catch(() => undefined);
  sharingStore.getState().reset();
  linkStore.getState().reset();
  incomingStore.getState().reset();
  friendsStore.getState().reset();
  locationStore.getState().reset();
  syncStatusStore.getState().reset();
  // Faz 4: ping kutusu, notlar, SOS durumu (kalıcı durum notu clearBackgroundState ile silindi).
  resetF4Stores();
  // Faz 5: OS bölge kaydı kalkar; bölge önbelleği / filtre / kuyruk (clearBackgroundState de siler) ve bellek durumu.
  await resetF5State();
  // Faz 6: widget "Giriş yap" çizer; yerel widget kimlik bilgisi, avatar dosyaları ve bellek durumu silinir.
  await resetF6State();
  // Faz 8: kesme anahtarı (görünmez niyeti / onay kapısı) ve izin / görünmez / onay bellek durumu.
  await resetF8State();
  resetLocationRequestState();
});
