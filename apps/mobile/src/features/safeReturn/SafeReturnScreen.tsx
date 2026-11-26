/**
 * Faz 9: Güvenli Dönüş ekranı (app/(main)/safe-return.tsx; harita girişi, band, "Güvende misin?" bildirimi açar) —
 * docs/PHASE9.md §3.
 *
 *  Başlatma: süre (15 / 30 / 45 / 60 dk, core `SAFE_RETURN_DURATIONS_MIN`) · hedef (kayıtlı bölge: Ev / İş …, paylaşım
 *  hedefi, etkinlik mekanı / buluşma noktası) · acil kişi(ler) (Faz 4 acil durum kişileri) · "Yolculuk boyunca canlı
 *  konumumu da paylaş" (varsayılan açık) · "Zamanlayıcıyı başlat" (başlangıç konumu zorunlu).
 *  Sürerken: hedef, geri sayım, kişiler · "Güvendeyim" · "Vardım" · "+15 dk" · "Zamanlayıcıyı iptal et" (onaylı).
 *  Gece geç saatte (22:00–06:00) öneri satırı.
 */
import {
  SAFE_RETURN_DURATIONS_MIN,
  SAFE_RETURN_LIMITS,
  SAFE_RETURN_TEXT,
  type SafeReturnDurationMin,
  type UserId,
} from '@konum/core';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { formatContactNames } from '../../services/notifications/safeReturnNotifications';
import { useAuthStore } from '../../state/authStore';
import { useDestinationStore } from '../../state/destinationStore';
import { useEventsStore } from '../../state/eventsStore';
import { useFriendNames } from '../../state/friendsStore';
import { selectMeetups, useMeetupStore } from '../../state/meetupStore';
import { canExtendSafeReturn, safeReturnStore, useSafeReturnStore, type SafeReturnDestinationInput } from '../../state/safeReturnStore';
import { useSosStore } from '../../state/sosStore';
import { useZonesStore } from '../../state/zonesStore';
import { Button, cardShadow, CheckRow, Chip, Icon, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { eventMeetupOptions } from '../approach/destModel';
import { EmergencyContactsSheet, type EmergencyContactsSheetHandle } from '../sos/EmergencyContactsSheet';
import { defaultSafeReturnZone, formatCountdown, isSafeReturnLive, lateNightNow, safeReturnBannerText } from './safeReturnModel';
import { useSafeReturnPhase } from './useSafeReturnPhase';

type DestChoice = { key: string; label: string; input: SafeReturnDestinationInput };

export function SafeReturnScreen() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const phase = useSafeReturnPhase();
  const current = useSafeReturnStore((s) => s.current);
  const live = isSafeReturnLive(phase) && current !== null;
  const card: StyleProp<ViewStyle> = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID="safe-return-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <Text variant="title" accessibilityRole="header" style={styles.flex}>
          {SAFE_RETURN_TEXT.title}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }} keyboardShouldPersistTaps="handled">
        {live ? <ActiveCard card={card} /> : <StartForm card={card} />}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Süren zamanlayıcı

