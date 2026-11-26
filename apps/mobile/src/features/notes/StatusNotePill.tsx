/**
 * Faz 4: harita alt alanında durum notu girişi. Not yoksa "＋ Not ekle", varsa "☕ Kahve molasındayım · 25 dk kaldı".
 * Dokun → NoteSheet (status modu).
 */
import { composeNoteLabel, formatNoteLeft } from '@konum/core';
import { Pressable, StyleSheet } from 'react-native';
import { useNow } from '../../lib/useNow';
import { useNotesStore } from '../../state/notesStore';
import { useMyProof } from '../../state/proofStore';
import { cardShadow, MIN_TOUCH, Text, useTheme } from '../../ui';

export function StatusNotePill({ onPress }: { onPress: () => void }) {
  const { colors, radius, spacing } = useTheme();
  const note = useNotesStore((s) => s.myStatus);
  const now = useNow(30_000);
  const active = note !== null && note.expires_at > now;
  // Faz 9: etkin anlık fotoğraf varsa kamera işareti.
  const proof = useMyProof();
  const photo = proof !== null && proof.expires_at > now ? '📷 ' : '';
  const label = `${photo}${active ? composeNoteLabel(note.emoji, note.text) : '＋ Not ekle'}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active ? `Durum notun: ${label}, ${formatNoteLeft(note.expires_at, now)}. Düzenlemek için dokun.` : 'Durum notu ekle'}
      hitSlop={4}
      testID="status-note-pill"
      style={({ pressed }) => [
        styles.pill,
        cardShadow,
        {
          backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
          borderRadius: radius.pill,
          paddingHorizontal: spacing.md,
          borderColor: active ? colors.warning : colors.border,
        },
      ]}
    >
      <Text variant="label" numberOfLines={1} style={styles.text}>
        {label}
      </Text>
      {active ? (
        <Text variant="caption" color="textSecondary" numberOfLines={1}>
          {formatNoteLeft(note.expires_at, now)}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { minHeight: MIN_TOUCH + 4, justifyContent: 'center', borderWidth: 1, maxWidth: 240, alignSelf: 'flex-start' },
  text: { maxWidth: 220 },
});
