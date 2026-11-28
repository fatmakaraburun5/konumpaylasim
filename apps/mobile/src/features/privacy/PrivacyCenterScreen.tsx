/**
 * Faz 7: İzin & Gizlilik Merkezi (app/(main)/privacy.tsx; hesap menüsünden ve Profil'den).
 *
 *   özet: "Tüm izinler tamam" / "2 ayar dikkat istiyor"
 *   İzinler (core `permissionCenterRows`): Konum (Kullanırken / Her zaman), Tam konum, Bildirimler, SOS alarmı (iOS
 *     zaman duyarlı / kritik), Kamera, Fotoğraflar, Hareket, Pil optimizasyonu (Android). Her satırda durum, neden
 *     gerektiği ve tek düğme: "İzin ver" (sistem istemi) ya da "Ayarları aç".
 *   Paylaşım tercihleri (hesaba bağlı, sunucuda zorlanır): Pil durumumu paylaş (varsayılan KAPALI), "Yola çıktı"
 *     bildirimleri.
 *   Görünüm: Sistem / Açık / Koyu (harita stili dahil, anında).
 *   Diğer: Görünmez ol (Profil), kişi izinleri (Arkadaşlar), Güvenlik Sözleşmesi / KVKK, kurulum rehberi.
 *
 * Faz 9: Rehber satırı (sistem izni) ve "SMS ile acil durum yedeği" satırı (uygulama içi: eylem `in_app` → SMS yedeği
 * sayfası; özet `useSmsSummary`). Kamera satırı: anlık fotoğraf yalnızca kamerayla çekilir, galeriden seçilemez.
 * Diğer'de Güvenli Dönüş.
 */
import {
  parsePrivacy,
  permissionCenterRows,
  permissionCenterSummary,
  PRIVACY_TEXT,
  THEME_NAME,
  THEME_PREF_V2_TEXT,
  type CenterRow,
} from '@konum/core';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openSystemSettings, requestPermission } from '../../services/permissions/permissionCenter';
import { useAuthStore } from '../../state/authStore';
import { onboardingStore } from '../../state/onboardingStore';
import { effectivePrivacy, privacyStore, usePrivacyStore } from '../../state/privacyStore';
import { useSmsSummary } from '../../state/smsFallbackStore';
import { Button, cardShadow, IconButton, MIN_TOUCH, Text, useTheme, useThemePref, useThemeSettings } from '../../ui';
import { usePermissionSnapshot } from './usePermissionSnapshot';