function ActiveCard({ card }: { card: StyleProp<ViewStyle> }) {
  const { colors, spacing } = useTheme();
  const current = useSafeReturnStore((s) => s.current)!;
  const phase = useSafeReturnPhase();
  const leftMs = useSafeReturnStore((s) => s.leftMs);
  const busy = useSafeReturnStore((s) => s.busy);
  const error = useSafeReturnStore((s) => s.error);
  const skipped = useSafeReturnStore((s) => s.liveShareSkipped);
  const names = useFriendNames();
  const now = useNow(5_000);
  const who = formatContactNames(current.contact_ids.map((id) => names[id] ?? null));
  const danger = phase === 'final_warning' || phase === 'alarm';

  const cancel = () =>
    Alert.alert(SAFE_RETURN_TEXT.cancel, SAFE_RETURN_TEXT.cancelConfirm, [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'İptal et', style: 'destructive', onPress: () => void safeReturnStore.getState().cancel() },
    ]);

  return (
    <>
      <View style={card} testID="safe-return-active">
        <View style={[styles.row, { gap: spacing.xs }]}>
          <Icon name="shield" size={22} color={danger ? colors.danger : colors.primary} />
          <Text variant="heading" style={styles.flex}>
            {current.destination.name}
          </Text>
        </View>
        <Text variant="title" style={[styles.tabular, { color: danger ? colors.danger : colors.text }]} accessibilityLiveRegion="polite" testID="safe-return-left">
          {phase === 'alarm' ? SAFE_RETURN_TEXT.alarmSent : formatCountdown(leftMs)}
        </Text>
        <Text variant="label" color="textSecondary">
          {phase === 'alarm' ? 'Güvendeysen "Güvendeyim"e dokun; alarm kapanır.' : safeReturnBannerText(phase, current.destination.name, leftMs)}
        </Text>
        <Text variant="caption" color="textSecondary">{`Haber verilecek: ${who}`}</Text>
        {skipped.length > 0 ? (
          <Text variant="caption" color="warning">
            {`${formatContactNames(skipped.map((id) => names[id] ?? null))} konum iznin olmadığı için canlı konumunu görmüyor; alarm yine de gider.`}
          </Text>
        ) : null}
        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="polite">
            {error.message}
          </Text>
        ) : null}
        <Button title={SAFE_RETURN_TEXT.checkIn} size="lg" onPress={() => void safeReturnStore.getState().checkIn('safe')} loading={busy === 'check_in'} disabled={busy !== null} testID="safe-return-ok" />
        {phase !== 'alarm' ? (
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Button title={SAFE_RETURN_TEXT.arrived} variant="secondary" style={styles.flex} block={false} onPress={() => void safeReturnStore.getState().checkIn('arrived')} disabled={busy !== null} />
            <Button
              title={SAFE_RETURN_TEXT.extend}
              variant="secondary"
              style={styles.flex}
              block={false}
              onPress={() => void safeReturnStore.getState().extend()}
              loading={busy === 'extend'}
              disabled={busy !== null || !canExtendSafeReturn(current, now)}
              testID="safe-return-extend"
            />
          </View>
        ) : null}
        {phase !== 'alarm' ? <Button title={SAFE_RETURN_TEXT.cancel} variant="danger" onPress={cancel} loading={busy === 'cancel'} disabled={busy !== null} /> : null}
      </View>
      <Text variant="caption" color="textSecondary">
        Süre dolup yanıt vermezsen uygulama kapalı olsa da alarm sunucudan son bildirdiğin konumla ve pil durumunla gider.
      </Text>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Başlatma

