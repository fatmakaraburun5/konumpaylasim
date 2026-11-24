import { LOW_BATTERY_PCT, type Freshness } from '@konum/core';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Text } from './Text';
import { useTheme } from './theme';

export interface AvatarProps {
  name: string;
  size?: number;
  /** Tazelik halkası: live = canlı yeşil düz, recent = birincil düz, stale = gri kesikli. Yoksa halka çizilmez. */
  freshness?: Freshness | null;
  /** Pil yüzdesi; verilirse rozet gösterilir. %15 ve altı uyarı renginde. */
  batteryPct?: number | null;
  /** Ad yerine erişilebilirlik etiketi. */
  accessibilityLabel?: string;
}

/** "Ayşe Yılmaz" → "AY" (Türkçe büyük harf kuralıyla: i → İ). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? [parts[0]!, parts[parts.length - 1]!] : parts.slice(0, 1);
  const out = letters.map((p) => Array.from(p)[0] ?? '').join('');
  return out.toLocaleUpperCase('tr-TR') || '?';
}

export function Avatar({ name, size = 40, freshness = null, batteryPct = null, accessibilityLabel }: AvatarProps) {
  const { colors } = useTheme();
  const ring = freshness ? 3 : 0;
  const gap = freshness ? 2 : 0;
  const outer = size + (ring + gap) * 2;
  const ringColor = freshness === 'live' ? colors.live : freshness === 'recent' ? colors.primary : colors.stale;
  const low = batteryPct !== null && batteryPct <= LOW_BATTERY_PCT;
  const r = (outer - ring) / 2;

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? name}
      style={{ width: outer, height: outer, alignItems: 'center', justifyContent: 'center' }}
    >
      {freshness ? (
        <Svg width={outer} height={outer} style={StyleSheet.absoluteFill}>
          <Circle
            cx={outer / 2}
            cy={outer / 2}
            r={r}
            stroke={ringColor}
            strokeWidth={ring}
            fill="none"
            strokeDasharray={freshness === 'stale' ? [4, 3] : undefined}
          />
        </Svg>
      ) : null}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: freshness === 'stale' ? colors.surfaceAlt : colors.primarySoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          variant={size >= 48 ? 'heading' : 'label'}
          style={{ color: freshness === 'stale' ? colors.stale : colors.primary }}
          maxFontSizeMultiplier={1}
        >
          {initialsOf(name)}
        </Text>
      </View>
      {batteryPct !== null ? (
        <View
          style={[
            styles.badge,
            {
              backgroundColor: low ? colors.warning : colors.surface,
              borderColor: low ? colors.warning : colors.border,
            },
          ]}
        >
          <Text variant="caption" style={{ color: low ? colors.onPrimary : colors.textSecondary, fontSize: 10, lineHeight: 12 }} maxFontSizeMultiplier={1}>
            {`%${batteryPct}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    right: -6,
    bottom: -2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
  },
});
