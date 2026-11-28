/**
 * Faz 12: en sık konum paylaştığım kişiler → harita ve alt kitapçıkta "15 dk / 1 saat" kısayolları.
 *
 * Geçmiş YALNIZCA cihazdadır (`konum.f12.shareHistory.v1`): her giden paylaşım (alıcı başına bir kayıt, `share_id`
 * ile tekil) {alıcı, başlangıç, süre}. Sunucuya gitmez, kimse "kimle ne sıklıkta paylaşıyorsun" göremez.
 *
 * Puan (saf, test edilebilir):
 *   puan(kişi) = Σ 0.5^(yaş / 14 gün)   (son 60 gün; her paylaşım ≈ 1 puan, iki haftada yarıya iner)
 *              + 0.75                    (favoriyse: hiç paylaşılmamış favori de görünür, ama sık paylaşılan öne geçer)
 *   Arkadaş olmayanlar / engellenenler elenir. Eşitlikte favori sırası, sonra en son paylaşım, sonra ad.
 *   En çok `SHORTCUT_LIMIT` kişi (şerit tek satıra sığar).
 *
 * Kısayol başlatma kararı (`planShortcutStart`): görünmez / onay kapısı / yönlü izin (ben → o, `location_view`) /
 * mola / zaten paylaşılıyor durumlarını menü açmadan tek bir karta çevirir.
 */
import type { UserId } from './model';
import { DAY, MINUTE, type EpochMs } from './time';

export const SHORTCUT_LIMIT = 4;
export const HISTORY_WINDOW_MS = 60 * DAY;
export const HISTORY_HALF_LIFE_MS = 14 * DAY;
export const HISTORY_MAX_ENTRIES = 300;
export const FAVORITE_BOOST = 0.75;

export const SHORTCUT_DURATIONS = [
  { id: 'm15', minutes: 15, label: '15 dk' },
  { id: 'h1', minutes: 60, label: '1 saat' },
] as const;
export type ShortcutDurationId = (typeof SHORTCUT_DURATIONS)[number]['id'];

export interface ShareHistoryEntry {
  /** Tekillik anahtarı (Firestore `location_shares` belge kimliği). */
  share_id: string;
  receiver_id: UserId;
  started_at: EpochMs;
  /** Seçilen süre (dk); süresiz null. */
  minutes: number | null;
}

/** Yeni kayıtları ekler: tekrarlar atılır, pencere dışı / fazlası budanır, en yeni sonda. Saf. */
export function mergeHistory(list: readonly ShareHistoryEntry[], add: readonly ShareHistoryEntry[], now: EpochMs): ShareHistoryEntry[] {
  const seen = new Set<string>();
  const out: ShareHistoryEntry[] = [];
  for (const e of [...list, ...add]) {
    if (seen.has(e.share_id) || now - e.started_at > HISTORY_WINDOW_MS || e.started_at > now + DAY) continue;
    seen.add(e.share_id);
    out.push(e);
  }
  out.sort((a, b) => a.started_at - b.started_at);
  return out.slice(-HISTORY_MAX_ENTRIES);
}

/** Bir kişiden geçmişi siler (arkadaşlıktan çıkarma / engelleme / kullanıcı "öneriden kaldır"). */
export function forgetContact(list: readonly ShareHistoryEntry[], uid: UserId): ShareHistoryEntry[] {
  return list.filter((e) => e.receiver_id !== uid);
}

export function parseHistory(v: unknown): ShareHistoryEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ShareHistoryEntry[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.share_id !== 'string' || typeof o.receiver_id !== 'string' || typeof o.started_at !== 'number') continue;
    const minutes = typeof o.minutes === 'number' && o.minutes > 0 ? o.minutes : null;
    out.push({ share_id: o.share_id, receiver_id: o.receiver_id, started_at: o.started_at, minutes });
  }
  return out;
}

export interface FrequentContact {
  uid: UserId;
  score: number;
  /** Son 60 günde paylaşım sayısı. */
  count: number;
  last_at: EpochMs | null;
  favorite: boolean;
  /** En çok seçtiği süre (kısayolda vurgulanır); yoksa null. */
  usual: ShortcutDurationId | null;
}

export interface RankInput {
  history: readonly ShareHistoryEntry[];
  favorites: readonly UserId[];
  /** Kabul edilmiş arkadaşlar (null = henüz yüklenmedi → yalnızca favoriler + geçmiş, süzme yok). */
  friendIds: ReadonlySet<UserId> | null;
  now: EpochMs;
  /** Ad (eşitlik bozucu). */
  nameOf?: (uid: UserId) => string;
  limit?: number;
}

const usualOf = (mins: number[]): ShortcutDurationId | null => {
  if (!mins.length) return null;
  const short = mins.filter((m) => m <= 30).length;
  return short * 2 > mins.length ? 'm15' : 'h1';
};

