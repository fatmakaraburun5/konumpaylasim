/**
 * Faz 4: alıcı tarafı yüksek öncelikli acil durum kartı (tam ekran, `sosStore.focusedSosId`). Push'a dokununca ya
 * da uygulama açıkken yeni aktif SOS gelince açılır.
 *
 *   kırmızı başlık "ACİL DURUM" · ad · core `SOS_MESSAGE` · "x dk önce"
 *   adres · koordinat (core `formatCoords`, Kopyala) · doğruluk (`formatAccuracyTr`) · pil · rota/ETA (`formatSosRoute`)
 *   eski konum uyarısı (`isSosLocationStale`)
 *   "Haritada göster" · "Yol tarifi" (`sosDirectionsUrl`) · "112'yi ara" · "Gördüm" (sos_ack)
 *   Çözülünce yeşil "… güvende". Birden çok SOS: en yeni üstte, diğerleri altta listede.
 *
 * Faz 9: Güvenli Dönüş alarmı (`origin: 'safe_return'`, sunucu açar): başlık "GÜVENLİ DÖNÜŞ ALARMI", mesaj
 * "Güvenli Dönüş süresi doldu: Ev hedefine 30 dk içinde varmadım ve yanıt vermedim", hedef / süre satırı ve son
 * doğrulanmış konum + pil.
 */
import {
  EMERGENCY_NUMBER,
  formatAccuracyTr,
  formatAgo,
  formatClock,
  sosOrigin,
  sosPushText,
  formatCoords,
  formatSosRoute,
  isSosActive,
  isSosLocationStale,
  SOS_MESSAGE,
  sosDirectionsUrl,
  type SosAlert,
} from '@konum/core';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { useAuthStore } from '../../state/authStore';
import { selectIncomingSos, sosStore, useSosStore } from '../../state/sosStore';
import { IconButton, lightColors, Overlay, Text, useTheme } from '../../ui';
import { callEmergency } from './SosActiveScreen';
import { BigButton } from './SosCountdown';
import { SOS_FG, sosBatteryText } from './sosModel';

export interface SosIncomingScreenProps {
  /** "Haritada göster": ekran kapanır, harita SOS konumuna ortalanır. */
  onShowOnMap: (a: SosAlert) => void;
}

