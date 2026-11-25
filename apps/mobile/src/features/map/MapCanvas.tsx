/**
 * Harita: iki platformda da yerel Google Maps SDK (react-native-maps, PROVIDER_GOOGLE).
 * `showsUserLocation` yalnızca konum izni ZATEN verilmişse açılır: aksi halde harita SDK'sı
 * açılışta izin penceresi tetikleyebilirdi (izin yalnızca ilk paylaşımda istenir).
 *
 * Faz 2:
 *  - Uzun basış → hedef noktası bırakılır (`onLongPress`); nokta pini `DestinationPin`.
 *  - Seçili hedefin rotası `Polyline` ile çizilir (core `decodePolyline` sonucu, routesRepo).
 *  - Arkadaş pinleri `FriendMarker` içinde yumuşak kayar (useMarkerMotion).
 *  - Faz 3: eşitlenen iz noktaları kesikli `Polyline`; bağlantısı kopmuş olabilecek arkadaşın pini soluk.
 *  - Açık/koyu stil `mapStyleFor(theme)`; cihaz teması değişince stil canlı değişir.
 *  - Faz 4: arkadaş pininde durum notu balonu ve nabız (ping / SOS); yer notu, ping ve SOS işaretleri (`F4Markers`).
 *  - Faz 5: kendi bölgelerim (`ZoneMapLayer`: soluk daire + emoji) ve buluşma katmanı (`MeetupMapLayer`: numaralı
 *    öneri pinleri, orta nokta, seçili öneriye kesikli çizgiler, paylaşılan öneri pini).
 */
import type { LatLng, Ping, PlaceNote, SosAlert, UserId, Zone, ZonePresence } from '@konum/core';
import { useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, type EdgePadding, type LongPressEvent } from 'react-native-maps';
import { MeetupMapLayer } from '../meetup/MeetupMapLayer';
import type { MeetupMapOverlay } from '../meetup/meetupModel';
import { ZoneMapLayer } from '../zones/ZoneMapLayer';
import type { IncomingFriendLocation } from '../../state/incomingStore';
import { usePermissionsStore } from '../../state/permissionsStore';
import { mapStyleFor, useTheme } from '../../ui';
import { PingMarker, PlaceNoteMarker, SosMarker } from './F4Markers';
import { FriendMarker } from './FriendMarker';

export interface MapCanvasHandle {
  centerOn: (lat: number, lng: number) => void;
  /** Noktaları kenar boşluğuyla sığdırır (rota açılınca ben + hedef). */
  fitTo?: (points: readonly LatLng[]) => void;
}

/** [Varsayım] İlk görünüm: İstanbul. Konum izni varsa kullanıcı konumuna ortalanır. */
const INITIAL_REGION = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.12, longitudeDelta: 0.12 };

export interface MapCanvasProps {
  friends: readonly IncomingFriendLocation[];
  names: Record<UserId, string>;
  padding: EdgePadding;
  onFriendPress: (f: IncomingFriendLocation) => void;
  /** Seçili arkadaş paylaşımı (ETA kartı açık). */
  selectedShareId?: string | null;
  /** Bırakılan hedef noktası. */
  destination?: LatLng | null;
  /** Seçili hedefin rota çizgisi. */
  route?: readonly LatLng[] | null;
  /** Haritaya uzun basış: hedef noktası bırak. */
  onLongPress?: (p: LatLng) => void;
  // --- Faz 4 ---
  /** shareId → arkadaşın görünür durum notu (core `visibleStatusNote`). */
  friendNotes?: Record<string, string>;
  /** Yeni ping gönderen (pin nabız vurgusu, `pingStore.highlight`). */
  pingHighlightFrom?: UserId | null;
  /** Aktif SOS gönderenler: arkadaş pini kırmızı ve nabızlı. */
  sosSenders?: ReadonlySet<UserId>;
  /** Yer notları (benim + bana görünür, aktif). */
  placeNotes?: readonly PlaceNote[];
  myUid?: UserId | null;
  selectedNoteId?: string | null;
  onPlaceNotePress?: (n: PlaceNote) => void;
  /** Göndereni canlı görünmeyen konumlu pingler (geçici pin). */
  pingPins?: readonly Ping[];
  onPingPress?: (p: Ping) => void;
  /** Canlı pini olmayan aktif SOS göndericilerinin tam konumu. */
  sosPins?: readonly SosAlert[];
  onSosPress?: (a: SosAlert) => void;
  // --- Faz 5 ---
  /** Kendi bölgelerim (etkin olanlar): soluk daire + emoji. */
  zones?: readonly Zone[];
  zonePresence?: Record<string, ZonePresence>;
  /** Buluşma noktası katmanı (öneri pinleri, orta nokta, kesikli çizgiler, paylaşılan öneri pini). */
  meetup?: MeetupMapOverlay | null;
  onMeetupSelect?: (index: number) => void;
  ref?: Ref<MapCanvasHandle>;
}

const toCoord = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng });

