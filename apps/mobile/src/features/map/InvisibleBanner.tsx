/**
 * Faz 8: görünmezken üst çubuğun altındaki ince şerit (docs/PHASE8.md §5.3): "Görünmezsin · kimse konumunu
 * görmüyor" + "Görünür ol" (görünür olma sayfasını açar). 44 pt'yi aşmaz: haritayı örtmesin (docs/SHARE_DECK.md).
 */
import { Pressable, StyleSheet, View } from 'react-native';
import { INVISIBLE_TEXT } from '../../state/invisibleStore';
import { useOutgoingSosActive } from '../../state/sosStore';
import { cardShadow, Icon, MIN_TOUCH, Text, useTheme } from '../../ui';

export const INVISIBLE_BANNER_HEIGHT = MIN_TOUCH;

export function InvisibleBanner({ onVisible }: { onVisible: () => void }) {
  const { colors, radius, spacing } = useTheme();
  // Süren SOS görünmezlikten etkilenmez: şerit "kimse görmüyor" demez.
  const sosActive = useOutgoingSosActive();
  return (
    <View
      testID="map-invisible-banner"
      accessibilityRole="summary"
      style={[
        styles.bar,
        cardShadow,
        { marginHorizontal: spacing.md, backgroundColor: colors.surface, borderColor: colors.primary, borderRadius: radius.pill, paddingLeft: spacing.sm, gap: spacing.xs },
      ]}
    >
      <Icon name="eyeOff" size={18} color={colors.primary} />
      <Text variant="label" style={[styles.flex, styles.text]} numberOfLines={2}>
        {sosActive ? INVISIBLE_TEXT.bannerSos : INVISIBLE_TEXT.banner}
      </Text>
      <Pressable
        testID="map-invisible-visible"
        accessibilityRole="button"
        accessibilityLabel={INVISIBLE_TEXT.bannerAction}
        onPress={onVisible}
        hitSlop={6}
        style={({ pressed }) => [styles.action, { backgroundColor: pressed ? colors.primaryPressed : colors.primary, borderRadius: radius.pill, paddingHorizontal: spacing.sm }]}
      >
        <Text variant="label" style={{ color: colors.onPrimary }} numberOfLines={1}>
          {INVISIBLE_TEXT.bannerAction}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Yükseklik sabit 44 pt; düğmenin görünen boyu 32, dokunma alanı hitSlop ile 44.
  bar: { flexDirection: 'row', alignItems: 'center', height: INVISIBLE_BANNER_HEIGHT, borderWidth: 1, paddingRight: 6 },
  flex: { flex: 1 },
  // İki satır 44 pt'ye sığar (dar ekranda metin kesilmesin).
  text: { lineHeight: 16 },
  action: { height: 32, justifyContent: 'center' },
});
