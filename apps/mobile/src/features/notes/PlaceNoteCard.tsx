/**
 * Faz 4: haritada yer notu pinine dokununca alt kart: emoji + metin, kim bıraktı, kalan süre (core `formatNoteLeft`),
 * kimlerin gördüğü (yalnızca sahibine). Sahibi ise "Düzenle" / "Sil".
 */
import { formatNoteLeft, type EpochMs, type PlaceNote, type UserId } from '@konum/core';
import { StyleSheet, View } from 'react-native';
import { Button, cardShadow, Text, useTheme } from '../../ui';

export interface PlaceNoteCardProps {
  note: PlaceNote;
  myUid: UserId | null;
  names: Record<UserId, string>;
  now: EpochMs;
  deleting?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function audienceText(note: Pick<PlaceNote, 'visible_to'>, names: Record<UserId, string>): string {
  const n = note.visible_to.length;
  if (n === 0) return 'Yalnızca sen görüyorsun';
  const list = note.visible_to.slice(0, 3).map((u) => names[u] ?? 'Arkadaş');
  return n <= 3 ? `${list.join(', ')} görüyor` : `${list.join(', ')} ve ${n - 3} kişi daha görüyor`;
}

export function PlaceNoteCard({ note, myUid, names, now, deleting = false, onEdit, onDelete, onClose }: PlaceNoteCardProps) {
  const { colors, radius, spacing } = useTheme();
  const mine = myUid !== null && note.owner_id === myUid;
  const owner = mine ? 'Sen bıraktın' : `${names[note.owner_id] ?? 'Arkadaşın'} bıraktı`;
  const left = formatNoteLeft(note.expires_at, now);
  return (
    <View
      style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.sm }]}
      accessibilityLabel="Yer notu kartı"
      testID="place-note-card"
    >
      <View style={[styles.row, { gap: spacing.sm }]}>
        <View style={[styles.badge, { backgroundColor: colors.warningSoft, borderColor: colors.warning }]}>
          <Text variant="heading" maxFontSizeMultiplier={1}>
            {note.emoji ?? '📝'}
          </Text>
        </View>
        <View style={styles.flex}>
          <Text variant="heading" accessibilityRole="header" numberOfLines={2}>
            {note.text}
          </Text>
          <Text variant="caption" color="textSecondary" numberOfLines={1}>
            {`${owner} · ${left}`}
          </Text>
          {mine ? (
            <Text variant="caption" color="textSecondary" numberOfLines={1}>
              {audienceText(note, names)}
            </Text>
          ) : null}
        </View>
      </View>
      {mine ? (
        <View style={[styles.row, { gap: spacing.xs }]}>
          <Button title="Düzenle" variant="secondary" onPress={onEdit} style={styles.flex} disabled={deleting} />
          <Button title="Sil" variant="danger" onPress={onDelete} style={styles.flex} loading={deleting} />
        </View>
      ) : null}
      <Button title="Kapat" variant="ghost" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  badge: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
