/**
 * Faz 4: alıcı tam ekran kartı kapattıktan sonra haritanın üstünde kalan kırmızı şerit: "ACİL: Ayşe tehlikede ·
 * 2 dk önce". Dokun → kart yeniden açılır (`sosStore.focus`). Yalnızca aktif uyarılar; en yeni üstte.
 */
import { formatAgo, isSosActive, sosPushText, type EpochMs, type SosAlert } from '@konum/core';
import { Pressable, StyleSheet, View } from 'react-native';
import { sosStore } from '../../state/sosStore';
import { lightColors, MIN_TOUCH, Text, useTheme } from '../../ui';
import { SOS_FG } from './sosModel';

export function SosIncomingBanner({ alerts, now }: { alerts: readonly SosAlert[]; now: EpochMs }) {
  const { radius, spacing } = useTheme();
  const active = alerts.filter(isSosActive);
  if (active.length === 0) return null;
  return (
    <View style={{ paddingHorizontal: spacing.md, gap: spacing.xxs }} pointerEvents="box-none">
      {active.map((a) => (
        <Pressable
          key={a.sos_id}
          onPress={() => sosStore.getState().focus(a.sos_id)}
          accessibilityRole="alert"
          accessibilityLabel={`${sosPushText(a).title}, ${formatAgo(a.created_at, now)}. Ayrıntılar için dokun.`}
          testID={`sos-banner-${a.sos_id}`}
          style={({ pressed }) => [
            styles.card,
            { backgroundColor: pressed ? lightColors.text : lightColors.danger, borderRadius: radius.md, paddingHorizontal: spacing.sm, gap: spacing.xs },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: SOS_FG }]} />
          <Text variant="heading" style={[styles.fg, styles.flex]} numberOfLines={1}>
            {/* Faz 9: Güvenli Dönüş alarmı kendi başlığıyla ("ACİL: Ayşe Güvenli Dönüş'te yanıt vermedi"). */}
            {sosPushText(a).title}
          </Text>
          <Text variant="label" style={styles.fg}>
            {formatAgo(a.created_at, now)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH + 4, boxShadow: '0px 6px 18px rgba(185, 28, 28, 0.4)' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  fg: { color: SOS_FG },
  flex: { flex: 1 },
});