export function SosIncomingScreen({ onShowOnMap }: SosIncomingScreenProps) {
  const { radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(5_000);
  const myUid = useAuthStore((s) => s.uid);
  const focusedId = useSosStore((s) => s.focusedSosId);
  const incoming = useSosStore((s) => s.incoming);
  const list = useMemo(() => selectIncomingSos({ incoming }), [incoming]);
  const alert = focusedId ? (incoming[focusedId] ?? null) : null;
  const [copied, setCopied] = useState(false);
  const [acking, setAcking] = useState(false);

  useEffect(() => {
    setCopied(false);
    setAcking(false);
  }, [focusedId]);

  if (!alert) return null;
  const active = isSosActive(alert);
  const loc = alert.location;
  const acked = myUid !== null && alert.acks[myUid] !== undefined;
  const stale = active && isSosLocationStale(loc, now);
  const route = formatSosRoute(alert.route);
  const battery = sosBatteryText(alert);
  const others = list.filter((a) => a.sos_id !== alert.sos_id);
  const bg = active ? lightColors.danger : lightColors.live;
  const close = () => sosStore.getState().focus(null);
  const safeReturn = sosOrigin(alert) === 'safe_return';
  const sr = alert.safe_return ?? null;

  const copy = async () => {
    await Clipboard.setStringAsync(formatCoords(loc.lat, loc.lng)).catch(() => false);
    setCopied(true);
  };
  const ack = async () => {
    setAcking(true);
    await sosStore.getState().ack(alert.sos_id);
    setAcking(false);
  };

  return (
    <Overlay visible onRequestClose={close} testID="sos-incoming-screen">
      <View style={[styles.root, { backgroundColor: bg }]}>
        <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.md }}>
          <View style={styles.row}>
            <Text variant="title" style={[styles.fg, styles.flex, { letterSpacing: 1 }]} accessibilityRole="header">
              {active ? (safeReturn ? 'GÜVENLİ DÖNÜŞ ALARMI' : 'ACİL DURUM') : 'GÜVENDE'}
            </Text>
            <IconButton icon="close" accessibilityLabel="Acil durum kartını kapat" onPress={close} variant="soft" size={40} />
          </View>

          <View style={{ gap: spacing.xxs }} accessible accessibilityLiveRegion="assertive">
            <Text style={[styles.fg, styles.name]} numberOfLines={2}>
              {alert.sender_name}
            </Text>
            <Text variant="heading" style={styles.fg}>
              {active ? (safeReturn ? alert.message || sosPushText(alert).title : SOS_MESSAGE) : `${alert.sender_name} güvende olduğunu bildirdi.`}
            </Text>
            {safeReturn && sr ? (
              <Text variant="label" style={styles.fg} testID="sos-incoming-safe-return">
                {`Güvenli Dönüş · ${sr.destination_name} · ${sr.duration_min} dk · süre ${formatClock(sr.due_at)}'te doldu`}
              </Text>
            ) : null}
            <Text variant="label" style={styles.fgSoft}>
              {active
                ? `${formatAgo(alert.created_at, now)} gönderildi · güncellendi ${formatAgo(alert.updated_at, now)}`
                : `Uyarı ${formatAgo(alert.resolved_at ?? alert.updated_at, now)} kapatıldı`}
            </Text>
          </View>

          <View style={[styles.box, { borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs }]}>
            <Text variant="label" style={styles.fgSoft}>
              {safeReturn ? 'Son doğrulanmış konumu' : active ? 'Şu anki konumu' : 'Son konumu'}
            </Text>
            <Text variant="heading" style={styles.fg}>
              {alert.address ?? 'Adres bulunamadı'}
            </Text>
            <View style={styles.row}>
              <View style={styles.flex}>
                <Text variant="body" style={[styles.fg, styles.mono]} selectable accessibilityLabel={`Koordinat ${formatCoords(loc.lat, loc.lng)}`}>
                  {formatCoords(loc.lat, loc.lng)}
                </Text>
                <Text variant="label" style={styles.fgSoft}>
                  {`Doğruluk ${formatAccuracyTr(loc.accuracy)}`}
                </Text>
              </View>
              <Pressable
                onPress={() => void copy()}
                accessibilityRole="button"
                accessibilityLabel="Koordinatı kopyala"
                hitSlop={6}
                style={({ pressed }) => [styles.copy, { borderRadius: radius.md, backgroundColor: pressed ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.18)' }]}
              >
                <Text variant="label" style={styles.fg}>
                  {copied ? 'Kopyalandı' : 'Kopyala'}
                </Text>
              </Pressable>
            </View>
            {battery || route ? (
              <Text variant="label" style={styles.fg}>
                {[battery, route].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
            {stale ? (
              <Text variant="label" style={[styles.fg, { fontWeight: '700' }]} accessibilityRole="alert">
                {`⚠ Konum ${formatAgo(loc.timestamp, now)} alındı; şu an farklı bir yerde olabilir.`}
              </Text>
            ) : null}
          </View>

          <View style={{ gap: spacing.sm }}>
            <View style={[styles.row, { gap: spacing.sm }]}>
              <View style={styles.flex}>
                <BigButton title="Haritada göster" onPress={() => onShowOnMap(alert)} small />
              </View>
              <View style={styles.flex}>
                <BigButton title="Yol tarifi" onPress={() => void Linking.openURL(sosDirectionsUrl(loc.lat, loc.lng)).catch(() => undefined)} hint="Harita uygulamasında yol tarifi açar" small />
              </View>
            </View>
            {active ? <BigButton title={`${EMERGENCY_NUMBER}'yi ara`} onPress={callEmergency} solid hint="Acil çağrı merkezini arar" /> : null}
            {active ? (
              <BigButton
                title={acked ? '✓ Gördün · bildirildi' : acking ? 'Bildiriliyor…' : 'Gördüm'}
                onPress={() => void ack()}
                disabled={acked || acking}
                hint={`${alert.sender_name} uyarısını gördüğünü öğrenir`}
              />
            ) : (
              <BigButton title="Kapat" onPress={close} solid />
            )}
          </View>

          {others.length > 0 ? (
            <View style={[styles.box, { borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs }]}>
              <Text variant="label" style={styles.fgSoft}>
                {`Diğer uyarılar (${others.length})`}
              </Text>
              {others.map((o) => (
                <Pressable
                  key={o.sos_id}
                  onPress={() => sosStore.getState().focus(o.sos_id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${o.sender_name}, ${isSosActive(o) ? 'acil durum' : 'güvende'}, ${formatAgo(o.created_at, now)}`}
                  style={({ pressed }) => [styles.otherRow, { borderRadius: radius.md, backgroundColor: pressed ? 'rgba(255,255,255,0.2)' : 'transparent' }]}
                >
                  <Text variant="heading" style={[styles.fg, styles.flex]} numberOfLines={1}>
                    {`${isSosActive(o) ? '🔴' : '🟢'} ${o.sender_name}`}
                  </Text>
                  <Text variant="label" style={styles.fgSoft}>
                    {formatAgo(o.created_at, now)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fg: { color: SOS_FG },
  fgSoft: { color: 'rgba(255,255,255,0.88)' },
  name: { fontSize: 30, lineHeight: 36, fontWeight: '800' },
  box: { backgroundColor: 'rgba(0,0,0,0.18)' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  mono: { fontVariant: ['tabular-nums'] },
  copy: { minHeight: 44, minWidth: 88, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  otherRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 8, gap: 8 },
});
