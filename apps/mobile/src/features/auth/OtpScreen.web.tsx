/**
 * YALNIZCA web demo: OtpScreen.tsx ile aynı ekran + "Demo kodu: 123456" ipucu (SMS gönderilmez).
 * Native paket OtpScreen.tsx'i kullanır; bu dosya Metro'nun `.web.tsx` uzantısıyla yalnızca tarayıcıda seçilir.
 */
import { maskPhone } from '@konum/core';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { DEMO_OTP } from '../../demo/server';
import { useAuthStore } from '../../state/authStore';
import { Button, MIN_TOUCH, Text, useTheme } from '../../ui';
import { AuthScaffold } from './AuthScaffold';

const CODE_LENGTH = 6;
/** [Varsayım] Yeniden gönderme bekleme süresi. */
const RESEND_AFTER_S = 60;

export function OtpScreen() {
  const { colors, radius, spacing, typography } = useTheme();
  const router = useRouter();
  const phone = useAuthStore((s) => s.pendingPhone);
  const confirmCode = useAuthStore((s) => s.confirmCode);
  const sendCode = useAuthStore((s) => s.sendCode);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(RESEND_AFTER_S);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = async (value = code) => {
    if (value.length !== CODE_LENGTH) return;
    await confirmCode(value);
  };

  const onChange = (v: string) => {
    const digits = v.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) void submit(digits);
  };

  return (
    <AuthScaffold
      title="Doğrulama kodu"
      subtitle={phone ? `${maskPhone(phone)} numarasına gönderilen 6 haneli kodu gir.` : 'Telefonuna gönderilen 6 haneli kodu gir.'}
      footer={
        <>
          <Button title="Doğrula" size="lg" onPress={() => void submit()} loading={busy} disabled={code.length !== CODE_LENGTH} />
          <Button
            title={wait > 0 ? `Kodu yeniden gönder (${wait} sn)` : 'Kodu yeniden gönder'}
            variant="ghost"
            disabled={wait > 0 || !phone || busy}
            onPress={async () => {
              if (phone && (await sendCode(phone))) setWait(RESEND_AFTER_S);
            }}
          />
          <Button title="Numarayı değiştir" variant="ghost" onPress={() => router.back()} />
        </>
      }
    >
      <TextInput
        value={code}
        onChangeText={onChange}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        accessibilityLabel="Doğrulama kodu"
        maxLength={CODE_LENGTH}
        autoFocus
        style={[
          typography.title,
          styles.input,
          { color: colors.text, backgroundColor: colors.surface, borderColor: error ? colors.danger : colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md },
        ]}
      />
      <View
        style={[styles.hint, { backgroundColor: colors.primarySoft, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }]}
        accessible
        accessibilityLabel={`Demo kodu: ${DEMO_OTP}`}
      >
        <Text variant="label" color="primary">
          {`Demo kodu: ${DEMO_OTP}`}
        </Text>
        <Text variant="caption" color="textSecondary">
          Web önizlemesinde SMS gönderilmez.
        </Text>
      </View>
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
});
