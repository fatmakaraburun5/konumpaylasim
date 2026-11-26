/**
 * Faz 7: Etkinlik & çok aşamalı buluşma oylaması (bkz. docs/PHASE7.md §1–§3).
 *
 * Kayıt: Firestore `events/{event_id}` (üyeler = sahibi + davetliler okur, YALNIZCA callable yazar).
 * Hatırlatıcılar: `event_reminders/{event_id}_{kind}` (yalnızca sunucu). Uygulama içi bildirim kutusu:
 * `users/{uid}/notices/{notice_id}` (yalnızca sahibi okur, yalnızca sunucu yazar).
 *
 * Durum makinesi (aşama = `stage`):
 *
 *   rsvp ──open_venue_vote (sahip; 3 mekan + ≥1 "Katılacağım")──▶ venue_vote
 *     │                                                              │ herkes oy verdi (eşitlik yok) / sahip kapattı /
 *     │                                                              │ süre doldu (eşitlikte ilk önerilen)
 *     │                                                              ▼
 *     │                                                          time_vote ── saat seçenekleri yoksa sahip ekler
 *     │                                                              │ aynı kapanış kuralları
 *     │                                                              ▼
 *     │                                                            final  (mekan + saat kesin; HERKES son onay verir;
 *     │                                                              │     1 gün önce + günün 08:00'i hatırlatma)
 *     │                                                              ▼ başlangıç + 3 sa
 *     │                                                          completed
 *     ├── cancel (sahip, her etkin aşamada) ──▶ cancelled
 *     └── tarih günü bitti, final'e ulaşılmadı ──▶ expired
 *
 * Kurallar:
 *  - Davet yalnızca bana `meetup_invite` izni vermiş arkadaşa gider (Faz 8 `canInvite`); diğerleri sessizce düşer.
 *  - Aşama 1 yanıtı (`rsvp`) son onaydan önceki her aşamada değiştirilebilir; "Katılamayacağım" diyenin oyları
 *    silinir ve isteğe bağlı ≤ 300 karakterlik notu kartta herkese görünür. Son onay (`final_rsvp`) yalnızca
 *    `final` aşamasında, başlangıçtan önce verilir ve TÜM davetlilere açıktır (önceden "Katılamayacağım" diyen de).
 *  - Oy: sahip + Aşama 1'de "Katılacağım" diyenler (`eventVoters`). Tek seçim, aşama kapanana kadar değişebilir.
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
  /** Mekan oylaması tam olarak bu kadar seçenekle açılır. */
  venueOptions: 3,
  /** Sahip olmayan bir davetlinin önerebileceği mekan sayısı. [Varsayım] */
  venueProposalsPerInvitee: 1,
  minTimeOptions: 2,
  maxTimeOptions: 4,
  /** Tarih en çok bu kadar ileride olabilir. [Varsayım] */
  maxDaysAhead: 180,
  /** Saat seçeneği en az bu kadar ileride olmalı (seçildiği anda). [Varsayım] */
  minLeadMs: 30 * MINUTE,
  /** Oylama süresi seçenekleri; varsayılan 24 sa. */
  voteWindowsMs: [2 * HOUR, 6 * HOUR, 24 * HOUR, 48 * HOUR] as readonly number[],
  defaultVoteWindowMs: 24 * HOUR,
  /** Saat oylaması en geç ilk saat seçeneğinden bu kadar önce kapanır. */
  timeVoteCloseBeforeMs: 15 * MINUTE,
  /** Süre dolumu kapanışı en az bu kadar sonra (çok yakın son tarih anında kapanmasın). */
  minDeadlineLeadMs: MINUTE,
  /** Başlangıçtan bu kadar sonra `completed`. [Varsayım] */
  completeAfterMs: 3 * HOUR,
  /** Biten etkinlik bu kadar sonra silinir (TTL). [Varsayım] */
  retentionMs: 30 * DAY,
  /** Sahip başına aynı anda etkin etkinlik. [Varsayım] */
  maxActivePerOwner: 10,
  /** Kullanıcı başına günlük oluşturma. [Varsayım] */
  createsPerDay: 20,
  /** Kullanıcı başına saatlik etkinlik işlemi (yanıt, oy, öneri…). [Varsayım] */
  actionsPerHour: 120,
} as const;

/** Hatırlatma saati: buluşma günü yerel 08:00. */
export const EVENT_MORNING_REMINDER_MINUTE = 8 * 60;
/** Kesinleşen buluşmadan 1 gün önce. */
export const EVENT_DAY_BEFORE_MS = DAY;
/** Sweeper bundan geç kalan hatırlatmayı göndermez (`stale`). [Varsayım] */
export const EVENT_REMINDER_MAX_LATENESS_MS = 2 * HOUR;

// --- tipler -------------------------------------------------------------------------------

export const EVENT_STAGES = ['rsvp', 'venue_vote', 'time_vote', 'final', 'completed', 'cancelled', 'expired'] as const;
export type EventStage = (typeof EVENT_STAGES)[number];
export const ACTIVE_EVENT_STAGES = ['rsvp', 'venue_vote', 'time_vote', 'final'] as const satisfies readonly EventStage[];
export type ActiveEventStage = (typeof ACTIVE_EVENT_STAGES)[number];

