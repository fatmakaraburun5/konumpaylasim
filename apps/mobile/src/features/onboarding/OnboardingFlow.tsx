/**
 * Faz 7: ilk açılış izin akışı (sözleşme onayından sonra bir kez; (main) yerleşimi gösterir).
 *
 *   Hoş geldin → Konum ("Kullanırken") → "Her zaman"a yükseltme → Bildirimler (tam izin; SOS alarmı, bölge ve hareket
 *   uyarıları, etkinlikler) → Pil paylaşımı onayı (uygulama içi anahtar, varsayılan KAPALI) → Kamera ve fotoğraflar
 *
 * Sıradaki adımı core `nextOnboardingStep` seçer: verilmiş izin atlanır, reddedilmiş izin için "Ayarlarda aç" gösterilir.
 * Her adımda "Şimdi değil" vardır; akış paylaşımı engellemez ve atlanan izinler ihtiyaç anında yeniden sorulur.
 */
import { nextOnboardingStep, ONBOARDING_TEXT, onboardingProgress, parsePrivacy, PRIVACY_TEXT, type OnboardingStep } from '@konum/core';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openSystemSettings, requestPermission } from '../../services/permissions/permissionCenter';
import { useAuthStore } from '../../state/authStore';
import { onboardingStore, useOnboardingStore } from '../../state/onboardingStore';
import { privacyStore } from '../../state/privacyStore';
import { Button, cardShadow, Icon, Text, useTheme, type IconName } from '../../ui';
import { usePermissionSnapshot } from '../privacy/usePermissionSnapshot';

const STEP_ICON: Record<Exclude<OnboardingStep, 'done'>, IconName> = {
  welcome: 'shield',
  location: 'mapPin',
  location_always: 'crosshair',
  notifications: 'bell',
  battery_share: 'battery',
  camera_photos: 'camera',
};

export function OnboardingFlow() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { snapshot, refresh } = usePermissionSnapshot();
  const done = useOnboardingStore((s) => s.done);
  const rawPrivacy = useAuthStore((s) => s.profile?.privacy);
  const privacy = useMemo(() => parsePrivacy(rawPrivacy), [rawPrivacy]);
  const [battery, setBattery] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = useMemo(
    () => (snapshot ? nextOnboardingStep({ perms: snapshot, batteryShareDecided: privacy.updated_at !== null, done }) : null),
    [snapshot, privacy.updated_at, done],
  );

  useEffect(() => {
    if (plan?.step === 'done') onboardingStore.getState().complete();
  }, [plan?.step]);

  if (!plan || plan.step === 'done') {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    );
  }

  const step = plan.step;
  const text = ONBOARDING_TEXT[step];
  const progress = onboardingProgress(step);
  const settings = plan.action === 'open_settings';

  const skip = () => {
    setError(null);
    onboardingStore.getState().markDone(step);
  };

  const primary = async () => {
    setError(null);
    setWorking(true);
    try {
      if (plan.action === 'info') {
        onboardingStore.getState().markDone(step);
      } else if (plan.action === 'open_settings') {
        await openSystemSettings();
        onboardingStore.getState().markDone(step);
      } else if (plan.action === 'in_app_toggle') {
        const r = await privacyStore.getState().set({ battery_share: battery });
        if (!r.ok) {
          setError(r.error.message);
          return;
        }
        onboardingStore.getState().markDone(step);
      } else {
        await requestPermission(step);
        onboardingStore.getState().markDone(step);
      }
      await refresh();
    } finally {
      setWorking(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID="onboarding">
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg, gap: spacing.lg }}>
        {step !== 'welcome' ? (
          <View style={{ gap: spacing.xs }} accessibilityLabel={`Adım ${progress.index} / ${progress.total}`}>
            <View style={[styles.track, { backgroundColor: colors.surfaceAlt }]}>
              <View style={[styles.trackFill, { width: `${Math.round((progress.index / progress.total) * 100)}%`, backgroundColor: colors.primary }]} />
            </View>
            <Text variant="caption" color="textSecondary">{`${progress.index} / ${progress.total}`}</Text>
          </View>
        ) : null}

        <View style={[styles.hero, { backgroundColor: colors.primarySoft, borderRadius: radius.xl }]}>
          <Icon name={STEP_ICON[step]} size={44} color={colors.primary} />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="title" accessibilityRole="header" testID={`onboarding-step-${step}`}>
            {text.title}
          </Text>
          <Text variant="body" color="textSecondary">
            {text.body}
          </Text>
        </View>

        {step === 'battery_share' ? (
          <View style={[cardShadow, styles.row, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }]}>
            <View style={styles.flex}>
              <Text variant="heading">{PRIVACY_TEXT.batteryTitle}</Text>
              <Text variant="caption" color="textSecondary">
                {battery ? 'Açık: pil yüzden paylaşımlara eklenir.' : 'Kapalı: pil bilgisi hiç gönderilmez.'}
              </Text>
            </View>
            <Switch value={battery} onValueChange={setBattery} accessibilityLabel={PRIVACY_TEXT.batteryTitle} testID="onboarding-battery-switch" />
          </View>
        ) : null}

        {step === 'notifications' ? (
          <View style={{ gap: spacing.xs }}>
            {[
              'SOS: kilit ekranında özel alarm sesiyle',
              '"Ayşe eve girdi", "Mehmet yola çıktı": üstten anlık banner',
              'Etkinlik davetleri ve 1 gün önce / sabah 08:00 hatırlatmaları',
            ].map((l) => (
              <View key={l} style={[styles.row, { gap: spacing.xs }]}>
                <Icon name="check" size={16} color={colors.live} />
                <Text variant="label" style={styles.flex}>
                  {l}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.flex} />

        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <Button
          title={settings && text.settingsPrimary ? text.settingsPrimary : text.primary}
          onPress={() => void primary()}
          loading={working}
          disabled={working}
          size="lg"
          testID="onboarding-primary"
        />
        {step !== 'welcome' ? <Button title="Şimdi değil" variant="ghost" onPress={skip} disabled={working} testID="onboarding-skip" /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  hero: { width: 88, height: 88, alignItems: 'center', justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, borderRadius: 3 },
});
