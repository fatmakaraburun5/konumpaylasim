import { EXTENSION_STEPS, formatRemaining, type EpochMs, type ExtensionMinutes } from '@konum/core';
import { StyleSheet, View } from 'react-native';
import { Chip, Text, useTheme } from '../../ui';

export interface ExpiryBannerProps {
  /** Faz 1 `ShareSession` ya da Faz 2 bağlantı (`LinkSession`): yalnızca evre ve bitiş okunur. */
  session: { phase: string; expires_at: EpochMs | null };
  now: EpochMs;
  onExtend: (minutes: ExtensionMinutes) => void;
  /** Bitiş metninin öznesi; varsayılan "Paylaşımın" (bağlantı için "QR bağlantın"). */
  subject?: string;
}

/** "Süre dolmak üzere" (phase = expiring_soon): tek dokunuşla +30 dk / +1 saat. */
export function ExpiryBanner({ session, now, onExtend, subject = 'Paylaşımın' }: ExpiryBannerProps) {
  const { colors, spacing, radius } = useTheme();
  if (session.phase !== 'expiring_soon' || session.expires_at === null) return null;
  const left = formatRemaining(session.expires_at - now);
  return (
    <View
      accessibilityRole="alert"
      style={[styles.wrap, { backgroundColor: colors.warningSoft, borderColor: colors.warning, borderRadius: radius.lg, padding: spacing.sm, gap: spacing.xs }]}
    >
      <Text variant="label" style={{ color: colors.warning }}>
        {`${subject} ${left} içinde bitiyor`}
      </Text>
      <View style={[styles.row, { gap: spacing.xs }]}>
        {EXTENSION_STEPS.map((s) => (
          <Chip key={s.minutes} label={s.label} tone="warning" onPress={() => onExtend(s.minutes)} style={styles.flex} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: 1 },
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
});