export const ATTENDANCE_STATUSES = ['going', 'not_going'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** `initial` = Aşama 1 ön onayı (son onaydan önceki her aşamada değişebilir), `final` = Aşama 3 son onay. */
export const RSVP_ROUNDS = ['initial', 'final'] as const;
export type RsvpRound = (typeof RSVP_ROUNDS)[number];

export const VOTE_KINDS = ['venue', 'time'] as const;
export type VoteKind = (typeof VOTE_KINDS)[number];

export interface EventAnswer {
  status: AttendanceStatus;
  /** Yalnızca `not_going` için; ≤ 300 karakter, kartta tüm üyelere görünür. */
  note: string | null;
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
  proposed_by: UserId;
  proposed_at: EpochMs;
}

export interface EventTimeOption {
  /** `t5`, `t6`… */
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
  /** Oylama aşamasının otomatik kapanış anı; oylama yoksa null. */
  stage_deadline_at: EpochMs | null;
  vote_window_ms: number;
  /** Aşama 1 yanıtları (davetliler; sahip her zaman katılır). Kayıt yoksa "yanıt bekleniyor". */
  rsvp: Record<UserId, EventAnswer>;
  /** Son onay (yalnızca `final`). */
  final_rsvp: Record<UserId, EventAnswer>;
  venue_options: EventVenueOption[];
  venue_votes: Record<UserId, string>;
  venue_option_id: string | null;
  time_options: EventTimeOption[];
  time_votes: Record<UserId, string>;
  time_option_id: string | null;
  /** Kesinleşen başlangıç (yalnızca `final` ve sonrası). */
  starts_at: EpochMs | null;
  finalized_at: EpochMs | null;
  /** Etkin aşamalar bu andan sonra `expired` olur: tarih gününün yerel sonu. */
  expires_at: EpochMs;
  end_reason: EventEndReason | null;
  ended_at: EpochMs | null;
  /** Öneri / seçenek kimlik sayacı. */
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

/** Aşama 1 yanıtı (sahip her zaman `going`); yanıt yoksa null. */
export function initialStatusOf(doc: Pick<EventDoc, 'owner_id' | 'rsvp'>, uid: UserId): AttendanceStatus | null {
  if (uid === doc.owner_id) return 'going';
  return doc.rsvp[uid]?.status ?? null;
}

/** Son onay (sahip her zaman `going`); yanıt yoksa null. */
export function finalStatusOf(doc: Pick<EventDoc, 'owner_id' | 'final_rsvp'>, uid: UserId): AttendanceStatus | null {
  if (uid === doc.owner_id) return 'going';
  return doc.final_rsvp[uid]?.status ?? null;
}

/** Oy verebilenler: sahip + Aşama 1'de "Katılacağım" diyen davetliler. */
export function eventVoters(doc: Pick<EventDoc, 'owner_id' | 'invitee_ids' | 'rsvp'>): UserId[] {
  return [doc.owner_id, ...doc.invitee_ids.filter((u) => doc.rsvp[u]?.status === 'going')];
}

/** Aşama 1'de henüz yanıt vermemiş davetliler. */
export function pendingInitial(doc: Pick<EventDoc, 'invitee_ids' | 'rsvp'>): UserId[] {
  return doc.invitee_ids.filter((u) => !doc.rsvp[u]);
}

export interface VoteTally {
  /** option_id → geçerli oy sayısı (yalnızca `eventVoters`). */
  counts: Record<string, number>;
  /** En çok oyu alan seçenek(ler), seçenek sırasıyla. Oy yoksa tüm seçenekler. */
  leaders: string[];
  /** Geçerli oy sayısı. */
  total: number;
  /** Oy verebilenlerin sayısı. */
  eligible: number;
}

/** Oy sayımı: yalnızca oy verebilenlerin, var olan seçeneğe verdiği oy geçerlidir. */
export function tallyVotes(options: readonly { option_id: string }[], votes: Record<UserId, string>, voters: readonly UserId[]): VoteTally {
  const counts: Record<string, number> = {};
  for (const o of options) counts[o.option_id] = 0;
  let total = 0;
  for (const v of voters) {
    const choice = votes[v];
    if (choice !== undefined && counts[choice] !== undefined) {
      counts[choice] += 1;
      total += 1;
    }
  }
  const max = Math.max(0, ...Object.values(counts));
  const leaders = options.map((o) => o.option_id).filter((id) => counts[id] === max);
  return { counts, leaders, total, eligible: voters.length };
}

/** Bir oylama aşaması için seçenekler ve oylar. Saat oylamasında başlangıcı geçmiş seçenek aday değildir. */
function voteSubject(doc: EventDoc, kind: VoteKind, now: EpochMs): { options: { option_id: string }[]; votes: Record<UserId, string> } {
  if (kind === 'venue') return { options: doc.venue_options, votes: doc.venue_votes };
  return { options: doc.time_options.filter((t) => t.starts_at > now), votes: doc.time_votes };
}

export function eventTally(doc: EventDoc, kind: VoteKind, now: EpochMs): VoteTally {
  const s = voteSubject(doc, kind, now);
  return tallyVotes(s.options, s.votes, eventVoters(doc));
}

/**
 * Oylama kendiliğinden kapanabilir mi: yanıt bekleyen davetli yok, oy verebilen HERKES oy verdi ve tek lider var.
 * (Bekleyen davetli sonradan "Katılacağım" deyip oy hakkı kazanabileceği için onu beklemek gerekir.)
 */
export function voteCanAutoClose(doc: EventDoc, kind: VoteKind, now: EpochMs): boolean {
  if (pendingInitial(doc).length > 0) return false;
  const t = eventTally(doc, kind, now);
  return t.eligible > 0 && t.total === t.eligible && t.leaders.length === 1;
}

/** Süre dolumunda kazanan: tek lider, eşitlikte ilk önerilen (seçenek sırası). Aday yoksa null. */
export function deadlineWinner(t: VoteTally): string | null {
  return t.leaders[0] ?? null;
}

export function venueOf(doc: Pick<EventDoc, 'venue_options' | 'venue_option_id'>): EventVenueOption | null {
  return doc.venue_options.find((o) => o.option_id === doc.venue_option_id) ?? null;
}

export function timeOptionOf(doc: Pick<EventDoc, 'time_options' | 'time_option_id'>): EventTimeOption | null {
  return doc.time_options.find((o) => o.option_id === doc.time_option_id) ?? null;
}

/** Sweeper'ın bu etkinliğe bir sonraki bakış anı (null = bakılacak bir şey yok). */
export function eventNextActionAt(doc: Pick<EventDoc, 'stage' | 'stage_deadline_at' | 'expires_at' | 'starts_at'>): EpochMs | null {
  switch (doc.stage) {
    case 'rsvp':
      return doc.expires_at;
    case 'venue_vote':
    case 'time_vote':
      return doc.stage_deadline_at === null ? doc.expires_at : Math.min(doc.stage_deadline_at, doc.expires_at);
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

/** Hatırlatma alıcıları: sahip + son onayda "Katılamayacağım" DEMEYEN davetliler (yanıtsızlar da hatırlatılır). */
export function eventReminderRecipients(doc: Pick<EventDoc, 'owner_id' | 'invitee_ids' | 'final_rsvp'>): UserId[] {
  return [doc.owner_id, ...doc.invitee_ids.filter((u) => doc.final_rsvp[u]?.status !== 'not_going')];
}

// --- etkiler (backend ve demo bunları push / hatırlatma / bildirim kutusuna çevirir) ----------------

/** Aşama bildirimi türleri. */
export const EVENT_STAGE_NOTICES = ['venue_vote', 'time_vote', 'need_times', 'final', 'date_changed'] as const;
export type EventStageNotice = (typeof EVENT_STAGE_NOTICES)[number];

export type EventEffect =
  /** Yeni davetlilere davet bildirimi. */
  | { type: 'invite'; to: UserId[] }
  /** Aşama değişti / sahipten iş bekleniyor. `to` boşsa gönderilmez. */
  | { type: 'stage'; notice: EventStageNotice; to: UserId[] }
  /** Sahibe: bir davetli yanıt verdi (değiştiyse). */
  | { type: 'rsvp'; to: UserId[]; by: UserId; round: RsvpRound; status: AttendanceStatus; note: string | null }
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
  | { type: 'rsvp'; round: RsvpRound; status: AttendanceStatus; note?: string | null }
  | { type: 'venue_propose'; venue: EventVenueInput }
  | { type: 'venue_remove'; option_id: string }
  | { type: 'vote'; kind: VoteKind; option_id: string }
  | { type: 'open_venue_vote'; vote_window_ms?: number | null }
  | { type: 'close_vote'; kind: VoteKind; tie_break_option_id?: string | null }
  | { type: 'time_options_set'; minutes: number[] }
  | { type: 'update'; title?: string; description?: string | null; date?: string }
  | { type: 'invite_add'; invitee_ids: UserId[]; names: Record<UserId, string> }
  | { type: 'cancel' }
  /** Sistem: arkadaşlık bitti / engel / hesap silindi. Sahip çıkarılırsa etkinlik iptal edilir. */
  | { type: 'remove_member'; uid: UserId }
  /** Sistem (sweeper): süre dolumu kapanışı, tamamlanma, bitiş. */
  | { type: 'tick' };

export const EVENT_ERROR_CODES = [
  'event_not_found',
  'event_not_owner',
  'event_stage_mismatch',
  'event_not_eligible',
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

/** Aşama 2/3 bildirimi: sahip + "Katılacağım" + yanıtsızlar ("Katılamayacağım" diyenler rahatsız edilmez). */
function engaged(doc: EventDoc): UserId[] {
  return [doc.owner_id, ...doc.invitee_ids.filter((u) => doc.rsvp[u]?.status !== 'not_going')];
}

function voteDeadline(doc: EventDoc, kind: VoteKind, now: EpochMs, windowMs: number): EpochMs {
  let cap = Math.min(now + windowMs, doc.expires_at);
  if (kind === 'time') {
    const future = doc.time_options.filter((t) => t.starts_at > now).map((t) => t.starts_at);
    if (future.length) cap = Math.min(cap, Math.min(...future) - EVENT_LIMITS.timeVoteCloseBeforeMs);
  }
  return Math.max(now + EVENT_LIMITS.minDeadlineLeadMs, cap);
}

/** Saat seçenekleri: 2–4 farklı dakika, her biri tarihte ve en az `minLeadMs` ileride. */
export function buildTimeOptions(
  doc: Pick<EventDoc, 'date' | 'seq'>,
  minutes: readonly number[],
  ctx: EventCtx,
): { options: EventTimeOption[]; seq: number } | null {
  if (minutes.length < EVENT_LIMITS.minTimeOptions || minutes.length > EVENT_LIMITS.maxTimeOptions) return null;
  const uniq = [...new Set(minutes)];
  if (uniq.length !== minutes.length) return null;
  if (uniq.some((m) => !Number.isInteger(m) || m < 0 || m > 1439)) return null;
  let seq = doc.seq;
  const options = [...uniq]
    .sort((a, b) => a - b)
    .map((m) => ({ option_id: `t${++seq}`, minute_of_day: m, starts_at: localDateTimeToEpoch(doc.date, m, ctx.offsetAt) }));
  if (options.some((o) => o.starts_at < ctx.now + EVENT_LIMITS.minLeadMs)) return null;
  return { options, seq };
}

function sanitizeVenue(v: EventVenueInput): Omit<EventVenueOption, 'option_id' | 'proposed_by' | 'proposed_at'> | null {
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

/** Mekan kesinleşti → saat aşaması (seçenek varsa oylama açılır, yoksa sahibe "saat ekle"). */
function enterTimeVote(doc: EventDoc, venueId: string, actor: UserId | 'system', now: EpochMs): { doc: EventDoc; effects: EventEffect[] } {
  const base: EventDoc = { ...doc, stage: 'time_vote', venue_option_id: venueId, time_votes: {}, stage_deadline_at: null };
  const hasOptions = base.time_options.filter((t) => t.starts_at >= now + EVENT_LIMITS.minLeadMs).length >= EVENT_LIMITS.minTimeOptions;
  if (!hasOptions) {
    // Geçersizleşmiş (geçmişte kalan) seçenekler atılır: sahip yenilerini ekler.
    const next = bump(base, now, { time_options: [] });
    return { doc: next, effects: [{ type: 'stage', notice: 'need_times', to: others([doc.owner_id], actor) }] };
  }
  const next = bump(base, now, { stage_deadline_at: voteDeadline(base, 'time', now, doc.vote_window_ms) });
  return { doc: next, effects: [{ type: 'stage', notice: 'time_vote', to: others(engaged(next), actor) }] };
}

/** Saat kesinleşti → son onay; hatırlatıcılar planlanır, TÜM davetlilere bildirim. */
function enterFinal(doc: EventDoc, timeId: string, actor: UserId | 'system', ctx: EventCtx): { doc: EventDoc; effects: EventEffect[] } {
  const opt = doc.time_options.find((t) => t.option_id === timeId);
  if (!opt) throw new Error('saat seçeneği yok');
  const next = bump(doc, ctx.now, {
    stage: 'final',
    time_option_id: timeId,
    starts_at: opt.starts_at,
    finalized_at: ctx.now,
    final_rsvp: {},
    stage_deadline_at: null,
  });
  return {
    doc: next,
    effects: [
      { type: 'stage', notice: 'final', to: others([doc.owner_id, ...doc.invitee_ids], actor) },
      { type: 'reminders', items: eventReminderPlan(next, ctx.now, ctx.offsetAt) },
    ],
  };
}

/** Oylamayı kapat (kazanan belli). */
function closeVote(doc: EventDoc, kind: VoteKind, winner: string, actor: UserId | 'system', ctx: EventCtx): EventResult {
  const r = kind === 'venue' ? enterTimeVote(doc, winner, actor, ctx.now) : enterFinal(doc, winner, actor, ctx);
  return { ok: true, doc: r.doc, effects: r.effects, changed: true };
}

/** Bir oy / yanıt sonrası: kendiliğinden kapanabiliyorsa kapat. */
function maybeAutoClose(res: EventResult, actor: UserId | 'system', ctx: EventCtx): EventResult {
  if (!res.ok) return res;
  const d = res.doc;
  const kind: VoteKind | null = d.stage === 'venue_vote' ? 'venue' : d.stage === 'time_vote' && d.stage_deadline_at !== null ? 'time' : null;
  if (!kind || !voteCanAutoClose(d, kind, ctx.now)) return res;
  const winner = eventTally(d, kind, ctx.now).leaders[0];
  if (!winner) return res;
  const closed = closeVote(d, kind, winner, actor, ctx);
  if (!closed.ok) return res;
  return { ok: true, doc: closed.doc, effects: [...res.effects, ...closed.effects], changed: true };
}

function endEvent(doc: EventDoc, reason: EventEndReason, now: EpochMs): EventDoc {
  return bump(doc, now, { stage: reason, end_reason: reason, ended_at: now, stage_deadline_at: null });
}

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
    case 'rsvp': {
      if (actor === 'system' || isOwner) return fail('invalid_argument', { field: 'actor' });
      let note: string | null = null;
      if (action.status === 'not_going' && action.note != null && action.note.trim() !== '') {
        if (eventTextLength(action.note.trim()) > EVENT_LIMITS.noteMaxChars) return fail('event_note_too_long');
        note = sanitizeEventText(action.note, EVENT_LIMITS.noteMaxChars);
      }
      const answer: EventAnswer = { status: action.status, note, at: now };
      if (action.round === 'initial') {
        if (!(doc.stage === 'rsvp' || doc.stage === 'venue_vote' || doc.stage === 'time_vote')) return fail('event_stage_mismatch', { stage: doc.stage });
        const prev = doc.rsvp[actor];
        if (prev && prev.status === answer.status && prev.note === answer.note) return unchanged(doc);
        let patch: Partial<EventDoc> = { rsvp: { ...doc.rsvp, [actor]: answer } };
        if (action.status === 'not_going') patch = { ...patch, venue_votes: omit(doc.venue_votes, actor), time_votes: omit(doc.time_votes, actor) };
        const next = bump(doc, now, patch);
        const effects: EventEffect[] = [{ type: 'rsvp', to: [doc.owner_id], by: actor, round: 'initial', status: answer.status, note }];
        return maybeAutoClose({ ok: true, doc: next, effects, changed: true }, actor, ctx);
      }
      if (doc.stage !== 'final') return fail('event_stage_mismatch', { stage: doc.stage });
      if (doc.starts_at !== null && now >= doc.starts_at) return fail('event_started');
      const prev = doc.final_rsvp[actor];
      if (prev && prev.status === answer.status && prev.note === answer.note) return unchanged(doc);
      const next = bump(doc, now, { final_rsvp: { ...doc.final_rsvp, [actor]: answer } });
      return { ok: true, doc: next, effects: [{ type: 'rsvp', to: [doc.owner_id], by: actor, round: 'final', status: answer.status, note }], changed: true };
    }

    case 'venue_propose': {
      if (actor === 'system') return fail('invalid_argument');
      if (doc.stage !== 'rsvp') return fail('event_stage_mismatch', { stage: doc.stage });
      if (!isOwner && doc.rsvp[actor]?.status !== 'going') return fail('event_not_eligible');
      if (doc.venue_options.length >= EVENT_LIMITS.venueOptions) return fail('event_options_invalid', { reason: 'venue_limit' });
      if (!isOwner && doc.venue_options.filter((o) => o.proposed_by === actor).length >= EVENT_LIMITS.venueProposalsPerInvitee) {
        return fail('event_options_invalid', { reason: 'proposal_limit' });
      }
      const v = sanitizeVenue(action.venue);
      if (!v) return fail('event_options_invalid', { reason: 'venue_invalid' });
      if (doc.venue_options.some((o) => sameVenue(o, v))) return fail('event_options_invalid', { reason: 'venue_duplicate' });
      const seq = doc.seq + 1;
      const opt: EventVenueOption = { option_id: `v${seq}`, ...v, proposed_by: actor, proposed_at: now };
      return { ok: true, doc: bump(doc, now, { seq, venue_options: [...doc.venue_options, opt] }), effects: [], changed: true };
    }

    case 'venue_remove': {
      if (actor === 'system') return fail('invalid_argument');
      if (doc.stage !== 'rsvp') return fail('event_stage_mismatch', { stage: doc.stage });
      const opt = doc.venue_options.find((o) => o.option_id === action.option_id);
      if (!opt) return unchanged(doc);
      if (!isOwner && opt.proposed_by !== actor) return fail('event_not_owner');
      return { ok: true, doc: bump(doc, now, { venue_options: doc.venue_options.filter((o) => o.option_id !== action.option_id) }), effects: [], changed: true };
    }

    case 'vote': {
      if (actor === 'system') return fail('invalid_argument');
      const stage: EventStage = action.kind === 'venue' ? 'venue_vote' : 'time_vote';
      if (doc.stage !== stage) return fail('event_stage_mismatch', { stage: doc.stage });
      if (action.kind === 'time' && doc.stage_deadline_at === null) return fail('event_stage_mismatch', { stage: doc.stage, reason: 'need_times' });
      if (!eventVoters(doc).includes(actor)) return fail('event_not_eligible');
      const { options, votes } = voteSubject(doc, action.kind, now);
      if (!options.some((o) => o.option_id === action.option_id)) return fail('event_options_invalid', { reason: 'unknown_option' });
      if (votes[actor] === action.option_id) return unchanged(doc);
      const patch: Partial<EventDoc> = action.kind === 'venue' ? { venue_votes: { ...doc.venue_votes, [actor]: action.option_id } } : { time_votes: { ...doc.time_votes, [actor]: action.option_id } };
      return maybeAutoClose({ ok: true, doc: bump(doc, now, patch), effects: [], changed: true }, actor, ctx);
    }

    case 'open_venue_vote': {
      const no = ownerOnly();
      if (no) return no;
      if (doc.stage !== 'rsvp') return fail('event_stage_mismatch', { stage: doc.stage });
      if (doc.venue_options.length !== EVENT_LIMITS.venueOptions) return fail('event_options_invalid', { reason: 'venue_required', count: doc.venue_options.length });
      if (!doc.invitee_ids.some((u) => doc.rsvp[u]?.status === 'going')) return fail('event_no_attendees');
      const windowMs = action.vote_window_ms ?? doc.vote_window_ms;
      if (!EVENT_LIMITS.voteWindowsMs.includes(windowMs)) return fail('invalid_argument', { field: 'vote_window_ms' });
      const base: EventDoc = { ...doc, stage: 'venue_vote', vote_window_ms: windowMs, venue_votes: {} };
      const next = bump(base, now, { stage_deadline_at: voteDeadline(base, 'venue', now, windowMs) });
      return { ok: true, doc: next, effects: [{ type: 'stage', notice: 'venue_vote', to: others(engaged(next), actor) }], changed: true };
    }

    case 'close_vote': {
      const no = ownerOnly();
      if (no) return no;
      const stage: EventStage = action.kind === 'venue' ? 'venue_vote' : 'time_vote';
      if (doc.stage !== stage) return fail('event_stage_mismatch', { stage: doc.stage });
      if (action.kind === 'time' && doc.stage_deadline_at === null) return fail('event_stage_mismatch', { stage: doc.stage, reason: 'need_times' });
      const t = eventTally(doc, action.kind, now);
      if (t.leaders.length === 0) return fail('event_options_invalid', { reason: 'no_candidates' });
      let winner: string | undefined;
      if (t.leaders.length === 1) winner = t.leaders[0];
      else if (action.tie_break_option_id && t.leaders.includes(action.tie_break_option_id)) winner = action.tie_break_option_id;
      else return fail('event_vote_tie', { leaders: t.leaders });
      return closeVote(doc, action.kind, winner as string, actor, ctx);
    }

    case 'time_options_set': {
      const no = ownerOnly();
      if (no) return no;
      if (!(doc.stage === 'rsvp' || doc.stage === 'venue_vote' || doc.stage === 'time_vote')) return fail('event_stage_mismatch', { stage: doc.stage });
      const built = buildTimeOptions(doc, action.minutes, ctx);
      if (!built) return fail('event_options_invalid', { reason: 'time_invalid' });
      const same =
        built.options.length === doc.time_options.length && built.options.every((o, i) => o.minute_of_day === doc.time_options[i]?.minute_of_day);
      if (same) return unchanged(doc);
      const base: EventDoc = { ...doc, seq: built.seq, time_options: built.options };
      if (doc.stage !== 'time_vote') return { ok: true, doc: bump(base, now, {}), effects: [], changed: true };
      // Saat oylaması sırasında değişirse oylar sıfırlanır ve süre yeniden başlar.
      const reset: EventDoc = { ...base, time_votes: {} };
      const next = bump(reset, now, { stage_deadline_at: voteDeadline(reset, 'time', now, doc.vote_window_ms) });
      return { ok: true, doc: next, effects: [{ type: 'stage', notice: 'time_vote', to: others(engaged(next), actor) }], changed: true };
    }

    case 'update': {
      const no = ownerOnly();
      if (no) return no;
      if (doc.stage !== 'rsvp') return fail('event_stage_mismatch', { stage: doc.stage });
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
        if (!isEventDateAllowed(action.date, now, ctx.offsetAt)) return fail('event_date_invalid');
        dateChanged = true;
        patch.date = action.date;
        patch.expires_at = endOfEventDate(action.date, ctx.offsetAt);
        // Tarih değişince Aşama 1 yeniden sorulur; saat seçenekleri yeni tarihe göre yeniden hesaplanır.
        patch.rsvp = {};
        const minutes = doc.time_options.map((o) => o.minute_of_day);
        const rebuilt = minutes.length ? buildTimeOptions({ date: action.date, seq: doc.seq }, minutes, ctx) : null;
        patch.time_options = rebuilt ? rebuilt.options : [];
        if (rebuilt) patch.seq = rebuilt.seq;
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
        rsvp: omit(doc.rsvp, action.uid),
        final_rsvp: omit(doc.final_rsvp, action.uid),
        venue_votes: omit(doc.venue_votes, action.uid),
        time_votes: omit(doc.time_votes, action.uid),
      });
      return maybeAutoClose({ ok: true, doc: next, effects: [], changed: true }, 'system', ctx);
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
      if (now >= doc.expires_at) {
        return { ok: true, doc: endEvent(doc, 'expired', now), effects: [{ type: 'reminders', items: [] }], changed: true };
      }
      if ((doc.stage === 'venue_vote' || doc.stage === 'time_vote') && doc.stage_deadline_at !== null && now >= doc.stage_deadline_at) {
        const kind: VoteKind = doc.stage === 'venue_vote' ? 'venue' : 'time';
        const winner = deadlineWinner(eventTally(doc, kind, now));
        if (!winner) return { ok: true, doc: endEvent(doc, 'expired', now), effects: [{ type: 'reminders', items: [] }], changed: true };
        return closeVote(doc, kind, winner, 'system', ctx);
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
  venue_options?: EventVenueInput[];
  time_minutes?: number[];
  vote_window_ms?: number;
}

/** Yeni etkinlik belgesi; doğrulama hatasında `EventResult` hatası. Davet bildirimi etkisi döner. */
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

  const names: Record<UserId, string> = {};
  for (const u of [ownerId, ...invitees]) names[u] = sanitizeEventLine(input.names[u] ?? '', 80) ?? '';

  let doc: EventDoc = {
    event_id: eventId,
    owner_id: ownerId,
    title,
    description,
    date: input.date,
    time_zone: input.time_zone,
    invitee_ids: invitees,
    member_ids: [ownerId, ...invitees],
    names,
    stage: 'rsvp',
    stage_deadline_at: null,
    vote_window_ms: windowMs,
    rsvp: {},
    final_rsvp: {},
    venue_options: [],
    venue_votes: {},
    venue_option_id: null,
    time_options: [],
    time_votes: {},
    time_option_id: null,
    starts_at: null,
    finalized_at: null,
    expires_at: endOfEventDate(input.date, ctx.offsetAt),
    end_reason: null,
    ended_at: null,
    seq: 0,
    created_at: ctx.now,
    updated_at: ctx.now,
    version: 0,
  };
  for (const v of input.venue_options ?? []) {
    const r = reduceEvent(doc, ownerId, { type: 'venue_propose', venue: v }, ctx);
    if (!r.ok) return r;
    doc = r.doc;
  }
  if (input.time_minutes && input.time_minutes.length) {
    const r = reduceEvent(doc, ownerId, { type: 'time_options_set', minutes: input.time_minutes }, ctx);
    if (!r.ok) return r;
    doc = r.doc;
  }
  doc = { ...doc, updated_at: ctx.now, version: 1 };
  return { ok: true, doc, effects: [{ type: 'invite', to: invitees }], changed: true };
}

/** Firestore'dan okunan belgeyi doğrular; bozuksa null. Bilinmeyen alanlar atılır. */
export function parseEventDoc(raw: unknown): EventDoc | null {
  const r = EventDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// --- görünüm yardımcıları --------------------------------------------------------------------------

export const EVENT_STAGE_TEXT: Record<EventStage, string> = {
  rsvp: 'Aşama 1 · Tarih ve katılım',
  venue_vote: 'Aşama 2 · Mekan oylaması',
  time_vote: 'Aşama 3 · Saat oylaması',
  final: 'Kesinleşti · Son onay',
  completed: 'Tamamlandı',
  cancelled: 'İptal edildi',
  expired: 'Süresi doldu',
};

/** Arayüzdeki 3 aşamalı ilerleme çubuğu: 1, 2, 3 (final = 3, tamamlandı = 4). */
export function eventStep(stage: EventStage): 1 | 2 | 3 | 4 {
  switch (stage) {
    case 'rsvp':
      return 1;
    case 'venue_vote':
      return 2;
    case 'time_vote':
    case 'final':
      return 3;
    default:
      return 4;
  }
}

export const ATTENDANCE_TEXT: Record<AttendanceStatus, string> = { going: 'Katılacağım', not_going: 'Katılamayacağım' };
export const ATTENDANCE_THIRD_PERSON: Record<AttendanceStatus | 'pending', string> = { going: 'Katılacak', not_going: 'Katılamayacak', pending: 'Yanıt bekleniyor' };

export const EVENT_TEXT = {
  screenTitle: 'Etkinlikler',
  create: 'Etkinlik oluştur',
  emptyTitle: 'Henüz etkinlik yok',
  emptyBody: 'Arkadaşlarını davet et; tarih, mekan ve saati birlikte oylayın.',
  notePlaceholder: 'İstersen nedenini yaz (en çok 300 karakter)',
  noteTitle: 'Katılamayacağını bildir',
  venueVoteNeeds: 'Mekan oylaması için 3 mekan seçeneği gerekli',
  openVenueVote: 'Mekan oylamasını başlat',
  closeVote: 'Oylamayı bitir',
  tieTitle: 'Oylar eşit: kazananı sen seç',
  needTimes: 'Saat seçeneklerini ekle',
  waitingTimes: 'Saat seçenekleri bekleniyor',
  finalQuestion: 'Buluşma kesinleşti. Katılıyor musun?',
  remindersNote: 'Buluşmadan 1 gün önce ve buluşma günü sabah 08:00\'de hatırlatılır.',
  cancel: 'Etkinliği iptal et',
  cancelConfirm: 'Etkinlik herkes için iptal edilecek. Emin misin?',
  notEligibleVote: 'Oy vermek için önce "Katılacağım" demelisin.',
  inviteNoPermissionHint: 'Yalnızca seni buluşmaya davet etmene izin veren arkadaşların listelenir.',
} as const;

/** Kartta özet: "Moda Kahve · 29 Kasım Cuma 10:00" ya da aşamaya göre. */
export function eventSummaryLine(doc: EventDoc): string {
  const venue = venueOf(doc);
  const time = timeOptionOf(doc);
  const day = formatEventDate(doc.date);
  if (time && venue) return `${venue.name} · ${day} ${formatMinuteOfDay(time.minute_of_day)}`;
  if (venue) return `${venue.name} · ${day}`;
  return day;
}

/** "3 katılacak · 1 katılamayacak · 2 yanıt bekleniyor" (aşamaya göre doğru tur). */
export function attendanceCounts(doc: EventDoc): { going: number; not_going: number; pending: number } {
  const map = doc.stage === 'final' || doc.stage === 'completed' ? doc.final_rsvp : doc.rsvp;
  let going = 1; // sahip
  let not_going = 0;
  let pending = 0;
  for (const u of doc.invitee_ids) {
    const s = map[u]?.status;
    if (s === 'going') going += 1;
    else if (s === 'not_going') not_going += 1;
    else pending += 1;
  }
  return { going, not_going, pending };
}

/** Benden beklenen eylem (liste rozeti): yanıt, oy ya da son onay; yoksa null. */
export type EventTodo = 'rsvp' | 'vote_venue' | 'vote_time' | 'final_rsvp' | 'add_times' | 'open_venue_vote' | null;

export function eventTodoFor(doc: EventDoc, me: UserId, now: EpochMs): EventTodo {
  const isOwner = me === doc.owner_id;
  switch (doc.stage) {
    case 'rsvp':
      if (isOwner) return doc.venue_options.length === EVENT_LIMITS.venueOptions && doc.invitee_ids.some((u) => doc.rsvp[u]?.status === 'going') ? 'open_venue_vote' : null;
      return doc.rsvp[me] ? null : 'rsvp';
    case 'venue_vote':
      if (!isOwner && !doc.rsvp[me]) return 'rsvp';
      return eventVoters(doc).includes(me) && !doc.venue_votes[me] ? 'vote_venue' : null;
    case 'time_vote':
      if (doc.stage_deadline_at === null) return isOwner ? 'add_times' : null;
      if (!isOwner && !doc.rsvp[me]) return 'rsvp';
      return eventVoters(doc).includes(me) && !doc.time_votes[me] ? 'vote_time' : null;
    case 'final':
      if (isOwner || (doc.starts_at !== null && now >= doc.starts_at)) return null;
      return doc.final_rsvp[me] ? null : 'final_rsvp';
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

/** Davet: "Etkinlik daveti" · "Ayşe seni “Kahvaltı” etkinliğine davet etti · 29 Kasım Cuma". */
export function eventInvitePushText(ownerName: string | null | undefined, doc: Pick<EventDoc, 'title' | 'date'>): { title: string; body: string } {
  return { title: 'Etkinlik daveti', body: `${nameOr(ownerName, 'Bir arkadaşın')} seni ${quote(doc.title)} etkinliğine davet etti · ${formatEventDate(doc.date)}` };
}

export function eventStagePushText(notice: EventStageNotice, doc: EventDoc): { title: string; body: string } {
  const venue = venueOf(doc);
  switch (notice) {
    case 'venue_vote':
      return { title: doc.title, body: 'Mekan oylaması başladı: 3 seçenekten birini seç' };
    case 'need_times':
      return { title: doc.title, body: `Mekan kesinleşti${venue ? `: ${venue.name}` : ''}. Saat seçeneklerini ekle` };
    case 'time_vote':
      return { title: doc.title, body: `${venue ? `Mekan: ${venue.name}. ` : ''}Saat oylaması başladı` };
    case 'final':
      return { title: `Kesinleşti: ${doc.title}`, body: `${eventSummaryLine(doc)} · Katılıyor musun?` };
    case 'date_changed':
      return { title: doc.title, body: `Tarih değişti: ${formatEventDate(doc.date)}. Katılımını yeniden bildir` };
  }
}

/** Sahibe: "Bora katılacak" · "Bora katılamayacak: “Ailemle olacağım”". */
export function eventRsvpPushText(byName: string | null | undefined, doc: Pick<EventDoc, 'title'>, status: AttendanceStatus, note: string | null): { title: string; body: string } {
  const n = nameOr(byName, 'Bir davetli');
  const body = status === 'going' ? `${n} katılacak` : note ? `${n} katılamayacak: ${quote(note)}` : `${n} katılamayacak`;
  return { title: doc.title, body };
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
const optionIdSchema = z.string().regex(/^[vt]\d{1,4}$/);
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
const voteWindow = z.number().int().refine((v) => EVENT_LIMITS.voteWindowsMs.includes(v), { message: 'geçersiz oylama süresi' });

export const EventCreateRequestSchema = z.object({
  op_id: opId,
  title: lineMax(EVENT_LIMITS.titleMaxChars).refine((s) => s.trim().length > 0),
  description: lineMax(EVENT_LIMITS.descriptionMaxChars).nullable().default(null),
  date: z.string().regex(DATE_RE),
  time_zone: z.string().min(1).max(64),
  invitee_ids: z.array(uid).min(1).max(EVENT_LIMITS.maxInvitees),
  venue_options: z.array(EventVenueInputSchema).max(EVENT_LIMITS.venueOptions).default([]),
  time_minutes: z.array(minuteOfDay).max(EVENT_LIMITS.maxTimeOptions).default([]),
  vote_window_ms: voteWindow.default(EVENT_LIMITS.defaultVoteWindowMs),
});
export type EventCreateRequest = z.input<typeof EventCreateRequestSchema>;

export const EventRsvpRequestSchema = z.object({
  op_id: opId,
  event_id: eventIdSchema,
  round: z.enum(RSVP_ROUNDS),
  status: z.enum(ATTENDANCE_STATUSES),
  note: z.string().max(EVENT_LIMITS.noteMaxChars * 4).nullable().default(null),
});
export type EventRsvpRequest = z.input<typeof EventRsvpRequestSchema>;

export const EventVenueProposeRequestSchema = z.object({ op_id: opId, event_id: eventIdSchema, venue: EventVenueInputSchema });
export type EventVenueProposeRequest = z.input<typeof EventVenueProposeRequestSchema>;

export const EventVenueRemoveRequestSchema = z.object({ op_id: opId, event_id: eventIdSchema, option_id: optionIdSchema });
export type EventVenueRemoveRequest = z.input<typeof EventVenueRemoveRequestSchema>;

export const EventVoteRequestSchema = z.object({ op_id: opId, event_id: eventIdSchema, kind: z.enum(VOTE_KINDS), option_id: optionIdSchema });
export type EventVoteRequest = z.input<typeof EventVoteRequestSchema>;

/** Sahibin aşama komutları. */
export const EVENT_ADVANCE_ACTIONS = ['open_venue_vote', 'close_venue_vote', 'close_time_vote'] as const;
export type EventAdvanceAction = (typeof EVENT_ADVANCE_ACTIONS)[number];

export const EventAdvanceRequestSchema = z.object({
  op_id: opId,
  event_id: eventIdSchema,
  action: z.enum(EVENT_ADVANCE_ACTIONS),
  /** Eşitlikte sahibin seçtiği kazanan (`event_vote_tie` yanıtındaki `leaders` içinden). */
  tie_break_option_id: optionIdSchema.nullable().default(null),
  /** Yalnızca `open_venue_vote`: oylama süresini değiştir. */
  vote_window_ms: voteWindow.nullable().default(null),
});
export type EventAdvanceRequest = z.input<typeof EventAdvanceRequestSchema>;

export const EventTimeOptionsSetRequestSchema = z.object({
  op_id: opId,
  event_id: eventIdSchema,
  minutes: z.array(minuteOfDay).min(EVENT_LIMITS.minTimeOptions).max(EVENT_LIMITS.maxTimeOptions),
});
export type EventTimeOptionsSetRequest = z.input<typeof EventTimeOptionsSetRequestSchema>;

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

const AnswerZ = z.object({ status: z.enum(ATTENDANCE_STATUSES), note: z.string().nullable(), at: z.number() });
const VenueZ = z.object({
  option_id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  location: LatLngZ.nullable(),
  place_id: z.string().nullable(),
  proposed_by: z.string(),
  proposed_at: z.number(),
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
  stage_deadline_at: z.number().nullable(),
  vote_window_ms: z.number(),
  rsvp: z.record(z.string(), AnswerZ),
  final_rsvp: z.record(z.string(), AnswerZ),
  venue_options: z.array(VenueZ),
  venue_votes: z.record(z.string(), z.string()),
  venue_option_id: z.string().nullable(),
  time_options: z.array(TimeZ),
  time_votes: z.record(z.string(), z.string()),
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
