/**
 * Faz 6: ana ekran / kilit ekranı widget'larının okuduğu JSON anlık görüntüsü (snapshot). Yerel kod (SwiftUI
 * WidgetKit, Android RemoteViews) TAM OLARAK bu şekli (snake_case) okur; alanlar yalnızca EKLENİR.
 *
 * Akış: uygulama store'larından `buildWidgetSnapshot` → `widgetSnapshotChanged` ile değişim sınıfı → yerel köprü
 * `setSnapshot(json)` (iOS App Group UserDefaults / Android tercih dosyası, anahtar `WIDGET_SNAPSHOT_KEY`) →
 * gerekirse `reload()`. Widget uzantısı ağ ve Firebase'e erişmez (tek istisna: token'lı hızlı paylaşım çağrısı).
 *
 * Gizlilik:
 *  - Ham koordinat ASLA yazılmaz; `place` kısa etikettir (Faz 5 bölge adı ya da kısa adres). Koordinata benzeyen
 *    metin atılır.
 *  - `avatar_file` paylaşılan kapsayıcıdaki DOSYA ADIDIR (yerel `saveAvatar` yazar), URL değildir.
 *  - Widget token'ı snapshot'ta YOKTUR (anahtar zinciri / şifreli tercihler); yalnızca `quick.token_ok`.
 *  - `privacy.lock_screen_details == false` (varsayılan): kilit ekranı yalnızca ad + durum + zaman gösterir; yer ve
 *    pil `.privacySensitive()` ile gizlenir.
 *
 * Boyut: iOS widget belleği ~30 MB, UserDefaults değeri küçük tutulmalı; `WIDGET_LIMITS.maxBytes` aşılırsa önce
 * yer etiketleri, sonra avatar dosyaları, en son sondaki favoriler atılır.
 */
import { z } from 'zod';
import { LOW_BATTERY_PCT } from './cadence';
import { utf8Encode } from './link';
import type { ShareStatus, UserId } from './model';
import { genderRingColor, GenderSchema, initialsOf, isGender, type Gender } from './profile';
import { WIDGET_TOKEN_EXPIRY_MARGIN_MS } from './quickShare';
import { DAY, HOUR, MINUTE, type EpochMs } from './time';

export const WIDGET_SNAPSHOT_VERSION = 1;
/** App Group (iOS) / tercih (Android) anahtarı. */
export const WIDGET_SNAPSHOT_KEY = 'konum.widget.snapshot.v1';

export const WIDGET_LIMITS = {
  maxFavorites: 4,
  nameMaxChars: 18,
  placeMaxChars: 28,
  maxBytes: 16_384,
  staleAfterMs: 15 * 60_000,
  writeMinIntervalMs: 60_000,
  reloadMinIntervalMs: 5 * 60_000,
} as const;

export const WIDGET_FAVORITE_STATUSES = ['sharing_live', 'sharing_stale', 'not_sharing', 'paused'] as const;
export type WidgetFavoriteStatus = (typeof WIDGET_FAVORITE_STATUSES)[number];

export interface WidgetFavorite {
  uid: UserId;
  name: string;
  initials: string;
  gender: Gender | null;
  /** hex renk (`genderRingColor`). */
  ring: string;
  /** Paylaşılan kapsayıcıdaki dosya adı (yerel `saveAvatar()` yazar); ASLA URL değil. */
  avatar_file: string | null;
  /** Onun BANA paylaşımı. */
  status: WidgetFavoriteStatus;
  /** Son paket zamanı. */
  last_seen_at: EpochMs | null;
  /** Kısa etiket: bölge adı (Faz 5) ya da kısa adres; ASLA ham koordinat. */
  place: string | null;
  battery_pct: number | null;
  battery_low: boolean;
  /** Benim ONA aktif paylaşımımın bitişi (null = yok ya da süresiz) → widget geri sayım gösterir. */
  my_share_expires_at: EpochMs | null;
  /**
   * [Ek alan] Benim ona aktif paylaşımım var mı (süresiz paylaşımda `my_share_expires_at` null olduğu için).
   * Yerel kod okumayabilir; okumazsa süresiz paylaşım "paylaşım yok" gibi görünür ve düğme `already_active` döner.
   */
  my_share_active: boolean;
}

