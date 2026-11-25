/**
 * Faz 4: kısa not alt sayfası (@gorhom/bottom-sheet, ShareSheet deseni). İki mod:
 *
 *  - `status` (durum notu, "☕ Kahve molasındayım"): canlı konumumun yanında, konumumu görenlere görünür.
 *    Kaydet → `notesStore.setMyStatus` (canlı hedef varsa hemen bir paket yayınlanır). Mevcut not düzenlenir / silinir.
 *  - `place` (yer notu, "🅿️ Park yeri burası"): haritada sabit noktaya. Kimler görsün: "Yalnızca ben" ya da en çok
 *    20 arkadaş. Kaydet → `notesStore.upsertPlace` (place_note_upsert); sahibi düzenler / siler.
 *
 * Hazır çipler core `NOTE_PRESETS` (türüne göre), süreler core `noteDurationsFor(kind)`, metin en çok
 * `NOTE_LIMITS.maxChars` (60), emoji en çok `maxEmojiChars`.
 */
import { NOTE_LIMITS, NOTE_PRESETS, noteDurationsFor, sanitizeNoteText, type NotePosition, type PlaceNote, type UserId } from '@konum/core';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, BottomSheetTextInput, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useCallback, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { now as serverNow } from '../../lib/clock';
import { useFriends } from '../../state/friendsStore';
import { notesStore, useNotesStore } from '../../state/notesStore';
import { Button, Chip, MIN_TOUCH, SheetHeader, Text, useTheme } from '../../ui';
import { RecipientPicker } from '../share/RecipientPicker';
import { pickerRowAccess } from '../access/accessModel';
import { useCanFn } from '../access/useAccess';

export type NoteSheetRequest = { mode: 'status' } | { mode: 'place'; position: NotePosition; note?: PlaceNote | null };

export interface NoteSheetHandle {
  present: (req: NoteSheetRequest) => void;
  dismiss: () => void;
}

export interface NoteSheetProps {
  /** Yer notu kaydedildi (haritada seçilsin). */
  onPlaceSaved?: (note: PlaceNote) => void;
  /** Yer notu silindi. */
  onPlaceDeleted?: (noteId: string) => void;
  ref?: Ref<NoteSheetHandle>;
}

/** [Varsayım] Varsayılan süreler: durum notu 1 saat, yer notu 1 gün. */
const DEFAULT_DURATION = { status: 'h1', place: 'd1' } as const;

/** Kalan süreye en yakın (ondan kısa olmayan) seçenek; yoksa en uzunu. */
function durationFor(kind: 'status' | 'place', leftMs: number | null): number {
  const opts = noteDurationsFor(kind);
  if (leftMs === null) return (opts.find((o) => o.id === DEFAULT_DURATION[kind]) ?? opts[0])!.ms;
  return (opts.find((o) => o.ms >= leftMs) ?? opts[opts.length - 1])!.ms;
}

