/**
 * Faz 10: Etkinlik içi "Kim ne kadar uzakta?" sıralama şeridi (bkz. docs/PHASE10.md §2).
 *
 * Kesinleşmiş (`final`) buluşmanın başlangıcına 45 dk kala, etkinlik kartında ve haritanın üstünde TEK bir kompakt
 * yatay şerit açılır: "Ayşe · 6 dk", "Mehmet · 14 dk", "Zeynep · 22 dk" (en yakından en uzağa; cinsiyet renkli
 * çerçeveli avatar). Buluşma tamamlanınca (başlangıç + 30 dk ya da herkes vardıktan sonra ya da etkinlik `final`
 * olmaktan çıkınca) şerit kendiliğinden kapanır.
 *
 * Gizlilik filtresi (iki koşul birden):
 *   1. Kişi o etkinliğe "Katılacağım" demiş olmalı (sahip her zaman katılır).
 *   2. Kişinin konumu izleyene ŞU AN canlı olarak geliyor olmalı (Faz 8 `location_view` izniyle başlamış etkin paylaşım:
 *      izleyenin gelen kutusunda, süresi dolmamış, "çevrimdışı olabilir" / "eski" değil) ve kişi görünmez değil.
 *      Böylece şerit HİÇBİR yeni veri yolu açmaz: yalnızca izleyenin zaten gördüğü konumlardan türetilir. Konumu
 *      gelmeyen katılımcı yalnızca sayı olarak görünür ("+2 kişi konum paylaşmıyor"); katılım bilgisi zaten kartta.
 *
 * ETA: `EtaEstimator` arayüzü (mobilde sağlayıcı adaptörü). Varsayılan yerel adaptör kuş uçuşu × 1,35 / hareket
 * türüne göre hız (Faz 5 `fallbackEta`); kişi Faz 9'da hedefini bu mekana koyduysa paketindeki `dest_state`
 * (`near` → `dest_eta`, `arrived` → vardı) önceliklidir. Google Routes Matrix adaptörü canlı kurulumda bağlanır
 * (sunucu vekili, kota), arayüz aynı kalır.
 */
import { haversineM, type LatLng } from './geo';
import { attendanceOf, type EventDoc, venueOf } from './events';
import { fallbackEta } from './meetup';
import type { TravelMode } from './mapsPolicy';
import type { UserId } from './model';
import type { Gender } from './profile';
import { MINUTE, type EpochMs } from './time';

export const ETA_BOARD_LIMITS = {
  /** Şerit başlangıçtan bu kadar önce açılır. */
  openBeforeMs: 45 * MINUTE,
  /** Başlangıçtan bu kadar sonra kesin kapanır (buluşma tamamlandı). [Varsayım] */
  closeAfterStartMs: 30 * MINUTE,
  /** Mekana bu kadar yakın = vardı. [Varsayım] (Faz 9 nokta varış yarıçapı 75 m + GPS payı) */
  arrivedRadiusM: 100,
  /** Bundan eski konum şeritte "eski" işaretlenir (sona dizilir). */
  staleAfterMs: 10 * MINUTE,
  /** Bundan eski konum hiç kullanılmaz (şeritte yer almaz). [Varsayım] */
  dropAfterMs: 30 * MINUTE,
  /** Doğruluğu bundan kötü konum ETA'ya dahil edilmez. */
  maxAccuracyM: 500,
  /** Şeritte en çok gösterilen kişi (fazlası "+N"). */
  maxShown: 8,
  /** ETA üst sınırı (gösterim "2 sa+"). */
  maxEtaMin: 240,
} as const;

export type EtaBoardState = 'hidden' | 'open' | 'closed';

export interface EtaBoardWindow {
  state: EtaBoardState;
  opens_at: EpochMs | null;
  closes_at: EpochMs | null;
}

