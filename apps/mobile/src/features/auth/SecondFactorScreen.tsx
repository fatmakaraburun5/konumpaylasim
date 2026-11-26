/**
 * Faz 10: yeni telefonda 2. aşama. SMS ile giriş yapıldı (1. aşama); hesapta doğrulanmış kurtarma e-postası var →
 * e-postaya giden 6 haneli kod. Doğrulanınca oturum bu cihaza bağlanır (`dsid`), arkadaşlar / izinler / favoriler /
 * bölgeler / onaylar sunucudan gelir ve "Aktif Cihazlar ve Oturumlar" açılır (eski cihazı kapatmak için).
 * Emülatör / web demosunda kod yanıtta (`dev_code`) gelir ve ipucu olarak gösterilir; gerçekte yalnızca e-postada.
 */
import { SECURITY_LIMITS, SECURITY_TEXT } from '@konum/core';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useAuthStore } from '../../state/authStore';
import { Button, MIN_TOUCH, Text, useTheme } from '../../ui';
import { AuthScaffold } from './AuthScaffold';

const LEN = SECURITY_LIMITS.otpDigits;

export function SecondFactorScreen() {
  const { colors, radius, spacing, typography } = useTheme();
  const sf = useAuthStore((s) => s.secondFactor);
  const verify = useAuthStore((s) => s.verifySecondFactor);
  const resend = useAuthStore((s) => s.resendSecondFactor);
  const signOut = useAuthStore((s) => s.signOut);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!sf) return null;
  const wait = Math.max(0, Math.ceil((sf.challenge.resend_at - now) / 1000));
  const submit = async (v = code) => {
    if (v.length === LEN) await verify(v);
  };

  return (
    <AuthScaffold
      title={SECURITY_TEXT.newDeviceTitle}
      subtitle={SECURITY_TEXT.newDeviceBody(sf.challenge.to_masked)}
      footer={
        <>
          <Button title={SECURITY_TEXT.verify} size="lg" onPress={() => void submit()} loading={busy} disabled={code.length !== LEN} testID="second-factor-verify" />
          <Button
            title={wait > 0 ? `${SECURITY_TEXT.resend} (${wait} sn)` : SECURITY_TEXT.resend}
            variant="ghost"
            disabled={wait > 0 || busy}
            onPress={() => void resend()}
          />
          <Button title="Vazgeç ve çık" variant="ghost" onPress={() => void signOut()} />
        </>
      }
    >
      <View style={[styles.step, { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm }]}>
        <Text variant="label">✓ 1. adım: SMS ile telefon numaran doğrulandı</Text>
        <Text variant="label" color="primary">2. adım: E-posta / Gmail kodu</Text>
        <Text variant="caption" color="textSecondary">{`Cihaz: ${sf.model}`}</Text>
      </View>
      <TextInput
        value={code}
        onChangeText={(v) => {
          const d = v.replace(/\D/g, '').slice(0, LEN);
          setCode(d);
          if (d.length === LEN) void submit(d);
        }}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        accessibilityLabel="E-posta doğrulama kodu"
        testID="second-factor-code"
        maxLength={LEN}
        autoFocus
        style={[
          typography.title,
          styles.input,
          { color: colors.text, backgroundColor: colors.surface, borderColor: error ? colors.danger : colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md },
        ]}
      />
      {sf.challenge.dev_code ? (
        <View style={[styles.hint, { backgroundColor: colors.primarySoft, borderRadius: radius.md, padding: spacing.sm }]}>
          <Text variant="label" color="primary">{`Demo: e-postaya giden kod ${sf.challenge.dev_code}`}</Text>
          <Text variant="caption" color="textSecondary">Önizlemede e-posta gönderilmez.</Text>
        </View>
      ) : null}
      {error ? (
        <Text variant="label" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1.5, minHeight: MIN_TOUCH + 12, letterSpacing: 8, textAlign: 'center' },
  hint: { gap: 2, alignItems: 'center' },
  step: { gap: 2 },
});
