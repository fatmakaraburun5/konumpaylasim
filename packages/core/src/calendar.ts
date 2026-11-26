/**
 * Faz 10: Ortak takvim entegrasyonu (bkz. docs/PHASE10.md §1).
 *
 * Faz 7 etkinliği `final` olduğunda (mekan + saat kesin) etkinlik kartında "Takvime Ekle" etkinleşir. Bu modül
 * platformdan bağımsız TAKVİM KAYDINI (`CalendarEntry`) üretir; mobil adaptörler onu yerel takvime yazar:
 *   - iOS: EventKit (expo-calendar), iOS 17+ YALNIZCA EKLEME izniyle (`NSCalendarsWriteOnlyAccessUsageDescription`).
 *     Tam erişim (`NSCalendarsFullAccessUsageDescription`) yalnızca kullanıcı "Takvimdeki kaydı güncel tut"u açarsa
 *     istenir (iptal / saat değişikliğinde kaydı güncellemek ya da silmek için okumak gerekir).
 *   - Android: CalendarContract (expo-calendar), `WRITE_CALENDAR` + `READ_CALENDAR` (yazılabilir birincil takvimi
 *     bulmak için okuma gerekir; Google Takvim hesabı varsa birincil takvim odur).
 *   - İzin yoksa / reddedildiyse: sistemin "Etkinlik ekle" formu (izin istemez) ya da Google Takvim şablon bağlantısı
 *     (`googleCalendarUrl`) / `.ics` (`icsFromEntry`) yedeği.
 *
 * Gizlilik: takvim OKUNMAZ, takvim verisi sunucuya GİTMEZ; kayıt yalnızca bu cihazdaki takvime yazılır. Cihazda yalnızca
 * `event_id → yerel kayıt kimliği + parmak izi` eşlemesi tutulur (değişiklik / iptal algılama).
 * Hepsi saf fonksiyondur: mobil, tarayıcı demosu ve testler aynı kaydı üretir.
 */
import type { LatLng } from './geo';
import { sha256Hex } from './link';
import type { UserId } from './model';
import { HOUR, MINUTE, type EpochMs } from './time';
import { attendanceOf, type EventDoc, formatEventDate, formatMinuteOfDay, timeOptionOf, venueOf } from './events';

export const CALENDAR_LIMITS = {
  /** Faz 7 etkinliğinde bitiş saati yok: takvim kaydı başlangıç + 2 sa. [Varsayım] */
  defaultDurationMs: 2 * HOUR,
  /** Takvim kaydına eklenen hatırlatıcı (dk önce). 45 dk = "Kim ne kadar uzakta?" şeridinin açıldığı an. */
  alarmMinutesBefore: [60, 45] as readonly number[],
  /** Notlarda gösterilen en çok katılımcı adı. */
  notesMaxNames: 8,
  titleMaxChars: 120,
} as const;

/** Takvim kaydı başlığının öneki yok; uygulama adı notlarda ve URL'de. */
export const CALENDAR_APP_URL_BASE = 'konum://events/';

export interface CalendarVenue {
  name: string;
  address: string | null;
  location: LatLng | null;
  place_id: string | null;
}

/** Platformdan bağımsız takvim kaydı (EventKit / CalendarContract / ICS / Google şablonu aynı veriden). */
export interface CalendarEntry {
  event_id: string;
  /** ICS UID ve yerel kayıtta eşleme anahtarı. */
  uid: string;
  title: string;
  starts_at: EpochMs;
  ends_at: EpochMs;
  /** IANA (etkinliği oluşturanın). */
  time_zone: string;
  /** Takvimin "Konum" alanı: "Mekan, açık adres". */
  location: string;
  venue: CalendarVenue;
  /** Google Haritalar bağlantısı (koordinat + varsa place_id); konum yoksa ada göre arama. */
  maps_url: string;
  /** Uygulamada etkinliği açan bağlantı. */
  app_url: string;
  /** Çok satırlı açıklama: açıklama, katılımcı özeti, harita ve uygulama bağlantıları. */
  notes: string;
  alarms_min_before: number[];
  attendees: { going: string[]; not_going: string[]; pending: string[] };
  /** Kayıt içeriğinin özeti: değişince takvimdeki kaydın güncellenmesi önerilir. */
  fingerprint: string;
}

export type CalendarEntryResult =
  | { ok: true; entry: CalendarEntry }
  | { ok: false; reason: 'not_final' | 'not_member' | 'not_going' | 'no_time' | 'started' };

