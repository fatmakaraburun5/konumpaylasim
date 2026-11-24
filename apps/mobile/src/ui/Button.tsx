import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { MIN_TOUCH } from './tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
  /** Tam genişlik (varsayılan true). */
  block?: boolean;
  size?: 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}

export function Button({ title, variant = 'primary', loading = false, disabled, block = true, size = 'md', style, ...rest }: ButtonProps) {
  const { colors, radius, spacing } = useTheme();
  const isDisabled = disabled || loading;

  const palette = {
    primary: { bg: colors.primary, bgPressed: colors.primaryPressed, fg: colors.onPrimary, border: 'transparent' },
    secondary: { bg: colors.surfaceAlt, bgPressed: colors.border, fg: colors.text, border: 'transparent' },
    danger: { bg: colors.dangerSoft, bgPressed: colors.dangerSoft, fg: colors.danger, border: 'transparent' },
    ghost: { bg: 'transparent', bgPressed: colors.surfaceAlt, fg: colors.primary, border: 'transparent' },
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: loading }}
      accessibilityLabel={title}
      disabled={isDisabled}
      hitSlop={4}
      {...rest}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: size === 'lg' ? 52 : MIN_TOUCH,
          borderRadius: radius.md,
          paddingHorizontal: spacing.md,
          backgroundColor: pressed ? palette.bgPressed : palette.bg,
          borderColor: palette.border,
          opacity: isDisabled && !loading ? 0.45 : 1,
          alignSelf: block ? 'stretch' : 'auto',
        },
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? <ActivityIndicator color={palette.fg} style={{ marginRight: spacing.xs }} /> : null}
        <Text variant="heading" style={{ color: palette.fg }} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center' },
});
