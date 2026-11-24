/**
 * Faz 4 harita işaretleri (native, react-native-maps). Web kardeşi `F4Markers.web.tsx` aynı props'u sunar.
 *
 *  - PlaceNoteMarker: yer notu (emoji rozet + ucu noktada); dokun → alt kart.
 *  - PingMarker: göndereni canlı görünmeyen "Buradayım/Yoldayım" pingi için geçici pin (süresi dolunca kalkar).
 *  - SosMarker: canlı pini olmayan SOS göndereninin TAM konumu: kırmızı, nabızlı, doğruluk dairesi.
 *
 * Özel görünümlü işaretçiler bit eşlem olarak çizilir; `tracksViewChanges` yalnızca kısa süre (nabızlı SOS pininde
 * sürekli) açık tutulur.
 */
import { formatAccuracyTr, PING_EMOJI, PING_TEXT, type PlaceNote, type Ping, type SosAlert } from '@konum/core';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Circle, Marker } from 'react-native-maps';
import { Avatar, lightColors, PulseRing, Text, useTheme } from '../../ui';

const coordOf = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });

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

export interface PlaceNoteMarkerProps {
  note: PlaceNote;
  selected: boolean;
  mine: boolean;
  onPress: () => void;
}

export function PlaceNoteMarker({ note, selected, mine, onPress }: PlaceNoteMarkerProps) {
  const { colors } = useTheme();
  const tracks = useBriefTracking(note.emoji, note.text, selected, colors);
  return (
    <Marker
      identifier={`note:${note.note_id}`}
      coordinate={coordOf(note.position)}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={tracks}
      onPress={onPress}
      accessibilityLabel={`Yer notu: ${note.text}${mine ? ', senin notun' : ''}`}
      zIndex={selected ? 3 : 1}
    >
      <NoteBadge emoji={note.emoji} selected={selected} />
    </Marker>
  );
}

/** Not rozeti (native ve web aynı görünüm). */
export function NoteBadge({ emoji, selected }: { emoji: string | null; selected: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.noteWrap}>
      <View style={[styles.noteHead, { backgroundColor: selected ? colors.warning : colors.surface, borderColor: colors.warning }]}>
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

export function PingMarker({ ping, name, highlighted, onPress }: PingMarkerProps) {
  const { colors, radius } = useTheme();
  const tracksBrief = useBriefTracking(ping.ping_id, name, colors);
  if (!ping.location) return null;
  return (
    <Marker
      identifier={`ping:${ping.ping_id}`}
      coordinate={coordOf(ping.location)}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksBrief || highlighted}
      onPress={onPress}
      accessibilityLabel={`${name}: ${PING_TEXT[ping.kind]}, doğruluk ${formatAccuracyTr(ping.location.accuracy)}`}
      zIndex={2}
    >
      <View style={styles.pingWrap}>
        <View style={styles.ringBox}>
          {highlighted ? <PulseRing size={44} color={colors.primary} /> : null}
          <View style={{ backgroundColor: colors.primary, borderRadius: 999, padding: 2 }}>
            <Avatar name={name} size={36} />
          </View>
        </View>
        <View style={[styles.label, { backgroundColor: colors.primary, borderRadius: radius.sm }]}>
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: colors.onPrimary }}>
            {`${PING_EMOJI[ping.kind]} ${name.split(' ')[0]} · ${PING_TEXT[ping.kind]}`}
          </Text>
        </View>
      </View>
    </Marker>
  );
}

export interface SosMarkerProps {
  alert: SosAlert;
  onPress: () => void;
}

export function SosMarker({ alert, onPress }: SosMarkerProps) {
  const loc = alert.location;
  return (
    <>
      <Circle
        center={coordOf(loc)}
        radius={Math.max(5, loc.accuracy)}
        strokeColor={lightColors.danger}
        strokeWidth={2}
        fillColor="rgba(185, 28, 28, 0.15)"
        zIndex={4}
      />
      <Marker
        identifier={`sos:${alert.sos_id}`}
        coordinate={coordOf(loc)}
        anchor={{ x: 0.5, y: 0.5 }}
        tracksViewChanges
        onPress={onPress}
        accessibilityLabel={`Acil durum: ${alert.sender_name} burada, doğruluk ${formatAccuracyTr(loc.accuracy)}`}
        zIndex={5}
      >
        <SosBadge name={alert.sender_name} />
      </Marker>
    </>
  );
}

/** Kırmızı nabızlı SOS rozeti (native ve web). */
export function SosBadge({ name }: { name: string }) {
  const { radius } = useTheme();
  return (
    <View style={styles.pingWrap}>
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
  noteWrap: { alignItems: 'center', width: 40, height: 50 },
  noteHead: { width: 36, height: 36, borderRadius: 18, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  noteStem: { width: 3, height: 12, marginTop: -1, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  emoji: { fontSize: 17, lineHeight: 22 },
  pingWrap: { alignItems: 'center' },
  ringBox: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center' },
  label: { marginTop: -14, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 160 },
});
