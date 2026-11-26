/**
 * Faz 9: anlık fotoğrafın küçük yuvarlak resmi + kalan süre halkası (core `proofRemainingRatio`). Kişi kartında,
 * kitapçıkta ve durum notu sayfasında. Görsel `cachePolicy="none"` ile çizilir (diskte ikinci kopya kalmaz).
 */
import type { EpochMs } from '@konum/core';
import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Icon, useTheme } from '../../ui';
import { ProgressRing } from '../map/ProgressRing';
import { proofLeft } from './proofModel';

export interface ProofThumbProps {
  uri: string | null;
  expiresAt: EpochMs;
  now: EpochMs;
  size?: number;
  loading?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
}

export function ProofThumb({ uri, expiresAt, now, size = 44, loading = false, onPress, accessibilityLabel, testID }: ProofThumbProps) {
  const { colors } = useTheme();
  const left = proofLeft(expiresAt, now);
  const stroke = 3;
  const inner = size - stroke * 2 - 2;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Anlık fotoğraf, ${left.text}`}
      hitSlop={4}
      testID={testID}
      style={({ pressed }) => [{ width: size, height: size, opacity: pressed ? 0.8 : 1 }]}
    >
      <ProgressRing progress={left.ratio} size={size} stroke={stroke} color={left.ratio < 0.15 ? colors.warning : colors.live} />
      <View style={[styles.inner, { width: inner, height: inner, borderRadius: inner / 2, top: stroke + 1, left: stroke + 1, backgroundColor: colors.surfaceAlt }]}>
        {uri && !left.expired ? (
          <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="none" transition={0} />
        ) : loading ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Icon name="camera" size={Math.round(inner * 0.5)} color={colors.textSecondary} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  inner: { position: 'absolute', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
