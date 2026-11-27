/**
 * Web önizleme · Faz 11 (yalnızca tarayıcı paketi): "FAZ 11 SENARYOLARI" — tema paketi.
 *
 *  - "Tema ve Harita ekranını aç": önizleme kartlı seçici (mini harita + pembe/mavi pin + mini kitapçık).
 *  - Nude / Pudra Pembesi / Siyah-Gri: tek dokunuşla uygulanır; harita ve kitapçık aynı karede değişir.
 *  - Saat kuralı: gündüz Pudra Pembesi, gece Siyah / Gri. "Gece saatine geçir" kuralın saatlerini şu ana göre
 *    kaydırır (gerçek saat beklenmez): bir sonraki sınırda tema kendiliğinden değişir.
 */
import { formatMinute, minuteOfDay, THEME_NAME } from '@konum/core';
import { router } from 'expo-router';
import { View } from 'react-native';
import { setThemePref, setThemeSchedule, Text, useThemeId, useThemeSettings } from '../../ui';
import type { ControlRow } from './Faz3.web';

interface Faz11Props {
  renderRow: (r: ControlRow) => React.ReactElement;
}

const halfHour = (m: number) => Math.floor(m / 30) * 30;

export function Faz11Section({ renderRow }: Faz11Props) {
  const settings = useThemeSettings();
  const active = useThemeId();
  const rows: ControlRow[] = [
    {
      key: 'f11-open',
      title: 'Tema ve Harita ekranını aç',
      hint: 'Beş tema canlı önizleme kartıyla: mini harita, pembe/mavi çerçeveli pin, mini kitapçık. Seçim anında uygulanır.',
      navigates: true,
      run: () => {
        router.push('/appearance');
        return 'Tema ve Harita açıldı.';
      },
    },
    { key: 'f11-nude', title: 'Nude teması', hint: 'Krem zemin, sütlü kahve kartlar, tarçın düğmeler; harita bej / kum / adaçayı.', run: () => (setThemePref('nude'), 'Nude uygulandı.') },
    {
      key: 'f11-blush',
      title: 'Pudra Pembesi teması',
      hint: 'Kırık beyaz zemin, toz pembe kartlar, mürdüm vurgular. Pembe çerçevede beyaz kontrast halka + gölge.',
      run: () => (setThemePref('blush'), 'Pudra Pembesi uygulandı.'),
    },
    {
      key: 'f11-charcoal',
      title: 'Siyah / Gri teması',
      hint: 'Grafit #121417 / #1C1F24, kitapçık arka katmanları kademeli açılan gri; harita otoyol > cadde > sokak gri, su mavi-gri.',
      run: () => (setThemePref('charcoal'), 'Siyah / Gri uygulandı.'),
    },
    {
      key: 'f11-schedule-night',
      title: 'Saat kuralı: gündüz Pudra, gece Siyah/Gri → gece saatine geçir',
      hint: 'Kural açılır; gece başlangıcı şu anki yarım saate çekilir (gündüz 12 sa sonra). Tema hemen Siyah / Gri olur.',
      run: () => {
        const now = halfHour(minuteOfDay(new Date()));
        setThemeSchedule({ day: 'blush', night: 'charcoal', night_start: now, day_start: (now + 720) % 1440 });
        setThemePref('schedule');
        return `Gece ${formatMinute(now)}'da başladı → Siyah / Gri.`;
      },
    },
    {
      key: 'f11-schedule-day',
      title: 'Saat kuralı: gündüz saatine geçir',
      hint: 'Gündüz başlangıcı şu anki yarım saate çekilir: tema Pudra Pembesi olur.',
      run: () => {
        const now = halfHour(minuteOfDay(new Date()));
        setThemeSchedule({ day: 'blush', night: 'charcoal', day_start: now, night_start: (now + 720) % 1440 });
        setThemePref('schedule');
        return `Gündüz ${formatMinute(now)}'da başladı → Pudra Pembesi.`;
      },
    },
    { key: 'f11-reset', title: 'Faz 7 görünümüne dön (Sistem)', hint: 'Telefonun açık / koyu ayarı.', run: () => (setThemePref('system'), 'Sistem görünümü.') },
  ];
  const line =
    settings.pref === 'schedule'
      ? `Etkin: ${THEME_NAME[active]} · kural gündüz ${formatMinute(settings.schedule.day_start)} ${THEME_NAME[settings.schedule.day]}, gece ${formatMinute(settings.schedule.night_start)} ${THEME_NAME[settings.schedule.night]}`
      : `Etkin: ${THEME_NAME[active]}`;
  return (
    <View style={{ gap: 6 }} testID="faz11-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 11 SENARYOLARI
      </Text>
      {rows.map(renderRow)}
      <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }} testID="faz11-status">
        {line}
      </Text>
    </View>
  );
}
