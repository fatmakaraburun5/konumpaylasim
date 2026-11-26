/**
 * Web önizleme · Faz 7 (yalnızca tarayıcı paketi): "FAZ 7 SENARYOLARI" panel grubu.
 *
 *  - "Ayşe etkinliğe davet etsin": yarın için 3 mekanlı, 2 saat seçenekli etkinlik → sana davet (push + Etkinlikler).
 *    Katılımını, mekanı ve saati tek seferde işaretleyip gönderince sonuçlar Ayşe'ye düşer, Ayşe birkaç saniyede onaylar.
 *  - Kendi etkinliğinde: Ayşe / Mehmet / Zeynep birkaç saniye içinde "Katılacağım" der ve birer mekan + saat seçer, Can
 *    "Katılamayacağım" + not bırakır; herkes yanıtlayınca sonuçların tamamı sana gelir, sen onaylarsın.
 *  - "Hatırlatmayı şimdi gönder": kesinleşmiş etkinliğin sıradaki hatırlatması (1 gün önce / sabah 08:00) hemen gider.
 *  - "Mehmet yola çıksın": paylaşan arkadaştan "Mehmet yola çıktı" heads-up bildirimi (demo: 30 dk soğuma sıfırlanır).
 * Altta etkinlik sayısı, gizlilik tercihlerin (pil paylaşımı varsayılan KAPALI) ve son "yola çıktı" raporun görünür.
 */
import type { ReactElement } from 'react';
import { View } from 'react-native';
import { ERROR_CODES, type ErrorCode } from '@konum/core';
import { Text } from '../../ui';
import { demoControls, type DemoSnapshot } from '../controls';
import type { ControlRow } from './Faz3.web';

interface Faz7Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactElement;
}

const MOVEMENT_STATUS_TEXT: Record<string, string> = {
  sent: 'gönderildi',
  cooldown: 'soğumada (30 dk)',
  no_recipients: 'alıcı yok (etkin paylaşım yok ya da tercih kapalı)',
  stale: 'geç rapor',
  invisible: 'görünmez mod',
};

const clock = (t: number) => new Date(t).toLocaleString('tr-TR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function Faz7Section({ snap, renderRow }: Faz7Props) {
  const f7 = snap?.f7 ?? null;

  const rows: ControlRow[] = [
    {
      key: 'f7-ayse-event',
      title: 'Ayşe etkinliğe davet etsin',
      hint: 'Yarın için "Moda’da kahvaltı": davet bildirimi + Etkinlikler. Önce Ayşe\'ye buluşma daveti izni ver (Kişi izinleri). Sonra katılımını, mekanı ve saati tek seferde işaretle; sonuçlar Ayşe\'ye gider, Ayşe onaylayınca kesinleşir.',
      run: () => {
        const r = demoControls.ayseCreatesEvent();
        if (r.ok) return 'Ayşe seni "Moda’da kahvaltı" etkinliğine davet etti.';
        const msg = (ERROR_CODES as Record<string, { message: string }>)[r.code as ErrorCode]?.message;
        return r.code === 'not_permitted' ? 'Önce Ayşe’ye buluşma daveti izni ver (Kişi izinleri).' : `Davet edilemedi: ${msg ?? r.code}`;
      },
    },
    {
      key: 'f7-reminder-now',
      title: 'Hatırlatmayı şimdi gönder',
      hint: 'Kesinleşmiş etkinliğin sıradaki hatırlatması (1 gün önce ya da buluşma günü 08:00) hemen gelir.',
      run: () => {
        const n = demoControls.fireEventRemindersNow();
        return n > 0 ? `${n} hatırlatma gönderildi.` : 'Bekleyen hatırlatma yok (önce bir etkinliği kesinleştir).';
      },
    },
    {
      key: 'f7-mehmet-departs',
      title: 'Mehmet yola çıksın',
      hint: 'Mehmet seninle konum paylaşıyorken "sabit → hareket": sana "Mehmet yola çıktı" heads-up bildirimi (konum yok).',
      run: () => {
        const st = demoControls.mehmetDeparts();
        return st === 'sent' ? 'Mehmet yola çıktı bildirimi gönderildi.' : `Bildirim gitmedi: ${MOVEMENT_STATUS_TEXT[st] ?? st}.`;
      },
    },
  ];

  const lm = f7?.lastMovement ?? null;
  const lines = [
    f7
      ? `Etkinlikler: ${f7.activeEvents} etkin · ${f7.pendingReminders} bekleyen hatırlatma${f7.nextReminderAt ? ` (sıradaki ${clock(f7.nextReminderAt)})` : ''}`
      : null,
    f7
      ? `Gizlilik: pil paylaşımı ${f7.privacy.battery_share ? 'AÇIK' : 'KAPALI'} · "yola çıktı" bildirimleri ${f7.privacy.movement_alerts ? 'açık' : 'kapalı'}`
      : null,
    lm
      ? `Son "yola çıktı" raporun: ${clock(lm.at)} · ${MOVEMENT_STATUS_TEXT[lm.status] ?? lm.status}${lm.status === 'sent' ? ` (${lm.notified} kişi)` : ''}`
      : 'Henüz "yola çıktı" raporun yok (paylaşırken telefonu 10 dk masada bırakıp yürüyüşe geç).',
  ].filter((l): l is string => l !== null);

  return (
    <View style={{ gap: 6 }} testID="faz7-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 7 SENARYOLARI
      </Text>
      {rows.map(renderRow)}
      {lines.map((l) => (
        <Text key={l} variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {l}
        </Text>
      ))}
    </View>
  );
}
