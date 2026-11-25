/**
 * Faz 8: işaret kutusu ve kutulu satır (izin onay sayfası, görünür olurken geri yükleme listesi).
 * Satırın tamamı dokunma hedefidir (en az 44 pt); ekran okuyucuya `checkbox` rolü ve işaret durumu bildirilir.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon';
import { Text } from './Text';
import { useTheme } from './theme';
import { MIN_TOUCH } from './tokens';

export function CheckBox({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={[
        styles.box,
        {
          borderRadius: radius.sm,
          borderColor: checked ? colors.primary : colors.border,
          backgroundColor: checked ? colors.primary : 'transparent',
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      {checked ? <Icon name="check" color={colors.onPrimary} size={16} strokeWidth={2.5} /> : null}
    </View>
  );
}

export interface CheckRowProps {
  checked: boolean;
  onPress: () => void;
  title: string;
  subtitle?: string;
  /** Solda avatar vb. */
  left?: ReactNode;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

export function CheckRow({ checked, onPress, title, subtitle, left, disabled = false, testID, accessibilityLabel }: CheckRowProps) {
  const { colors, spacing } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      // react-native-web `accessibilityState`ı DOM'a taşımaz: web'de ekran okuyucu işaret durumunu `aria-checked`tan okur.
      aria-checked={checked}
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH + 4, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}
    >
      {left}
      <View style={styles.flex}>
        <Text variant="body" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="label" color="textSecondary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <CheckBox checked={checked} disabled={disabled} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { width: 24, height: 24, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  flex: { flex: 1 },
});