const roundCoord = (n: number): string => n.toFixed(6);

/** Google Haritalar evrensel bağlantısı (iOS / Android / web'de Haritalar uygulamasını açar). */
export function mapsUrlForVenue(v: Pick<CalendarVenue, 'name' | 'address' | 'location' | 'place_id'>): string {
  const q = v.location ? `${roundCoord(v.location.lat)},${roundCoord(v.location.lng)}` : [v.name, v.address].filter(Boolean).join(', ');
  let url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  if (v.place_id) url += `&query_place_id=${encodeURIComponent(v.place_id)}`;
  return url;
}

function nameOf(doc: Pick<EventDoc, 'names'>, uid: UserId, me: UserId): string {
  if (uid === me) return 'Sen';
  return (doc.names[uid] ?? 'Davetli').trim() || 'Davetli';
}

function listNames(names: string[]): string {
  if (names.length <= CALENDAR_LIMITS.notesMaxNames) return names.join(', ');
  return `${names.slice(0, CALENDAR_LIMITS.notesMaxNames).join(', ')} +${names.length - CALENDAR_LIMITS.notesMaxNames}`;
}

/** Katılımcı özeti (sahip her zaman katılır). */
export function calendarAttendees(doc: EventDoc, me: UserId): CalendarEntry['attendees'] {
  const going: string[] = [];
  const notGoing: string[] = [];
  const pending: string[] = [];
  for (const u of [doc.owner_id, ...doc.invitee_ids]) {
    const st = attendanceOf(doc, u);
    const n = nameOf(doc, u, me);
    if (st === 'going') going.push(n);
    else if (st === 'not_going') notGoing.push(n);
    else pending.push(n);
  }
  return { going, not_going: notGoing, pending };
}

/** "Takvime Ekle" etkin mi: yalnızca `final`, başlamamış, üye ve "Katılamayacağım" dememiş. */
export function calendarEntryFromEvent(doc: EventDoc, me: UserId, now: EpochMs): CalendarEntryResult {
  if (doc.stage !== 'final') return { ok: false, reason: 'not_final' };
  if (!doc.member_ids.includes(me)) return { ok: false, reason: 'not_member' };
  if (attendanceOf(doc, me) === 'not_going') return { ok: false, reason: 'not_going' };
  const time = timeOptionOf(doc);
  const startsAt = doc.starts_at ?? time?.starts_at ?? null;
  if (startsAt === null) return { ok: false, reason: 'no_time' };
  if (now >= startsAt) return { ok: false, reason: 'started' };
  const v = venueOf(doc);
  const venue: CalendarVenue = {
    name: v?.name ?? 'Buluşma noktası',
    address: v?.address ?? null,
    location: v?.location ?? null,
    place_id: v?.place_id ?? null,
  };
  const maps_url = mapsUrlForVenue(venue);
  const app_url = `${CALENDAR_APP_URL_BASE}${encodeURIComponent(doc.event_id)}`;
  const attendees = calendarAttendees(doc, me);
  const owner = nameOf(doc, doc.owner_id, me);
  const lines: string[] = [];
  if (doc.description) lines.push(doc.description, '');
  lines.push(`Düzenleyen: ${owner}`);
  lines.push(`Katılacak (${attendees.going.length}): ${listNames(attendees.going)}`);
  if (attendees.not_going.length) lines.push(`Katılamayacak (${attendees.not_going.length}): ${listNames(attendees.not_going)}`);
  if (attendees.pending.length) lines.push(`Yanıt bekleniyor (${attendees.pending.length}): ${listNames(attendees.pending)}`);
  lines.push('');
  lines.push(`Mekan: ${[venue.name, venue.address].filter(Boolean).join(', ')}`);
  if (venue.location) lines.push(`Koordinat: ${roundCoord(venue.location.lat)}, ${roundCoord(venue.location.lng)}`);
  lines.push(`Harita: ${maps_url}`);
  lines.push(`Konum uygulamasında aç: ${app_url}`);
  lines.push('', 'Buluşmaya 45 dk kala uygulamada "Kim ne kadar uzakta?" şeridi açılır.');
  const base = {
    event_id: doc.event_id,
    uid: `${doc.event_id}@konum.app`,
    title: doc.title.slice(0, CALENDAR_LIMITS.titleMaxChars),
    starts_at: startsAt,
    ends_at: startsAt + CALENDAR_LIMITS.defaultDurationMs,
    time_zone: doc.time_zone,
    location: [venue.name, venue.address].filter(Boolean).join(', '),
    venue,
    maps_url,
    app_url,
    notes: lines.join('\n'),
    alarms_min_before: [...CALENDAR_LIMITS.alarmMinutesBefore],
    attendees,
  };
  return { ok: true, entry: { ...base, fingerprint: calendarFingerprint(base) } };
}

