/**
 * Özel süre: "Süre" (saat + dakika adımlayıcı) ya da "Bitiş saati" (saat:dakika) modu.
 * Doğrulama core `resolveDuration`'dan gelen `DurationError` mesajlarıyla yapılır
 * ("Süre en az 5 dakika olmalı", "7 günden uzun paylaşım için Haftalık veya Süresiz seçin" ...).
 */
import { DurationError, resolveDuration, type DurationChoice, type EpochMs } from '@konum/core';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Chip, IconButton, Text, useTheme } from '../../ui';

/** [Varsayım] Dakika adımı. */
const MINUTE_STEP = 5;
/** core üst sınırı 7 gün = 168 saat. */
const MAX_HOURS = 168;

type Mode = 'duration' | 'until';

export interface CustomDurationPickerProps {
  now: EpochMs;
  onChange: (choice: DurationChoice | null, error: string | null) => void;
}

/** Yerel duvar saati hh:mm'in bir sonraki gerçekleşmesi (geçtiyse yarın). */
export function nextOccurrence(hour: number, minute: number, deviceNow: Date = new Date()): EpochMs {
  const d = new Date(deviceNow.getTime());
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= deviceNow.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function validate(choice: DurationChoice, now: EpochMs): string | null {
  try {
    resolveDuration(choice, now);
    return null;
  } catch (e) {
    return e instanceof DurationError ? e.message : 'Süre geçersiz';
  }
}

export function CustomDurationPicker({ now, onChange }: CustomDurationPickerProps) {
  const { spacing } = useTheme();
  const [mode, setMode] = useState<Mode>('duration');
  // [Varsayım] Varsayılan özel süre 2 saat.
  const [hours, setHours] = useState(2);
  const [minutes, setMinutes] = useState(0);
  const initialUntil = useMemo(() => {
    const d = new Date(Date.now() + 2 * 3_600_000);
    return { h: d.getHours(), m: Math.ceil(d.getMinutes() / MINUTE_STEP) * MINUTE_STEP };
  }, []);
  const [untilH, setUntilH] = useState(initialUntil.h);
  const [untilM, setUntilM] = useState(initialUntil.m % 60);

  const choice: DurationChoice = useMemo(
    () =>
      mode === 'duration'
        ? { kind: 'custom_minutes', minutes: hours * 60 + minutes }
        : { kind: 'custom_until', until: nextOccurrence(untilH, untilM) },
    [mode, hours, minutes, untilH, untilM],
  );
  const error = validate(choice, now);

  useEffect(() => {
    onChange(error ? null : choice, error);
    // `now` her yenilendiğinde yeniden doğrula (bitiş saati geçmiş olabilir)
  }, [choice, error, onChange]);

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={[styles.row, { gap: spacing.xs }]}>
        <Chip label="Süre" selected={mode === 'duration'} onPress={() => setMode('duration')} style={styles.flex} />
        <Chip label="Bitiş saati" selected={mode === 'until'} onPress={() => setMode('until')} style={styles.flex} />
      </View>
      {mode === 'duration' ? (
        <View style={[styles.row, { gap: spacing.md }]}>
          <Stepper label="Saat" value={hours} display={String(hours)} onDec={() => setHours((h) => Math.max(0, h - 1))} onInc={() => setHours((h) => Math.min(MAX_HOURS, h + 1))} />
          <Stepper
            label="Dakika"
            value={minutes}
            display={String(minutes).padStart(2, '0')}
            onDec={() => setMinutes((m) => (m - MINUTE_STEP + 60) % 60)}
            onInc={() => setMinutes((m) => (m + MINUTE_STEP) % 60)}
          />
        </View>
      ) : (
        <View style={[styles.row, { gap: spacing.md }]}>
          <Stepper label="Saat" value={untilH} display={String(untilH).padStart(2, '0')} onDec={() => setUntilH((h) => (h + 23) % 24)} onInc={() => setUntilH((h) => (h + 1) % 24)} />
          <Stepper
            label="Dakika"
            value={untilM}
            display={String(untilM).padStart(2, '0')}
            onDec={() => setUntilM((m) => (m - MINUTE_STEP + 60) % 60)}
            onInc={() => setUntilM((m) => (m + MINUTE_STEP) % 60)}
          />
        </View>
      )}
      {error ? (
        <Text variant="label" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function Stepper({ label, display, onDec, onInc }: { label: string; value: number; display: string; onDec: () => void; onInc: () => void }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={[styles.flex, { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.xs }]}>
      <Text variant="caption" color="textSecondary" align="center">
        {label}
      </Text>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <IconButton icon="minus" accessibilityLabel={`${label} azalt`} onPress={onDec} />
        <Text variant="title" accessibilityLabel={`${label}: ${display}`}>
          {display}
        </Text>
        <IconButton icon="plus" accessibilityLabel={`${label} artır`} onPress={onInc} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
