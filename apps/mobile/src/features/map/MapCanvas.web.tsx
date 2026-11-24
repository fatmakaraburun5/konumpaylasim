/**
 * Web önizlemesi: ana ekran haritası. Native `MapCanvas.tsx` (yerel Google Maps SDK) ile aynı props ve aynı
 * `MapCanvasHandle` (centerOn, fitTo) sunulur; yalnızca tarayıcı paketine girer (Metro `.web.tsx` uzantısı).
 * Çizim ve etkileşim `PreviewMap.web.tsx`'tedir (vektör Kadıköy / Moda haritası).
 *
 * Faz 2 (native ile aynı davranış):
 *  - Uzun basış (ya da sağ tık) → hedef noktası (`onLongPress`); nokta pini `DestinationPin`.
 *  - Seçili hedefin rotası (`route`, core `decodePolyline` sonucu) caddelerin üstünde çizilir.
 *  - Arkadaş pinleri yumuşak kayar (`FriendMarker.web` → `useAnimatedLatLng`), seçili pin vurgulanır.
 *  - Kendi konumum: locationStore.myPosition (mavi nokta + doğruluk halesi).
 *  - Faz 3: eşitlenen iz noktaları kesikli çizgi (iz → canlı pin, native `Polyline lineDashPattern` karşılığı);
 *    bağlantısı kopmuş olabilecek arkadaşın pini soluk, etiketinde son doğrulanmış konum.
 *  - Faz 4: arkadaş pininde durum notu balonu ve nabız (ping / SOS); yer notu, ping ve SOS işaretleri (`F4Markers.web`).
 *  - Faz 5: kendi bölgelerim (`ZoneMapLayer.web`) ve buluşma katmanı (`MeetupMapLayer.web`), native ile aynı.
 */
import type { LatLng, Ping, PlaceNote, SosAlert, UserId, Zone, ZonePresence } from '@konum/core';
import { useContext, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import type { EdgePadding } from 'react-native-maps';
import Svg, { Circle, Path } from 'react-native-svg';
import { MeetupMapLayer } from '../meetup/MeetupMapLayer.web';
import type { MeetupMapOverlay } from '../meetup/meetupModel';
import { ZoneMapLayer } from '../zones/ZoneMapLayer.web';
import type { IncomingFriendLocation } from '../../state/incomingStore';
import { useLocationStore } from '../../state/locationStore';
import { useTheme } from '../../ui';
import { PingMarker, PlaceNoteMarker, SosMarker } from './F4Markers.web';
import { FriendMarker } from './FriendMarker.web';
import { MapProjectionContext, PreviewMap, type PreviewMapHandle } from './PreviewMap.web';

export interface MapCanvasHandle {
  centerOn: (lat: number, lng: number) => void;
  /** Noktaları kenar boşluğuyla sığdırır (rota açılınca ben + hedef). */
  fitTo?: (points: readonly LatLng[]) => void;
}

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
  const map = useRef<PreviewMapHandle>(null);

  useImperativeHandle(
    ref,
    () => ({
      centerOn: (lat, lng) => map.current?.centerOn(lat, lng),
      fitTo: (points) => {
        if (points.length === 1) {
          const p = points[0] as LatLng;
          map.current?.centerOn(p.lat, p.lng);
        } else map.current?.fitTo(points);
      },
    }),
    [],
  );

  // Kuzeydeki pin arkada kalsın (Google Maps gibi); seçili pin her zaman üstte.
  const sorted = useMemo(
    () => [...friends].sort((a, b) => Number(a.shareId === selectedShareId) - Number(b.shareId === selectedShareId) || b.location.lat - a.location.lat),
    [friends, selectedShareId],
  );

  return (
    <PreviewMap ref={map} padding={padding} route={route} onLongPress={onLongPress}>
      {/* Faz 5: kendi bölgelerim en altta (soluk daire + emoji). */}
      {zones.length > 0 ? <ZoneMapLayer zones={zones} presence={zonePresence} /> : null}
      {friends.map((f) => (f.trail && f.trail.length > 0 ? <TrailLine key={`trail:${f.shareId}`} friend={f} /> : null))}
      <MyLocation />
      {destination ? <DestinationPin at={destination} /> : null}
      {sorted.map((f) => (
        <FriendMarker
          key={f.shareId}
          id={f.shareId}
          name={names[f.senderId] ?? 'Arkadaş'}
          lat={f.location.lat}
          lng={f.location.lng}
          timestamp={f.location.timestamp}
          freshness={f.freshness}
          batteryPct={f.location.battery_pct}
          status={f.verified?.status}
          verifiedLabel={f.verified?.label ?? null}
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
    </PreviewMap>
  );
}

/** Faz 3: çevrimdışıyken kaydedilip sonradan eşitlenen noktalar → kesikli çizgi (son nokta → canlı pin) + nokta işaretleri. */
function TrailLine({ friend }: { friend: IncomingFriendLocation }) {
  const { colors } = useTheme();
  const project = useContext(MapProjectionContext);
  if (!project || !friend.trail || friend.trail.length === 0) return null;
  const pts = [...friend.trail.map((p) => project(p.lat, p.lng)), project(friend.location.lat, friend.location.lng)];
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityLabel="Çevrimdışıyken kaydedilen yol">
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Path d={d} stroke={colors.surface} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.85} />
        <Path d={d} stroke={colors.stale} strokeWidth={3} strokeDasharray="8 6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        {pts.slice(0, -1).map((p, i) => (
          <Circle key={i} cx={p.x} cy={p.y} r={2.6} fill={colors.surface} stroke={colors.stale} strokeWidth={1.5} />
        ))}
      </Svg>
    </View>
  );
}

