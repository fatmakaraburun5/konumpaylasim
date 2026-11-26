/** Web demo: cihaz oturumları + kurtarma özeti → bellek içi demo sunucusu (native `devicesRepo.ts` ile aynı API). */
import { EMPTY_RECOVERY, parseDeviceSession, type DeviceSessionDoc, type RecoverySummary, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';

export function listenDeviceSessions(uid: UserId, onDocs: (docs: DeviceSessionDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().deviceSessionsOf(uid),
    (list) => onDocs(list.map((d) => parseDeviceSession(d)).filter((d): d is DeviceSessionDoc => d !== null)),
  );
}

export function listenRecoverySummary(uid: UserId, onDoc: (s: RecoverySummary) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().recoverySummaryOf(uid),
    (s) => onDoc(s ?? EMPTY_RECOVERY),
  );
}
