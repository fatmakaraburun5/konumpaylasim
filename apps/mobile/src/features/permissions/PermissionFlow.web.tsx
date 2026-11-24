/**
 * YALNIZCA web demo: `PermissionFlow.tsx` ile AYNI akış ve aynı dışa aktarımlar. İki fark:
 *  - RN `Modal` yerine telefon ekranı katmanına portal (`demo/web/screenHost`): geniş ekranda kaplama telefon
 *    çerçevesinin içinde kalır.
 *  - `Linking.openSettings()` yerine simüle iOS Ayarlar sayfası (`openDemoSettings`); sistem pencereleri
 *    `demo/web/permissions.ts` üzerinden telefon çerçevesinde açılır.
 * Native değişirse bu dosya da güncellenmeli.
 *
 * Faz 3: kullanıcıyı sıkmayan, adım adım izin akışı. Hangi adımın sorulacağına core `nextPermissionStep` karar verir
 * (bkz. permissionPlanner.ts); bu bileşen her adımı bağlam içi bir açıklama kartıyla sunar ve sonucu hafızaya işler.
 *
 *   1. when_in_use      "Kullanırken" — TEK engelleyici adım (kısa paylaşım bununla yeter; iOS mavi gösterge,
 *                        Android kalıcı bildirimli ön plan servisi kilit ekranında da sürdürür)
 *   2. notifications    bitiş uyarısı / "+30 dk" (Android 13+, iOS)
 *   3. always_rationale uzun paylaşım (≥ 8 sa, gün sonu, haftalık, süresiz) ya da paylaşım sırasında arka plana
 *                        gidildiyse: önce uygulama içi açıklama (Play "prominent disclosure")
 *   4. always_request   iOS yükseltme penceresi / Android 10 sistem penceresi
 *      android_background_settings  Android 11+: ayarlarda "Her zaman izin ver" (açık yönerge)
 *   5. battery_optimization_hint    Android, yalnızca haftalık/süresiz: pil ayarlarına yönlendirme (istem YOK)
 *   6. precise_hint     yaklaşık konum: bir kez nazik hatırlatma
 *   (+) motion          (mobil ek) uzun paylaşımda hareket etkinliği izni — bayrak açık ve modül varsa
 *
 * "Şimdi değil" / ret → 7 gün sorulmaz; bu akışta gösterilen adım tekrar gösterilmez. Engelleyici olmayan
 * adımlarda vazgeçmek paylaşımı DURDURMAZ.
 */
import { needsBackgroundPermission, PERMISSION_COPY, PERMISSION_REASK_COOLDOWN_MS, type PermissionKind, type PermissionStep } from '@konum/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activityPermission, askActivityPermission } from '../../services/location/adaptive/activitySource';
import { openBatteryOptimizationSettings } from '../../services/location/batteryOptimization';
import { permissionFlowStore } from '../../state/permissionFlowState';
import { permissionsStore } from '../../state/permissionsStore';
import { openDemoSettings } from '../../demo/web/permissions';
import { ScreenPortal } from '../../demo/web/screenHost';
import { Button, cardShadow, Text, useTheme } from '../../ui';
import { planPermissionStep, type PermissionSnapshot, type ShareContext } from './permissionPlanner';

/** `Linking.openSettings()` karşılığı (simüle iOS Ayarlar). */
const Linking = { openSettings: () => openDemoSettings() };

export interface PermissionResult {
  foreground: boolean;
  background: boolean;
  notifications: boolean;
}

/** Mobil ek adım: hareket etkinliği (core planlayıcıda yok → needs_from_others). */
type FlowStep = Exclude<PermissionStep, 'done'> | 'motion';

export const MOTION_COPY = {
  title: 'Pilin daha uzun dayansın',
  body: 'Telefonun masadayken GPS’i kapatıp, yürümeye ya da araca binmeye başladığında güncellemeleri hızlandırmak için hareket etkinliğini kullanırız. Bu bilgi telefonundan çıkmaz.',
  cta: 'İzin ver',
  dismiss: 'Şimdi değil',
};

