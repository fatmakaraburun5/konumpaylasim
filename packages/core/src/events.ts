/**
 * Faz 7: Etkinlik & tek seferde oylama (bkz. docs/PHASE7.md §1–§3).
 *
 * Kayıt: Firestore `events/{event_id}` (üyeler = sahibi + davetliler okur, YALNIZCA callable yazar).
 * Hatırlatıcılar: `event_reminders/{event_id}_{kind}` (yalnızca sunucu). Uygulama içi bildirim kutusu:
 * `users/{uid}/notices/{notice_id}` (yalnızca sahibi okur, yalnızca sunucu yazar).
 *
 * Akış (2026-11-26 kararı: aşama aşama ilerlemez; davetli her şeyi TEK seferde işaretler, sonuçların tamamı
 * düzenleyene düşer):
 *
 *   oluştur: tarih + 1–3 mekan + 1–4 saat + yanıt süresi ──▶ voting
 *
 *   voting ── her davetli TEK yanıt verir: "Katılacağım" + mekan + saat ya da "Katılamayacağım" (+ ≤ 300 karakter not).
 *     │       Yanıt, düzenleyen onaylayana kadar değiştirilebilir. Davetliye oy sayıları gösterilmez.
 *     │
 *     │  herkes eksiksiz yanıtladı ya da yanıt süresi doldu ──▶ `results_at`: düzenleyene TEK "Sonuçlar hazır"
 *     │      bildirimi (katılım sayıları + önde giden mekan ve saat). Bundan sonraki yanıtlar tek tek bildirilir.
 *     │
 *     ├── finalize (düzenleyen; ≥ 1 "Katılacağım"; eşitlikte kazananı liderler arasından seçer) ──▶ final
 *     ├── cancel (düzenleyen) ──▶ cancelled
 *     └── tarih günü bitti ya da tüm saat seçenekleri geçti ──▶ expired
 *
 *   final ── mekan + saat kesin; tüm davetlilere bildirim; 1 gün önce + günün 08:00'i hatırlatma. Davetli başlangıca
 *     │      kadar katılımını değiştirebilir (oylar donmuştur); değişiklik düzenleyene bildirilir.
 *     └── başlangıç + 3 sa ──▶ completed
 *
 * Kurallar:
 *  - Davet yalnızca bana `meetup_invite` izni vermiş arkadaşa gider (Faz 8 `canInvite`); diğerleri sessizce düşer.
 *  - Oy: yalnızca "Katılacağım" diyen davetlilerin seçimi sayılır (düzenleyen oy vermez, sonucu onaylar). Tek
 *    seçenekli mekan / saat sabittir, oylanmaz. "Katılamayacağım" notu kartta tüm üyelere görünür.
 *  - Hepsi saf fonksiyondur: backend callable'ları ve tarayıcı demosunun sahte sunucusu AYNI `reduceEvent`'i çağırır.
 */
import { z } from 'zod';
import type { LatLng } from './geo';
import type { UserId } from './model';
import { DAY, HOUR, MINUTE, type EpochMs, type OffsetFn } from './time';

// --- sınırlar -------------------------------------------------------------------------------

export const EVENT_LIMITS = {
  titleMaxChars: 60,
  descriptionMaxChars: 300,
  /** Katılmama notu: en çok 300 karakter (Unicode kod noktası, `eventTextLength`). */
  noteMaxChars: 300,
  venueNameMaxChars: 80,
  venueAddressMaxChars: 160,
  /** Sahip hariç. [Varsayım] */
  maxInvitees: 20,
  /** Mekan seçenekleri: 1–3. Tek seçenekte mekan sabittir (oylanmaz). */
  minVenueOptions: 1,
  maxVenueOptions: 3,
  /** Saat seçenekleri: 1–4 (etkinlik tarihinde). Tek seçenekte saat sabittir. */
  minTimeOptions: 1,
  maxTimeOptions: 4,
  /** Tarih en çok bu kadar ileride olabilir. [Varsayım] */
  maxDaysAhead: 180,
  /** Yeni saat seçeneği en az bu kadar ileride olmalı (eklendiği anda). [Varsayım] */
  minLeadMs: 30 * MINUTE,
  /** Yanıt süresi seçenekleri; varsayılan 24 sa. */
  voteWindowsMs: [2 * HOUR, 6 * HOUR, 24 * HOUR, 48 * HOUR] as readonly number[],
  defaultVoteWindowMs: 24 * HOUR,
  /** Yanıt süresi en geç ilk saat seçeneğinden bu kadar önce dolar (düzenleyen onaylayabilsin). [Varsayım] */
  respondCloseBeforeMs: HOUR,
  /** Yanıt süresi sonu en az bu kadar sonra (çok yakın son tarih anında dolmasın). */
  minDeadlineLeadMs: MINUTE,
  /** Başlangıçtan bu kadar sonra `completed`. [Varsayım] */
  completeAfterMs: 3 * HOUR,
  /** Biten etkinlik bu kadar sonra silinir (TTL). [Varsayım] */
  retentionMs: 30 * DAY,
  /** Sahip başına aynı anda etkin etkinlik. [Varsayım] */
  maxActivePerOwner: 10,
  /** Kullanıcı başına günlük oluşturma. [Varsayım] */
  createsPerDay: 20,
  /** Kullanıcı başına saatlik etkinlik işlemi (yanıt, onay, düzenleme…). [Varsayım] */
  actionsPerHour: 120,
} as const;

/** Hatırlatma saati: buluşma günü yerel 08:00. */
export const EVENT_MORNING_REMINDER_MINUTE = 8 * 60;
/** Kesinleşen buluşmadan 1 gün önce. */
export const EVENT_DAY_BEFORE_MS = DAY;
/** Sweeper bundan geç kalan hatırlatmayı göndermez (`stale`). [Varsayım] */
export const EVENT_REMINDER_MAX_LATENESS_MS = 2 * HOUR;

// --- tipler -------------------------------------------------------------------------------

export const EVENT_STAGES = ['voting', 'final', 'completed', 'cancelled', 'expired'] as const;
export type EventStage = (typeof EVENT_STAGES)[number];
export const ACTIVE_EVENT_STAGES = ['voting', 'final'] as const satisfies readonly EventStage[];
export type ActiveEventStage = (typeof ACTIVE_EVENT_STAGES)[number];

export const ATTENDANCE_STATUSES = ['going', 'not_going'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const VOTE_KINDS = ['venue', 'time'] as const;
export type VoteKind = (typeof VOTE_KINDS)[number];

/** Sonuç bildirimi neden gitti: herkes eksiksiz yanıtladı / yanıt süresi doldu. */
export const EVENT_RESULTS_REASONS = ['all_answered', 'deadline'] as const;
export type EventResultsReason = (typeof EVENT_RESULTS_REASONS)[number];

/** Davetlinin TEK yanıtı: katılım + (katılıyorsa) mekan ve saat seçimi. */
export interface EventAnswer {
  status: AttendanceStatus;
  /** Yalnızca `not_going` için; ≤ 300 karakter, kartta tüm üyelere görünür. */
  note: string | null;
  /** Yalnızca `going`: seçilen mekan (tek seçenekte o seçenek). Seçenek kaldırılırsa null olur. */
  venue_option_id: string | null;
  /** Yalnızca `going`: seçilen saat (tek seçenekte o seçenek). Seçenek kaldırılırsa null olur. */
  time_option_id: string | null;
  at: EpochMs;
}

export interface EventVenueOption {
  /** `v1`, `v2`… (etkinlik içinde benzersiz, `seq` ile). */
  option_id: string;
  name: string;
  address: string | null;
  /** İsteğe bağlı: haritada göster / yol tarifi. */
  location: LatLng | null;
  /** Google Places kimliği (buluşma önerisinden eklendiyse). */
  place_id: string | null;
}

export interface EventTimeOption {
  /** `t4`, `t5`… */
  option_id: string;
  /** Etkinlik tarihinde yerel dakika (0–1439), ör. 600 = 10:00. */
  minute_of_day: number;
  /** `date` + `minute_of_day` + `time_zone` → UTC (yaz saati düzeltilmiş). */
  starts_at: EpochMs;
}

export type EventEndReason = 'completed' | 'cancelled' | 'expired';

/** `events/{event_id}`: istemcinin okuduğu biçim (sunucu ayrıca `purge_at`, `open`, `next_action_at` yazar). */
export interface EventDoc {
  event_id: string;
  owner_id: UserId;
  title: string;
  description: string | null;
  /** Önerilen tarih, sahibin saat diliminde `YYYY-MM-DD`. */
  date: string;
  /** IANA saat dilimi (oluşturanın). */
  time_zone: string;
  /** Sahip hariç davetliler (davet sırası). */
  invitee_ids: UserId[];
  /** `[owner_id, ...invitee_ids]`: kural (`request.auth.uid in member_ids`) ve `array-contains` sorgusu. */
  member_ids: UserId[];
  /** Üyelerin görünen ad anlık görüntüsü (üyeler birbirini tanımayabilir). */
  names: Record<UserId, string>;
  stage: EventStage;
  /** Yanıt süresi sonu (`voting`): bu an gelince sonuçlar düzenleyene gider (yanıtlar onaya kadar açık kalır). */
  respond_by: EpochMs | null;
  vote_window_ms: number;
  /** Davetlilerin yanıtları (sahip her zaman katılır, yanıtı yoktur). Kayıt yoksa "yanıt bekleniyor". */
  answers: Record<UserId, EventAnswer>;
  venue_options: EventVenueOption[];
  time_options: EventTimeOption[];
  /** "Sonuçlar hazır" bildiriminin düzenleyene gittiği an; gitmediyse null. */
  results_at: EpochMs | null;
  results_reason: EventResultsReason | null;
  /** Kesinleşen mekan ve saat (yalnızca `final` ve sonrası). */
  venue_option_id: string | null;
  time_option_id: string | null;
  starts_at: EpochMs | null;
  finalized_at: EpochMs | null;
  /** Etkin aşamalar bu andan sonra `expired` olur: tarih gününün yerel sonu. */
  expires_at: EpochMs;
  end_reason: EventEndReason | null;
  ended_at: EpochMs | null;
  /** Seçenek kimlik sayacı. */
  seq: number;
  created_at: EpochMs;
  updated_at: EpochMs;
  version: number;
}

// --- metin uzunluğu ve temizleme ---------------------------------------------------------------

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

/** Kullanıcıya gösterilen sayaç ve sunucu sınırı aynı ölçüyü kullanır: Unicode kod noktası. */
export function eventTextLength(s: string): number {
  return Array.from(s).length;
}

/**
 * Tek satırlık metin (başlık, mekan): kontrol karakterleri atılır, boşluklar tekilleşir, kırpılır. Sınır AŞILIRSA
 * null döner (sessizce kesmek kullanıcının yazdığını değiştirirdi; arayüz zaten sınırı gösterir).
 */
export function sanitizeEventLine(raw: string | null | undefined, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (!s || eventTextLength(s) > maxChars) return null;
  return s;
}

/** Çok satırlı metin (not, açıklama): satır sonları korunur (en çok 2 boş satır), sınır aşılırsa null. */
export function sanitizeEventText(raw: string | null | undefined, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!s || eventTextLength(s) > maxChars) return null;
  return s;
}

