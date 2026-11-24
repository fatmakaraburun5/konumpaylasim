/**
 * YALNIZCA web: `MeetupMapLayer.tsx` ile aynı props. Pinler önizleme haritasının izdüşümüyle yerleşen View'lar,
 * kesikli çizgiler react-native-svg (MapCanvas.web TrailLine deseni).
 */
import type { MeetupPlace } from '@konum/core';
import { useContext } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text, useTheme } from '../../ui';
import { MapProjectionContext } from '../map/PreviewMap.web';
import { meetupPlaceEmoji, showsCenterMark, type MeetupMapOverlay } from './meetupModel';

export interface MeetupMapLayerProps {
  overlay: MeetupMapOverlay;
  onSelect?: (index: number) => void;
}

const PLACE_W = 200;

export function MeetupMapLayer({ overlay, onSelect }: MeetupMapLayerProps) {
  const { colors } = useTheme();
  const project = useContext(MapProjectionContext);
  if (!project) return null;
  const selected = overlay.selectedIndex !== null ? overlay.suggestions[overlay.selectedIndex] : undefined;
  const lines = selected
    ? overlay.participants.map((p) => {
        const a = project(p.position.lat, p.position.lng);
        const b = project(selected.place.location.lat, selected.place.location.lng);
        return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      })
    : [];
  const center = showsCenterMark(overlay) && overlay.center ? project(overlay.center.lat, overlay.center.lng) : null;
  return (
    <>
      {lines.length > 0 ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityLabel="Katılımcılardan öneriye çizgiler">
          <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
            {lines.map((d, i) => (
              <Path key={i} d={d} stroke={colors.stale} strokeWidth={2.5} strokeDasharray="6 6" strokeLinecap="round" fill="none" />
            ))}
          </Svg>
        </View>
      ) : null}
      {center ? (
        <View pointerEvents="none" accessibilityLabel="Orta nokta" testID="meetup-center" style={[styles.abs, { left: center.x - 11, top: center.y - 11, zIndex: 4 }]}>
          <CenterBadge />
        </View>
      ) : null}
      {overlay.suggestions.map((s, i) => {
        const p = project(s.place.location.lat, s.place.location.lng);
        const isSel = i === overlay.selectedIndex;
        return (
          <View key={`msug:${i}:${s.place.place_id ?? 'mid'}`} pointerEvents="box-none" style={[styles.abs, { left: p.x - 17, top: p.y - 46, zIndex: isSel ? 7 : 6 }]} testID={`meetup-suggestion-${i + 1}`}>
            <Pressable onPress={() => onSelect?.(i)} accessibilityRole="button" accessibilityLabel={`Öneri ${i + 1}: ${s.place.name}${isSel ? ', seçili' : ''}`} style={styles.press}>
              <NumberPin number={i + 1} selected={isSel} />
            </Pressable>
          </View>
        );
      })}
      {overlay.focused ? <FocusedPin place={overlay.focused} /> : null}
    </>
  );
}

function FocusedPin({ place }: { place: MeetupPlace }) {
  const project = useContext(MapProjectionContext);
  if (!project) return null;
  const p = project(place.location.lat, place.location.lng);
  return (
    <View pointerEvents="none" accessibilityLabel={`Buluşma noktası: ${place.name}`} testID="meetup-focused" style={[styles.abs, { width: PLACE_W, left: p.x - PLACE_W / 2, top: p.y - 42, zIndex: 7 }]}>
      <PlacePin place={place} />
    </View>
  );
}

export function NumberPin({ number, selected }: { number: number; selected: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.pinWrap}>
      <View style={[styles.pinHead, { backgroundColor: selected ? colors.primary : colors.surface, borderColor: colors.primary, boxShadow: '0px 2px 6px rgba(15, 23, 42, 0.3)' }]}>
        <Text variant="heading" maxFontSizeMultiplier={1} style={{ color: selected ? colors.onPrimary : colors.primary, lineHeight: 20 }}>
          {String(number)}
        </Text>
      </View>
      <View style={[styles.pinStem, { backgroundColor: colors.primary }]} />
    </View>
  );
}

export function CenterBadge() {
  const { colors } = useTheme();
  return (
    <View style={[styles.center, { borderColor: colors.text, backgroundColor: colors.surface }]}>
      <View style={[styles.centerDot, { backgroundColor: colors.text }]} />
    </View>
  );
}

export function PlacePin({ place }: { place: MeetupPlace }) {
  const { colors, radius } = useTheme();
  return (
    <View style={styles.placeWrap}>
      <View style={[styles.placeLabel, { backgroundColor: colors.live, borderRadius: radius.sm, boxShadow: '0px 2px 6px rgba(15, 23, 42, 0.3)' }]}>
        <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: '#FFFFFF', fontWeight: '700' }}>
          {`${meetupPlaceEmoji(place)} ${place.name}`}
        </Text>
      </View>
      <View style={[styles.placeStem, { backgroundColor: colors.live }]} />
      <View style={[styles.placeDot, { backgroundColor: colors.live, borderColor: colors.surface }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute', alignItems: 'center' },
  press: { alignItems: 'center', cursor: 'pointer' },
  pinWrap: { alignItems: 'center', width: 34, height: 46 },
  pinHead: { width: 32, height: 32, borderRadius: 16, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  pinStem: { width: 3, height: 14, marginTop: -1, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  center: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  centerDot: { width: 6, height: 6, borderRadius: 3 },
  placeWrap: { alignItems: 'center', maxWidth: PLACE_W },
  placeLabel: { paddingHorizontal: 8, paddingVertical: 3, maxWidth: PLACE_W },
  placeStem: { width: 3, height: 10 },
  placeDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, marginTop: -2 },
});
