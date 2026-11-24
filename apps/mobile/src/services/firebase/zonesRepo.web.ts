/** Web demo: `users/{ben}/zones` + `zone_events` okuyucusu → bellek içi demo sunucusu (native `zonesRepo.ts` ile aynı API). */
import type { UserId, Zone, ZoneEventLog } from '@konum/core';
import { demoServer } from '../../demo/server';
import { zoneEventFromDoc, zoneFromDoc } from './f5Docs';

export function listenZones(uid: UserId, cb: (zones: Zone[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().zonesOf(uid),
    (list) => {
      const out: Zone[] = [];
      for (const d of list) {
        const z = zoneFromDoc(String((d as { zone_id?: unknown }).zone_id ?? ''), d);
        if (z) out.push(z);
      }
      cb(out);
    },
  );
}

export function listenZoneEvents(uid: UserId, max: number, cb: (events: ZoneEventLog[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().zoneEventsOf(uid, max),
    (list) => {
      const out: ZoneEventLog[] = [];
      for (const d of list) {
        const e = zoneEventFromDoc(d);
        if (e) out.push(e);
      }
      cb(out);
    },
  );
}
