/**
 * Faz 4: ping arayüzünün saf seçicileri (harita ve kayan kart aynı kuralı kullanır; testler de).
 */
import { isPingActive, type EpochMs, type Ping, type UserId } from '@konum/core';

/** Kayan kartta gösterilecek ping: kutudaki en yeni, kullanıcının kapatmadığı, süresi geçmemiş. */
export function pingToastItem(inbox: Record<string, Ping>, hidden: ReadonlySet<string>, now: EpochMs): Ping | null {
  let best: Ping | null = null;
  for (const p of Object.values(inbox)) {
    if (hidden.has(p.ping_id) || !isPingActive(p, now)) continue;
    if (!best || p.sent_at > best.sent_at) best = p;
  }
  return best;
}

/**
 * Haritadaki geçici "ping pinleri": konum taşıyan ve göndereni canlı konumla görünmeyen pingler. Aynı kişiden
 * birden çok ping varsa yalnızca en yenisi (tek pin).
 */
export function pingPins(inbox: Record<string, Ping>, liveSenders: ReadonlySet<UserId>, now: EpochMs): Ping[] {
  const bySender = new Map<UserId, Ping>();
  for (const p of Object.values(inbox)) {
    if (!p.location || liveSenders.has(p.from) || !isPingActive(p, now)) continue;
    const cur = bySender.get(p.from);
    if (!cur || p.sent_at > cur.sent_at) bySender.set(p.from, p);
  }
  return [...bySender.values()].sort((a, b) => a.sent_at - b.sent_at);
}

/** Kişi kartındaki "Gönderildi" geri bildiriminin süresi. */
export const PING_SENT_FEEDBACK_MS = 2_500;
/** Kayan kart bu süre sonra kendiliğinden gizlenir (ping kutuda ve haritada kalır). [Varsayım] */
export const PING_TOAST_AUTO_HIDE_MS = 12_000;
