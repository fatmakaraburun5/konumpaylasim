/**
 * Ana ekran (app/(main)/index.tsx).
 *
 *   MapHome (kapsayıcı: seçim durumu, rota modu, sayfalar)
 *   ├─ MapCanvas (yerel Google Maps SDK)
 *   │   ├─ FriendMarker × n (yumuşak kayan pin, seçiliyse vurgulu)
 *   │   ├─ DestinationPin (uzun basışla bırakılan hedef)
 *   │   └─ Polyline (seçili hedefin rotası, core `decodePolyline`)
 *   ├─ TopBar (avatar, başlık, davet kodu çipi, arkadaşlar)
 *   ├─ IncomingStrip (bana paylaşanlar; dokununca seçer)
 *   ├─ SyncBanner (sunucuyla eşitleme hatası; dinleyici yeniden deneniyor)
 *   ├─ RecenterButton (+ paylaşım sürerken "QR ile paylaş" kısayolu)
 *   ├─ alt alan:
 *   │   seçim varsa:  ExpiryBanner(lar) → EtaCard (ad/adres, Araç|Yürüyüş|Bisiklet, ETA · mesafe, "Rotayı kapat")
 *   │   yoksa:        BackgroundPermissionHint → ExpiryBanner(lar) → ActiveShareCard × oturum → ActiveLinkCard × bağlantı | ShareButton
 *   ├─ ShareSheet ("Arkadaşlar | Bağlantı (QR)") ─ PermissionFlow
 *   ├─ LinkQrSheet (QR, bağlantı, Kopyala/Paylaş, kalan süre, +30 dk / +1 saat, "Paylaşımı durdur")
 *   └─ çıkış sırasında ilerleme örtüsü
 *
 * Seçim: arkadaş pinine / şeride dokun → o arkadaş; haritaya uzun bas → nokta. Arkadaşın paylaşımı biterse
 * seçim kalkar. Rota ve adres yalnızca EtaCard görünürken istenir (useEta → routesRepo/geocodeRepo).
 */
import { formatAgo, FRESHNESS_TEXT, type ExtensionMinutes, type LatLng, type LinkId, type TravelMode } from '@konum/core';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { authStore, useAuthStore } from '../../state/authStore';
import { useFriendNames } from '../../state/friendsStore';
import { useVisibleIncoming, type IncomingFriendLocation } from '../../state/incomingStore';
import { linkStore, useLinkSessions, useLinkStore, type LinkSession } from '../../state/linkStore';
import { locationStore, useLocationStore } from '../../state/locationStore';
import { permissionsStore, usePermissionsStore } from '../../state/permissionsStore';
import { sharingStore, useShareSessions, useSharingNow } from '../../state/sharingStore';
import { useSyncStatus } from '../../state/syncStatusStore';
import { cardShadow, IconButton, Text, useTheme } from '../../ui';
import { LinkQrSheet, type LinkQrSheetHandle } from '../link/LinkQrSheet';
import { BackgroundPermissionHint } from '../permissions/BackgroundPermissionHint';
import { activeShareContext } from '../permissions/permissionPlanner';
import { ShareSheet, type ShareSheetHandle } from '../share/ShareSheet';
import { ActiveLinkCard } from './ActiveLinkCard';
import { ActiveShareCard } from './ActiveShareCard';
import { EtaCard } from './EtaCard';
import { ExpiryBanner } from './ExpiryBanner';
import { IncomingStrip } from './IncomingStrip';
import { MapCanvas, type MapCanvasHandle } from './MapCanvas';
import { RecenterButton } from './RecenterButton';
import { ShareButton } from './ShareButton';
import { TopBar } from './TopBar';
import { useAddress, useRouteEta, type EtaTarget } from './useEta';

const RUNNING = new Set(['starting', 'active', 'expiring_soon', 'extending', 'stopping']);
const LINK_RUNNING = new Set<LinkSession['phase']>(['active', 'expiring_soon', 'extending', 'stopping']);

/** Haritadaki seçim: arkadaş (paylaşım kimliği) ya da uzun basışla bırakılan nokta. */
export type MapSelection = { kind: 'friend'; shareId: string } | { kind: 'pin'; point: LatLng } | null;

