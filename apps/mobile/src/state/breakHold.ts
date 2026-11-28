/**
 * Faz 12: konum hattının (başsız da) mola kararı. Bilerek hafif: depo / React içermez, yalnızca diskteki kaydı okur.
 *
 * Mola başlarken durum notu ("☕ Moladayım") içeren son paketin gidebilmesi için kayıt `BREAK_GRACE_MS` sonra devreye
 * girer; `until` geçince kendiliğinden biter (zamanlayıcı gerekmez).
 */
import type { EpochMs, UserId } from '@konum/core';
import { loadBreak } from './persist';

export const BREAK_GRACE_MS = 5_000;

export async function breakHoldsPublishing(uid: UserId, now: EpochMs): Promise<boolean> {
  const b = await loadBreak();
  return !!b && b.uid === uid && now >= b.started_at + BREAK_GRACE_MS && now < b.until;
}
