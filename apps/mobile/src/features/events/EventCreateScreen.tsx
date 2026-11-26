/**
 * Faz 7: "Etkinlik oluştur" (app/(main)/events/new.tsx). Davetliler her şeyi TEK seferde işaretler:
 *
 *   ad (≤ 60) · açıklama (≤ 300) · tarih çipleri (bugünden 3 hafta; sunucu 180 güne kadar kabul eder)
 *   davetliler: yalnızca beni buluşmaya / etkinliğe davet etmeme izin veren arkadaşlar seçilebilir (Faz 8
 *     `meetup_invite`); izni olmayan satır pasif ve "izin yok" etiketli. En çok 20 kişi.
 *   mekan seçenekleri (zorunlu, 1–3; tekse sabit) · saat seçenekleri (zorunlu, 1–4; tekse sabit)
 *   yanıt süresi: 2 sa · 6 sa · 1 gün · 2 gün. Herkes yanıtlayınca ya da süre dolunca sonuçlar düzenleyene düşer.
 * Sınırlar core şemasıyla aynı ölçüyle (kod noktası) denetlenir; sunucu ayrıca doğrular.
 */
import { EVENT_LIMITS, EVENT_TEXT, eventTextLength } from '@konum/core';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { now as serverNow } from '../../lib/clock';
import { eventsStore } from '../../state/eventsStore';
import { useFriends } from '../../state/friendsStore';
import { pickerRowAccess } from '../access/accessModel';
import { useCanFn } from '../access/useAccess';
import { FriendAvatar } from '../profile/FriendAvatar';
import { Button, cardShadow, Chip, CheckRow, IconButton, Text, useTheme } from '../../ui';
import { dateChoices, deviceTimeZone, voteWindowLabel } from './eventModel';
import { newVenueDraft, optionsProblem, TimeFields, VenueFields, venueInputs, type VenueDraft } from './EventOptionsFields';

