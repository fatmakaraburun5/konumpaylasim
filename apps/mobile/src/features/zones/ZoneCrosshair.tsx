/** Faz 5: bölge düzenleyici haritasının ortasında sabit artı işareti + bölge emojisi (native ve web aynı). */
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '../../ui';

export function Crosshair({ emoji }: { emoji: string }) {
  const { colors } = useTheme();
  return (
    <View pointerEvents="none" style={styles.wrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.v, { backgroundColor: colors.text }]} />
      <View style={[styles.h, { backgroundColor: colors.text }]} />
      <View style={[styles.dot, { backgroundColor: colors.primary, borderColor: colors.surface }]} />
      <View style={[styles.emoji, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
        <Text variant="label" maxFontSizeMultiplier={1} style={styles.emojiText}>
          {emoji}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: '50%', top: '50%', width: 0, height: 0, alignItems: 'center', justifyContent: 'center' },
  v: { position: 'absolute', width: 2, height: 28, left: -1, top: -14, opacity: 0.7 },
  h: { position: 'absolute', height: 2, width: 28, top: -1, left: -14, opacity: 0.7 },
  dot: { position: 'absolute', width: 12, height: 12, borderRadius: 6, borderWidth: 2, left: -6, top: -6 },
  emoji: { position: 'absolute', width: 30, height: 30, borderRadius: 15, borderWidth: 2, left: -15, top: -52, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 15, lineHeight: 20 },
});
