/**
 * YALNIZCA web: `ZoneMapLayer.tsx` ile aynı props. Daireler önizleme haritasının (PreviewMap.web) izdüşümüyle
 * ekran koordinatına yerleşen View'lardır; yarıçap (m) → piksel, MyLocation halesiyle aynı yöntem.
 */
import type { Zone, ZonePresence } from '@konum/core';
import { useContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '../../ui';
import { MapProjectionContext } from '../map/PreviewMap.web';
import { withAlpha } from './zoneColors';
import { zoneEmoji } from './zoneModel';

export interface ZoneMapLayerProps {
  zones: readonly Zone[];
  presence?: Record<string, ZonePresence>;
}

export function ZoneMapLayer({ zones, presence }: ZoneMapLayerProps) {
  return (
    <>
      {zones.map((z) => (
        <ZoneShape key={`zone:${z.zone_id}`} zone={z} inside={presence?.[z.zone_id] === 'inside'} />
      ))}
    </>
  );
}

function ZoneShape({ zone, inside }: { zone: Zone; inside: boolean }) {
  const { colors } = useTheme();
  const project = useContext(MapProjectionContext);
  if (!project) return null;
  const c = project(zone.center.lat, zone.center.lng);
  const north = project(zone.center.lat + zone.radius_m / 111_320, zone.center.lng);
  const r = Math.max(6, Math.abs(c.y - north.y));
  return (
    <>
      <View
        pointerEvents="none"
        style={[
          styles.abs,
          {
            left: c.x - r,
            top: c.y - r,
            width: r * 2,
            height: r * 2,
            borderRadius: r,
            borderWidth: 1.5,
            borderColor: withAlpha(colors.primary, inside ? 0.6 : 0.35),
            backgroundColor: withAlpha(colors.primary, inside ? 0.12 : 0.06),
          },
        ]}
      />
      <View
        pointerEvents="none"
        accessibilityLabel={`Bölgen: ${zone.name}${inside ? ', şu an buradasın' : ''}`}
        testID={`zone-${zone.zone_id}`}
        style={[styles.abs, { left: c.x - 14, top: c.y - 14, opacity: 0.85 }]}
      >
        <ZoneBadge emoji={zoneEmoji(zone)} />
      </View>
    </>
  );
}

export function ZoneBadge({ emoji, size = 28 }: { emoji: string; size?: number }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.badge, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surface, borderColor: withAlpha(colors.primary, 0.45) }]}>
      <Text variant="label" maxFontSizeMultiplier={1} style={{ fontSize: size * 0.5, lineHeight: size * 0.68 }}>
        {emoji}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  badge: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
});
