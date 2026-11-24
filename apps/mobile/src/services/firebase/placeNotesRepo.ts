/**
 * Faz 4: Firestore `place_notes` okuyucusu (istemci YAZMAZ; `place_note_upsert` / `place_note_delete` callable'ları).
 * Kural filtre değildir, iki kısıtlı sorgu: sahibi `owner_id == ben`, okuyucu `visible_to array-contains ben`.
 * İki sorgu da en az bir kez yanıt verince birleşik liste iletilir (süresi geçenler okuma tarafında gizlenir).
 */
import { PATHS, type PlaceNote, type UserId } from '@konum/core';
import { collection, getFirestore, onSnapshot, query, where, type QuerySnapshot } from '@react-native-firebase/firestore';
import { mergeById, placeNoteFromDoc } from './f4Docs';

function parse(snap: QuerySnapshot): PlaceNote[] {
  const out: PlaceNote[] = [];
  for (const d of snap.docs) {
    const n = placeNoteFromDoc(d.id, d.data());
    if (n) out.push(n);
    else if (__DEV__) console.warn('[konum] bozuk place_notes belgesi atlandı', d.id);
  }
  return out;
}

export function listenPlaceNotes(uid: UserId, cb: (notes: PlaceNote[]) => void, onError?: (e: Error) => void): () => void {
  const db = getFirestore();
  const parts: { mine: PlaceNote[] | null; shared: PlaceNote[] | null } = { mine: null, shared: null };
  const emit = () => {
    if (parts.mine && parts.shared) cb(mergeById((n) => n.note_id, parts.shared, parts.mine));
  };
  const unMine = onSnapshot(
    query(collection(db, PATHS.placeNotes), where('owner_id', '==', uid)),
    (snap) => {
      parts.mine = parse(snap);
      emit();
    },
    (e) => onError?.(e),
  );
  const unShared = onSnapshot(
    query(collection(db, PATHS.placeNotes), where('visible_to', 'array-contains', uid)),
    (snap) => {
      parts.shared = parse(snap);
      emit();
    },
    (e) => onError?.(e),
  );
  return () => {
    unMine();
    unShared();
  };
}
