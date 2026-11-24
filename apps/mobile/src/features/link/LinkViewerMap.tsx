/**
 * Görüntüleyici haritası (yerel Google Maps SDK): paylaşan kişinin pini yumuşak kayar (useMarkerMotion),
 * kamera pini izler; kullanıcı haritayı kaydırınca izleme durur ("Ortala" ile geri gelir).
 */
import type { Freshness, LinkLiveLocation } from '@konum/core';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Circle, PROVIDER_GOOGLE } from 'react-native-maps';
import { Avatar, mapStyleFor, useTheme } from '../../ui';
import { AnimatedMarker } from '../map/FriendMarker';
import { useMarkerMotion } from '../map/useMarkerMotion';

export interface LinkViewerMapHandle {
  recenter: () => void;
}

export interface LinkViewerMapProps {
  live: LinkLiveLocation | null;
  freshness: Freshness | null;
  follow: boolean;
  onUserPan: () => void;
  bottomInset: number;
  ref?: Ref<LinkViewerMapHandle>;
}

const INITIAL_REGION = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.2, longitudeDelta: 0.2 };

export function LinkViewerMap({ live, freshness, follow, onUserPan, bottomInset, ref }: LinkViewerMapProps) {
  const theme = useTheme();
  const map = useRef<MapView>(null);
  const style = useMemo(() => mapStyleFor(theme), [theme]);
  const first = useRef(true);
  const lat = live?.lat;
  const lng = live?.lng;

  useImperativeHandle(
    ref,
    () => ({
      recenter: () => {
        if (lat !== undefined && lng !== undefined) map.current?.animateCamera({ center: { latitude: lat, longitude: lng }, zoom: 16 }, { duration: 450 });
      },
    }),
    [lat, lng],
  );

  useEffect(() => {
    if (lat === undefined || lng === undefined || !follow) return;
    const zoom = first.current ? 16 : undefined;
    first.current = false;
    map.current?.animateCamera({ center: { latitude: lat, longitude: lng }, ...(zoom ? { zoom } : {}) }, { duration: 600 });
  }, [lat, lng, follow]);

  return (
    <MapView
      ref={map}
      provider={PROVIDER_GOOGLE}
      style={StyleSheet.absoluteFill}
      initialRegion={INITIAL_REGION}
      customMapStyle={style}
      showsUserLocation={false}
      showsMyLocationButton={false}
      showsCompass={false}
      toolbarEnabled={false}
      mapPadding={{ top: 0, right: 0, bottom: bottomInset, left: 0 }}
      onPanDrag={onUserPan}
      accessibilityLabel="Paylaşılan konum haritası"
    >
      {live ? <SharerMarker live={live} freshness={freshness} /> : null}
    </MapView>
  );
}

function SharerMarker({ live, freshness }: { live: LinkLiveLocation; freshness: Freshness | null }) {
  const { colors } = useTheme();
  const coordinate = useMarkerMotion(live.lat, live.lng, live.timestamp);
  // Özel görünümlü pin bit eşlem olarak çizilir: görünüm değişince kısa süre izle, sonra kapat (bkz. FriendMarker).
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [freshness, live.battery_pct, live.sender_name, colors]);
  return (
    <>
      {live.accuracy > 25 ? (
        <Circle
          center={{ latitude: live.lat, longitude: live.lng }}
          radius={Math.min(live.accuracy, 2_000)}
          strokeColor={colors.primary}
          fillColor={withAlpha(colors.primary)}
          strokeWidth={1}
        />
      ) : null}
      <AnimatedMarker coordinate={coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={tracks} accessibilityLabel={`${live.sender_name} konumu`}>
        <View style={{ backgroundColor: colors.surface, borderRadius: 999, padding: 2 }}>
          <Avatar name={live.sender_name} size={40} freshness={freshness ?? 'live'} batteryPct={live.battery_pct} />
        </View>
      </AnimatedMarker>
    </>
  );
}

/** Doğruluk dairesi dolgusu: birincil rengin ~%12'si (#RRGGBB + alfa). */
const withAlpha = (hex: string) => `${hex}1F`;
