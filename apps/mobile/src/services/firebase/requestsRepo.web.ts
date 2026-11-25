/** Web demo: `location_requests` okuyucusu → bellek içi demo sunucusu (iki yön, aynı şemadan geçer). */
import type { UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { LocationRequestDocSchema, type LocationRequestDoc } from '../../lib/schemas';

export function listenLocationRequests(uid: UserId, onDocs: (docs: LocationRequestDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().locationRequestsOf(uid),
    (list) => {
      const out: LocationRequestDoc[] = [];
      for (const d of list) {
        const r = LocationRequestDocSchema.safeParse(d);
        if (r.success) out.push(r.data);
      }
      onDocs(out);
    },
  );
}
