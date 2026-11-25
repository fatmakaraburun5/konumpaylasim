/**
 * Faz 4: gönderen tarafı "Uyarı gönderildi" ekranı (kırmızı, tam ekran). Kimlerin gördüğü (acks), gönderilen tam
 * konum + doğruluk + adres, pil, rota; "112'yi ara" (`tel:112`), "Güvendeyim" (iki adımlı onay → `sosStore.resolve`),
 * "Haritaya dön" (ekranı küçültür; haritada "SOS aktif" düğmesi kalır). Çözülünce yeşil "Uyarı kapatıldı" durumu.
 */
import {
  EMERGENCY_NUMBER,
  formatAccuracyTr,
  formatAgo,
  formatCoords,
  formatSosRoute,
  isSosActive,
  isSosLocationStale,
  type SosAlert,
  type UserId,
} from '@konum/core';
import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { lightColors, Overlay, Text, useTheme } from '../../ui';
import { BigButton } from './SosCountdown';
import { SOS_FG, sosAckRows, sosAckSummary, sosBatteryText } from './sosModel';

export interface SosActiveScreenProps {
  visible: boolean;
  alert: SosAlert | null;
  resolving: boolean;
  error: string | null;
  names: Record<UserId, string>;
  /** Konum izni olmadığı için canlı paylaşımın başlamadığı acil kişiler (SOS konumunu yine görürler). */
  liveShareSkipped?: readonly UserId[];
  onResolve: () => void;
  onClose: () => void;
}

export const callEmergency = () => void Linking.openURL(`tel:${EMERGENCY_NUMBER}`).catch(() => undefined);

export function SosActiveScreen({ visible, alert, resolving, error, names, liveShareSkipped = [], onResolve, onClose }: SosActiveScreenProps) {
  const { radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(5_000);
  const [confirming, setConfirming] = useState(false);
  const active = alert !== null && isSosActive(alert);

  useEffect(() => {
    if (!visible || !active) setConfirming(false);
  }, [visible, active]);

  if (!alert) return null;
  const loc = alert.location;
  const stale = active && isSosLocationStale(loc, now);
  const route = formatSosRoute(alert.route);
  const battery = sosBatteryText(alert);
  const bg = active ? lightColors.danger : lightColors.live;

  return (
    <Overlay visible={visible} onRequestClose={onClose} testID="sos-active-screen">
      <View style={[styles.root, { backgroundColor: bg }]}>
        <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.md }}>
          <View style={{ gap: spacing.xxs }}>
            <Text variant="title" style={styles.fg} accessibilityRole="header">
              {active ? 'Uyarı gönderildi' : 'Uyarı kapatıldı'}
            </Text>
            <Text variant="body" style={styles.fgSoft}>
              {active
                ? `${formatAgo(alert.created_at, now)} · ${sosAckSummary(alert)}. Konumun acil kişilerinle paylaşılıyor.`
                : 'Kişilerine güvende olduğun bildirildi.'}
            </Text>
          </View>

          <View style={[styles.box, { borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs }]} accessibilityLabel="Uyarıyı görenler">
            <Text variant="label" style={styles.fgSoft}>
              Kimler gördü
            </Text>
            {sosAckRows(alert, names).map((r) => (
              <View key={r.uid} style={styles.row}>
                <Text variant="heading" style={[styles.fg, styles.flex]} numberOfLines={1}>
                  {r.name}
                </Text>
                <Text variant="label" style={r.ackedAt !== null ? styles.fg : styles.fgSoft}>
                  {r.ackedAt !== null ? `✓ Gördü · ${formatAgo(r.ackedAt, now)}` : 'İletildi'}
                </Text>
              </View>
            ))}
          </View>

          <View style={[styles.box, { borderRadius: radius.lg, padding: spacing.md, gap: spacing.xxs }]} accessible accessibilityLabel={`Gönderilen konum ${alert.address ?? ''}, doğruluk ${formatAccuracyTr(loc.accuracy)}`}>
            <Text variant="label" style={styles.fgSoft}>
              Gönderilen konum
            </Text>
            <Text variant="heading" style={styles.fg}>
              {alert.address ?? 'Adres bulunamadı'}
            </Text>
            <Text variant="body" style={[styles.fg, styles.mono]}>
              {`${formatCoords(loc.lat, loc.lng)} · ${formatAccuracyTr(loc.accuracy)}`}
            </Text>
            <Text variant="label" style={styles.fgSoft}>
              {[`Güncellendi ${formatAgo(alert.updated_at, now)}`, battery, route].filter(Boolean).join(' · ')}
            </Text>
            {stale ? (
              <Text variant="label" style={styles.fg}>
                {`⚠ Konum ${formatAgo(loc.timestamp, now)} alındı; yenisi alınınca güncellenecek.`}
              </Text>
            ) : null}
          </View>

          {active && liveShareSkipped.length > 0 ? (
            <Text variant="label" style={styles.fg} testID="sos-live-share-skipped">
              {`Konum izni vermediğin için canlı paylaşım başlatılmadı: ${liveShareSkipped.map((id) => names[id] ?? 'Arkadaşın').join(', ')}. SOS konumunu yine görürler.`}
            </Text>
          ) : null}

          {error ? (
            <Text variant="label" style={styles.fg} accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}

          <View style={{ gap: spacing.sm }}>
            {active ? <BigButton title={`${EMERGENCY_NUMBER}'yi ara`} onPress={callEmergency} solid hint="Acil çağrı merkezini arar" /> : null}
            {active && !confirming ? <BigButton title="Güvendeyim" onPress={() => setConfirming(true)} disabled={resolving} /> : null}
            {active && confirming ? (
              <View style={[styles.box, { borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }]}>
                <Text variant="heading" style={styles.fg} accessibilityLiveRegion="polite">
                  Uyarı kapatılsın mı? Kişilerine güvende olduğun bildirilecek.
                </Text>
                <BigButton title={resolving ? 'Kapatılıyor…' : 'Evet, güvendeyim'} onPress={onResolve} solid disabled={resolving} />
                <BigButton title="Vazgeç" onPress={() => setConfirming(false)} disabled={resolving} />
              </View>
            ) : null}
            <BigButton title={active ? 'Haritaya dön' : 'Kapat'} onPress={onClose} />
          </View>
        </ScrollView>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fg: { color: SOS_FG },
  fgSoft: { color: 'rgba(255,255,255,0.88)' },
  box: { backgroundColor: 'rgba(0,0,0,0.18)' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  flex: { flex: 1 },
  mono: { fontVariant: ['tabular-nums'] },
});