export interface WidgetSnapshot {
  v: 1;
  generated_at: EpochMs;
  signed_in: boolean;
  me_initials: string | null;
  default_uid: UserId | null;
  favorites: WidgetFavorite[];
  /** Token'ın kendisi snapshot'ta YOK (anahtar zinciri / şifreli tercihler). */
  quick: { token_ok: boolean; bg_location_ok: boolean };
  /** false (varsayılan): kilit ekranı ad + durum + zaman gösterir. */
  privacy: { lock_screen_details: boolean };
}

// ---------------------------------------------------------------------------
// Girdi (uygulama durumu → saf fonksiyon)
// ---------------------------------------------------------------------------

export interface WidgetFriendInput {
  uid: UserId;
  display_name: string;
  gender?: Gender | null;
  /** Yerel `saveAvatar(uid, dosya)` sonucu; yoksa baş harfler. */
  avatar_file?: string | null;
  /** Onun bana paylaşımı ve son paketi (null = paylaşım yok). */
  incoming?: {
    active: boolean;
    /** Gönderenin takibi duraksadı (Faz 3 `offline_suspected` / `tracking_stalled`). */
    paused?: boolean;
    last_seen_at: EpochMs | null;
    battery_pct?: number | null;
    place?: string | null;
  } | null;
}

export interface WidgetBuildInput {
  now: EpochMs;
  signed_in: boolean;
  me: { display_name: string } | null;
  /** Sıralı favoriler (`users/{uid}.favorite_ids`). Arkadaş listesinde olmayanlar atlanır. */
  favorite_ids: readonly UserId[];
  friends: readonly WidgetFriendInput[];
  /** Benim giden paylaşımlarım. */
  outgoing: readonly { receiver_id: UserId; status: ShareStatus; expires_at: EpochMs | null }[];
  quick: { token_expires_at: EpochMs | null; bg_location_ok: boolean };
  privacy?: { lock_screen_details: boolean };
  /** Test / ayar: bayt sınırı (varsayılan `WIDGET_LIMITS.maxBytes`). */
  max_bytes?: number;
}

