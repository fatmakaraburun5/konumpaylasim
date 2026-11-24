/**
 * Faz 5: ana haritada kendi bölgelerim (native, react-native-maps). Web kardeşi `ZoneMapLayer.web.tsx` aynı props'u
 * sunar. Soluk daire (yarıçap) + ortada emoji rozeti; içindeysem daire biraz daha belirgin.
 * Bölge koordinatı yalnızca sahibinin cihazında çizilir (alıcılara asla gitmez).
 */
import type { Zone, ZonePresence } from '@konum/core';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Circle, Marker } from 'react-native-maps';
import { Text, useTheme } from '../../ui';
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
  const [tracks, setTracks] = useState(true);
  const emoji = zoneEmoji(zone);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [emoji, colors]);
  const coord = { latitude: zone.center.lat, longitude: zone.center.lng };
  return (
    <>
      <Circle
        center={coord}
        radius={zone.radius_m}
        strokeColor={withAlpha(colors.primary, inside ? 0.6 : 0.35)}
        strokeWidth={1.5}
        fillColor={withAlpha(colors.primary, inside ? 0.12 : 0.06)}
        zIndex={0}
      />
      <Marker
        identifier={`zone:${zone.zone_id}`}
        coordinate={coord}
        anchor={{ x: 0.5, y: 0.5 }}
        tracksViewChanges={tracks}
        accessibilityLabel={`Bölgen: ${zone.name}${inside ? ', şu an buradasın' : ''}`}
        zIndex={0}
        opacity={0.85}
      >
        <ZoneBadge emoji={emoji} />
      </Marker>
    </>
  );
}

/** Bölge emoji rozeti (native ve web aynı görünüm). */
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
  badge: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
});
