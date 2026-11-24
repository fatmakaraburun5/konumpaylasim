/**
 * YALNIZCA web: IncomingStrip.tsx ile aynı kartlar. Tek fark yapı: tarayıcıda Pressable bir <button>
 * olduğundan "×" düğmesi kart düğmesinin İÇİNDE olamaz (iç içe <button> geçersiz HTML'dir); burada
 * kart bir kapsayıcıdır, odaklama düğmesi ile "×" düğmesi kardeştir. Native paket IncomingStrip.tsx'i kullanır.
 *
 * Faz 3 (native ile aynı): core `lastVerifiedLocation` → canlı değilse "Son doğrulanmış konum · 14:05 · %42" ve durum
 * ("Bağlantısı kopmuş olabilir"); düşük pil rozeti ("Pil %14", uyarı rengi); çevrimdışı eşitlenen nokta sayısı.
 */
import { formatAgo, LOW_BATTERY_PCT, lowBatteryBadge, syncedPointsText, type EpochMs, type ReceiverStatus, type UserId } from '@konum/core';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { incomingStore, type IncomingFriendLocation } from '../../state/incomingStore';
import { Avatar, cardShadow, IconButton, Text, useTheme } from '../../ui';

/** Uyarı rengiyle gösterilen alıcı durumları. */
const WARN: ReadonlySet<ReceiverStatus> = new Set(['delayed', 'offline_suspected', 'stale']);

export interface IncomingStripProps {
  items: readonly IncomingFriendLocation[];
  names: Record<UserId, string>;
  now: EpochMs;
  onFocus: (f: IncomingFriendLocation) => void;
}

export function IncomingStrip({ items, names, now, onFocus }: IncomingStripProps) {
  const { colors, spacing, radius } = useTheme();
  if (items.length === 0) return null;

  const confirmRevoke = (senderId: UserId) => {
    const name = names[senderId] ?? 'Bu kişi';
    Alert.alert('Görmeyi bırak', `${name} artık konumunu seninle paylaşmayacak. Yeniden görmek için senin için yeni bir paylaşım başlatması gerekir.`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Görmeyi bırak',
        style: 'destructive',
        onPress: async () => {
          const r = await incomingStore.getState().revoke(senderId);
          if (!r.ok) Alert.alert('İşlem yapılamadı', r.message);
        },
      },
    ]);
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.xs }}
      accessibilityLabel="Konumunu seninle paylaşanlar"
    >
      {items.map((f) => {
        const name = names[f.senderId] ?? 'Arkadaş';
        const v = f.verified ?? null;
        const warn = v !== null && WARN.has(v.status);
        const status = warn ? v.statusText : f.freshness === 'live' ? 'Canlı' : formatAgo(f.location.timestamp, now);
        const pct = v?.battery_pct ?? f.location.battery_pct;
        const low = pct !== null && pct <= LOW_BATTERY_PCT;
        const badge = lowBatteryBadge(pct, LOW_BATTERY_PCT);
        // Canlı değilken son doğrulanmış koordinatın zamanı + pil; eşitlenen iz varsa onun notu.
        const detail = v && v.status !== 'live' ? v.label : null;
        const synced = syncedPointsText(f.trail?.length ?? 0);
        return (
          <View
            key={f.shareId}
            style={[styles.card, cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingRight: spacing.xs }]}
          >
            <Pressable
              onPress={() => onFocus(f)}
              onLongPress={() => confirmRevoke(f.senderId)}
              accessibilityRole="button"
              accessibilityLabel={`${name}, ${status}${pct !== null ? `, pil yüzde ${pct}` : ''}${detail ? `, ${detail}` : ''}${synced ? `, ${synced}` : ''}`}
              accessibilityHint="Haritada göstermek için dokun"
              style={({ pressed }) => [
                styles.focus,
                { backgroundColor: pressed ? colors.surfaceAlt : 'transparent', borderRadius: radius.lg, padding: spacing.xs, gap: spacing.xs },
              ]}
            >
              <Avatar name={name} size={36} freshness={f.freshness} />
              <View>
                <Text variant="label" numberOfLines={1} style={styles.name}>
                  {name}
                </Text>
                <View style={styles.row}>
                  <Text
                    variant="caption"
                    numberOfLines={1}
                    style={{ color: warn ? colors.warning : f.freshness === 'live' ? colors.live : f.freshness === 'recent' ? colors.primary : colors.stale }}
                  >
                    {status}
                  </Text>
                  {pct !== null ? (
                    <Text variant="caption" style={{ color: low ? colors.warning : colors.textSecondary, fontWeight: low ? '600' : undefined }}>
                      {`  ·  ${badge ?? `%${pct}`}`}
                    </Text>
                  ) : null}
                </View>
                {detail ? (
                  <Text variant="caption" color="textSecondary" numberOfLines={1} style={styles.detail}>
                    {detail}
                  </Text>
                ) : null}
                {synced ? (
                  <Text variant="caption" color="textSecondary" numberOfLines={1} style={styles.detail}>
                    {synced}
                  </Text>
                ) : null}
              </View>
            </Pressable>
            <IconButton icon="close" size={32} accessibilityLabel={`${name}: görmeyi bırak`} onPress={() => confirmRevoke(f.senderId)} />
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  focus: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  name: { maxWidth: 120 },
  detail: { maxWidth: 220 },
  row: { flexDirection: 'row' },
});