const KIND: Record<Exclude<FlowStep, 'when_in_use'>, PermissionKind> = {
  notifications: 'notifications',
  always_rationale: 'background',
  always_request: 'background',
  android_background_settings: 'background',
  battery_optimization_hint: 'battery',
  precise_hint: 'precise',
  motion: 'motion',
};

const snapshot = (): PermissionSnapshot => {
  const p = permissionsStore.getState();
  return {
    foreground: p.foreground,
    foregroundCanAskAgain: p.foregroundCanAskAgain,
    background: p.background,
    backgroundCanAskAgain: p.backgroundCanAskAgain,
    notifications: p.notifications,
    preciseLocation: p.preciseLocation,
    batteryOptimization: p.batteryOptimization,
  };
};

const memory = () => {
  const m = permissionFlowStore.getState();
  return { hasSeenRationale: m.hasSeenRationale, lastDeniedAt: m.lastDeniedAt };
};

/** Core adımından sonra: hareket izni sorulmalı mı (yalnızca uzun paylaşım, bir kez, 7 gün bekleme). */
async function wantsMotionStep(ctx: ShareContext, shown: readonly FlowStep[], now: number): Promise<boolean> {
  if (shown.includes('motion') || !needsBackgroundPermission(ctx)) return false;
  const denied = permissionFlowStore.getState().lastDeniedAt.motion;
  if (typeof denied === 'number' && now - denied < PERMISSION_REASK_COOLDOWN_MS) return false;
  return (await activityPermission()) === 'undetermined';
}

async function nextStep(ctx: ShareContext, shown: readonly FlowStep[]): Promise<{ step: FlowStep | 'done'; action: string }> {
  const now = Date.now();
  const coreShown = shown.filter((s): s is Exclude<FlowStep, 'motion'> => s !== 'motion');
  const r = planPermissionStep(snapshot(), memory(), ctx, coreShown, now);
  if (r.step !== 'done') return { step: r.step, action: r.action };
  if (r.canShare && (await wantsMotionStep(ctx, shown, now))) return { step: 'motion', action: 'system_prompt' };
  return { step: 'done', action: 'none' };
}

/** Paylaşım için akış gerekiyor mu? (yalnızca okur; sistem penceresi açmaz) */
export async function needsPermissionFlow(ctx: ShareContext = { shareMode: 'timed' }): Promise<boolean> {
  await Promise.all([permissionsStore.getState().refresh(), permissionFlowStore.getState().hydrate()]);
  return (await nextStep(ctx, [])).step !== 'done';
}

export interface PermissionFlowProps {
  visible: boolean;
  /** Başlatılan paylaşımın modu/süresi (arka plan izni yalnızca uzun paylaşımda sorulur). */
  context?: ShareContext;
  onDone: (result: PermissionResult | null) => void;
}

function copyFor(step: FlowStep, action: string): { title: string; body: string; cta: string; dismiss: string } {
  if (step === 'motion') return MOTION_COPY;
  const c = PERMISSION_COPY[step];
  if (step === 'when_in_use' && action === 'open_settings') {
    return {
      title: 'Konum izni kapalı',
      body: 'Konumunu paylaşabilmek için Ayarlar’dan Konum iznini “Uygulamayı Kullanırken” olarak açman gerekiyor.',
      cta: 'Ayarları aç',
      dismiss: 'Kapat',
    };
  }
  if (step === 'always_request' && action === 'open_settings') {
    return {
      title: '“Her Zaman” iznini Ayarlar’dan seç',
      body:
        Platform.OS === 'ios'
          ? 'Ayarlar → Konum → “Her Zaman”. Uygulama kapalıyken de haftalık ve süresiz paylaşım sürer.'
          : 'Ayarlar → İzinler → Konum → “Her zaman izin ver”.',
      cta: 'Ayarları aç',
      dismiss: c.dismiss,
    };
  }
  if (step === 'android_background_settings') {
    return { ...c, body: `${c.body}\n\n1. “Ayarlara git”e dokun\n2. Konum → “Her zaman izin ver”\n3. Geri dön: paylaşım kaldığı yerden sürer.` };
  }
  return c;
}

