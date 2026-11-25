/**
 * Faz 8: Profil > "Sözleşme ve KVKK" kartı (docs/PHASE8.md §5.2): sürüm, onay tarihi, "Metni görüntüle" (salt okunur)
 * ve "Açık rızamı geri çek" (iki adımlı onay → `consent_withdraw` → uygulama onay kapısına döner).
 */
import { CONSENT_UI_TEXT, consentNewerThanApp } from '@konum/core';
import { useRouter } from 'expo-router';
import { Alert, View } from 'react-native';
import { useAuthStore } from '../../state/authStore';
import { consentStore, useConsentStore } from '../../state/consentStore';
import { Button, cardShadow, Text, useTheme } from '../../ui';
import { formatConsentAcceptedAt } from './consentModel';

export function ConsentCard() {
  const { colors, radius, spacing } = useTheme();
  const router = useRouter();
  const consent = useAuthStore((s) => s.profile?.consent ?? null);
  const busy = useConsentStore((s) => s.busy);

  const withdraw = async () => {
    const r = await consentStore.getState().withdraw();
    // Başarıda profil `consent: null` olur ve (main) yerleşimi onay kapısını gösterir.
    if (!r.ok) Alert.alert('Geri çekilemedi', r.message);
  };

  const confirmWithdraw = () =>
    Alert.alert(CONSENT_UI_TEXT.withdrawConfirmTitle, CONSENT_UI_TEXT.withdrawConfirmBody, [
      { text: CONSENT_UI_TEXT.cancel, style: 'cancel' },
      {
        text: 'Devam',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Emin misin?', 'Onay ekranına dönersin; yeniden onaylayana kadar uygulama kullanılamaz.', [
            { text: CONSENT_UI_TEXT.cancel, style: 'cancel' },
            { text: CONSENT_UI_TEXT.withdrawAction, style: 'destructive', onPress: () => void withdraw() },
          ]),
      },
    ]);

  return (
    <View testID="profile-consent-card" style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }]}>
      <Text variant="heading">{CONSENT_UI_TEXT.cardTitle}</Text>
      <View style={{ gap: 2 }}>
        <Text variant="label" color="textSecondary">
          {consent ? CONSENT_UI_TEXT.versionLine(consent.version) : CONSENT_UI_TEXT.versionLine()}
        </Text>
        {consent ? (
          <Text variant="label" color="textSecondary">
            {`${CONSENT_UI_TEXT.acceptedAtLabel}: ${formatConsentAcceptedAt(consent.accepted_at)}`}
          </Text>
        ) : null}
        {consentNewerThanApp(consent) ? (
          <Text variant="label" color="warning" testID="profile-consent-update-app">
            {CONSENT_UI_TEXT.updateApp}
          </Text>
        ) : null}
      </View>
      <Button title={CONSENT_UI_TEXT.viewText} variant="secondary" onPress={() => router.push('/consent')} testID="profile-consent-view" />
      <Button title={CONSENT_UI_TEXT.withdraw} variant="danger" onPress={confirmWithdraw} loading={busy} testID="profile-consent-withdraw" />
    </View>
  );
}
