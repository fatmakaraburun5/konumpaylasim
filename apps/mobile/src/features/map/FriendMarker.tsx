import type { EpochMs, Freshness, ReceiverStatus } from '@konum/core';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { MarkerAnimated, type AnimatedRegion, type MapMarkerProps } from 'react-native-maps';
import { Avatar, lightColors, PulseRing, Text, useTheme } from '../../ui';
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
  /** Faz 4: arkadaşın durum notu ("☕ Kahve molasındayım"); pinin altında küçük balon. */
  note?: string | null;
  /** Faz 4: nabız halkası — `ping` (yeni "Buradayım/Yoldayım", birincil renk) ya da `sos` (aktif SOS, kırmızı). */
  pulse?: 'ping' | 'sos' | null;
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
export function FriendMarker({ id, name, lat, lng, freshness, batteryPct, onPress, timestamp, selected = false, status, note = null, pulse = null }: FriendMarkerProps) {
  const dim = status !== undefined && DIM.has(status);
  const { colors, radius } = useTheme();
  const coordinate = useMarkerMotion(lat, lng, timestamp);
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [freshness, batteryPct, name, selected, colors, dim, note, pulse]);
  const sos = pulse === 'sos';
  const ringColor = sos ? lightColors.danger : selected ? colors.primary : colors.surface;

  return (
    <AnimatedMarker
      identifier={id}
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      // Nabız halkası canlandığı sürece bit eşlem yeniden çizilmeli.
      tracksViewChanges={tracks || pulse !== null}
      onPress={onPress}
      accessibilityLabel={`${sos ? 'Acil durum: ' : ''}${name} konumu${dim ? ', bağlantısı kopmuş olabilir' : ''}${note ? `, not: ${note}` : ''}`}
      zIndex={sos ? 4 : selected ? 2 : 1}
    >
      <View style={[styles.wrap, dim && !selected && !sos ? styles.dim : null]}>
        <View style={pulse ? styles.ringBox : null}>
          {pulse ? <PulseRing size={44} color={sos ? lightColors.danger : colors.primary} /> : null}
          <View style={{ backgroundColor: ringColor, borderRadius: 999, padding: sos ? 3 : 2 }}>
            <Avatar name={name} size={36} freshness={freshness} batteryPct={batteryPct} />
          </View>
        </View>
        <View style={[styles.label, { backgroundColor: sos ? lightColors.danger : selected ? colors.primary : colors.surface, borderRadius: radius.sm }]}>
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={selected || sos ? { color: colors.onPrimary, fontWeight: sos ? '700' : undefined } : undefined}>
            {sos ? `SOS · ${name.split(' ')[0]}` : name.split(' ')[0]}
          </Text>
        </View>
        {note ? (
          <View style={[styles.note, { backgroundColor: colors.warningSoft, borderColor: colors.warning, borderRadius: radius.sm }]}>
            <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: colors.text, fontSize: 11, lineHeight: 14 }}>
              {note}
            </Text>
          </View>
        ) : null}
      </View>
    </AnimatedMarker>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  dim: { opacity: 0.55 },
  label: { marginTop: 2, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 96 },
  // Nabız alanı simetrik büyür: avatar merkezinin çapaya göre konumu değişmez.
  ringBox: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center' },
  note: { marginTop: 2, paddingHorizontal: 5, paddingVertical: 1, maxWidth: 150, borderWidth: 1 },
});