/** Şerit penceresi (yalnızca zamana göre; "herkes vardı" kapanışı `buildEtaBoard`'da). */
export function etaBoardWindow(doc: Pick<EventDoc, 'stage' | 'starts_at' | 'venue_options' | 'venue_option_id'>, now: EpochMs): EtaBoardWindow {
  if (doc.starts_at === null) return { state: 'hidden', opens_at: null, closes_at: null };
  const opens_at = doc.starts_at - ETA_BOARD_LIMITS.openBeforeMs;
  const closes_at = doc.starts_at + ETA_BOARD_LIMITS.closeAfterStartMs;
  const venue = venueOf(doc);
  if (doc.stage !== 'final' || !venue?.location) {
    return { state: now >= opens_at ? 'closed' : 'hidden', opens_at, closes_at };
  }
  if (now < opens_at) return { state: 'hidden', opens_at, closes_at };
  if (now >= closes_at) return { state: 'closed', opens_at, closes_at };
  return { state: 'open', opens_at, closes_at };
}

/** Şerit adayları: sahip + "Katılacağım" diyen davetliler (davet sırası). */
export function etaBoardParticipants(doc: Pick<EventDoc, 'owner_id' | 'invitee_ids' | 'answers'>): UserId[] {
  return [doc.owner_id, ...doc.invitee_ids].filter((u) => attendanceOf(doc, u) === 'going');
}

/** Bir katılımcının izleyenin elindeki son konumu (izleyenin gelen kutusundan ya da kendi konumu). */
export interface EtaBoardPoint {
  uid: UserId;
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: EpochMs;
  speed_mps?: number | null;
  activity_state?: 'still' | 'walking' | 'running' | 'cycling' | 'automotive' | 'unknown' | null;
  /** Faz 9 hedef alanları (kişi hedefini bu mekana koyduysa). */
  dest_name?: string | null;
  dest_state?: 'en_route' | 'near' | 'arrived' | null;
  dest_eta?: number | null;
  /** Alıcı tarafı durum (Faz 3 `receiverStatusOf`): `offline_suspected` / `stale` olan konum kullanılmaz. */
  receiver_status?: 'live' | 'recent' | 'delayed' | 'offline_suspected' | 'stale' | null;
}

export interface EtaEstimate {
  eta_min: number;
  distance_m: number;
  source: 'packet' | 'heuristic' | 'routes';
}

/** ETA sağlayıcı arayüzü: yerel (kuş uçuşu) adaptör şimdi, Google Routes Matrix canlı kurulumda. */
export interface EtaEstimator {
  readonly id: 'heuristic' | 'routes';
  estimate(points: readonly EtaBoardPoint[], venue: LatLng, now: EpochMs): Promise<Map<UserId, EtaEstimate>> | Map<UserId, EtaEstimate>;
}

/** Hareket türünden ulaşım kipi (paket `activity_state`, hız). [Varsayım] */
export function travelModeOf(p: Pick<EtaBoardPoint, 'activity_state' | 'speed_mps'>, distanceM: number): TravelMode {
  if (p.activity_state === 'automotive') return 'DRIVE';
  if (p.activity_state === 'cycling') return 'BICYCLE';
  if (typeof p.speed_mps === 'number' && p.speed_mps > 7) return 'DRIVE';
  if ((p.activity_state === 'still' || p.activity_state === 'unknown' || !p.activity_state) && distanceM > 3_000) return 'DRIVE';
  return 'WALK';
}

const sameName = (a: string | null | undefined, b: string): boolean =>
  !!a && a.trim().toLocaleLowerCase('tr-TR') === b.trim().slice(0, 30).toLocaleLowerCase('tr-TR');

/** Yerel ETA (sağlayıcısız): paket hedefi bu mekansa onu, değilse kuş uçuşu tahmini. */
export function heuristicEta(p: EtaBoardPoint, venue: LatLng, venueName: string | null): EtaEstimate {
  const d = haversineM(p, venue);
  if (venueName && sameName(p.dest_name, venueName)) {
    if (p.dest_state === 'arrived') return { eta_min: 0, distance_m: Math.round(d), source: 'packet' };
    if (p.dest_state === 'near' && typeof p.dest_eta === 'number') return { eta_min: Math.max(1, p.dest_eta), distance_m: Math.round(d), source: 'packet' };
  }
  if (d <= ETA_BOARD_LIMITS.arrivedRadiusM) return { eta_min: 0, distance_m: Math.round(d), source: 'heuristic' };
  const f = fallbackEta(p, venue, travelModeOf(p, d));
  return { eta_min: Math.min(ETA_BOARD_LIMITS.maxEtaMin, Math.max(1, Math.ceil(f.duration_s / 60))), distance_m: f.distance_m, source: 'heuristic' };
}

