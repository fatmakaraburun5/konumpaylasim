/**
 * Faz 9: arkadaş paylaşımı sürerken kitapçığın üstündeki ince araç satırı.
 *
 *   [📷 Anlık fotoğraf | küçük resim + "52 dk kaldı"]  [🏁 Hedef seç | "Hedef: Ev · Neredeyse vardın"]
 *   gece geç saatte (22:00–06:00) ve Güvenli Dönüş yokken: "🛡 Güvenli Dönüş" önerisi
 *
 * Fotoğraf yalnızca kamerayla çekilir (MyProofButton); hedef DestinationPicker'da seçilir.
 *
 * Faz 12: "☕ Mola" → aynı satırda [15 dk] [30 dk]; molada "☕ Moladasın · 12 dk" + "Devam et". Mola boyunca yeni
 * konum gitmez, paylaşım süresi işlemeye devam eder; kilit ekranı sayacı "Molada" olur.
 */
import { BREAK_MINUTES, BREAK_TEXT, isOnBreak, SAFE_RETURN_TEXT } from '@konum/core';
import { useNow } from '../../lib/useNow';
import { now as serverNow } from '../../lib/clock';
import { breakStore, useBreakStore } from '../../state/breakStore';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { selectDestinationStatus, useDestinationStore } from '../../state/destinationStore';
import { Icon, MIN_TOUCH, Text, useTheme } from '../../ui';
import { myDestStatusText } from '../approach/destModel';
import { MyProofButton } from '../proof/MyProofButton';
import { isSafeReturnLive, lateNightNow } from '../safeReturn/safeReturnModel';
import { useSafeReturnPhase } from '../safeReturn/useSafeReturnPhase';

export interface ShareExtrasBarProps {
  onPickDestination: () => void;
  onSafeReturn: () => void;
}

/** Bu oturumda gece önerisi kapatıldı mı (uygulama yeniden açılana kadar). */
let lateNightDismissed = false;

export function ShareExtrasBar({ onPickDestination, onSafeReturn }: ShareExtrasBarProps) {
  const { colors, radius, spacing } = useTheme();
  const destination = useDestinationStore((s) => s.destination);
  const approach = useDestinationStore((s) => s.approach);
  const status = useMemo(() => selectDestinationStatus({ destination, approach }), [destination, approach]);
  const srPhase = useSafeReturnPhase();
  const [dismissed, setDismissed] = useState(lateNightDismissed);
  const suggest = !dismissed && !isSafeReturnLive(srPhase) && lateNightNow();
  const near = status?.state === 'near' || status?.state === 'arrived';

  return (
    <View style={{ gap: spacing.xs }} pointerEvents="box-none">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }} keyboardShouldPersistTaps="handled">
        <BreakPill />
        <MyProofButton compact testID="share-proof" />
        <Pressable
          onPress={onPickDestination}
          accessibilityRole="button"
          accessibilityLabel={destination ? `${myDestStatusText(destination.name, status)}. Değiştirmek için dokun.` : 'Hedef seç'}
          testID="share-destination"
          style={({ pressed }) => [
            styles.pill,
            {
              gap: spacing.xs,
              paddingHorizontal: spacing.sm,
              borderRadius: radius.pill,
              backgroundColor: pressed ? colors.border : near ? colors.liveSoft : colors.surfaceAlt,
              borderColor: near ? colors.live : colors.border,
            },
          ]}
        >
          <Icon name="flag" size={18} color={near ? colors.live : colors.text} />
          <Text variant="label" numberOfLines={1} style={near ? { color: colors.live } : undefined}>
            {destination ? myDestStatusText(destination.name, status) : 'Hedef seç'}
          </Text>
        </Pressable>
      </ScrollView>
      {suggest ? (
        <View style={[styles.pill, { gap: spacing.xs, paddingLeft: spacing.sm, borderRadius: radius.md, backgroundColor: colors.primarySoft, borderColor: colors.primary }]} testID="safe-return-suggest">
          <Icon name="moon" size={18} color={colors.primary} />
          <Pressable onPress={onSafeReturn} accessibilityRole="button" style={styles.flex}>
            <Text variant="label" numberOfLines={2}>
              {SAFE_RETURN_TEXT.lateNightHint}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              lateNightDismissed = true;
              setDismissed(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Öneriyi kapat"
            hitSlop={8}
            style={styles.close}
          >
            <Icon name="close" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Faz 12: Mola düğmesi (kapalı → süre seçimi → molada geri sayım + Devam et). */
function BreakPill() {
  const { colors, radius, spacing } = useTheme();
  const brk = useBreakStore((s) => s.brk);
  const [picking, setPicking] = useState(false);
  const now = useNow(brk ? 15_000 : 60_000);
  const on = isOnBreak(brk, Math.max(now, serverNow()));
  const pill = (active: boolean) => [styles.pill, { gap: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.pill, backgroundColor: active ? colors.warningSoft : colors.surfaceAlt, borderColor: active ? colors.warning : colors.border }];
  if (on && brk) {
    const left = Math.max(1, Math.ceil((brk.until - serverNow()) / 60_000));
    return (
      <View style={[styles.row, { gap: spacing.xs }]} testID="break-on">
        <View style={pill(true)} accessible accessibilityLabel={`Moladasın, ${left} dakika kaldı. Yeni konum gitmiyor.`}>
          <Text variant="label">☕ {BREAK_TEXT.on(`${left} dk`)}</Text>
        </View>
        <Pressable onPress={() => breakStore.getState().end()} accessibilityRole="button" testID="break-resume" style={({ pressed }) => [pill(pressed), { borderColor: colors.primary }]}>
          <Text variant="label" style={{ color: colors.primary, fontWeight: '700' }}>
            {BREAK_TEXT.resume}
          </Text>
        </Pressable>
      </View>
    );
  }
  if (picking) {
    return (
      <View style={[styles.row, { gap: spacing.xs }]} testID="break-pick">
        {BREAK_MINUTES.map((m) => (
          <Pressable
            key={m}
            onPress={() => {
              setPicking(false);
              breakStore.getState().start(m);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${m} dakika mola. ${BREAK_TEXT.hint}`}
            testID={`break-${m}`}
            style={({ pressed }) => [pill(pressed), { borderColor: colors.warning }]}
          >
            <Text variant="label">☕ {m} dk</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setPicking(false)} accessibilityRole="button" accessibilityLabel="Vazgeç" hitSlop={6} style={styles.close}>
          <Icon name="close" size={16} color={colors.textSecondary} />
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel="Mola ver" accessibilityHint={BREAK_TEXT.hint} testID="break-open" style={({ pressed }) => pill(pressed)}>
      <Text variant="label">☕ {BREAK_TEXT.action}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH, borderWidth: 1 },
  flex: { flex: 1 },
  close: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
});
