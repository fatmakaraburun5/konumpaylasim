/**
 * Faz 10: kesinleşen etkinlik kartındaki "Takvime Ekle" (core `calendar.ts`, `state/calendarStore.ts`).
 * Kart: saat aralığı, mekan adı + adres, Google Maps bağlantısı, düğme. İlk eklemede resmi onay sayfası
 * (`CalendarSheets`), izin reddinde sistem formu / Google Takvim / Ayarlar.
 */
import { CALENDAR_TEXT, calendarEntryFromEvent, calendarSyncAction, calendarWhenLine, type EpochMs, type EventDoc, type UserId } from '@konum/core';
import { useEffect } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { calendarStore, useCalendarStore } from '../../state/calendarStore';
import { Button, cardShadow, Icon, Overlay, SheetHeader, Text, useTheme } from '../../ui';

export function AddToCalendar({ doc, me, now }: { doc: EventDoc; me: UserId; now: EpochMs }) {
  const { colors, spacing } = useTheme();
  const link = useCalendarStore((s) => s.links[doc.event_id] ?? null);
  const perm = useCalendarStore((s) => s.perm);
  const busy = useCalendarStore((s) => s.busy === doc.event_id);
  const message = useCalendarStore((s) => s.message);
  const r = calendarEntryFromEvent(doc, me, now);
  const sync = calendarSyncAction(link, r, perm, doc.stage);

  // Etkinlik değişti / iptal: tam erişimde kayıt kendiliğinden güncellenir / silinir.
  useEffect(() => {
    if (sync === 'update' || sync === 'remove') void calendarStore.getState().sync(doc, me);
  }, [sync, doc, me]);

  if (!r.ok) {
    if (link && sync === 'offer_update') {
      return (
        <Text variant="caption" color="warning" testID="calendar-removed-hint">
          {CALENDAR_TEXT.removedHint}
        </Text>
      );
    }
    return null;
  }
  const e = r.entry;
  return (
    <View style={{ gap: spacing.xs }} testID="calendar-card">
      <View style={[styles.row, { gap: spacing.xs }]}>
        <Icon name="calendar" size={16} color={colors.textSecondary} />
        <Text variant="label" style={styles.flex}>
          {calendarWhenLine(doc, e)}
        </Text>
      </View>
      <View style={[styles.row, { gap: spacing.xs }]}>
        <Icon name="mapPin" size={16} color={colors.textSecondary} />
        <Text variant="label" color="textSecondary" style={styles.flex}>
          {[e.venue.name, e.venue.address].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Text variant="caption" color="primary" accessibilityRole="link" onPress={() => void Linking.openURL(e.maps_url)}>
        Google Haritalar’da aç
      </Text>
      {link && sync === 'none' ? (
        <View style={[styles.row, { gap: spacing.sm }]}>
          <Text variant="label" color="primary" testID="calendar-added">
            {CALENDAR_TEXT.added}
          </Text>
          <Button title="Yeniden ekle" variant="ghost" onPress={() => void calendarStore.getState().add(doc, me)} loading={busy} />
        </View>
      ) : (
        <>
          {link && sync === 'offer_update' ? (
            <Text variant="caption" color="warning">
              {CALENDAR_TEXT.changedHint}
            </Text>
          ) : null}
          <Button
            title={link ? CALENDAR_TEXT.update : CALENDAR_TEXT.add}
            variant="secondary"
            block
            loading={busy}
            onPress={() => void calendarStore.getState().add(doc, me)}
            testID="calendar-add"
          />
        </>
      )}
      {message ? (
        <Text variant="caption" color="textSecondary" accessibilityLiveRegion="polite" testID="calendar-message">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

/** Onay sayfası + izin reddi sayfası (EventDetailScreen bir kez yerleştirir). */
export function CalendarSheets({ doc, me }: { doc: EventDoc; me: UserId }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const sheet = useCalendarStore((s) => s.sheet);
  const busy = useCalendarStore((s) => s.busy === doc.event_id);
  if (!sheet || sheet.event_id !== doc.event_id) return null;
  const close = () => calendarStore.getState().closeSheet();
  const s = calendarStore.getState();
  return (
    <Overlay visible onRequestClose={close} testID={sheet.kind === 'consent' ? 'calendar-consent' : 'calendar-denied'}>
      <View style={[styles.backdrop, { paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md }]}>
        <View style={[cardShadow, styles.card, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing.md, gap: spacing.sm }]}>
          <SheetHeader title={sheet.kind === 'consent' ? CALENDAR_TEXT.consentTitle : CALENDAR_TEXT.deniedTitle} onClose={close} />
          <ScrollView style={styles.scroll} contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
            {sheet.kind === 'consent' ? (
              <>
                <Text variant="body">{CALENDAR_TEXT.consentBody}</Text>
                <Text variant="label" color="textSecondary">
                  {CALENDAR_TEXT.consentIos}
                </Text>
                <Text variant="label" color="textSecondary">
                  {CALENDAR_TEXT.consentAndroid}
                </Text>
                <Text variant="caption" color="textSecondary">
                  Bu izni istediğin zaman İzin ve Gizlilik Merkezi’nden ya da telefon Ayarlar’ından kapatabilirsin.
                </Text>
                <Button title={CALENDAR_TEXT.consentAccept} block loading={busy} onPress={() => void s.acceptConsent(doc, me)} testID="calendar-consent-accept" />
                <Button title={CALENDAR_TEXT.consentLater} variant="ghost" block onPress={close} />
              </>
            ) : (
              <>
                <Text variant="body">{CALENDAR_TEXT.deniedBody}</Text>
                <Button title={CALENDAR_TEXT.openForm} block loading={busy} onPress={() => void s.openForm(doc, me)} testID="calendar-open-form" />
                <Button title={CALENDAR_TEXT.googleLink} variant="secondary" block onPress={() => void s.openGoogle(doc, me)} />
                <Button
                  title={CALENDAR_TEXT.openSettings}
                  variant="ghost"
                  block
                  onPress={() => {
                    close();
                    void Linking.openSettings().catch(() => undefined);
                  }}
                />
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  card: { maxHeight: '90%', width: '100%', maxWidth: 560, alignSelf: 'center' },
  scroll: { flexGrow: 0 },
});