export function NoteSheet({ onPlaceSaved, onPlaceDeleted, ref }: NoteSheetProps) {
  const { colors, spacing, radius, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useRef<BottomSheetModal>(null);
  const friends = useFriends();
  // Faz 8: yer notunu yalnızca konum izni verdiğim kişiler görebilir.
  const can = useCanFn();
  const myStatus = useNotesStore((s) => s.myStatus);

  const [req, setReq] = useState<NoteSheetRequest>({ mode: 'status' });
  const [emoji, setEmoji] = useState('');
  const [text, setText] = useState('');
  const [durationMs, setDurationMs] = useState(durationFor('status', null));
  const [audience, setAudience] = useState<ReadonlySet<UserId>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'saving' | 'deleting' | null>(null);

  const kind = req.mode;
  const editingPlace = req.mode === 'place' ? (req.note ?? null) : null;
  const editing = kind === 'status' ? myStatus !== null : editingPlace !== null;

  useImperativeHandle(
    ref,
    () => ({
      present: (r) => {
        setReq(r);
        setError(null);
        setBusy(null);
        const t = serverNow();
        if (r.mode === 'status') {
          const cur = notesStore.getState().myStatus;
          setEmoji(cur?.emoji ?? '');
          setText(cur?.text ?? '');
          setDurationMs(durationFor('status', cur ? cur.expires_at - t : null));
          setAudience(new Set());
        } else {
          const n = r.note ?? null;
          setEmoji(n?.emoji ?? '');
          setText(n?.text ?? '');
          setDurationMs(durationFor('place', n ? n.expires_at - t : null));
          setAudience(new Set(n?.visible_to ?? []));
        }
        sheet.current?.present();
      },
      dismiss: () => sheet.current?.dismiss(),
    }),
    [],
  );

  const presets = NOTE_PRESETS.filter((p) => p.kind === kind);
  const durations = noteDurationsFor(kind);
  const clean = sanitizeNoteText(text);
  const canSave = clean !== null && busy === null;

  const toggle = (uid: UserId) => {
    if (!audience.has(uid) && audience.size >= NOTE_LIMITS.maxAudience) {
      setError(`En çok ${NOTE_LIMITS.maxAudience} kişi seçebilirsin.`);
      return;
    }
    setAudience((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const save = async () => {
    if (!clean) {
      setError('Not boş olamaz.');
      return;
    }
    setError(null);
    const e = emoji.trim() ? emoji.trim() : null;
    if (req.mode === 'status') {
      notesStore.getState().setMyStatus({ emoji: e, text: clean, duration_ms: durationMs });
      sheet.current?.dismiss();
      return;
    }
    setBusy('saving');
    const r = await notesStore.getState().upsertPlace({
      note_id: req.note?.note_id ?? null,
      emoji: e,
      text: clean,
      position: req.position,
      visible_to: [...audience],
      duration_ms: durationMs,
    });
    setBusy(null);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    sheet.current?.dismiss();
    onPlaceSaved?.(r.note);
  };

  const remove = () => {
    if (req.mode === 'status') {
      notesStore.getState().clearMyStatus();
      sheet.current?.dismiss();
      return;
    }
    const n = req.note;
    if (!n) return;
    Alert.alert('Notu sil', 'Not haritadan kalkacak; gördüğü kişiler de artık göremez.', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          setBusy('deleting');
          const ok = await notesStore.getState().deletePlace(n.note_id);
          setBusy(null);
          if (!ok) {
            setError('Not silinemedi. Bağlantını kontrol edip tekrar dene.');
            return;
          }
          sheet.current?.dismiss();
          onPlaceDeleted?.(n.note_id);
        },
      },
    ]);
  };

  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );

  const title = kind === 'status' ? (editing ? 'Durum notunu düzenle' : 'Durum notu ekle') : editing ? 'Yer notunu düzenle' : 'Buraya not bırak';
  const subtitle =
    kind === 'status'
      ? 'Konumunu gören arkadaşların pininin altında görür. QR bağlantısı izleyicilerine gitmez.'
      : 'Haritadaki bu noktaya kısa not. Süre dolunca kendiliğinden silinir.';

  return (
    <BottomSheetModal
      ref={sheet}
      snapPoints={[kind === 'place' ? '92%' : '75%']}
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface }}
      handleIndicatorStyle={{ backgroundColor: colors.border }}
      keyboardBehavior="interactive"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, gap: spacing.md }} keyboardShouldPersistTaps="handled">
        <SheetHeader title={title} subtitle={subtitle} onClose={() => sheet.current?.dismiss()} />

        <View style={[styles.wrap, { paddingHorizontal: spacing.md, gap: spacing.xs }]} accessibilityLabel="Hazır notlar">
          {presets.map((p) => (
            <Chip
              key={p.id}
              label={`${p.emoji} ${p.text}`}
              selected={text === p.text && emoji === p.emoji}
              onPress={() => {
                setEmoji(p.emoji);
                setText(p.text);
                setError(null);
              }}
            />
          ))}
        </View>

        <View style={{ paddingHorizontal: spacing.md, gap: spacing.xxs }}>
          <View style={[styles.row, { gap: spacing.xs }]}>
            <BottomSheetTextInput
              value={emoji}
              onChangeText={(v) => setEmoji(v.slice(0, NOTE_LIMITS.maxEmojiChars))}
              placeholder="🙂"
              placeholderTextColor={colors.textSecondary}
              accessibilityLabel="Emoji (isteğe bağlı)"
              maxLength={NOTE_LIMITS.maxEmojiChars}
              style={[typography.heading, styles.emoji, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md }]}
            />
            <BottomSheetTextInput
              value={text}
              onChangeText={(v) => {
                setText(v);
                setError(null);
              }}
              placeholder={kind === 'status' ? 'Ne yapıyorsun?' : 'Bu noktaya not'}
              placeholderTextColor={colors.textSecondary}
              accessibilityLabel="Not metni"
              maxLength={NOTE_LIMITS.maxChars}
              returnKeyType="done"
              style={[typography.body, styles.text, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.sm }]}
            />
          </View>
          <Text variant="caption" color="textSecondary" align="right">
            {`${text.length}/${NOTE_LIMITS.maxChars}`}
          </Text>
        </View>

        <View style={{ gap: spacing.xs }}>
          <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
            Süre
          </Text>
          <View style={[styles.wrap, { paddingHorizontal: spacing.md, gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Notun süresi">
            {durations.map((d) => (
              <Chip key={d.id} label={d.label} selected={d.ms === durationMs} onPress={() => setDurationMs(d.ms)} />
            ))}
          </View>
        </View>

        {kind === 'place' ? (
          <View style={{ gap: spacing.xs }}>
            <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
              {`Kimler görsün${audience.size > 0 ? ` (${audience.size})` : ''}`}
            </Text>
            <View style={[styles.wrap, { paddingHorizontal: spacing.md }]}>
              <Chip label="Yalnızca ben" selected={audience.size === 0} onPress={() => setAudience(new Set())} accessibilityHint="Notu yalnızca sen görürsün" />
            </View>
            <RecipientPicker
              friends={friends}
              selected={audience}
              onToggle={toggle}
              access={(uid) => pickerRowAccess('note_audience', uid, can)}
              onAddFriend={() => {
                sheet.current?.dismiss();
                router.push('/friends');
              }}
            />
          </View>
        ) : null}

        <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }}>
          {error ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}
          <Button title={editing ? 'Kaydet' : kind === 'status' ? 'Notu ekle' : 'Notu bırak'} size="lg" onPress={() => void save()} disabled={!canSave} loading={busy === 'saving'} />
          {editing ? <Button title="Notu sil" variant="danger" onPress={remove} loading={busy === 'deleting'} disabled={busy === 'saving'} /> : null}
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center' },
  emoji: { width: 56, minHeight: MIN_TOUCH + 4, textAlign: 'center' },
  text: { flex: 1, minHeight: MIN_TOUCH + 4 },
});
