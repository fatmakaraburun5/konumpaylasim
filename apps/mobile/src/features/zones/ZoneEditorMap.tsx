/**
 * Faz 5 bölge düzenleyici haritası (native, react-native-maps). Web kardeşi `ZoneEditorMap.web.tsx`.
 *
 *  - Merkez = harita ortası: ortada sabit artı işareti; harita kaydıkça `onCenterChange` (onRegionChange).
 *  - Yarıçap dairesi haritada (Circle) merkezde; yarıçap değişince harita daireyi sığdırır.
 *  - `centerOn` ("Şu anki konumum" düğmesi): haritayı noktaya götürür.
 */
import type { LatLng } from '@konum/core';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Circle, PROVIDER_GOOGLE, type Region } from 'react-native-maps';
import { usePermissionsStore } from '../../state/permissionsStore';
import { mapStyleFor, useTheme } from '../../ui';
import { Crosshair } from './ZoneCrosshair';
import { withAlpha } from './zoneColors';
import { circleBounds } from './zoneModel';

export interface ZoneEditorMapHandle {
  centerOn: (p: LatLng) => void;
}

export interface ZoneEditorMapProps {
  initialCenter: LatLng;
  radiusM: number;
  emoji: string;
  onCenterChange: (p: LatLng) => void;
  ref?: Ref<ZoneEditorMapHandle>;
}

/** Daire ekranın yaklaşık yarısını kaplasın. */
const regionFor = (c: LatLng, r: number): Region => {
  const span = (r * 4.4) / 111_320;
  return { latitude: c.lat, longitude: c.lng, latitudeDelta: span, longitudeDelta: span / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)) };
};

export function ZoneEditorMap({ initialCenter, radiusM, emoji, onCenterChange, ref }: ZoneEditorMapProps) {
  const theme = useTheme();
  const map = useRef<MapView>(null);
  const [center, setCenter] = useState(initialCenter);
  const centerRef = useRef(initialCenter);
  const radiusRef = useRef(radiusM);
  radiusRef.current = radiusM;
  const changeRef = useRef(onCenterChange);
  changeRef.current = onCenterChange;
  const locationGranted = usePermissionsStore((s) => s.foreground === 'granted');
  const customMapStyle = useMemo(() => mapStyleFor(theme), [theme]);
  const [initialRegion] = useState(() => regionFor(initialCenter, radiusM));

  useImperativeHandle(ref, () => ({ centerOn: (p) => map.current?.animateToRegion(regionFor(p, radiusRef.current), 400) }), []);

  // Yarıçap değişince daire sığsın (ilk çizimde değil).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    map.current?.fitToCoordinates(
      circleBounds(centerRef.current, radiusM).map((p) => ({ latitude: p.lat, longitude: p.lng })),
      { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: true },
    );
  }, [radiusM]);

  const onRegionChange = (r: Region) => {
    const c = { lat: Math.round(r.latitude * 1e6) / 1e6, lng: Math.round(r.longitude * 1e6) / 1e6 };
    centerRef.current = c;
    setCenter(c);
    changeRef.current(c);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        customMapStyle={customMapStyle}
        showsUserLocation={locationGranted}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        onRegionChange={onRegionChange}
        onRegionChangeComplete={onRegionChange}
        accessibilityLabel="Bölge haritası"
        accessibilityHint="Bölgenin merkezini seçmek için haritayı kaydır"
      >
        <Circle
          center={{ latitude: center.lat, longitude: center.lng }}
          radius={radiusM}
          strokeColor={withAlpha(theme.colors.primary, 0.8)}
          strokeWidth={2}
          fillColor={withAlpha(theme.colors.primary, 0.14)}
        />
      </MapView>
      <Crosshair emoji={emoji} />
    </View>
  );
}
