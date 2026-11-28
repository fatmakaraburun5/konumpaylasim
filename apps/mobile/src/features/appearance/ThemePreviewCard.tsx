/**
 * Faz 11: canlı tema önizleme kartı. Kartın İÇİ etkin temadan değil, önizlenen temanın belirteçlerinden çizilir
 * (`themeById`): mini harita (zemin, park, su, otoyol / cadde / sokak kademesi), üstünde pembe ve mavi çerçeveli iki
 * avatar pini (temanın kontrast halkasıyla) ve altta iki arka katmanlı mini kitapçık kartı + aksiyon düğmesi.
 * Böylece kullanıcı temayı seçmeden önce haritada pinlerin ve kart katmanlarının nasıl ayrıştığını görür.
 */
import { GENDER_RING, THEME_DESC, THEME_NAME, type ThemeId } from '@konum/core';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { Text, themeById, useTheme } from '../../ui';

export interface ThemePreviewCardProps {
  id: ThemeId;
  selected: boolean;
  /** Saat kuralındaki rolü ("Gündüz" / "Gece") rozeti. */
  badge?: string | null;
  onPress: () => void;
  width: number;
}

const MAP_H = 92;

function MiniPin({ x, y, ring, c }: { x: number; y: number; ring: string; c: ReturnType<typeof themeById>['colors'] }) {
  const halo = c.ringHalo === 'transparent' ? undefined : `0px 0px 0px 1.5px ${c.ringHalo}, 0px 1px 3px 0px ${c.ringShadow}`;
  return (
    <View style={[styles.pin, { left: x - 13, top: y - 13, borderColor: ring, backgroundColor: c.ringGap, boxShadow: halo }]}>
      <View style={[styles.pinFace, { backgroundColor: c.primarySoft }]} />
    </View>
  );
}

export const ThemePreviewCard = memo(function ThemePreviewCard({ id, selected, badge, onPress, width }: ThemePreviewCardProps) {
  const active = useTheme();
  const t = themeById(id);
  const c = t.colors;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${THEME_NAME[id]} teması: ${THEME_DESC[id]}`}
      onPress={onPress}
      testID={`theme-card-${id}`}
      style={({ pressed }) => [
        styles.card,
        {
          width,
          backgroundColor: c.bg,
          borderColor: selected ? active.colors.primary : active.colors.border,
          borderWidth: selected ? 2.5 : StyleSheet.hairlineWidth * 2,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={{ height: MAP_H, backgroundColor: c.mapLand, overflow: 'hidden' }}>
        <Svg width={width} height={MAP_H} viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice">
          <Rect x={0} y={0} width={160} height={92} fill={c.mapLand} />
          <Path d="M110 0 L160 0 L160 92 L128 92 C120 70 104 52 112 30 Z" fill={c.mapWater} stroke={c.mapShore} strokeWidth={1} />
          <Path d="M14 54 h34 v26 h-34 Z" fill={c.mapPark} />
          <Path d="M0 30 H160 M60 0 V92 M0 72 H112 M30 0 V54 M84 30 V92" stroke={c.mapRoadStroke} strokeWidth={4.5} fill="none" />
          <Path d="M0 30 H160 M60 0 V92 M0 72 H112 M30 0 V54 M84 30 V92" stroke={c.mapRoadMinor} strokeWidth={3} fill="none" />
          <Path d="M0 12 C40 20 70 6 110 16" stroke={c.mapRoadStroke} strokeWidth={8} fill="none" />
          <Path d="M0 12 C40 20 70 6 110 16" stroke={c.mapHighway} strokeWidth={6} fill="none" />
          <Path d="M60 30 H84 V72" stroke={c.primary} strokeWidth={3} strokeLinecap="round" fill="none" />
        </Svg>
        <MiniPin x={width * 0.36} y={44} ring={GENDER_RING.female} c={c} />
        <MiniPin x={width * 0.6} y={66} ring={GENDER_RING.male} c={c} />
        {badge ? (
          <View style={[styles.badge, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text variant="caption" style={{ color: c.text, fontSize: 10, lineHeight: 12 }} maxFontSizeMultiplier={1}>
              {badge}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Mini kitapçık: iki arka katman + ön kart */}
      <View style={{ paddingHorizontal: 8, paddingTop: 10, paddingBottom: 8, backgroundColor: c.bg }}>
        <View style={[styles.layer, { top: 2, left: 20, right: 20, backgroundColor: c.deckLayer2, borderColor: c.border }]} />
        <View style={[styles.layer, { top: 6, left: 14, right: 14, backgroundColor: c.deckLayer1, borderColor: c.border }]} />
        <View style={[styles.front, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={{ flex: 1, gap: 3 }}>
            <View style={[styles.line, { width: '70%', backgroundColor: c.text }]} />
            <View style={[styles.line, { width: '45%', backgroundColor: c.textSecondary, opacity: 0.8 }]} />
          </View>
          <View style={[styles.cta, { backgroundColor: c.primary }]}>
            <View style={[styles.line, { width: 14, backgroundColor: c.onPrimary }]} />
          </View>
        </View>
        <View style={styles.titleRow}>
          <Text variant="label" numberOfLines={1} style={{ color: c.text, flex: 1 }} maxFontSizeMultiplier={1.2}>
            {THEME_NAME[id]}
          </Text>
          {selected ? (
            <View style={[styles.check, { backgroundColor: active.colors.primary }]}>
              <Text variant="caption" style={{ color: active.colors.onPrimary, fontSize: 10, lineHeight: 12 }} maxFontSizeMultiplier={1}>
                ✓
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: 16, overflow: 'hidden' },
  pin: { position: 'absolute', width: 26, height: 26, borderRadius: 13, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  pinFace: { width: 16, height: 16, borderRadius: 8 },
  badge: { position: 'absolute', left: 6, top: 6, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  layer: { position: 'absolute', height: 30, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  front: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 7, marginTop: 4 },
  line: { height: 5, borderRadius: 3 },
  cta: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 999 },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 4 },
  check: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
