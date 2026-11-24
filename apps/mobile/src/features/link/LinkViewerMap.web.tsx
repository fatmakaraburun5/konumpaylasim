/**
 * Web önizlemesi: QR izleyicisinin haritası (native `LinkViewerMap.tsx` → yerel Google Maps SDK ile aynı props ve
 * `LinkViewerMapHandle`). Vektör önizleme haritası (`PreviewMap.web`), paylaşan kişinin pini yumuşak kayar
 * (`useAnimatedLatLng`), kamera pini izler; kullanıcı haritayı kaydırınca izleme durur ("Ortala" ile geri gelir).
 * Konum gösterilmiyorken (yükleniyor / sona erdi) harita soluklaşır.
 */
import type { Freshness, LinkLiveLocation } from '@konum/core';
import { useContext, useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { View } from 'react-native';
import { Avatar, useTheme } from '../../ui';
import { MapProjectionContext, PreviewMap, type PreviewMapHandle } from '../map/PreviewMap.web';
import { useAnimatedLatLng } from '../map/useAnimatedLatLng.web';

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

/** [Varsayım] Native ile aynı: doğruluk 25 m'nin üstündeyse hale çizilir. */
const ACCURACY_CIRCLE_MIN_M = 25;
/**
 * [Varsayım] Native 16 kullanır; önizleme çiziminde sokak adı olmadığından 15.4 ile semt adı ("MODA") ve
 * çevre caddeler de görünür, izleyici nerede olduğunu anlar.
 */
const FOLLOW_ZOOM = 15.4;

export function LinkViewerMap({ live, freshness, follow, onUserPan, bottomInset, ref }: LinkViewerMapProps) {
  const map = useRef<PreviewMapHandle>(null);
  const first = useRef(true);
  const lat = live?.lat;
  const lng = live?.lng;

  useImperativeHandle(
    ref,
    () => ({
      recenter: () => {
        if (lat !== undefined && lng !== undefined) map.current?.centerOn(lat, lng, FOLLOW_ZOOM);
      },
    }),
    [lat, lng],
  );

  useEffect(() => {
    if (lat === undefined || lng === undefined || !follow) return;
    map.current?.centerOn(lat, lng, first.current ? FOLLOW_ZOOM : 0);
    first.current = false;
  }, [lat, lng, follow]);

  return (
    <PreviewMap
      ref={map}
      padding={{ top: 0, right: 0, bottom: bottomInset, left: 0 }}
      onUserPan={onUserPan}
      dimmed={!live}
      initialZoom={15.2}
      accessibilityLabel="Paylaşılan konum haritası"
    >
      {live ? <SharerMarker live={live} freshness={freshness} /> : null}
    </PreviewMap>
  );
}

function SharerMarker({ live, freshness }: { live: LinkLiveLocation; freshness: Freshness | null }) {
  const { colors } = useTheme();
  const project = useContext(MapProjectionContext);
  const pos = useAnimatedLatLng(live.lat, live.lng, live.timestamp);
  if (!project) return null;
  const p = project(pos.lat, pos.lng);
  const north = project(pos.lat + Math.min(live.accuracy, 2_000) / 111_320, pos.lng);
  const r = live.accuracy > ACCURACY_CIRCLE_MIN_M ? Math.abs(p.y - north.y) : 0;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: p.x, top: p.y, width: 0, height: 0 }} accessibilityLabel={`${live.sender_name} konumu`}>
      {r > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: -r,
            top: -r,
            width: r * 2,
            height: r * 2,
            borderRadius: r,
            backgroundColor: `${colors.primary}1F`,
            borderWidth: 1,
            borderColor: colors.primary,
          }}
        />
      ) : null}
      <View style={{ position: 'absolute', left: -40, top: -40, width: 80, height: 80, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ backgroundColor: colors.surface, borderRadius: 999, padding: 2, boxShadow: '0px 2px 8px rgba(15, 23, 42, 0.22)' }}>
          <Avatar name={live.sender_name} size={40} freshness={freshness ?? 'live'} batteryPct={live.battery_pct} />
        </View>
      </View>
    </View>
  );
}