/** Not alanının sayacı: "128/300". */
export function eventNoteCounter(text: string): { used: number; max: number; over: boolean; label: string } {
  const used = eventTextLength(text.trim());
  const max = EVENT_LIMITS.noteMaxChars;
  return { used, max, over: used > max, label: `${used}/${max}` };
}

// --- tarih / saat -----------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` takvimde gerçek bir gün mü (2026-02-30 değil). */
export function isValidEventDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function dateParts(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Geçersiz tarih: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Takvim günü + n gün. */
export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = dateParts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Verilen andaki yerel takvim günü (`offsetAt` = etkinliğin saat dilimi). */
export function localDateOf(at: EpochMs, offsetAt: OffsetFn): string {
  const t = new Date(at + offsetAt(at) * MINUTE);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/**
 * Yerel gün + dakika → UTC epoch. Yaz saati geçişinde fark yeniden ölçülür; var olmayan yerel saat (ileri
 * geçişteki boşluk) bir sonraki geçerli ana kayar.
 */
export function localDateTimeToEpoch(date: string, minuteOfDay: number, offsetAt: OffsetFn): EpochMs {
  const [y, m, d] = dateParts(date);
  const naive = Date.UTC(y, m - 1, d) + minuteOfDay * MINUTE;
  const off1 = offsetAt(naive);
  let at = naive - off1 * MINUTE;
  const off2 = offsetAt(at);
  if (off2 !== off1) at = naive - off2 * MINUTE;
  return at;
}

/** Tarih gününün yerel sonu (ertesi günün 00:00'ı). */
export function endOfEventDate(date: string, offsetAt: OffsetFn): EpochMs {
  return localDateTimeToEpoch(addDaysToDate(date, 1), 0, offsetAt);
}

/** Geçerli bir IANA saat dilimi mi (Intl ile). */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TR_MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'] as const;
export const TR_WEEKDAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'] as const;

/** "29 Kasım Cuma". */
export function formatEventDate(date: string): string {
  const [y, m, d] = dateParts(date);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${d} ${TR_MONTHS[m - 1]} ${TR_WEEKDAYS[wd]}`;
}

/** 600 → "10:00". */
export function formatMinuteOfDay(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** "10:00" / "9:5" → 600 / 545; geçersizse null. */
export function parseClock(text: string): number | null {
  const m = /^\s*(\d{1,2})[:.](\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** Bugünden (etkinlik dilimi) itibaren seçilebilir tarih aralığı. */
export function eventDateRange(now: EpochMs, offsetAt: OffsetFn): { min: string; max: string } {
  const min = localDateOf(now, offsetAt);
  return { min, max: addDaysToDate(min, EVENT_LIMITS.maxDaysAhead) };
}

export function isEventDateAllowed(date: string, now: EpochMs, offsetAt: OffsetFn): boolean {
  if (!isValidEventDate(date)) return false;
  const { min, max } = eventDateRange(now, offsetAt);
  return date >= min && date <= max;
}

// --- sorgular -------------------------------------------------------------------------------

export const isActiveEventStage = (s: EventStage): s is ActiveEventStage => (ACTIVE_EVENT_STAGES as readonly string[]).includes(s);

export function isEventMember(doc: Pick<EventDoc, 'member_ids'>, uid: UserId): boolean {
  return doc.member_ids.includes(uid);
}

/** Davetlinin yanıtı; yoksa null (sahibin yanıtı olmaz). */
export function answerOf(doc: Pick<EventDoc, 'answers'>, uid: UserId): EventAnswer | null {
  return doc.answers[uid] ?? null;
}

/** Katılım durumu (sahip her zaman `going`); yanıt yoksa null. */
export function attendanceOf(doc: Pick<EventDoc, 'owner_id' | 'answers'>, uid: UserId): AttendanceStatus | null {
  if (uid === doc.owner_id) return 'going';
  return doc.answers[uid]?.status ?? null;
}

/** "Katılacağım" diyen davetliler (davet sırası). */
export function goingInvitees(doc: Pick<EventDoc, 'invitee_ids' | 'answers'>): UserId[] {
  return doc.invitee_ids.filter((u) => doc.answers[u]?.status === 'going');
}

/** Hâlâ seçilebilir saat seçenekleri: başlangıcı gelmemiş olanlar (seçenek sırası). */
export function timeCandidates(doc: Pick<EventDoc, 'time_options'>, now: EpochMs): EventTimeOption[] {
  return doc.time_options.filter((t) => t.starts_at > now);
}

type BallotView = Pick<EventDoc, 'invitee_ids' | 'answers' | 'venue_options' | 'time_options'>;

/**
 * Yanıt eksiksiz mi: "Katılamayacağım" her zaman; "Katılacağım" için birden çok seçenek varsa geçerli bir mekan ve
 * (başlamamış) bir saat seçilmiş olmalı. Seçenekler değişince eksik kalan yanıt yeniden beklenir.
 */
export function isAnswerComplete(doc: Pick<EventDoc, 'venue_options' | 'time_options'>, a: EventAnswer, now: EpochMs): boolean {
  if (a.status === 'not_going') return true;
  const venueOk = doc.venue_options.length <= 1 || doc.venue_options.some((o) => o.option_id === a.venue_option_id);
  const times = timeCandidates(doc, now);
  const timeOk = times.length <= 1 || times.some((o) => o.option_id === a.time_option_id);
  return venueOk && timeOk;
}

/** Yanıt vermemiş ya da yanıtı eksik kalmış davetliler (davet sırası). */
export function pendingInvitees(doc: BallotView, now: EpochMs): UserId[] {
  return doc.invitee_ids.filter((u) => {
    const a = doc.answers[u];
    return !a || !isAnswerComplete(doc, a, now);
  });
}

/** Tüm davetliler eksiksiz yanıt verdi mi. */
export function allAnswered(doc: BallotView, now: EpochMs): boolean {
  return doc.invitee_ids.length > 0 && pendingInvitees(doc, now).length === 0;
}

export interface VoteTally {
  /** option_id → geçerli oy sayısı. */
  counts: Record<string, number>;
  /** option_id → oy veren davetliler (yalnızca düzenleyene gösterilir). */
  voters: Record<string, UserId[]>;
  /** En çok oyu alan seçenek(ler), seçenek sırasıyla. Oy yoksa tüm seçenekler (eşitlik). */
  leaders: string[];
  /** Geçerli oy sayısı. */
  total: number;
  /** "Katılacağım" diyen davetli sayısı. */
  eligible: number;
}

/**
 * Oy sayımı: yalnızca "Katılacağım" diyen davetlilerin, var olan (saatte: başlamamış) seçeneğe verdiği oy geçerlidir.
 * Tek seçenekli türde her katılan o seçeneğe sayılır.
 */
export function eventTally(doc: BallotView, kind: VoteKind, now: EpochMs): VoteTally {
  const options: readonly { option_id: string }[] = kind === 'venue' ? doc.venue_options : timeCandidates(doc, now);
  const counts: Record<string, number> = {};
  const voters: Record<string, UserId[]> = {};
  for (const o of options) {
    counts[o.option_id] = 0;
    voters[o.option_id] = [];
  }
  const only = options.length === 1 ? (options[0]?.option_id ?? null) : null;
  const going = goingInvitees(doc);
  let total = 0;
  for (const u of going) {
    const a = doc.answers[u];
    const choice = only ?? (kind === 'venue' ? a?.venue_option_id : a?.time_option_id) ?? null;
    if (choice === null) continue;
    const c = counts[choice];
    const list = voters[choice];
    if (c === undefined || !list) continue;
    counts[choice] = c + 1;
    list.push(u);
    total += 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  const leaders = options.map((o) => o.option_id).filter((id) => counts[id] === max);
  return { counts, voters, leaders, total, eligible: going.length };
}

export type WinnerPick = { ok: true; option_id: string } | { ok: false; reason: 'tie' | 'not_leader' | 'no_candidates' };

/** Kazanan: tek lider; eşitlikte düzenleyenin liderler arasından seçtiği (`choice`). */
export function pickWinner(t: Pick<VoteTally, 'leaders'>, choice: string | null | undefined): WinnerPick {
  if (t.leaders.length === 0) return { ok: false, reason: 'no_candidates' };
  if (choice != null) return t.leaders.includes(choice) ? { ok: true, option_id: choice } : { ok: false, reason: 'not_leader' };
  const only = t.leaders.length === 1 ? t.leaders[0] : undefined;
  return only !== undefined ? { ok: true, option_id: only } : { ok: false, reason: 'tie' };
}

export function venueOf(doc: Pick<EventDoc, 'venue_options' | 'venue_option_id'>): EventVenueOption | null {
  return doc.venue_options.find((o) => o.option_id === doc.venue_option_id) ?? null;
}

export function timeOptionOf(doc: Pick<EventDoc, 'time_options' | 'time_option_id'>): EventTimeOption | null {
  return doc.time_options.find((o) => o.option_id === doc.time_option_id) ?? null;
}

/**
 * Sweeper'ın bu etkinliğe bir sonraki bakış anı (null = bakılacak bir şey yok):
 *  - `voting`: yanıt süresi sonu (sonuç bildirimi henüz gitmediyse), son saat seçeneğinin başlangıcı (artık
 *    onaylanamaz → `expired`) ve tarih gününün sonu; hangisi erken.
 *  - `final`: başlangıç + 3 sa (`completed`).
 */
export function eventNextActionAt(
  doc: Pick<EventDoc, 'stage' | 'respond_by' | 'results_at' | 'expires_at' | 'starts_at' | 'time_options'>,
): EpochMs | null {
  switch (doc.stage) {
    case 'voting': {
      let at = doc.expires_at;
      if (doc.time_options.length) at = Math.min(at, Math.max(...doc.time_options.map((t) => t.starts_at)));
      if (doc.results_at === null && doc.respond_by !== null) at = Math.min(at, doc.respond_by);
      return at;
    }
    case 'final':
      return doc.starts_at === null ? doc.expires_at : doc.starts_at + EVENT_LIMITS.completeAfterMs;
    default:
      return null;
  }
}

// --- hatırlatıcılar ----------------------------------------------------------------------------

export const EVENT_REMINDER_KINDS = ['day_before', 'morning'] as const;
export type EventReminderKind = (typeof EVENT_REMINDER_KINDS)[number];

export interface EventReminderPlanItem {
  kind: EventReminderKind;
  due_at: EpochMs;
}

/** `event_reminders/{event_id}_{kind}`. */
export const eventReminderId = (eventId: string, kind: EventReminderKind): string => `${eventId}_${kind}`;

/**
 * Kesinleşen buluşmanın hatırlatıcıları (yalnızca `final` + `starts_at`):
 *  - `day_before`: başlangıçtan tam 24 saat önce. O an geçtiyse (kesinleşme < 24 sa kala) planlanmaz.
 *  - `morning`: buluşma günü yerel 08:00. O an geçtiyse ya da buluşma 08:00'de / daha önce başlıyorsa planlanmaz.
 * Geçmişe hatırlatma planlanmaz (kesinleşme bildirimi zaten gitti).
 */
export function eventReminderPlan(doc: Pick<EventDoc, 'stage' | 'starts_at' | 'date'>, now: EpochMs, offsetAt: OffsetFn): EventReminderPlanItem[] {
  if (doc.stage !== 'final' || doc.starts_at === null) return [];
  const out: EventReminderPlanItem[] = [];
  const dayBefore = doc.starts_at - EVENT_DAY_BEFORE_MS;
  if (dayBefore > now) out.push({ kind: 'day_before', due_at: dayBefore });
  const morning = localDateTimeToEpoch(doc.date, EVENT_MORNING_REMINDER_MINUTE, offsetAt);
  if (morning > now && morning < doc.starts_at) out.push({ kind: 'morning', due_at: morning });
  return out.sort((a, b) => a.due_at - b.due_at);
}

/** Hatırlatma alıcıları: sahip + "Katılamayacağım" DEMEYEN davetliler (yanıtsızlar da hatırlatılır). */
export function eventReminderRecipients(doc: Pick<EventDoc, 'owner_id' | 'invitee_ids' | 'answers'>): UserId[] {
  return [doc.owner_id, ...doc.invitee_ids.filter((u) => doc.answers[u]?.status !== 'not_going')];
}

// --- etkiler (backend ve demo bunları push / hatırlatma / bildirim kutusuna çevirir) ----------------

/**
 * Durum bildirimi türleri:
 *  - `results`: düzenleyene "Sonuçlar hazır" (herkes yanıtladı / yanıt süresi doldu).
 *  - `final`: davetlilere "Kesinleşti".
 *  - `date_changed`: davetlilere, yanıtlar sıfırlandı.
 *  - `options_changed`: seçimi kaldırılan davetlilere, yanıtını güncellemesi gerekiyor.
 */
export const EVENT_STAGE_NOTICES = ['results', 'final', 'date_changed', 'options_changed'] as const;
export type EventStageNotice = (typeof EVENT_STAGE_NOTICES)[number];

export type EventEffect =
  /** Yeni davetlilere davet bildirimi. */
  | { type: 'invite'; to: UserId[] }
  /** Durum değişti / birinden iş bekleniyor. `to` boşsa gönderilmez. */
  | { type: 'stage'; notice: EventStageNotice; to: UserId[] }
  /** Sahibe: sonuç bildiriminden SONRA bir davetli yanıt verdi ya da yanıtını değiştirdi. */
  | { type: 'rsvp'; to: UserId[]; by: UserId; status: AttendanceStatus; note: string | null; venue_option_id: string | null; time_option_id: string | null }
  | { type: 'cancelled'; to: UserId[] }
  /** Hatırlatıcıları bu listeyle DEĞİŞTİR (boş = hepsini iptal et). */
  | { type: 'reminders'; items: EventReminderPlanItem[] };

// --- eylemler ---------------------------------------------------------------------------------

export interface EventVenueInput {
  name: string;
  address?: string | null;
  location?: LatLng | null;
  place_id?: string | null;
}

export type EventAction =
  /** Davetlinin tek yanıtı. `voting`: katılım + mekan + saat; `final`: yalnızca katılım (oylar donmuştur). */
  | { type: 'respond'; status: AttendanceStatus; note?: string | null; venue_option_id?: string | null; time_option_id?: string | null }
  /** Sahip: sonucu onayla. Eşitlikte kazananı liderler arasından seçer. */
  | { type: 'finalize'; venue_option_id?: string | null; time_option_id?: string | null }
  /** Sahip (`voting`): mekan ve saat seçeneklerini değiştir. Aynı kalan seçeneğin oyları korunur. */
  | { type: 'options_set'; venues: EventVenueInput[]; minutes: number[] }
  | { type: 'update'; title?: string; description?: string | null; date?: string }
  | { type: 'invite_add'; invitee_ids: UserId[]; names: Record<UserId, string> }
  | { type: 'cancel' }
  /** Sistem: arkadaşlık bitti / engel / hesap silindi. Sahip çıkarılırsa etkinlik iptal edilir. */
  | { type: 'remove_member'; uid: UserId }
  /** Sistem (sweeper): yanıt süresi dolumu, tamamlanma, bitiş. */
  | { type: 'tick' };

export const EVENT_ERROR_CODES = [
  'event_not_found',
  'event_not_owner',
  'event_stage_mismatch',
  'event_options_invalid',
  'event_vote_tie',
  'event_no_attendees',
  'event_date_invalid',
  'event_note_too_long',
  'event_invitee_limit',
  'event_started',
  'invalid_argument',
] as const;
export type EventErrorCode = (typeof EVENT_ERROR_CODES)[number];

export type EventResult =
  | { ok: true; doc: EventDoc; effects: EventEffect[]; changed: boolean }
  | { ok: false; error: EventErrorCode; extra?: Record<string, unknown> };

export interface EventCtx {
  now: EpochMs;
  /** Etkinliğin saat dilimi (`offsetFnForTimeZone(doc.time_zone)`). */
  offsetAt: OffsetFn;
}

const fail = (error: EventErrorCode, extra?: Record<string, unknown>): EventResult => (extra ? { ok: false, error, extra } : { ok: false, error });

function bump(doc: EventDoc, now: EpochMs, patch: Partial<EventDoc>): EventDoc {
  return { ...doc, ...patch, updated_at: now, version: doc.version + 1 };
}

const unchanged = (doc: EventDoc): EventResult => ({ ok: true, doc, effects: [], changed: false });

const omit = <T>(rec: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
};

/** Bildirim alıcıları: aktör hariç, tekil. */
const others = (list: readonly UserId[], actor: UserId | 'system'): UserId[] => [...new Set(list)].filter((u) => u !== actor);

/**
 * Yanıt süresi sonu: pencere, tarih gününün sonu ve ilk (başlamamış) saat seçeneğinden `respondCloseBeforeMs` önce;
 * hangisi erken. En az `minDeadlineLeadMs` sonra.
 */
export function respondDeadline(doc: Pick<EventDoc, 'expires_at' | 'time_options'>, now: EpochMs, windowMs: number): EpochMs {
  let cap = Math.min(now + windowMs, doc.expires_at);
  const future = timeCandidates(doc, now).map((t) => t.starts_at);
  if (future.length) cap = Math.min(cap, Math.min(...future) - EVENT_LIMITS.respondCloseBeforeMs);
  return Math.max(now + EVENT_LIMITS.minDeadlineLeadMs, cap);
}

/**
 * Saat seçenekleri: 1–4 farklı dakika (etkinlik tarihinde). Yeni seçenek en az `minLeadMs` ileride olmalı; `keep`
 * içindeki aynı dakikalı mevcut seçenek kimliğiyle korunur (oyu geçerli kalır). En az biri hâlâ başlamamış olmalı.
 */
export function buildTimeOptions(
  doc: Pick<EventDoc, 'date' | 'seq'>,
  minutes: readonly number[],
  ctx: EventCtx,
  keep: readonly EventTimeOption[] = [],
): { options: EventTimeOption[]; seq: number } | null {
  if (minutes.length < EVENT_LIMITS.minTimeOptions || minutes.length > EVENT_LIMITS.maxTimeOptions) return null;
  const uniq = [...new Set(minutes)];
  if (uniq.length !== minutes.length) return null;
  if (uniq.some((m) => !Number.isInteger(m) || m < 0 || m > 1439)) return null;
  let seq = doc.seq;
  const options: EventTimeOption[] = [];
  for (const m of [...uniq].sort((a, b) => a - b)) {
    const kept = keep.find((t) => t.minute_of_day === m);
    if (kept) {
      options.push({ ...kept });
      continue;
    }
    const starts_at = localDateTimeToEpoch(doc.date, m, ctx.offsetAt);
    if (starts_at < ctx.now + EVENT_LIMITS.minLeadMs) return null;
    options.push({ option_id: `t${++seq}`, minute_of_day: m, starts_at });
  }
  if (!options.some((o) => o.starts_at > ctx.now)) return null;
  return { options, seq };
}

function sanitizeVenue(v: EventVenueInput): Omit<EventVenueOption, 'option_id'> | null {
  const name = sanitizeEventLine(v.name, EVENT_LIMITS.venueNameMaxChars);
  if (!name) return null;
  let address: string | null = null;
  if (v.address != null && v.address.trim() !== '') {
    address = sanitizeEventLine(v.address, EVENT_LIMITS.venueAddressMaxChars);
    if (!address) return null;
  }
  const loc = v.location ?? null;
  if (loc && !(Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180)) return null;
  const place_id = typeof v.place_id === 'string' && v.place_id.length > 0 && v.place_id.length <= 256 ? v.place_id : null;
  return { name, address, location: loc ? { lat: loc.lat, lng: loc.lng } : null, place_id };
}

const sameVenue = (a: { name: string; place_id: string | null }, b: { name: string; place_id: string | null }) =>
  (a.place_id !== null && a.place_id === b.place_id) || a.name.toLocaleLowerCase('tr') === b.name.toLocaleLowerCase('tr');

/**
 * Mekan seçenekleri: 1–3, temizlenmiş, tekrarsız (ad büyük/küçük harf duyarsız ya da aynı Places kimliği). `keep`
 * içindeki aynı mekan kimliğiyle korunur (oyu geçerli kalır); ad / adres güncellenir.
 */
export function buildVenueOptions(
  doc: Pick<EventDoc, 'seq'>,
  venues: readonly EventVenueInput[],
  keep: readonly EventVenueOption[] = [],
): { ok: true; options: EventVenueOption[]; seq: number } | { ok: false; reason: 'venue_count' | 'venue_invalid' | 'venue_duplicate' } {
  if (venues.length < EVENT_LIMITS.minVenueOptions || venues.length > EVENT_LIMITS.maxVenueOptions) return { ok: false, reason: 'venue_count' };
  let seq = doc.seq;
  const out: EventVenueOption[] = [];
  for (const raw of venues) {
    const v = sanitizeVenue(raw);
    if (!v) return { ok: false, reason: 'venue_invalid' };
    if (out.some((o) => sameVenue(o, v))) return { ok: false, reason: 'venue_duplicate' };
    const kept = keep.find((o) => sameVenue(o, v) && !out.some((x) => x.option_id === o.option_id));
    out.push({ option_id: kept ? kept.option_id : `v${++seq}`, ...v });
  }
  return { ok: true, options: out, seq };
}

/** Yanıttaki seçim: tek seçenekte o seçenek; birden çokta zorunlu ve geçerli olmalı; seçenek yoksa null. */
function pickOption(
  options: readonly { option_id: string }[],
  id: string | null | undefined,
  kind: VoteKind,
): { ok: true; id: string | null } | { ok: false; reason: 'venue_required' | 'time_required' | 'unknown_option' } {
  if (options.length === 0) return { ok: true, id: null };
  if (options.length === 1) {
    const only = options[0]?.option_id ?? null;
    if (id != null && id !== only) return { ok: false, reason: 'unknown_option' };
    return { ok: true, id: only };
  }
  if (id == null) return { ok: false, reason: kind === 'venue' ? 'venue_required' : 'time_required' };
  return options.some((o) => o.option_id === id) ? { ok: true, id } : { ok: false, reason: 'unknown_option' };
}

/** Sonuç bildirimi henüz gitmediyse ve herkes eksiksiz yanıtladıysa: `results_at` + düzenleyene "Sonuçlar hazır". */
function withResultsIfDone(doc: EventDoc, effects: EventEffect[], actor: UserId | 'system', now: EpochMs): { doc: EventDoc; effects: EventEffect[] } {
  if (doc.stage !== 'voting' || doc.results_at !== null || !allAnswered(doc, now)) return { doc, effects };
  return {
    doc: { ...doc, results_at: now, results_reason: 'all_answered' },
    effects: [...effects, { type: 'stage', notice: 'results', to: others([doc.owner_id], actor) }],
  };
}

const done = (r: { doc: EventDoc; effects: EventEffect[] }): EventResult => ({ ok: true, doc: r.doc, effects: r.effects, changed: true });

function endEvent(doc: EventDoc, reason: EventEndReason, now: EpochMs): EventDoc {
  return bump(doc, now, { stage: reason, end_reason: reason, ended_at: now, respond_by: null });
}

const sameAnswer = (a: EventAnswer, b: Omit<EventAnswer, 'at'>) =>
  a.status === b.status && a.note === b.note && a.venue_option_id === b.venue_option_id && a.time_option_id === b.time_option_id;

/**
 * Tek geçiş fonksiyonu. `actor` = çağıran (callable) ya da `'system'` (sweeper / arkadaşlık bitişi). Üyelik ve
 * sahiplik burada denetlenir; arkadaşlık, izin, onay ve hız sınırı ÇAĞIRANIN işidir.
 * Değişiklik yoksa `changed: false` (yazma / bildirim yok).
 */
export function reduceEvent(doc: EventDoc, actor: UserId | 'system', action: EventAction, ctx: EventCtx): EventResult {
  const { now } = ctx;
  const isOwner = actor === doc.owner_id;
  if (actor !== 'system' && !isEventMember(doc, actor)) return fail('event_not_found');
  const ownerOnly = () => (isOwner ? null : fail('event_not_owner'));

  switch (action.type) {
    case 'respond': {
      if (actor === 'system' || isOwner) return fail('invalid_argument', { field: 'actor' });
      if (!isActiveEventStage(doc.stage)) return fail('event_stage_mismatch', { stage: doc.stage });
      if (doc.stage === 'final' && doc.starts_at !== null && now >= doc.starts_at) return fail('event_started');
      let note: string | null = null;
      if (action.status === 'not_going' && action.note != null && action.note.trim() !== '') {
        if (eventTextLength(action.note.trim()) > EVENT_LIMITS.noteMaxChars) return fail('event_note_too_long');
        note = sanitizeEventText(action.note, EVENT_LIMITS.noteMaxChars);
      }
      const prev = doc.answers[actor] ?? null;
      let venue: string | null = null;
      let time: string | null = null;
      if (doc.stage === 'final') {
        // Oylar donmuştur: yalnızca katılım değişir, önceki seçim (varsa) korunur.
        venue = prev?.venue_option_id ?? null;
        time = prev?.time_option_id ?? null;
      } else if (action.status === 'going') {
        const v = pickOption(doc.venue_options, action.venue_option_id, 'venue');
        if (!v.ok) return fail('event_options_invalid', { reason: v.reason });
        const t = pickOption(timeCandidates(doc, now), action.time_option_id, 'time');
        if (!t.ok) return fail('event_options_invalid', { reason: t.reason });
        venue = v.id;
        time = t.id;
      }
      const answer: EventAnswer = { status: action.status, note, venue_option_id: venue, time_option_id: time, at: now };
      if (prev && sameAnswer(prev, answer)) return unchanged(doc);
      const next = bump(doc, now, { answers: { ...doc.answers, [actor]: answer } });
      // Sonuçlar düzenleyene toplu gider; bildirimden SONRAki yanıtlar tek tek bildirilir.
      const effects: EventEffect[] =
        doc.stage === 'final' || doc.results_at !== null
          ? [{ type: 'rsvp', to: [doc.owner_id], by: actor, status: answer.status, note, venue_option_id: venue, time_option_id: time }]
          : [];
      return done(withResultsIfDone(next, effects, actor, now));
    }

    case 'finalize': {
      const no = ownerOnly();
      if (no) return no;
      if (doc.stage !== 'voting') return fail('event_stage_mismatch', { stage: doc.stage });
      if (goingInvitees(doc).length === 0) return fail('event_no_attendees');
      const vt = eventTally(doc, 'venue', now);
      const tt = eventTally(doc, 'time', now);
      const v = pickWinner(vt, action.venue_option_id);
      const t = pickWinner(tt, action.time_option_id);
      if ((!v.ok && v.reason === 'no_candidates') || (!t.ok && t.reason === 'no_candidates')) return fail('event_options_invalid', { reason: 'no_candidates' });
      if ((!v.ok && v.reason === 'not_leader') || (!t.ok && t.reason === 'not_leader')) return fail('event_options_invalid', { reason: 'not_leader' });
      if (!v.ok || !t.ok) {
        return fail('event_vote_tie', { ...(!v.ok ? { venue_leaders: vt.leaders } : {}), ...(!t.ok ? { time_leaders: tt.leaders } : {}) });
      }
      const opt = doc.time_options.find((o) => o.option_id === t.option_id);
      if (!opt) return fail('event_options_invalid', { reason: 'unknown_option' });
      const next = bump(doc, now, {
        stage: 'final',
        venue_option_id: v.option_id,
        time_option_id: t.option_id,
        starts_at: opt.starts_at,
        finalized_at: now,
        respond_by: null,
      });
      return {
        ok: true,
        doc: next,
        effects: [
          { type: 'stage', notice: 'final', to: others(doc.invitee_ids, actor) },
          { type: 'reminders', items: eventReminderPlan(next, now, ctx.offsetAt) },
        ],
        changed: true,
      };
    }

    case 'options_set': {
      const no = ownerOnly();
      if (no) return no;
      if (doc.stage !== 'voting') return fail('event_stage_mismatch', { stage: doc.stage });
      const venues = buildVenueOptions(doc, action.venues, doc.venue_options);
      if (!venues.ok) return fail('event_options_invalid', { reason: venues.reason });
      const times = buildTimeOptions({ date: doc.date, seq: venues.seq }, action.minutes, ctx, doc.time_options);
      if (!times) return fail('event_options_invalid', { reason: 'time_invalid' });
      const sameVenues = JSON.stringify(venues.options) === JSON.stringify(doc.venue_options);
      const sameTimes = JSON.stringify(times.options) === JSON.stringify(doc.time_options);
      if (sameVenues && sameTimes) return unchanged(doc);
      const venueIds = new Set(venues.options.map((o) => o.option_id));
      const timeIds = new Set(times.options.map((o) => o.option_id));
      const answers: Record<UserId, EventAnswer> = {};
      for (const [u, a] of Object.entries(doc.answers)) {
        answers[u] = {
          ...a,
          venue_option_id: a.venue_option_id !== null && venueIds.has(a.venue_option_id) ? a.venue_option_id : null,
          time_option_id: a.time_option_id !== null && timeIds.has(a.time_option_id) ? a.time_option_id : null,
        };
      }
      let next = bump(doc, now, { venue_options: venues.options, time_options: times.options, seq: times.seq, answers });
      if (next.results_at === null) next = { ...next, respond_by: Math.min(doc.respond_by ?? Infinity, respondDeadline(next, now, Infinity)) };
      // Seçimi kaldırılan (yanıtı eksik kalan) davetlilere haber verilir.
      const affected = doc.invitee_ids.filter((u) => {
        const before = doc.answers[u];
        const after = next.answers[u];
        return !!before && !!after && isAnswerComplete(doc, before, now) && !isAnswerComplete(next, after, now);
      });
      const effects: EventEffect[] = affected.length ? [{ type: 'stage', notice: 'options_changed', to: others(affected, actor) }] : [];
      return done(withResultsIfDone(next, effects, actor, now));
    }

    case 'update': {
      const no = ownerOnly();
      if (no) return no;
      if (!isActiveEventStage(doc.stage)) return fail('event_stage_mismatch', { stage: doc.stage });
      if (doc.stage === 'final' && doc.starts_at !== null && now >= doc.starts_at) return fail('event_started');
      const patch: Partial<EventDoc> = {};
      if (action.title !== undefined) {
        const t = sanitizeEventLine(action.title, EVENT_LIMITS.titleMaxChars);
        if (!t) return fail('invalid_argument', { field: 'title' });
        if (t !== doc.title) patch.title = t;
      }
      if (action.description !== undefined) {
        let d: string | null = null;
        if (action.description !== null && action.description.trim() !== '') {
          d = sanitizeEventText(action.description, EVENT_LIMITS.descriptionMaxChars);
          if (!d) return fail('invalid_argument', { field: 'description' });
        }
        if (d !== doc.description) patch.description = d;
      }
      let dateChanged = false;
      if (action.date !== undefined && action.date !== doc.date) {
        // Tarih yalnızca yanıtlar toplanırken değişir: herkes yeniden yanıt verir, saatler yeni tarihe taşınır.
        if (doc.stage !== 'voting') return fail('event_stage_mismatch', { stage: doc.stage, field: 'date' });
        if (!isEventDateAllowed(action.date, now, ctx.offsetAt)) return fail('event_date_invalid');
        const valid = doc.time_options
          .map((o) => o.minute_of_day)
          .filter((m) => localDateTimeToEpoch(action.date as string, m, ctx.offsetAt) >= now + EVENT_LIMITS.minLeadMs);
        const rebuilt = buildTimeOptions({ date: action.date, seq: doc.seq }, valid, ctx);
        if (!rebuilt) return fail('event_options_invalid', { reason: 'time_invalid' });
        dateChanged = true;
        const expires_at = endOfEventDate(action.date, ctx.offsetAt);
        Object.assign(patch, {
          date: action.date,
          expires_at,
          answers: {},
          results_at: null,
          results_reason: null,
          time_options: rebuilt.options,
          seq: rebuilt.seq,
          respond_by: respondDeadline({ expires_at, time_options: rebuilt.options }, now, doc.vote_window_ms),
        } satisfies Partial<EventDoc>);
      }
      if (Object.keys(patch).length === 0) return unchanged(doc);
      const next = bump(doc, now, patch);
      const effects: EventEffect[] = dateChanged ? [{ type: 'stage', notice: 'date_changed', to: others(doc.invitee_ids, actor) }] : [];
      return { ok: true, doc: next, effects, changed: true };
    }

    case 'invite_add': {
      const no = ownerOnly();
      if (no) return no;
      if (!isActiveEventStage(doc.stage)) return fail('event_stage_mismatch', { stage: doc.stage });
      if (doc.stage === 'final' && doc.starts_at !== null && now >= doc.starts_at) return fail('event_started');
      const fresh = [...new Set(action.invitee_ids)].filter((u) => u !== doc.owner_id && !doc.invitee_ids.includes(u));
      if (fresh.length === 0) return unchanged(doc);
      if (doc.invitee_ids.length + fresh.length > EVENT_LIMITS.maxInvitees) return fail('event_invitee_limit');
      const names = { ...doc.names };
      for (const u of fresh) names[u] = sanitizeEventLine(action.names[u] ?? '', 80) ?? '';
      const invitee_ids = [...doc.invitee_ids, ...fresh];
      const next = bump(doc, now, { invitee_ids, member_ids: [doc.owner_id, ...invitee_ids], names });
      return { ok: true, doc: next, effects: [{ type: 'invite', to: fresh }], changed: true };
    }

    case 'cancel': {
      const no = ownerOnly();
      if (no) return no;
      if (!isActiveEventStage(doc.stage)) return unchanged(doc);
      const next = endEvent(doc, 'cancelled', now);
      return { ok: true, doc: next, effects: [{ type: 'cancelled', to: others(doc.invitee_ids, actor) }, { type: 'reminders', items: [] }], changed: true };
    }

    case 'remove_member': {
      if (actor !== 'system') return fail('invalid_argument');
      if (action.uid === doc.owner_id) {
        if (!isActiveEventStage(doc.stage)) return unchanged(doc);
        return { ok: true, doc: endEvent(doc, 'cancelled', now), effects: [{ type: 'reminders', items: [] }], changed: true };
      }
      if (!doc.invitee_ids.includes(action.uid)) return unchanged(doc);
      const invitee_ids = doc.invitee_ids.filter((u) => u !== action.uid);
      const next = bump(doc, now, {
        invitee_ids,
        member_ids: [doc.owner_id, ...invitee_ids],
        names: omit(doc.names, action.uid),
        answers: omit(doc.answers, action.uid),
      });
      // Kalan herkes yanıtlamışsa sonuçlar şimdi düzenleyene gider.
      return done(withResultsIfDone(next, [], 'system', now));
    }

    case 'tick': {
      if (actor !== 'system') return fail('invalid_argument');
      if (!isActiveEventStage(doc.stage)) return unchanged(doc);
      if (doc.stage === 'final') {
        if (doc.starts_at !== null && now >= doc.starts_at + EVENT_LIMITS.completeAfterMs) {
          return { ok: true, doc: endEvent(doc, 'completed', now), effects: [{ type: 'reminders', items: [] }], changed: true };
        }
        return unchanged(doc);
      }
      // voting: gün bitti ya da hiçbir saat seçeneği kalmadı → artık onaylanamaz.
      if (now >= doc.expires_at || timeCandidates(doc, now).length === 0) {
        return { ok: true, doc: endEvent(doc, 'expired', now), effects: [{ type: 'reminders', items: [] }], changed: true };
      }
      if (doc.results_at === null && doc.respond_by !== null && now >= doc.respond_by) {
        const next = bump(doc, now, { results_at: now, results_reason: 'deadline' });
        return { ok: true, doc: next, effects: [{ type: 'stage', notice: 'results', to: [doc.owner_id] }], changed: true };
      }
      return unchanged(doc);
    }
  }
}

// --- oluşturma -------------------------------------------------------------------------------

export interface EventCreateInput {
  title: string;
  description?: string | null;
  date: string;
  time_zone: string;
  /** Sunucu süzdükten sonra kalanlar (izinli arkadaşlar). */
  invitee_ids: UserId[];
  names: Record<UserId, string>;
  /** 1–3 mekan. */
  venue_options: EventVenueInput[];
  /** 1–4 saat (yerel dakika). */
  time_minutes: number[];
  vote_window_ms?: number;
}

/** Yeni etkinlik belgesi (`voting`); doğrulama hatasında `EventResult` hatası. Davet bildirimi etkisi döner. */
export function createEventDoc(eventId: string, ownerId: UserId, input: EventCreateInput, ctx: EventCtx): EventResult {
  const title = sanitizeEventLine(input.title, EVENT_LIMITS.titleMaxChars);
  if (!title) return fail('invalid_argument', { field: 'title' });
  let description: string | null = null;
  if (input.description != null && input.description.trim() !== '') {
    description = sanitizeEventText(input.description, EVENT_LIMITS.descriptionMaxChars);
    if (!description) return fail('invalid_argument', { field: 'description' });
  }
  if (!isValidTimeZone(input.time_zone)) return fail('invalid_argument', { field: 'time_zone' });
  if (!isEventDateAllowed(input.date, ctx.now, ctx.offsetAt)) return fail('event_date_invalid');
  const invitees = [...new Set(input.invitee_ids)].filter((u) => u !== ownerId);
  if (invitees.length === 0) return fail('invalid_argument', { field: 'invitee_ids' });
  if (invitees.length > EVENT_LIMITS.maxInvitees) return fail('event_invitee_limit');
  const windowMs = input.vote_window_ms ?? EVENT_LIMITS.defaultVoteWindowMs;
  if (!EVENT_LIMITS.voteWindowsMs.includes(windowMs)) return fail('invalid_argument', { field: 'vote_window_ms' });
  const venues = buildVenueOptions({ seq: 0 }, input.venue_options ?? []);
  if (!venues.ok) return fail('event_options_invalid', { reason: venues.reason });
  const times = buildTimeOptions({ date: input.date, seq: venues.seq }, input.time_minutes ?? [], ctx);
  if (!times) return fail('event_options_invalid', { reason: 'time_invalid' });

  const names: Record<UserId, string> = {};
  for (const u of [ownerId, ...invitees]) names[u] = sanitizeEventLine(input.names[u] ?? '', 80) ?? '';
  const expires_at = endOfEventDate(input.date, ctx.offsetAt);

  const doc: EventDoc = {
    event_id: eventId,
    owner_id: ownerId,
    title,
    description,
    date: input.date,
    time_zone: input.time_zone,
    invitee_ids: invitees,
    member_ids: [ownerId, ...invitees],
    names,
    stage: 'voting',
    respond_by: respondDeadline({ expires_at, time_options: times.options }, ctx.now, windowMs),
    vote_window_ms: windowMs,
    answers: {},
    venue_options: venues.options,
    time_options: times.options,
    results_at: null,
    results_reason: null,
    venue_option_id: null,
    time_option_id: null,
    starts_at: null,
    finalized_at: null,
    expires_at,
    end_reason: null,
    ended_at: null,
    seq: times.seq,
    created_at: ctx.now,
    updated_at: ctx.now,
    version: 1,
  };
  return { ok: true, doc, effects: [{ type: 'invite', to: invitees }], changed: true };
}

/** Firestore'dan okunan belgeyi doğrular; bozuksa (ör. eski aşamalı biçim) null. Bilinmeyen alanlar atılır. */
export function parseEventDoc(raw: unknown): EventDoc | null {
  const r = EventDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// --- görünüm yardımcıları --------------------------------------------------------------------------

export const EVENT_STAGE_TEXT: Record<EventStage, string> = {
  voting: 'Yanıtlar toplanıyor',
  final: 'Kesinleşti',
  completed: 'Tamamlandı',
  cancelled: 'İptal edildi',
  expired: 'Süresi doldu',
};

/** Kart / liste başlığı: sonuç bildirimi gittiyse "Sonuçlar hazır". */
export function eventPhaseText(doc: Pick<EventDoc, 'stage' | 'results_at'>): string {
  if (doc.stage === 'voting' && doc.results_at !== null) return 'Sonuçlar hazır · onay bekleniyor';
  return EVENT_STAGE_TEXT[doc.stage];
}

/** Üç adımlı ilerleme: 1 Yanıtlar · 2 Sonuçlar · 3 Kesinleşti (tamamlandı = 4). İptal / süre dolumu = 0. */
export function eventStep(doc: Pick<EventDoc, 'stage' | 'results_at'>): 0 | 1 | 2 | 3 | 4 {
  switch (doc.stage) {
    case 'voting':
      return doc.results_at === null ? 1 : 2;
    case 'final':
      return 3;
    case 'completed':
      return 4;
    default:
      return 0;
  }
}

export const ATTENDANCE_TEXT: Record<AttendanceStatus, string> = { going: 'Katılacağım', not_going: 'Katılamayacağım' };
export const ATTENDANCE_THIRD_PERSON: Record<AttendanceStatus | 'pending', string> = { going: 'Katılacak', not_going: 'Katılamayacak', pending: 'Yanıt bekleniyor' };

export const EVENT_TEXT = {
  screenTitle: 'Etkinlikler',
  create: 'Etkinlik oluştur',
  emptyTitle: 'Henüz etkinlik yok',
  emptyBody: 'Arkadaşlarını davet et; katılımı, mekanı ve saati tek seferde işaretlesinler.',
  createHint: 'Davetliler katılımını, mekanı ve saati tek seferde işaretler. Herkes yanıtlayınca ya da süre dolunca sonuçların tamamı sana gelir.',
  ballotTitle: 'Yanıtın',
  ballotHint: 'Katılımını, mekanı ve saati işaretle, tek seferde gönder.',
  send: 'Yanıtımı gönder',
  resend: 'Yanıtımı güncelle',
  sent: 'Yanıtın düzenleyene iletildi. Düzenleyen onaylayana kadar değiştirebilirsin.',
  votesHidden: 'Oylar yalnızca düzenleyene görünür.',
  notePlaceholder: 'İstersen nedenini yaz (en çok 300 karakter)',
  noteTitle: 'Katılamayacağını bildir',
  resultsTitle: 'Sonuçlar',
  waitingResults: 'Herkes yanıt verince ya da yanıt süresi dolunca sonuçların tamamı sana tek bildirimle gelir. İstersen beklemeden onaylayabilirsin.',
  finalize: 'Sonucu onayla ve herkese bildir',
  tieTitle: 'Oylar eşit: kazananı sen seç',
  needAttendee: 'Onaylamak için en az bir davetlinin "Katılacağım" demesi gerekiyor.',
  editOptions: 'Seçenekleri düzenle',
  saveOptions: 'Seçenekleri kaydet',
  optionsChangedHint: 'Kaldırılan seçeneği işaretleyenlerin yanıtı sıfırlanır ve onlara haber verilir.',
  finalChange: 'Planın değişirse katılımını buradan güncelle.',
  remindersNote: 'Buluşmadan 1 gün önce ve buluşma günü sabah 08:00\'de hatırlatılır.',
  cancel: 'Etkinliği iptal et',
  cancelConfirm: 'Etkinlik herkes için iptal edilecek. Emin misin?',
  inviteNoPermissionHint: 'Yalnızca seni buluşmaya davet etmene izin veren arkadaşların listelenir.',
} as const;

/** Kartta özet: "Moda Kahve · 29 Kasım Cuma 10:00"; kesinleşmediyse tarih (+ tek seçenekli mekan / saat). */
export function eventSummaryLine(doc: EventDoc): string {
  const day = formatEventDate(doc.date);
  const venue = venueOf(doc) ?? (doc.venue_options.length === 1 ? (doc.venue_options[0] ?? null) : null);
  const time = timeOptionOf(doc) ?? (doc.time_options.length === 1 ? (doc.time_options[0] ?? null) : null);
  const when = time ? `${day} ${formatMinuteOfDay(time.minute_of_day)}` : day;
  return venue ? `${venue.name} · ${when}` : when;
}

/** "3 katılacak · 1 katılamayacak · 2 yanıt bekleniyor" (sahip katılır). */
export function attendanceCounts(doc: Pick<EventDoc, 'invitee_ids' | 'answers'>): { going: number; not_going: number; pending: number } {
  let going = 1; // sahip
  let not_going = 0;
  let pending = 0;
  for (const u of doc.invitee_ids) {
    const s = doc.answers[u]?.status;
    if (s === 'going') going += 1;
    else if (s === 'not_going') not_going += 1;
    else pending += 1;
  }
  return { going, not_going, pending };
}

/** Benden beklenen eylem (liste rozeti): yanıt, eksik yanıtı tamamlama ya da sonucu onaylama; yoksa null. */
export type EventTodo = 'respond' | 'complete_answer' | 'finalize' | null;

export function eventTodoFor(doc: EventDoc, me: UserId, now: EpochMs): EventTodo {
  const isOwner = me === doc.owner_id;
  const a = doc.answers[me];
  switch (doc.stage) {
    case 'voting':
      if (isOwner) return doc.results_at !== null ? 'finalize' : null;
      if (!a) return 'respond';
      return isAnswerComplete(doc, a, now) ? null : 'complete_answer';
    case 'final':
      if (isOwner || a || (doc.starts_at !== null && now >= doc.starts_at)) return null;
      return 'respond';
    default:
      return null;
  }
}

/** Liste sırası: önce benden eylem bekleyenler, sonra etkinler (yakın tarih önde), sonra bitenler (yeni önde). */
export function sortEventsForList(docs: readonly EventDoc[], me: UserId, now: EpochMs): EventDoc[] {
  const rank = (d: EventDoc) => (eventTodoFor(d, me, now) ? 0 : isActiveEventStage(d.stage) ? 1 : 2);
  const when = (d: EventDoc) => d.starts_at ?? d.expires_at;
  return [...docs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 2) return (b.ended_at ?? b.updated_at) - (a.ended_at ?? a.updated_at);
    return when(a) - when(b);
  });
}

const nameOr = (n: string | null | undefined, fallback: string) => (n && n.trim() ? n.trim() : fallback);
const quote = (s: string) => `“${s}”`;

function optionLabel(doc: Pick<EventDoc, 'venue_options' | 'time_options'>, kind: VoteKind, id: string): string {
  if (kind === 'venue') return doc.venue_options.find((o) => o.option_id === id)?.name ?? id;
  const t = doc.time_options.find((o) => o.option_id === id);
  return t ? formatMinuteOfDay(t.minute_of_day) : id;
}

/** "Mekan: Moda Kahve (3 oy)" · "Mekan: eşitlik (Moda Kahve / Kadıköy Fırın)" · tek seçenekte "Mekan: Moda Kahve". */
function leaderPart(doc: BallotView, kind: VoteKind, now: EpochMs): string | null {
  const label = kind === 'venue' ? 'Mekan' : 'Saat';
  const options = kind === 'venue' ? doc.venue_options : timeCandidates(doc, now);
  if (options.length === 0) return null;
  if (options.length === 1) return `${label}: ${optionLabel(doc, kind, options[0]?.option_id ?? '')}`;
  const t = eventTally(doc, kind, now);
  if (t.total === 0) return null;
  if (t.leaders.length === 1) {
    const id = t.leaders[0] ?? '';
    return `${label}: ${optionLabel(doc, kind, id)} (${t.counts[id] ?? 0} oy)`;
  }
  return `${label}: eşitlik (${t.leaders.map((id) => optionLabel(doc, kind, id)).join(' / ')})`;
}

/** "Sonuçlar hazır" gövdesi: "4 katılacak · 1 katılamayacak · 1 yanıt vermedi · Mekan: Moda Kahve (3 oy) · Saat: 10:00 (2 oy)". */
export function eventResultsSummary(doc: EventDoc, now: EpochMs = doc.updated_at): string {
  const c = attendanceCounts(doc);
  const parts = [`${c.going} katılacak`];
  if (c.not_going) parts.push(`${c.not_going} katılamayacak`);
  if (c.pending) parts.push(`${c.pending} yanıt vermedi`);
  const venue = leaderPart(doc, 'venue', now);
  const time = leaderPart(doc, 'time', now);
  if (venue) parts.push(venue);
  if (time) parts.push(time);
  return parts.join(' · ');
}

/** Davet: "Etkinlik daveti" · "Ayşe seni “Kahvaltı” etkinliğine davet etti · 29 Kasım Cuma. Katılımını, mekanı ve saati işaretle". */
export function eventInvitePushText(ownerName: string | null | undefined, doc: Pick<EventDoc, 'title' | 'date'>): { title: string; body: string } {
  return {
    title: 'Etkinlik daveti',
    body: `${nameOr(ownerName, 'Bir arkadaşın')} seni ${quote(doc.title)} etkinliğine davet etti · ${formatEventDate(doc.date)}. Katılımını, mekanı ve saati işaretle`,
  };
}

export function eventStagePushText(notice: EventStageNotice, doc: EventDoc, now: EpochMs = doc.updated_at): { title: string; body: string } {
  switch (notice) {
    case 'results':
      return { title: `Sonuçlar hazır: ${doc.title}`, body: eventResultsSummary(doc, now) };
    case 'final':
      return { title: `Kesinleşti: ${doc.title}`, body: eventSummaryLine(doc) };
    case 'date_changed':
      return { title: doc.title, body: `Tarih değişti: ${formatEventDate(doc.date)}. Yanıtını yeniden ver` };
    case 'options_changed':
      return { title: doc.title, body: 'Mekan ya da saat seçenekleri değişti. Yanıtını güncelle' };
  }
}

/** Sahibe (sonuç bildiriminden sonra): "Bora katılacak · Moda Kahve · 10:00" · "Bora katılamayacak: “Ailemle olacağım”". */
export function eventRsvpPushText(
  byName: string | null | undefined,
  doc: Pick<EventDoc, 'title' | 'stage' | 'venue_options' | 'time_options'>,
  status: AttendanceStatus,
  note: string | null,
  venueOptionId: string | null = null,
  timeOptionId: string | null = null,
): { title: string; body: string } {
  const n = nameOr(byName, 'Bir davetli');
  if (status === 'not_going') return { title: doc.title, body: note ? `${n} katılamayacak: ${quote(note)}` : `${n} katılamayacak` };
  const picks =
    doc.stage === 'voting'
      ? [venueOptionId && doc.venue_options.length > 1 ? optionLabel(doc, 'venue', venueOptionId) : null, timeOptionId && doc.time_options.length > 1 ? optionLabel(doc, 'time', timeOptionId) : null].filter(
          (x): x is string => !!x,
        )
      : [];
  return { title: doc.title, body: [`${n} katılacak`, ...picks].join(' · ') };
}

export function eventReminderPushText(kind: EventReminderKind, doc: EventDoc): { title: string; body: string } {
  const venue = venueOf(doc);
  const time = timeOptionOf(doc);
  const clock = time ? formatMinuteOfDay(time.minute_of_day) : '';
  if (kind === 'day_before') return { title: `Yarın: ${doc.title}`, body: [venue?.name, clock].filter(Boolean).join(' · ') };
  return { title: `Bugün: ${doc.title}`, body: [clock ? `Saat ${clock}` : null, venue?.name].filter(Boolean).join(' · ') };
}

export function eventCancelledPushText(ownerName: string | null | undefined, doc: Pick<EventDoc, 'title'>): { title: string; body: string } {
  return { title: 'Etkinlik iptal edildi', body: `${nameOr(ownerName, 'Düzenleyen')} ${quote(doc.title)} etkinliğini iptal etti` };
}

// --- bildirim kutusu (uygulama içi) --------------------------------------------------------------

export const EVENT_NOTICE_TYPES = ['event_invite', 'event_stage', 'event_rsvp', 'event_reminder', 'event_cancelled'] as const;
export type EventNoticeType = (typeof EVENT_NOTICE_TYPES)[number];

/** `users/{uid}/notices/{notice_id}` (yalnızca sunucu yazar, sahibi okur, 30 gün TTL). Koordinat YOK. */
export interface EventNotice {
  notice_id: string;
  type: EventNoticeType;
  event_id: string;
  title: string;
  body: string;
  created_at: EpochMs;
}

export const NOTICE_RETENTION_MS = 30 * DAY;
/** Bildirim kutusunda gösterilen en çok kayıt. */
export const NOTICE_LIST_LIMIT = 50;

export const EventNoticeSchema: z.ZodType<EventNotice> = z.object({
  notice_id: z.string().min(1).max(200),
  type: z.enum(EVENT_NOTICE_TYPES),
  event_id: z.string().min(1).max(64),
  title: z.string().max(200),
  body: z.string().max(600),
  created_at: z.number(),
});

export function parseEventNotice(raw: unknown): EventNotice | null {
  const r = EventNoticeSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Okunmamış sayısı (okundu anı cihazda tutulur). */
export const unreadNoticeCount = (list: readonly Pick<EventNotice, 'created_at'>[], lastSeenAt: EpochMs | null): number =>
  list.filter((n) => lastSeenAt === null || n.created_at > lastSeenAt).length;

// --- şemalar ---------------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const opId = z.uuid();
const eventIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const venueOptionIdSchema = z.string().regex(/^v\d{1,4}$/);
const timeOptionIdSchema = z.string().regex(/^t\d{1,4}$/);
const LatLngZ = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/** İstemcide sınırlar sunucuyla aynı ölçüyle denetlenir (kod noktası); ayrıntılı temizlik `reduceEvent`te. */
const lineMax = (max: number) => z.string().max(max * 4).refine((s) => eventTextLength(s.trim()) <= max, { message: `en çok ${max} karakter` });

export const EventVenueInputSchema = z.object({
  name: lineMax(EVENT_LIMITS.venueNameMaxChars).refine((s) => s.trim().length > 0),
  address: lineMax(EVENT_LIMITS.venueAddressMaxChars).nullable().default(null),
  location: LatLngZ.nullable().default(null),
  place_id: z.string().min(1).max(256).nullable().default(null),
});

const minuteOfDay = z.number().int().min(0).max(1439);
const voteWindow = z.number().int().refine((v) => EVENT_LIMITS.voteWindowsMs.includes(v), { message: 'geçersiz yanıt süresi' });
const venueList = z.array(EventVenueInputSchema).min(EVENT_LIMITS.minVenueOptions).max(EVENT_LIMITS.maxVenueOptions);
const minuteList = z.array(minuteOfDay).min(EVENT_LIMITS.minTimeOptions).max(EVENT_LIMITS.maxTimeOptions);

export const EventCreateRequestSchema = z.object({
  op_id: opId,
  title: lineMax(EVENT_LIMITS.titleMaxChars).refine((s) => s.trim().length > 0),
  description: lineMax(EVENT_LIMITS.descriptionMaxChars).nullable().default(null),
  date: z.string().regex(DATE_RE),
  time_zone: z.string().min(1).max(64),
  invitee_ids: z.array(uid).min(1).max(EVENT_LIMITS.maxInvitees),
  /** 1–3 mekan (zorunlu: davetli tek seferde seçer). */
  venue_options: venueList,
  /** 1–4 saat, yerel dakika (zorunlu). */
  time_minutes: minuteList,
  vote_window_ms: voteWindow.default(EVENT_LIMITS.defaultVoteWindowMs),
});
export type EventCreateRequest = z.input<typeof EventCreateRequestSchema>;

/** Davetlinin tek yanıtı: katılım + (katılıyorsa) mekan ve saat; katılamıyorsa isteğe bağlı not. */
export const EventRespondRequestSchema = z.object({
  op_id: opId,
  event_id: eventIdSchema,
  status: z.enum(ATTENDANCE_STATUSES),
  note: z.string().max(EVENT_LIMITS.noteMaxChars * 4).nullable().default(null),
  venue_option_id: venueOptionIdSchema.nullable().default(null),
  time_option_id: timeOptionIdSchema.nullable().default(null),
});
export type EventRespondRequest = z.input<typeof EventRespondRequestSchema>;

/** Sahip: sonucu onayla. Eşitlikte kazanan (`event_vote_tie` yanıtındaki `venue_leaders` / `time_leaders` içinden). */
export const EventFinalizeRequestSchema = z.object({
  op_id: opId,
  event_id: eventIdSchema,
  venue_option_id: venueOptionIdSchema.nullable().default(null),
  time_option_id: timeOptionIdSchema.nullable().default(null),
});
export type EventFinalizeRequest = z.input<typeof EventFinalizeRequestSchema>;

/** Sahip (`voting`): mekan ve saat seçeneklerini değiştir. */
export const EventOptionsSetRequestSchema = z.object({
  op_id: opId,
  event_id: eventIdSchema,
  venues: venueList,
  minutes: minuteList,
});
export type EventOptionsSetRequest = z.input<typeof EventOptionsSetRequestSchema>;

export const EventUpdateRequestSchema = z.object({
  op_id: opId,
  event_id: eventIdSchema,
  title: lineMax(EVENT_LIMITS.titleMaxChars).optional(),
  description: lineMax(EVENT_LIMITS.descriptionMaxChars).nullable().optional(),
  date: z.string().regex(DATE_RE).optional(),
});
export type EventUpdateRequest = z.input<typeof EventUpdateRequestSchema>;

export const EventInviteAddRequestSchema = z.object({ op_id: opId, event_id: eventIdSchema, invitee_ids: z.array(uid).min(1).max(EVENT_LIMITS.maxInvitees) });
export type EventInviteAddRequest = z.input<typeof EventInviteAddRequestSchema>;

export const EventCancelRequestSchema = z.object({ op_id: opId, event_id: eventIdSchema });
export type EventCancelRequest = z.input<typeof EventCancelRequestSchema>;

const AnswerZ = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  note: z.string().nullable(),
  venue_option_id: z.string().nullable(),
  time_option_id: z.string().nullable(),
  at: z.number(),
});
const VenueZ = z.object({
  option_id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  location: LatLngZ.nullable(),
  place_id: z.string().nullable(),
});
const TimeZ = z.object({ option_id: z.string(), minute_of_day: z.number(), starts_at: z.number() });

export const EventDocSchema: z.ZodType<EventDoc> = z.object({
  event_id: z.string().min(1),
  owner_id: z.string().min(1),
  title: z.string(),
  description: z.string().nullable(),
  date: z.string().regex(DATE_RE),
  time_zone: z.string(),
  invitee_ids: z.array(z.string()),
  member_ids: z.array(z.string()),
  names: z.record(z.string(), z.string()),
  stage: z.enum(EVENT_STAGES),
  respond_by: z.number().nullable(),
  vote_window_ms: z.number(),
  answers: z.record(z.string(), AnswerZ),
  venue_options: z.array(VenueZ),
  time_options: z.array(TimeZ),
  results_at: z.number().nullable(),
  results_reason: z.enum(EVENT_RESULTS_REASONS).nullable(),
  venue_option_id: z.string().nullable(),
  time_option_id: z.string().nullable(),
  starts_at: z.number().nullable(),
  finalized_at: z.number().nullable(),
  expires_at: z.number(),
  end_reason: z.enum(['completed', 'cancelled', 'expired']).nullable(),
  ended_at: z.number().nullable(),
  seq: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  version: z.number(),
});

/** Tüm etkinlik callable'larının yanıtı. */
export interface EventResponse {
  event: EventDoc;
  /** `event_create` / `event_invite_add`: izinsiz / arkadaş olmayan için SESSİZCE atlanan kişi SAYISI (kimlik yok). */
  skipped_count: number;
  server_now: EpochMs;
}

export const EventResponseSchema: z.ZodType<EventResponse> = z.object({ event: EventDocSchema, skipped_count: z.number().int().nonnegative(), server_now: z.number() });