export function rankFrequentContacts(i: RankInput): FrequentContact[] {
  const by = new Map<UserId, { score: number; count: number; last: EpochMs | null; mins: number[] }>();
  const get = (uid: UserId) => {
    let v = by.get(uid);
    if (!v) by.set(uid, (v = { score: 0, count: 0, last: null, mins: [] }));
    return v;
  };
  for (const e of i.history) {
    const age = i.now - e.started_at;
    if (age < -DAY || age > HISTORY_WINDOW_MS) continue;
    const v = get(e.receiver_id);
    v.score += Math.pow(0.5, Math.max(0, age) / HISTORY_HALF_LIFE_MS);
    v.count++;
    v.last = Math.max(v.last ?? 0, e.started_at);
    if (e.minutes !== null) v.mins.push(e.minutes);
  }
  const favIndex = new Map(i.favorites.map((u, k) => [u, k] as const));
  for (const f of i.favorites) get(f).score += FAVORITE_BOOST;

  const list: FrequentContact[] = [];
  for (const [uid, v] of by) {
    if (i.friendIds && !i.friendIds.has(uid)) continue;
    list.push({ uid, score: v.score, count: v.count, last_at: v.last, favorite: favIndex.has(uid), usual: usualOf(v.mins) });
  }
  const name = i.nameOf ?? ((u: UserId) => u);
  list.sort(
    (a, b) =>
      b.score - a.score ||
      (favIndex.get(a.uid) ?? 99) - (favIndex.get(b.uid) ?? 99) ||
      (b.last_at ?? 0) - (a.last_at ?? 0) ||
      name(a.uid).localeCompare(name(b.uid), 'tr'),
  );
  return list.slice(0, i.limit ?? SHORTCUT_LIMIT);
}

// --- kısayolla başlatma kararı ---------------------------------------------------------------

export interface ShortcutGateInput {
  invisible: boolean;
  consentRequired: boolean;
  /** Ben → o `location_view` izni var mı (ve bu cihazda geri alınmadı mı). */
  grantToThem: boolean;
  /** O → ben `location_view` (bilgi amaçlı: "Ayşe de sana açık"). */
  grantFromThem: boolean;
  /** Bu kişiye şu an sürmekte olan paylaşımım (bitişi; süresiz = null). */
  activeUntil: EpochMs | null | undefined;
  onBreak: boolean;
  now: EpochMs;
  minutes: number;
}

export type ShortcutPlan =
  /** Hiçbir engel yok: hemen `share_start`. */
  | { kind: 'start'; endsBreak: boolean }
  /** Görünmez: "Görünür ol" yönlendirmesi; paylaşım başlamaz. */
  | { kind: 'invisible' }
  /** Güncel sözleşme onayı gerekiyor. */
  | { kind: 'consent' }
  /** Bu kişiye konum izni vermemişim: tek dokunuşla "İzin ver ve paylaş" (Faz 8 `grant_location_view`). */
  | { kind: 'needs_grant'; endsBreak: boolean }
  /** Zaten bu süreden uzun / süresiz paylaşıyorum: hiçbir şey yapılmaz, kart kalan süreyi söyler. */
  | { kind: 'already'; until: EpochMs | null };

export function planShortcutStart(i: ShortcutGateInput): ShortcutPlan {
  if (i.consentRequired) return { kind: 'consent' };
  if (i.invisible) return { kind: 'invisible' };
  if (i.activeUntil === null) return { kind: 'already', until: null };
  if (typeof i.activeUntil === 'number' && i.activeUntil > i.now && i.activeUntil >= i.now + i.minutes * MINUTE - MINUTE) {
    return { kind: 'already', until: i.activeUntil };
  }
  if (!i.grantToThem) return { kind: 'needs_grant', endsBreak: i.onBreak };
  return { kind: 'start', endsBreak: i.onBreak };
}

export const SHORTCUT_TEXT = {
  title: 'Sık paylaştıkların',
  invisible: 'Görünmez moddasın. Paylaşmak için önce görünür ol.',
  consent: 'Devam etmek için güncel sözleşmeyi onaylaman gerekiyor.',
  needsGrant: (first: string) => `${first} konumunu görmüyor; ona henüz konum izni vermedin.`,
  grantAndShare: 'İzin ver ve paylaş',
  mutual: (first: string) => `${first} da konumunu seninle paylaşabiliyor`,
  oneWay: (first: string) => `${first} sana konum izni vermedi; yalnızca sen paylaşırsın`,
  already: (first: string, left: string | null) => (left ? `${first} konumunu zaten görüyor · ${left} kaldı` : `${first} konumunu zaten görüyor`),
  started: (first: string, label: string) => `${first} ile ${label} paylaşım başladı`,
  breakEnds: 'Molan biter ve yayın yeniden açılır.',
  empty: 'Paylaştıkça en sık paylaştığın kişiler burada görünür.',
} as const;
