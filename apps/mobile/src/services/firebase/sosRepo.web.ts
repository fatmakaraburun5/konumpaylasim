/** Web demo: `sos_alerts` okuyucusu → bellek içi demo sunucusu (native `sosRepo.ts` ile aynı API). */
import type { SosAlert, UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { sosAlertFromDoc } from './f4Docs';

export interface SosHandlers {
  onSent: (alerts: SosAlert[]) => void;
  onReceived: (alerts: SosAlert[]) => void;
  onError?: (e: Error) => void;
}

const parseAll = (list: readonly unknown[]): SosAlert[] => {
  const out: SosAlert[] = [];
  for (const d of list) {
    const a = sosAlertFromDoc(String((d as { sos_id?: unknown }).sos_id ?? ''), d);
    if (a) out.push(a);
  }
  return out;
};

export function listenSosAlerts(uid: UserId, h: SosHandlers): () => void {
  const unSent = demoServer().subscribe(
    () => demoServer().sosAlertsWhere('sender_id', uid),
    (list) => h.onSent(parseAll(list)),
  );
  const unReceived = demoServer().subscribe(
    () => demoServer().sosAlertsWhere('recipient_ids', uid),
    (list) => h.onReceived(parseAll(list)),
  );
  return () => {
    unSent();
    unReceived();
  };
}
