/**
 * Faz 7: etkinlik kartı (app/(main)/events/[id].tsx). Tek seferde oylama, core `reduceEvent` sunucuda çalışır:
 *
 *   Davetli (yanıtlar toplanırken): TEK form. "Katılacağım" + mekan + saat ya da "Katılamayacağım" + (≤ 300 karakterlik
 *     not, kartta herkes görür). Tek düğmeyle gönderilir; düzenleyen onaylayana kadar değiştirilebilir. Oy sayıları
 *     davetliye gösterilmez.
 *   Düzenleyen: Sonuçlar kartı (katılım, mekan ve saat oy dağılımı, kimin neyi seçtiği). Herkes yanıtlayınca ya da yanıt
 *     süresi dolunca sonuçların tamamı tek bildirimle gelir; düzenleyen istediği an onaylar (eşitlikte kazananı seçer).
 *     Yanıtlar gelmeden "Seçenekleri düzenle" ile mekan / saat değiştirilebilir.
 *   Kesinleşince: herkese bildirim, 1 gün önce ve günün 08:00'inde hatırlatma; davetli başlangıca kadar katılımını
 *     güncelleyebilir.
 */
import {
  ATTENDANCE_TEXT,
  ATTENDANCE_THIRD_PERSON,
  EVENT_LIMITS,
  EVENT_TEXT,
  attendanceCounts,
  eventNoteCounter,
  eventPhaseText,
  eventSummaryLine,
  eventTally,
  formatEventDate,
  formatMinuteOfDay,
  goingInvitees,
  isActiveEventStage,
  isAnswerComplete,
  pendingInvitees,
  timeCandidates,
  type AttendanceStatus,
  type EpochMs,
  type EventAnswer,
  type EventDoc,
  type UserId,
  type VoteKind,
} from '@konum/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../state/authStore';
import { eventsStore, useEventsStore, type EventResult } from '../../state/eventsStore';
import { useFriendNames, useFriends } from '../../state/friendsStore';
import { pickerRowAccess } from '../access/accessModel';
import { useCanFn } from '../access/useAccess';
import { FriendAvatar } from '../profile/FriendAvatar';
import { Button, cardShadow, Chip, CheckRow, Icon, MIN_TOUCH, Text, IconButton, useTheme } from '../../ui';
import { deadlineLabel, memberName, stageSteps } from './eventModel';
import { optionsProblem, TimeFields, VenueFields, venueDraftsFrom, venueInputs, type VenueDraft } from './EventOptionsFields';
import { useNow } from './useNow';

type Act = (p: Promise<EventResult>) => Promise<boolean>;

