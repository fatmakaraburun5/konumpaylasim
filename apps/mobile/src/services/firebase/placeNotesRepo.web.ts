/** Web demo: `place_notes` okuyucusu → bellek içi demo sunucusu (native `placeNotesRepo.ts` ile aynı API). */
import type { PlaceNote, UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { placeNoteFromDoc } from './f4Docs';

export function listenPlaceNotes(uid: UserId, cb: (notes: PlaceNote[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().placeNotesFor(uid),
    (list) => {
      const out: PlaceNote[] = [];
      for (const d of list) {
        const n = placeNoteFromDoc(String((d as { note_id?: unknown }).note_id ?? ''), d);
        if (n) out.push(n);
      }
      cb(out);
    },
  );
}
