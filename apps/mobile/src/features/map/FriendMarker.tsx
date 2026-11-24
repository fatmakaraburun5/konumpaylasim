import type { EpochMs, Freshness, ReceiverStatus } from '@konum/core';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { MarkerAnimated, type AnimatedRegion, type MapMarkerProps } from 'react-native-maps';
import { Avatar, Text, useTheme } from '../../ui';
import { useMarkerMotion } from './useMarkerMotion';

export interface FriendMarkerProps {
  id: string;
  name: string;
  lat: number;
  lng: number;
  freshness: Freshness;
  batteryPct: number | null;
  onPress?: () => void;
  /** Konum örneğinin alındığı an (paketteki `timestamp`): iki örnek arası kayma süresi buradan. */
  timestamp?: EpochMs;
  /** Seçili (ETA kartı açık) pin: etiket vurgulanır. */
  selected?: boolean;
  /** Faz 3: core alıcı durumu; "Bağlantısı kopmuş olabilir" / uzun sessizlikte pin soluklaşır. */
  status?: ReceiverStatus;
}

const DIM: ReadonlySet<ReceiverStatus> = new Set(['offline_suspected', 'stale']);

/** `MarkerAnimated` tipinde `children` eksik; koordinat AnimatedRegion alır. */
type AnimatedMarkerProps = Omit<MapMarkerProps, 'coordinate'> & { coordinate: AnimatedRegion; children?: ReactNode };
export const AnimatedMarker = MarkerAnimated as unknown as ComponentType<AnimatedMarkerProps>;

/**
 * Arkadaş işaretçisi = Avatar + tazelik halkası + pil rozeti.
 * Özel görünümlü işaretçiler bit eşlem olarak çizilir; `tracksViewChanges` yalnızca görünüm
 * değiştikten sonra kısa süre açık tutulur (sürekli açık olması haritayı yavaşlatır).
 * Konum değişimi bit eşlemi yeniden çizdirmez: pin `useMarkerMotion` ile yeni konuma kayar.
 */
export function FriendMarker({ id, name, lat, lng, freshness, batteryPct, onPress, timestamp, selected = false, status }: FriendMarkerProps) {
  const dim = status !== undefined && DIM.has(status);
  const { colors, radius } = useTheme();
  const coordinate = useMarkerMotion(lat, lng, timestamp);
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [freshness, batteryPct, name, selected, colors, dim]);

  return (
    <AnimatedMarker
      identifier={id}
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracks}
      onPress={onPress}
      accessibilityLabel={dim ? `${name} konumu, bağlantısı kopmuş olabilir` : `${name} konumu`}
      zIndex={selected ? 2 : 1}
    >
      <View style={[styles.wrap, dim && !selected ? styles.dim : null]}>
        <View style={{ backgroundColor: selected ? colors.primary : colors.surface, borderRadius: 999, padding: 2 }}>
          <Avatar name={name} size={36} freshness={freshness} batteryPct={batteryPct} />
        </View>
        <View style={[styles.label, { backgroundColor: selected ? colors.primary : colors.surface, borderRadius: radius.sm }]}>
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={selected ? { color: colors.onPrimary } : undefined}>
            {name.split(' ')[0]}
          </Text>
        </View>
      </View>
    </AnimatedMarker>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  dim: { opacity: 0.55 },
  label: { marginTop: 2, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 96 },
});