/** Görünen karakter sayısına göre keser (vekil çiftleri bölmeden), gerekirse "…" ekler. */
export function truncateText(s: string, max: number): string {
  const chars = Array.from(s.trim().replace(/\s+/g, ' '));
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

const COORD_RE = /-?\d{1,3}[.,]\d{3,}\s*[,;/ ]\s*-?\d{1,3}[.,]\d{3,}/;
const AVATAR_FILE_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Yer etiketi temizliği: boş / koordinata benzeyen metin → null. */
export function safePlaceLabel(place: string | null | undefined): string | null {
  if (typeof place !== 'string') return null;
  const p = place.trim();
  if (!p || COORD_RE.test(p)) return null;
  return truncateText(p, WIDGET_LIMITS.placeMaxChars);
}

const safeAvatarFile = (f: string | null | undefined): string | null =>
  typeof f === 'string' && AVATAR_FILE_NAME_RE.test(f) && !f.includes('..') ? f : null;

function statusOf(inc: WidgetFriendInput['incoming'], now: EpochMs): WidgetFavoriteStatus {
  if (!inc || !inc.active) return 'not_sharing';
  if (inc.paused) return 'paused';
  if (inc.last_seen_at !== null && now - inc.last_seen_at <= WIDGET_LIMITS.staleAfterMs) return 'sharing_live';
  return 'sharing_stale';
}

export const snapshotBytes = (s: WidgetSnapshot): number => utf8Encode(JSON.stringify(s)).length;

/** Saf: uygulama durumundan widget snapshot'ı. Keser, gizlilik kurallarını ve bayt sınırını uygular. */
export function buildWidgetSnapshot(input: WidgetBuildInput): WidgetSnapshot {
  const { now } = input;
  const privacy = { lock_screen_details: input.privacy?.lock_screen_details === true };
  if (!input.signed_in) {
    return {
      v: 1,
      generated_at: now,
      signed_in: false,
      me_initials: null,
      default_uid: null,
      favorites: [],
      quick: { token_ok: false, bg_location_ok: false },
      privacy,
    };
  }
  const byUid = new Map(input.friends.map((f) => [f.uid, f]));
  const mine = new Map<UserId, { expires_at: EpochMs | null }>();
  for (const o of input.outgoing) {
    if (o.status === 'active' && (o.expires_at === null || o.expires_at > now)) mine.set(o.receiver_id, o);
  }
  const seen = new Set<UserId>();
  const favorites: WidgetFavorite[] = [];
  for (const id of input.favorite_ids) {
    if (favorites.length >= WIDGET_LIMITS.maxFavorites) break;
    const f = byUid.get(id);
    if (!f || seen.has(id)) continue;
    seen.add(id);
    const gender = isGender(f.gender) ? f.gender : null;
    const inc = f.incoming ?? null;
    const status = statusOf(inc, now);
    const sharing = status !== 'not_sharing';
    const pct = sharing && typeof inc?.battery_pct === 'number' ? Math.round(Math.min(100, Math.max(0, inc.battery_pct))) : null;
    const my = mine.get(id);
    favorites.push({
      uid: id,
      name: truncateText(f.display_name || 'Arkadaş', WIDGET_LIMITS.nameMaxChars),
      initials: initialsOf(f.display_name || ''),
      gender,
      ring: genderRingColor(gender),
      avatar_file: safeAvatarFile(f.avatar_file),
      status,
      last_seen_at: sharing ? (inc?.last_seen_at ?? null) : null,
      place: sharing ? safePlaceLabel(inc?.place) : null,
      battery_pct: pct,
      battery_low: pct !== null && pct <= LOW_BATTERY_PCT,
      my_share_expires_at: my?.expires_at ?? null,
      my_share_active: my !== undefined,
    });
  }
  const tokenAt = input.quick.token_expires_at;
  const snap: WidgetSnapshot = {
    v: 1,
    generated_at: now,
    signed_in: true,
    me_initials: input.me ? initialsOf(input.me.display_name) : null,
    default_uid: favorites[0]?.uid ?? null,
    favorites,
    quick: {
      token_ok: tokenAt !== null && tokenAt - now > WIDGET_TOKEN_EXPIRY_MARGIN_MS,
      bg_location_ok: input.quick.bg_location_ok,
    },
    privacy,
  };
  return enforceMaxBytes(snap, input.max_bytes ?? WIDGET_LIMITS.maxBytes);
}

/** Bayt sınırı: önce yer etiketleri, sonra avatar dosyaları, en son sondaki favoriler atılır. */
function enforceMaxBytes(snap: WidgetSnapshot, maxBytes: number): WidgetSnapshot {
  let s = snap;
  if (snapshotBytes(s) <= maxBytes) return s;
  s = { ...s, favorites: s.favorites.map((f) => ({ ...f, place: null })) };
  if (snapshotBytes(s) <= maxBytes) return s;
  s = { ...s, favorites: s.favorites.map((f) => ({ ...f, avatar_file: null })) };
  while (s.favorites.length > 0 && snapshotBytes(s) > maxBytes) {
    s = { ...s, favorites: s.favorites.slice(0, -1) };
  }
  return { ...s, default_uid: s.favorites[0]?.uid ?? null };
}

// ---------------------------------------------------------------------------
// Değişim sınıfı ve yazma / yenileme kısıtlaması
// ---------------------------------------------------------------------------

/**
 * `major` = durum / benim paylaşımım / favori listesi (sıra, ad, avatar, cinsiyet) / oturum / token / izin / gizlilik
 *           değişti → hemen yaz + widget'ı yenile;
 * `minor` = yalnızca son görülme / pil / yer → yaz, yenileme kısıtlı (`reloadMinIntervalMs`);
 * `none`  = görünür fark yok (`generated_at` sayılmaz).
 */
export function widgetSnapshotChanged(prev: WidgetSnapshot | null, next: WidgetSnapshot): 'none' | 'minor' | 'major' {
  if (!prev) return 'major';
  if (
    prev.signed_in !== next.signed_in ||
    prev.me_initials !== next.me_initials ||
    prev.default_uid !== next.default_uid ||
    prev.quick.token_ok !== next.quick.token_ok ||
    prev.quick.bg_location_ok !== next.quick.bg_location_ok ||
    prev.privacy.lock_screen_details !== next.privacy.lock_screen_details ||
    prev.favorites.length !== next.favorites.length
  ) {
    return 'major';
  }
  let minor = false;
  for (let i = 0; i < next.favorites.length; i++) {
    const a = prev.favorites[i]!;
    const b = next.favorites[i]!;
    if (
      a.uid !== b.uid ||
      a.status !== b.status ||
      a.my_share_expires_at !== b.my_share_expires_at ||
      a.my_share_active !== b.my_share_active ||
      a.name !== b.name ||
      a.initials !== b.initials ||
      a.gender !== b.gender ||
      a.ring !== b.ring ||
      a.avatar_file !== b.avatar_file
    ) {
      return 'major';
    }
    if (a.last_seen_at !== b.last_seen_at || a.place !== b.place || a.battery_pct !== b.battery_pct || a.battery_low !== b.battery_low) {
      minor = true;
    }
  }
  return minor ? 'minor' : 'none';
}

/**
 * Yazma / yenileme kararı. `minor` değişiklik `writeMinIntervalMs` dolmadan yazılmaz; `next_check_at` ertelenen
 * yazma için zamanlayıcı anıdır (o an yeniden `buildWidgetSnapshot` + bu fonksiyon çağrılır).
 */
export function widgetSyncDecision(s: {
  change: 'none' | 'minor' | 'major';
  now: EpochMs;
  last_write_at: EpochMs | null;
  last_reload_at: EpochMs | null;
}): { write: boolean; reload: boolean; next_check_at: EpochMs | null } {
  if (s.change === 'none') return { write: false, reload: false, next_check_at: null };
  if (s.change === 'major') return { write: true, reload: true, next_check_at: null };
  const writeOk = s.last_write_at === null || s.now - s.last_write_at >= WIDGET_LIMITS.writeMinIntervalMs;
  if (!writeOk) return { write: false, reload: false, next_check_at: (s.last_write_at as number) + WIDGET_LIMITS.writeMinIntervalMs };
  const reload = s.last_reload_at === null || s.now - s.last_reload_at >= WIDGET_LIMITS.reloadMinIntervalMs;
  return { write: true, reload, next_check_at: reload ? null : (s.last_reload_at as number) + WIDGET_LIMITS.reloadMinIntervalMs };
}

/** Hızlı paylaşım başarılı olunca snapshot'ı yamalar (yerel kod da aynısını yapar). */
export function applyQuickShareToSnapshot(snap: WidgetSnapshot, toUid: UserId, expiresAt: EpochMs | null, now: EpochMs): WidgetSnapshot {
  return {
    ...snap,
    generated_at: now,
    favorites: snap.favorites.map((f) => (f.uid === toUid ? { ...f, my_share_expires_at: expiresAt, my_share_active: true } : f)),
  };
}

// ---------------------------------------------------------------------------
// Metinler (yerel kod aynı kuralları uygular)
// ---------------------------------------------------------------------------

/** Zaman çizelgesi anında durum: `sharing_live` → son paket `staleAfterMs`'ten eskiyse `sharing_stale`. */
export function effectiveWidgetStatus(f: Pick<WidgetFavorite, 'status' | 'last_seen_at'>, now: EpochMs): WidgetFavoriteStatus {
  if (f.status === 'sharing_live' && (f.last_seen_at === null || now - f.last_seen_at > WIDGET_LIMITS.staleAfterMs)) return 'sharing_stale';
  return f.status;
}

/** Kısa yaş: "3 dk", "2 sa", "1 gün"; bir dakikadan az → "şimdi". */
export function formatAgeShort(ms: number): string {
  const d = Math.max(0, ms);
  if (d < MINUTE) return 'şimdi';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} dk`;
  if (d < DAY) return `${Math.floor(d / HOUR)} sa`;
  return `${Math.floor(d / DAY)} gün`;
}

/**
 * "Paylaşıyor · 3 dk önce", "Paylaşıyor · şimdi", "Paylaşmıyor", "Bağlantı yok · 22 dk", "Duraklatıldı".
 * `lock` (kilit ekranı aksesuarları): daha kısa ("Paylaşıyor · 3 dk"); yer / pil zaten bu metinde yoktur.
 */
export function widgetStatusText(f: WidgetFavorite, now: EpochMs, lock: boolean): string {
  const st = effectiveWidgetStatus(f, now);
  if (st === 'not_sharing') return 'Paylaşmıyor';
  if (st === 'paused') return 'Duraklatıldı';
  if (f.last_seen_at === null) return 'Konum bekleniyor';
  const age = now - f.last_seen_at;
  if (st === 'sharing_stale') return `Bağlantı yok · ${formatAgeShort(age)}`;
  if (age < MINUTE) return 'Paylaşıyor · şimdi';
  return lock ? `Paylaşıyor · ${formatAgeShort(age)}` : `Paylaşıyor · ${formatAgeShort(age)} önce`;
}

/** Geri sayım: "59 dk", "1 sa", "1 sa 30 dk", "2 gün". Dakika yukarı yuvarlanır. */
export function formatCountdown(msLeft: number): string {
  if (msLeft <= 0) return '0 dk';
  const totalMin = Math.ceil(msLeft / MINUTE);
  if (totalMin < 60) return `${totalMin} dk`;
  if (totalMin < 24 * 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h} sa ${m} dk` : `${h} sa`;
  }
  return `${Math.floor(totalMin / (24 * 60))} gün`;
}

