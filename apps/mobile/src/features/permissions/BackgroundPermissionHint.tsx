/**
 * Paylaşım sürerken haritada gösterilen ENGELLEMEYEN "Her zaman" şeridi (Faz 3: core planlayıcı güdümlü).
 *
 * Şerit yalnızca core `nextPermissionStep` süren en uzun paylaşım için bir arka plan adımı
 * (always_rationale / always_request / android_background_settings) önerdiğinde görünür:
 *   - uzun paylaşım (≥ 8 sa, gün sonu, haftalık, süresiz) ya da paylaşım sürerken uygulama arka plana gitti,
 *   - "Kullanırken" verilmiş, "Her zaman" yok, son ret üzerinden 7 gün geçmiş.
 * "İzin ver" → aynı bağlamla PermissionFlow (önce uygulama içi açıklama, sonra sistem / Ayarlar).
 * Kapatmak → "Şimdi değil" sayılır (7 gün sorulmaz). Paylaşım DURMAZ.
 */
import { Platform, StyleSheet, View } from 'react-native';
import { useMemo, useState } from 'react';
import { permissionFlowStore, usePermissionFlowStore } from '../../state/permissionFlowState';
import { usePermissionsStore } from '../../state/permissionsStore';
import { Button, IconButton, Text, useTheme } from '../../ui';
import { PermissionFlow } from './PermissionFlow';
import { BACKGROUND_STEPS, planPermissionStep, type ShareContext } from './permissionPlanner';

export function BackgroundPermissionHint({ visible, context }: { visible: boolean; context?: ShareContext }) {
  const { colors, spacing, radius } = useTheme();
  const foreground = usePermissionsStore((s) => s.foreground);
  const foregroundCanAskAgain = usePermissionsStore((s) => s.foregroundCanAskAgain);
  const background = usePermissionsStore((s) => s.background);
  const backgroundCanAskAgain = usePermissionsStore((s) => s.backgroundCanAskAgain);
  const notifications = usePermissionsStore((s) => s.notifications);
  const preciseLocation = usePermissionsStore((s) => s.preciseLocation);
  const batteryOptimization = usePermissionsStore((s) => s.batteryOptimization);
  const hasSeenRationale = usePermissionFlowStore((s) => s.hasSeenRationale);
  const lastDeniedAt = usePermissionFlowStore((s) => s.lastDeniedAt);
  const hydrated = usePermissionFlowStore((s) => s.hydrated);
  const wentBackground = usePermissionFlowStore((s) => s.wentBackgroundDuringShare);
  const [flowOpen, setFlowOpen] = useState(false);

  const ctx: ShareContext = useMemo(
    () => ({ ...(context ?? { shareMode: 'timed' }), wentBackgroundDuringShare: (context?.wentBackgroundDuringShare ?? false) || wentBackground }),
    [context, wentBackground],
  );

  const step = useMemo(() => {
    if (!visible || !hydrated || foreground !== 'granted' || background === 'unknown') return null;
    const r = planPermissionStep(
      { foreground, foregroundCanAskAgain, background, backgroundCanAskAgain, notifications, preciseLocation, batteryOptimization },
      { hasSeenRationale, lastDeniedAt },
      ctx,
      // Şerit yalnızca arka plan yükseltmesi içindir; bildirim / pil / tam konum adımları burada sorulmaz.
      ['notifications', 'battery_optimization_hint', 'precise_hint'],
      Date.now(),
    );
    return r.step !== 'done' && BACKGROUND_STEPS.has(r.step) ? r.step : null;
  }, [visible, hydrated, foreground, foregroundCanAskAgain, background, backgroundCanAskAgain, notifications, preciseLocation, batteryOptimization, hasSeenRationale, lastDeniedAt, ctx]);

  if (!step && !flowOpen) return null;

  return (
    <>
      {step ? (
        <View
          accessibilityRole="summary"
          style={[styles.wrap, { backgroundColor: colors.primarySoft, borderRadius: radius.lg, padding: spacing.sm, gap: spacing.xs }]}
        >
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Text variant="label" style={styles.flex}>
              {Platform.OS === 'ios'
                ? 'Uygulama kapalıyken de paylaşımın sürmesi için konum iznini “Her Zaman” yap.'
                : 'Uygulama kapalıyken de paylaşımın sürmesi için konum iznini “Her zaman izin ver” yap.'}
            </Text>
            <IconButton
              icon="close"
              size={32}
              accessibilityLabel="Uyarıyı kapat"
              onPress={() => permissionFlowStore.getState().markDenied('background', Date.now())}
            />
          </View>
          <Button title="İzin ver" variant="secondary" onPress={() => setFlowOpen(true)} />
        </View>
      ) : null}
      <PermissionFlow visible={flowOpen} context={ctx} onDone={() => setFlowOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
