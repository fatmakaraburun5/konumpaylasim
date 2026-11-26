/**
 * Faz 9: Güvenli Dönüş son uyarısı (tam ekran, her ekranın üstünde; (main) yerleşiminde bağlı) — docs/PHASE9.md §3.1.
 *
 *   "Güvende misin?" · büyük geri sayım (grace_until'e) · "120 sn içinde 'Güvendeyim' demezsen Annem son konumunla
 *   ve pil durumunla uyarılacak."
 *   "Güvendeyim" · "Vardım" · "+15 dk" (3 saat sınırı)
 *   internet yoksa: core `SAFE_RETURN_TEXT.offlineHint` + "SMS ile gönder (N kişi)" ("Güvenli Dönüş: Ev hedefine
 *   varamadım" satırıyla; OfflineSosPanel)
 *
 * Süre dolunca alarmı SUNUCU açar (uygulama kapalı olsa da); bu ekran yalnızca hatırlatır. Görünürlük
 * `safeReturnStore.phase === 'final_warning'`.
 */
import { SAFE_RETURN_TEXT } from '@konum/core';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { formatContactNames } from '../../services/notifications/safeReturnNotifications';
import { useFriendNames } from '../../state/friendsStore';
import { canExtendSafeReturn, safeReturnStore, useSafeReturnStore } from '../../state/safeReturnStore';
import { sosStore } from '../../state/sosStore';
import { lightColors, Overlay, Text, useTheme } from '../../ui';
import { OfflineSosPanel } from '../sms/OfflineSosPanel';
import { BigButton } from '../sos/BigButton';
import { SOS_FG } from '../sos/sosModel';
import { formatCountdown } from './safeReturnModel';

export function FinalWarning() {
  const phase = useSafeReturnStore((s) => s.phase);
  const visible = phase === 'final_warning';
  return (
    <Overlay visible={visible} testID="safe-return-final-warning">
      {visible ? <FinalWarningBody /> : null}
    </Overlay>
  );
}

function FinalWarningBody() {
  const { spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const current = useSafeReturnStore((s) => s.current);
  const leftMs = useSafeReturnStore((s) => s.leftMs);
  const busy = useSafeReturnStore((s) => s.busy);
  const error = useSafeReturnStore((s) => s.error);
  const names = useFriendNames();
  const now = useNow(5_000);
  // Çevrimdışı kararı açılışta ve birkaç saniyede bir yeniden okunur (RTDB bağlantısı).
  const [offline, setOffline] = useState(() => sosStore.getState().offlineDecisionNow());
  useEffect(() => {
    setOffline(sosStore.getState().offlineDecisionNow());
  }, [now]);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(`${SAFE_RETURN_TEXT.finalWarningTitle} Güvendeysen Güvendeyim düğmesine dokun.`);
  }, []);

  if (!current) return null;
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  const who = formatContactNames(current.contact_ids.map((id) => names[id] ?? null));
  const canExtend = canExtendSafeReturn(current, now);
  const act = (fn: () => Promise<unknown>) => () => {
    safeReturnStore.getState().clearError();
    void fn();
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Text variant="title" style={styles.fg} accessibilityRole="header">
            {SAFE_RETURN_TEXT.finalWarningTitle}
          </Text>
          <Text variant="body" style={styles.fgSoft}>
            {`${SAFE_RETURN_TEXT.title} · ${current.destination.name}`}
          </Text>
        </View>

        <View style={styles.center} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${seconds} saniye kaldı`}>
          <Text style={[styles.fg, styles.big]} maxFontSizeMultiplier={1} testID="safe-return-final-left">
            {formatCountdown(leftMs)}
          </Text>
          <Text variant="heading" style={[styles.fg, { textAlign: 'center' }]}>
            {SAFE_RETURN_TEXT.finalWarningBody(seconds, who)}
          </Text>
        </View>

        {error ? (
          <Text variant="label" style={[styles.fg, { textAlign: 'center', fontWeight: '700' }]} accessibilityLiveRegion="assertive">
            {error.message}
          </Text>
        ) : null}

        {offline !== 'online' ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="label" style={styles.fgSoft}>
              {SAFE_RETURN_TEXT.offlineHint}
            </Text>
            <OfflineSosPanel decision={offline} safeReturnDest={current.destination.name} />
          </View>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <BigButton title={busy === 'check_in' ? 'Bildiriliyor…' : SAFE_RETURN_TEXT.checkIn} onPress={act(() => safeReturnStore.getState().checkIn('safe'))} solid disabled={busy !== null} />
          <View style={[styles.row, { gap: spacing.sm }]}>
            <View style={styles.flex}>
              <BigButton title={SAFE_RETURN_TEXT.arrived} onPress={act(() => safeReturnStore.getState().checkIn('arrived'))} disabled={busy !== null} small />
            </View>
            {canExtend ? (
              <View style={styles.flex}>
                <BigButton title={busy === 'extend' ? 'Uzatılıyor…' : SAFE_RETURN_TEXT.extend} onPress={act(() => safeReturnStore.getState().extend())} disabled={busy !== null} small />
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: lightColors.danger },
  fg: { color: SOS_FG },
  fgSoft: { color: 'rgba(255,255,255,0.88)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  big: { fontSize: 88, lineHeight: 100, fontWeight: '800', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