function useCard() {
  const { colors, radius, spacing } = useTheme();
  return [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
}

const venueName = (doc: EventDoc, id: string | null) => doc.venue_options.find((o) => o.option_id === id)?.name ?? null;
const timeLabel = (doc: EventDoc, id: string | null) => {
  const t = doc.time_options.find((o) => o.option_id === id);
  return t ? formatMinuteOfDay(t.minute_of_day) : null;
};

/** "Katılacağım · Moda Kahve · 10:00" (çoklu seçenekli türlerde seçim). */
function answerLine(doc: EventDoc, a: EventAnswer): string {
  if (a.status === 'not_going') return ATTENDANCE_TEXT.not_going;
  const picks = [doc.venue_options.length > 1 ? venueName(doc, a.venue_option_id) : null, doc.time_options.length > 1 ? timeLabel(doc, a.time_option_id) : null];
  return [ATTENDANCE_TEXT.going, ...picks.filter((x): x is string => !!x)].join(' · ');
}

export function EventDetailScreen({ eventId }: { eventId: string }) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ skipped?: string }>();
  const me = useAuthStore((s) => s.uid);
  const doc = useEventsStore((s) => s.events[eventId] ?? null);
  const loaded = useEventsStore((s) => s.loaded);
  const busy = useEventsStore((s) => !!s.busy[eventId]);
  const friendNames = useFriendNames();
  const now = useNow(15_000);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const skipped = Number(params.skipped ?? 0);
  const card = useCard();

  useEffect(() => {
    if (eventsStore.getState().focusId === eventId) eventsStore.getState().focus(null);
  }, [eventId]);

  const act: Act = async (p) => {
    setError(null);
    const r = await p;
    if (!r.ok) setError(r.error.message);
    return r.ok;
  };

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
      <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => (router.canGoBack() ? router.back() : router.replace('/events'))} />
      <Text variant="title" accessibilityRole="header" style={styles.flex} numberOfLines={1}>
        {doc?.title ?? 'Etkinlik'}
      </Text>
    </View>
  );

  if (!doc || !me) {
    return (
      <View style={[styles.root, { backgroundColor: colors.bg }]}>
        {header}
        <View style={{ padding: spacing.md }}>
          {loaded ? (
            <Text variant="label" color="textSecondary">
              Etkinlik bulunamadı ya da artık bu etkinlikte değilsin.
            </Text>
          ) : (
            <ActivityIndicator color={colors.textSecondary} />
          )}
        </View>
      </View>
    );
  }

  const isOwner = doc.owner_id === me;
  const name = (u: UserId) => memberName(doc, u, friendNames, me);
  const ended = !isActiveEventStage(doc.stage);
  const started = doc.starts_at !== null && now >= doc.starts_at;

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: colors.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {header}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        <View style={card}>
          <Text variant="label" color={doc.stage === 'cancelled' ? 'danger' : 'primary'}>
            {eventPhaseText(doc)}
          </Text>
          <Text variant="heading">{eventSummaryLine(doc)}</Text>
          <Text variant="caption" color="textSecondary">
            {`Düzenleyen: ${isOwner ? 'Sen' : name(doc.owner_id)}`}
          </Text>
          {doc.description ? <Text variant="body">{doc.description}</Text> : null}
          <Stepper doc={doc} />
          {skipped > 0 ? (
            <Text variant="caption" color="warning">
              {`${skipped} kişi davet edilemedi: seni davet etmene izin vermemişler ya da artık arkadaşın değiller.`}
            </Text>
          ) : null}
        </View>

        {doc.stage === 'voting' && !isOwner ? (
          <BallotCard key={doc.date} doc={doc} me={me} now={now} busy={busy} act={act} />
        ) : null}

        {doc.stage === 'voting' && isOwner ? (
          editing ? (
            <OptionsEditor
              doc={doc}
              busy={busy}
              onCancel={() => setEditing(false)}
              onSave={async (venues, minutes) => {
                const ok = await act(eventsStore.getState().setOptions(doc.event_id, venues, minutes));
                if (ok) setEditing(false);
              }}
            />
          ) : (
            <ResultsCard doc={doc} now={now} busy={busy} name={name} act={act} onEdit={() => setEditing(true)} />
          )
        ) : null}

        {doc.stage === 'final' || doc.stage === 'completed' ? (
          <View style={card} testID="event-final">
            <Text variant="heading">{`Kesinleşti: ${eventSummaryLine(doc)}`}</Text>
            {doc.stage === 'final' ? (
              <Text variant="caption" color="textSecondary">
                {EVENT_TEXT.remindersNote}
              </Text>
            ) : null}
          </View>
        ) : null}

        {doc.stage === 'final' && !isOwner ? <AttendanceCard doc={doc} me={me} busy={busy} disabled={started} act={act} /> : null}

        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="polite" testID="event-error">
            {error}
          </Text>
        ) : null}

        <Participants doc={doc} me={me} isOwner={isOwner} now={now} name={name} />

        {isOwner && !ended && !started ? <OwnerTools doc={doc} busy={busy} act={act} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// --- adımlar ------------------------------------------------------------------------------------

function Stepper({ doc }: { doc: EventDoc }) {
  const { colors, spacing } = useTheme();
  const steps = stageSteps(doc);
  return (
    <View style={[styles.row, { gap: spacing.xs, marginTop: spacing.xs }]} accessibilityLabel={`İlerleme: ${eventPhaseText(doc)}`} testID="event-stepper">
      {steps.map((s, i) => {
        const bg = s.state === 'done' ? colors.live : s.state === 'current' ? colors.primary : colors.surfaceAlt;
        const fg = s.state === 'todo' ? colors.textSecondary : colors.onPrimary;
        return (
          <View key={s.label} style={[styles.flex, { gap: 4 }]}>
            <View style={[styles.bar, { backgroundColor: bg }]} />
            <View style={[styles.row, { gap: 4 }]}>
              <View style={[styles.stepDot, { backgroundColor: bg }]}>
                {s.state === 'done' ? (
                  <Icon name="check" size={12} color={fg} strokeWidth={3} />
                ) : (
                  <Text variant="caption" style={{ color: fg, fontSize: 11, lineHeight: 14 }} maxFontSizeMultiplier={1}>
                    {String(i + 1)}
                  </Text>
                )}
              </View>
              <Text variant="caption" color={s.state === 'todo' ? 'textSecondary' : 'text'} numberOfLines={1} style={styles.flex}>
                {s.label}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// --- ortak: radyo satırı ve katılım düğmeleri ------------------------------------------------------------

function RadioRow({
  label,
  sub,
  selected,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  sub?: string | null;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      accessibilityLabel={sub ? `${label}, ${sub}` : label}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.option,
        {
          minHeight: MIN_TOUCH,
          borderColor: selected ? colors.primary : colors.border,
          borderRadius: radius.md,
          padding: spacing.sm,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
          backgroundColor: selected ? colors.primarySoft : colors.surface,
        },
      ]}
    >
      <View style={[styles.row, { gap: spacing.sm }]}>
        <View style={[styles.radio, { borderColor: selected ? colors.primary : colors.border }]}>{selected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}</View>
        <View style={styles.flex}>
          <Text variant="body">{label}</Text>
          {sub ? (
            <Text variant="caption" color="textSecondary">
              {sub}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Tek seçenek: oylanmaz, sabit satır. */
function FixedRow({ icon, label, sub }: { icon: 'mapPin' | 'clock'; label: string; sub?: string | null }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
      <Icon name={icon} size={20} color={colors.primary} />
      <View style={styles.flex}>
        <Text variant="body">{label}</Text>
        {sub ? (
          <Text variant="caption" color="textSecondary">
            {sub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function AttendanceButtons({
  status,
  disabled,
  onPick,
  testPrefix,
}: {
  status: AttendanceStatus | null;
  disabled: boolean;
  onPick: (s: AttendanceStatus) => void;
  testPrefix: string;
}) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing.xs }]} accessibilityRole="radiogroup">
      <Button
        title={ATTENDANCE_TEXT.going}
        variant={status === 'going' ? 'primary' : 'secondary'}
        block={false}
        style={styles.flex}
        disabled={disabled}
        accessibilityState={{ selected: status === 'going', disabled }}
        onPress={() => onPick('going')}
        testID={`${testPrefix}-going`}
      />
      <Button
        title={ATTENDANCE_TEXT.not_going}
        variant={status === 'not_going' ? 'danger' : 'secondary'}
        block={false}
        style={styles.flex}
        disabled={disabled}
        accessibilityState={{ selected: status === 'not_going', disabled }}
        onPress={() => onPick('not_going')}
        testID={`${testPrefix}-not-going`}
      />
    </View>
  );
}

function NoteField({ value, onChange, testPrefix }: { value: string; onChange: (v: string) => void; testPrefix: string }) {
  const { colors, radius, spacing, typography } = useTheme();
  const counter = eventNoteCounter(value);
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label">{EVENT_TEXT.noteTitle}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={EVENT_TEXT.notePlaceholder}
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="Katılamama notu"
        multiline
        maxLength={EVENT_LIMITS.noteMaxChars * 2}
        style={[typography.body, styles.input, styles.multiline, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
        testID={`${testPrefix}-note`}
      />
      <Text variant="caption" color={counter.over ? 'danger' : 'textSecondary'} align="right" testID={`${testPrefix}-counter`}>
        {counter.label}
      </Text>
    </View>
  );
}

// --- davetli: tek seferlik yanıt ---------------------------------------------------------------------

function BallotCard({ doc, me, now, busy, act }: { doc: EventDoc; me: UserId; now: EpochMs; busy: boolean; act: Act }) {
  const { spacing } = useTheme();
  const card = useCard();
  const current = doc.answers[me] ?? null;
  const [status, setStatus] = useState<AttendanceStatus | null>(current?.status ?? null);
  const [venue, setVenue] = useState<string | null>(current?.venue_option_id ?? null);
  const [time, setTime] = useState<string | null>(current?.time_option_id ?? null);
  const [note, setNote] = useState(current?.note ?? '');

  const venues = doc.venue_options;
  const times = timeCandidates(doc, now);
  // Seçenek kaldırıldıysa (düzenleyen değiştirdi) ya da saat geçtiyse seçim temizlenir.
  const venuePick = venues.length === 1 ? (venues[0]?.option_id ?? null) : venues.some((o) => o.option_id === venue) ? venue : null;
  const timePick = times.length === 1 ? (times[0]?.option_id ?? null) : times.some((o) => o.option_id === time) ? time : null;
  const counter = eventNoteCounter(note);
  const trimmedNote = note.trim() ? note.trim() : null;

  const missing =
    status === null
      ? 'Önce katılıp katılmayacağını seç.'
      : status === 'going' && venues.length > 1 && !venuePick
        ? 'Bir mekan seç.'
        : status === 'going' && times.length > 1 && !timePick
          ? 'Bir saat seç.'
          : status === 'not_going' && counter.over
            ? `Not en çok ${EVENT_LIMITS.noteMaxChars} karakter olabilir.`
            : null;
  const same =
    !!current &&
    current.status === status &&
    (status === 'going' ? current.venue_option_id === venuePick && current.time_option_id === timePick : (current.note ?? null) === trimmedNote);
  const complete = !!current && isAnswerComplete(doc, current, now);
  const deadline = doc.results_at === null ? deadlineLabel(doc.respond_by, now) : null;

  const send = () =>
    act(
      eventsStore.getState().respond(doc.event_id, {
        status: status as AttendanceStatus,
        note: status === 'not_going' ? trimmedNote : null,
        venueOptionId: status === 'going' ? venuePick : null,
        timeOptionId: status === 'going' ? timePick : null,
      }),
    );

  return (
    <View style={card} testID="event-ballot">
      <Text variant="heading">{`${formatEventDate(doc.date)} · ${EVENT_TEXT.ballotTitle}`}</Text>
      <Text variant="caption" color="textSecondary">
        {[EVENT_TEXT.ballotHint, deadline].filter(Boolean).join(' · ')}
      </Text>
      {current && !complete ? (
        <Text variant="label" color="warning">
          Düzenleyen seçenekleri değiştirdi: yanıtını tamamla.
        </Text>
      ) : null}

      <Text variant="label">Katılabilecek misin?</Text>
      <AttendanceButtons status={status} disabled={busy} onPick={setStatus} testPrefix="event-ballot" />

      {status === 'going' ? (
        <View style={{ gap: spacing.xs }}>
          <Text variant="label">{venues.length > 1 ? 'Hangi mekan?' : 'Mekan'}</Text>
          {venues.length === 1 && venues[0] ? (
            <FixedRow icon="mapPin" label={venues[0].name} sub={venues[0].address} />
          ) : (
            venues.map((o) => (
              <RadioRow
                key={o.option_id}
                label={o.name}
                sub={o.address}
                selected={venuePick === o.option_id}
                disabled={busy}
                onPress={() => setVenue(o.option_id)}
                testID={`event-ballot-venue-${o.option_id}`}
              />
            ))
          )}
          <Text variant="label" style={{ marginTop: spacing.xs }}>
            {times.length > 1 ? 'Hangi saat?' : 'Saat'}
          </Text>
          {times.length === 0 ? (
            <Text variant="caption" color="textSecondary">
              Saat seçeneklerinin hepsi geçti.
            </Text>
          ) : times.length === 1 && times[0] ? (
            <FixedRow icon="clock" label={formatMinuteOfDay(times[0].minute_of_day)} sub={formatEventDate(doc.date)} />
          ) : (
            times.map((t) => (
              <RadioRow
                key={t.option_id}
                label={formatMinuteOfDay(t.minute_of_day)}
                selected={timePick === t.option_id}
                disabled={busy}
                onPress={() => setTime(t.option_id)}
                testID={`event-ballot-time-${t.option_id}`}
              />
            ))
          )}
        </View>
      ) : null}

      {status === 'not_going' ? <NoteField value={note} onChange={setNote} testPrefix="event-ballot" /> : null}

      <Text variant="caption" color="textSecondary">
        {EVENT_TEXT.votesHidden}
      </Text>
      {missing && status !== null ? (
        <Text variant="caption" color="warning">
          {missing}
        </Text>
      ) : null}
      <Button
        title={current ? EVENT_TEXT.resend : EVENT_TEXT.send}
        variant={status === 'not_going' ? 'danger' : 'primary'}
        disabled={busy || missing !== null || (same && complete)}
        loading={busy}
        onPress={() => void send()}
        testID="event-ballot-send"
      />
      {current && complete && same ? (
        <Text variant="caption" color="live" testID="event-ballot-sent" accessibilityLiveRegion="polite">
          {`${answerLine(doc, current)}. ${EVENT_TEXT.sent}`}
        </Text>
      ) : null}
    </View>
  );
}

// --- düzenleyen: sonuçlar ve onay ------------------------------------------------------------------

function TallyList({ doc, kind, now, name, pick, onPick }: { doc: EventDoc; kind: VoteKind; now: EpochMs; name: (u: UserId) => string; pick: string | null; onPick: (id: string) => void }) {
  const { colors, radius, spacing } = useTheme();
  const busy = useEventsStore((s) => !!s.busy[doc.event_id]);
  const tally = eventTally(doc, kind, now);
  const options =
    kind === 'venue'
      ? doc.venue_options.map((o) => ({ id: o.option_id, label: o.name, sub: o.address }))
      : timeCandidates(doc, now).map((t) => ({ id: t.option_id, label: formatMinuteOfDay(t.minute_of_day), sub: null as string | null }));
  const title = kind === 'venue' ? 'Mekan' : 'Saat';
  if (options.length === 0) {
    return (
      <Text variant="caption" color="warning">
        Saat seçeneklerinin hepsi geçti; etkinlik onaylanamaz.
      </Text>
    );
  }
  if (options.length === 1 && options[0]) {
    return <FixedRow icon={kind === 'venue' ? 'mapPin' : 'clock'} label={options[0].label} sub={`${title} sabit · ${tally.total} kişi katılıyor`} />;
  }
  const tie = tally.leaders.length > 1;
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label">{`${title} oyları (${tally.total}/${tally.eligible})`}</Text>
      {options.map((o) => {
        const count = tally.counts[o.id] ?? 0;
        const who = (tally.voters[o.id] ?? []).map(name);
        const leader = tally.total > 0 && tally.leaders.includes(o.id);
        const pct = tally.eligible > 0 ? count / tally.eligible : 0;
        return (
          <View
            key={o.id}
            testID={`event-results-${kind}-${o.id}`}
            accessibilityLabel={`${o.label}, ${count} oy${who.length ? `: ${who.join(', ')}` : ''}${leader && !tie ? ', önde' : ''}`}
            style={[styles.option, { borderColor: leader ? colors.live : colors.border, borderRadius: radius.md, padding: spacing.sm }]}
          >
            <View style={[styles.fill, { width: `${Math.round(pct * 100)}%`, backgroundColor: leader ? colors.liveSoft : colors.surfaceAlt, borderRadius: radius.md }]} />
            <View style={[styles.row, { gap: spacing.sm }]}>
              <View style={styles.flex}>
                <Text variant="body">{o.label}</Text>
                <Text variant="caption" color="textSecondary">
                  {[o.sub, who.length ? who.join(', ') : 'Henüz oy yok'].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Text variant="label" color={leader ? 'live' : 'textSecondary'}>
                {`${count} oy`}
              </Text>
            </View>
          </View>
        );
      })}
      {tie ? (
        <View style={{ gap: spacing.xs }}>
          <Text variant="label" color="warning">{`${title}: ${EVENT_TEXT.tieTitle}`}</Text>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {tally.leaders.map((id) => (
              <Chip key={id} label={options.find((o) => o.id === id)?.label ?? id} selected={pick === id} disabled={busy} onPress={() => onPick(id)} testID={`event-tie-${kind}-${id}`} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ResultsCard({ doc, now, busy, name, act, onEdit }: { doc: EventDoc; now: EpochMs; busy: boolean; name: (u: UserId) => string; act: Act; onEdit: () => void }) {
  const { spacing } = useTheme();
  const card = useCard();
  const [venuePick, setVenuePick] = useState<string | null>(null);
  const [timePick, setTimePick] = useState<string | null>(null);
  const c = attendanceCounts(doc);
  const pending = pendingInvitees(doc, now);
  const answered = doc.invitee_ids.length - pending.length;
  const going = goingInvitees(doc).length;
  const vt = eventTally(doc, 'venue', now);
  const tt = eventTally(doc, 'time', now);
  const venueTie = vt.leaders.length > 1;
  const timeTie = tt.leaders.length > 1;
  const venueChoice = venueTie && venuePick && vt.leaders.includes(venuePick) ? venuePick : null;
  const timeChoice = timeTie && timePick && tt.leaders.includes(timePick) ? timePick : null;
  const blocker =
    going === 0
      ? EVENT_TEXT.needAttendee
      : tt.leaders.length === 0
        ? 'Saat seçeneklerinin hepsi geçti.'
        : venueTie && !venueChoice
          ? 'Mekan için kazananı seç.'
          : timeTie && !timeChoice
            ? 'Saat için kazananı seç.'
            : null;
  const deadline = doc.results_at === null ? deadlineLabel(doc.respond_by, now) : null;
  const status =
    doc.results_at !== null
      ? doc.results_reason === 'deadline'
        ? 'Yanıt süresi doldu: sonuçlar hazır.'
        : 'Herkes yanıtladı: sonuçlar hazır.'
      : EVENT_TEXT.waitingResults;

  const finalize = () => act(eventsStore.getState().finalize(doc.event_id, { venueOptionId: venueChoice, timeOptionId: timeChoice }));
  const confirm = () => {
    if (pending.length === 0) {
      void finalize();
      return;
    }
    Alert.alert('Yanıt bekleyenler var', `${pending.map(name).join(', ')} henüz yanıt vermedi. Yine de onaylayıp herkese bildirelim mi?`, [
      { text: 'Bekle', style: 'cancel' },
      { text: 'Onayla', onPress: () => void finalize() },
    ]);
  };

  return (
    <View style={card} testID="event-results">
      <Text variant="heading">{EVENT_TEXT.resultsTitle}</Text>
      <Text variant="caption" color={doc.results_at !== null ? 'live' : 'textSecondary'} testID="event-results-status">
        {status}
      </Text>
      <Text variant="label">{`${answered}/${doc.invitee_ids.length} yanıt · ${c.going} katılacak (sen dahil) · ${c.not_going} katılamayacak${deadline ? ` · ${deadline}` : ''}`}</Text>
      <TallyList doc={doc} kind="venue" now={now} name={name} pick={venueChoice} onPick={setVenuePick} />
      <TallyList doc={doc} kind="time" now={now} name={name} pick={timeChoice} onPick={setTimePick} />
      {pending.length > 0 ? (
        <Text variant="caption" color="textSecondary">
          {`Yanıt bekleniyor: ${pending.map(name).join(', ')}`}
        </Text>
      ) : null}
      {blocker ? (
        <Text variant="caption" color="warning">
          {blocker}
        </Text>
      ) : null}
      <Button title={EVENT_TEXT.finalize} disabled={busy || blocker !== null} loading={busy} onPress={confirm} testID="event-finalize" />
      <Button title={EVENT_TEXT.editOptions} variant="secondary" disabled={busy} onPress={onEdit} testID="event-options-edit" style={{ marginTop: spacing.xs }} />
    </View>
  );
}

function OptionsEditor({
  doc,
  busy,
  onCancel,
  onSave,
}: {
  doc: EventDoc;
  busy: boolean;
  onCancel: () => void;
  onSave: (venues: ReturnType<typeof venueInputs>, minutes: number[]) => Promise<void>;
}) {
  const { spacing } = useTheme();
  const card = useCard();
  const [venues, setVenues] = useState<VenueDraft[]>(() => venueDraftsFrom(doc.venue_options));
  const [minutes, setMinutes] = useState<number[]>(() => doc.time_options.map((t) => t.minute_of_day));
  const problem = optionsProblem(venues, minutes);
  return (
    <View style={card} testID="event-options-editor">
      <Text variant="heading">{EVENT_TEXT.editOptions}</Text>
      <Text variant="caption" color="textSecondary">
        {EVENT_TEXT.optionsChangedHint}
      </Text>
      <Text variant="label">{`Mekanlar (en çok ${EVENT_LIMITS.maxVenueOptions})`}</Text>
      <VenueFields venues={venues} onChange={setVenues} />
      <Text variant="label" style={{ marginTop: spacing.xs }}>{`Saatler (en çok ${EVENT_LIMITS.maxTimeOptions})`}</Text>
      <TimeFields minutes={minutes} onChange={setMinutes} />
      {problem ? (
        <Text variant="caption" color="warning">
          {problem}
        </Text>
      ) : null}
      <Button title={EVENT_TEXT.saveOptions} disabled={busy || problem !== null} loading={busy} onPress={() => void onSave(venueInputs(venues), minutes)} testID="event-options-save" />
      <Button title="Vazgeç" variant="ghost" disabled={busy} onPress={onCancel} />
    </View>
  );
}

// --- davetli: kesinleşince katılım güncelleme -----------------------------------------------------------

function AttendanceCard({ doc, me, busy, disabled, act }: { doc: EventDoc; me: UserId; busy: boolean; disabled: boolean; act: Act }) {
  const card = useCard();
  const current = doc.answers[me] ?? null;
  const [status, setStatus] = useState<AttendanceStatus | null>(current?.status ?? null);
  const [note, setNote] = useState(current?.note ?? '');
  const counter = eventNoteCounter(note);
  const trimmedNote = note.trim() ? note.trim() : null;
  const same = !!current && current.status === status && (status === 'going' || (current.note ?? null) === trimmedNote);
  return (
    <View style={card} testID="event-attendance">
      <Text variant="heading">Katılımın</Text>
      <Text variant="caption" color="textSecondary">
        {disabled ? 'Buluşma başladı, katılım artık değiştirilemez.' : current ? EVENT_TEXT.finalChange : 'Henüz yanıt vermedin. Katılıp katılmayacağını bildir.'}
      </Text>
      {current ? (
        <Text variant="label" color={current.status === 'going' ? 'live' : 'warning'}>
          {`Yanıtın: ${ATTENDANCE_TEXT[current.status]}`}
        </Text>
      ) : null}
      <AttendanceButtons status={status} disabled={busy || disabled} onPick={setStatus} testPrefix="event-attendance" />
      {status === 'not_going' && !disabled ? <NoteField value={note} onChange={setNote} testPrefix="event-attendance" /> : null}
      {!disabled && status !== null && !same ? (
        <Button
          title="Katılımımı güncelle"
          variant={status === 'not_going' ? 'danger' : 'primary'}
          disabled={busy || (status === 'not_going' && counter.over)}
          loading={busy}
          onPress={() => void act(eventsStore.getState().respond(doc.event_id, { status, note: status === 'not_going' ? trimmedNote : null }))}
          testID="event-attendance-send"
        />
      ) : null}
    </View>
  );
}

// --- katılımcılar -----------------------------------------------------------------------------------

function Participants({ doc, me, isOwner, now, name }: { doc: EventDoc; me: UserId; isOwner: boolean; now: EpochMs; name: (u: UserId) => string }) {
  const { colors, radius, spacing } = useTheme();
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs }];
  const rows = [doc.owner_id, ...doc.invitee_ids];
  const c = attendanceCounts(doc);
  return (
    <View style={card} testID="event-participants">
      <Text variant="heading">Katılım</Text>
      <Text variant="caption" color="textSecondary">{`${c.going} katılacak · ${c.not_going} katılamayacak · ${c.pending} yanıt bekleniyor`}</Text>
      {rows.map((u) => {
        const owner = u === doc.owner_id;
        const a = owner ? null : (doc.answers[u] ?? null);
        const status: AttendanceStatus | null = owner ? 'going' : (a?.status ?? null);
        const incomplete = !!a && doc.stage === 'voting' && !isAnswerComplete(doc, a, now);
        const label = owner ? 'Düzenleyen' : incomplete ? 'Yanıtı eksik' : u === me && status === null ? 'Yanıtın bekleniyor' : ATTENDANCE_THIRD_PERSON[status ?? 'pending'];
        const tone = incomplete ? colors.warning : status === 'going' ? colors.live : status === 'not_going' ? colors.warning : colors.textSecondary;
        // Seçimler yalnızca düzenleyene (ve kişinin kendisine) görünür; not herkese.
        const picks = a && a.status === 'going' && (isOwner || u === me) && doc.stage === 'voting' ? answerLine(doc, a).split(' · ').slice(1).join(' · ') : '';
        return (
          <View key={u} style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]} testID={`event-participant-${u}`}>
            <FriendAvatar uid={u} fallbackName={doc.names[u] ?? 'Davetli'} size={32} />
            <View style={styles.flex}>
              <Text variant="body">{name(u)}</Text>
              {picks ? (
                <Text variant="caption" color="textSecondary">
                  {picks}
                </Text>
              ) : null}
              {a?.status === 'not_going' && a.note ? (
                <Text variant="caption" color="textSecondary" testID={`event-note-${u}`}>{`“${a.note}”`}</Text>
              ) : null}
            </View>
            <Text variant="label" style={{ color: tone }}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// --- sahip araçları -----------------------------------------------------------------------------------

function OwnerTools({ doc, busy, act }: { doc: EventDoc; busy: boolean; act: Act }) {
  const { spacing } = useTheme();
  const card = useCard();
  const friends = useFriends();
  const can = useCanFn();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = useMemo(() => friends.filter((f) => !doc.member_ids.includes(f.uid)), [friends, doc.member_ids]);
  const roomLeft = EVENT_LIMITS.maxInvitees - doc.invitee_ids.length;

  const confirmCancel = () =>
    Alert.alert(EVENT_TEXT.cancel, EVENT_TEXT.cancelConfirm, [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'İptal et', style: 'destructive', onPress: () => void act(eventsStore.getState().cancel(doc.event_id)) },
    ]);

  return (
    <View style={card} testID="event-owner-tools">
      <Text variant="heading">Düzenleyen araçları</Text>
      {inviteOpen ? (
        <View style={{ gap: spacing.xs }}>
          <Text variant="label">{`Davet et (en çok ${roomLeft} kişi daha)`}</Text>
          {candidates.length === 0 ? (
            <Text variant="caption" color="textSecondary">
              Davet edilecek başka arkadaşın yok.
            </Text>
          ) : (
            candidates.map((f) => {
              const access = pickerRowAccess('meetup_invite', f.uid, can);
              const selected = picked.includes(f.uid);
              return (
                <CheckRow
                  key={f.uid}
                  checked={selected}
                  disabled={(!!access?.disabledReason && !selected) || (!selected && picked.length >= roomLeft)}
                  onPress={() => setPicked((p) => (p.includes(f.uid) ? p.filter((x) => x !== f.uid) : [...p, f.uid]))}
                  title={f.displayName}
                  subtitle={access?.disabledReason ?? undefined}
                  left={<FriendAvatar uid={f.uid} fallbackName={f.displayName} size={32} />}
                />
              );
            })
          )}
          <Button
            title={picked.length ? `${picked.length} kişiyi davet et` : 'Kişi seç'}
            disabled={busy || picked.length === 0}
            onPress={async () => {
              const ok = await act(eventsStore.getState().inviteAdd(doc.event_id, picked));
              if (ok) {
                setPicked([]);
                setInviteOpen(false);
              }
            }}
          />
        </View>
      ) : roomLeft > 0 ? (
        <Button title="Daha fazla kişi davet et" variant="secondary" onPress={() => setInviteOpen(true)} />
      ) : null}

      <Button title={EVENT_TEXT.cancel} variant="ghost" disabled={busy} onPress={confirmCancel} testID="event-cancel" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  bar: { height: 4, borderRadius: 2 },
  stepDot: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 44, paddingVertical: 10 },
  multiline: { minHeight: 90, textAlignVertical: 'top' },
  option: { borderWidth: 1.5, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