/** Değişince takvim kaydı güncellenmeli: başlık, saat, mekan, katılımcılar. */
export function calendarFingerprint(e: Pick<CalendarEntry, 'title' | 'starts_at' | 'ends_at' | 'location' | 'venue' | 'attendees'>): string {
  const canon = JSON.stringify([e.title, e.starts_at, e.ends_at, e.location, e.venue.location?.lat ?? null, e.venue.location?.lng ?? null, e.attendees.going.length, e.attendees.not_going.length]);
  return sha256Hex(canon).slice(0, 16);
}

/** expo-calendar `createEvent` / `addEventWithForm` alanları (Date nesneleri mobil adaptörde üretilir). */
export function nativeCalendarFields(e: CalendarEntry): {
  title: string;
  startDate: EpochMs;
  endDate: EpochMs;
  timeZone: string;
  location: string;
  notes: string;
  url: string;
  alarms: { relativeOffset: number }[];
} {
  return {
    title: e.title,
    startDate: e.starts_at,
    endDate: e.ends_at,
    timeZone: e.time_zone,
    location: e.location,
    notes: e.notes,
    url: e.maps_url,
    alarms: e.alarms_min_before.map((m) => ({ relativeOffset: -m })),
  };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** UTC `YYYYMMDDTHHMMSSZ` (ICS ve Google şablonu). */
export function icsUtc(at: EpochMs): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Google Takvim "etkinlik oluştur" şablonu (Android'de Google Takvim intent'i / web yedeği). */
export function googleCalendarUrl(e: CalendarEntry): string {
  const p: [string, string][] = [
    ['action', 'TEMPLATE'],
    ['text', e.title],
    ['dates', `${icsUtc(e.starts_at)}/${icsUtc(e.ends_at)}`],
    ['details', e.notes],
    ['location', e.location],
    ['ctz', e.time_zone],
  ];
  return `https://calendar.google.com/calendar/render?${p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** RFC 5545 metin kaçışı. */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function utf8Len(t: string): number {
  let n = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** RFC 5545 satır katlama: 75 sekizli, devam satırı boşlukla başlar (UTF-8 karakter bölünmez). */
export function icsFold(line: string): string {
  const enc = { encode: (t: string) => ({ length: utf8Len(t) }) };
  if (utf8Len(line) <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (curLen + len > limit) {
      out.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n');
}

/** Tek etkinlikli `.ics` (VEVENT + GEO + VALARM). `dtstamp` çağıranın saati. */
export function icsFromEntry(e: CalendarEntry, dtstamp: EpochMs): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Konum//Etkinlik//TR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsUtc(dtstamp)}`,
    `DTSTART:${icsUtc(e.starts_at)}`,
    `DTEND:${icsUtc(e.ends_at)}`,
    `SUMMARY:${icsEscape(e.title)}`,
    `LOCATION:${icsEscape(e.location)}`,
    `DESCRIPTION:${icsEscape(e.notes)}`,
    `URL:${e.maps_url}`,
  ];
  if (e.venue.location) lines.push(`GEO:${roundCoord(e.venue.location.lat)};${roundCoord(e.venue.location.lng)}`);
  for (const m of e.alarms_min_before) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(e.title)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// --- izin ve ekleme planı ---------------------------------------------------------------------

/**
 * Takvim izni durumu: iOS 17+'da `write_only` (yalnızca ekleme) ya da `full`; Android'de `granted` = okuma + yazma.
 * `unavailable`: modül / takvim yok (web, simülatör).
 */
export const CALENDAR_PERM_STATES = ['undetermined', 'write_only', 'full', 'granted', 'denied', 'restricted', 'unavailable'] as const;
export type CalendarPermState = (typeof CALENDAR_PERM_STATES)[number];
export type CalendarPlatform = 'ios' | 'android' | 'web';

export const calendarCanWrite = (s: CalendarPermState): boolean => s === 'write_only' || s === 'full' || s === 'granted';
/** Daha önce eklenen kaydı bulup güncelleyebilir / silebilir mi (iOS yalnızca-ekleme izni okuyamaz). */
export const calendarCanUpdate = (s: CalendarPermState): boolean => s === 'full' || s === 'granted';

/**
 * "Takvime Ekle" dokunuşunun adımı:
 *  - `consent`: uygulama içi resmi onay sayfası (ne yazılacak, takvimin okunmayacağı) → onaylarsa sistem istemi.
 *  - `write`: doğrudan yaz (izin var).
 *  - `system_form`: izin reddedildi / kısıtlı → sistemin "Etkinlik ekle" formu (izin gerektirmez) ya da Google
 *    Takvim şablonu; ayrıca "Ayarları aç" önerilir.
 *  - `fallback_link`: takvim modülü yok (web) → Google Takvim bağlantısı / .ics.
 */
export type CalendarAddStep = 'consent' | 'write' | 'system_form' | 'fallback_link';

export function calendarAddStep(platform: CalendarPlatform, state: CalendarPermState, consentGiven: boolean): CalendarAddStep {
  if (state === 'unavailable' || platform === 'web') return calendarCanWrite(state) ? 'write' : 'fallback_link';
  if (calendarCanWrite(state)) return 'write';
  if (state === 'undetermined') return consentGiven ? 'write' : 'consent';
  return 'system_form';
}

/** Takvimdeki kaydın etkinlik değişince ne olacağı. */
export type CalendarSyncAction = 'none' | 'update' | 'remove' | 'offer_update';

export function calendarSyncAction(
  stored: { fingerprint: string } | null,
  current: CalendarEntryResult,
  state: CalendarPermState,
  eventStage: EventDoc['stage'],
): CalendarSyncAction {
  if (!stored) return 'none';
  if (eventStage === 'cancelled' || (!current.ok && current.reason === 'not_going')) {
    return calendarCanUpdate(state) ? 'remove' : 'offer_update';
  }
  if (!current.ok) return 'none';
  if (current.entry.fingerprint === stored.fingerprint) return 'none';
  return calendarCanUpdate(state) ? 'update' : 'offer_update';
}

/** Cihazdaki eşleme kaydı (`konum.f10.calendar.v1`, kullanıcı başına). */
export interface CalendarLink {
  event_id: string;
  native_id: string | null;
  calendar_id: string | null;
  fingerprint: string;
  method: 'native' | 'system_form' | 'google_link' | 'ics';
  added_at: EpochMs;
}

export const CALENDAR_STORAGE_KEY = 'konum.f10.calendar.v1';

export const CALENDAR_TEXT = {
  add: 'Takvime Ekle',
  added: 'Takvimde ✓',
  update: 'Takvimdeki kaydı güncelle',
  consentTitle: 'Etkinliği takvimine ekle',
  consentBody:
    'Konum, yalnızca bu kesinleşen buluşmayı (başlık, başlangıç–bitiş saati, mekan adı ve adresi, harita bağlantısı, katılımcı özeti) telefonunun takvimine yazar. Takvimin okunmaz ve sunucuya gönderilmez.',
  consentIos: 'iPhone\'da yalnızca “ekleme” izni istenir: uygulama takvimindeki diğer etkinlikleri göremez.',
  consentAndroid: 'Android\'de yazılabilir takvimi (ör. Google Takvim hesabın) bulmak için takvim okuma + yazma izni istenir; etkinliklerin okunmaz, kaydedilmez.',
  consentAccept: 'Onaylıyorum, takvime ekle',
  consentLater: 'Şimdi değil',
  deniedTitle: 'Takvim izni kapalı',
  deniedBody: 'İzin vermeden de ekleyebilirsin: sistemin “Etkinlik ekle” ekranı açılır, kaydet’e basman yeterli.',
  openForm: 'Takvim ekranında ekle',
  openSettings: 'Ayarları aç',
  googleLink: 'Google Takvim’de aç',
  done: (title: string) => `“${title}” takvime eklendi`,
  removedHint: 'Etkinlik iptal edildi. Takvimindeki kaydı silmeyi unutma.',
  changedHint: 'Etkinlik değişti. Takvimdeki kaydı güncelle.',
} as const;

/** Kart satırı: "Cumartesi 29 Kasım · 19:00–21:00". */
export function calendarWhenLine(doc: EventDoc, e: CalendarEntry): string {
  const startLocal = timeOptionOf(doc)?.minute_of_day ?? null;
  const durMin = Math.round((e.ends_at - e.starts_at) / MINUTE);
  if (startLocal === null) return formatEventDate(doc.date);
  return `${formatEventDate(doc.date)} · ${formatMinuteOfDay(startLocal)}–${formatMinuteOfDay((startLocal + durMin) % (24 * 60))}`;
}
