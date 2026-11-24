/**
 * Web görüntüleyicinin saf durum makinesi. Temel karar core `linkViewState` ile verilir
 * (uygulama içi `app/s/[token].tsx` ile aynı kural ve metinler):
 *
 *   - `unavailable` (core): ilk okuma kuralla reddedildi (hiç erişim olmadı). Var olmayan, bitmiş ve
 *     süresi dolmuş bağlantı AYIRT EDİLMEZ: "Bağlantı geçersiz ya da süresi dolmuş".
 *   - `ended` (core): erişim vardı (en az bir anlık görüntü geldi), sonra düğüm silindi ya da dinleyici
 *     `permission_denied` ile kesildi ya da paketteki `expires_at` geçti: "Paylaşım sona erdi".
 *   - `offline` / `error` (yalnızca web): ağ yok ya da dinleyici başka bir hatayla düştü.
 *
 * Bitince pin KALKAR (`showMarker: false`); son konum ekranda bırakılmaz.
 *
 * Faz 3 (core `receiverStatus`): bu sekmede görülen son birkaç paket (`fixes`, en çok `FIX_HISTORY_MAX`)
 * tutulur; pin ve "Haritada göster" doğruluğu ≤ 100 m olan EN SON ölçümü gösterir (kötü doğruluklu bir
 * hücre ölçümü iyi GPS noktasını ezmez). Durum satırı gönderenin kalp atışına (`hb`) göre: sabit duran
 * gönderen 15 dk'da bir yazar, 10 dk sessizlik normaldir; araçtaki için 5 dk sessizlik "Bağlantısı kopmuş
 * olabilir" demektir. Kuyruktan gelen paket (`q: 1`) sakin bir "eşitlendi" notu çıkarır. Bağlantı paketi
 * `is_charging` taşımaz (gizlilik): düşük pil yalnızca `battery_pct ≤ %15` ile anlaşılır.
 */
import {
  DAY,
  LINK_VIEW_DETAIL,
  LINK_VIEW_TEXT,
  LOW_BATTERY_PCT,
  MINUTE,
  formatAgo,
  formatRemaining,
  lastVerifiedLocation,
  linkViewState,
  lowBatteryBadge,
  lowBatteryPushText,
  parseLinkLive,
  syncedPointsText,
  untilClock,
  deviceOffset,
  type EpochMs,
  type Freshness,
  type LinkLiveLocation,
  type OffsetFn,
  type ReceivedFix,
  type ReceiverStatus,
} from '@konum/core';

export type ConnectionState = 'unknown' | 'up' | 'down';

export interface ViewerModel {
  tokenValid: boolean;
  /** İlk anlık görüntü ya da hata geldi. */
  loaded: boolean;
  /** En az bir anlık görüntü (null bile olsa) okundu: bağlantı o an geçerliydi. */
  hadAccess: boolean;
  denied: boolean;
  /** İzin dışı bir dinleyici hatası (ör. yapılandırma). */
  failed: boolean;
  live: LinkLiveLocation | null;
  seenLive: boolean;
  connection: ConnectionState;
  browserOnline: boolean;
  /** Faz 3: bu sekmede kabul edilen son paketler (eskiden yeniye). Bitince/kesilince boşalır. */
  fixes: ReceivedFix[];
  /** Faz 3: kuyruktan (`q: 1`) gelen paketler. `lastServerTs` sunucu saatidir (not süresi buna göre). */
  queued: { count: number; lastServerTs: EpochMs } | null;
}

/** Tutulan paket sayısı (yalnızca bellekte; sekme kapanınca gider). */
export const FIX_HISTORY_MAX = 20;
/** Kuyruk notu son kuyruk paketinden bu kadar sonra kalkar. [Varsayım] */
export const SYNC_NOTE_MS = 2 * MINUTE;

export type ViewerEvent =
  | { type: 'snapshot'; raw: unknown }
  | { type: 'denied' }
  | { type: 'failed' }
  | { type: 'connection'; connected: boolean }
  | { type: 'connect_timeout' }
  | { type: 'browser_online'; online: boolean };

export function initialViewerModel(tokenValid: boolean, browserOnline = true): ViewerModel {
  return {
    tokenValid,
    loaded: false,
    hadAccess: false,
    denied: false,
    failed: false,
    live: null,
    seenLive: false,
    connection: 'unknown',
    browserOnline,
    fixes: [],
    queued: null,
  };
}

