import { describe, expect, it } from 'vitest';
import {
  CALLABLES,
  CONSENT_EXEMPT_CALLABLES,
  DEFAULT_PRIVACY,
  ERROR_CODES,
  EVENT_ERROR_CODES,
  EVENT_LIMITS,
  EventCreateRequestSchema,
  EventDocSchema,
  EventRsvpRequestSchema,
  HOUR,
  MINUTE,
  MOVEMENT_LIMITS,
  PUSH_TYPES_F7,
  attendanceCounts,
  consentExemptCall,
  createEventDoc,
  eventNoteCounter,
  eventReminderPlan,
  eventReminderPushText,
  eventReminderRecipients,
  eventTodoFor,
  formatEventDate,
  localDateTimeToEpoch,
  movementPushText,
  nextOnboardingStep,
  nextThemePref,
  offsetFnForTimeZone,
  packetBatteryFields,
  parseEventDoc,
  parsePrivacy,
  parseThemePref,
  permissionCenterRows,
  permissionCenterSummary,
  reduceEvent,
  resolveColorScheme,
  shouldReportDeparture,
  sortEventsForList,
  zoneHeadsUpText,
  type EventAction,
  type EventCtx,
  type EventDoc,
  type PermissionSnapshot,
} from '../src';

const TZ = 'Europe/Istanbul';
const offsetAt = offsetFnForTimeZone(TZ);
/** 2026-11-26 09:00 İstanbul (UTC+3) = 06:00Z */
const T0 = Date.UTC(2026, 10, 26, 6, 0);
const ctxAt = (now: number): EventCtx => ({ now, offsetAt });
const ctx = ctxAt(T0);

const OWNER = 'owner';
const A = 'ayse';
const B = 'bora';
const C = 'can';

const names = { [OWNER]: 'Erim', [A]: 'Ayşe', [B]: 'Bora', [C]: 'Can' };

