/**
 * Faz 7: etkinlik kartı (app/(main)/events/[id].tsx). Üç aşamalı oylama, core `reduceEvent` sunucuda çalışır:
 *
 *   Aşama 1 · Tarih ve katılım: davetli "Katılacağım" / "Katılamayacağım" der; katılamayacaksa 300 karakterlik notu
 *     kartta herkes görür. Mekan seçenekleri burada toplanır (sahip + "Katılacağım" diyen her davetli 1 öneri,
 *     toplam 3). 3 seçenek ve en az bir katılımcı olunca sahip "Mekan oylamasını başlat"a basar.
 *   Aşama 2 · Mekan oylaması: katılacaklar 3 mekandan birine oy verir; herkes oy verince ya da süre dolunca en çok
 *     oyu alan kazanır (eşitlikte sahip seçer, süre dolumunda ilk önerilen).
 *   Aşama 3 · Saat oylaması ve son onay: sahip 2–4 saat seçeneği ekler (oluştururken eklediyse hemen başlar), oylama
 *     aynı kuralla kapanır; buluşma kesinleşince herkes son onayını verir. Hatırlatmalar 1 gün önce ve günün 08:00'i.
 */
import {
  ATTENDANCE_TEXT,
  ATTENDANCE_THIRD_PERSON,
  EVENT_LIMITS,
  EVENT_STAGE_TEXT,
  EVENT_TEXT,
  eventNoteCounter,
  eventSummaryLine,
  eventTally,
  eventVoters,
  finalStatusOf,
  formatEventDate,
  formatMinuteOfDay,
  initialStatusOf,
  isActiveEventStage,
  parseClock,
  type AttendanceStatus,
  type EventDoc,
  type RsvpRound,
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
import { Button, cardShadow, Chip, CheckRow, Icon, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { deadlineLabel, memberName, stageSteps, TIME_PRESETS, toggleMinute, voteWindowLabel } from './eventModel';
import { useNow } from './useNow';

export function EventDetailScreen({ eventId }: { eventId: string }) {
  const { colors, radius, spacing } = useTheme();
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
  const [tieLeaders, setTieLeaders] = useState<{ kind: VoteKind; ids: string[] } | null>(null);
  const skipped = Number(params.skipped ?? 0);

  useEffect(() => {
    if (eventsStore.getState().focusId === eventId) eventsStore.getState().focus(null);
  }, [eventId]);

  const act = async (p: Promise<EventResult>) => {
    setError(null);
    const r = await p;
    if (!r.ok) {
      setError(r.error.message);
      const leaders = r.extra.leaders;
      if (r.error.code === 'event_vote_tie' && Array.isArray(leaders)) setTieLeaders((t) => (t ? { ...t, ids: leaders.map(String) } : null));
    } else setTieLeaders(null);
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
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const ended = !isActiveEventStage(doc.stage);
  const myInitial = initialStatusOf(doc, me);
  const voters = eventVoters(doc);
  const canVote = voters.includes(me);

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: colors.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {header}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        <View style={card}>
          <Text variant="label" color={doc.stage === 'cancelled' ? 'danger' : 'primary'}>
            {EVENT_STAGE_TEXT[doc.stage]}
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

        {/* Aşama 1: katılım ön onayı (oylama sürerken de verilebilir; geç gelen oy hakkı kazanır). */}
        {!isOwner && (doc.stage === 'rsvp' || doc.stage === 'venue_vote' || doc.stage === 'time_vote') ? (
          <RsvpCard
            title={doc.stage === 'rsvp' ? `${formatEventDate(doc.date)} günü katılabilecek misin?` : 'Katılım durumun'}
            current={doc.rsvp[me] ?? null}
            round="initial"
            busy={busy}
            onSend={(status, note) => act(eventsStore.getState().rsvp(doc.event_id, 'initial', status, note))}
          />
        ) : null}

        {doc.stage === 'rsvp' ? (
          <VenueCollect doc={doc} me={me} isOwner={isOwner} busy={busy} name={name} act={act} />
        ) : null}

        {doc.stage === 'venue_vote' ? (
          <VoteCard
            doc={doc}
            me={me}
            kind="venue"
            now={now}
            canVote={canVote}
            isOwner={isOwner}
            busy={busy}
            tie={tieLeaders?.kind === 'venue' ? tieLeaders.ids : null}
            onVote={(id) => act(eventsStore.getState().vote(doc.event_id, 'venue', id))}
            onClose={async (tieBreak) => {
              setTieLeaders({ kind: 'venue', ids: tieLeaders?.ids ?? [] });
              await act(eventsStore.getState().advance(doc.event_id, 'close_venue_vote', { tieBreak }));
            }}
          />
        ) : null}

        {doc.stage === 'time_vote' && doc.stage_deadline_at === null ? (
          isOwner ? (
            <TimeOptionsEditor doc={doc} busy={busy} onSave={(m) => act(eventsStore.getState().setTimes(doc.event_id, m))} />
          ) : (
            <View style={card}>
              <Text variant="heading">{EVENT_TEXT.waitingTimes}</Text>
              <Text variant="label" color="textSecondary">
                Mekan kesinleşti. Düzenleyen saat seçeneklerini ekleyince oylama başlayacak ve sana haber vereceğiz.
              </Text>
            </View>
          )
        ) : null}

        {doc.stage === 'time_vote' && doc.stage_deadline_at !== null ? (
          <VoteCard
            doc={doc}
            me={me}
            kind="time"
            now={now}
            canVote={canVote}
            isOwner={isOwner}
            busy={busy}
            tie={tieLeaders?.kind === 'time' ? tieLeaders.ids : null}
            onVote={(id) => act(eventsStore.getState().vote(doc.event_id, 'time', id))}
            onClose={async (tieBreak) => {
              setTieLeaders({ kind: 'time', ids: tieLeaders?.ids ?? [] });
              await act(eventsStore.getState().advance(doc.event_id, 'close_time_vote', { tieBreak }));
            }}
          />
        ) : null}

        {doc.stage === 'final' ? (
          <View style={card}>
            <Text variant="heading">{`Kesinleşti: ${eventSummaryLine(doc)}`}</Text>
            <Text variant="caption" color="textSecondary">
              {EVENT_TEXT.remindersNote}
            </Text>
          </View>
        ) : null}

        {doc.stage === 'final' && !isOwner ? (
          <RsvpCard
            title={EVENT_TEXT.finalQuestion}
            current={doc.final_rsvp[me] ?? null}
            round="final"
            busy={busy}
            disabled={doc.starts_at !== null && now >= doc.starts_at}
            onSend={(status, note) => act(eventsStore.getState().rsvp(doc.event_id, 'final', status, note))}
          />
        ) : null}

        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="polite" testID="event-error">
            {error}
          </Text>
        ) : null}

        <Participants doc={doc} me={me} name={name} />

        {isOwner && !ended ? <OwnerTools doc={doc} busy={busy} act={act} /> : null}
        {!isOwner && myInitial === null && doc.stage === 'final' ? (
          <Text variant="caption" color="textSecondary">
            İlk aşamada yanıt vermedin; son onayını yine de verebilirsin.
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// --- adımlar ------------------------------------------------------------------------------------

function Stepper({ doc }: { doc: EventDoc }) {
  const { colors, spacing } = useTheme();
  const steps = stageSteps(doc.stage);
  return (
    <View style={[styles.row, { gap: spacing.xs, marginTop: spacing.xs }]} accessibilityLabel={`İlerleme: ${EVENT_STAGE_TEXT[doc.stage]}`} testID="event-stepper">
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

// --- katılım ------------------------------------------------------------------------------------

function RsvpCard({
  title,
  current,
  round,
  busy,
  disabled = false,
  onSend,
}: {
  title: string;
  current: { status: AttendanceStatus; note: string | null } | null;
  round: RsvpRound;
  busy: boolean;
  disabled?: boolean;
  onSend: (status: AttendanceStatus, note: string | null) => Promise<boolean>;
}) {
  const { colors, radius, spacing, typography } = useTheme();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(current?.note ?? '');
  const counter = eventNoteCounter(note);
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  return (
    <View style={card} testID={`event-rsvp-${round}`}>
      <Text variant="heading">{title}</Text>
      {current ? (
        <Text variant="label" color={current.status === 'going' ? 'live' : 'warning'}>
          {`Yanıtın: ${ATTENDANCE_TEXT[current.status]}`}
        </Text>
      ) : null}
      <View style={[styles.row, { gap: spacing.xs }]}>
        <Button
          title={ATTENDANCE_TEXT.going}
          variant={current?.status === 'going' ? 'primary' : 'secondary'}
          block={false}
          style={styles.flex}
          disabled={busy || disabled}
          onPress={() => {
            setNoteOpen(false);
            void onSend('going', null);
          }}
          testID={`event-rsvp-${round}-going`}
        />
        <Button
          title={ATTENDANCE_TEXT.not_going}
          variant={current?.status === 'not_going' ? 'danger' : 'secondary'}
          block={false}
          style={styles.flex}
          disabled={busy || disabled}
          onPress={() => setNoteOpen(true)}
          testID={`event-rsvp-${round}-not-going`}
        />
      </View>
      {noteOpen ? (
        <View style={{ gap: spacing.xs }}>
          <Text variant="label">{EVENT_TEXT.noteTitle}</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={EVENT_TEXT.notePlaceholder}
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Katılamama notu"
            multiline
            maxLength={EVENT_LIMITS.noteMaxChars * 2}
            style={[typography.body, styles.input, styles.multiline, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
            testID={`event-rsvp-${round}-note`}
          />
          <Text variant="caption" color={counter.over ? 'danger' : 'textSecondary'} align="right" testID={`event-rsvp-${round}-counter`}>
            {counter.label}
          </Text>
          <Button
            title="Gönder"
            variant="danger"
            disabled={busy || counter.over}
            loading={busy}
            onPress={async () => {
              const ok = await onSend('not_going', note.trim() ? note.trim() : null);
              if (ok) setNoteOpen(false);
            }}
            testID={`event-rsvp-${round}-send`}
          />
        </View>
      ) : current?.status === 'not_going' && current.note ? (
        <Text variant="caption" color="textSecondary">{`Notun: “${current.note}”`}</Text>
      ) : null}
    </View>
  );
}

// --- Aşama 1: mekan önerileri -------------------------------------------------------------------

function VenueCollect({
  doc,
  me,
  isOwner,
  busy,
  name,
  act,
}: {
  doc: EventDoc;
  me: UserId;
  isOwner: boolean;
  busy: boolean;
  name: (u: UserId) => string;
  act: (p: Promise<EventResult>) => Promise<boolean>;
}) {
  const { colors, radius, spacing, typography } = useTheme();
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  const full = doc.venue_options.length >= EVENT_LIMITS.venueOptions;
  const mineCount = doc.venue_options.filter((o) => o.proposed_by === me).length;
  const going = doc.rsvp[me]?.status === 'going';
  const canPropose = !full && (isOwner || (going && mineCount < EVENT_LIMITS.venueProposalsPerInvitee));
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const inputStyle = [typography.body, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }];

  return (
    <View style={card} testID="event-venues">
      <Text variant="heading">{`Mekan seçenekleri (${doc.venue_options.length}/${EVENT_LIMITS.venueOptions})`}</Text>
      {doc.venue_options.length === 0 ? (
        <Text variant="label" color="textSecondary">
          Henüz öneri yok. {isOwner ? 'Mekanları sen ekleyebilir ya da katılacakların önermesini bekleyebilirsin.' : '"Katılacağım" dersen bir mekan önerebilirsin.'}
        </Text>
      ) : (
        doc.venue_options.map((o) => (
          <View key={o.option_id} style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
            <Icon name="mapPin" size={20} color={colors.primary} />
            <View style={styles.flex}>
              <Text variant="body">{o.name}</Text>
              <Text variant="caption" color="textSecondary">
                {[o.address, `${name(o.proposed_by)} önerdi`].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {isOwner || o.proposed_by === me ? (
              <IconButton icon="close" accessibilityLabel={`${o.name} önerisini kaldır`} disabled={busy} onPress={() => void act(eventsStore.getState().removeVenue(doc.event_id, o.option_id))} />
            ) : null}
          </View>
        ))
      )}
      {canPropose ? (
        <View style={{ gap: spacing.xs }}>
          <TextInput
            value={venueName}
            onChangeText={setVenueName}
            placeholder="Mekan adı (ör. Moda Kahve)"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Önerilen mekan adı"
            maxLength={EVENT_LIMITS.venueNameMaxChars * 2}
            style={inputStyle}
            testID="event-venue-name"
          />
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder="Adres ya da semt (isteğe bağlı)"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Önerilen mekan adresi"
            maxLength={EVENT_LIMITS.venueAddressMaxChars * 2}
            style={inputStyle}
          />
          <Button
            title="Mekan öner"
            variant="secondary"
            disabled={busy || !venueName.trim()}
            onPress={async () => {
              const ok = await act(eventsStore.getState().proposeVenue(doc.event_id, { name: venueName.trim(), address: address.trim() ? address.trim() : null, location: null, place_id: null }));
              if (ok) {
                setVenueName('');
                setAddress('');
              }
            }}
            testID="event-venue-propose"
          />
        </View>
      ) : !full && !isOwner && going ? (
        <Text variant="caption" color="textSecondary">
          Önerini yaptın. Diğerleri de önerince sahip oylamayı başlatacak.
        </Text>
      ) : null}
      {!full ? (
        <Text variant="caption" color="textSecondary">
          {EVENT_TEXT.venueVoteNeeds}
        </Text>
      ) : null}
    </View>
  );
}

// --- Aşama 2 / 3: oylama -------------------------------------------------------------------------

function VoteCard({
  doc,
  me,
  kind,
  now,
  canVote,
  isOwner,
  busy,
  tie,
  onVote,
  onClose,
}: {
  doc: EventDoc;
  me: UserId;
  kind: VoteKind;
  now: number;
  canVote: boolean;
  isOwner: boolean;
  busy: boolean;
  tie: string[] | null;
  onVote: (optionId: string) => Promise<boolean>;
  onClose: (tieBreak: string | null) => Promise<void>;
}) {
  const { colors, radius, spacing } = useTheme();
  const tally = eventTally(doc, kind, now);
  const votes = kind === 'venue' ? doc.venue_votes : doc.time_votes;
  const options =
    kind === 'venue'
      ? doc.venue_options.map((o) => ({ id: o.option_id, label: o.name, sub: o.address }))
      : doc.time_options.filter((t) => t.starts_at > now).map((t) => ({ id: t.option_id, label: formatMinuteOfDay(t.minute_of_day), sub: formatEventDate(doc.date) }));
  const mine = votes[me] ?? null;
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const deadline = deadlineLabel(doc.stage_deadline_at, now);
  const title = kind === 'venue' ? 'Mekan oylaması' : 'Saat oylaması';

  return (
    <View style={card} testID={`event-vote-${kind}`}>
      <Text variant="heading">{title}</Text>
      <Text variant="caption" color="textSecondary">
        {`${tally.total}/${tally.eligible} oy${deadline ? ` · ${deadline}` : ''}`}
      </Text>
      {!canVote ? (
        <Text variant="label" color="warning">
          {EVENT_TEXT.notEligibleVote}
        </Text>
      ) : null}
      {options.map((o) => {
        const count = tally.counts[o.id] ?? 0;
        const selected = mine === o.id;
        const leader = tally.total > 0 && tally.leaders.includes(o.id);
        const pct = tally.eligible > 0 ? count / tally.eligible : 0;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: !canVote || busy }}
            accessibilityLabel={`${o.label}, ${count} oy${selected ? ', senin oyun' : ''}`}
            disabled={!canVote || busy}
            onPress={() => void onVote(o.id)}
            testID={`event-vote-${kind}-${o.id}`}
            style={({ pressed }) => [
              styles.option,
              { borderColor: selected ? colors.primary : colors.border, borderRadius: radius.md, padding: spacing.sm, opacity: pressed ? 0.8 : 1, backgroundColor: selected ? colors.primarySoft : colors.surface },
            ]}
          >
            <View style={[styles.fill, { width: `${Math.round(pct * 100)}%`, backgroundColor: leader ? colors.liveSoft : colors.surfaceAlt, borderRadius: radius.md }]} />
            <View style={[styles.row, { gap: spacing.sm }]}>
              <View style={[styles.radio, { borderColor: selected ? colors.primary : colors.border }]}>{selected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}</View>
              <View style={styles.flex}>
                <Text variant="body">{o.label}</Text>
                {o.sub ? (
                  <Text variant="caption" color="textSecondary">
                    {o.sub}
                  </Text>
                ) : null}
              </View>
              <Text variant="label" color={leader ? 'live' : 'textSecondary'}>
                {`${count} oy`}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {isOwner ? (
        tie && tie.length > 1 ? (
          <View style={{ gap: spacing.xs }} testID={`event-tie-${kind}`}>
            <Text variant="label">{EVENT_TEXT.tieTitle}</Text>
            <View style={[styles.wrap, { gap: spacing.xs }]}>
              {tie.map((id) => (
                <Chip key={id} label={options.find((o) => o.id === id)?.label ?? id} onPress={() => void onClose(id)} disabled={busy} />
              ))}
            </View>
          </View>
        ) : (
          <Button title={EVENT_TEXT.closeVote} variant="secondary" disabled={busy || options.length === 0} onPress={() => void onClose(null)} testID={`event-close-${kind}`} />
        )
      ) : null}
    </View>
  );
}

// --- Aşama 3: saat seçenekleri (sahip) ------------------------------------------------------------

function TimeOptionsEditor({ doc, busy, onSave }: { doc: EventDoc; busy: boolean; onSave: (minutes: number[]) => Promise<boolean> }) {
  const { colors, radius, spacing, typography } = useTheme();
  const [minutes, setMinutes] = useState<number[]>(doc.time_options.map((t) => t.minute_of_day));
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const add = () => {
    const m = parseClock(custom);
    if (m === null) {
      setErr('Saati 19:30 biçiminde yaz.');
      return;
    }
    setMinutes((p) => toggleMinute(p.filter((x) => x !== m), m));
    setCustom('');
    setErr(null);
  };
  return (
    <View style={card} testID="event-times-editor">
      <Text variant="heading">{EVENT_TEXT.needTimes}</Text>
      <Text variant="caption" color="textSecondary">
        {`${EVENT_LIMITS.minTimeOptions}–${EVENT_LIMITS.maxTimeOptions} saat seç. En az 30 dk sonrası olmalı; oylama ilk saatten 15 dk önce kapanır.`}
      </Text>
      <View style={[styles.wrap, { gap: spacing.xs }]}>
        {[...new Set([...TIME_PRESETS, ...minutes])]
          .sort((a, b) => a - b)
          .map((m) => (
            <Chip key={m} label={formatMinuteOfDay(m)} selected={minutes.includes(m)} onPress={() => setMinutes((p) => toggleMinute(p, m))} />
          ))}
      </View>
      <View style={[styles.row, { gap: spacing.xs }]}>
        <TextInput
          value={custom}
          onChangeText={setCustom}
          placeholder="Başka saat: 17:45"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Başka saat"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          onSubmitEditing={add}
          style={[typography.body, styles.input, styles.flex, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
        />
        <Button title="Ekle" variant="secondary" block={false} onPress={add} disabled={!custom.trim()} />
      </View>
      {err ? (
        <Text variant="caption" color="danger">
          {err}
        </Text>
      ) : null}
      <Button
        title="Saat oylamasını başlat"
        disabled={busy || minutes.length < EVENT_LIMITS.minTimeOptions}
        loading={busy}
        onPress={() => void onSave(minutes)}
        testID="event-times-save"
      />
    </View>
  );
}

// --- katılımcılar -----------------------------------------------------------------------------------

function Participants({ doc, me, name }: { doc: EventDoc; me: UserId; name: (u: UserId) => string }) {
  const { colors, radius, spacing } = useTheme();
  const finalRound = doc.stage === 'final' || doc.stage === 'completed';
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs }];
  const rows = [doc.owner_id, ...doc.invitee_ids];
  return (
    <View style={card} testID="event-participants">
      <Text variant="heading">{finalRound ? 'Son onaylar' : 'Katılım'}</Text>
      {rows.map((u) => {
        const owner = u === doc.owner_id;
        const status = owner ? 'going' : finalRound ? finalStatusOf(doc, u) : initialStatusOf(doc, u);
        const answer = owner ? null : finalRound ? doc.final_rsvp[u] : doc.rsvp[u];
        const label = owner ? 'Düzenleyen' : ATTENDANCE_THIRD_PERSON[status ?? 'pending'];
        const tone = status === 'going' ? colors.live : status === 'not_going' ? colors.warning : colors.textSecondary;
        return (
          <View key={u} style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
            <FriendAvatar uid={u} fallbackName={doc.names[u] ?? 'Davetli'} size={32} />
            <View style={styles.flex}>
              <Text variant="body">{name(u)}</Text>
              {answer?.status === 'not_going' && answer.note ? (
                <Text variant="caption" color="textSecondary" testID={`event-note-${u}`}>{`“${answer.note}”`}</Text>
              ) : null}
            </View>
            <Text variant="label" style={{ color: tone }}>
              {u === me && !owner && status === null ? 'Yanıtın bekleniyor' : label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// --- sahip araçları -----------------------------------------------------------------------------------

function OwnerTools({ doc, busy, act }: { doc: EventDoc; busy: boolean; act: (p: Promise<EventResult>) => Promise<boolean> }) {
  const { colors, radius, spacing } = useTheme();
  const friends = useFriends();
  const can = useCanFn();
  const [windowMs, setWindowMs] = useState(doc.vote_window_ms);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = useMemo(() => friends.filter((f) => !doc.member_ids.includes(f.uid)), [friends, doc.member_ids]);
  const anyGoing = doc.invitee_ids.some((u) => doc.rsvp[u]?.status === 'going');
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const roomLeft = EVENT_LIMITS.maxInvitees - doc.invitee_ids.length;

  const confirmCancel = () =>
    Alert.alert(EVENT_TEXT.cancel, EVENT_TEXT.cancelConfirm, [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'İptal et', style: 'destructive', onPress: () => void act(eventsStore.getState().cancel(doc.event_id)) },
    ]);

  return (
    <View style={card} testID="event-owner-tools">
      <Text variant="heading">Düzenleyen araçları</Text>
      {doc.stage === 'rsvp' ? (
        <View style={{ gap: spacing.xs }}>
          <Text variant="caption" color="textSecondary">
            Oylama süresi
          </Text>
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {EVENT_LIMITS.voteWindowsMs.map((ms) => (
              <Chip key={ms} label={voteWindowLabel(ms)} selected={windowMs === ms} onPress={() => setWindowMs(ms)} />
            ))}
          </View>
          <Button
            title={EVENT_TEXT.openVenueVote}
            disabled={busy || doc.venue_options.length !== EVENT_LIMITS.venueOptions || !anyGoing}
            onPress={() => void act(eventsStore.getState().advance(doc.event_id, 'open_venue_vote', { voteWindowMs: windowMs }))}
            testID="event-open-venue-vote"
          />
          {!anyGoing ? (
            <Text variant="caption" color="textSecondary">
              Önce en az bir davetlinin &quot;Katılacağım&quot; demesi gerekiyor.
            </Text>
          ) : null}
        </View>
      ) : null}

      {doc.stage === 'rsvp' || doc.stage === 'venue_vote' || doc.stage === 'time_vote' ? (
        inviteOpen ? (
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
        ) : null
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