const toFix = (l: LinkLiveLocation): ReceivedFix => ({
  lat: l.lat,
  lng: l.lng,
  accuracy: l.accuracy,
  timestamp: l.timestamp,
  server_ts: l.server_ts,
  battery_pct: l.battery_pct,
  hb: l.hb ?? null,
  q: l.q ?? null,
});

/** Aynı ölçüm (uzatma eşitlemesi) yeni kayıt sayılmaz, yerine yazılır. */
function pushFix(fixes: readonly ReceivedFix[], f: ReceivedFix): ReceivedFix[] {
  const out = fixes.filter((x) => x.timestamp !== f.timestamp);
  out.push(f);
  return out.length > FIX_HISTORY_MAX ? out.slice(out.length - FIX_HISTORY_MAX) : out;
}

function nextQueued(m: ViewerModel, p: LinkLiveLocation): ViewerModel['queued'] {
  const isNewFix = !m.live || p.timestamp > m.live.timestamp;
  if (p.q !== 1 || !isNewFix) return m.queued;
  const sameBurst = m.queued !== null && p.server_ts - m.queued.lastServerTs <= SYNC_NOTE_MS;
  return { count: sameBurst && m.queued ? m.queued.count + 1 : 1, lastServerTs: p.server_ts };
}

export function viewerReducer(m: ViewerModel, e: ViewerEvent): ViewerModel {
  switch (e.type) {
    case 'snapshot': {
      // Dinleyici kesildikten sonra gelen olay yok sayılır (kesilme kalıcıdır).
      if (m.denied || m.failed) return m;
      if (e.raw === null || e.raw === undefined) return { ...m, loaded: true, hadAccess: true, live: null, fixes: [], queued: null };
      const parsed = parseLinkLive(e.raw);
      // Bozuk paket: veri yokmuş gibi davran (önceki konum varsa korunur).
      if (!parsed) return { ...m, loaded: true, hadAccess: true };
      // Sıra dışı (daha eski) örnek konumu geri almaz; aynı örnek (ör. sunucu uzatma eşitlemesi) kabul.
      if (m.live && parsed.timestamp < m.live.timestamp) return { ...m, loaded: true, hadAccess: true };
      return {
        ...m,
        loaded: true,
        hadAccess: true,
        live: parsed,
        seenLive: true,
        fixes: pushFix(m.fixes, toFix(parsed)),
        queued: nextQueued(m, parsed),
      };
    }
    case 'denied':
      return { ...m, loaded: true, denied: true, live: null, fixes: [], queued: null };
    case 'failed':
      return m.denied ? m : { ...m, loaded: true, failed: true, live: null, fixes: [], queued: null };
    case 'connection':
      if (e.connected) return { ...m, connection: 'up' };
      // İlk `false` bağlanmadan önce gelir: çevrimdışı sayılmaz (bağlantı zaman aşımı karar verir).
      return m.connection === 'up' ? { ...m, connection: 'down' } : m;
    case 'connect_timeout':
      return m.connection === 'unknown' ? { ...m, connection: 'down' } : m;
    case 'browser_online':
      return { ...m, browserOnline: e.online };
  }
}

export type ViewerPhase = 'invalid' | 'unavailable' | 'loading' | 'offline' | 'waiting' | 'live' | 'ended' | 'error';

export const isOffline = (m: ViewerModel): boolean => !m.browserOnline || m.connection === 'down';

export function viewerPhase(m: ViewerModel, now: EpochMs): ViewerPhase {
  if (!m.tokenValid) return 'invalid';
  // Ağ / yapılandırma hatası "sona erdi" diye gösterilmez: paylaşım hâlâ sürüyor olabilir.
  if (m.failed && !m.denied) return 'error';
  const base = linkViewState({
    tokenValid: m.tokenValid,
    loaded: m.loaded,
    denied: m.denied,
    live: m.live,
    seenLive: m.seenLive,
    hadAccess: m.hadAccess,
    now,
  });
  switch (base) {
    case 'invalid':
      return 'invalid';
    case 'unavailable':
      return 'unavailable';
    case 'ended':
      return 'ended';
    case 'loading':
      return isOffline(m) ? 'offline' : 'loading';
    case 'waiting':
      return 'waiting';
    case 'live':
      return 'live';
  }
}