export function EventCreateScreen() {
  const { colors, radius, spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const friends = useFriends();
  const can = useCanFn();
  const timeZone = useMemo(deviceTimeZone, []);
  const dates = useMemo(() => dateChoices(serverNow(), timeZone), [timeZone]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState<string>(dates[1]?.date ?? dates[0]!.date);
  const [invitees, setInvitees] = useState<string[]>([]);
  const [venues, setVenues] = useState<VenueDraft[]>(() => [newVenueDraft()]);
  const [minutes, setMinutes] = useState<number[]>([]);
  const [windowMs, setWindowMs] = useState<number>(EVENT_LIMITS.defaultVoteWindowMs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleLen = eventTextLength(title.trim());
  const descLen = eventTextLength(description.trim());
  const filledVenues = venues.filter((v) => v.name.trim().length > 0);
  // Gönder düğmesi pasifken nedeni altta yazılır (ilk eksik).
  const blocker =
    titleLen === 0
      ? 'Etkinliğe bir ad ver.'
      : titleLen > EVENT_LIMITS.titleMaxChars
        ? `Ad en çok ${EVENT_LIMITS.titleMaxChars} karakter olabilir.`
        : descLen > EVENT_LIMITS.descriptionMaxChars
          ? `Açıklama en çok ${EVENT_LIMITS.descriptionMaxChars} karakter olabilir.`
          : invitees.length === 0
            ? 'Davet edilecek en az bir kişi seç.'
            : optionsProblem(venues, minutes);
  const canSubmit = blocker === null && !busy;

  const inputStyle = [typography.body, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }];
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  const toggleInvitee = (uid: string) => {
    setError(null);
    setInvitees((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : prev.length >= EVENT_LIMITS.maxInvitees ? prev : [...prev, uid]));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const r = await eventsStore.getState().create({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      date,
      time_zone: timeZone,
      invitee_ids: invitees,
      venue_options: venueInputs(venues),
      time_minutes: minutes,
      vote_window_ms: windowMs,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    router.replace(`/events/${encodeURIComponent(r.event.event_id)}${r.skipped > 0 ? `?skipped=${r.skipped}` : ''}`);
  };

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: colors.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="close" accessibilityLabel="Vazgeç" onPress={() => router.back()} />
        <Text variant="title" accessibilityRole="header" style={styles.flex}>
          {EVENT_TEXT.create}
        </Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        <View style={card}>
          <Text variant="heading">Ne yapıyoruz?</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Ör. Cumartesi kahvaltısı"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Etkinlik adı"
            maxLength={EVENT_LIMITS.titleMaxChars * 2}
            style={inputStyle}
            testID="event-title"
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Açıklama (isteğe bağlı)"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Açıklama"
            multiline
            maxLength={EVENT_LIMITS.descriptionMaxChars * 2}
            style={[inputStyle, styles.multiline]}
          />
          <Text variant="caption" color={descLen > EVENT_LIMITS.descriptionMaxChars ? 'danger' : 'textSecondary'} align="right">
            {`${descLen}/${EVENT_LIMITS.descriptionMaxChars}`}
          </Text>
        </View>

        <View style={card}>
          <Text variant="heading">Tarih</Text>
          <Text variant="caption" color="textSecondary">
            Davetliler bu tarihe katılıp katılamayacağını, mekanı ve saati tek yanıtta bildirir.
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
            {dates.map((d) => (
              <Chip key={d.date} label={d.label} selected={date === d.date} onPress={() => setDate(d.date)} accessibilityHint={d.a11y} />
            ))}
          </ScrollView>
        </View>

        <View style={card}>
          <Text variant="heading">{`Davetliler (${invitees.length}/${EVENT_LIMITS.maxInvitees})`}</Text>
          <Text variant="caption" color="textSecondary">
            {EVENT_TEXT.inviteNoPermissionHint}
          </Text>
          {friends.length === 0 ? (
            <Text variant="label" color="textSecondary">
              Henüz arkadaşın yok. Arkadaşlar ekranından davet kodunla ekle.
            </Text>
          ) : (
            friends.map((f) => {
              const access = pickerRowAccess('meetup_invite', f.uid, can);
              const selected = invitees.includes(f.uid);
              const disabled = !!access?.disabledReason && !selected;
              return (
                <CheckRow
                  key={f.uid}
                  testID={`event-invitee-${f.uid}`}
                  checked={selected}
                  disabled={disabled}
                  onPress={() => toggleInvitee(f.uid)}
                  title={f.displayName}
                  subtitle={access?.disabledReason ?? undefined}
                  left={<FriendAvatar uid={f.uid} fallbackName={f.displayName} size={32} />}
                />
              );
            })
          )}
        </View>

        <View style={card}>
          <Text variant="heading">{`Mekan seçenekleri (${filledVenues.length}/${EVENT_LIMITS.maxVenueOptions})`}</Text>
          <Text variant="caption" color="textSecondary">
            En az 1, en çok 3 mekan. Birden çok yazarsan davetliler birini seçer; tek mekan sabit kalır.
          </Text>
          <VenueFields
            venues={venues}
            onChange={(v) => {
              setError(null);
              setVenues(v);
            }}
          />
        </View>

        <View style={card}>
          <Text variant="heading">{`Saat seçenekleri (${minutes.length}/${EVENT_LIMITS.maxTimeOptions})`}</Text>
          <Text variant="caption" color="textSecondary">
            En az 1, en çok 4 saat; her biri en az 30 dk sonrası olmalı. Birden çoksa davetliler birini seçer.
          </Text>
          <TimeFields
            minutes={minutes}
            onChange={(m) => {
              setError(null);
              setMinutes(m);
            }}
          />
        </View>

        <View style={card}>
          <Text variant="heading">Yanıt süresi</Text>
          <Text variant="caption" color="textSecondary">
            {EVENT_TEXT.createHint}
          </Text>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {EVENT_LIMITS.voteWindowsMs.map((ms) => (
              <Chip key={ms} label={voteWindowLabel(ms)} selected={windowMs === ms} onPress={() => setWindowMs(ms)} testID={`event-window-${ms}`} />
            ))}
          </View>
        </View>

        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="polite" testID="event-create-error">
            {error}
          </Text>
        ) : null}
        {!error && blocker ? (
          <Text variant="caption" color="textSecondary" testID="event-create-blocker">
            {blocker}
          </Text>
        ) : null}
        <Button title={invitees.length ? `Davet et (${invitees.length} kişi)` : 'Davet edilecek kişileri seç'} onPress={() => void submit()} disabled={!canSubmit} loading={busy} testID="event-create-submit" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  input: { minHeight: 44, paddingVertical: 10 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
});
