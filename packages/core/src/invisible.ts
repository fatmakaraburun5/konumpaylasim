/**
 * Faz 8: Görünmez ol (docs/PHASE8.md §1.4–§1.5, §2.2, §3 `invisible_set`).
 *
 *  - Sunucuda zorlanır: açınca etkin giden paylaşımların anlık görüntüsü alınır, hepsi `stopped_by_sender` ile biter
 *    (arkadaşa "görünmez oldu" DENMEZ), etkin QR bağlantıları biter (geri yüklenmez). Görünmezken yeni paylaşım,
 *    uzatma, hızlı paylaşım ve bölge olayı açılamaz (`invisible_mode`); RTDB yazıları kurallarca reddedilir.
 *  - Görünür olunca hiçbir şey kendiliğinden açılmaz: kullanıcı anlık görüntüden tek tek seçer (varsayılan: hiçbiri).
 *    Seçilen, süresi dolmamış ve hâlâ arkadaş + `location_view` izni olan alıcılarla paylaşım ESKİ bitiş saatine kadar
 *    yeniden başlar (`custom_until`, süresizse `indefinite`).
 *  - SOS görünmezken de gider; o anda görünmez mod geri yükleme yapmadan kapanır.
 */
import { z } from 'zod';
import { DURATION_LIMITS, type DurationChoice, type ShareMode } from './duration';
import { formatExpiryLabel } from './format';
import type { ShareStatus, UserId } from './model';
import { deviceOffset, type EpochMs, type OffsetFn } from './time';

export interface InvisibleSnapshotEntry {
  receiver_id: UserId;
  share_mode: ShareMode;
  /** null = süresiz. */
  expires_at: EpochMs | null;
  started_at: EpochMs;
}

/** `users/{uid}.invisible` (yalnızca sahibi okur, yalnızca callable yazar). */
export interface InvisibleState {
  on: boolean;
  since: EpochMs | null;
  /** Görünmez olurken durdurulan giden paylaşımlar (görünür olunca seçilebilir). */
  snapshot: InvisibleSnapshotEntry[];
  /** Kapatılan QR bağlantısı sayısı (bilgi amaçlı; bağlantılar geri yüklenmez). */
  links_ended: number;
}

/** Anlık görüntüdeki en çok kayıt (arkadaş sayısıyla zaten sınırlı). */
export const INVISIBLE_SNAPSHOT_MAX = 100;

/** Geri yüklemede bundan az süresi kalan paylaşım yeniden başlatılmaz (`custom_until` en az 5 dk ister). */
export const INVISIBLE_RESTORE_MIN_REMAINING_MS = DURATION_LIMITS.minCustomMs;

export function isInvisible(profile: { invisible?: InvisibleState | null } | null | undefined): boolean {
  return profile?.invisible?.on === true;
}

export interface SnapshotSourceShare {
  receiver_id: UserId;
  status: ShareStatus;
  share_mode: ShareMode;
  started_at: EpochMs;
  expires_at: EpochMs | null;
}

/**
 * Görünmez olurken alınacak anlık görüntü: etkin (ve `now` verildiyse süresi dolmamış) giden paylaşımlar, alıcı başına
 * bir kayıt. Zaten görünmezken tekrar çağrılırsa sunucu eski anlık görüntüyü KORUR (bu fonksiyonu çağırmaz).
 */
export function planInvisibleOn(outgoingShares: readonly SnapshotSourceShare[], now?: EpochMs): InvisibleSnapshotEntry[] {
  const seen = new Set<UserId>();
  const out: InvisibleSnapshotEntry[] = [];
  for (const s of outgoingShares) {
    if (s.status !== 'active' || seen.has(s.receiver_id)) continue;
    if (now !== undefined && s.expires_at !== null && s.expires_at <= now) continue;
    seen.add(s.receiver_id);
    out.push({ receiver_id: s.receiver_id, share_mode: s.share_mode, expires_at: s.expires_at, started_at: s.started_at });
    if (out.length >= INVISIBLE_SNAPSHOT_MAX) break;
  }
  return out;
}

/** Geri yüklenebilecek kayıtlar: süresiz olanlar ve en az 5 dk süresi kalanlar. */
export function restorableEntries(snapshot: readonly InvisibleSnapshotEntry[], now: EpochMs): InvisibleSnapshotEntry[] {
  return snapshot.filter((e) => e.expires_at === null || e.expires_at - now >= INVISIBLE_RESTORE_MIN_REMAINING_MS);
}

/** Eski bitiş saatine kadar: `custom_until` (süresizse `indefinite`). */
export function restoreDuration(entry: Pick<InvisibleSnapshotEntry, 'expires_at'>): DurationChoice {
  return entry.expires_at === null ? { kind: 'indefinite' } : { kind: 'custom_until', until: entry.expires_at };
}

