/** "Arkadaşlar | Bağlantı (QR)" bölümlü seçici (segmented control). */
import { Pressable, StyleSheet, View } from 'react-native';
import { MIN_TOUCH, Text, useTheme } from '../../ui';

export type ShareAudience = 'friends' | 'link';

const OPTIONS: { id: ShareAudience; label: string }[] = [
  { id: 'friends', label: 'Arkadaşlar' },
  { id: 'link', label: 'Bağlantı (QR)' },
];

export function AudienceSwitch({ value, onChange }: { value: ShareAudience; onChange: (a: ShareAudience) => void }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.wrap, { marginHorizontal: spacing.md, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: 3 }]}
    >
      {OPTIONS.map((o) => {
        const selected = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.id)}
            style={[styles.item, { minHeight: MIN_TOUCH - 4, borderRadius: radius.md - 3, backgroundColor: selected ? colors.surface : 'transparent' }]}
          >
            <Text variant="label" style={{ color: selected ? colors.text : colors.textSecondary }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row' },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
