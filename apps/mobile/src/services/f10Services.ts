/**
 * Faz 10 oturum servisleri: cihaz oturumları + kurtarma özeti dinleyicileri, cihaz heartbeat'i (en sık 5 dk; arka
 * plan konum yayını açılıp kapanınca hemen), "bu cihaz kapatıldı" algısı ve takvim eşlemesi.
 *
 * Oturum iptali dört yoldan algılanır (hangisi önce gelirse): sessiz `session_revoked` push'u, callable
 * `session_revoked` hatası, kendi `device_sessions` kaydımın "revoked" görünmesi ve RTDB yazım reddi (kural). Hepsi
 * `onSessionEvent` → `handleSessionRevoked`: arka plan konum görevi durur, yerel durum silinir, oturum kapanır.
 */
import { SECURITY_LIMITS, type UserId } from '@konum/core';
import { AppState } from 'react-native';
import { emitSessionEvent, onSessionEvent } from '../lib/sessionEvents';
import { authStore } from '../state/authStore';
import { calendarStore } from '../state/calendarStore';
import { clearBackgroundState } from '../state/persist';
import { securityStore } from '../state/securityStore';
import { currentDsid, signOutAuth } from './firebase/authClient';
import { deviceHeartbeat } from './firebase/callables';
import { listenDeviceSessions, listenRecoverySummary } from './firebase/devicesRepo';
import { locationEngine } from './location/ExpoLocationEngine';
import { resilientListener } from './resilientListener';

let revoking = false;

/** Bu cihazın oturumu kapatıldı: arka plan konumu durdur, yerel veriyi sil, çıkış yap (çıkış temizliği de çalışır). */
export async function handleSessionRevoked(): Promise<void> {
  if (revoking) return;
  revoking = true;
  try {
    securityStore.getState().markRevokedHere(true);
    await locationEngine.stopBackground().catch(() => undefined);
    await clearBackgroundState().catch(() => undefined);
    await signOutAuth().catch(() => undefined);
  } finally {
    revoking = false;
  }
}

onSessionEvent((e) => {
  if (e.kind === 'revoked') void handleSessionRevoked();
  else void authStore.getState().reRegisterDevice();
});

export interface F10ServiceContext {
  /** Arka plan konum yayını açık mı (paylaşım / QR hedefi var). */
  isPublishing: () => boolean;
}

export function startF10Services(uid: UserId, ctx: F10ServiceContext): () => void {
  let disposed = false;
  let lastBeat = 0;
  let lastPublishing: boolean | null = null;
  const unsubs: (() => void)[] = [];

  void currentDsid().then((d) => {
    if (!disposed) securityStore.getState().setMyDsid(d);
  });
  void calendarStore.getState().hydrate(uid);

  const listeners = [
    resilientListener('device_sessions', (h) =>
      listenDeviceSessions(
        uid,
        (docs) => {
          h.ok();
          securityStore.getState().setDevices(docs);
          const me = securityStore.getState().myDsid;
          const mine = me ? docs.find((d) => d.dsid === me) : undefined;
          if (mine?.status === 'revoked') emitSessionEvent({ kind: 'revoked', source: 'listener' });
        },
        h.error,
      ),
    ),
    resilientListener('recovery_summary', (h) =>
      listenRecoverySummary(
        uid,
        (s) => {
          h.ok();
          securityStore.getState().setRecovery(s);
        },
        h.error,
      ),
    ),
  ];

  const beat = (force = false) => {
    if (disposed) return;
    const publishing = ctx.isPublishing();
    const now = Date.now();
    if (!force && publishing === lastPublishing && now - lastBeat < SECURITY_LIMITS.heartbeatMinIntervalMs) return;
    lastBeat = now;
    lastPublishing = publishing;
    void deviceHeartbeat({ publishing, app_version: null }).catch(() => undefined);
  };
  const t = setInterval(() => beat(), 30_000);
  // İlk nabız bir sonraki turda: çağıran (sharingCoordinator) yayın durumunu henüz kurmamış olabilir.
  const first = setTimeout(() => beat(true), 0);
  unsubs.push(() => clearTimeout(first));
  const app = AppState.addEventListener('change', (st) => {
    if (st === 'active') beat();
  });
  unsubs.push(() => clearInterval(t), () => app.remove());

  return () => {
    disposed = true;
    for (const l of listeners) l.dispose();
    for (const u of unsubs) u();
  };
}

export async function resetF10State(): Promise<void> {
  securityStore.getState().reset();
  await calendarStore.getState().reset();
}