export interface InvisibleRestorePlan {
  restore: { entry: InvisibleSnapshotEntry; duration: DurationChoice }[];
  /** İstenen ama geri yüklenmeyen alıcılar (anlık görüntüde yok, süresi doldu ya da artık izin / arkadaşlık yok). */
  skipped_receiver_ids: UserId[];
}

/**
 * `invisible_set(false)`: yalnızca `requestedIds` içindeki, anlık görüntüde olan, süresi dolmamış ve `canRestore`
 * (sunucu: arkadaş + `location_view`, bkz. `canShareLocation`) onaylı alıcılar. Seçim yoksa hiçbir şey başlamaz.
 */
export function planInvisibleRestore(
  snapshot: readonly InvisibleSnapshotEntry[],
  requestedIds: readonly UserId[] | undefined,
  now: EpochMs,
  canRestore: (receiverId: UserId) => boolean = () => true,
): InvisibleRestorePlan {
  const restorable = new Map(restorableEntries(snapshot, now).map((e) => [e.receiver_id, e]));
  const restore: InvisibleRestorePlan['restore'] = [];
  const skipped_receiver_ids: UserId[] = [];
  for (const id of new Set(requestedIds ?? [])) {
    const entry = restorable.get(id);
    if (entry && canRestore(id)) restore.push({ entry, duration: restoreDuration(entry) });
    else skipped_receiver_ids.push(id);
  }
  return { restore, skipped_receiver_ids };
}

// --- callable ---------------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** `invisible_set`: `invisible: true` onay olmadan da çalışır (koruyucu işlem). */
export const InvisibleSetRequestSchema = z.object({
  op_id: z.uuid(),
  invisible: z.boolean(),
  /** Yalnızca kapatırken: yeniden başlatılacak alıcılar (varsayılan hiçbiri). */
  restore_receiver_ids: z.array(uid).max(INVISIBLE_SNAPSHOT_MAX).optional(),
});
export type InvisibleSetRequest = z.input<typeof InvisibleSetRequestSchema>;

export interface InvisibleSetResponse {
  invisible: boolean;
  restored_receiver_ids: UserId[];
  skipped_receiver_ids: UserId[];
  server_now: EpochMs;
}

// --- metinler -----------------------------------------------------------------------------------

export const INVISIBLE_TEXT = {
  banner: 'Görünmezsin · kimse konumunu görmüyor',
  /** Süren SOS görünmezlikten etkilenmez (SOS görünmezliği geçersiz kılar, §4): şerit bunu söyler. */
  bannerSos: 'Görünmezsin · yalnızca acil kişilerin SOS konumunu görüyor',
  bannerAction: 'Görünür ol',
  cardTitle: 'Görünmez ol',
  cardBodyOff: 'Açınca tüm paylaşımların durur ve kimse konumunu göremez.',
  cardBodyOn: 'Şu an görünmezsin. Kimse konumunu görmüyor.',
  cardBodyOnSos: 'Şu an görünmezsin. Süren SOS uyarın kapanana kadar acil durum kişilerin SOS konumunu görmeye devam eder.',
  sosNote: 'Süren SOS uyarın sürer: acil durum kişilerin SOS konumunu görmeye devam eder.',
  confirmTitle: 'Görünmez olunsun mu?',
  /** "3 paylaşımın duracak, QR bağlantıların kapanacak, …" (+ süren SOS varsa SOS notu) */
  confirmBody: (activeShares: number, sosActive = false): string =>
    `${activeShares > 0 ? `${activeShares} paylaşımın duracak, ` : ''}QR bağlantıların kapanacak, arka planda konum gönderilmeyecek. Arkadaşlarına görünmez olduğun söylenmez.${sosActive ? ' Süren SOS uyarın sürer: acil durum kişilerin SOS konumunu görmeye devam eder.' : ''}`,
  confirmAction: 'Görünmez ol',
  cancel: 'Vazgeç',
  shareBlockedTitle: 'Görünmez moddasın',
  shareBlockedBody: 'Paylaşmak için önce görünür ol.',
  restoreTitle: 'Önceki paylaşımların',
  restoreBody: 'Hiçbiri kendiliğinden başlamaz. Yeniden başlatmak istediklerini seç.',
  /** "Seçilenleri yeniden başlat (2)" */
  restoreAction: (selected: number): string => `Seçilenleri yeniden başlat (${selected})`,
  restoreNone: 'Kimseyle paylaşma',
  restoreEmpty: 'Yeniden başlatılabilecek paylaşım yok.',
  avatarBadgeLabel: 'Görünmez',
} as const;

/** Geri yükleme satırı: "17:30'a kadar · 2 sa kaldı" · "Süresiz · siz durdurana kadar". */
export function invisibleRestoreLabel(entry: InvisibleSnapshotEntry, now: EpochMs, offsetAt: OffsetFn = deviceOffset): string {
  return formatExpiryLabel({ share_mode: entry.share_mode, expires_at: entry.expires_at }, now, offsetAt);
}
