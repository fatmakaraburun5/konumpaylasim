/**
 * Süre seçimi: core `DURATION_OPTIONS` (bağlantı/QR için `LINK_DURATION_OPTIONS`: özel süre yok).
 * Kısa grup 2 sütunlu çip ızgarası, uzun grup altında.
 * Önizleme satırı core `resolveDuration` + `formatExpiryLabel` ile (ör. "17:45'e kadar · 1 sa kaldı").
 * Süresiz seçimi onay ister.
 */
import {
  DURATION_OPTIONS,
  DurationError,
  formatExpiryLabel,
  resolveDuration,
  type DurationChoice,
  type DurationOption,
  type EpochMs,
} from '@konum/core';
import { useCallback, useMemo } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { fixUntilSuffix } from '../../lib/turkish';
import { Chip, Icon, Text, useTheme } from '../../ui';
import { CustomDurationPicker } from './CustomDurationPicker';

export interface DurationSelection {
  optionId: DurationOption['id'] | null;
  /** Geçerli seçim; özel süre geçersizse null. */
  choice: DurationChoice | null;
  error: string | null;
}

export const EMPTY_DURATION: DurationSelection = { optionId: null, choice: null, error: null };

export interface DurationPickerProps {
  value: DurationSelection;
  onChange: (next: DurationSelection) => void;
  now: EpochMs;
  /** Gösterilecek seçenekler; varsayılan core `DURATION_OPTIONS`. */
  options?: readonly DurationOption[];
  /** "Süresiz" onay metni (bağlantıda alıcı "bağlantıya sahip herkes"tir). */
  foreverConfirmText?: string;
}

const DEFAULT_FOREVER_TEXT =
  'Konumun, sen durdurana kadar seçtiğin kişilerle paylaşılacak. Haftada bir hatırlatma alırsın. Emin misin?';

/** Önizleme metni (seçim yoksa null). */
export function previewLabel(choice: DurationChoice | null, now: EpochMs): string | null {
  if (!choice) return null;
  try {
    const resolved = resolveDuration(choice, now);
    if (resolved.expires_at === null) return 'Süresiz · sen durdurana kadar paylaşılacak';
    return `${fixUntilSuffix(formatExpiryLabel(resolved, now))}`;
  } catch (e) {
    return e instanceof DurationError ? e.message : null;
  }
}

export function DurationPicker({ value, onChange, now, options = DURATION_OPTIONS, foreverConfirmText = DEFAULT_FOREVER_TEXT }: DurationPickerProps) {
  const { colors, spacing } = useTheme();
  const short = useMemo(() => options.filter((o) => o.group === 'short'), [options]);
  const long = useMemo(() => options.filter((o) => o.group === 'long'), [options]);

  const select = (o: DurationOption) => {
    if (o.id === 'custom') {
      onChange({ optionId: 'custom', choice: null, error: null });
      return;
    }
    if (o.id === 'forever' && value.optionId !== 'forever') {
      Alert.alert(
        'Süresiz paylaşım',
        foreverConfirmText,
        [
          { text: 'Vazgeç', style: 'cancel' },
          { text: 'Süresiz paylaş', onPress: () => onChange({ optionId: o.id, choice: o.choice, error: null }) },
        ],
      );
      return;
    }
    onChange({ optionId: o.id, choice: o.choice, error: null });
  };

  const onCustom = useCallback(
    (choice: DurationChoice | null, error: string | null) => onChange({ optionId: 'custom', choice, error }),
    [onChange],
  );

  const preview = value.error ? null : previewLabel(value.choice, now);

  return (
    <View style={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
      <View style={styles.grid}>
        {short.map((o) => (
          <View key={o.id} style={styles.cell}>
            <Chip label={o.label} selected={value.optionId === o.id} onPress={() => select(o)} />
          </View>
        ))}
      </View>
      {value.optionId === 'custom' ? <CustomDurationPicker now={now} onChange={onCustom} /> : null}
      <Text variant="caption" color="textSecondary">
        Uzun süreli
      </Text>
      <View style={styles.grid}>
        {long.map((o) => (
          <View key={o.id} style={styles.cell}>
            <Chip label={o.label} selected={value.optionId === o.id} onPress={() => select(o)} />
          </View>
        ))}
      </View>
      {preview ? (
        <View style={[styles.preview, { gap: spacing.xs }]} accessibilityLiveRegion="polite">
          <Icon name="clock" color={colors.textSecondary} size={16} />
          <Text variant="label" color="textSecondary">
            {preview}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  cell: { width: '50%', padding: 4 },
  preview: { flexDirection: 'row', alignItems: 'center' },
});
