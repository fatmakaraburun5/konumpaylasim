/**
 * Faz 5 buluşma noktası arayüzünün saf mantığı (React / depo bağımlılığı yok).
 *
 *  - Katılımcı noktaları ve varsayılan ulaşım modu (meetupStore ile aynı kural: yayılım ≤ 2 km → Yürüyüş).
 *  - Sonuç satırları: ad, adres, `formatMeetupEtas` ("Ayşe 12 dk · Sen ~9 dk"), `formatFromCenter`.
 *  - Yedek durum metinleri, yanıt satırları ("Ayşe: Geliyorum"), yol tarifi bağlantısı, buluşma saati seçenekleri.
 */
import {
  formatClock,
  formatFromCenter,
  formatMeetupEtas,
  MEETUP_CATEGORY_EMOJI,
  MEETUP_LIMITS,
  meetupCenter,
  meetupSpreadM,
  type EpochMs,
  type LatLng,
  type Meetup,
  type MeetupPlace,
  type MeetupSuggestResponse,
  type OffsetFn,
  type TravelMode,
  type UserId,
} from '@konum/core';

/** meetupStore `WALK_DEFAULT_MAX_SPREAD_M` ile aynı. [Varsayım] */
export const MEETUP_WALK_MAX_SPREAD_M = 2_000;

export type ParticipantKey = 'me' | UserId;

export interface ParticipantPoint {
  key: ParticipantKey;
  position: LatLng;
}

/** Katılımcı konumları (depo `suggest` ile aynı sıra): ben + konumu görünen / hedefi seçilen arkadaşlar. */
export function participantPoints(
  friendIds: readonly UserId[],
  myPosition: LatLng | null,
  friendPositions: Record<UserId, LatLng>,
  overrides: Partial<Record<string, LatLng>> = {},
): { points: ParticipantPoint[]; missing: UserId[] } {
  const points: ParticipantPoint[] = [];
  const missing: UserId[] = [];
  const mine = overrides.me ?? myPosition;
  if (mine) points.push({ key: 'me', position: mine });
  for (const f of friendIds) {
    const p = overrides[f] ?? friendPositions[f];
    if (p) points.push({ key: f, position: p });
    else missing.push(f);
  }
  return { points: points.slice(0, MEETUP_LIMITS.maxParticipants), missing };
}

export function defaultMeetupMode(points: readonly LatLng[]): TravelMode {
  if (points.length < 2) return 'DRIVE';
  const c = meetupCenter(points);
  return meetupSpreadM(c, points) <= MEETUP_WALK_MAX_SPREAD_M ? 'WALK' : 'DRIVE';
}

/** Arkadaş seçimi: en çok `maxParticipants − 1` arkadaş (ben de katılımcıyım). */
export function toggleMeetupFriend(list: readonly UserId[], uid: UserId): { next: UserId[]; error: string | null } {
  if (list.includes(uid)) return { next: list.filter((u) => u !== uid), error: null };
  const max = MEETUP_LIMITS.maxParticipants - 1;
  if (list.length >= max) return { next: [...list], error: `En çok ${max} arkadaşla buluşma noktası arayabilirsin.` };
  return { next: [...list, uid], error: null };
}

// --- sonuçlar --------------------------------------------------------------------------------------

export const MEETUP_FALLBACK_TEXT: Record<NonNullable<MeetupSuggestResponse['fallback']>, string> = {
  too_close: 'Zaten birbirinize çok yakınsınız',
  places_unavailable: 'Yalnızca orta nokta gösteriliyor',
  quota_exceeded: 'Yalnızca orta nokta gösteriliyor',
  no_results: 'Yakında uygun yer bulunamadı; orta nokta gösteriliyor',
  too_far: 'Birbirinize çok uzaksınız; buluşma noktası önerilemiyor',
};

export const meetupPlaceEmoji = (p: Pick<MeetupPlace, 'category'>): string => (p.category === 'midpoint' ? '🎯' : MEETUP_CATEGORY_EMOJI[p.category]);

