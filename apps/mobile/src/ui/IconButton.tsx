import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './Icon';
import { useTheme } from './theme';
import { cardShadow, MIN_TOUCH } from './tokens';

export interface IconButtonProps {
  icon: IconName;
  accessibilityLabel: string;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
  /** `floating`: harita üstündeki yüzen düğme (kart gölgesi). */
  variant?: 'plain' | 'floating' | 'soft';
  size?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({ icon, accessibilityLabel, onPress, onLongPress, testID, variant = 'plain', size = MIN_TOUCH, disabled, style }: IconButtonProps) {
  const { colors } = useTheme();
  const bg = variant === 'floating' ? colors.surface : variant === 'soft' ? colors.surfaceAlt : 'transparent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      disabled={disabled}
      hitSlop={Math.max(0, (MIN_TOUCH - size) / 2)}
      style={({ pressed }) => [
        styles.base,
        { width: Math.max(size, MIN_TOUCH), height: Math.max(size, MIN_TOUCH), borderRadius: 999, backgroundColor: pressed ? colors.surfaceAlt : bg },
        variant === 'floating' ? cardShadow : null,
        disabled ? { opacity: 0.45 } : null,
        style,
      ]}
    >
      <Icon name={icon} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