const pinKey = (p: LatLng) => `pin:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
/** [Varsayım] Çıkışta tüm durdurmalar için toplam bekleme (çevrimdışıyken her biri ~48 sn sürebilirdi). */
const SIGN_OUT_STOP_DEADLINE_MS = 10_000;

/**
 * Süren tüm oturumları PARALEL durdurur, tek bir üst süreyle. Durdurma niyetleri zaten kalıcıdır:
 * süre aşılırsa ya da başarısız olursa yayın bu cihazda yine kapalıdır ve aynı hesapla tekrar girişte
 * share_stop yeniden gönderilir. Dönen değer: sunucunun onayladığı mı.
 */
async function stopAllWithDeadline(sessionIds: readonly string[], linkIds: readonly LinkId[] = []): Promise<boolean> {
  if (sessionIds.length === 0 && linkIds.length === 0) return true;
  const all = Promise.all([
    ...sessionIds.map((id) => sharingStore.getState().stop(id)),
    // Bağlantılar da durdurulur: çıkıştan sonra yayın kesilir, açık kalan bağlantı eski konumu göstermesin.
    ...linkIds.map((id) => linkStore.getState().stop(id)),
  ]).then((r) => r.every(Boolean));
  const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), SIGN_OUT_STOP_DEADLINE_MS));
  return Promise.race([all, timeout]);
}

export function MapHome() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const map = useRef<MapCanvasHandle>(null);
  const sheet = useRef<ShareSheetHandle>(null);
  const qrSheet = useRef<LinkQrSheetHandle>(null);
  const [bottomH, setBottomH] = useState(0);
  const [selection, setSelection] = useState<MapSelection>(null);
  const [travelMode, setTravelMode] = useState<TravelMode>('DRIVE');

  const profile = useAuthStore((s) => s.profile);
  const names = useFriendNames();
  const sessions = useShareSessions();
  const shareNow = useSharingNow();
  const incomingNow = useNow(10_000);
  const incoming = useVisibleIncoming(incomingNow);
  const myPosition = useLocationStore((s) => s.myPosition);
  const trackingError = useLocationStore((s) => s.trackingError);
  const syncFailing = useSyncStatus((s) => Object.keys(s.failing).length > 0);
  const [signingOut, setSigningOut] = useState(false);

  const links = useLinkSessions();
  const linkNow = useLinkStore((s) => s.now);

  const anyRunning = sessions.some((s) => RUNNING.has(s.phase));
  const anyLinkRunning = links.some((l) => LINK_RUNNING.has(l.phase));
  const expiring = sessions.find((s) => s.phase === 'expiring_soon');
  // Arka plan izni yalnızca süren en uzun paylaşım gerektiriyorsa önerilir (core planlayıcı).
  const runningShareKey = [...sessions.filter((s) => RUNNING.has(s.phase)), ...links.filter((l) => LINK_RUNNING.has(l.phase))]
    .map((s) => `${s.share_mode}:${s.expires_at ?? ''}`)
    .join('|');
  const permContext = useMemo(
    () =>
      activeShareContext(
        [...sessions.filter((s) => RUNNING.has(s.phase)), ...links.filter((l) => LINK_RUNNING.has(l.phase))],
        Date.now(),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runningShareKey],
  );
  const expiringLink = links.find((l) => l.phase === 'expiring_soon');

  // --- seçim → rota hedefi ------------------------------------------------------------
  const selectedFriend = selection?.kind === 'friend' ? incoming.find((f) => f.shareId === selection.shareId) : undefined;
  // Arkadaşın paylaşımı bitti / konum kayboldu: seçimi kaldır (rota artık istenmez).
  useEffect(() => {
    if (selection?.kind === 'friend' && !selectedFriend) setSelection(null);
  }, [selection, selectedFriend]);

  const target: EtaTarget | null = useMemo(() => {
    if (selection?.kind === 'pin') return { key: pinKey(selection.point), kind: 'pin', title: 'Seçilen nokta', position: selection.point };
    if (selectedFriend) {
      return {
        key: `friend:${selectedFriend.shareId}`,
        kind: 'friend',
        title: names[selectedFriend.senderId] ?? 'Arkadaş',
        position: { lat: selectedFriend.location.lat, lng: selectedFriend.location.lng },
      };
    }
    return null;
  }, [selection, selectedFriend, names]);
  const origin = useMemo(() => (myPosition ? { lat: myPosition.lat, lng: myPosition.lng } : null), [myPosition]);
  const eta = useRouteEta(target, origin, travelMode, target !== null);
  const address = useAddress(target, target !== null);
  const routePoints = eta.entry && !eta.entry.error ? (eta.entry.result?.points ?? null) : null;
  const friendSubtitle = selectedFriend
    ? selectedFriend.freshness === 'stale'
      ? formatAgo(selectedFriend.location.timestamp, incomingNow)
      : FRESHNESS_TEXT[selectedFriend.freshness]
    : null;

  // Yeni hedefin rotası gelince ben + hedef ekrana sığsın (aynı hedefte konum güncellemesi kamerayı oynatmaz).
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!target || !routePoints || routePoints.length < 2 || fittedFor.current === target.key) return;
    fittedFor.current = target.key;
    map.current?.fitTo?.(origin ? [origin, target.position] : [target.position]);
  }, [target, routePoints, origin]);
  useEffect(() => {
    if (!target) fittedFor.current = null;
  }, [target]);

  // Rota benim konumumdan çizilir: kendi konumum yoksa (paylaşım başlatılmadığı için izin hiç istenmediyse)
  // kullanıcı rota istediği anda konum izni istenir; izin verilince koordinatör izlemeyi başlatır ve rota gelir.
  const ensureMyLocation = useCallback(() => {
    const p = permissionsStore.getState();
    if (p.foreground === 'granted' || (p.foreground === 'denied' && !p.foregroundCanAskAgain)) return;
    void p.requestForeground().catch(() => undefined);
  }, []);
  const focusFriend = useCallback(
    (f: IncomingFriendLocation) => {
      setSelection({ kind: 'friend', shareId: f.shareId });
      map.current?.centerOn(f.location.lat, f.location.lng);
      if (!locationStore.getState().myPosition) ensureMyLocation();
    },
    [ensureMyLocation],
  );
  const dropPin = useCallback(
    (p: LatLng) => {
      setSelection({ kind: 'pin', point: p });
      if (!locationStore.getState().myPosition) ensureMyLocation();
    },
    [ensureMyLocation],
  );
  const locationBlocked = usePermissionsStore((s) => s.foreground === 'denied' && !s.foregroundCanAskAgain);
  const locationGranted = usePermissionsStore((s) => s.foreground === 'granted');
  const closeRoute = useCallback(() => setSelection(null), []);
  const recenter = useCallback(() => {
    if (myPosition) map.current?.centerOn(myPosition.lat, myPosition.lng);
  }, [myPosition]);

  const extend = useCallback(async (sessionId: string, minutes: ExtensionMinutes) => {
    await sharingStore.getState().extend(sessionId, minutes);
  }, []);
  const stop = useCallback((sessionId: string) => void sharingStore.getState().stop(sessionId), []);
  const dismiss = useCallback((sessionId: string) => sharingStore.getState().dismiss(sessionId), []);
  const showQr = useCallback((linkId: LinkId) => qrSheet.current?.present(linkId), []);
  const stopLink = useCallback((linkId: LinkId) => {
    Alert.alert('Paylaşımı durdur', 'Bağlantı ve QR kod hemen geçersiz olur; açık olan haritalarda konumun kaybolur.', [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Durdur', style: 'destructive', onPress: () => void linkStore.getState().stop(linkId) },
    ]);
  }, []);

  const signOut = useCallback(() => {
    const doSignOut = async () => {
      setSigningOut(true);
      try {
        const running = sessions.filter((s) => RUNNING.has(s.phase)).map((s) => s.session_id);
        const runningLinks = links.filter((l) => LINK_RUNNING.has(l.phase)).map((l) => l.link_id);
        const confirmed = await stopAllWithDeadline(running, runningLinks);
        if (!confirmed) {
          setSigningOut(false);
          Alert.alert(
            'Paylaşım sunucuda durdurulamadı',
            'Bu cihaz konum göndermeyi hemen bıraktı, ama bağlantı olmadığı için paylaşım sunucuda hâlâ açık görünebilir; alıcılar son bilinen konumunu görmeye devam edebilir. Çıkış yaparsan aynı hesapla tekrar girdiğinde durdurma yeniden denenir.',
            [
              { text: 'Vazgeç', style: 'cancel' },
              {
                text: 'Yine de çık',
                style: 'destructive',
                onPress: () => {
                  setSigningOut(true);
                  void authStore
                    .getState()
                    .signOut()
                    .finally(() => setSigningOut(false));
                },
              },
            ],
          );
          return;
        }
        await authStore.getState().signOut();
      } finally {
        setSigningOut(false);
      }
    };
    Alert.alert('Çıkış yap', anyRunning || anyLinkRunning ? 'Süren paylaşımın ve QR bağlantıların hemen durur.' : 'Hesabından çıkış yapılacak.', [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Çıkış yap', style: 'destructive', onPress: () => void doSignOut() },
    ]);
  }, [anyLinkRunning, anyRunning, links, sessions]);

  const padding = useMemo(() => ({ top: insets.top + 140, right: 0, bottom: bottomH + 8, left: 0 }), [insets.top, bottomH]);
  const onBottomLayout = (e: LayoutChangeEvent) => setBottomH(e.nativeEvent.layout.height);

  return (
    <View style={styles.root}>
      <MapCanvas
        ref={map}
        friends={incoming}
        names={names}
        padding={padding}
        onFriendPress={focusFriend}
        selectedShareId={selection?.kind === 'friend' ? selection.shareId : null}
        destination={selection?.kind === 'pin' ? selection.point : null}
        route={routePoints}
        onLongPress={dropPin}
      />

      <TopBar profile={profile} onFriends={() => router.push('/friends')} onSignOut={signOut} />
      <View style={[styles.strip, { top: insets.top + 72, gap: spacing.xs }]} pointerEvents="box-none">
        <IncomingStrip items={incoming} names={names} now={incomingNow} onFocus={focusFriend} />
        {syncFailing ? (
          <View
            accessibilityRole="alert"
            style={[styles.sync, cardShadow, { marginHorizontal: spacing.md, backgroundColor: colors.warningSoft, borderColor: colors.warning, borderRadius: radius.md, padding: spacing.sm }]}
          >
            <Text variant="label" style={{ color: colors.warning }}>
              Sunucuyla eşitlenemiyor, yeniden deneniyor. Paylaşımını yine de durdurabilirsin.
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.bottom, { paddingHorizontal: spacing.md, paddingBottom: insets.bottom + spacing.md, gap: spacing.sm }]} onLayout={onBottomLayout} pointerEvents="box-none">
        <View style={[styles.recenter, { gap: spacing.xs }]} pointerEvents="box-none">
          {anyRunning && !target ? (
            <IconButton icon="qr" variant="floating" size={48} accessibilityLabel="QR ile paylaş" onPress={() => sheet.current?.present('link')} />
          ) : null}
          <RecenterButton onPress={recenter} disabled={!myPosition} />
        </View>
        {!target ? <BackgroundPermissionHint visible={anyRunning || anyLinkRunning} context={permContext} /> : null}
        {expiring ? <ExpiryBanner session={expiring} now={shareNow} onExtend={(m) => void extend(expiring.session_id, m)} /> : null}
        {expiringLink ? (
          <ExpiryBanner session={expiringLink} now={linkNow} subject="QR bağlantın" onExtend={(m) => void linkStore.getState().extend(expiringLink.link_id, m)} />
        ) : null}
        {target ? (
          <EtaCard target={target} subtitle={friendSubtitle} mode={travelMode} onModeChange={setTravelMode} eta={eta} address={address} onClose={closeRoute} onRequestLocation={locationGranted ? undefined : ensureMyLocation} locationBlocked={locationBlocked} />
        ) : (
          <>
            {sessions.map((s) => (
              <ActiveShareCard
                key={s.session_id}
                session={s}
                names={names}
                now={shareNow}
                trackingError={trackingError}
                onExtend={(m) => void extend(s.session_id, m)}
                onStop={() => stop(s.session_id)}
                onDismiss={() => dismiss(s.session_id)}
              />
            ))}
            {links.map((l) => (
              <ActiveLinkCard
                key={l.link_id}
                link={l}
                now={linkNow}
                onShowQr={() => showQr(l.link_id)}
                onStop={() => (l.phase === 'stopping' ? void linkStore.getState().stop(l.link_id) : stopLink(l.link_id))}
                onDismiss={() => linkStore.getState().dismiss(l.link_id)}
              />
            ))}
            {!anyRunning ? <ShareButton onPress={() => sheet.current?.present()} /> : null}
          </>
        )}
      </View>

      <ShareSheet ref={sheet} onLinkCreated={showQr} />
      <LinkQrSheet ref={qrSheet} />

      {signingOut ? (
        <View style={[StyleSheet.absoluteFill, styles.overlay]} accessibilityViewIsModal accessibilityLiveRegion="polite">
          <View style={[cardShadow, styles.overlayCard, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm }]}>
            <ActivityIndicator color={colors.primary} />
            <Text variant="body">Paylaşımların durduruluyor, çıkış yapılıyor…</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  strip: { position: 'absolute', left: 0, right: 0 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  recenter: { flexDirection: 'row', justifyContent: 'flex-end' },
  sync: { borderWidth: 1 },
  overlay: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  overlayCard: { flexDirection: 'row', alignItems: 'center', maxWidth: 320 },
});
