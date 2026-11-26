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
  EventRespondRequestSchema,
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
  eventRsvpPushText,
  eventStagePushText,
  eventTally,
  eventTodoFor,
  formatEventDate,
  isAnswerComplete,
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

const venues = [{ name: 'Moda Kahve', address: 'Moda Cd. 1' }, { name: 'Kadıköy Fırın' }, { name: 'Yeldeğirmeni Bahçe' }];
/** 3 mekan (v1–v3) ve 3 saat: 10:00 (t4), 12:00 (t5), 18:00 (t6); 29 Kasım. */
const MINUTES = [600, 720, 1080];

function created(extra: Partial<Parameters<typeof createEventDoc>[2]> = {}): EventDoc {
  const r = createEventDoc(
    'ev1',
    OWNER,
    { title: 'Kahvaltı', date: '2026-11-29', time_zone: TZ, invitee_ids: [A, B, C], names, venue_options: venues, time_minutes: MINUTES, ...extra },
    ctx,
  );
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

function act(doc: EventDoc, actor: string, action: EventAction, now = T0) {
  const r = reduceEvent(doc, actor, action, ctxAt(now));
  if (!r.ok) throw new Error(`${action.type}: ${r.error} ${JSON.stringify(r.extra ?? {})}`);
  return r;
}

const going = (venue: string, time: string): EventAction => ({ type: 'respond', status: 'going', venue_option_id: venue, time_option_id: time });
const startsAt10 = localDateTimeToEpoch('2026-11-29', 600, offsetAt);

describe('Faz 7 · etkinlik oluşturma', () => {
  it('belge doğru kurulur: yanıt toplama aşaması, seçenek kimlikleri, yanıt süresi, davet etkisi', () => {
    const r = createEventDoc('ev1', OWNER, { title: '  Kahvaltı  ', date: '2026-11-29', time_zone: TZ, invitee_ids: [A, B, B, OWNER], names, venue_options: venues, time_minutes: MINUTES }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.title).toBe('Kahvaltı');
    expect(r.doc.invitee_ids).toEqual([A, B]);
    expect(r.doc.member_ids).toEqual([OWNER, A, B]);
    expect(r.doc.stage).toBe('voting');
    expect(r.doc.version).toBe(1);
    expect(r.doc.venue_options.map((o) => o.option_id)).toEqual(['v1', 'v2', 'v3']);
    expect(r.doc.time_options.map((o) => o.option_id)).toEqual(['t4', 't5', 't6']);
    expect(r.doc.respond_by).toBe(T0 + EVENT_LIMITS.defaultVoteWindowMs);
    expect(r.doc.results_at).toBeNull();
    expect(r.effects).toEqual([{ type: 'invite', to: [A, B] }]);
    expect(EventDocSchema.safeParse(r.doc).success).toBe(true);
    expect(parseEventDoc(JSON.parse(JSON.stringify(r.doc)))).toEqual(r.doc);
    expect(r.doc.expires_at).toBe(localDateTimeToEpoch('2026-11-30', 0, offsetAt));
  });

  it('yanıt süresi ilk saatten 1 saat önce kapanır', () => {
    const d = created({ date: '2026-11-26', time_minutes: [12 * 60], vote_window_ms: 48 * HOUR });
    expect(d.respond_by).toBe(localDateTimeToEpoch('2026-11-26', 11 * 60, offsetAt));
  });

  it('geçersiz tarih / boş davet / fazla davetli / eksik ya da fazla seçenek reddedilir', () => {
    const base = { title: 'X', time_zone: TZ, names, venue_options: venues, time_minutes: MINUTES };
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-11-25', invitee_ids: [A] }, ctx)).toMatchObject({ ok: false, error: 'event_date_invalid' });
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-02-30', invitee_ids: [A] }, ctx)).toMatchObject({ ok: false, error: 'event_date_invalid' });
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-11-29', invitee_ids: [OWNER] }, ctx)).toMatchObject({ ok: false, error: 'invalid_argument' });
    const many = Array.from({ length: EVENT_LIMITS.maxInvitees + 1 }, (_, i) => `u${i}`);
    expect(createEventDoc('e', OWNER, { ...base, date: '2026-11-29', invitee_ids: many }, ctx)).toMatchObject({ ok: false, error: 'event_invitee_limit' });
    const d = { ...base, date: '2026-11-29', invitee_ids: [A] };
    expect(createEventDoc('e', OWNER, { ...d, venue_options: [] }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid' });
    expect(createEventDoc('e', OWNER, { ...d, venue_options: [...venues, { name: 'Dördüncü' }] }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid' });
    expect(createEventDoc('e', OWNER, { ...d, venue_options: [{ name: 'Moda' }, { name: 'MODA' }] }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid' });
    expect(createEventDoc('e', OWNER, { ...d, time_minutes: [] }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid' });
    expect(createEventDoc('e', OWNER, { ...d, time_minutes: [600, 660, 720, 780, 840] }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid' });
    // Bugün 09:00: 09:15 en az 30 dk sonra değil
    expect(createEventDoc('e', OWNER, { ...d, date: '2026-11-26', time_minutes: [555] }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid' });
  });

  it('istek şeması: başlık, mekan ve saat zorunlu; varsayılan süre dolar', () => {
    const op = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const ok = { op_id: op, title: 'Kahve', date: '2026-11-29', time_zone: TZ, invitee_ids: [A], venue_options: [{ name: 'Moda' }], time_minutes: [600] };
    expect(EventCreateRequestSchema.parse(ok).vote_window_ms).toBe(EVENT_LIMITS.defaultVoteWindowMs);
    expect(EventCreateRequestSchema.safeParse({ ...ok, title: '   ' }).success).toBe(false);
    expect(EventCreateRequestSchema.safeParse({ ...ok, venue_options: [] }).success).toBe(false);
    expect(EventCreateRequestSchema.safeParse({ ...ok, time_minutes: [] }).success).toBe(false);
  });
});

describe('Faz 7 · tek seferde yanıt', () => {
  it('"Katılacağım" mekan + saat seçimini birlikte ister; yanlış seçenek reddedilir', () => {
    const d = created();
    const r = (action: EventAction) => reduceEvent(d, A, action, ctx);
    expect(r({ type: 'respond', status: 'going', time_option_id: 't4' })).toMatchObject({ ok: false, error: 'event_options_invalid', extra: { reason: 'venue_required' } });
    expect(r({ type: 'respond', status: 'going', venue_option_id: 'v1' })).toMatchObject({ ok: false, error: 'event_options_invalid', extra: { reason: 'time_required' } });
    expect(r(going('v9', 't4'))).toMatchObject({ ok: false, error: 'event_options_invalid', extra: { reason: 'unknown_option' } });
    expect(r(going('v1', 'v2'))).toMatchObject({ ok: false, error: 'event_options_invalid' });
    // Sahip yanıt vermez; üye olmayan bulamaz
    expect(reduceEvent(d, OWNER, going('v1', 't4'), ctx)).toMatchObject({ ok: false, error: 'invalid_argument' });
    expect(reduceEvent(d, 'yabanci', going('v1', 't4'), ctx)).toMatchObject({ ok: false, error: 'event_not_found' });
  });

  it('tek seçenekte seçim kendiliğinden; sonuçlardan önce yanıt bildirimi yok; aynı yanıt değişiklik değil', () => {
    const one = created({ venue_options: [{ name: 'Moda Kahve' }], time_minutes: [600] });
    const r = act(one, A, { type: 'respond', status: 'going' });
    expect(r.doc.answers[A]).toMatchObject({ status: 'going', venue_option_id: 'v1', time_option_id: 't2' });
    expect(r.effects).toEqual([]);
    expect(act(r.doc, A, { type: 'respond', status: 'going' }).changed).toBe(false);
  });

  it('"Katılamayacağım" + 300 karakter not; seçimler boşalır; şema notu sınırlar', () => {
    const d = created();
    const note = 'n'.repeat(EVENT_LIMITS.noteMaxChars);
    const r = act(d, C, { type: 'respond', status: 'not_going', note, venue_option_id: 'v1', time_option_id: 't4' });
    expect(r.doc.answers[C]).toMatchObject({ status: 'not_going', note, venue_option_id: null, time_option_id: null });
    expect(reduceEvent(d, C, { type: 'respond', status: 'not_going', note: `${note}x` }, ctx)).toMatchObject({ ok: false, error: 'event_note_too_long' });
    expect(eventNoteCounter(note)).toMatchObject({ used: 300, over: false });
    const op = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    expect(EventRespondRequestSchema.safeParse({ op_id: op, event_id: 'ev1', status: 'going', note: 'x'.repeat(2000) }).success).toBe(false);
    expect(EventRespondRequestSchema.parse({ op_id: op, event_id: 'ev1', status: 'going' })).toMatchObject({ note: null, venue_option_id: null, time_option_id: null });
  });

  it('herkes yanıtlayınca sonuçların tamamı TEK bildirimle düzenleyene; sonrasındaki değişiklik tek tek bildirilir', () => {
    let d = created();
    d = act(d, A, going('v1', 't4')).doc;
    d = act(d, B, going('v2', 't4')).doc;
    expect(eventTodoFor(d, OWNER, T0)).toBeNull();
    const r = act(d, C, { type: 'respond', status: 'not_going', note: 'Ailemle olacağım' });
    expect(r.doc.results_at).toBe(T0);
    expect(r.doc.results_reason).toBe('all_answered');
    expect(r.effects).toEqual([{ type: 'stage', notice: 'results', to: [OWNER] }]);
    expect(eventStagePushText('results', r.doc, T0)).toEqual({
      title: 'Sonuçlar hazır: Kahvaltı',
      body: '3 katılacak · 1 katılamayacak · Mekan: eşitlik (Moda Kahve / Kadıköy Fırın) · Saat: 10:00 (2 oy)',
    });
    expect(eventTodoFor(r.doc, OWNER, T0)).toBe('finalize');
    expect(eventTally(r.doc, 'venue', T0)).toMatchObject({ counts: { v1: 1, v2: 1, v3: 0 }, leaders: ['v1', 'v2'], total: 2, eligible: 2 });
    // Sonuçlardan sonra: B fikrini değiştirir → sahibe tek bildirim, seçimleriyle
    const r2 = act(r.doc, B, going('v1', 't5'));
    expect(r2.effects).toEqual([{ type: 'rsvp', to: [OWNER], by: B, status: 'going', note: null, venue_option_id: 'v1', time_option_id: 't5' }]);
    expect(eventRsvpPushText('Bora', r2.doc, 'going', null, 'v1', 't5').body).toBe('Bora katılacak · Moda Kahve · 12:00');
    expect(eventRsvpPushText('Can', r2.doc, 'not_going', 'Ailemle olacağım').body).toBe('Can katılamayacak: “Ailemle olacağım”');
  });

  it('yanıt süresi dolunca sonuçlar (yanıt vermeyenlerle) düzenleyene; süre dolmadan değişiklik yok', () => {
    let d = created();
    d = act(d, A, going('v1', 't4')).doc;
    expect(act(d, 'system', { type: 'tick' }, (d.respond_by as number) - 1).changed).toBe(false);
    const r = act(d, 'system', { type: 'tick' }, d.respond_by as number);
    expect(r.doc.results_reason).toBe('deadline');
    expect(r.effects).toEqual([{ type: 'stage', notice: 'results', to: [OWNER] }]);
    expect(eventStagePushText('results', r.doc).body).toBe('2 katılacak · 2 yanıt vermedi · Mekan: Moda Kahve (1 oy) · Saat: 10:00 (1 oy)');
    // Süre dolduktan sonra da yanıt verilebilir (onaylanana kadar)
    expect(act(r.doc, B, going('v2', 't5'), (d.respond_by as number) + 1).effects[0]).toMatchObject({ type: 'rsvp', by: B });
  });
});

describe('Faz 7 · düzenleyenin onayı ve sonrası', () => {
  const answered = () => {
    let d = created();
    d = act(d, A, going('v1', 't4')).doc;
    d = act(d, B, going('v2', 't4')).doc;
    return act(d, C, { type: 'respond', status: 'not_going' }).doc;
  };

  it('yalnızca sahip onaylar; eşitlikte liderler döner, lider olmayan seçilemez', () => {
    const d = answered();
    expect(reduceEvent(d, A, { type: 'finalize' }, ctx)).toMatchObject({ ok: false, error: 'event_not_owner' });
    expect(reduceEvent(d, OWNER, { type: 'finalize' }, ctx)).toMatchObject({ ok: false, error: 'event_vote_tie', extra: { venue_leaders: ['v1', 'v2'] } });
    expect(reduceEvent(d, OWNER, { type: 'finalize', venue_option_id: 'v3' }, ctx)).toMatchObject({ ok: false, error: 'event_options_invalid', extra: { reason: 'not_leader' } });
  });

  it('onay → kesinleşir, davetlilere bildirim + hatırlatıcı planı; final yanıtı yalnızca katılımı değiştirir; 3 sa sonra tamamlanır', () => {
    const r = act(answered(), OWNER, { type: 'finalize', venue_option_id: 'v2' });
    expect(r.doc.stage).toBe('final');
    expect(r.doc.venue_option_id).toBe('v2');
    expect(r.doc.time_option_id).toBe('t4');
    expect(r.doc.starts_at).toBe(startsAt10);
    expect(r.effects).toContainEqual({ type: 'stage', notice: 'final', to: [A, B, C] });
    expect(r.effects).toContainEqual({
      type: 'reminders',
      items: [
        { kind: 'day_before', due_at: startsAt10 - 24 * HOUR },
        { kind: 'morning', due_at: localDateTimeToEpoch('2026-11-29', 480, offsetAt) },
        { kind: 'eta_window', due_at: startsAt10 - 45 * 60_000 },
      ],
    });
    expect(eventStagePushText('final', r.doc).title).toBe('Kesinleşti: Kahvaltı');
    // Final: A katılamayacak der (seçimi korunur), C katılır; sahibe bildirim
    let f = act(r.doc, A, { type: 'respond', status: 'not_going', note: 'Hastayım' });
    expect(f.effects).toEqual([{ type: 'rsvp', to: [OWNER], by: A, status: 'not_going', note: 'Hastayım', venue_option_id: 'v1', time_option_id: 't4' }]);
    f = act(f.doc, C, { type: 'respond', status: 'going' });
    expect(eventReminderRecipients(f.doc)).toEqual([OWNER, B, C]);
    expect(attendanceCounts(f.doc)).toEqual({ going: 3, not_going: 1, pending: 0 }); // sahip dahil
    expect(reduceEvent(f.doc, B, { type: 'respond', status: 'going' }, ctxAt(startsAt10))).toMatchObject({ ok: false, error: 'event_started' });
    expect(reduceEvent(f.doc, OWNER, { type: 'options_set', venues, minutes: MINUTES }, ctx)).toMatchObject({ ok: false, error: 'event_stage_mismatch' });
    expect(act(f.doc, 'system', { type: 'tick' }, startsAt10 + 3 * HOUR).doc.stage).toBe('completed');
    expect(eventReminderPushText('day_before', f.doc)).toEqual({ title: 'Yarın: Kahvaltı', body: 'Kadıköy Fırın · 10:00' });
  });

  it('herkes yanıtlamadan da onaylanabilir; kimse katılmıyorsa onaylanamaz', () => {
    const d = act(created(), A, going('v3', 't6')).doc;
    expect(act(d, OWNER, { type: 'finalize' }).doc).toMatchObject({ stage: 'final', venue_option_id: 'v3', time_option_id: 't6' });
    const none = act(created(), A, { type: 'respond', status: 'not_going' }).doc;
    expect(reduceEvent(none, OWNER, { type: 'finalize' }, ctx)).toMatchObject({ ok: false, error: 'event_no_attendees' });
  });

  it('08:00 veya öncesi başlayan buluşmada sabah hatırlatması yok; geçmiş hatırlatma planlanmaz', () => {
    const doc = { stage: 'final' as const, date: '2026-11-27', starts_at: localDateTimeToEpoch('2026-11-27', 480, offsetAt) };
    // Faz 10: 45 dk kala "Kim ne kadar uzakta?" hatırlatması her zaman (geçmişte değilse) planlanır.
    expect(eventReminderPlan(doc, T0, offsetAt).map((i) => i.kind)).toEqual(['eta_window']);
    const doc2 = { ...doc, starts_at: localDateTimeToEpoch('2026-11-27', 1200, offsetAt) };
    expect(eventReminderPlan(doc2, T0, offsetAt).map((i) => i.kind)).toEqual(['day_before', 'morning', 'eta_window']);
  });
});

describe('Faz 7 · seçenek ve tarih değişikliği, bitiş', () => {
  it('seçenekler değişince aynı kalanın oyu korunur; kaldırılan seçim boşalır ve o kişiye haber gider', () => {
    let d = created();
    d = act(d, A, going('v2', 't5')).doc;
    d = act(d, B, going('v1', 't4')).doc;
    const r = act(d, OWNER, { type: 'options_set', venues: [{ name: 'moda kahve' }, { name: 'Yeni Yer' }], minutes: [600, 720] });
    expect(r.doc.venue_options.map((o) => [o.option_id, o.name])).toEqual([
      ['v1', 'moda kahve'], // aynı mekan (büyük/küçük harf): kimlik ve oy korunur
      ['v7', 'Yeni Yer'],
    ]);
    expect(r.doc.time_options.map((o) => o.option_id)).toEqual(['t4', 't5']);
    expect(r.doc.answers[B]).toMatchObject({ venue_option_id: 'v1', time_option_id: 't4' });
    expect(r.doc.answers[A]).toMatchObject({ venue_option_id: null, time_option_id: 't5' });
    expect(r.effects).toEqual([{ type: 'stage', notice: 'options_changed', to: [A] }]);
    expect(isAnswerComplete(r.doc, r.doc.answers[A]!, T0)).toBe(false);
    expect(eventTodoFor(r.doc, A, T0)).toBe('complete_answer');
    expect(reduceEvent(d, A, { type: 'options_set', venues, minutes: MINUTES }, ctx)).toMatchObject({ ok: false, error: 'event_not_owner' });
  });

  it('tarih değişince yanıtlar sıfırlanır, saatler yeni güne taşınır ve davetlilere haber gider', () => {
    let d = act(created(), A, going('v1', 't4')).doc;
    const r = act(d, OWNER, { type: 'update', date: '2026-11-30' });
    d = r.doc;
    expect(d.answers).toEqual({});
    expect(d.results_at).toBeNull();
    expect(d.time_options[0]?.starts_at).toBe(localDateTimeToEpoch('2026-11-30', 600, offsetAt));
    expect(r.effects).toEqual([{ type: 'stage', notice: 'date_changed', to: [A, B, C] }]);
  });

  it('onaylanmadan gün biterse ya da hiçbir saat kalmazsa süresi dolar; iptal davetlilere bildirilir', () => {
    const d = created();
    expect(act(d, 'system', { type: 'tick' }, localDateTimeToEpoch('2026-11-29', 1080, offsetAt) + 1).doc.stage).toBe('expired');
    const c = act(d, OWNER, { type: 'cancel' });
    expect(c.doc.stage).toBe('cancelled');
    expect(c.effects).toContainEqual({ type: 'cancelled', to: [A, B, C] });
  });

  it('üye çıkarılınca yanıtı silinir ve kalanlar yanıtladıysa sonuçlar gider; sahip çıkarılırsa iptal', () => {
    let d = created();
    d = act(d, A, going('v1', 't4')).doc;
    d = act(d, B, going('v1', 't4')).doc;
    const r = act(d, 'system', { type: 'remove_member', uid: C });
    expect(r.doc.invitee_ids).toEqual([A, B]);
    expect(r.effects).toEqual([{ type: 'stage', notice: 'results', to: [OWNER] }]);
    expect(act(d, 'system', { type: 'remove_member', uid: OWNER }).doc.stage).toBe('cancelled');
  });

  it('liste sırası: önce benden eylem bekleyenler', () => {
    const a = created();
    const b = { ...act(created(), A, going('v1', 't4')).doc, event_id: 'ev2' };
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
    expect(consentExemptCall(CALLABLES.eventRespond, { status: 'not_going' })).toBe(true);
    expect(consentExemptCall(CALLABLES.eventRespond, { status: 'going' })).toBe(false);
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
    contacts: 'undetermined',
    contactsCanAskAgain: true,
    smsAvailable: true,
    motion: null,
    batteryOptimization: null,
  };

  it('sıra: hoş geldin → Kullanırken → Her zaman → bildirim → rehber → SMS → pil → kamera/galeri → bitti', () => {
    const steps: string[] = [];
    let perms = { ...base };
    const done: Parameters<typeof nextOnboardingStep>[0]['done'][number][] = [];
    let battery = false;
    let sms = false;
    for (let i = 0; i < 12; i++) {
      const s = nextOnboardingStep({ perms, batteryShareDecided: battery, smsFallbackDecided: sms, done });
      steps.push(`${s.step}:${s.action}`);
      if (s.step === 'done') break;
      done.push(s.step);
      if (s.step === 'location') perms = { ...perms, foreground: 'granted' };
      if (s.step === 'location_always') perms = { ...perms, background: 'granted' };
      if (s.step === 'notifications') perms = { ...perms, notifications: 'granted' };
      if (s.step === 'contacts') perms = { ...perms, contacts: 'granted' };
      if (s.step === 'sms') sms = true;
      if (s.step === 'battery_share') battery = true;
    }
    expect(steps).toEqual([
      'welcome:info',
      'location:system_prompt',
      'location_always:system_prompt',
      'notifications:system_prompt',
      'contacts:system_prompt',
      'sms:in_app_toggle',
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
