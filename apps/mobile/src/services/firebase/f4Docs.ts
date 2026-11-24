/**
 * Faz 4 Firestore belgeleri → core tipleri (saf; native ve web demo ortak, `linkDoc.ts` deseni).
 *
 *  - `place_notes/{note_id}` → core `PlaceNote` (`parsePlaceNote`), `sos_alerts/{sos_id}` → core `SosAlert`
 *    (`parseSosAlert`). Belgedeki `purge_at` (TTL Timestamp) gibi ek alanlar atılır.
 *  - Sözleşmeye göre zamanlar epoch ms'dir; savunma amaçlı Firestore `Timestamp` gelirse ms'ye çevrilir.
 *  - Bozuk belge sessizce atlanır (bir arkadaşın hatalı belgesi haritayı çökertmesin).
 */
import { parsePlaceNote, parseSosAlert, type PlaceNote, type SosAlert } from '@konum/core';

export const toMillis = (v: unknown): unknown => {
  if (v && typeof v === 'object') {
    const t = v as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
  }
  return v;
};

const withMillis = (raw: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...raw };
  for (const f of fields) if (f in out) out[f] = toMillis(out[f]);
  return out;
};

const NOTE_TIME_FIELDS = ['created_at', 'updated_at', 'expires_at'] as const;
const SOS_TIME_FIELDS = ['created_at', 'updated_at', 'resolved_at'] as const;

/** Belge kimliği belgede yoksa `id` kullanılır. */
export function placeNoteFromDoc(id: string, data: unknown): PlaceNote | null {
  if (!data || typeof data !== 'object') return null;
  return parsePlaceNote(withMillis({ note_id: id, ...(data as Record<string, unknown>) }, NOTE_TIME_FIELDS));
}

export function sosAlertFromDoc(id: string, data: unknown): SosAlert | null {
  if (!data || typeof data !== 'object') return null;
  const raw = withMillis({ sos_id: id, ...(data as Record<string, unknown>) }, SOS_TIME_FIELDS);
  const loc = raw.location;
  if (loc && typeof loc === 'object') raw.location = withMillis(loc as Record<string, unknown>, ['timestamp']);
  const acks = raw.acks;
  if (acks && typeof acks === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(acks as Record<string, unknown>)) out[k] = toMillis(v);
    raw.acks = out;
  } else raw.acks = {};
  return parseSosAlert(raw);
}

/** İki sorgunun (sahibi / görünür) sonuçları kimliğe göre birleştirilir. */
export function mergeById<T>(key: (t: T) => string, ...lists: readonly (readonly T[])[]): T[] {
  const m = new Map<string, T>();
  for (const l of lists) for (const t of l) m.set(key(t), t);
  return [...m.values()];
}