export function PermissionFlow({ visible, context = { shareMode: 'timed' }, onDone }: PermissionFlowProps) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState<{ step: FlowStep; action: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef<FlowStep[]>([]);
  const ctxRef = useRef(context);
  ctxRef.current = context;

  const finish = useCallback(() => {
    const p = permissionsStore.getState();
    setCurrent(null);
    onDone({ foreground: p.foreground === 'granted', background: p.background === 'granted', notifications: p.notifications === 'granted' });
  }, [onDone]);

  const advance = useCallback(async () => {
    await permissionsStore.getState().refresh().catch(() => undefined);
    const n = await nextStep(ctxRef.current, shown.current);
    if (n.step === 'done') finish();
    else setCurrent({ step: n.step, action: n.action });
  }, [finish]);

  useEffect(() => {
    if (!visible) return;
    shown.current = [];
    void permissionFlowStore
      .getState()
      .hydrate()
      .then(advance);
  }, [visible, advance]);

  const markShown = (s: FlowStep) => {
    if (!shown.current.includes(s)) shown.current = [...shown.current, s];
  };
  const denied = (s: Exclude<FlowStep, 'when_in_use'>) =>
    permissionFlowStore.getState().markDenied(KIND[s], Date.now());

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const onPrimary = () =>
    run(async () => {
      if (!current) return;
      const { step, action } = current;
      const perms = permissionsStore.getState();
      markShown(step);
      switch (step) {
        case 'when_in_use': {
          if (action === 'open_settings') {
            void Linking.openSettings();
            setCurrent(null);
            onDone(null);
            return;
          }
          const ok = await perms.requestForeground();
          if (!ok) {
            permissionFlowStore.getState().markDenied('foreground', Date.now());
            setCurrent(null);
            onDone(null);
            return;
          }
          permissionFlowStore.getState().clearDenied('foreground');
          break;
        }
        case 'notifications':
          if (!(await perms.requestNotifications())) denied(step);
          break;
        case 'always_rationale':
          permissionFlowStore.getState().markRationaleSeen();
          break;
        case 'always_request':
          if (action === 'open_settings') await Linking.openSettings();
          else if (!(await perms.requestBackground())) denied(step);
          break;
        case 'android_background_settings':
          // [Varsayım] expo-location Android 11+'da sistem ayar sayfasını açar; dönüşte durum yeniden okunur.
          if (!(await perms.requestBackground().catch(() => false))) {
            if (!permissionsStore.getState().backgroundCanAskAgain) await Linking.openSettings();
            denied(step);
          }
          break;
        case 'battery_optimization_hint':
          await openBatteryOptimizationSettings();
          break;
        case 'precise_hint':
          // iOS'ta "Tam Konum" yalnızca Ayarlar'dan kalıcı açılır; Android'de yeniden istem FINE yükseltmesi sunar.
          if (Platform.OS === 'ios') await Linking.openSettings();
          else if (!(await perms.requestForeground()) || permissionsStore.getState().preciseLocation === false) denied(step);
          break;
        case 'motion':
          if ((await askActivityPermission()) !== 'granted') denied(step);
          break;
      }
      await advance();
    });

  const onSecondary = () =>
    run(async () => {
      if (!current) return;
      const { step } = current;
      markShown(step);
      if (step === 'when_in_use') {
        setCurrent(null);
        onDone(null);
        return;
      }
      denied(step);
      await advance();
    });

  if (!current || !visible) return null;
  const c = copyFor(current.step, current.action);

  return (
    <ScreenPortal>
      <View style={StyleSheet.absoluteFill} accessibilityViewIsModal testID="permission-flow">
        <View style={[styles.backdrop, { paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md }]}>
          <View style={[styles.card, cardShadow, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.xl, gap: spacing.sm }]}>
            <Text variant="title" accessibilityRole="header">
              {c.title}
            </Text>
            <Text variant="body" color="textSecondary">
              {c.body}
            </Text>
            <View style={{ gap: spacing.xs, marginTop: spacing.xs }}>
              <Button title={c.cta} onPress={() => void onPrimary()} loading={busy} size="lg" />
              <Button title={c.dismiss} variant="ghost" onPress={() => void onSecondary()} disabled={busy} />
            </View>
          </View>
        </View>
      </View>
    </ScreenPortal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  card: { width: '100%' },
});
