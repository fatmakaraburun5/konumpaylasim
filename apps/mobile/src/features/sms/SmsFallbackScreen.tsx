/**
 * Faz 9: SMS ile acil durum yedeği (app/(main)/sms-fallback.tsx; Gizlilik Merkezi "SMS ile acil durum yedeği" satırı
 * ve çevrimdışı SOS ekranı açar) — docs/PHASE9.md §4.
 *
 *   açıklama (core `SMS_FALLBACK_TEXT`): ne zaman, ne gider; iOS / Android notu; SMS operatörden şifresiz gider
 *   AÇIK ONAY: onay kutusu + "SMS yedeğini aç" (kutu işaretlenmeden açılmaz) · açıkken "Kapat"
 *   numaralar: rehberden seç (rehber izni; yalnızca seçilen numara cihazda kalır) / elle yaz / kaldır
 *   örnek mesaj önizlemesi (core `sosSmsBody`)
 *
 * Tercih ve numaralar yalnızca bu telefonda saklanır; sunucuya gitmez. Uygulama SMS göndermez / okumaz: mesaj
 * uygulaması hazır dolu açılır, Gönder'e kullanıcı dokunur. `SEND_SMS` izni yoktur.
 */
import { SMS_FALLBACK_TEXT, smsFallbackStatus } from '@konum/core';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { smsFallbackStore, useSmsFallbackStore } from '../../state/smsFallbackStore';
import { sosStore } from '../../state/sosStore';
import { Button, cardShadow, CheckRow, IconButton, Text, useTheme } from '../../ui';
import { SmsNumbers } from './SmsNumbers';

export function SmsFallbackScreen() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const hydrated = useSmsFallbackStore((s) => s.hydrated);
  const settings = useSmsFallbackStore((s) => s.settings);
  const available = useSmsFallbackStore((s) => s.available);
  const [consent, setConsent] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) void smsFallbackStore.getState().hydrate();
    else void smsFallbackStore.getState().refreshAvailability();
  }, [hydrated]);
  useEffect(() => {
    void sosStore
      .getState()
      .smsBody({ safeReturnDest: null })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, []);

  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const platformNote = Platform.OS === 'ios' ? SMS_FALLBACK_TEXT.iosNote : SMS_FALLBACK_TEXT.androidNote;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID="sms-fallback-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <Text variant="title" accessibilityRole="header" style={styles.flex} numberOfLines={1}>
          {SMS_FALLBACK_TEXT.title}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }} keyboardShouldPersistTaps="handled">
        <View style={card}>
          <Text variant="body">{SMS_FALLBACK_TEXT.body}</Text>
          <Text variant="caption" color="textSecondary">
            {platformNote}
          </Text>
          <Text variant="caption" color="textSecondary">
            {SMS_FALLBACK_TEXT.costNote}
          </Text>
          {available === false ? (
            <Text variant="label" color="warning" testID="sms-unavailable">
              {SMS_FALLBACK_TEXT.unavailable}
            </Text>
          ) : null}
        </View>

        <View style={card} testID="sms-consent">
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Text variant="heading" style={styles.flex}>
              Durum
            </Text>
            <Text variant="label" style={{ color: settings.enabled ? colors.live : colors.textSecondary }} testID="sms-status">
              {smsFallbackStatus(settings)}
            </Text>
          </View>
          {settings.enabled ? (
            <Button title="SMS yedeğini kapat" variant="danger" onPress={() => void smsFallbackStore.getState().disable()} testID="sms-disable" />
          ) : (
            <>
              <CheckRow checked={consent} onPress={() => setConsent((c) => !c)} title={SMS_FALLBACK_TEXT.consent} testID="sms-consent-check" />
              <Button
                title="SMS yedeğini aç"
                onPress={() => void smsFallbackStore.getState().enable(consent)}
                disabled={!consent || available === false}
                testID="sms-enable"
              />
            </>
          )}
        </View>

        <View style={card}>
          <Text variant="heading">{SMS_FALLBACK_TEXT.numbersTitle}</Text>
          <SmsNumbers />
          {settings.enabled && settings.numbers.length === 0 ? (
            <Text variant="caption" color="warning">
              En az bir numara ekle; numara yokken SMS önerilmez.
            </Text>
          ) : null}
        </View>

        {preview ? (
          <View style={card}>
            <Text variant="heading">Örnek mesaj</Text>
            <View style={[styles.preview, { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.sm }]}>
              <Text variant="label" selectable>
                {preview}
              </Text>
            </View>
            <Text variant="caption" color="textSecondary">
              Gönderirken son doğrulanmış konumun, saat ve pil yüzden o anki değerlerle doldurulur.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  preview: {},
});
