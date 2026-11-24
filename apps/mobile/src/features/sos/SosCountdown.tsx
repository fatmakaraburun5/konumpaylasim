/**
 * Faz 4: SOS gönderim öncesi tam ekran geri sayım (core `sosCountdownLeft`, 5 → 1). Büyük "İptal" ve "Hemen gönder",
 * uyarının kime gideceği ve şu anki konum doğruluğu. Süre dolunca gönderim kendiliğinden başlar (sosFlowReduce
 * `tick`). Gönderim sürerken "Gönderiliyor…", başarısızsa hata + "Tekrar gönder".
 */
import { formatAccuracyTr, SOS_LIMITS, SOS_MESSAGE, type SosFlowState } from '@konum/core';
import { useEffect } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lightColors, Overlay, Text, useTheme } from '../../ui';
import { SOS_FG } from './sosModel';

export interface SosCountdownProps {
  flow: SosFlowState;
  secondsLeft: number;
  recipients: readonly string[];
  /** Son bilinen konum doğruluğu (m); yoksa null. */
  accuracyM: number | null;
  onCancel: () => void;
  onSendNow: () => void;
  onRetry: () => void;
}

export function SosCountdown({ flow, secondsLeft, recipients, accuracyM, onCancel, onSendNow, onRetry }: SosCountdownProps) {
  const { radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const visible = flow.phase === 'countdown' || flow.phase === 'sending' || flow.phase === 'error';

  useEffect(() => {
    if (flow.phase === 'countdown') {
      AccessibilityInfo.announceForAccessibility?.(`Acil durum uyarısı ${SOS_LIMITS.countdownS} saniye içinde gönderilecek. İptal etmek için İptal düğmesine dokun.`);
    }
  }, [flow.phase]);

  const to = recipients.length > 0 ? recipients.join(', ') : 'Acil durum kişilerin';

  return (
    <Overlay visible={visible} onRequestClose={flow.phase === 'sending' ? undefined : onCancel} testID="sos-countdown">
      <View style={[styles.root, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.lg }]}>
        <View style={{ gap: spacing.xs }}>
          <Text variant="title" style={styles.fg} accessibilityRole="header">
            {flow.phase === 'error' ? 'Uyarı gönderilemedi' : flow.phase === 'sending' ? 'Uyarı gönderiliyor…' : 'Acil durum uyarısı'}
          </Text>
          <Text variant="body" style={styles.fgSoft}>
            {`“${SOS_MESSAGE}”`}
          </Text>
        </View>

        <View style={styles.center}>
          {flow.phase === 'countdown' ? (
            <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${secondsLeft} saniye sonra gönderilecek`} style={styles.center}>
              <Text style={[styles.fg, styles.big]} maxFontSizeMultiplier={1}>
                {String(secondsLeft)}
              </Text>
              <Text variant="heading" style={styles.fg}>
                saniye sonra gönderilecek
              </Text>
            </View>
          ) : flow.phase === 'sending' ? (
            <View style={[styles.center, { gap: spacing.sm }]}>
              <ActivityIndicator size="large" color={SOS_FG} />
              <Text variant="heading" style={styles.fg}>
                Tam konumun alınıyor ve gönderiliyor…
              </Text>
            </View>
          ) : flow.phase === 'error' ? (
            <Text variant="heading" style={[styles.fg, { textAlign: 'center' }]} accessibilityLiveRegion="assertive">
              {flow.message}
            </Text>
          ) : null}
        </View>

        <View style={[styles.info, { borderRadius: radius.lg, padding: spacing.md, gap: spacing.xxs }]}>
          <Text variant="label" style={styles.fgSoft}>
            Kime
          </Text>
          <Text variant="heading" style={styles.fg} numberOfLines={2}>
            {to}
          </Text>
          <Text variant="label" style={[styles.fgSoft, { marginTop: spacing.xs }]}>
            Gidecek bilgiler
          </Text>
          <Text variant="body" style={styles.fg}>
            {`Tam konum${accuracyM !== null ? ` (${formatAccuracyTr(accuracyM)})` : ''}, adres, harita bağlantısı, pil ve varsa rotan`}
          </Text>
        </View>

        <View style={{ gap: spacing.sm }}>
          {flow.phase === 'error' ? (
            <BigButton title="Tekrar gönder" onPress={onRetry} solid />
          ) : (
            <BigButton title="Hemen gönder" onPress={onSendNow} solid disabled={flow.phase !== 'countdown'} />
          )}
          <BigButton title={flow.phase === 'error' ? 'Kapat' : 'İptal'} onPress={onCancel} disabled={flow.phase === 'sending'} />
        </View>
      </View>
    </Overlay>
  );
}

/** Büyük dokunma alanlı düğme (en az 64 pt). `solid`: beyaz zemin, kırmızı yazı. */
export function BigButton({
  title,
  onPress,
  solid = false,
  disabled = false,
  hint,
  small = false,
}: {
  title: string;
  onPress: () => void;
  solid?: boolean;
  disabled?: boolean;
  hint?: string;
  /** Yan yana iki düğme için daha küçük yazı. */
  small?: boolean;
}) {
  const { radius } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.big_btn,
        {
          borderRadius: radius.lg,
          backgroundColor: solid ? (pressed ? lightColors.dangerSoft : SOS_FG) : pressed ? 'rgba(255,255,255,0.18)' : 'transparent',
          borderColor: SOS_FG,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text variant={small ? 'heading' : 'title'} style={{ color: solid ? lightColors.danger : SOS_FG }} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: lightColors.danger },
  fg: { color: SOS_FG },
  fgSoft: { color: 'rgba(255,255,255,0.88)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  big: { fontSize: 120, lineHeight: 132, fontWeight: '800', fontVariant: ['tabular-nums'] },
  info: { backgroundColor: 'rgba(0,0,0,0.18)' },
  big_btn: { minHeight: 64, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
});