// ---------------------------------------------------------------------------
// Sunum (metinler). Türkçe, uygulamayla aynı dil.
// ---------------------------------------------------------------------------

export const PHASE_TEXT: Record<ViewerPhase, { title: string; detail: string }> = {
  invalid: { title: LINK_VIEW_TEXT.invalid, detail: LINK_VIEW_DETAIL.invalid },
  unavailable: { title: LINK_VIEW_TEXT.unavailable, detail: LINK_VIEW_DETAIL.unavailable },
  loading: { title: LINK_VIEW_TEXT.loading, detail: LINK_VIEW_DETAIL.loading },
  offline: { title: 'İnternet bağlantısı yok', detail: 'Bağlantı gelince konum kendiliğinden yüklenir.' },
  waiting: { title: LINK_VIEW_TEXT.waiting, detail: LINK_VIEW_DETAIL.waiting },
  live: { title: LINK_VIEW_TEXT.live, detail: LINK_VIEW_DETAIL.live },
  ended: { title: LINK_VIEW_TEXT.ended, detail: LINK_VIEW_DETAIL.ended },
  error: { title: 'Konum şu an alınamıyor', detail: 'Biraz sonra yeniden dene.' },
};

export interface LivePresentation {
  senderName: string;
  initial: string;
  /** Pin ve avatar tonu (Faz 1/2 `Freshness` biçimi; Faz 3 durumundan türetilir). */
  freshness: Freshness;
  /** Faz 3 alıcı durumu (core `receiverStatusOf`, gönderenin `hb` değerine göre). */
  status: ReceiverStatus;
  /** "Canlı · şimdi" / "Güncel · 8 dk önce" / "Bağlantısı kopmuş olabilir · 45 dk önce" */
  freshnessLine: string;
  /** "şimdi" / "18 dk önce" (gösterilen ölçümün yaşı) */
  ago: string;
  /** "Son doğrulanmış konum · 14:05 · %42"; canlıyken null (üst satır yeterli). */
  verifiedLabel: string | null;
  /** Bağlantı kopmuş görünüyorsa sakin açıklama; yoksa null. */
  statusDetail: string | null;
  /** "17:30'a kadar" / "28.11 17:30'a kadar" / "Süresiz" */
  until: string;
  /** "42 dk kaldı"; süresizde null. */
  remaining: string | null;
  /** "±12 m" */
  accuracy: string;
  /** "%54"; bilinmiyorsa null. */
  battery: string | null;
  /** Pil ≤ %15: bilgi notu (core `lowBatteryPushText`, bildirimle aynı metin) + rozet ("Pil %14"). */
  lowBattery: { badge: string; title: string; body: string } | null;
  /** Kuyruktan gelen paket notu; yoksa null. */
  syncNote: string | null;
  /** Pinin gösterdiği ölçüm (doğrulanmış son konum). */
  position: { lat: number; lng: number; accuracy: number; timestamp: EpochMs };
  /** Google Haritalar bağlantısı (kullanıcı tıklarsa açılır; sayfa istek atmaz). */
  mapsUrl: string;
  /** Ekran okuyucu duyurusu: yalnızca durum değişince değişir (saniyelik metin yok). */
  announcement: string;
}

/** Durum → pin/avatar tonu. Zamanında gelen seyrek paket (recent) gri DEĞİL: gönderen yolunda. */
const STATUS_TONE: Record<ReceiverStatus, Freshness> = {
  live: 'live',
  recent: 'recent',
  delayed: 'recent',
  offline_suspected: 'stale',
  stale: 'stale',
};

export const STATUS_DETAIL: Partial<Record<ReceiverStatus, string>> = {
  offline_suspected: 'Telefonu çekim alanı dışında ya da kapalı olabilir. Bağlantı gelince konum kendiliğinden güncellenir.',
  stale: 'Bir süredir konum gelmedi. Bağlantı gelince konum kendiliğinden güncellenir.',
};