/** Mavi nokta + doğruluk halesi (native `showsUserLocation` karşılığı). */
function MyLocation() {
  const { colors, scheme } = useTheme();
  const dark = scheme === 'dark';
  const project = useContext(MapProjectionContext);
  const myPosition = useLocationStore((s) => s.myPosition);
  if (!project || !myPosition) return null;
  const me = project(myPosition.lat, myPosition.lng);
  // Doğruluk (m) → piksel: aynı boylamda kuzeye doğruluk kadar kaydırılmış noktanın ekran farkı.
  const north = project(myPosition.lat + (myPosition.accuracy ?? 0) / 111_320, myPosition.lng);
  const haloR = myPosition.accuracy ? Math.max(14, Math.abs(me.y - north.y)) : 0;
  return (
    <View pointerEvents="none" style={[styles.meWrap, { left: me.x, top: me.y }]} accessibilityLabel="Konumun">
      {haloR > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: -haloR,
            top: -haloR,
            width: haloR * 2,
            height: haloR * 2,
            borderRadius: haloR,
            backgroundColor: dark ? 'rgba(59, 130, 246, 0.18)' : 'rgba(37, 99, 235, 0.14)',
            borderWidth: 1,
            borderColor: dark ? 'rgba(59, 130, 246, 0.45)' : 'rgba(37, 99, 235, 0.35)',
          }}
        />
      ) : null}
      <View style={[styles.meDot, { backgroundColor: colors.primary, borderColor: '#FFFFFF' }]} />
    </View>
  );
}

/** Hedef noktası: damla biçimli pin (native `MapCanvas.tsx` `DestinationPin` ile aynı görünüm, ucu noktada). */
function DestinationPin({ at }: { at: LatLng }) {
  const { colors } = useTheme();
  const project = useContext(MapProjectionContext);
  if (!project) return null;
  const p = project(at.lat, at.lng);
  return (
    <View pointerEvents="none" accessibilityLabel="Seçilen nokta" style={[styles.pinWrap, { left: p.x - 16, top: p.y - 44 }]}>
      <View style={[styles.pinHead, { backgroundColor: colors.primary, borderColor: colors.surface }]}>
        <View style={[styles.pinDot, { backgroundColor: colors.surface }]} />
      </View>
      <View style={[styles.pinStem, { backgroundColor: colors.primary }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  meWrap: { position: 'absolute', width: 0, height: 0, alignItems: 'center', justifyContent: 'center' },
  meDot: {
    position: 'absolute',
    left: -9,
    top: -9,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    boxShadow: '0px 1px 4px rgba(15, 23, 42, 0.35)',
  },
  pinWrap: { position: 'absolute', alignItems: 'center', width: 32, height: 44, zIndex: 4 },
  pinHead: { width: 30, height: 30, borderRadius: 15, borderWidth: 3, alignItems: 'center', justifyContent: 'center', boxShadow: '0px 2px 6px rgba(15, 23, 42, 0.3)' },
  pinDot: { width: 8, height: 8, borderRadius: 4 },
  pinStem: { width: 4, height: 14, borderBottomLeftRadius: 2, borderBottomRightRadius: 2, marginTop: -2 },
});