/** Varsayılan yerel adaptör. */
export const heuristicEtaEstimator = (venueName: string | null): EtaEstimator => ({
  id: 'heuristic',
  estimate(points, venue) {
    const m = new Map<UserId, EtaEstimate>();
    for (const p of points) m.set(p.uid, heuristicEta(p, venue, venueName));
    return m;
  },
});

export interface EtaBoardEntry {
  uid: UserId;
  name: string;
  gender: Gender | 'unknown';
  is_me: boolean;
  status: 'arrived' | 'en_route' | 'stale';
  eta_min: number | null;
  distance_m: number | null;
  /** "Ayşe · 6 dk", "Ayşe · Vardı", "Mehmet · ~14 dk" (eski konum). */
  label: string;
  /** Erişilebilirlik: "Ayşe, mekana yaklaşık 6 dakika". */
  a11y: string;
  updated_at: EpochMs;
}

export interface EtaBoard {
  state: EtaBoardState;
  event_id: string;
  venue_name: string;
  starts_at: EpochMs | null;
  closes_at: EpochMs | null;
  entries: EtaBoardEntry[];
  /** "Katılacağım" deyip konumu izleyene gelmeyenler (yalnızca sayı). */
  hidden_count: number;
  /** Gösterilmeyen fazla kişi ("+N"). */
  overflow: number;
  /** "Buluşmaya 32 dk" / "Buluşma başladı". */
  headline: string;
}

export interface EtaBoardInput {
  doc: EventDoc;
  viewer: UserId;
  now: EpochMs;
  /** İzleyenin elindeki konumlar: arkadaşların CANLI paylaşımları + (izleyen katılıyorsa) kendi konumu. */
  points: readonly EtaBoardPoint[];
  /** Sağlayıcıdan gelen ETA'lar; yoksa yerel tahmin. */
  etas?: ReadonlyMap<UserId, EtaEstimate>;
  /** Görünen ad (arkadaş listesi > etkinlik ad anlık görüntüsü). */
  nameOf?: (uid: UserId) => string | null;
  genderOf?: (uid: UserId) => Gender | null;
  /** Ek izin denetimi (Faz 8 `meetupEtaAllowed`); verilmezse gelen kutusunda olmak yeterli sayılır. */
  allowed?: (uid: UserId) => boolean;
}

/** Ad Soyad → ad. */
export function firstName(full: string | null | undefined): string {
  const t = (full ?? '').trim();
  return t ? (t.split(/\s+/)[0] ?? t) : 'Davetli';
}

/** Kullanılabilir konum mu (gizlilik + tazelik). */
export function usablePoint(p: EtaBoardPoint, now: EpochMs): boolean {
  if (p.receiver_status === 'offline_suspected' || p.receiver_status === 'stale') return false;
  if (now - p.timestamp > ETA_BOARD_LIMITS.dropAfterMs) return false;
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.accuracy <= ETA_BOARD_LIMITS.maxAccuracyM;
}

export function etaHeadline(startsAt: EpochMs | null, now: EpochMs): string {
  if (startsAt === null) return '';
  const min = Math.ceil((startsAt - now) / MINUTE);
  if (min <= 0) return 'Buluşma başladı';
  return `Buluşmaya ${min} dk`;
}

/**
 * Şeridi üretir: pencere + gizlilik filtresi + ETA + sıralama (vardı → yakından uzağa → eski konumlar sonda; eşitlikte
 * ada göre). Başlangıç geçtikten sonra görünen herkes vardıysa şerit `closed` (buluşma tamamlandı).
 */
