/**
 * Faz 11: Tema ve Harita ekranı. Beş tema canlı önizleme kartıyla seçilir (mini harita + pembe/mavi çerçeveli
 * pinler + mini kitapçık). Seçim ANINDA uygulanır: uygulama belirteçleri ve Google Maps stili (customMapStyle)
 * aynı karede değişir, yeniden başlatma yok.
 *
 * "Saate göre otomatik": kişisel ikili kural (gündüz teması + gece teması + iki başlangıç saati, 30 dk adım).
 * Açıkken kartlara (üstte) dokunmak gündüz / gece rolünü (kuraldaki sekme) değiştirir; kapatınca seçili kart sabit tema olur.
 * "Sistem" seçeneği Faz 7 davranışını (telefonun açık/koyu ayarı → Açık / Koyu) korur.
 */
import { formatMinute, nextThemeSwitchAt, THEME_IDS, THEME_NAME, type ThemeId } from '@konum/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, setThemePref, setThemeSchedule, Text, useTheme, useThemeId, useThemeSettings } from '../../ui';
import { ThemePreviewCard } from './ThemePreviewCard';

type Slot = 'day' | 'night';
const STEP = 30;

function TimeStepper({ label, value, onChange, testID }: { label: string; value: number; onChange: (m: number) => void; testID: string }) {
  const { colors, radius } = useTheme();
  const shift = (d: number) => onChange((value + d + 1440) % 1440);
  return (
    <View style={[styles.stepper, { backgroundColor: colors.surfaceAlt, borderRadius: radius.md }]} testID={testID}>
      <Text variant="label" color="textSecondary" style={{ flex: 1 }}>
        {label}
      </Text>
      <IconButton icon="minus" size={36} variant="soft" accessibilityLabel={`${label}: 30 dakika erken`} onPress={() => shift(-STEP)} />
      <Text variant="heading" style={{ minWidth: 56, textAlign: 'center' }} accessibilityLiveRegion="polite">
        {formatMinute(value)}
      </Text>
      <IconButton icon="plus" size={36} variant="soft" accessibilityLabel={`${label}: 30 dakika geç`} onPress={() => shift(STEP)} />
    </View>
  );
}

export function ThemePickerScreen() {
  const theme = useTheme();
  const { colors, spacing, radius } = theme;
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const settings = useThemeSettings();
  const activeId = useThemeId();
  // Kart genişliği kapsayıcıdan (telefon / tablet / web çerçevesi): iki sütun.
  const [gridW, setGridW] = useState(0);
  const [slot, setSlot] = useState<Slot>('day');
  const scheduled = settings.pref === 'schedule';
  const cardW = Math.max(120, Math.floor((gridW - 12) / 2));

  const pick = (id: ThemeId) => {
    if (scheduled) setThemeSchedule(slot === 'day' ? { day: id } : { night: id });
    else setThemePref(id);
  };
  const isSelected = (id: ThemeId) =>
    scheduled ? (slot === 'day' ? settings.schedule.day : settings.schedule.night) === id : settings.pref === id;
  const badgeFor = (id: ThemeId) =>
    !scheduled ? null : [settings.schedule.day === id ? '☀️ Gündüz' : null, settings.schedule.night === id ? '🌙 Gece' : null].filter(Boolean).join(' · ') || null;

  const nextAt = nextThemeSwitchAt(settings, new Date(settings.clock));
  const status = scheduled
    ? `Şu an ${THEME_NAME[activeId]}. ${nextAt ? new Date(nextAt).toTimeString().slice(0, 5) : ''} itibarıyla ${THEME_NAME[activeId === settings.schedule.day ? settings.schedule.night : settings.schedule.day]} teması açılır.`
    : settings.pref === 'system'
      ? `Telefonunun ayarını izliyor: şu an ${THEME_NAME[activeId]}.`
      : `${THEME_NAME[activeId]} teması uygulama ve haritada etkin.`;

  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }} testID="theme-picker">
      <View style={[styles.header, { paddingHorizontal: spacing.xs, gap: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />
        <Text variant="title" accessibilityRole="header">
          Tema ve Harita
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl, maxWidth: 520, width: '100%', alignSelf: 'center' }}>
        <Text variant="label" color="textSecondary" accessibilityLiveRegion="polite" testID="theme-status">
          {status}
        </Text>

        <View style={styles.grid} accessibilityRole="radiogroup" onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
          {THEME_IDS.map((id) => (
            <ThemePreviewCard key={id} id={id} width={cardW} selected={isSelected(id)} badge={badgeFor(id)} onPress={() => pick(id)} />
          ))}
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: settings.pref === 'system' }}
            accessibilityLabel="Sistem: telefonun açık / koyu ayarını izler"
            onPress={() => setThemePref('system')}
            testID="theme-card-system"
            style={[
              styles.system,
              {
                width: cardW,
                borderRadius: 16,
                backgroundColor: colors.surface,
                borderColor: settings.pref === 'system' ? colors.primary : colors.border,
                borderWidth: settings.pref === 'system' ? 2.5 : StyleSheet.hairlineWidth * 2,
              },
            ]}
          >
            <Text variant="title">🌓</Text>
            <Text variant="label">Sistem</Text>
            <Text variant="caption" color="textSecondary" style={{ textAlign: 'center' }}>
              Telefonun açık / koyu ayarı
            </Text>
          </Pressable>
        </View>
        <View style={card}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text variant="heading">Saate göre otomatik</Text>
              <Text variant="caption" color="textSecondary">
                Örn. gündüz Nude ya da Pudra Pembesi, akşam Siyah / Gri
              </Text>
            </View>
            <Switch
              value={scheduled}
              onValueChange={(v) => setThemePref(v ? 'schedule' : activeId)}
              accessibilityLabel="Saate göre otomatik tema"
              testID="theme-schedule-switch"
            />
          </View>
          {scheduled ? (
            <>
              <View style={[styles.segment, { backgroundColor: colors.surfaceAlt, borderRadius: radius.pill }]} accessibilityRole="tablist">
                {(['day', 'night'] as const).map((s) => (
                  <Pressable
                    key={s}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: slot === s }}
                    onPress={() => setSlot(s)}
                    testID={`theme-slot-${s}`}
                    style={[styles.segmentItem, { borderRadius: radius.pill, backgroundColor: slot === s ? colors.surface : 'transparent' }]}
                  >
                    <Text variant="label" color={slot === s ? 'text' : 'textSecondary'}>
                      {s === 'day' ? `☀️ Gündüz: ${THEME_NAME[settings.schedule.day]}` : `🌙 Gece: ${THEME_NAME[settings.schedule.night]}`}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TimeStepper label="Gündüz başlar" value={settings.schedule.day_start} onChange={(m) => setThemeSchedule({ day_start: m })} testID="theme-day-start" />
              <TimeStepper label="Gece başlar" value={settings.schedule.night_start} onChange={(m) => setThemeSchedule({ night_start: m })} testID="theme-night-start" />
              <Text variant="caption" color="textSecondary">
                Yukarıdaki kartlardan {slot === 'day' ? 'gündüz' : 'gece'} temasını seç. Geçiş saatinde tema ve harita kendiliğinden değişir.
              </Text>
            </>
          ) : null}
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 52 },
  card: { borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  segment: { flexDirection: 'row', padding: 4 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 8, paddingHorizontal: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4, paddingVertical: 4, gap: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  system: { alignItems: 'center', justifyContent: 'center', gap: 4, padding: 12, minHeight: 170 },
});
