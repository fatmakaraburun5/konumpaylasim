/**
 * Faz 9: çevrimdışı SOS yedeği (kırmızı SOS ekranlarında) — docs/PHASE9.md §4.4, core `offlineSosDecision`.
 *
 *   'offer_sms'          → büyük "SMS ile gönder (N kişi)": telefonun mesaj uygulaması hazır dolu açılır
 *                          (son doğrulanmış konum, saat, pil, harita bağlantısı); Gönder'e kullanıcı dokunur
 *   'sms_not_configured' → nasıl açılacağı + "SMS yedeğini aç" (SMS yedeği sayfası)
 *   'sms_unavailable'    → bu cihaz SMS gönderemiyor notu
 *   her durumda "112'yi ara"
 * SOS arka planda (aynı op_id ile) yeniden denenmeye devam eder.
 */
import { SMS_FALLBACK_TEXT, type OfflineSosDecision } from '@konum/core';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { sosStore, type SosSmsResult } from '../../state/sosStore';
import { useSmsFallbackStore } from '../../state/smsFallbackStore';
import { Text, useTheme } from '../../ui';
import { BigButton } from '../sos/BigButton';
import { callEmergency } from '../sos/SosActiveScreen';

export interface OfflineSosPanelProps {
  decision: OfflineSosDecision;
  /** "SMS yedeğini aç": ekran kapanır, SMS yedeği sayfası açılır (verilmezse düğme yok). */
  onOpenSettings?: () => void;
  /** Güvenli Dönüş son uyarısı: SMS'e "Güvenli Dönüş: Ev hedefine varamadım" satırı (verilmezse etkin hedef). */
  safeReturnDest?: string | null;
  /** 112 düğmesi gösterilsin mi (ekranda zaten varsa false). */
  show112?: boolean;
}

const RESULT_TEXT: Record<SosSmsResult, string> = {
  ...SMS_FALLBACK_TEXT.sentResult,
  unavailable: SMS_FALLBACK_TEXT.unavailable,
  not_configured: SMS_FALLBACK_TEXT.notConfigured,
};

export function OfflineSosPanel({ decision, onOpenSettings, safeReturnDest, show112 = true }: OfflineSosPanelProps) {
  const { spacing, radius } = useTheme();
  const count = useSmsFallbackStore((s) => s.settings.numbers.length);
  const [result, setResult] = useState<SosSmsResult | null>(null);
  const [busy, setBusy] = useState(false);
  if (decision === 'online') return null;

  const send = async () => {
    setBusy(true);
    try {
      const r = await sosStore.getState().sendSms(safeReturnDest !== undefined ? { safeReturnDest } : undefined);
      setResult(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: spacing.sm }} testID="offline-sos-panel">
      <View style={[styles.box, { borderRadius: radius.lg, padding: spacing.sm, gap: spacing.xxs }]}>
        <Text variant="heading" style={styles.fg}>
          {SMS_FALLBACK_TEXT.offlineTitle}
        </Text>
        <Text variant="label" style={styles.fgSoft} testID={`offline-sos-${decision}`}>
          {decision === 'offer_sms' ? SMS_FALLBACK_TEXT.offlineBody : decision === 'sms_not_configured' ? SMS_FALLBACK_TEXT.notConfigured : SMS_FALLBACK_TEXT.unavailable}
        </Text>
        {result ? (
          <Text variant="label" style={[styles.fg, { fontWeight: '700' }]} accessibilityLiveRegion="polite">
            {RESULT_TEXT[result]}
          </Text>
        ) : null}
      </View>
      {decision === 'offer_sms' ? (
        <BigButton title={busy ? 'Mesaj hazırlanıyor…' : SMS_FALLBACK_TEXT.sendSms(count)} onPress={() => void send()} solid disabled={busy} hint="Mesaj uygulaması hazır dolu açılır; Gönder'e sen dokunursun" />
      ) : decision === 'sms_not_configured' && onOpenSettings ? (
        <BigButton title="SMS yedeğini aç" onPress={onOpenSettings} small />
      ) : null}
      {show112 ? <BigButton title={SMS_FALLBACK_TEXT.call112} onPress={callEmergency} small={decision === 'offer_sms'} solid={decision !== 'offer_sms'} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: 'rgba(0,0,0,0.22)' },
  fg: { color: '#FFFFFF' },
  fgSoft: { color: 'rgba(255,255,255,0.9)' },
});
