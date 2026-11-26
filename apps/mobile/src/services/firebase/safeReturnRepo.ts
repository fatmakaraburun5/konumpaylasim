/**
 * Faz 9: Firestore `safe_returns` okuyucusu (istemci YAZMAZ; `safe_return_*` callable'ları). Kural: yalnızca sahibi
 * okur (`owner_id == auth.uid`). Tek eşitlik sorgusu (bileşik dizin gerekmez); kayıtlar bitişten 7 gün sonra TTL ile
 * silindiği için liste kısadır. Durum geçişleri (alarm, varış, iptal) aynı dinleyiciyle gelir.
 * Web demosu aynı adla `safeReturnRepo.web.ts` sağlar.
 */
import { parseSafeReturn, PATHS, type SafeReturnDoc, type UserId } from '@konum/core';
import { collection, doc, getDocFromServer, getFirestore, onSnapshot, query, where } from '@react-native-firebase/firestore';

/** [Varsayım] Tek kayıt okuması en çok bu kadar beklenir (bildirim eylemi / check-in yedeği). */
const FETCH_TIMEOUT_MS = 6_000;

/**
 * Tek kaydı SUNUCUDAN okur (dinleyiciyi beklemeden): "Güvendeyim" `safe_return_not_active` döndüğünde alarmın
 * açılıp açılmadığını ve SOS kimliğini öğrenmek için. Başarısız / zaman aşımı / yok → null.
 */
export async function fetchSafeReturn(id: string): Promise<SafeReturnDoc | null> {
  const read = getDocFromServer(doc(getFirestore(), PATHS.safeReturns, id))
    .then((snap) => (snap.exists() ? parseSafeReturn({ safe_return_id: snap.id, ...snap.data() }) : null))
    .catch(() => null);
  return Promise.race([read, new Promise<null>((r) => setTimeout(() => r(null), FETCH_TIMEOUT_MS))]);
}

export function listenSafeReturns(uid: UserId, onDocs: (docs: SafeReturnDoc[]) => void, onError?: (e: Error) => void): () => void {
  return onSnapshot(
    query(collection(getFirestore(), PATHS.safeReturns), where('owner_id', '==', uid)),
    (snap) => {
      const out: SafeReturnDoc[] = [];
      for (const d of snap.docs) {
        const doc = parseSafeReturn({ safe_return_id: d.id, ...d.data() });
        if (doc) out.push(doc);
        else if (__DEV__) console.warn('[konum] bozuk safe_returns belgesi atlandı', d.id);
      }
      onDocs(out);
    },
    (e) => onError?.(e),
  );
}
