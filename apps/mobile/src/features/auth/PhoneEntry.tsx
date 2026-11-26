/**
 * Telefon girişi: core `normalizePhone` (E.164, Faz 1'de yalnızca TR cep numaraları) → SMS kodu.
 * Geçersiz numara sunucuya hiç gitmez (SMS pompalama savunmasının istemci adımı).
 */
import { normalizePhone, SECURITY_TEXT } from '@konum/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useAuthStore } from '../../state/authStore';
import { Button, MIN_TOUCH, Text, useTheme } from '../../ui';
import { AuthScaffold } from './AuthScaffold';
import { useSecurityStore } from '../../state/securityStore';

const REASON_TEXT = {
  invalid: 'Geçerli bir telefon numarası girin',
  not_mobile_tr: 'Şimdilik yalnızca Türkiye cep telefonu numaraları destekleniyor',
} as const;

export function PhoneEntry() {
  const { colors, radius, spacing, typography } = useTheme();
  const router = useRouter();
  const sendCode = useAuthStore((s) => s.sendCode);
  const busy = useAuthStore((s) => s.busy);
  const serverError = useAuthStore((s) => s.error);
  // Faz 10: bu cihazın oturumu başka cihazdan kapatıldı (yayın durdu, yerel veri silindi).
  const revokedHere = useSecurityStore((s) => s.revokedHere);
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  const result = normalizePhone(value);
  const localError = touched && value.trim() && !result.ok ? REASON_TEXT[result.reason] : null;

  const submit = async () => {
    setTouched(true);
    if (!result.ok) return;
    if (await sendCode(result.e164)) router.push('/otp');
  };

  return (
    <AuthScaffold
      title="Telefon numaran"
      subtitle="Sana bir doğrulama kodu göndereceğiz. Numaran arkadaşlarına gösterilmez."
      footer={<Button title="Kod gönder" size="lg" onPress={submit} loading={busy} disabled={!value.trim()} />}
    >
      {revokedHere ? (
        <View style={{ backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: spacing.sm }} testID="revoked-here">
          <Text variant="label" style={{ color: colors.warning }}>
            {SECURITY_TEXT.revokedHere}
          </Text>
        </View>
      ) : null}
      <View style={[styles.field, { backgroundColor: colors.surface, borderColor: localError ? colors.danger : colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }]}>
        <Text variant="body" color="textSecondary">
          +90
        </Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          onBlur={() => setTouched(true)}
          placeholder="5XX XXX XX XX"
          placeholderTextColor={colors.textSecondary}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          accessibilityLabel="Telefon numarası"
          maxLength={17}
          style={[typography.heading, styles.input, { color: colors.text }]}
          onSubmitEditing={submit}
          autoFocus
        />
      </View>
      {localError || serverError ? (
        <Text variant="label" color="danger" accessibilityLiveRegion="polite">
          {localError ?? serverError}
        </Text>
      ) : null}
      {result.ok ? (
        <Text variant="label" color="textSecondary">
          {result.national}
        </Text>
      ) : null}
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, minHeight: MIN_TOUCH + 12, gap: 8 },
  input: { flex: 1, paddingVertical: 12 },
});
