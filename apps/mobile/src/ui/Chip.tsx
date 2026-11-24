import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { MIN_TOUCH } from './tokens';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  /** `warning`: süre dolmak üzere uyarısındaki uzatma çipleri. */
  tone?: 'default' | 'warning';
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

/** Seçilebilir çip (süre seçimi, uzatma). En az 44 pt yükseklik. */
export function Chip({ label, selected = false, onPress, disabled, tone = 'default', style, accessibilityHint }: ChipProps) {
  const { colors, radius, spacing } = useTheme();
  const bg = selected ? colors.primarySoft : tone === 'warning' ? colors.surface : colors.surfaceAlt;
  const border = selected ? colors.primary : tone === 'warning' ? colors.warning : colors.border;
  const fg = selected ? colors.primary : tone === 'warning' ? colors.warning : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: MIN_TOUCH,
          borderRadius: radius.pill,
          paddingHorizontal: spacing.md,
          backgroundColor: bg,
          borderColor: border,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      <Text variant="label" style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
});
