/**
 * Faz 5: "Bölgelerim" ekranı (app/(main)/zones.tsx; TopBar menüsünden ve Arkadaşlar ekranından).
 *
 *   izleme durumu bandı (izin gerekiyorsa "Bölge bildirimleri için konum iznini 'Her zaman' yap" + düğme)
 *   bölge listesi: emoji + ad + yarıçap (core `formatZoneRadius`) + "Şu an buradasın" rozeti + kural özetleri
 *     (core `describeZoneRule`) + aç / kapa; dokun → düzenleyici
 *   son olaylar: "Ev · vardın · 18:42 · Ayşe'ye bildirildi" ya da bastırma nedeni
 * Bölge koordinatı yalnızca bu cihazda ve sahibinin Firestore belgesinde durur; alıcılar yalnızca bölge ADINI görür.
 */
import { formatZoneRadius, ZONE_LIMITS, type Zone } from '@konum/core';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFriendNames } from '../../state/friendsStore';
import { usePermissionsStore } from '../../state/permissionsStore';
import { selectZoneList, useZonesStore, zonesStore } from '../../state/zonesStore';
import { Button, cardShadow, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { monitoringBanner, recentEventText, ruleSummary, zoneEmoji } from './zoneModel';

export function ZonesScreen() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const names = useFriendNames();
  const zonesMap = useZonesStore((s) => s.zones);
  const presence = useZonesStore((s) => s.presence);
  const pending = useZonesStore((s) => s.pending);
  const monitoring = useZonesStore((s) => s.monitoring);
  const recentEvents = useZonesStore((s) => s.recentEvents);
  const backgroundBlocked = usePermissionsStore((s) => s.background === 'denied' && !s.backgroundCanAskAgain);
  const zones = useMemo(() => selectZoneList({ zones: zonesMap }), [zonesMap]);
  const enabledCount = zones.filter((z) => z.enabled).length;
  const banner = monitoringBanner(monitoring, enabledCount);
  const [asking, setAsking] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const atLimit = zones.length >= ZONE_LIMITS.maxZones;

  const askPermission = async () => {
    if (backgroundBlocked) {
      void Linking.openSettings().catch(() => undefined);
      return;
    }
    setAsking(true);
    const ok = await zonesStore.getState().requestMonitoringPermission();
    setAsking(false);
    if (!ok) void Linking.openSettings().catch(() => undefined);
  };

  const toggle = async (z: Zone, on: boolean) => {
    setToggleError(null);
    const ok = await zonesStore.getState().setEnabled(z.zone_id, on);
    if (!ok) setToggleError(`${z.name} ${on ? 'açılamadı' : 'kapatılamadı'}. Bağlantını kontrol edip tekrar dene.`);
  };

  const openEditor = (zoneId?: string) => router.push(zoneId ? `/zone-edit?id=${encodeURIComponent(zoneId)}` : '/zone-edit');
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const bannerColors =
    banner?.tone === 'warning'
      ? { bg: colors.warningSoft, fg: colors.warning }
      : banner?.tone === 'live'
        ? { bg: colors.liveSoft, fg: colors.live }
        : { bg: colors.surfaceAlt, fg: colors.textSecondary };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />
        <Text variant="title" accessibilityRole="header" style={styles.flex}>
          Bölgelerim
        </Text>
        <IconButton icon="plus" accessibilityLabel="Bölge ekle" onPress={() => openEditor()} disabled={atLimit} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        {banner ? (
          <View
            accessibilityRole={banner.tone === 'warning' ? 'alert' : undefined}
            testID="zone-monitoring-banner"
            style={[{ backgroundColor: bannerColors.bg, borderRadius: radius.md, padding: spacing.sm, gap: spacing.xs }]}
          >
            <Text variant="label" style={{ color: bannerColors.fg }}>
              {banner.text}
            </Text>
            {banner.action ? (
              <Button title={backgroundBlocked ? 'Ayarları aç' : banner.action} variant="secondary" onPress={() => void askPermission()} loading={asking} />
            ) : null}
          </View>
        ) : null}

        {zones.length === 0 ? (
          <View style={card}>
            <Text variant="heading">Henüz bölge yok</Text>
            <Text variant="label" color="textSecondary">
              Ev, iş ya da sık gittiğin bir noktayı kaydet; vardığında ya da çıktığında seçtiğin arkadaşlarına haber verelim
              veya konum paylaşımını kendiliğinden başlatalım. Bölgenin yeri yalnızca sende kalır; arkadaşların yalnızca adını
              görür.
            </Text>
            <Button title="Bölge ekle" onPress={() => openEditor()} />
          </View>
        ) : (
          <View style={card}>
            {zones.map((z, i) => (
              <View key={z.zone_id} style={[{ gap: spacing.xxs }, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm } : null]} testID={`zone-row-${z.zone_id}`}>
                <View style={[styles.row, { gap: spacing.sm }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${z.name}, ${formatZoneRadius(z.radius_m)}${presence[z.zone_id] === 'inside' ? ', şu an buradasın' : ''}`}
                    accessibilityHint="Bölgeyi düzenle"
                    onPress={() => openEditor(z.zone_id)}
                    style={({ pressed }) => [styles.row, styles.flex, { gap: spacing.sm, minHeight: MIN_TOUCH, opacity: pressed ? 0.7 : z.enabled ? 1 : 0.55 }]}
                  >
                    <View style={[styles.emoji, { backgroundColor: colors.primarySoft }]}>
                      <Text variant="heading" maxFontSizeMultiplier={1}>
                        {zoneEmoji(z)}
                      </Text>
                    </View>
                    <View style={styles.flex}>
                      <View style={[styles.row, { gap: spacing.xs, flexWrap: 'wrap' }]}>
                        <Text variant="heading" numberOfLines={1}>
                          {z.name}
                        </Text>
                        <Text variant="label" color="textSecondary">
                          {formatZoneRadius(z.radius_m)}
                        </Text>
                        {presence[z.zone_id] === 'inside' ? (
                          <View style={[styles.badge, { backgroundColor: colors.liveSoft, borderRadius: radius.pill }]}>
                            <Text variant="caption" style={{ color: colors.live }}>
                              Şu an buradasın
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      {z.rules.length === 0 ? (
                        <Text variant="caption" color="textSecondary">
                          Kural yok
                        </Text>
                      ) : (
                        z.rules.map((r) => (
                          <Text key={r.rule_id} variant="caption" color="textSecondary">
                            {ruleSummary(r, z.name, names)}
                          </Text>
                        ))
                      )}
                    </View>
                  </Pressable>
                  {pending[z.zone_id] ? <ActivityIndicator color={colors.textSecondary} size="small" /> : null}
                  <Switch value={z.enabled} onValueChange={(on) => void toggle(z, on)} disabled={!!pending[z.zone_id]} accessibilityLabel={`${z.name} bölgesi açık`} />
                </View>
              </View>
            ))}
            {toggleError ? (
              <Text variant="label" color="danger" accessibilityLiveRegion="polite">
                {toggleError}
              </Text>
            ) : null}
            {atLimit ? (
              <Text variant="caption" color="textSecondary">
                {`En fazla ${ZONE_LIMITS.maxZones} bölge kaydedebilirsin.`}
              </Text>
            ) : (
              <Button title="Bölge ekle" variant="secondary" onPress={() => openEditor()} />
            )}
          </View>
        )}

        {recentEvents.length > 0 ? (
          <View style={card} testID="zone-recent-events">
            <Text variant="heading">Son olaylar</Text>
            {recentEvents.map((e) => (
              <Text key={`${e.zone_id}:${e.transition}:${e.at}`} variant="label" color={e.suppressed ? 'textSecondary' : 'text'}>
                {recentEventText(e, zonesMap[e.zone_id], names)}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  emoji: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  badge: { paddingHorizontal: 8, paddingVertical: 1 },
});
