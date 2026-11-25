/**
 * Giden paylaşım kartı: alıcı avatarları, core `formatExpiryLabel`, kalan süre halkası,
 * "Süreyi uzat" (+30 dk / +1 saat) ve "Durdur". Oturum evresine göre metin değişir.
 */
import {
  END_REASON_TEXT,
  EXTENSION_STEPS,
  formatExpiryLabel,
  type EpochMs,
  type ExtensionMinutes,
  type ShareSession,
  type UserId,
} from '@konum/core';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { fixUntilSuffix } from '../../lib/turkish';
import { Button, cardShadow, Chip, Text, useTheme } from '../../ui';
import { FriendAvatar } from '../profile/FriendAvatar';
import { ProgressRing } from './ProgressRing';

export interface ActiveShareCardProps {
  session: ShareSession;
  names: Record<UserId, string>;
  now: EpochMs;
  trackingError: string | null;
  onExtend: (minutes: ExtensionMinutes) => void;
  onStop: () => void;
  onDismiss: () => void;
}

const TITLE: Record<ShareSession['phase'], string> = {
  starting: 'Paylaşım başlatılıyor…',
  active: 'Konumun paylaşılıyor',
  expiring_soon: 'Konumun paylaşılıyor',
  extending: 'Süre uzatılıyor…',
  stopping: 'Paylaşım durduruluyor…',
  ended: 'Paylaşım sona erdi',
  failed: 'Paylaşım başlatılamadı',
};

const listNames = (ids: readonly UserId[], names: Record<UserId, string>) => ids.map((id) => names[id] ?? 'Arkadaş').join(', ');

export function ActiveShareCard({ session, names, now, trackingError, onExtend, onStop, onDismiss }: ActiveShareCardProps) {
  const { colors, spacing, radius } = useTheme();
  const [showExtend, setShowExtend] = useState(false);
  const s = session;
  const running = s.phase === 'active' || s.phase === 'expiring_soon' || s.phase === 'extending';
  const finished = s.phase === 'ended' || s.phase === 'failed';
  const canExtend = (s.phase === 'active' || s.phase === 'expiring_soon') && s.expires_at !== null;

  const total = s.expires_at === null ? null : s.expires_at - s.started_at;
  const progress = total && s.expires_at !== null ? (s.expires_at - now) / total : 1;
  const ringColor = s.phase === 'expiring_soon' ? colors.warning : finished ? colors.stale : colors.live;

  const subtitle =
    s.phase === 'ended'
      ? END_REASON_TEXT[s.end_reason ?? 'stopped_by_sender']
      : s.phase === 'failed'
        ? (s.error?.message ?? 'Bir şeyler ters gitti')
        : fixUntilSuffix(formatExpiryLabel(s, now));

  const receivers = finished && s.active_receiver_ids.length === 0 ? s.ended_receivers.map((e) => e.receiver_id) : s.active_receiver_ids;
  const partiallyEnded = !finished ? s.ended_receivers.filter((e) => e.reason !== 'expired') : [];

  return (
    <View style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.sm }]}>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <ProgressRing progress={progress} color={ringColor} />
        <View style={styles.flex}>
          {/* Canlı bölge yalnızca evre değişince duyurulur (başlık); geri sayım her saniye değiştiği için alt metin canlı bölge DEĞİL. */}
          <Text variant="heading" accessibilityRole="header" accessibilityLiveRegion="polite">
            {TITLE[s.phase]}
          </Text>
          <Text variant="label" color={s.phase === 'failed' ? 'danger' : 'textSecondary'}>
            {subtitle}
          </Text>
        </View>
      </View>

      {receivers.length > 0 ? (
        <View style={[styles.row, { gap: spacing.xs }]}>
          <View style={styles.row}>
            {receivers.slice(0, 4).map((id, i) => (
              <View key={id} style={{ marginLeft: i === 0 ? 0 : -10 }}>
                <FriendAvatar uid={id} fallbackName={names[id] ?? 'Arkadaş'} size={28} />
              </View>
            ))}
          </View>
          <Text variant="label" color="textSecondary" numberOfLines={1} style={styles.flex}>
            {listNames(receivers, names)}
          </Text>
        </View>
      ) : null}

      {partiallyEnded.length > 0 ? (
        <Text variant="caption" color="textSecondary">
          {partiallyEnded.map((e) => `${names[e.receiver_id] ?? 'Arkadaş'}: ${END_REASON_TEXT[e.reason]}`).join(' · ')}
        </Text>
      ) : null}

      {trackingError && running ? (
        <Text variant="label" style={{ color: colors.warning }}>
          {trackingError}
        </Text>
      ) : null}
      {s.error && !finished ? (
        <Text variant="label" color="danger">
          {s.error.message}
        </Text>
      ) : null}

      {showExtend && canExtend ? (
        <View style={[styles.row, { gap: spacing.xs }]}>
          {EXTENSION_STEPS.map((step) => (
            <Chip
              key={step.minutes}
              label={step.label}
              onPress={() => {
                setShowExtend(false);
                onExtend(step.minutes);
              }}
              style={styles.flex}
            />
          ))}
        </View>
      ) : null}

      {finished ? (
        <Button title="Kapat" variant="secondary" onPress={onDismiss} />
      ) : (
        <View style={[styles.row, { gap: spacing.xs }]}>
          {s.expires_at !== null ? (
            <Button
              title="Süreyi uzat"
              variant="secondary"
              block={false}
              style={styles.flex}
              disabled={!canExtend}
              loading={s.phase === 'extending'}
              onPress={() => setShowExtend((v) => !v)}
            />
          ) : null}
          <Button
            title={s.phase === 'stopping' && s.error ? 'Tekrar dene' : 'Durdur'}
            variant="danger"
            block={false}
            style={styles.flex}
            disabled={s.phase === 'starting' || (s.phase === 'stopping' && !s.error)}
            loading={s.phase === 'stopping' && !s.error}
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