function created(extra: Partial<Parameters<typeof createEventDoc>[2]> = {}): EventDoc {
  const r = createEventDoc('ev1', OWNER, { title: 'Kahvaltı', date: '2026-11-29', time_zone: TZ, invitee_ids: [A, B, C], names, ...extra }, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

function act(doc: EventDoc, actor: string, action: EventAction, now = T0) {
  const r = reduceEvent(doc, actor, action, ctxAt(now));
  if (!r.ok) throw new Error(`${action.type}: ${r.error} ${JSON.stringify(r.extra ?? {})}`);
  return r;
}

const venues = [
  { name: 'Moda Kahve', address: 'Moda Cd. 1' },
  { name: 'Kadıköy Fırın' },
  { name: 'Yeldeğirmeni Bahçe' },
];

describe('Faz 7 · etkinlik oluşturma', () => {
  it('belge doğru kurulur, davet etkisi tüm davetlilere', () => {
    const r = createEventDoc('ev1', OWNER, { title: '  Kahvaltı  ', date: '2026-11-29', time_zone: TZ, invitee_ids: [A, B, B, OWNER], names }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.title).toBe('Kahvaltı');
    expect(r.doc.invitee_ids).toEqual([A, B]);
    expect(r.doc.member_ids).toEqual([OWNER, A, B]);
    expect(r.doc.stage).toBe('rsvp');
    expect(r.doc.version).toBe(1);
    expect(r.effects).toEqual([{ type: 'invite', to: [A, B] }]);
    expect(EventDocSchema.safeParse(r.doc).success).toBe(true);
    expect(parseEventDoc(JSON.parse(JSON.stringify(r.doc)))).toEqual(r.doc);
    // Gün sonu: 30 Kasım 00:00 İstanbul (bu andan itibaren süresi dolmuş sayılır)
    expect(r.doc.expires_at).toBe(localDateTimeToEpoch('2026-11-30', 0, offsetAt));
  });

  it('geçersiz tarih / boş davet / fazla davetli reddedilir', () => {
    const base = { title: 'X', time_zone: TZ, names };
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-11-25', invitee_ids: [A] }, ctx)).toMatchObject({ ok: false, error: 'event_date_invalid' });
    expect(createEventDoc('e', OWNER, { ...base, date: '2027-12-01', invitee_ids: [A] }, ctx)).toMatchObject({ ok: false, error: 'event_date_invalid' });
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-02-30', invitee_ids: [A] }, ctx)).toMatchObject({ ok: false, error: 'event_date_invalid' });
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-11-29', invitee_ids: [OWNER] }, ctx)).toMatchObject({ ok: false, error: 'invalid_argument' });
    const many = Array.from({ length: EVENT_LIMITS.maxInvitees + 1 }, (_, i) => `u${i}`);
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-11-29', invitee_ids: many }, ctx)).toMatchObject({ ok: false, error: 'event_invitee_limit' });
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-11-29', invitee_ids: [A], time_zone: 'Mars/Olympus' }, ctx)).toMatchObject({ ok: false, error: 'invalid_argument' });
  });

  it('istek şeması: başlık zorunlu, varsayılanlar dolar', () => {
    const p = EventCreateRequestSchema.parse({ op_id: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', title: 'Kahve', date: '2026-11-29', time_zone: TZ, invitee_ids: [A] });
    expect(p.vote_window_ms).toBe(EVENT_LIMITS.defaultVoteWindowMs);
    expect(p.venue_options).toEqual([]);
    expect(EventCreateRequestSchema.safeParse({ op_id: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', title: '   ', date: '2026-11-29', time_zone: TZ, invitee_ids: [A] }).success).toBe(false);
  });
});

describe('Faz 7 · Aşama 1: tarih ve katılım ön onayı', () => {
  it('Katılacağım / Katılamayacağım + 300 karakter not; sahibe bildirim', () => {
    let d = created();
    const r1 = act(d, A, { type: 'rsvp', round: 'initial', status: 'going' });
    expect(r1.effects).toEqual([{ type: 'rsvp', to: [OWNER], by: A, round: 'initial', status: 'going', note: null }]);
    d = r1.doc;
    const note = 'Ailemle olacağım '.repeat(30).slice(0, 300);
    const r2 = act(d, B, { type: 'rsvp', round: 'initial', status: 'not_going', note });
    expect(r2.doc.rsvp[B]).toMatchObject({ status: 'not_going', note: note.trim() });
    expect(attendanceCounts(r2.doc)).toEqual({ going: 2, not_going: 1, pending: 1 });
    // 301 karakter reddedilir; emoji tek karakter sayılır
    expect(reduceEvent(d, B, { type: 'rsvp', round: 'initial', status: 'not_going', note: 'a'.repeat(301) }, ctx)).toMatchObject({ ok: false, error: 'event_note_too_long' });
    expect(eventNoteCounter('😀'.repeat(300))).toMatchObject({ used: 300, over: false });
    expect(eventNoteCounter('😀'.repeat(301)).over).toBe(true);
    // Katılacağım derken not saklanmaz
    expect(act(d, C, { type: 'rsvp', round: 'initial', status: 'going', note: 'gelirim' }).doc.rsvp[C]?.note).toBeNull();
  });

  it('aynı yanıt tekrar = değişiklik yok; sahip yanıt veremez; üye olmayan bulamaz', () => {
    const d = act(created(), A, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    expect(reduceEvent(d, A, { type: 'rsvp', round: 'initial', status: 'going' }, ctx)).toMatchObject({ ok: true, changed: false });
    expect(reduceEvent(d, OWNER, { type: 'rsvp', round: 'initial', status: 'going' }, ctx)).toMatchObject({ ok: false });
    expect(reduceEvent(d, 'yabanci', { type: 'rsvp', round: 'initial', status: 'going' }, ctx)).toMatchObject({ ok: false, error: 'event_not_found' });
    expect(reduceEvent(d, A, { type: 'rsvp', round: 'final', status: 'going' }, ctx)).toMatchObject({ ok: false, error: 'event_stage_mismatch' });
  });

  it('RSVP şeması notu sınırlar', () => {
    expect(EventRsvpRequestSchema.safeParse({ op_id: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', event_id: 'ev1', round: 'initial', status: 'not_going', note: 'x'.repeat(1201) }).success).toBe(false);
  });

  it('tarih değişince Aşama 1 sıfırlanır ve davetlilere bildirim gider', () => {
    let d = act(created({ time_minutes: [600, 660] }), A, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    const r = act(d, OWNER, { type: 'update', date: '2026-11-30' });
    d = r.doc;
    expect(d.rsvp).toEqual({});
    expect(d.time_options.map((t) => t.minute_of_day)).toEqual([600, 660]);
    expect(d.time_options[0]?.starts_at).toBe(localDateTimeToEpoch('2026-11-30', 600, offsetAt));
    expect(r.effects).toEqual([{ type: 'stage', notice: 'date_changed', to: [A, B, C] }]);
  });
});

describe('Faz 7 · Aşama 2: mekan oylaması', () => {
  function withVenues(): EventDoc {
    let d = created({ venue_options: venues.slice(0, 2) });
    d = act(d, A, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    d = act(d, B, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    d = act(d, A, { type: 'venue_propose', venue: venues[2]! }).doc;
    return d;
  }

  it('katılımcı en çok 1 mekan önerir; en çok 3 seçenek; yinelenen ad reddedilir', () => {
    let d = created({ venue_options: [venues[0]!] });
    expect(reduceEvent(d, A, { type: 'venue_propose', venue: venues[1]! }, ctx)).toMatchObject({ ok: false, error: 'event_not_eligible' });
    d = act(d, A, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    expect(reduceEvent(d, A, { type: 'venue_propose', venue: { name: 'moda kahve' } }, ctx)).toMatchObject({ ok: false, extra: { reason: 'venue_duplicate' } });
    d = act(d, A, { type: 'venue_propose', venue: venues[1]! }).doc;
    expect(reduceEvent(d, A, { type: 'venue_propose', venue: venues[2]! }, ctx)).toMatchObject({ ok: false, extra: { reason: 'proposal_limit' } });
    d = act(d, OWNER, { type: 'venue_propose', venue: venues[2]! }).doc;
    expect(d.venue_options.map((o) => o.option_id)).toEqual(['v1', 'v2', 'v3']);
    expect(reduceEvent(d, OWNER, { type: 'venue_propose', venue: { name: 'Dördüncü' } }, ctx)).toMatchObject({ ok: false, extra: { reason: 'venue_limit' } });
    // Öneren kendi önerisini geri alabilir, başkasınınkini alamaz
    expect(reduceEvent(d, A, { type: 'venue_remove', option_id: 'v1' }, ctx)).toMatchObject({ ok: false, error: 'event_not_owner' });
    expect(act(d, A, { type: 'venue_remove', option_id: 'v2' }).doc.venue_options).toHaveLength(2);
  });

  it('oylama 3 seçenek + en az 1 "Katılacağım" ister; yalnızca sahip açar', () => {
    const d2 = created({ venue_options: venues.slice(0, 2) });
    expect(reduceEvent(d2, OWNER, { type: 'open_venue_vote' }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid', extra: { reason: 'venue_required' } });
    const d3 = created({ venue_options: venues });
    expect(reduceEvent(d3, OWNER, { type: 'open_venue_vote' }, ctx)).toMatchObject({ ok: false, error: 'event_no_attendees' });
    const d = withVenues();
    expect(reduceEvent(d, A, { type: 'open_venue_vote' }, ctx)).toMatchObject({ ok: false, error: 'event_not_owner' });
    expect(eventTodoFor(d, OWNER, T0)).toBe('open_venue_vote');
    const r = act(d, OWNER, { type: 'open_venue_vote' });
    expect(r.doc.stage).toBe('venue_vote');
    expect(r.doc.stage_deadline_at).toBe(T0 + EVENT_LIMITS.defaultVoteWindowMs);
    // Bildirim: sahip hariç, "Katılamayacağım" demeyenler (yanıtsız C dahil)
    expect(r.effects).toEqual([{ type: 'stage', notice: 'venue_vote', to: [A, B, C] }]);
  });

  it('en çok oyu alan kazanır; herkes oy verince kendiliğinden kapanır', () => {
    let d = act(act(withVenues(), C, { type: 'rsvp', round: 'initial', status: 'not_going', note: 'Yokum' }).doc, OWNER, { type: 'open_venue_vote' }).doc;
    // C katılmıyor → oy veremez
    expect(reduceEvent(d, C, { type: 'vote', kind: 'venue', option_id: 'v1' }, ctx)).toMatchObject({ ok: false, error: 'event_not_eligible' });
    d = act(d, OWNER, { type: 'vote', kind: 'venue', option_id: 'v2' }).doc;
    d = act(d, A, { type: 'vote', kind: 'venue', option_id: 'v3' }).doc;
    expect(d.stage).toBe('venue_vote');
    const r = act(d, B, { type: 'vote', kind: 'venue', option_id: 'v2' });
    expect(r.doc.stage).toBe('time_vote');
    expect(r.doc.venue_option_id).toBe('v2');
    // Saat seçeneği yok → sahibe "saat ekle"
    expect(r.doc.stage_deadline_at).toBeNull();
    expect(r.effects).toContainEqual({ type: 'stage', notice: 'need_times', to: [OWNER] });
    expect(eventTodoFor(r.doc, OWNER, T0)).toBe('add_times');
  });

  it('eşitlikte sahip seçer; süre dolarsa ilk önerilen kazanır', () => {
    let d = act(withVenues(), OWNER, { type: 'open_venue_vote' }).doc;
    d = act(d, A, { type: 'vote', kind: 'venue', option_id: 'v3' }).doc;
    d = act(d, B, { type: 'vote', kind: 'venue', option_id: 'v1' }).doc;
    const tie = reduceEvent(d, OWNER, { type: 'close_vote', kind: 'venue' }, ctx);
    expect(tie).toMatchObject({ ok: false, error: 'event_vote_tie', extra: { leaders: ['v1', 'v3'] } });
    expect(act(d, OWNER, { type: 'close_vote', kind: 'venue', tie_break_option_id: 'v3' }).doc.venue_option_id).toBe('v3');
    const later = T0 + EVENT_LIMITS.defaultVoteWindowMs + 1;
    const ticked = act(d, 'system', { type: 'tick' }, later);
    expect(ticked.doc.stage).toBe('time_vote');
    expect(ticked.doc.venue_option_id).toBe('v1');
  });

  it('"Katılamayacağım" diyenin oyu silinir', () => {
    let d = act(withVenues(), OWNER, { type: 'open_venue_vote' }).doc;
    d = act(d, A, { type: 'vote', kind: 'venue', option_id: 'v3' }).doc;
    d = act(d, A, { type: 'rsvp', round: 'initial', status: 'not_going' }).doc;
    expect(d.venue_votes[A]).toBeUndefined();
  });
});

describe('Faz 7 · Aşama 3: saat oylaması ve son onay', () => {
  function toTimeVote(minutes = [600, 690, 780]): EventDoc {
    let d = created({ venue_options: venues, time_minutes: minutes });
    d = act(d, A, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    d = act(d, B, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    d = act(d, C, { type: 'rsvp', round: 'initial', status: 'not_going' }).doc;
    d = act(d, OWNER, { type: 'open_venue_vote' }).doc;
    for (const u of [OWNER, A, B]) d = act(d, u, { type: 'vote', kind: 'venue', option_id: 'v1' }).doc;
    return d;
  }

  it('saat oylaması açılır, süre ilk seçenekten 15 dk önce sınırlanır', () => {
    const d = toTimeVote();
    expect(d.stage).toBe('time_vote');
    expect(d.stage_deadline_at).toBe(Math.min(T0 + EVENT_LIMITS.defaultVoteWindowMs, localDateTimeToEpoch('2026-11-29', 600, offsetAt) - 15 * MINUTE));
    expect(eventTodoFor(d, A, T0)).toBe('vote_time');
  });

  it('seçenek kimlikleri: önce mekanlar (v1–v3), sonra saatler (t4–t6)', () => {
    const d = toTimeVote();
    expect(d.time_options.map((t) => `${t.option_id}:${t.minute_of_day}`)).toEqual(['t4:600', 't5:690', 't6:780']);
  });

  it('herkes oy verdi, 2–1 → çoğunluk kazanır; eşitlikte açık kalır', () => {
    let d = toTimeVote();
    d = act(d, OWNER, { type: 'vote', kind: 'time', option_id: 't4' }).doc;
    d = act(d, A, { type: 'vote', kind: 'time', option_id: 't5' }).doc;
    // Eşitlik (1–1) ve B henüz oy vermedi → açık
    expect(d.stage).toBe('time_vote');
    const r = act(d, B, { type: 'vote', kind: 'time', option_id: 't5' });
    expect(r.doc.stage).toBe('final');
    expect(r.doc.time_option_id).toBe('t5');
  });

  it('herkes oy verdi ve tek lider → final; hatırlatıcı planı', () => {
    let d = toTimeVote();
    d = act(d, OWNER, { type: 'vote', kind: 'time', option_id: 't4' }).doc;
    d = act(d, A, { type: 'vote', kind: 'time', option_id: 't4' }).doc;
    const r = act(d, B, { type: 'vote', kind: 'time', option_id: 't4' });
    expect(r.doc.stage).toBe('final');
    expect(r.doc.time_option_id).toBe('t4');
    const startsAt = localDateTimeToEpoch('2026-11-29', 600, offsetAt);
    expect(r.doc.starts_at).toBe(startsAt);
    expect(r.effects).toContainEqual({ type: 'stage', notice: 'final', to: [OWNER, A, C] });
    expect(r.effects).toContainEqual({
      type: 'reminders',
      items: [
        { kind: 'day_before', due_at: startsAt - 24 * HOUR },
        { kind: 'morning', due_at: localDateTimeToEpoch('2026-11-29', 480, offsetAt) },
      ],
    });
    // Son onay herkese açık (önceden katılamayacağım diyen C de)
    let f = act(r.doc, C, { type: 'rsvp', round: 'final', status: 'going' }).doc;
    f = act(f, A, { type: 'rsvp', round: 'final', status: 'not_going', note: 'Hastayım' }).doc;
    expect(eventReminderRecipients(f)).toEqual([OWNER, B, C]);
    expect(attendanceCounts(f)).toEqual({ going: 2, not_going: 1, pending: 1 });
    expect(eventTodoFor(f, B, T0)).toBe('final_rsvp');
    // Başladıktan sonra yanıt yok
    expect(reduceEvent(f, B, { type: 'rsvp', round: 'final', status: 'going' }, ctxAt(startsAt))).toMatchObject({ ok: false, error: 'event_started' });
    // 3 sa sonra tamamlanır
    expect(act(f, 'system', { type: 'tick' }, startsAt + 3 * HOUR).doc.stage).toBe('completed');
    expect(eventReminderPushText('morning', f).title).toBe('Bugün: Kahvaltı');
    expect(eventReminderPushText('day_before', f)).toEqual({ title: 'Yarın: Kahvaltı', body: 'Moda Kahve · 10:00' });
  });

  it('08:00 veya öncesi başlayan buluşmada sabah hatırlatması yok; geçmiş hatırlatma planlanmaz', () => {
    const doc = { stage: 'final' as const, date: '2026-11-27', starts_at: localDateTimeToEpoch('2026-11-27', 480, offsetAt) };
    expect(eventReminderPlan(doc, T0, offsetAt)).toEqual([]); // 1 gün önce = 26 Kas 08:00 (geçti), sabah = başlangıç
    const doc2 = { ...doc, starts_at: localDateTimeToEpoch('2026-11-27', 1200, offsetAt) };
    expect(eventReminderPlan(doc2, T0, offsetAt).map((i) => i.kind)).toEqual(['day_before', 'morning']);
  });

  it('saat seçenekleri yokken sahip ekler; oylama sırasında değişirse oylar sıfırlanır', () => {
    let d = toTimeVote([]);
    expect(d.stage_deadline_at).toBeNull();
    expect(reduceEvent(d, A, { type: 'vote', kind: 'time', option_id: 't1' }, ctx)).toMatchObject({ ok: false, error: 'event_stage_mismatch' });
    expect(reduceEvent(d, OWNER, { type: 'time_options_set', minutes: [600] }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid' });
    const r = act(d, OWNER, { type: 'time_options_set', minutes: [660, 600] });
    expect(r.doc.time_options.map((t) => t.minute_of_day)).toEqual([600, 660]);
    expect(r.effects).toEqual([{ type: 'stage', notice: 'time_vote', to: [A, B] }]);
    d = act(r.doc, A, { type: 'vote', kind: 'time', option_id: r.doc.time_options[0]!.option_id }).doc;
    d = act(d, OWNER, { type: 'time_options_set', minutes: [600, 720] }).doc;
    expect(d.time_votes).toEqual({});
    // Geçmişte kalan saat reddedilir
    expect(reduceEvent(d, OWNER, { type: 'time_options_set', minutes: [0, 60] }, ctxAt(localDateTimeToEpoch('2026-11-29', 30, offsetAt)))).toMatchObject({ ok: false });
  });

  it('final olmadan gün biterse süresi dolar; iptal hatırlatıcıları siler', () => {
    const d = created();
    const end = act(d, 'system', { type: 'tick' }, d.expires_at);
    expect(end.doc.stage).toBe('expired');
    const c = act(d, OWNER, { type: 'cancel' });
    expect(c.doc.stage).toBe('cancelled');
    expect(c.effects).toEqual([{ type: 'cancelled', to: [A, B, C] }, { type: 'reminders', items: [] }]);
    expect(reduceEvent(d, A, { type: 'cancel' }, ctx)).toMatchObject({ ok: false, error: 'event_not_owner' });
  });

  it('üye çıkarılınca oyları silinir ve kalanlar oy verdiyse kapanır; sahip çıkarılırsa iptal', () => {
    let d = created({ venue_options: venues });
    d = act(d, A, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    d = act(d, B, { type: 'rsvp', round: 'initial', status: 'going' }).doc;
    d = act(d, C, { type: 'rsvp', round: 'initial', status: 'not_going' }).doc;
    d = act(d, OWNER, { type: 'open_venue_vote' }).doc;
    d = act(d, OWNER, { type: 'vote', kind: 'venue', option_id: 'v2' }).doc;
    d = act(d, A, { type: 'vote', kind: 'venue', option_id: 'v2' }).doc;
    const r = act(d, 'system', { type: 'remove_member', uid: B });
    expect(r.doc.invitee_ids).toEqual([A, C]);
    expect(r.doc.stage).toBe('time_vote');
    expect(act(d, 'system', { type: 'remove_member', uid: OWNER }).doc.stage).toBe('cancelled');
  });

  it('liste sırası: önce benden eylem bekleyenler', () => {
    const a = created();
    const b = { ...act(created(), A, { type: 'rsvp', round: 'initial', status: 'going' }).doc, event_id: 'ev2' };
    expect(sortEventsForList([b, a], A, T0).map((x) => x.event_id)).toEqual(['ev1', 'ev2']);
  });

  it('tarih biçimi', () => {
    expect(formatEventDate('2026-11-29')).toBe('29 Kasım Pazar');
  });
});

describe('Faz 7 · sözleşme', () => {
  it('etkinlik hata kodları ERROR_CODES içinde', () => {
    for (const c of EVENT_ERROR_CODES) expect(Object.keys(ERROR_CODES)).toContain(c);
  });

  it('push türleri ve onay muafiyetleri', () => {
    expect(PUSH_TYPES_F7).toContain('event_invite');
    expect(PUSH_TYPES_F7).toContain('movement');
    expect(CONSENT_EXEMPT_CALLABLES).toContain(CALLABLES.eventCancel);
    expect(consentExemptCall(CALLABLES.eventRsvp, { status: 'not_going' })).toBe(true);
    expect(consentExemptCall(CALLABLES.eventRsvp, { status: 'going' })).toBe(false);
    expect(consentExemptCall(CALLABLES.privacySettingsSet, { battery_share: false })).toBe(true);
    expect(consentExemptCall(CALLABLES.privacySettingsSet, { battery_share: true })).toBe(false);
    expect(consentExemptCall(CALLABLES.eventCreate, {})).toBe(false);
  });
});

describe('Faz 7 · gizlilik, hareket, tema', () => {
  it('pil paylaşımı varsayılan kapalı; kapalıyken pakette pil yok', () => {
    expect(DEFAULT_PRIVACY.battery_share).toBe(false);
    expect(parsePrivacy(undefined)).toMatchObject({ battery_share: false, movement_alerts: true });
    expect(parsePrivacy({ battery_share: true, movement_alerts: false })).toMatchObject({ battery_share: true, movement_alerts: false });
    expect(packetBatteryFields({ battery_share: false }, 42, true)).toEqual({ battery_pct: null, is_charging: null });
    expect(packetBatteryFields({ battery_share: true }, 42, true)).toEqual({ battery_pct: 42, is_charging: true });
  });

  it('"yola çıktı": en az 10 dk sabit + hareket bandı + soğuma', () => {
    const now = T0;
    expect(shouldReportDeparture('stationary', 'driving', now - 11 * MINUTE, now, null)).toBe(true);
    expect(shouldReportDeparture('stationary', 'walking', now - 5 * MINUTE, now, null)).toBe(false);
    expect(shouldReportDeparture('walking', 'driving', now - 30 * MINUTE, now, null)).toBe(false);
    expect(shouldReportDeparture('stationary', 'unknown', now - 30 * MINUTE, now, null)).toBe(false);
    expect(shouldReportDeparture('stationary', 'walking', now - 30 * MINUTE, now, now - MOVEMENT_LIMITS.cooldownMs + 1)).toBe(false);
    expect(movementPushText('Mehmet', 'departed').title).toBe('Mehmet yola çıktı');
  });

  it('bölge heads-up metni doğal Türkçe', () => {
    expect(zoneHeadsUpText('Ayşe', 'Ev', 'home', 'arrive')).toEqual({ title: 'Ayşe eve girdi', body: 'Ev' });
    expect(zoneHeadsUpText('Mehmet', 'Ev', 'home', 'leave').title).toBe('Mehmet evden çıktı');
    expect(zoneHeadsUpText('Can', 'Spor salonu', 'custom', 'arrive').title).toBe('Can Spor salonu konumuna vardı');
    expect(zoneHeadsUpText('', 'Okul', 'school', 'arrive').title).toBe('Arkadaşın okula vardı');
  });

  it('tema tercihi: sistem cihazı izler, açık/koyu sabit', () => {
    expect(resolveColorScheme('system', 'dark')).toBe('dark');
    expect(resolveColorScheme('system', null)).toBe('light');
    expect(resolveColorScheme('light', 'dark')).toBe('light');
    expect(resolveColorScheme('dark', 'light')).toBe('dark');
    expect(parseThemePref('bogus')).toBe('system');
    expect(nextThemePref('system')).toBe('light');
    expect(nextThemePref('dark')).toBe('system');
  });
});

describe('Faz 7 · ilk açılış izin akışı ve Gizlilik Merkezi', () => {
  const base: PermissionSnapshot = {
    platform: 'ios',
    osVersion: 18,
    foreground: 'undetermined',
    foregroundCanAskAgain: true,
    background: 'undetermined',
    backgroundCanAskAgain: true,
    precise: null,
    notifications: 'undetermined',
    notificationsCanAskAgain: true,
    timeSensitive: null,
    criticalAlerts: null,
    camera: 'undetermined',
    cameraCanAskAgain: true,
    photos: 'undetermined',
    photosCanAskAgain: true,
    motion: null,
    batteryOptimization: null,
  };

  it('sıra: hoş geldin → Kullanırken → Her zaman → bildirim → pil → kamera/galeri → bitti', () => {
    const steps: string[] = [];
    let perms = { ...base };
    const done: Parameters<typeof nextOnboardingStep>[0]['done'][number][] = [];
    let battery = false;
    for (let i = 0; i < 10; i++) {
      const s = nextOnboardingStep({ perms, batteryShareDecided: battery, done });
      steps.push(`${s.step}:${s.action}`);
      if (s.step === 'done') break;
      done.push(s.step);
      if (s.step === 'location') perms = { ...perms, foreground: 'granted' };
      if (s.step === 'location_always') perms = { ...perms, background: 'granted' };
      if (s.step === 'notifications') perms = { ...perms, notifications: 'granted' };
      if (s.step === 'battery_share') battery = true;
    }
    expect(steps).toEqual([
      'welcome:info',
      'location:system_prompt',
      'location_always:system_prompt',
      'notifications:system_prompt',
      'battery_share:in_app_toggle',
      'camera_photos:system_prompt',
      'done:none',
    ]);
  });

  it('Android 11+ "Her zaman" ayarlardan; reddedilen izin ayarlara yönlendirir; atlanan adım tekrar sorulmaz', () => {
    const and = { ...base, platform: 'android' as const, osVersion: 34, foreground: 'granted' as const };
    expect(nextOnboardingStep({ perms: and, batteryShareDecided: false, done: ['welcome'] })).toEqual({ step: 'location_always', action: 'open_settings' });
    const denied = { ...base, foreground: 'denied' as const, foregroundCanAskAgain: false };
    expect(nextOnboardingStep({ perms: denied, batteryShareDecided: false, done: ['welcome'] })).toEqual({ step: 'location', action: 'open_settings' });
    // Konum atlandı → Her zaman sorulmaz (ön plan yok), bildirime geçer
    expect(nextOnboardingStep({ perms: denied, batteryShareDecided: false, done: ['welcome', 'location'] }).step).toBe('notifications');
  });

  it('Merkez satırları: Kullanırken = uyarı + yükselt; seçili fotoğraflar tamam sayılır', () => {
    const rows = permissionCenterRows({ ...base, foreground: 'granted', background: 'denied', backgroundCanAskAgain: false, notifications: 'granted', timeSensitive: true, camera: 'granted', photos: 'limited', precise: true });
    const loc = rows.find((r) => r.id === 'location')!;
    expect(loc).toMatchObject({ status: 'Uygulamayı kullanırken', tone: 'warn', action: 'settings' });
    expect(rows.find((r) => r.id === 'photos')).toMatchObject({ status: 'Seçili fotoğraflar', tone: 'ok' });
    expect(rows.find((r) => r.id === 'sos_alerts')).toMatchObject({ status: 'Zaman duyarlı', tone: 'ok' });
    expect(permissionCenterSummary(rows)).toEqual({ missing: 1, text: '1 ayar dikkat istiyor' });
  });
});