function StartForm({ card }: { card: StyleProp<ViewStyle> }) {
  const { colors, spacing } = useTheme();
  const busy = useSafeReturnStore((s) => s.busy);
  const error = useSafeReturnStore((s) => s.error);
  const ended = useSafeReturnStore((s) => s.ended);
  const myUid = useAuthStore((s) => s.uid);
  const contacts = useSosStore((s) => s.emergencyContacts);
  const names = useFriendNames();
  const zonesMap = useZonesStore((s) => s.zones);
  const shareDest = useDestinationStore((s) => s.destination);
  const eventsMap = useEventsStore((s) => s.events);
  const meetupsMap = useMeetupStore((s) => s.meetups);
  const now = useNow(60_000);
  const contactsSheet = useRef<EmergencyContactsSheetHandle>(null);

  const zones = useMemo(() => Object.values(zonesMap).filter((z) => z.enabled), [zonesMap]);
  const choices = useMemo<DestChoice[]>(() => {
    const out: DestChoice[] = zones.map((z) => ({
      key: `zone:${z.zone_id}`,
      label: `${z.emoji ?? '📍'} ${z.name}`,
      input: { kind: 'zone', zone_id: z.zone_id, name: z.name, center: z.center, radius_m: z.radius_m },
    }));
    if (shareDest && shareDest.kind !== 'zone') {
      out.push({ key: `dest:${shareDest.key}`, label: `🏁 ${shareDest.name}`, input: { kind: 'point', name: shareDest.name, center: shareDest.center, radius_m: shareDest.radius_m } });
    }
    for (const o of eventMeetupOptions(Object.values(eventsMap), selectMeetups({ meetups: meetupsMap }, myUid), now)) {
      if (out.some((c) => c.key === `dest:${o.key}`)) continue;
      out.push({ key: o.key, label: o.label, input: { kind: 'point', name: o.name, center: o.center, radius_m: o.radius_m } });
    }
    return out;
  }, [zones, shareDest, eventsMap, meetupsMap, myUid, now]);

  const [duration, setDuration] = useState<SafeReturnDurationMin>(30);
  const [destKey, setDestKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<UserId>>(new Set());
  const [shareLive, setShareLive] = useState(true);
  const touched = useRef(false);

  // Varsayılanlar: Ev bölgesi (ya da paylaşım hedefi), tüm acil durum kişileri.
  useEffect(() => {
    if (destKey && choices.some((c) => c.key === destKey)) return;
    const home = defaultSafeReturnZone(zones);
    setDestKey(home ? `zone:${home}` : (choices[0]?.key ?? null));
  }, [choices, zones, destKey]);
  useEffect(() => {
    if (!touched.current) setSelected(new Set(contacts.slice(0, SAFE_RETURN_LIMITS.maxContacts)));
  }, [contacts]);

  const dest = choices.find((c) => c.key === destKey) ?? null;
  const toggle = (uid: UserId) => {
    touched.current = true;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else if (next.size < SAFE_RETURN_LIMITS.maxContacts) next.add(uid);
      return next;
    });
  };

  const start = async () => {
    if (!dest) return;
    safeReturnStore.getState().clearError();
    await safeReturnStore.getState().start({ duration_min: duration, destination: dest.input, contact_ids: [...selected], shareLive });
  };

  return (
    <>
      {ended && ended.reason !== 'alarm' ? (
        <View style={[card, { backgroundColor: colors.liveSoft }]}>
          <Text variant="label" style={{ color: colors.live }}>
            {SAFE_RETURN_TEXT.ended[ended.reason]}
          </Text>
        </View>
      ) : null}

      <Text variant="body" color="textSecondary">
        {SAFE_RETURN_TEXT.subtitle}
      </Text>
      {lateNightNow() ? (
        <View style={[styles.row, { gap: spacing.xs }]}>
          <Icon name="moon" size={18} color={colors.primary} />
          <Text variant="label" style={styles.flex}>
            {SAFE_RETURN_TEXT.lateNightHint}
          </Text>
        </View>
      ) : null}

      <View style={card}>
        <Text variant="heading">{SAFE_RETURN_TEXT.durationLabel}</Text>
        <View style={[styles.row, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Süre">
          {SAFE_RETURN_DURATIONS_MIN.map((m) => (
            <Chip key={m} label={SAFE_RETURN_TEXT.durationOption(m)} selected={m === duration} onPress={() => setDuration(m)} style={styles.flex} testID={`safe-return-duration-${m}`} />
          ))}
        </View>
      </View>

      <View style={card}>
        <Text variant="heading">{SAFE_RETURN_TEXT.destinationLabel}</Text>
        {choices.length === 0 ? (
          <Text variant="label" color="textSecondary">
            Önce Ev gibi bir bölge kaydet (Menü › Bölgelerim) ya da paylaşımda haritadan bir hedef seç.
          </Text>
        ) : (
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {choices.map((c) => (
              <Chip key={c.key} label={c.label} selected={c.key === destKey} onPress={() => setDestKey(c.key)} testID={`safe-return-dest-${c.key}`} />
            ))}
          </View>
        )}
      </View>

      <View style={card}>
        <Text variant="heading">{SAFE_RETURN_TEXT.contactsLabel}</Text>
        {contacts.length === 0 ? (
          <Text variant="label" color="textSecondary">
            {SAFE_RETURN_TEXT.contactsEmpty}
          </Text>
        ) : (
          contacts.map((uid) => <CheckRow key={uid} checked={selected.has(uid)} onPress={() => toggle(uid)} title={names[uid] ?? 'Arkadaş'} testID={`safe-return-contact-${uid}`} />)
        )}
        <Button title="Acil durum kişilerini düzenle" variant="ghost" onPress={() => contactsSheet.current?.present(false)} />
        <View style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
          <View style={styles.flex}>
            <Text variant="body">Yolculuk boyunca canlı konumumu da paylaş</Text>
            <Text variant="caption" color="textSecondary">
              Seçtiğin kişiler süre bitene kadar konumunu canlı görür; uygulama arka planda da konum göndermeye devam eder.
            </Text>
          </View>
          <Switch value={shareLive} onValueChange={setShareLive} accessibilityLabel="Yolculuk boyunca canlı konumumu da paylaş" testID="safe-return-share-live" />
        </View>
      </View>

      {error ? (
        <Text variant="label" color="danger" accessibilityLiveRegion="polite" testID="safe-return-error">
          {error.message}
        </Text>
      ) : null}
      <Button
        title={SAFE_RETURN_TEXT.start}
        size="lg"
        onPress={() => void start()}
        loading={busy === 'start'}
        disabled={busy !== null || !dest || selected.size === 0}
        testID="safe-return-start"
      />
      <EmergencyContactsSheet ref={contactsSheet} />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
});
