/**
 * Faz 9: harita üst şeridinde Güvenli Dönüş bandı (44 pt, görünmez şeridi deseni) — docs/PHASE9.md §3.1.
 *
 *   🛡 "Güvenli Dönüş · Ev · 12:05" (son 5 dk turuncu, son uyarı / alarm kırmızı) · "Güvendeyim" · "+15 dk"
 *   dokun → Güvenli Dönüş ekranı (Vardım, iptal, kişiler)
 *   bitince kısa bilgi: "Hedefine vardın, kişilerine bildirildi." (kapat)
 *
 * Geri sayım `safeReturnStore.leftMs` (f9Services öndeyken saniyede bir `tick`).
 */
import { SAFE_RETURN_TEXT } from '@konum/core';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useNow } from '../../lib/useNow';
import { SAFE_RETURN_ROUTE } from '../../services/f9Services';
import { canExtendSafeReturn, safeReturnStore, useSafeReturnStore } from '../../state/safeReturnStore';
import { cardShadow, Icon, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { isSafeReturnLive, safeReturnBannerText } from './safeReturnModel';
import { useSafeReturnPhase } from './useSafeReturnPhase';

export const SAFE_RETURN_BANNER_HEIGHT = MIN_TOUCH;

const ENDED_SHOW_MS = 8_000;

/** Bandın görünüp görünmediği (harita üst dolgusu için). */
export function useSafeReturnBannerVisible(): boolean {
  const phase = useSafeReturnPhase();
  const ended = useSafeReturnStore((s) => s.ended);
  return isSafeReturnLive(phase) || (ended !== null && ended.reason !== 'alarm');
}

export function SafeReturnBanner() {
  const { colors, radius, spacing } = useTheme();
  const router = useRouter();
  const current = useSafeReturnStore((s) => s.current);
  const phase = useSafeReturnPhase();
  const leftMs = useSafeReturnStore((s) => s.leftMs);
  const busy = useSafeReturnStore((s) => s.busy);
  const ended = useSafeReturnStore((s) => s.ended);
  const now = useNow(5_000);

  useEffect(() => {
    if (!ended || isSafeReturnLive(phase)) return;
    const t = setTimeout(() => safeReturnStore.getState().dismissEnded(), ENDED_SHOW_MS);
    return () => clearTimeout(t);
  }, [ended, phase]);

  if (!isSafeReturnLive(phase) || !current) {
    if (!ended || ended.reason === 'alarm') return null;
    return (
      <View
        testID="safe-return-ended"
        accessibilityRole="alert"
        style={[styles.bar, cardShadow, { marginHorizontal: spacing.md, backgroundColor: colors.liveSoft, borderColor: colors.live, borderRadius: radius.pill, paddingLeft: spacing.sm, gap: spacing.xs }]}
      >
        <Icon name="shield" size={18} color={colors.live} />
        <Text variant="label" style={[styles.flex, styles.text, { color: colors.live }]} numberOfLines={2}>
          {SAFE_RETURN_TEXT.ended[ended.reason]}
        </Text>
        <IconButton icon="close" accessibilityLabel="Kapat" onPress={() => safeReturnStore.getState().dismissEnded()} size={32} />
      </View>
    );
  }

  const danger = phase === 'final_warning' || phase === 'alarm';
  const tone = danger ? colors.danger : phase === 'ending_soon' ? colors.warning : colors.primary;
  const text = safeReturnBannerText(phase, current.destination.name, leftMs);
  const canExtend = phase !== 'alarm' && canExtendSafeReturn(current, now);

  return (
    <View
      testID="safe-return-banner"
      style={[styles.bar, cardShadow, { marginHorizontal: spacing.md, backgroundColor: colors.surface, borderColor: tone, borderRadius: radius.pill, paddingLeft: spacing.sm, gap: spacing.xs }]}
    >
      <Pressable
        onPress={() => router.push(SAFE_RETURN_ROUTE)}
        accessibilityRole="button"
        accessibilityLabel={`${text}. Ayrıntılar için dokun.`}
        style={[styles.row, styles.flex, { gap: spacing.xs }]}
      >
        <Icon name="shield" size={18} color={tone} />
        <Text variant="label" style={[styles.flex, styles.text, { color: danger ? colors.danger : colors.text }]} numberOfLines={2} accessibilityLiveRegion="polite">
          {text}
        </Text>
      </Pressable>
      <Pressable
        testID="safe-return-banner-ok"
        accessibilityRole="button"
        accessibilityLabel={SAFE_RETURN_TEXT.checkIn}
        onPress={() => void safeReturnStore.getState().checkIn('safe')}
        disabled={busy !== null}
        hitSlop={6}
        style={({ pressed }) => [styles.action, { backgroundColor: pressed ? colors.primaryPressed : colors.live, borderRadius: radius.pill, paddingHorizontal: spacing.sm, opacity: busy ? 0.6 : 1 }]}
      >
        <Text variant="label" style={{ color: colors.onPrimary }} numberOfLines={1}>
          {SAFE_RETURN_TEXT.checkIn}
        </Text>
      </Pressable>
      {canExtend ? (
        <Pressable
          testID="safe-return-banner-extend"
          accessibilityRole="button"
          accessibilityLabel="Süreyi 15 dakika uzat"
          onPress={() => void safeReturnStore.getState().extend()}
          disabled={busy !== null}
          hitSlop={6}
          style={({ pressed }) => [styles.action, { backgroundColor: pressed ? colors.border : colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: spacing.sm }]}
        >
          <Text variant="label" numberOfLines={1}>
            {SAFE_RETURN_TEXT.extend}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', height: SAFE_RETURN_BANNER_HEIGHT, borderWidth: 1.5, paddingRight: 6 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  text: { lineHeight: 16 },
  action: { height: 32, justifyContent: 'center' },
});
