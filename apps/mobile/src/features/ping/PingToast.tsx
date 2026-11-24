/**
 * Faz 4: alıcı tarafı kayan ping kartı (ekranın üstünde): gönderenin adı + "📍 Buradayım" / "🚶 Yoldayım · yaklaşık
 * 12 dk içinde oradayım" (core `pingPushText`), "Haritada göster" ve kapat.
 *
 * Kapatmak yalnızca kartı gizler: ping kutuda ve (konum taşıyorsa) haritadaki geçici pinde süresi dolana kadar kalır
 * [Varsayım]. Kart `PING_TOAST_AUTO_HIDE_MS` sonra kendiliğinden gizlenir.
 */
import { formatAgo, pingPushText, type Ping, type UserId } from '@konum/core';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { usePingStore } from '../../state/pingStore';
import { Avatar, cardShadow, IconButton, Text, useTheme } from '../../ui';
import { PING_TOAST_AUTO_HIDE_MS, pingToastItem } from './pingModel';

export interface PingToastProps {
  names: Record<UserId, string>;
  /** "Haritada göster": göndereni (canlı pin ya da ping konumu) haritada ortala ve vurgula. */
  onShowOnMap: (p: Ping) => void;
}

const NATIVE_DRIVER = Platform.OS !== 'web';

export function PingToast({ names, onShowOnMap }: PingToastProps) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const inbox = usePingStore((s) => s.inbox);
  const now = useNow(5_000);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const item = pingToastItem(inbox, hidden, now);
  const slide = useRef(new Animated.Value(0)).current;
  const id = item?.ping_id ?? null;

  const hide = (pingId: string) => setHidden((prev) => new Set(prev).add(pingId));

  useEffect(() => {
    if (!id) return;
    slide.setValue(0);
    Animated.spring(slide, { toValue: 1, useNativeDriver: NATIVE_DRIVER, friction: 8 }).start();
    const t = setTimeout(() => hide(id), PING_TOAST_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [id, slide]);

  if (!item) return null;
  const name = names[item.from] ?? 'Arkadaşın';
  const text = pingPushText(name, item.kind, item.eta_s);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          top: insets.top + spacing.xs,
          paddingHorizontal: spacing.md,
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] }) }],
        },
      ]}
    >
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${text.title}: ${text.body}`}
        style={[styles.card, cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.sm, gap: spacing.sm, borderColor: colors.primary }]}
        testID="ping-toast"
      >
        <Avatar name={name} size={40} />
        <View style={styles.flex}>
          <Text variant="heading" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="label" numberOfLines={2}>
            {text.body}
          </Text>
          {/* Eylem metin sütununda: dar ekranda ad ("Ayşe Yılmaz") düğme yüzünden kesilmesin. */}
          <View style={styles.metaRow}>
            <Text variant="caption" color="textSecondary">
              {formatAgo(item.sent_at, now)}
            </Text>
            <Pressable
              onPress={() => {
                hide(item.ping_id);
                onShowOnMap(item);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${name} kişisini haritada göster`}
              hitSlop={4}
              style={({ pressed }) => [styles.show, { backgroundColor: pressed ? colors.primaryPressed : colors.primary, borderRadius: radius.pill, paddingHorizontal: spacing.sm }]}
            >
              <Text variant="label" style={{ color: colors.onPrimary }} numberOfLines={1}>
                Haritada göster
              </Text>
            </Pressable>
          </View>
        </View>
        <IconButton icon="close" size={32} accessibilityLabel="Bildirimi kapat" onPress={() => hide(item.ping_id)} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, zIndex: 30 },
  card: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5 },
  flex: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  show: { minHeight: 40, justifyContent: 'center' },
});
