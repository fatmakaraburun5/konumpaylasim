/**
 * Faz 9: arkadaş pinindeki ve kişi kartındaki rozetler — paketten (core `visibleProofRef`, `visibleDestination`,
 * `destBadgeText`). Saf; testte de kullanılır.
 *
 *  - 📷 anlık fotoğraf: `photo_id` + `photo_exp` (süresi geçmişse yok).
 *  - Hedef durumu: "Neredeyse vardı · Ev · ~1 dk" (near), "Ev konumuna vardı" (arrived), "Ev yolunda" (en_route).
 */
import { destBadgeText, visibleDestination, visibleProofRef, type DeliveredLocation, type DestState, type EpochMs } from '@konum/core';

export interface FriendBadge {
  photo: { photo_id: string; photo_exp: EpochMs } | null;
  dest: { text: string; state: DestState } | null;
}

export function friendBadge(loc: Pick<DeliveredLocation, 'photo_id' | 'photo_exp' | 'dest_name' | 'dest_state' | 'dest_eta'>, now: EpochMs): FriendBadge | null {
  const photo = visibleProofRef(loc, now);
  const d = visibleDestination(loc);
  const dest = d ? { text: destBadgeText(d.state, d.name, d.eta_min), state: d.state } : null;
  return photo || dest ? { photo, dest } : null;
}

/** shareId → rozetler (yalnızca rozeti olanlar). */
export function friendBadges(items: readonly { shareId: string; location: DeliveredLocation }[], now: EpochMs): Record<string, FriendBadge> {
  const out: Record<string, FriendBadge> = {};
  for (const f of items) {
    const b = friendBadge(f.location, now);
    if (b) out[f.shareId] = b;
  }
  return out;
}
