/**
 * Faz 5: Firestore `users/{ben}/zones` ve `users/{ben}/zone_events` okuyucusu (istemci YAZMAZ; `zone_upsert` /
 * `zone_delete` / `zone_event_report` callable'ları). Kural: yalnızca sahibi okur (yol uid'e bağlı).
 */
import { PATHS, type UserId, type Zone, type ZoneEventLog } from '@konum/core';
import { collection, getFirestore, limit, onSnapshot, orderBy, query } from '@react-native-firebase/firestore';
import { zoneEventFromDoc, zoneFromDoc } from './f5Docs';

export function listenZones(uid: UserId, cb: (zones: Zone[]) => void, onError?: (e: Error) => void): () => void {
  return onSnapshot(
    collection(getFirestore(), PATHS.zones(uid)),
    (snap) => {
      const out: Zone[] = [];
      for (const d of snap.docs) {
        const z = zoneFromDoc(d.id, d.data());
        if (z) out.push(z);
        else if (__DEV__) console.warn('[konum] bozuk zones belgesi atlandı', d.id);
      }
      cb(out);
    },
    (e) => onError?.(e),
  );
}

/** Son bölge olayları (en yeni önde, ≤ `max`). */
export function listenZoneEvents(uid: UserId, max: number, cb: (events: ZoneEventLog[]) => void, onError?: (e: Error) => void): () => void {
  return onSnapshot(
    query(collection(getFirestore(), PATHS.zoneEvents(uid)), orderBy('occurred_at', 'desc'), limit(max)),
    (snap) => {
      const out: ZoneEventLog[] = [];
      for (const d of snap.docs) {
        const e = zoneEventFromDoc(d.data());
        if (e) out.push(e);
      }
      cb(out);
    },
    (e) => onError?.(e),
  );
}
