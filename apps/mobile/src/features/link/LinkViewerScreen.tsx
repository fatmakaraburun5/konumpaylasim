/**
 * QR / bağlantıyla açılan salt okunur canlı harita (app/s/[token].tsx). Oturum GEREKMEZ.
 *
 *   LinkViewerScreen
 *   ├─ LinkViewerMap (yerel Google Maps; pin yumuşak kayar, kamera izler)
 *   ├─ üst çubuk: Kapat
 *   └─ alt kart: ad · tazelik (core `freshness`/`FRESHNESS_TEXT`) · "HH:MM'e kadar" · Ortala
 *        ya da durum: "Konum yükleniyor…" / "Paylaşan kişinin konumu bekleniyor" / "Paylaşım sona erdi" / "Bağlantı geçersiz"
 *
 * Token cihazda özetlenir ve yalnızca `link_live/{hash}` dinlenir. Paylaşan kişi durdurunca sunucu düğümü siler:
 * dinleyici aynı anda null alır, pin kalkar ve "Paylaşım sona erdi" görünür (2 sn içinde kabul ölçütü).
 * Süre dolumu ayrıca yerelde saniyelik saatle de yakalanır (`expires_at` geçince pin kalkar).
 * Hiçbir şey diske yazılmaz; token kayıt altına alınmaz.
 */
import { useBottomSheetModal } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { linkDomains } from '../../lib/linkConfig';
import { useNow } from '../../lib/useNow';
import { Avatar, Button, cardShadow, IconButton, Text, useTheme } from '../../ui';
import { resolveLinkParam, linkViewerModel } from './linkViewerModel';
import { LinkViewerMap, type LinkViewerMapHandle } from './LinkViewerMap';
import { useLinkLive } from './useLinkLive';

export function LinkViewerScreen({ rawToken }: { rawToken: string | string[] | undefined }) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const map = useRef<LinkViewerMapHandle>(null);
  const resolved = useMemo(() => resolveLinkParam(rawToken, linkDomains()), [rawToken]);
  const live = useLinkLive(resolved?.hash ?? null);
  const now = useNow(1_000);
  const model = linkViewerModel(resolved !== null, live, now);
  const [follow, setFollow] = useState(true);
  const [cardH, setCardH] = useState(0);
  const { dismissAll } = useBottomSheetModal();

  // Bağlantı açık bir alt sayfanın (paylaşım / QR) üstüne açılırsa (uygulama açıkken gelen Universal/App Link,
  // web önizlemesinde demo panelinden açma) sayfa kök sağlayıcıda kaldığı için izleyiciyi örter: kapat.
  useEffect(() => {
    dismissAll();
  }, [dismissAll]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const onCardLayout = (e: LayoutChangeEvent) => setCardH(e.nativeEvent.layout.height);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <LinkViewerMap
        ref={map}
        live={model.showMarker ? live.live : null}
        freshness={model.freshness}
        follow={follow}
        onUserPan={() => setFollow(false)}
        bottomInset={cardH + insets.bottom}
      />

      <View style={[styles.top, { top: insets.top + spacing.xs, paddingHorizontal: spacing.md }]} pointerEvents="box-none">
        <IconButton icon="close" variant="floating" accessibilityLabel="Kapat" onPress={close} />
      </View>

      <View style={[styles.bottom, { paddingHorizontal: spacing.md, paddingBottom: insets.bottom + spacing.md }]} onLayout={onCardLayout} pointerEvents="box-none">
        <View
          style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.sm }]}
          accessibilityLiveRegion="polite"
        >
          {model.state === 'live' && live.live ? (
            <>
              <View style={[styles.row, { gap: spacing.sm }]}>
                <Avatar name={live.live.sender_name} size={44} freshness={model.freshness ?? 'live'} batteryPct={live.live.battery_pct} />
                <View style={styles.flex}>
                  <Text variant="heading" numberOfLines={1} accessibilityRole="header">
                    {model.title}
                  </Text>
                  <Text variant="label" color="textSecondary">
                    {model.subtitle}
                  </Text>
                </View>
              </View>
              {!follow ? <Button title="Ortala" variant="secondary" onPress={() => { setFollow(true); map.current?.recenter(); }} /> : null}
              <Text variant="caption" color="textSecondary">
                Salt okunur canlı konum. Paylaşan kişi durdurduğunda ya da süre dolduğunda bu harita kendiliğinden kapanır.
              </Text>
            </>
          ) : (
            <>
              <View style={[styles.row, { gap: spacing.sm }]}>
                {model.state === 'loading' || model.state === 'waiting' ? <ActivityIndicator color={colors.primary} /> : null}
                <Text variant="heading" accessibilityRole="header" style={styles.flex}>
                  {model.title}
                </Text>
              </View>
              {model.subtitle ? (
                <Text variant="label" color="textSecondary">
                  {model.subtitle}
                </Text>
              ) : null}
              {model.state === 'ended' || model.state === 'invalid' || model.state === 'unavailable' ? <Button title="Kapat" variant="secondary" onPress={close} /> : null}
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', left: 0, right: 0, flexDirection: 'row' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
