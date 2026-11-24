/**
 * Faz 5: haritada buluşma noktası katmanı (native, react-native-maps). Web kardeşi `MeetupMapLayer.web.tsx`.
 *
 *  - Öneri arama sırasında: numaralı öneri pinleri (1-3; seçili olan dolu), orta nokta işareti, seçili öneriye her
 *    katılımcıdan kesikli çizgi. Benim rotam MapCanvas `route` (useRouteEta) ile ayrıca çizilir.
 *  - Paylaşılmış öneri kartı açıkken: yer pini (kategori emojisi + ad).
 */
import type { LatLng, MeetupPlace } from '@konum/core';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Marker, Polyline } from 'react-native-maps';
import { Text, useTheme } from '../../ui';
import { meetupPlaceEmoji, showsCenterMark, type MeetupMapOverlay } from './meetupModel';

export interface MeetupMapLayerProps {
  overlay: MeetupMapOverlay;
  onSelect?: (index: number) => void;
}

const coordOf = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng });

function useBriefTracking(...deps: unknown[]): boolean {
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return tracks;
}

export function MeetupMapLayer({ overlay, onSelect }: MeetupMapLayerProps) {
  const { colors } = useTheme();
  const selected = overlay.selectedIndex !== null ? overlay.suggestions[overlay.selectedIndex] : undefined;
  return (
    <>
      {selected
        ? overlay.participants.map((p) => (
            <Polyline
              key={`mline:${p.key}`}
              coordinates={[coordOf(p.position), coordOf(selected.place.location)]}
              strokeColor={colors.stale}
              strokeWidth={2.5}
              lineDashPattern={[6, 6]}
              zIndex={1}
            />
          ))
        : null}
      {showsCenterMark(overlay) && overlay.center ? <CenterMark at={overlay.center} /> : null}
      {overlay.suggestions.map((s, i) => (
        <SuggestionMarker key={`msug:${i}:${s.place.place_id ?? 'mid'}`} place={s.place} number={i + 1} selected={i === overlay.selectedIndex} onPress={() => onSelect?.(i)} />
      ))}
      {overlay.focused ? <FocusedMarker place={overlay.focused} /> : null}
    </>
  );
}

function SuggestionMarker({ place, number, selected, onPress }: { place: MeetupPlace; number: number; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const tracks = useBriefTracking(selected, number, colors);
  return (
    <Marker
      identifier={`meetup-suggestion-${number}`}
      coordinate={coordOf(place.location)}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={tracks}
      onPress={onPress}
      accessibilityLabel={`Öneri ${number}: ${place.name}${selected ? ', seçili' : ''}`}
      zIndex={selected ? 6 : 5}
    >
      <NumberPin number={number} selected={selected} />
    </Marker>
  );
}

function CenterMark({ at }: { at: LatLng }) {
  const { colors } = useTheme();
  const tracks = useBriefTracking(colors);
  return (
    <Marker identifier="meetup-center" coordinate={coordOf(at)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={tracks} accessibilityLabel="Orta nokta" zIndex={4}>
      <CenterBadge />
    </Marker>
  );
}

function FocusedMarker({ place }: { place: MeetupPlace }) {
  const { colors } = useTheme();
  const tracks = useBriefTracking(place.name, colors);
  return (
    <Marker
      identifier="meetup-focused"
      coordinate={coordOf(place.location)}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={tracks}
      accessibilityLabel={`Buluşma noktası: ${place.name}`}
      zIndex={6}
    >
      <PlacePin place={place} />
    </Marker>
  );
}

/** Numaralı öneri pini (native ve web aynı görünüm). */
export function NumberPin({ number, selected }: { number: number; selected: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.pinWrap}>
      <View style={[styles.pinHead, { backgroundColor: selected ? colors.primary : colors.surface, borderColor: colors.primary }]}>
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
      <View style={[styles.placeLabel, { backgroundColor: colors.live, borderRadius: radius.sm }]}>
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
  pinWrap: { alignItems: 'center', width: 34, height: 46 },
  pinHead: { width: 32, height: 32, borderRadius: 16, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  pinStem: { width: 3, height: 14, marginTop: -1, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  center: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  centerDot: { width: 6, height: 6, borderRadius: 3 },
  placeWrap: { alignItems: 'center', maxWidth: 200 },
  placeLabel: { paddingHorizontal: 8, paddingVertical: 3, maxWidth: 200 },
  placeStem: { width: 3, height: 10 },
  placeDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, marginTop: -2 },
});
