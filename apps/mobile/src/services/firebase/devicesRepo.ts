/**
 * Faz 10: kendi cihaz oturumlarım (`device_sessions where owner_id == uid`) ve kurtarma özeti
 * (`users/{uid}/security/recovery`). İstemci YAZMAZ (callable'lar). Kural: oturum kayıtları iptal edilmiş cihaz da
 * okuyabilir (kendi kaydının "revoked" olduğunu görüp kapanması için). Web demosu `devicesRepo.web.ts`.
 */
import { EMPTY_RECOVERY, PATHS, RecoverySummarySchema, parseDeviceSession, type DeviceSessionDoc, type RecoverySummary, type UserId } from '@konum/core';
import { collection, doc, getFirestore, onSnapshot, query, where } from '@react-native-firebase/firestore';

export function listenDeviceSessions(uid: UserId, onDocs: (docs: DeviceSessionDoc[]) => void, onError?: (e: Error) => void): () => void {
  return onSnapshot(
    query(collection(getFirestore(), PATHS.deviceSessions), where('owner_id', '==', uid)),
    (snap) => {
      const out: DeviceSessionDoc[] = [];
      for (const d of snap.docs) {
        const v = parseDeviceSession({ dsid: d.id, ...d.data() });
        if (v) out.push(v);
      }
      onDocs(out);
    },
    (e) => onError?.(e),
  );
}

export function listenRecoverySummary(uid: UserId, onDoc: (s: RecoverySummary) => void, onError?: (e: Error) => void): () => void {
  return onSnapshot(
    doc(getFirestore(), PATHS.recoverySummary(uid)),
    (snap) => {
      const r = snap.exists() ? RecoverySummarySchema.safeParse(snap.data()) : null;
      onDoc(r?.success ? r.data : EMPTY_RECOVERY);
    },
    (e) => onError?.(e),
  );
}
