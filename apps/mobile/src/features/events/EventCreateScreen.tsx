/**
 * Faz 7: "Etkinlik oluştur" (app/(main)/events/new.tsx).
 *
 *   ad (≤ 60) · açıklama (≤ 300) · tarih çipleri (bugünden 3 hafta; sunucu 180 güne kadar kabul eder)
 *   davetliler: yalnızca beni buluşmaya / etkinliğe davet etmeme izin veren arkadaşlar seçilebilir (Faz 8
 *     `meetup_invite`); izni olmayan satır pasif ve "izin yok" etiketli. En çok 20 kişi.
 *   mekan seçenekleri (isteğe bağlı, en çok 3): şimdi girilmezse katılacağını söyleyenler önerir.
 *   saat seçenekleri (isteğe bağlı, 2–4): girilirse mekan kesinleşince saat oylaması hemen başlar.
 *   oylama süresi: 2 sa · 6 sa · 1 gün · 2 gün.
 * Sınırlar core şemasıyla aynı ölçüyle (kod noktası) denetlenir; sunucu ayrıca doğrular.
 */
import { EVENT_LIMITS, EVENT_TEXT, eventTextLength, formatMinuteOfDay, parseClock, uuidV4 } from '@konum/core';
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
import { dateChoices, deviceTimeZone, TIME_PRESETS, toggleMinute, voteWindowLabel } from './eventModel';

interface VenueDraft {
  key: string;
  name: string;
  address: string;
}

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
  const [venues, setVenues] = useState<VenueDraft[]>([]);
  const [minutes, setMinutes] = useState<number[]>([]);
  const [customTime, setCustomTime] = useState('');
  const [windowMs, setWindowMs] = useState<number>(EVENT_LIMITS.defaultVoteWindowMs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleLen = eventTextLength(title.trim());
  const descLen = eventTextLength(description.trim());
  const filledVenues = venues.filter((v) => v.name.trim().length > 0);
  const venueTooLong = venues.some((v) => eventTextLength(v.name.trim()) > EVENT_LIMITS.venueNameMaxChars || eventTextLength(v.address.trim()) > EVENT_LIMITS.venueAddressMaxChars);
  const timesInvalid = minutes.length === 1;
  const canSubmit =
    titleLen > 0 &&
    titleLen <= EVENT_LIMITS.titleMaxChars &&
    descLen <= EVENT_LIMITS.descriptionMaxChars &&
    invitees.length > 0 &&
    !venueTooLong &&
    !timesInvalid &&
    !busy;

  const inputStyle = [typography.body, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }];
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  const toggleInvitee = (uid: string) => {
    setError(null);
    setInvitees((prev) => (prev.includes(uid) ? prev.filter((u) => u !== uid) : prev.length >= EVENT_LIMITS.maxInvitees ? prev : [...prev, uid]));
  };

  const addCustomTime = () => {
    const m = parseClock(customTime);
    if (m === null) {
      setError('Saati 19:30 biçiminde yaz.');
      return;
    }
    setMinutes((prev) => toggleMinute(prev.filter((x) => x !== m), m));
    setCustomTime('');
    setError(null);
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
      venue_options: filledVenues.map((v) => ({ name: v.name.trim(), address: v.address.trim() ? v.address.trim() : null, location: null, place_id: null })),
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
            Aşama 1: davetliler bu tarihe katılıp katılamayacağını bildirir.
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
          <Text variant="heading">{`Mekan seçenekleri (${filledVenues.length}/${EVENT_LIMITS.venueOptions})`}</Text>
          <Text variant="caption" color="textSecondary">
            Aşama 2 için 3 mekan gerekir. Şimdi eklemezsen &quot;Katılacağım&quot; diyenler önerebilir; en çok oyu alan kazanır.
          </Text>
          {venues.map((v, i) => (
            <View key={v.key} style={[styles.venue, { gap: spacing.xs, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm }]}>
              <View style={[styles.row, { gap: spacing.xs }]}>
                <TextInput
                  value={v.name}
                  onChangeText={(name) => setVenues((list) => list.map((x) => (x.key === v.key ? { ...x, name } : x)))}
                  placeholder={`Mekan ${i + 1} adı`}
                  placeholderTextColor={colors.textSecondary}
                  accessibilityLabel={`Mekan ${i + 1} adı`}
                  maxLength={EVENT_LIMITS.venueNameMaxChars * 2}
                  style={[inputStyle, styles.flex]}
                />
                <IconButton icon="close" accessibilityLabel={`Mekan ${i + 1} seçeneğini kaldır`} onPress={() => setVenues((list) => list.filter((x) => x.key !== v.key))} />
              </View>
              <TextInput
                value={v.address}
                onChangeText={(address) => setVenues((list) => list.map((x) => (x.key === v.key ? { ...x, address } : x)))}
                placeholder="Adres ya da semt (isteğe bağlı)"
                placeholderTextColor={colors.textSecondary}
                accessibilityLabel={`Mekan ${i + 1} adresi`}
                maxLength={EVENT_LIMITS.venueAddressMaxChars * 2}
                style={inputStyle}
              />
            </View>
          ))}
          {venues.length < EVENT_LIMITS.venueOptions ? (
            <Button title="Mekan ekle" variant="secondary" onPress={() => setVenues((list) => [...list, { key: uuidV4(), name: '', address: '' }])} />
          ) : null}
        </View>

        <View style={card}>
          <Text variant="heading">{`Saat seçenekleri (${minutes.length}/${EVENT_LIMITS.maxTimeOptions})`}</Text>
          <Text variant="caption" color={timesInvalid ? 'danger' : 'textSecondary'}>
            {timesInvalid
              ? 'Saat oylaması için en az 2 seçenek gerekli (ya da hiç ekleme, sonra eklersin).'
              : 'İsteğe bağlı. Eklersen mekan kesinleşince Aşama 3 saat oylaması hemen başlar.'}
          </Text>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {TIME_PRESETS.map((m) => (
              <Chip key={m} label={formatMinuteOfDay(m)} selected={minutes.includes(m)} onPress={() => setMinutes((prev) => toggleMinute(prev, m))} />
            ))}
            {minutes
              .filter((m) => !TIME_PRESETS.includes(m))
              .map((m) => (
                <Chip key={`c${m}`} label={formatMinuteOfDay(m)} selected onPress={() => setMinutes((prev) => toggleMinute(prev, m))} />
              ))}
          </View>
          <View style={[styles.row, { gap: spacing.xs }]}>
            <TextInput
              value={customTime}
              onChangeText={setCustomTime}
              placeholder="Başka saat: 17:45"
              placeholderTextColor={colors.textSecondary}
              accessibilityLabel="Başka saat"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              onSubmitEditing={addCustomTime}
              style={[inputStyle, styles.flex]}
            />
            <Button title="Ekle" variant="secondary" block={false} onPress={addCustomTime} disabled={!customTime.trim() || minutes.length >= EVENT_LIMITS.maxTimeOptions} />
          </View>
        </View>

        <View style={card}>
          <Text variant="heading">Oylama süresi</Text>
          <Text variant="caption" color="textSecondary">
            Herkes oy verince oylama kendiliğinden kapanır; vermeyenleri bu süre kadar bekleriz.
          </Text>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {EVENT_LIMITS.voteWindowsMs.map((ms) => (
              <Chip key={ms} label={voteWindowLabel(ms)} selected={windowMs === ms} onPress={() => setWindowMs(ms)} />
            ))}
          </View>
        </View>

        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="polite" testID="event-create-error">
            {error}
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
  venue: { borderWidth: StyleSheet.hairlineWidth },
});
