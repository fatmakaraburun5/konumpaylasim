/**
 * Faz 8: Güvenlik Sözleşmesi ve KVKK Aydınlatma / Açık Rıza Metni (docs/PHASE8.md §5.1).
 *
 *  - `ConsentGate`: (main) yerleşiminde cinsiyet kapısından sonra, oturum servisleri başlamadan gösterilir. Başlık,
 *    sürüm + tarih, (yeniden onayda) "Metin güncellendi" ve değişiklik özeti, kaydırılabilir tam metin (core
 *    `CONSENT_DOCUMENT`), altta sabit "Okudum, Onaylıyorum". Düğme metin sonuna kadar kaydırılana kadar pasiftir
 *    (core `isScrolledToBottom`; karar `consentModel`). Onaylanınca profil güncellenir ve kapı kendiliğinden kalkar.
 *    Onay vermeden: "Paylaşımlarımı durdur ve görünmez ol" (`invisible_set`, onaydan muaf) tüm paylaşımları ve QR
 *    bağlantılarını sunucuda bitirir; "Çıkış yap" paylaşımları durdurmaz.
 *  - `ConsentReader`: Profil > "Metni görüntüle" (`/consent`): aynı metin, onay düğmesi yok.
 * Gösterilen metin = onaylanan metin: bölümler core'dan gelir, sunucu sürüm + özeti denetler.
 */
import { CONSENT_CHANGES, CONSENT_DOCUMENT, CONSENT_TITLE, CONSENT_UI_TEXT, type ScrollMetrics } from '@konum/core';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../state/authStore';
import { consentStore, useConsentStore } from '../../state/consentStore';
import { invisibleStore, useInvisibleStore, useIsInvisible } from '../../state/invisibleStore';
import { Button, IconButton, Text, useTheme } from '../../ui';
import { consentFooterView, consentGateMode, formatConsentAcceptedAt, latchScrolled } from './consentModel';