export function PrivacyCenterScreen() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { snapshot, refresh } = usePermissionSnapshot();
  const rawPrivacy = useAuthStore((s) => s.profile?.privacy);
  const pending = usePrivacyStore((s) => s.pending);
  const privacyError = usePrivacyStore((s) => s.error);
  const privacy = useMemo(() => effectivePrivacy(parsePrivacy(rawPrivacy), pending), [rawPrivacy, pending]);
  const themePref = useThemePref();
  const themeSchedule = useThemeSettings().schedule;
  const [working, setWorking] = useState<string | null>(null);

  const sms = useSmsSummary();
  const rows = useMemo(() => (snapshot ? permissionCenterRows(snapshot, sms) : []), [snapshot, sms]);
  const summary = permissionCenterSummary(rows);
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const toneColor = (t: CenterRow['tone']) => (t === 'ok' ? colors.live : t === 'warn' ? colors.warning : colors.danger);

  const onRow = async (r: CenterRow) => {
    if (r.action === 'in_app') {
      router.push('/sms-fallback');
      return;
    }
    setWorking(r.id);
    try {
      if (r.action === 'settings') await openSystemSettings();
      else if (r.action === 'request') await requestPermission(r.id);
      await refresh();
    } finally {
      setWorking(null);
    }
  };

  const toggle = (patch: { battery_share?: boolean; movement_alerts?: boolean }) => void privacyStore.getState().set(patch);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />
        <Text variant="title" accessibilityRole="header" style={styles.flex}>
          İzin ve Gizlilik
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        <View style={card} testID="privacy-permissions">
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Text variant="heading" style={styles.flex}>
              İzinler
            </Text>
            {snapshot ? (
              <Text variant="label" style={{ color: summary.missing === 0 ? colors.live : colors.warning }} testID="privacy-summary">
                {summary.text}
              </Text>
            ) : null}
          </View>
          {!snapshot ? <ActivityIndicator color={colors.textSecondary} /> : null}
          {rows.map((r, i) => (
            <View
              key={r.id}
              testID={`privacy-row-${r.id}`}
              style={[{ gap: spacing.xxs, paddingTop: i > 0 ? spacing.sm : 0 }, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border } : null]}
            >
              <View style={[styles.row, { gap: spacing.xs }]}>
                <View style={[styles.dot, { backgroundColor: toneColor(r.tone) }]} />
                <Text variant="body" style={styles.flex}>
                  {r.title}
                </Text>
                <Text variant="label" style={{ color: toneColor(r.tone) }}>
                  {r.status}
                </Text>
              </View>
              <Text variant="caption" color="textSecondary">
                {r.detail}
              </Text>
              {r.action && r.actionLabel ? (
                <Button title={r.actionLabel} variant="secondary" size="md" onPress={() => void onRow(r)} loading={working === r.id} disabled={working !== null} />
              ) : null}
            </View>
          ))}
        </View>

        <View style={card} testID="privacy-sharing">
          <Text variant="heading">Paylaşım tercihleri</Text>
          <View style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
            <View style={styles.flex}>
              <Text variant="body">{PRIVACY_TEXT.batteryTitle}</Text>
              <Text variant="caption" color="textSecondary">
                {PRIVACY_TEXT.batteryBody}
              </Text>
            </View>
            <Switch
              value={privacy.battery_share}
              onValueChange={(v) => toggle({ battery_share: v })}
              accessibilityLabel={PRIVACY_TEXT.batteryTitle}
              testID="privacy-battery-switch"
            />
          </View>
          <View style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm }]}>
            <View style={styles.flex}>
              <Text variant="body">{PRIVACY_TEXT.movementTitle}</Text>
              <Text variant="caption" color="textSecondary">
                {PRIVACY_TEXT.movementBody}
              </Text>
            </View>
            <Switch
              value={privacy.movement_alerts}
              onValueChange={(v) => toggle({ movement_alerts: v })}
              accessibilityLabel={PRIVACY_TEXT.movementTitle}
              testID="privacy-movement-switch"
            />
          </View>
          {privacyError ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="polite">
              {privacyError.message}
            </Text>
          ) : null}
        </View>

        <View style={card} testID="privacy-appearance">
          <Text variant="heading">Görünüm</Text>
          <Text variant="caption" color="textSecondary">
            {themePref === 'schedule'
              ? `Saate göre: gündüz ${THEME_NAME[themeSchedule.day]}, gece ${THEME_NAME[themeSchedule.night]}`
              : `${THEME_PREF_V2_TEXT[themePref]} teması. Nude, Pudra Pembesi ve Siyah / Gri önizlemeli seçilir; harita da aynı anda değişir.`}
          </Text>
          <Button title="Tema ve Harita" variant="secondary" onPress={() => router.push('/appearance')} testID="privacy-open-appearance" />
        </View>

        <View style={card}>
          <Text variant="heading">Diğer</Text>
          <Button title="Görünmez ol / görünürlük" variant="secondary" onPress={() => router.push('/profile')} />
          <Button title="Kişi izinleri (kim neyi görebilir)" variant="secondary" onPress={() => router.push('/friends')} />
          <Button title="Güvenli Dönüş" variant="secondary" onPress={() => router.push('/safe-return')} testID="privacy-safe-return" />
          <Button title="Güvenlik Sözleşmesi ve KVKK" variant="secondary" onPress={() => router.push('/consent')} />
          <Button
            title="Kurulum rehberini yeniden göster"
            variant="ghost"
            onPress={() => {
              onboardingStore.getState().restart();
              router.back();
            }}
            testID="privacy-restart-onboarding"
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  segment: { flexDirection: 'row', padding: 3 },
  segmentItem: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
});