/** Bağlantıda iz yok (`LINK_TRAIL_ENABLED = false`): genellikle yalnızca en son kuyruk noktası gelir. */
export function syncNoteText(count: number): string {
  return count > 1
    ? (syncedPointsText(count) as string)
    : 'Bağlantı geri geldi · çevrimdışıyken kaydedilen konum eşitlendi';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Bitiş satırı: core `untilClock`; 24 saatten uzaksa ya da başka günse tarih öne eklenir. */
export function untilText(expiresAt: EpochMs | null, now: EpochMs, offsetAt: OffsetFn = deviceOffset): string {
  if (expiresAt === null) return 'Süresiz';
  const localDay = (t: EpochMs) => Math.floor((t + offsetAt(t) * MINUTE) / DAY);
  const until = untilClock(expiresAt, offsetAt);
  // Gece yarısı (00:00) bitişi "bugünün sonu" olarak okunur; tarih eklenmez.
  const endsAtMidnight = (expiresAt + offsetAt(expiresAt) * MINUTE) % DAY === 0;
  const sameDay = localDay(expiresAt) === localDay(now) || (endsAtMidnight && localDay(expiresAt - 1) === localDay(now));
  if (sameDay && expiresAt - now < DAY) return until;
  const d = new Date(expiresAt + offsetAt(expiresAt) * MINUTE);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${until}`;
}

export function formatAccuracy(m: number): string {
  if (m >= 1000) return `±${(m / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} km`;
  return `±${Math.max(1, Math.round(m))} m`;
}

/** Türkçe büyük harf baş harf ("ilknur" → "İ"). */
export function initialOf(name: string): string {
  const ch = [...name.trim()][0] ?? '?';
  return ch.toLocaleUpperCase('tr-TR');
}

export function googleMapsUrl(lat: number, lng: number): string {
  const r = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
  return `https://www.google.com/maps?q=${r(lat)},${r(lng)}`;
}

export interface PresentationHistory {
  fixes: readonly ReceivedFix[];
  queued: ViewerModel['queued'];
}

export function livePresentation(
  live: LinkLiveLocation,
  now: EpochMs,
  offsetAt: OffsetFn = deviceOffset,
  history: PresentationHistory = { fixes: [], queued: null },
): LivePresentation {
  const fixes = history.fixes.length > 0 ? history.fixes : [toFix(live)];
  const v = lastVerifiedLocation(fixes, now, offsetAt) ?? lastVerifiedLocation([toFix(live)], now, offsetAt);
  // `fixes` boş değil: v her zaman dolu.
  const verified = v as NonNullable<typeof v>;
  const left = live.expires_at === null ? null : live.expires_at - now;
  const ago = formatAgo(verified.recorded_at, now);
  const pct = verified.battery_pct;
  const low = pct !== null && pct <= LOW_BATTERY_PCT ? lowBatteryPushText(live.sender_name, pct) : null;
  const queued = history.queued;
  const syncNote = queued && now - queued.lastServerTs <= SYNC_NOTE_MS ? syncNoteText(queued.count) : null;
  const statusLine = `${verified.statusText} · ${ago}`;
  return {
    senderName: live.sender_name,
    initial: initialOf(live.sender_name),
    freshness: STATUS_TONE[verified.status],
    status: verified.status,
    freshnessLine: statusLine,
    ago,
    verifiedLabel: verified.status === 'live' ? null : verified.label,
    statusDetail: STATUS_DETAIL[verified.status] ?? null,
    until: untilText(live.expires_at, now, offsetAt),
    remaining: left === null ? null : `${formatRemaining(left)} kaldı`,
    accuracy: formatAccuracy(verified.accuracy),
    battery: pct === null ? null : `%${Math.round(pct)}`,
    lowBattery: low && pct !== null ? { badge: lowBatteryBadge(pct, LOW_BATTERY_PCT) as string, ...low } : null,
    syncNote,
    position: { lat: verified.lat, lng: verified.lng, accuracy: verified.accuracy, timestamp: verified.recorded_at },
    mapsUrl: googleMapsUrl(verified.lat, verified.lng),
    announcement: [
      verified.status === 'live' || verified.status === 'recent'
        ? `${live.sender_name} canlı konumunu paylaşıyor`
        : `${live.sender_name}: ${verified.statusText}`,
      low ? low.title : null,
      syncNote,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

/** Haritada pin yalnızca canlıyken (çevrimdışıyken son bilinen konum) görünür. */
export const showsMarker = (phase: ViewerPhase): boolean => phase === 'live';