/** Metin bölümleri (başlık, paragraflar, maddeler, kapanış). */
function ConsentBody() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.lg }}>
      {CONSENT_DOCUMENT.map((s) => (
        <View key={s.id} style={{ gap: spacing.xs }}>
          <Text variant="heading" accessibilityRole="header">
            {s.heading}
          </Text>
          {(s.paragraphs ?? []).map((p, i) => (
            <Text key={`p${i}`} variant="body">
              {p}
            </Text>
          ))}
          {(s.bullets ?? []).map((b, i) => (
            <View key={`b${i}`} style={[styles.bullet, { gap: spacing.xs }]}>
              <Text variant="body">•</Text>
              <Text variant="body" style={styles.flex}>
                {b}
              </Text>
            </View>
          ))}
          {(s.closing ?? []).map((p, i) => (
            <Text key={`c${i}`} variant="body">
              {p}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function ChangesBox() {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      testID="consent-changes"
      style={{ backgroundColor: colors.primarySoft, borderColor: colors.primary, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: spacing.xxs }}
    >
      <Text variant="heading" color="primary">
        {CONSENT_UI_TEXT.changesTitle}
      </Text>
      {CONSENT_CHANGES.map((c, i) => (
        <View key={i} style={[styles.bullet, { gap: spacing.xs }]}>
          <Text variant="label">•</Text>
          <Text variant="label" style={styles.flex}>
            {c}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Header({ left, right, badge, extra }: { left?: ReactNode; right?: ReactNode; badge?: boolean; extra?: string | null }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.xxs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
      {left || right ? (
        <View style={styles.headRow}>
          {left ?? <View />}
          {right ?? null}
        </View>
      ) : null}
      {badge ? (
        <View style={[styles.badge, { backgroundColor: colors.warningSoft, borderRadius: radius.pill, paddingHorizontal: spacing.sm }]}>
          <Text variant="caption" style={{ color: colors.warning }}>
            {CONSENT_UI_TEXT.updatedBadge}
          </Text>
        </View>
      ) : null}
      <Text variant="title" accessibilityRole="header">
        {CONSENT_TITLE}
      </Text>
      <Text variant="label" color="textSecondary">
        {CONSENT_UI_TEXT.versionLine()}
      </Text>
      {extra ? (
        <Text variant="label" color="textSecondary">
          {extra}
        </Text>
      ) : null}
    </View>
  );
}

export function ConsentGate() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const consent = useAuthStore((s) => s.profile?.consent ?? null);
  const signOut = useAuthStore((s) => s.signOut);
  const busy = useConsentStore((s) => s.busy);
  const error = useConsentStore((s) => s.error);
  const mode = consentGateMode(consent);
  const metrics = useRef<ScrollMetrics>({ offsetY: 0, viewportH: 0, contentH: 0 });
  const [scrolled, setScrolled] = useState(false);

  const update = useCallback((patch: Partial<ScrollMetrics>) => {
    metrics.current = { ...metrics.current, ...patch };
    setScrolled((prev) => latchScrolled(prev, metrics.current));
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      update({ offsetY: contentOffset.y, viewportH: layoutMeasurement.height, contentH: contentSize.height });
    },
    [update],
  );
  const onLayout = useCallback((e: LayoutChangeEvent) => update({ viewportH: e.nativeEvent.layout.height }), [update]);
  const onContentSize = useCallback((_w: number, h: number) => update({ contentH: h }), [update]);

  const footer = consentFooterView({ scrolled, busy, error });
  const invisible = useIsInvisible();
  const stopping = useInvisibleStore((s) => s.busy === 'on');
  const [stopError, setStopError] = useState<string | null>(null);
  const stopAll = async () => {
    setStopError(null);
    const r = await invisibleStore.getState().setInvisible(true);
    if (!r.ok) setStopError(r.message);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID="consent-gate">
      <Header
        badge={mode === 'updated'}
        right={<Button title="Çıkış yap" variant="ghost" block={false} onPress={() => void signOut()} disabled={busy} testID="consent-sign-out" />}
        left={<View />}
      />
      <ScrollView
        testID="consent-scroll"
        onScroll={onScroll}
        onLayout={onLayout}
        onContentSizeChange={onContentSize}
        scrollEventThrottle={32}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xl }}
      >
        {mode === 'updated' ? (
          <>
            <Text variant="body" color="textSecondary">
              {CONSENT_UI_TEXT.outdated}
            </Text>
            <ChangesBox />
          </>
        ) : null}
        <ConsentBody />
      </ScrollView>
      <View
        style={{
          backgroundColor: colors.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingHorizontal: spacing.md,
          paddingTop: spacing.sm,
          paddingBottom: insets.bottom + spacing.sm,
          gap: spacing.xs,
        }}
      >
        <Button
          title={CONSENT_UI_TEXT.accept}
          size="lg"
          testID="consent-accept"
          disabled={footer.disabled}
          loading={busy}
          accessibilityHint={footer.disabled ? CONSENT_UI_TEXT.scrollHint : undefined}
          onPress={() => void consentStore.getState().accept()}
        />
        <Text
          variant="label"
          align="center"
          color={footer.tone === 'error' ? 'danger' : 'textSecondary'}
          accessibilityLiveRegion="polite"
          testID="consent-note"
        >
          {footer.note}
        </Text>
        {invisible && !stopError ? (
          <Text variant="caption" align="center" color="textSecondary" testID="consent-stop-all-done">
            {CONSENT_UI_TEXT.stopAllDone}
          </Text>
        ) : (
          <Button
            title={CONSENT_UI_TEXT.stopAll}
            variant="ghost"
            testID="consent-stop-all"
            loading={stopping}
            disabled={busy}
            onPress={() => void stopAll()}
          />
        )}
        {stopError ? (
          <Text variant="caption" align="center" color="danger" accessibilityLiveRegion="polite">
            {stopError}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Profil > "Metni görüntüle": salt okunur, onay düğmesi yok. */
export function ConsentReader() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const consent = useAuthStore((s) => s.profile?.consent ?? null);
  const accepted = consent ? `${CONSENT_UI_TEXT.acceptedAtLabel}: ${formatConsentAcceptedAt(consent.accepted_at)}` : null;
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID="consent-reader">
      <Header left={<IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />} extra={accepted} />
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}>
        <ConsentBody />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  bullet: { flexDirection: 'row', alignItems: 'flex-start' },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  badge: { alignSelf: 'flex-start', minHeight: 22, justifyContent: 'center' },
});
