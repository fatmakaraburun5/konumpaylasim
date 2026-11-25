/**
 * Faz 8: görünmez mod arayüzünün saf mantığı (docs/PHASE8.md §5.2–§5.3).
 *
 *  - Görünür olurken geri yükleme listesi: anlık görüntüdeki, hâlâ geri yüklenebilir paylaşımlar (kişi, bitiş saati,
 *    kalan süre). Varsayılan seçim BOŞTUR: hiçbir paylaşım kendiliğinden başlamaz.
 *  - Sonuç: yeniden başlayanlar ve başlatılamayanlar (neden yalnızca kendi tarafımızdan: izin, arkadaşlık, süre).
 *  - Görünmez olurken onay metni: süren paylaşımdaki alıcı sayısı (core `INVISIBLE_TEXT.confirmBody`).
 */
import { INVISIBLE_TEXT, invisibleRestoreLabel, type EpochMs, type InvisibleSnapshotEntry, type OffsetFn, type ShareSession, type UserId } from '@konum/core';

export interface RestoreRow {
  receiverId: UserId;
  name: string;
  /** "17:30'a kadar · 2 sa kaldı" · "Süresiz · siz durdurana kadar". */
  label: string;
}

export function restoreRows(
  entries: readonly InvisibleSnapshotEntry[],
  names: Readonly<Record<UserId, string>>,
  now: EpochMs,
  offsetAt?: OffsetFn,
): RestoreRow[] {
  return entries.map((e) => ({
    receiverId: e.receiver_id,
    name: names[e.receiver_id] ?? 'Arkadaşın',
    label: invisibleRestoreLabel(e, now, offsetAt),
  }));
}

/** Varsayılan: hiçbiri seçili değil. */
export function initialRestoreSelection(): ReadonlySet<UserId> {
  return new Set();
}

export function toggleRestore(selected: ReadonlySet<UserId>, id: UserId): ReadonlySet<UserId> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Yalnızca listede hâlâ duran (geri yüklenebilir) seçimler gönderilir. */
export function restoreRequestIds(selected: ReadonlySet<UserId>, rows: readonly RestoreRow[]): UserId[] {
  return rows.filter((r) => selected.has(r.receiverId)).map((r) => r.receiverId);
}

export type SkipReason = 'not_friend' | 'no_grant' | 'expired';

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  not_friend: 'artık arkadaş değilsiniz',
  no_grant: 'konum iznini kapatmışsın',
  expired: 'süresi doldu',
};

/** Neden yalnızca bizim tarafımızdan çıkarılır (karşı tarafın durumu söylenmez). */
export function skipReason(id: UserId, ctx: { isFriend: (id: UserId) => boolean; iGrantLocation: (id: UserId) => boolean }): SkipReason {
  if (!ctx.isFriend(id)) return 'not_friend';
  if (!ctx.iGrantLocation(id)) return 'no_grant';
  return 'expired';
}

export interface RestoreOutcomeView {
  restored: string | null;
  skipped: { id: UserId; text: string }[];
}

export function restoreOutcome(
  res: { restoredReceiverIds: readonly UserId[]; skippedReceiverIds: readonly UserId[] },
  names: Readonly<Record<UserId, string>>,
  reasonOf: (id: UserId) => SkipReason,
): RestoreOutcomeView {
  const nameOf = (id: UserId) => names[id] ?? 'Arkadaşın';
  return {
    restored: res.restoredReceiverIds.length ? `Yeniden başladı: ${res.restoredReceiverIds.map(nameOf).join(', ')}` : null,
    skipped: res.skippedReceiverIds.map((id) => ({ id, text: `${nameOf(id)} · ${SKIP_REASON_TEXT[reasonOf(id)]}` })),
  };
}

const RUNNING_PHASES = new Set<ShareSession['phase']>(['starting', 'active', 'expiring_soon', 'extending', 'stopping']);

/** Görünmez olunca duracak paylaşımların alıcı sayısı. */
export function activeShareCount(sessions: readonly Pick<ShareSession, 'phase' | 'active_receiver_ids'>[]): number {
  const ids = new Set<UserId>();
  for (const s of sessions) if (RUNNING_PHASES.has(s.phase)) for (const id of s.active_receiver_ids) ids.add(id);
  return ids.size;
}

/** `sosActive`: süren SOS'um var → SOS'un sürdüğü (acil kişilerin konumu görmeye devam ettiği) söylenir. */
export function invisibleConfirmBody(sessions: readonly Pick<ShareSession, 'phase' | 'active_receiver_ids'>[], sosActive = false): string {
  return INVISIBLE_TEXT.confirmBody(activeShareCount(sessions), sosActive);
}
