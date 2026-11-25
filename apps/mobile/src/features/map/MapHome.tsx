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
 *   │   yoksa:        BackgroundPermissionHint → ExpiryBanner(lar) → ShareDeck (tüm giden paylaşımlar tek kitapçıkta: öndeki kart + arka katmanlar, liste, ince çubuk) | ShareButton
 *   ├─ ShareSheet ("Arkadaşlar | Bağlantı (QR)") ─ PermissionFlow
 *   ├─ LinkQrSheet (QR, bağlantı, Kopyala/Paylaş, kalan süre, +30 dk / +1 saat, "Paylaşımı durdur")
 *   ├─ çıkış sırasında ilerleme örtüsü
 *   └─ Faz 4:
 *       PingToast (üstte kayan "📍 Buradayım / 🚶 Yoldayım" kartı) · EtaCard'da ping düğmeleri (arkadaş hedefi)
 *       StatusNotePill → NoteSheet (durum notu) · EtaCard "Buraya not bırak" (nokta hedefi) → NoteSheet (yer notu)
 *       yer notu pini → PlaceNoteCard (sahibi düzenler / siler) · arkadaş pininde not balonu ve ping/SOS nabzı
 *       SosLauncher (sağ altta basılı tut → geri sayım → gönder → "Uyarı gönderildi") · SosIncomingBanner +
 *       SosIncomingScreen (alıcı tam ekran acil durum kartı)
 *   └─ Faz 5:
 *       haritada kendi bölgelerim (soluk daire + emoji) · TopBar menüsünde "Bölgelerim"
 *       EtaCard "Buluşma noktası öner" (arkadaş hedefi; nokta hedefinde "Buradan buluşma öner") → MeetupSheet
 *       (karartmasız alt sayfa; haritada numaralı öneri pinleri, orta nokta, seçili öneriye kesikli çizgiler ve
 *       benim rotam) · paylaşılan öneri → MeetupCard (alıcı: Geliyorum / Uyamam; öneren: yanıtlar) + yer pini
 *
 * Seçim: arkadaş pinine / şeride dokun → o arkadaş; haritaya uzun bas → nokta. Arkadaşın paylaşımı biterse
 * seçim kalkar. Rota ve adres yalnızca EtaCard görünürken istenir (useEta → routesRepo/geocodeRepo).
 */
import {
  formatAgo,
  FRESHNESS_TEXT,
  isSosActive,
  visibleStatusNote,
  type ExtensionMinutes,
  type LatLng,
  type LinkId,
  type Ping,
  type PlaceNote,
  type SosAlert,
  type TravelMode,
} from '@konum/core';
import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
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
import { notesStore, selectPlaceNotes, useNotesStore } from '../../state/notesStore';
import { pingStore, usePingStore } from '../../state/pingStore';
import { selectIncomingSos, sosStore, useSosStore } from '../../state/sosStore';
import { meetupStore, selectMeetups, useMeetupStore } from '../../state/meetupStore';
import { useZonesStore } from '../../state/zonesStore';
import { MeetupCard, MeetupPills } from '../meetup/MeetupCard';
import { participantPoints, type MeetupMapOverlay } from '../meetup/meetupModel';
import { MeetupSheet, type MeetupSheetHandle } from '../meetup/MeetupSheet';
import { circleBounds } from '../zones/zoneModel';
import { Button, cardShadow, IconButton, Text, useTheme } from '../../ui';
import { LinkQrSheet, type LinkQrSheetHandle } from '../link/LinkQrSheet';
import { NoteSheet, type NoteSheetHandle } from '../notes/NoteSheet';
import { PlaceNoteCard } from '../notes/PlaceNoteCard';
import { StatusNotePill } from '../notes/StatusNotePill';
import { PingButtons } from '../ping/PingButtons';
import { pingPins } from '../ping/pingModel';
import { PingToast } from '../ping/PingToast';
import { SosIncomingBanner } from '../sos/SosIncomingBanner';
import { SosIncomingScreen } from '../sos/SosIncomingScreen';
import { SosLauncher } from '../sos/SosLauncher';
import { sosPins, sosRouteFrom } from '../sos/sosModel';
import { BackgroundPermissionHint } from '../permissions/BackgroundPermissionHint';
import { activeShareContext } from '../permissions/permissionPlanner';
import { ShareSheet, type ShareSheetHandle } from '../share/ShareSheet';
import { EtaCard } from './EtaCard';
import { ExpiryBanner } from './ExpiryBanner';
import { IncomingStrip } from './IncomingStrip';
import { MapCanvas, type MapCanvasHandle } from './MapCanvas';
import { RecenterButton } from './RecenterButton';
import { ShareButton } from './ShareButton';
import { ShareDeck, type ShareDeckActions } from './ShareDeck';
import { TopBar } from './TopBar';
import { useAddress, useRouteEta, type EtaTarget } from './useEta';

