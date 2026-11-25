/**
 * "Konum İste": Firestore `location_requests` okuyucusu (istemci YAZMAZ; tüm geçişler callable ile).
 *
 * Kural filtre değildir: iki sorgu (`requester_id == ben` → giden, `target_id == ben` → gelen) birleştirilir; ikisi de
 * ilk görüntüsünü verene kadar geri çağrı yapılmaz.
 */
import { PATHS, type UserId } from '@konum/core';
import { collection, getFirestore, onSnapshot, query, where, type QuerySnapshot } from '@react-native-firebase/firestore';
import { LocationRequestDocSchema, type LocationRequestDoc } from '../../lib/schemas';

function parse(snap: QuerySnapshot): LocationRequestDoc[] {
  const out: LocationRequestDoc[] = [];
  for (const d of snap.docs) {
    const r = LocationRequestDocSchema.safeParse(d.data());
    if (r.success) out.push(r.data);
    else if (__DEV__) console.warn('[konum] bozuk location_requests belgesi atlandı', d.id);
  }
  return out;
}

export function listenLocationRequests(uid: UserId, onDocs: (docs: LocationRequestDoc[]) => void, onError?: (e: Error) => void): () => void {
  const col = collection(getFirestore(), PATHS.requests);
  let outgoing: LocationRequestDoc[] | null = null;
  let incoming: LocationRequestDoc[] | null = null;
  const emit = () => {
    if (outgoing && incoming) onDocs([...outgoing, ...incoming]);
  };
  const u1 = onSnapshot(
    query(col, where('requester_id', '==', uid)),
    (s) => {
      outgoing = parse(s);
      emit();
    },
    (e) => onError?.(e),
  );
  const u2 = onSnapshot(
    query(col, where('target_id', '==', uid)),
    (s) => {
      incoming = parse(s);
      emit();
    },
    (e) => onError?.(e),
  );
  return () => {
    u1();
    u2();
  };
}