export interface SuggestionRow {
  index: number;
  /** Haritadaki pin numarası (1'den). */
  number: number;
  title: string;
  address: string | null;
  /** "Ayşe 12 dk · Sen ~9 dk" (tahminiyse "~"). */
  etas: string;
  fromCenter: string;
  estimated: boolean;
  emoji: string;
}

export function suggestionRows(result: MeetupSuggestResponse | null, names: Record<string, string>): SuggestionRow[] {
  if (!result) return [];
  return result.suggestions.map((s, i) => ({
    index: i,
    number: i + 1,
    title: s.place.name,
    address: s.place.address,
    etas: formatMeetupEtas(s.etas, names),
    fromCenter: formatFromCenter(result.center, s.place.location),
    estimated: s.etas.some((e) => e.estimated),
    emoji: meetupPlaceEmoji(s.place),
  }));
}

/** Haritadaki buluşma katmanı (native `MeetupMapLayer.tsx` ve web kardeşi aynı veriyi çizer). */
export interface MeetupMapOverlay {
  /** Numaralı öneri pinleri (1-3). */
  suggestions: readonly { place: MeetupPlace }[];
  /** Orta nokta işareti. */
  center: LatLng | null;
  selectedIndex: number | null;
  /** Seçili öneriye kesikli çizgi çekilecek katılımcılar. */
  participants: readonly ParticipantPoint[];
  /** Paylaşılmış öneri (alıcı / gönderen kartı): tek pin. */
  focused: MeetupPlace | null;
}

/** Orta nokta işareti yalnızca önerilerden biri zaten "Orta nokta" değilse çizilir. */
export const showsCenterMark = (o: Pick<MeetupMapOverlay, 'center' | 'suggestions'>): boolean =>
  o.center !== null && !o.suggestions.some((s) => s.place.category === 'midpoint');

/** Google Haritalar yol tarifi (uygulama kuruluysa uygulamada açılır). */
export const directionsUrl = (p: LatLng): string => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

// --- paylaşılan öneri -------------------------------------------------------------------------------

export const MEETUP_RESPONSE_TEXT: Record<'accepted' | 'declined', string> = { accepted: 'Geliyorum', declined: 'Uyamam' };

export interface ResponseRow {
  uid: UserId;
  name: string;
  response: 'accepted' | 'declined' | null;
  /** "Ayşe: Geliyorum" / "Ayşe: Yanıt bekleniyor" */
  text: string;
}

export function responseRows(m: Pick<Meetup, 'to' | 'responses'>, names: Record<string, string>): ResponseRow[] {
  return m.to.map((uid) => {
    const name = names[uid] ?? 'Arkadaşın';
    const response = m.responses[uid] ?? null;
    return { uid, name, response, text: `${name}: ${response ? MEETUP_RESPONSE_TEXT[response] : 'Yanıt bekleniyor'}` };
  });
}

/** Paylaşım anındaki ETA'lar; benim uid'im "Sen" olur. */
export const meetupEtaLine = (m: Pick<Meetup, 'etas'>, names: Record<string, string>, myUid: UserId | null): string =>
  formatMeetupEtas(m.etas, names, myUid);

export interface MeetAtOption {
  id: string;
  label: string;
  at: EpochMs | null;
}

/** Buluşma saati: yok / 30 dk / 1 saat / 2 saat sonra (5 dk'ya yuvarlanır). [Varsayım] */
export function meetAtOptions(now: EpochMs, offsetAt?: OffsetFn): MeetAtOption[] {
  const round = (t: EpochMs) => Math.ceil(t / 300_000) * 300_000;
  const opt = (id: string, mins: number, label: string): MeetAtOption => {
    const at = round(now + mins * 60_000);
    return { id, label: `${label} · ${formatClock(at, offsetAt)}`, at };
  };
  return [{ id: 'none', label: 'Saat yok', at: null }, opt('m30', 30, '30 dk sonra'), opt('h1', 60, '1 saat sonra'), opt('h2', 120, '2 saat sonra')];
}