/**
 * Zaman çizelgesi için bir sonraki görünüm değişimi: en yakın "canlı → bağlantı yok" sınırı ya da paylaşım bitişi.
 * Yoksa null (yerel kod kendi üst sınırıyla, örn. 30 dk, yeniler).
 */
export function widgetNextChangeAt(snap: WidgetSnapshot, now: EpochMs): EpochMs | null {
  let next: EpochMs | null = null;
  const consider = (t: EpochMs | null) => {
    if (t !== null && t > now && (next === null || t < next)) next = t;
  };
  for (const f of snap.favorites) {
    if (f.status === 'sharing_live' && f.last_seen_at !== null) consider(f.last_seen_at + WIDGET_LIMITS.staleAfterMs + 1);
    consider(f.my_share_expires_at);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Ayrıştırma (demo, uygulama geri okuma, sözleşme testi)
// ---------------------------------------------------------------------------

const epochOrNull = z.number().int().nonnegative().nullable();

export const WidgetFavoriteSchema: z.ZodType<WidgetFavorite> = z.object({
  uid: z.string().min(1).max(128),
  // Sınır karakter (kod noktası) sayısıdır; UTF-16 birimi olarak iki katı pay bırakılır.
  name: z.string().max(WIDGET_LIMITS.nameMaxChars * 2),
  initials: z.string().max(8),
  gender: GenderSchema.nullable().catch(null),
  ring: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  avatar_file: z.string().regex(AVATAR_FILE_NAME_RE).nullable(),
  status: z.enum(WIDGET_FAVORITE_STATUSES),
  last_seen_at: epochOrNull,
  place: z.string().max(WIDGET_LIMITS.placeMaxChars * 2).nullable(),
  battery_pct: z.number().int().min(0).max(100).nullable(),
  battery_low: z.boolean(),
  my_share_expires_at: epochOrNull,
  my_share_active: z.boolean().default(false),
});

export const WidgetSnapshotSchema: z.ZodType<WidgetSnapshot> = z.object({
  v: z.literal(1),
  generated_at: z.number().int().nonnegative(),
  signed_in: z.boolean(),
  me_initials: z.string().max(8).nullable(),
  default_uid: z.string().min(1).max(128).nullable(),
  favorites: z.array(WidgetFavoriteSchema).max(WIDGET_LIMITS.maxFavorites),
  quick: z.object({ token_ok: z.boolean(), bg_location_ok: z.boolean() }),
  privacy: z.object({ lock_screen_details: z.boolean() }),
});

export function parseWidgetSnapshot(raw: unknown): WidgetSnapshot | null {
  const r = WidgetSnapshotSchema.safeParse(typeof raw === 'string' ? safeJson(raw) : raw);
  return r.success ? r.data : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
