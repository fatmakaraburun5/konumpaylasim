/**
 * Faz 6: cinsiyet seçimi — iki büyük çip (Kadın / Erkek). Seçilen çipin kenarı, avatar çerçevesinin alacağı rengi
 * (core `genderRingColor`: kadın pembe, erkek mavi) gösterir. Kayıt (ProfileNameScreen), eski hesap kapısı
 * (GenderGate) ve profil ekranı aynı bileşeni kullanır.
 */
import { GENDER_TEXT, GENDERS, genderRingColor, type Gender } from '@konum/core';
import { Pressable, StyleSheet, View } from 'react-native';
import { MIN_TOUCH, Text, useTheme } from '../../ui';

export interface GenderPickerProps {
  value: Gender | null;
  onChange: (g: Gender) => void;
  disabled?: boolean;
}

export function GenderPicker({ value, onChange, disabled = false }: GenderPickerProps) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing.sm }]} accessibilityRole="radiogroup" accessibilityLabel="Cinsiyet">
      {GENDERS.map((g) => {
        const selected = value === g;
        const ring = genderRingColor(g);
        return (
          <Pressable
            key={g}
            testID={`gender-${g}`}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={GENDER_TEXT[g]}
            disabled={disabled}
            onPress={() => onChange(g)}
            style={({ pressed }) => [
              styles.chip,
              {
                minHeight: MIN_TOUCH + 20,
                borderRadius: radius.lg,
                borderColor: selected ? ring : colors.border,
                backgroundColor: selected ? colors.surface : colors.surfaceAlt,
                opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
                gap: spacing.xs,
              },
            ]}
          >
            <View style={[styles.swatch, { borderColor: ring, backgroundColor: selected ? ring : 'transparent' }]} />
            <Text variant="heading" style={{ color: selected ? colors.text : colors.textSecondary }}>
              {GENDER_TEXT[g]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  chip: { flex: 1, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', paddingHorizontal: 12 },
  swatch: { width: 16, height: 16, borderRadius: 8, borderWidth: 3 },
});