export function buildEtaBoard(i: EtaBoardInput): EtaBoard {
  const { doc, viewer, now } = i;
  const win = etaBoardWindow(doc, now);
  const venue = venueOf(doc);
  const base: EtaBoard = {
    state: win.state,
    event_id: doc.event_id,
    venue_name: venue?.name ?? '',
    starts_at: doc.starts_at,
    closes_at: win.closes_at,
    entries: [],
    hidden_count: 0,
    overflow: 0,
    headline: etaHeadline(doc.starts_at, now),
  };
  if (win.state !== 'open' || !venue?.location) return base;
  const going = etaBoardParticipants(doc);
  if (!going.includes(viewer) && !doc.member_ids.includes(viewer)) return { ...base, state: 'hidden' };
  const byUid = new Map<UserId, EtaBoardPoint>();
  for (const p of i.points) {
    if (!going.includes(p.uid)) continue; // 1. yalnızca "Katılacağım"
    if (p.uid !== viewer && i.allowed && !i.allowed(p.uid)) continue; // 2. izin
    if (!usablePoint(p, now)) continue;
    const prev = byUid.get(p.uid);
    if (!prev || p.timestamp > prev.timestamp) byUid.set(p.uid, p);
  }
  const fallback = heuristicEtaEstimator(venue.name);
  const local = fallback.estimate([...byUid.values()], venue.location, now) as Map<UserId, EtaEstimate>;
  const entries: EtaBoardEntry[] = [];
  for (const [uid, p] of byUid) {
    const est = (local.get(uid)?.source === 'packet' ? local.get(uid) : i.etas?.get(uid) ?? local.get(uid))!;
    const stale = now - p.timestamp > ETA_BOARD_LIMITS.staleAfterMs;
    const status: EtaBoardEntry['status'] = est.eta_min === 0 ? 'arrived' : stale ? 'stale' : 'en_route';
    const is_me = uid === viewer;
    const name = is_me ? 'Sen' : firstName(i.nameOf?.(uid) ?? doc.names[uid]);
    const etaText = status === 'arrived' ? 'Vardı' : `${stale ? '~' : ''}${est.eta_min >= ETA_BOARD_LIMITS.maxEtaMin ? '4 sa+' : `${est.eta_min} dk`}`;
    entries.push({
      uid,
      name,
      gender: i.genderOf?.(uid) ?? 'unknown',
      is_me,
      status,
      eta_min: est.eta_min,
      distance_m: est.distance_m,
      label: `${name} · ${status === 'arrived' && is_me ? 'Vardın' : etaText}`,
      a11y: status === 'arrived' ? `${name}, mekana vardı` : `${name}, mekana yaklaşık ${est.eta_min} dakika${stale ? ', konum birkaç dakika önce' : ''}`,
      updated_at: p.timestamp,
    });
  }
  const rank = (e: EtaBoardEntry): number => (e.status === 'arrived' ? 0 : e.status === 'en_route' ? 1 : 2);
  entries.sort((a, b) => rank(a) - rank(b) || (a.eta_min ?? 0) - (b.eta_min ?? 0) || a.name.localeCompare(b.name, 'tr-TR'));
  const hidden_count = going.filter((u) => !byUid.has(u) && u !== viewer).length;
  if (doc.starts_at !== null && now >= doc.starts_at && entries.length > 0 && entries.every((e) => e.status === 'arrived')) {
    return { ...base, state: 'closed', entries: [], hidden_count };
  }
  const shown = entries.slice(0, ETA_BOARD_LIMITS.maxShown);
  return { ...base, entries: shown, overflow: entries.length - shown.length, hidden_count };
}

/** Birden çok etkinlik aynı anda pencerede ise haritada en erken başlayan gösterilir. */
export function pickMapEtaEvent(docs: readonly EventDoc[], viewer: UserId, now: EpochMs): EventDoc | null {
  const open = docs.filter((d) => d.member_ids.includes(viewer) && etaBoardWindow(d, now).state === 'open');
  open.sort((a, b) => (a.starts_at ?? 0) - (b.starts_at ?? 0));
  return open[0] ?? null;
}

export const ETA_BOARD_TEXT = {
  title: 'Kim ne kadar uzakta?',
  hidden: (n: number) => `+${n} kişi konum paylaşmıyor`,
  shareCta: 'Konumumu katılımcılarla paylaş',
  empty: 'Katılanlardan kimse şu an konum paylaşmıyor',
  reminderTitle: (title: string) => `45 dk kaldı: ${title}`,
  reminderBody: (venue: string | null, clock: string) => ['Kim ne kadar uzakta? Görmek için aç', [venue, clock].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
} as const;