export function MapCanvas({
  friends,
  names,
  padding,
  onFriendPress,
  selectedShareId,
  destination,
  route,
  onLongPress,
  friendNotes,
  pingHighlightFrom = null,
  sosSenders,
  placeNotes = [],
  myUid = null,
  selectedNoteId = null,
  onPlaceNotePress,
  pingPins = [],
  onPingPress,
  sosPins = [],
  onSosPress,
  zones = [],
  zonePresence,
  meetup = null,
  onMeetupSelect,
  ref,
}: MapCanvasProps) {
  const theme = useTheme();
  const { colors } = theme;
  const map = useRef<MapView>(null);
  const locationGranted = usePermissionsStore((s) => s.foreground === 'granted');
  const customMapStyle = useMemo(() => mapStyleFor(theme), [theme]);
  const routeCoords = useMemo(() => (route && route.length > 1 ? route.map(toCoord) : null), [route]);

  useImperativeHandle(
    ref,
    () => ({
      centerOn: (lat, lng) =>
        map.current?.animateCamera({ center: { latitude: lat, longitude: lng }, zoom: 15 }, { duration: 450 }),
      fitTo: (points) => {
        if (points.length === 0) return;
        if (points.length === 1) {
          const p = points[0] as LatLng;
          map.current?.animateCamera({ center: toCoord(p), zoom: 15 }, { duration: 450 });
          return;
        }
        map.current?.fitToCoordinates(points.map(toCoord), { edgePadding: { top: 48, right: 48, bottom: 48, left: 48 }, animated: true });
      },
    }),
    [],
  );

  const handleLongPress = (e: LongPressEvent) => {
    const c = e.nativeEvent.coordinate;
    onLongPress?.({ lat: c.latitude, lng: c.longitude });
  };

  return (
    <MapView
      ref={map}
      provider={PROVIDER_GOOGLE}
      style={StyleSheet.absoluteFill}
      initialRegion={INITIAL_REGION}
      customMapStyle={customMapStyle}
      showsUserLocation={locationGranted}
      showsMyLocationButton={false}
      showsCompass={false}
      toolbarEnabled={false}
      mapPadding={padding}
      onLongPress={onLongPress ? handleLongPress : undefined}
      accessibilityLabel="Harita"
      accessibilityHint="Rota için bir noktaya uzun bas"
    >
      {/* Faz 5: kendi bölgelerim en altta (soluk daire + emoji). */}
      {zones.length > 0 ? <ZoneMapLayer zones={zones} presence={zonePresence} /> : null}
      {routeCoords ? (
        <Polyline coordinates={routeCoords} strokeColor={colors.primary} strokeWidth={5} lineCap="round" lineJoin="round" zIndex={0} />
      ) : null}
      {destination ? (
        <Marker
          identifier="destination"
          coordinate={toCoord(destination)}
          anchor={{ x: 0.5, y: 1 }}
          tracksViewChanges={false}
          accessibilityLabel="Seçilen nokta"
          zIndex={3}
        >
          <DestinationPin color={colors.primary} ring={colors.surface} />
        </Marker>
      ) : null}
      {/* Faz 3: çevrimdışıyken kaydedilip sonradan eşitlenen noktalar → kesikli çizgi (son nokta → canlı pin). */}
      {friends.map((f) =>
        f.trail && f.trail.length > 0 ? (
          <Polyline
            key={`trail:${f.shareId}`}
            coordinates={[...f.trail.map((p) => ({ latitude: p.lat, longitude: p.lng })), toCoord(f.location)]}
            strokeColor={colors.stale}
            strokeWidth={3}
            lineDashPattern={[8, 6]}
            lineCap="round"
            zIndex={0}
          />
        ) : null,
      )}
      {friends.map((f) => (
        <FriendMarker
          key={f.shareId}
          id={f.shareId}
          uid={f.senderId}
          name={names[f.senderId] ?? 'Arkadaş'}
          lat={f.location.lat}
          lng={f.location.lng}
          timestamp={f.location.timestamp}
          freshness={f.freshness}
          batteryPct={f.location.battery_pct}
          status={f.verified?.status}
          selected={f.shareId === selectedShareId}
          onPress={() => onFriendPress(f)}
          note={friendNotes?.[f.shareId] ?? null}
          pulse={sosSenders?.has(f.senderId) ? 'sos' : pingHighlightFrom === f.senderId ? 'ping' : null}
        />
      ))}
      {/* Faz 4: yer notları, geçici ping pinleri, canlı pini olmayan SOS göndericileri. */}
      {placeNotes.map((n) => (
        <PlaceNoteMarker key={`note:${n.note_id}`} note={n} selected={n.note_id === selectedNoteId} mine={n.owner_id === myUid} onPress={() => onPlaceNotePress?.(n)} />
      ))}
      {pingPins.map((p) => (
        <PingMarker key={`ping:${p.ping_id}`} ping={p} name={names[p.from] ?? 'Arkadaş'} highlighted={pingHighlightFrom === p.from} onPress={() => onPingPress?.(p)} />
      ))}
      {sosPins.map((a) => (
        <SosMarker key={`sos:${a.sos_id}`} alert={a} onPress={() => onSosPress?.(a)} />
      ))}
      {/* Faz 5: buluşma noktası önerileri / paylaşılan öneri. */}
      {meetup ? <MeetupMapLayer overlay={meetup} onSelect={onMeetupSelect} /> : null}
    </MapView>
  );
}

/** Hedef noktası: damla biçimli pin (bit eşlem bir kez çizilir). */
function DestinationPin({ color, ring }: { color: string; ring: string }) {
  return (
    <View style={styles.pinWrap}>
      <View style={[styles.pinHead, { backgroundColor: color, borderColor: ring }]}>
        <View style={[styles.pinDot, { backgroundColor: ring }]} />
      </View>
      <View style={[styles.pinStem, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  pinWrap: { alignItems: 'center', width: 32, height: 44 },
  pinHead: { width: 30, height: 30, borderRadius: 15, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  pinDot: { width: 8, height: 8, borderRadius: 4 },
  pinStem: { width: 4, height: 14, borderBottomLeftRadius: 2, borderBottomRightRadius: 2, marginTop: -2 },
});
