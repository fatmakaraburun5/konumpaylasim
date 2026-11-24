/**
 * YALNIZCA web: `F4Markers.tsx` ile aynı props. İşaretler önizleme haritasının (PreviewMap.web) izdüşümüyle ekran
 * koordinatına yerleştirilen View'lardır (FriendMarker.web deseni).
 */
import { formatAccuracyTr, PING_EMOJI, PING_TEXT, type PlaceNote, type Ping, type SosAlert } from '@konum/core';
import { useContext } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Avatar, lightColors, PulseRing, Text, useTheme } from '../../ui';
import { MapProjectionContext } from './PreviewMap.web';

export interface PlaceNoteMarkerProps {
  note: PlaceNote;
  selected: boolean;
  mine: boolean;
  onPress: () => void;
}

export function PlaceNoteMarker({ note, selected, mine, onPress }: PlaceNoteMarkerProps) {
  const project = useContext(MapProjectionContext);
  if (!project) return null;
  const p = project(note.position.lat, note.position.lng);
  return (
    <View pointerEvents="box-none" style={[styles.abs, { left: p.x - 20, top: p.y - 50, zIndex: selected ? 5 : 3 }]} testID={`place-note-${note.note_id}`}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Yer notu: ${note.text}${mine ? ', senin notun' : ''}`} style={styles.press}>
        <NoteBadge emoji={note.emoji} selected={selected} />
      </Pressable>
    </View>
  );
}

export function NoteBadge({ emoji, selected }: { emoji: string | null; selected: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.noteWrap}>
      <View style={[styles.noteHead, { backgroundColor: selected ? colors.warning : colors.surface, borderColor: colors.warning, boxShadow: '0px 2px 6px rgba(15, 23, 42, 0.3)' }]}>
        <Text variant="label" maxFontSizeMultiplier={1} style={styles.emoji}>
          {emoji ?? '📝'}
        </Text>
      </View>
      <View style={[styles.noteStem, { backgroundColor: colors.warning }]} />
    </View>
  );
}

export interface PingMarkerProps {
  ping: Ping;
  name: string;
  highlighted: boolean;
  onPress: () => void;
}

const BOX = 76;
const LABEL_W = 180;

export function PingMarker({ ping, name, highlighted, onPress }: PingMarkerProps) {
  const { colors, radius } = useTheme();
  const project = useContext(MapProjectionContext);
  if (!project || !ping.location) return null;
  const p = project(ping.location.lat, ping.location.lng);
  return (
    <View pointerEvents="box-none" style={[styles.abs, { width: LABEL_W, left: p.x - LABEL_W / 2, top: p.y - BOX / 2, zIndex: 4 }]} testID={`ping-pin-${ping.ping_id}`}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${name}: ${PING_TEXT[ping.kind]}, doğruluk ${formatAccuracyTr(ping.location.accuracy)}`}
        style={styles.press}
      >
        <View style={styles.ringBox}>
          {highlighted ? <PulseRing size={44} color={colors.primary} /> : null}
          <View style={{ backgroundColor: colors.primary, borderRadius: 999, padding: 2, boxShadow: '0px 2px 8px rgba(15, 23, 42, 0.18)' }}>
            <Avatar name={name} size={36} />
          </View>
        </View>
        <View style={[styles.label, { backgroundColor: colors.primary, borderRadius: radius.sm }]}>
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: colors.onPrimary }}>
            {`${PING_EMOJI[ping.kind]} ${name.split(' ')[0]} · ${PING_TEXT[ping.kind]}`}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

export interface SosMarkerProps {
  alert: SosAlert;
  onPress: () => void;
}

export function SosMarker({ alert, onPress }: SosMarkerProps) {
  const project = useContext(MapProjectionContext);
  if (!project) return null;
  const loc = alert.location;
  const c = project(loc.lat, loc.lng);
  // Doğruluk (m) → piksel (MapCanvas.web MyLocation ile aynı yöntem).
  const north = project(loc.lat + loc.accuracy / 111_320, loc.lng);
  const r = Math.max(10, Math.abs(c.y - north.y));
  return (
    <>
      <View
        pointerEvents="none"
        style={[
          styles.abs,
          { left: c.x - r, top: c.y - r, width: r * 2, height: r * 2, borderRadius: r, borderWidth: 2, borderColor: lightColors.danger, backgroundColor: 'rgba(185, 28, 28, 0.15)', zIndex: 5 },
        ]}
      />
      <View pointerEvents="box-none" style={[styles.abs, { width: LABEL_W, left: c.x - LABEL_W / 2, top: c.y - BOX / 2, zIndex: 6 }]} testID={`sos-pin-${alert.sos_id}`}>
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Acil durum: ${alert.sender_name} burada, doğruluk ${formatAccuracyTr(loc.accuracy)}`} style={styles.press}>
          <SosBadge name={alert.sender_name} />
        </Pressable>
      </View>
    </>
  );
}

export function SosBadge({ name }: { name: string }) {
  const { radius } = useTheme();
  return (
    <View style={styles.press}>
      <View style={styles.ringBox}>
        <PulseRing size={44} color={lightColors.danger} scaleTo={1.6} />
        <View style={{ backgroundColor: lightColors.danger, borderRadius: 999, padding: 3 }}>
          <Avatar name={name} size={34} />
        </View>
      </View>
      <View style={[styles.label, { backgroundColor: lightColors.danger, borderRadius: radius.sm }]}>
        <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: '#FFFFFF', fontWeight: '700' }}>
          {`SOS · ${name.split(' ')[0]}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute', alignItems: 'center' },
  press: { alignItems: 'center', cursor: 'pointer' },
  noteWrap: { alignItems: 'center', width: 40, height: 50 },
  noteHead: { width: 36, height: 36, borderRadius: 18, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  noteStem: { width: 3, height: 12, marginTop: -1, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  emoji: { fontSize: 17, lineHeight: 22 },
  ringBox: { width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' },
  label: { marginTop: -14, paddingHorizontal: 7, paddingVertical: 2, maxWidth: LABEL_W },
});
