/**
 * Faz 9: SMS acil numaraları düzenleyicisi (SMS yedeği sayfası ve ilk açılış `sms` adımı).
 *
 *   liste: "Annem · +90 5•• ••• 45 67" (core `formatSmsNumber`) · kaldır
 *   "Rehberden seç": sistem kişi seçici; yalnızca seçilen numara bu telefonda saklanır (rehber okunmaz / yüklenmez).
 *     Birden çok numarası olan kişide numara seçtirilir.
 *   "Numara yaz": ad + telefon (E.164'e çevrilir; en çok 5)
 */
import { formatSmsNumber, SMS_FALLBACK_LIMITS, SMS_FALLBACK_TEXT } from '@konum/core';
import { useState } from 'react';
import { Linking, StyleSheet, TextInput, View } from 'react-native';
import type { PickedPhone } from '../../services/permissions/contactsPermissions';
import { smsFallbackStore, useSmsFallbackStore } from '../../state/smsFallbackStore';
import { Button, Chip, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';

export function SmsNumbers({ compact = false }: { compact?: boolean }) {
  const { colors, radius, spacing, typography } = useTheme();
  const numbers = useSmsFallbackStore((s) => s.settings.numbers);
  const [message, setMessage] = useState<string | null>(null);
  const [settingsLink, setSettingsLink] = useState(false);
  const [choose, setChoose] = useState<{ name: string; phones: PickedPhone[] } | null>(null);
  const [manual, setManual] = useState(false);
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const full = numbers.length >= SMS_FALLBACK_LIMITS.maxNumbers;

  const pick = async () => {
    setMessage(null);
    setSettingsLink(false);
    setChoose(null);
    setBusy(true);
    try {
      const r = await smsFallbackStore.getState().pickFromContacts();
      if (r.ok) return;
      if (r.reason === 'choose') setChoose({ name: r.name, phones: r.phones });
      else if (r.reason !== 'cancelled') {
        setMessage(r.message);
        setSettingsLink(r.reason === 'denied' && r.canAskAgain === false);
      }
    } finally {
      setBusy(false);
    }
  };

  const addPicked = async (p: PickedPhone) => {
    const name = choose?.name || 'Acil kişi';
    setChoose(null);
    const r = await smsFallbackStore.getState().addNumber({ label: name, phone: p.number, source: 'contacts' });
    setMessage(r.ok ? null : r.message);
  };

  const addManual = async () => {
    const r = await smsFallbackStore.getState().addNumber({ label: label.trim() || 'Acil kişi', phone, source: 'manual' });
    if (!r.ok) {
      setMessage(r.message);
      return;
    }
    setMessage(null);
    setLabel('');
    setPhone('');
    setManual(false);
  };

  const input = [typography.body, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.sm }];

  return (
    <View style={{ gap: spacing.sm }} testID="sms-numbers">
      {!compact ? (
        <Text variant="caption" color="textSecondary">
          {SMS_FALLBACK_TEXT.numbersHint}
        </Text>
      ) : null}
      {numbers.map((n) => (
        <View key={n.e164} style={[styles.row, { gap: spacing.xs, minHeight: MIN_TOUCH }]} testID={`sms-number-${n.e164}`}>
          <Text variant="body" style={styles.flex} numberOfLines={1}>
            {formatSmsNumber(n)}
          </Text>
          <IconButton icon="close" accessibilityLabel={`${n.label} numarasını kaldır`} onPress={() => void smsFallbackStore.getState().removeNumber(n.e164)} size={36} />
        </View>
      ))}

      {choose ? (
        <View style={{ gap: spacing.xs }}>
          <Text variant="label">{`${choose.name}: hangi numara?`}</Text>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {choose.phones.map((p) => (
              <Chip key={`${p.label}:${p.number}`} label={`${p.label ? `${p.label} · ` : ''}${p.number}`} onPress={() => void addPicked(p)} />
            ))}
            <Chip label="Vazgeç" onPress={() => setChoose(null)} />
          </View>
        </View>
      ) : null}

      {manual ? (
        <View style={{ gap: spacing.xs }}>
          <TextInput value={label} onChangeText={setLabel} placeholder="Ad (ör. Annem)" placeholderTextColor={colors.textSecondary} accessibilityLabel="Kişinin adı" maxLength={SMS_FALLBACK_LIMITS.labelMaxChars} style={input} />
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="05xx xxx xx xx"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Telefon numarası"
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            style={input}
            testID="sms-manual-phone"
          />
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Button title="Vazgeç" variant="ghost" onPress={() => setManual(false)} style={styles.flex} block={false} />
            <Button title="Ekle" onPress={() => void addManual()} disabled={phone.trim().length === 0} style={styles.flex} block={false} testID="sms-manual-add" />
          </View>
        </View>
      ) : null}

      {message ? (
        <Text variant="label" color="danger" accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      {settingsLink ? <Button title="Ayarları aç" variant="secondary" onPress={() => void Linking.openSettings().catch(() => undefined)} /> : null}

      {full ? (
        <Text variant="caption" color="textSecondary">
          {SMS_FALLBACK_TEXT.limitReached}
        </Text>
      ) : !manual ? (
        <View style={[styles.row, { gap: spacing.xs }]}>
          <Button title={SMS_FALLBACK_TEXT.pickFromContacts} variant="secondary" onPress={() => void pick()} loading={busy} style={styles.flex} block={false} testID="sms-pick-contacts" />
          <Button title={SMS_FALLBACK_TEXT.addManual} variant="secondary" onPress={() => setManual(true)} style={styles.flex} block={false} testID="sms-add-manual" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  input: { minHeight: MIN_TOUCH + 4 },
});
