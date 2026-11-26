/**
 * Faz 7: etkinliğin mekan (1–3) ve saat (1–4) seçenek alanları. "Etkinlik oluştur" ekranı ve düzenleyenin
 * "Seçenekleri düzenle" kartı aynı alanları kullanır. Sınırlar core `EVENT_LIMITS` ile aynı ölçüyle (kod noktası)
 * denetlenir; sunucu ayrıca doğrular.
 */
import { EVENT_LIMITS, eventTextLength, formatMinuteOfDay, parseClock, uuidV4, type EventVenueOption } from '@konum/core';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { EventVenueInput } from '../../state/eventsStore';
import { Button, Chip, IconButton, Text, useTheme } from '../../ui';
import { TIME_PRESETS, toggleMinute } from './eventModel';

export interface VenueDraft {
  key: string;
  name: string;
  address: string;
}

export const newVenueDraft = (name = '', address = ''): VenueDraft => ({ key: uuidV4(), name, address });

export const venueDraftsFrom = (options: readonly EventVenueOption[]): VenueDraft[] => options.map((o) => newVenueDraft(o.name, o.address ?? ''));

/** Doldurulmuş mekanlar → istek girdisi (boş satırlar atılır). */
export const venueInputs = (venues: readonly VenueDraft[]): EventVenueInput[] =>
  venues
    .filter((v) => v.name.trim().length > 0)
    .map((v) => ({ name: v.name.trim(), address: v.address.trim() ? v.address.trim() : null, location: null, place_id: null }));

/** Seçenekler gönderilebilir mi; değilse kullanıcıya gösterilecek neden. */
export function optionsProblem(venues: readonly VenueDraft[], minutes: readonly number[]): string | null {
  const filled = venues.filter((v) => v.name.trim().length > 0);
  if (venues.some((v) => eventTextLength(v.name.trim()) > EVENT_LIMITS.venueNameMaxChars)) return `Mekan adı en çok ${EVENT_LIMITS.venueNameMaxChars} karakter olabilir.`;
  if (venues.some((v) => eventTextLength(v.address.trim()) > EVENT_LIMITS.venueAddressMaxChars)) return `Adres en çok ${EVENT_LIMITS.venueAddressMaxChars} karakter olabilir.`;
  if (filled.length < EVENT_LIMITS.minVenueOptions) return 'En az bir mekan yaz.';
  const names = filled.map((v) => v.name.trim().toLocaleLowerCase('tr'));
  if (new Set(names).size !== names.length) return 'Aynı mekanı iki kez yazdın.';
  if (minutes.length < EVENT_LIMITS.minTimeOptions) return 'En az bir saat seç.';
  return null;
}

export function VenueFields({ venues, onChange }: { venues: VenueDraft[]; onChange: (next: VenueDraft[]) => void }) {
  const { colors, radius, spacing, typography } = useTheme();
  const inputStyle = [typography.body, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }];
  const set = (key: string, patch: Partial<VenueDraft>) => onChange(venues.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  return (
    <View style={{ gap: spacing.sm }}>
      {venues.map((v, i) => (
        <View key={v.key} style={[styles.venue, { gap: spacing.xs, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm }]}>
          <View style={[styles.row, { gap: spacing.xs }]}>
            <TextInput
              value={v.name}
              onChangeText={(name) => set(v.key, { name })}
              placeholder={i === 0 ? 'Mekan adı (ör. Moda Kahve)' : `Mekan ${i + 1} adı`}
              placeholderTextColor={colors.textSecondary}
              accessibilityLabel={`Mekan ${i + 1} adı`}
              maxLength={EVENT_LIMITS.venueNameMaxChars * 2}
              style={[inputStyle, styles.flex]}
              testID={`event-venue-name-${i}`}
            />
            {venues.length > 1 ? (
              <IconButton icon="close" accessibilityLabel={`Mekan ${i + 1} seçeneğini kaldır`} onPress={() => onChange(venues.filter((x) => x.key !== v.key))} />
            ) : null}
          </View>
          <TextInput
            value={v.address}
            onChangeText={(address) => set(v.key, { address })}
            placeholder="Adres ya da semt (isteğe bağlı)"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel={`Mekan ${i + 1} adresi`}
            maxLength={EVENT_LIMITS.venueAddressMaxChars * 2}
            style={inputStyle}
            testID={`event-venue-address-${i}`}
          />
        </View>
      ))}
      {venues.length < EVENT_LIMITS.maxVenueOptions ? (
        <Button title="Başka mekan ekle" variant="secondary" onPress={() => onChange([...venues, newVenueDraft()])} testID="event-venue-add" />
      ) : null}
    </View>
  );
}

export function TimeFields({ minutes, onChange }: { minutes: number[]; onChange: (next: number[]) => void }) {
  const { colors, radius, spacing, typography } = useTheme();
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const full = minutes.length >= EVENT_LIMITS.maxTimeOptions;
  const add = () => {
    const m = parseClock(custom);
    if (m === null) {
      setErr('Saati 19:30 biçiminde yaz.');
      return;
    }
    onChange(toggleMinute(minutes.filter((x) => x !== m), m));
    setCustom('');
    setErr(null);
  };
  return (
    <View style={{ gap: spacing.sm }}>
      <View style={[styles.wrap, { gap: spacing.xs }]}>
        {[...new Set([...TIME_PRESETS, ...minutes])]
          .sort((a, b) => a - b)
          .map((m) => {
            const selected = minutes.includes(m);
            return (
              <Chip
                key={m}
                label={formatMinuteOfDay(m)}
                selected={selected}
                disabled={!selected && full}
                onPress={() => onChange(toggleMinute(minutes, m))}
                testID={`event-time-${m}`}
              />
            );
          })}
      </View>
      <View style={[styles.row, { gap: spacing.xs }]}>
        <TextInput
          value={custom}
          onChangeText={setCustom}
          placeholder="Başka saat: 17:45"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Başka saat"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          onSubmitEditing={add}
          style={[typography.body, styles.input, styles.flex, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
          testID="event-time-custom"
        />
        <Button title="Ekle" variant="secondary" block={false} onPress={add} disabled={!custom.trim() || full} />
      </View>
      {err ? (
        <Text variant="caption" color="danger">
          {err}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  input: { minHeight: 44, paddingVertical: 10 },
  venue: { borderWidth: StyleSheet.hairlineWidth },
});
