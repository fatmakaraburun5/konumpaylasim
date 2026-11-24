/**
 * Giden bağlantı (QR) paylaşımı kartı: başlık, kalan süre (core `formatExpiryLabel`), "QR'ı göster",
 * "Durdur". Faz 1 `ActiveShareCard` ile aynı dil; uzatma QR sayfasında ve "bitmek üzere" afişinde.
 */
import type { EpochMs } from '@konum/core';
import { StyleSheet, View } from 'react-native';
import type { LinkSession } from '../../state/linkStore';
import { Button, cardShadow, Icon, Text, useTheme } from '../../ui';
import { LINK_TITLE, linkSubtitle } from '../link/linkText';
import { ProgressRing } from './ProgressRing';

export interface ActiveLinkCardProps {
  link: LinkSession;
  now: EpochMs;
  onShowQr: () => void;
  onStop: () => void;
  onDismiss: () => void;
}

export function ActiveLinkCard({ link: l, now, onShowQr, onStop, onDismiss }: ActiveLinkCardProps) {
  const { colors, spacing, radius } = useTheme();
  const finished = l.phase === 'ended';
  const total = l.expires_at === null ? null : l.expires_at - l.started_at;
  const progress = total && l.expires_at !== null ? (l.expires_at - now) / total : 1;
  const ringColor = l.phase === 'expiring_soon' ? colors.warning : finished ? colors.stale : colors.live;

  return (
    <View style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.sm }]}>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <ProgressRing progress={progress} color={ringColor} />
        <View style={styles.flex}>
          <View style={[styles.row, { gap: spacing.xxs }]}>
            <Icon name="qr" size={16} color={colors.textSecondary} />
            <Text variant="heading" accessibilityRole="header" accessibilityLiveRegion="polite">
              {LINK_TITLE[l.phase]}
            </Text>
          </View>
          <Text variant="label" color="textSecondary">
            {linkSubtitle(l, now)}
          </Text>
        </View>
      </View>
      {l.error && !finished ? (
        <Text variant="label" color="danger">
          {l.error.message}
        </Text>
      ) : null}
      {finished ? (
        <Button title="Kapat" variant="secondary" onPress={onDismiss} />
      ) : (
        <View style={[styles.row, { gap: spacing.xs }]}>
          <Button title="QR'ı göster" variant="secondary" block={false} style={styles.flex} onPress={onShowQr} disabled={l.phase === 'stopping'} />
          <Button
            title={l.phase === 'stopping' && l.error ? 'Tekrar dene' : 'Durdur'}
            variant="danger"
            block={false}
            style={styles.flex}
            disabled={l.phase === 'stopping' && !l.error}
            loading={l.phase === 'stopping' && !l.error}
            onPress={onStop}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