const RUNNING = new Set(['starting', 'active', 'expiring_soon', 'extending', 'stopping']);
const LINK_RUNNING = new Set<LinkSession['phase']>(['active', 'expiring_soon', 'extending', 'stopping']);

/** Haritadaki seçim: arkadaş (paylaşım kimliği), uzun basışla bırakılan nokta ya da (Faz 4) yer notu. */
export type MapSelection = { kind: 'friend'; shareId: string } | { kind: 'pin'; point: LatLng } | { kind: 'note'; noteId: string } | null;

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
  const noteSheet = useRef<NoteSheetHandle>(null);
  const meetupSheet = useRef<MeetupSheetHandle>(null);
  const navigation = useNavigation();
  const { height: windowH } = useWindowDimensions();
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

  // --- Faz 4: ping, notlar, SOS ----------------------------------------------------------
  const myUid = useAuthStore((s) => s.uid);
  const pingInbox = usePingStore((s) => s.inbox);
  const pingHighlightFrom = usePingStore((s) => s.highlight?.from ?? null);
  const placeNotesMap = useNotesStore((s) => s.placeNotes);
  const notePending = useNotesStore((s) => s.pending);
  const sosIncoming = useSosStore((s) => s.incoming);
  const placeNotes = useMemo(() => selectPlaceNotes({ placeNotes: placeNotesMap }, incomingNow), [placeNotesMap, incomingNow]);
  const incomingSos = useMemo(() => selectIncomingSos({ incoming: sosIncoming }), [sosIncoming]);
  const liveSenders = useMemo(() => new Set(incoming.map((f) => f.senderId)), [incoming]);
  const sosSenders = useMemo(() => new Set(incomingSos.filter(isSosActive).map((a) => a.sender_id)), [incomingSos]);
  const friendNotes = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of incoming) {
      const n = visibleStatusNote(f.location, incomingNow);
      if (n) out[f.shareId] = n;
    }
    return out;
  }, [incoming, incomingNow]);
  const pingPinList = useMemo(() => pingPins(pingInbox, liveSenders, incomingNow), [pingInbox, liveSenders, incomingNow]);
  const sosPinList = useMemo(() => sosPins(incomingSos, liveSenders), [incomingSos, liveSenders]);
  const selectedNote = selection?.kind === 'note' ? placeNotes.find((n) => n.note_id === selection.noteId) : undefined;
  // Not silindi / süresi doldu: kart kapanır.
  useEffect(() => {
    if (selection?.kind === 'note' && !selectedNote) setSelection(null);
  }, [selection, selectedNote]);

  // --- Faz 5: bölgeler, buluşma noktası -------------------------------------------------------
  const zonesMap = useZonesStore((s) => s.zones);
  const zonePresence = useZonesStore((s) => s.presence);
  const mapZones = useMemo(() => Object.values(zonesMap).filter((z) => z.enabled), [zonesMap]);
  const [meetupOpen, setMeetupOpen] = useState(false);
  const meetupResult = useMeetupStore((s) => s.result);
  const meetupSel = useMeetupStore((s) => s.selectedIndex);
  const meetupInput = useMeetupStore((s) => s.input);
  const meetupsMap = useMeetupStore((s) => s.meetups);
  const focusedMeetupId = useMeetupStore((s) => s.focusedMeetupId);
  const focusedMeetup = focusedMeetupId ? meetupsMap[focusedMeetupId] : undefined;
  const meetupList = useMemo(() => selectMeetups({ meetups: meetupsMap }, myUid), [meetupsMap, myUid]);
  const friendPositions = useMemo(() => {
    const out: Record<string, LatLng> = {};
    for (const f of incoming) if (!(f.senderId in out)) out[f.senderId] = { lat: f.location.lat, lng: f.location.lng };
    return out;
  }, [incoming]);
  const selectedSuggestion = meetupOpen && meetupResult && meetupSel !== null ? meetupResult.suggestions[meetupSel] : undefined;

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
  // Faz 5: buluşma önerisi seçiliyken / paylaşılan öneri kartı açıkken rota o yere çizilir (route_compute).
  const meetupTarget: EtaTarget | null = useMemo(() => {
    if (selectedSuggestion) {
      const p = selectedSuggestion.place.location;
      return { key: `meetup:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, kind: 'pin', title: selectedSuggestion.place.name, position: p };
    }
    if (!meetupOpen && focusedMeetup) return { key: `meetup:${focusedMeetup.meetup_id}`, kind: 'pin', title: focusedMeetup.place.name, position: focusedMeetup.place.location };
    return null;
  }, [selectedSuggestion, meetupOpen, focusedMeetup]);
  const routeTarget = meetupTarget ?? (meetupOpen ? null : target);
  const routeOrigin = useMemo(
    () => (selectedSuggestion ? (meetupInput?.positionOverrides?.me ?? origin) : origin),
    [selectedSuggestion, meetupInput, origin],
  );
  const routeMode: TravelMode = (selectedSuggestion ? meetupInput?.modes?.me : undefined) ?? travelMode;
  const meetupOverlay: MeetupMapOverlay | null = useMemo(() => {
    if (meetupOpen && meetupResult) {
      const { points } = participantPoints(meetupInput?.friendIds ?? [], origin, friendPositions, meetupInput?.positionOverrides ?? {});
      return { suggestions: meetupResult.suggestions, center: meetupResult.center, selectedIndex: meetupSel, participants: points, focused: null };
    }
    if (!meetupOpen && focusedMeetup) return { suggestions: [], center: null, selectedIndex: null, participants: [], focused: focusedMeetup.place };
    return null;
  }, [meetupOpen, meetupResult, meetupSel, meetupInput, origin, friendPositions, focusedMeetup]);
  const eta = useRouteEta(routeTarget, routeOrigin, routeMode, routeTarget !== null);
  const address = useAddress(target, target !== null && meetupTarget === null);
  const routePoints = eta.entry && !eta.entry.error ? (eta.entry.result?.points ?? null) : null;
  const etaResult = eta.entry && !eta.entry.error ? (eta.entry.result ?? null) : null;
  // Faz 4: SOS anında haritada açık rota (varsa) pakete eklenir.
  const sosRoute = useMemo(() => (routeTarget ? sosRouteFrom(routeTarget.title, etaResult) : null), [routeTarget, etaResult]);
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
      meetupStore.getState().focus(null);
      setSelection({ kind: 'friend', shareId: f.shareId });
      map.current?.centerOn(f.location.lat, f.location.lng);
      if (!locationStore.getState().myPosition) ensureMyLocation();
    },
    [ensureMyLocation],
  );
  const dropPin = useCallback(
    (p: LatLng) => {
      meetupStore.getState().focus(null);
      setSelection({ kind: 'pin', point: p });
      if (!locationStore.getState().myPosition) ensureMyLocation();
    },
    [ensureMyLocation],
  );
  const locationBlocked = usePermissionsStore((s) => s.foreground === 'denied' && !s.foregroundCanAskAgain);
  const locationGranted = usePermissionsStore((s) => s.foreground === 'granted');
  const closeRoute = useCallback(() => setSelection(null), []);
  // --- Faz 4 eylemleri ---------------------------------------------------------------------
  const openStatusNote = useCallback(() => noteSheet.current?.present({ mode: 'status' }), []);
  const leaveNoteAt = useCallback((p: LatLng) => noteSheet.current?.present({ mode: 'place', position: { lat: p.lat, lng: p.lng, accuracy: null } }), []);
  const selectNote = useCallback((n: PlaceNote) => {
    meetupStore.getState().focus(null);
    setSelection({ kind: 'note', noteId: n.note_id });
    map.current?.centerOn(n.position.lat, n.position.lng);
  }, []);
  const deleteNote = useCallback((n: PlaceNote) => {
    Alert.alert('Notu sil', 'Not haritadan kalkacak; gördüğü kişiler de artık göremez.', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          const ok = await notesStore.getState().deletePlace(n.note_id);
          if (ok) setSelection(null);
          else Alert.alert('Not silinemedi', 'Bağlantını kontrol edip tekrar dene.');
        },
      },
    ]);
  }, []);
  const showPingOnMap = useCallback(
    (p: Ping) => {
      pingStore.getState().highlightFrom(p.from, p.kind);
      const live = incoming.find((f) => f.senderId === p.from);
      if (live) focusFriend(live);
      else if (p.location) map.current?.centerOn(p.location.lat, p.location.lng);
    },
    [incoming, focusFriend],
  );
  const showSosOnMap = useCallback(
    (a: SosAlert) => {
      sosStore.getState().focus(null);
      // Arkadaşlar ekranındaysa haritaya dön.
      if (!navigation.isFocused()) router.navigate('/');
      const live = incoming.find((f) => f.senderId === a.sender_id);
      if (live) focusFriend(live);
      else map.current?.centerOn(a.location.lat, a.location.lng);
    },
    [incoming, focusFriend, navigation, router],
  );

  // --- Faz 5 eylemleri ---------------------------------------------------------------------
  const openMeetup = useCallback((friendIds: string[], pickedPoint: LatLng | null = null) => {
    meetupStore.getState().focus(null);
    setSelection(null);
    meetupSheet.current?.present({ friendIds, pickedPoint });
  }, []);
  const fitMeetup = useCallback(
    (index: number | null) => {
      const r = meetupStore.getState().result;
      const input = meetupStore.getState().input;
      if (!r) return;
      const { points } = participantPoints(input?.friendIds ?? [], origin, friendPositions, input?.positionOverrides ?? {});
      const places = index !== null && r.suggestions[index] ? [r.suggestions[index].place.location] : r.suggestions.map((x) => x.place.location);
      const all = [...points.map((p) => p.position), ...places, r.center];
      if (all.length > 0) map.current?.fitTo?.(all);
    },
    [origin, friendPositions],
  );
  // Yeni öneri sonucu gelince katılımcılar + öneriler ekrana sığsın.
  useEffect(() => {
    if (meetupOpen && meetupResult) fitMeetup(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetupResult, meetupOpen]);
  // Paylaşılan öneri odaklanınca (push / yeni gelen): seçim kalkar, haritaya dönülür, ben + yer sığar.
  useEffect(() => {
    if (!focusedMeetupId) return;
    setSelection(null);
    if (!navigation.isFocused()) router.navigate('/');
    const m = meetupStore.getState().meetups[focusedMeetupId];
    if (m) map.current?.fitTo?.(origin ? [origin, m.place.location] : circleBounds(m.place.location, 300));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedMeetupId]);

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

  // Kitapçık yalnızca seçim (rota / yer notu / buluşma kartı) yokken görünür; görünürken "bitmek üzere" afişi
  // ayrıca gösterilmez: süresi dolmak üzere olan kart öne gelir ve uzatma çipleri kartın üstündedir.
  const deckVisible = !selectedNote && !target && !focusedMeetup;
  const deckActions = useMemo<ShareDeckActions>(
    () => ({
      extend: (id, m) => void extend(id, m),
      stop,
      dismiss,
      linkExtend: (id, m) => void linkStore.getState().extend(id, m),
      linkShowQr: showQr,
      linkStop: stopLink,
      linkDismiss: (id) => linkStore.getState().dismiss(id),
      // Onay kitapçıkta iki adımda alındı; burada yeniden sorulmaz.
      stopAll: (items) => {
        for (const it of items) {
          if (it.kind === 'share') void sharingStore.getState().stop(it.session.session_id);
          else void linkStore.getState().stop(it.link.link_id);
        }
      },
      newShare: () => sheet.current?.present(),
    }),
    [dismiss, extend, showQr, stop, stopLink],
  );

  // Buluşma sayfası açıkken alt dolgu sayfanın ilk durağı (%52) kadar: pinler sayfanın üstünde kalsın.
  const padding = useMemo(
    () => ({ top: insets.top + 140, right: 0, bottom: meetupOpen ? Math.round(windowH * 0.52) + 8 : bottomH + 8, left: 0 }),
    [insets.top, bottomH, meetupOpen, windowH],
  );
  const onBottomLayout = (e: LayoutChangeEvent) => setBottomH(e.nativeEvent.layout.height);

  return (
    <View style={styles.root} testID="map-home">
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
        friendNotes={friendNotes}
        pingHighlightFrom={pingHighlightFrom}
        sosSenders={sosSenders}
        placeNotes={placeNotes}
        myUid={myUid}
        selectedNoteId={selection?.kind === 'note' ? selection.noteId : null}
        onPlaceNotePress={selectNote}
        pingPins={pingPinList}
        onPingPress={(p) => pingStore.getState().highlightFrom(p.from, p.kind)}
        sosPins={sosPinList}
        onSosPress={(a) => sosStore.getState().focus(a.sos_id)}
        zones={mapZones}
        zonePresence={zonePresence}
        meetup={meetupOverlay}
        onMeetupSelect={(i) => {
          meetupStore.getState().select(i);
          fitMeetup(i);
        }}
      />

      <TopBar profile={profile} onFriends={() => router.push('/friends')} onZones={() => router.push('/zones')} onProfile={() => router.push('/profile')} onSignOut={signOut} />
      <View style={[styles.strip, { top: insets.top + 72, gap: spacing.xs }]} pointerEvents="box-none">
        <SosIncomingBanner alerts={incomingSos} now={incomingNow} />
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

      {meetupOpen ? null : (
        <View style={[styles.bottom, { paddingHorizontal: spacing.md, paddingBottom: insets.bottom + spacing.md, gap: spacing.sm }]} onLayout={onBottomLayout} pointerEvents="box-none">
          <View style={[styles.recenter, { gap: spacing.xs }]} pointerEvents="box-none">
            <View style={styles.flex} pointerEvents="box-none">
              {!target && !selectedNote ? <StatusNotePill onPress={openStatusNote} /> : null}
            </View>
            {anyRunning && !target ? (
              <IconButton icon="qr" variant="floating" size={48} accessibilityLabel="QR ile paylaş" onPress={() => sheet.current?.present('link')} />
            ) : null}
            <RecenterButton onPress={recenter} disabled={!myPosition} />
            <SosLauncher route={sosRoute} />
          </View>
          {!target ? <BackgroundPermissionHint visible={anyRunning || anyLinkRunning} context={permContext} /> : null}
          {expiring && !deckVisible ? <ExpiryBanner session={expiring} now={shareNow} onExtend={(m) => void extend(expiring.session_id, m)} /> : null}
          {expiringLink && !deckVisible ? (
            <ExpiryBanner session={expiringLink} now={linkNow} subject="QR bağlantın" onExtend={(m) => void linkStore.getState().extend(expiringLink.link_id, m)} />
          ) : null}
          {selectedNote ? (
            <PlaceNoteCard
              note={selectedNote}
              myUid={myUid}
              names={names}
              now={incomingNow}
              deleting={notePending[selectedNote.note_id] === 'deleting'}
              onEdit={() => noteSheet.current?.present({ mode: 'place', position: selectedNote.position, note: selectedNote })}
              onDelete={() => deleteNote(selectedNote)}
              onClose={closeRoute}
            />
          ) : target ? (
            <EtaCard
              target={target}
              subtitle={friendSubtitle}
              mode={travelMode}
              onModeChange={setTravelMode}
              eta={eta}
              address={address}
              onClose={closeRoute}
              onRequestLocation={locationGranted ? undefined : ensureMyLocation}
              locationBlocked={locationBlocked}
              note={selectedFriend ? (friendNotes[selectedFriend.shareId] ?? null) : null}
            >
              {selectedFriend ? (
                <>
                  <PingButtons to={selectedFriend.senderId} name={target.title} etaS={etaResult?.duration_s ?? null} />
                  <Button title="📍 Buluşma noktası öner" variant="secondary" onPress={() => openMeetup([selectedFriend.senderId])} />
                </>
              ) : selection?.kind === 'pin' ? (
                <>
                  <Button title="📝 Buraya not bırak" variant="secondary" onPress={() => leaveNoteAt(selection.point)} />
                  <Button title="📍 Buradan buluşma noktası öner" variant="secondary" onPress={() => openMeetup([], selection.point)} />
                </>
              ) : null}
            </EtaCard>
          ) : focusedMeetup ? (
            <MeetupCard meetup={focusedMeetup} myUid={myUid} names={names} eta={eta} onClose={() => meetupStore.getState().focus(null)} />
          ) : (
            <>
              <MeetupPills meetups={meetupList} myUid={myUid} onOpen={(m) => meetupStore.getState().focus(m.meetup_id)} />
              <ShareDeck
                sessions={sessions}
                links={links}
                names={names}
                shareNow={shareNow}
                linkNow={linkNow}
                trackingError={trackingError}
                actions={deckActions}
              />
              {!anyRunning ? <ShareButton onPress={() => sheet.current?.present()} /> : null}
            </>
          )}
        </View>
      )}

      <ShareSheet ref={sheet} onLinkCreated={showQr} />
      <LinkQrSheet ref={qrSheet} />
      <NoteSheet ref={noteSheet} onPlaceSaved={selectNote} onPlaceDeleted={() => setSelection(null)} />
      <MeetupSheet
        ref={meetupSheet}
        friendPositions={friendPositions}
        myPosition={origin}
        names={names}
        onOpenChange={setMeetupOpen}
        onFocusSuggestion={fitMeetup}
        onShared={(m) => meetupStore.getState().focus(m.meetup_id)}
      />

      <PingToast names={names} onShowOnMap={showPingOnMap} />
      <SosIncomingScreen onShowOnMap={showSosOnMap} />

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
  recenter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  flex: { flex: 1 },
  sync: { borderWidth: 1 },
  overlay: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  overlayCard: { flexDirection: 'row', alignItems: 'center', maxWidth: 320 },
});
