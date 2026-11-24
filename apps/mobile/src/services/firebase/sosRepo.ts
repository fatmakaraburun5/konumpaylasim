/**
 * Faz 4: Firestore `sos_alerts` okuyucusu (istemci YAZMAZ; `sos_*` callable'ları).
 * İki kısıtlı sorgu: gönderdiklerim `sender_id == ben`, bana gelenler `recipient_ids array-contains ben`.
 * Tam koordinat push'ta değil, YALNIZCA bu belgede bulunur (kural: gönderen ve alıcılar okur).
 */
import { PATHS, type SosAlert, type UserId } from '@konum/core';
import { collection, getFirestore, onSnapshot, query, where, type QuerySnapshot } from '@react-native-firebase/firestore';
import { sosAlertFromDoc } from './f4Docs';

export interface SosHandlers {
  onSent: (alerts: SosAlert[]) => void;
  onReceived: (alerts: SosAlert[]) => void;
  onError?: (e: Error) => void;
}

function parse(snap: QuerySnapshot): SosAlert[] {
  const out: SosAlert[] = [];
  for (const d of snap.docs) {
    const a = sosAlertFromDoc(d.id, d.data());
    if (a) out.push(a);
    else if (__DEV__) console.warn('[konum] bozuk sos_alerts belgesi atlandı', d.id);
  }
  return out;
}

export function listenSosAlerts(uid: UserId, h: SosHandlers): () => void {
  const db = getFirestore();
  const unSent = onSnapshot(
    query(collection(db, PATHS.sosAlerts), where('sender_id', '==', uid)),
    (snap) => h.onSent(parse(snap)),
    (e) => h.onError?.(e),
  );
  const unReceived = onSnapshot(
    query(collection(db, PATHS.sosAlerts), where('recipient_ids', 'array-contains', uid)),
    (snap) => h.onReceived(parse(snap)),
    (e) => h.onError?.(e),
  );
  return () => {
    unSent();
    unReceived();
  };
}
