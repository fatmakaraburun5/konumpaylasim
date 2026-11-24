/**
 * YALNIZCA web: `ZoneEditorMap.tsx` ile aynı props ve handle. Önizleme haritası (PreviewMap.web) üzerinde merkez =
 * görünüm ortası (`onCameraChange` / `getCenter`), daire izdüşümle piksele çevrilir.
 */
import type { LatLng } from '@konum/core';
import { useContext, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../ui';
import { MapProjectionContext, PreviewMap, type PreviewMapHandle } from '../map/PreviewMap.web';
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

const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

export function ZoneEditorMap({ initialCenter, radiusM, emoji, onCenterChange, ref }: ZoneEditorMapProps) {
  const map = useRef<PreviewMapHandle>(null);
  const [center, setCenter] = useState(initialCenter);
  const centerRef = useRef(initialCenter);
  const radiusRef = useRef(radiusM);
  radiusRef.current = radiusM;
  const changeRef = useRef(onCenterChange);
  changeRef.current = onCenterChange;
  const ready = useRef(false);

  useImperativeHandle(ref, () => ({ centerOn: (p) => map.current?.fitTo(circleBounds(p, radiusRef.current), 40) }), []);

  // Açılış: başlangıç merkezine git ve daireyi sığdır. Sonra yarıçap değişince yeniden sığdır.
  useEffect(() => {
    const c = ready.current ? centerRef.current : initialCenter;
    ready.current = true;
    map.current?.fitTo(circleBounds(c, radiusM), 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radiusM]);

  const onCamera = (c: LatLng) => {
    // Açılış animasyonu bitmeden ilk kare HOME'u bildirir: başlangıç merkezi korunsun.
    if (!ready.current) return;
    centerRef.current = c;
    setCenter(c);
    changeRef.current(c);
  };

  return (
    <View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      <PreviewMap ref={map} padding={NO_PADDING} onCameraChange={onCamera} accessibilityLabel="Bölge haritası">
        <EditorCircle center={center} radiusM={radiusM} />
      </PreviewMap>
      <Crosshair emoji={emoji} />
    </View>
  );
}

function EditorCircle({ center, radiusM }: { center: LatLng; radiusM: number }) {
  const { colors } = useTheme();
  const project = useContext(MapProjectionContext);
  if (!project) return null;
  const c = project(center.lat, center.lng);
  const north = project(center.lat + radiusM / 111_320, center.lng);
  const r = Math.max(6, Math.abs(c.y - north.y));
  return (
    <View
      pointerEvents="none"
      testID="zone-editor-circle"
      style={{
        position: 'absolute',
        left: c.x - r,
        top: c.y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        borderWidth: 2,
        borderColor: withAlpha(colors.primary, 0.8),
        backgroundColor: withAlpha(colors.primary, 0.14),
      }}
    />
  );
}
