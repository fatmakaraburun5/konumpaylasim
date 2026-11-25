/**
 * Faz 5 Firestore belgeleri → core tipleri (saf; native ve web demo ortak, `f4Docs.ts` deseni).
 *
 *  - `users/{uid}/zones/{zone_id}` → core `Zone` (`parseZone`), `meetups/{meetup_id}` → core `Meetup` (`parseMeetup`),
 *    `users/{uid}/zone_events/{id}` → core `ZoneEventLog`. `purge_at` (TTL Timestamp) gibi ek alanlar atılır.
 *  - Sözleşmeye göre zamanlar epoch ms'dir; savunma amaçlı Firestore `Timestamp` gelirse ms'ye çevrilir.
 *  - Bozuk belge sessizce atlanır.
 */
import { parseMeetup, parseZone, ZONE_TRIGGERS, type Meetup, type Zone, type ZoneEventLog, type ZoneTrigger } from '@konum/core';
import { toMillis } from './f4Docs';

const withMillis = (raw: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...raw };
  for (const f of fields) if (f in out) out[f] = toMillis(out[f]);
  return out;
};

export function zoneFromDoc(id: string, data: unknown): Zone | null {
  if (!data || typeof data !== 'object') return null;
  return parseZone(withMillis({ zone_id: id, ...(data as Record<string, unknown>) }, ['created_at', 'updated_at']));
}

export function meetupFromDoc(id: string, data: unknown): Meetup | null {
  if (!data || typeof data !== 'object') return null;
  const raw = withMillis({ meetup_id: id, ...(data as Record<string, unknown>) }, ['created_at', 'expires_at', 'meet_at']);
  if (!raw.responses || typeof raw.responses !== 'object') raw.responses = {};
  return parseMeetup(raw);
}

// Faz 8: `invisible` = olay anında görünmezdim (bildirim gitmedi).
const SUPPRESSED = new Set(['cooldown', 'stale', 'outside_window', 'disabled', 'daily_limit', 'invisible']);

export function zoneEventFromDoc(data: unknown): ZoneEventLog | null {
  if (!data || typeof data !== 'object') return null;
  const r = withMillis(data as Record<string, unknown>, ['occurred_at']);
  if (typeof r.zone_id !== 'string' || typeof r.occurred_at !== 'number') return null;
  if (!(ZONE_TRIGGERS as readonly string[]).includes(String(r.transition))) return null;
  const suppressed = typeof r.suppressed === 'string' && SUPPRESSED.has(r.suppressed) ? (r.suppressed as ZoneEventLog['suppressed']) : null;
  return {
    zone_id: r.zone_id,
    transition: r.transition as ZoneTrigger,
    occurred_at: r.occurred_at,
    notified: typeof r.notified === 'number' ? r.notified : 0,
    suppressed,
  };
}
