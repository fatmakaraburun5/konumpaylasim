/**
 * Firebase RTDB veri kaynağı. Kimlik doğrulama YOK: `link_live/{hash}` okuma kuralı yalnızca
 * `link_acl/{hash}` aktif ve süresi dolmamışken izin verir (token = yetki, özeti = yol).
 * Yalnızca `firebase/app` + `firebase/database` yüklenir (Auth, Analytics vb. paket dışında).
 */
import { getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { connectDatabaseEmulator, getDatabase, onValue, ref } from 'firebase/database';
import { linkLivePath, isLinkTokenHash } from '@konum/core';
import type { FirebaseWebConfig } from '../env';
import { isPermissionDenied, type LinkLiveSource } from './source';

const APP_NAME = 'konum-web';

export function createFirebaseSource(cfg: FirebaseWebConfig): LinkLiveSource {
  const options: FirebaseOptions = { projectId: cfg.projectId, databaseURL: cfg.databaseURL };
  if (cfg.apiKey) options.apiKey = cfg.apiKey;
  if (cfg.appId) options.appId = cfg.appId;
  const existing = getApps().find((a) => a.name === APP_NAME);
  const app = existing ?? initializeApp(options, APP_NAME);
  const db = getDatabase(app);
  // Emülatöre bağlanma yalnızca ilk kurulumda (bağlantı açıldıktan sonra çağrı hata verir).
  if (cfg.emulator && !existing) connectDatabaseEmulator(db, cfg.emulator.host, cfg.emulator.port);

  return {
    subscribe(tokenHash, h) {
      if (!isLinkTokenHash(tokenHash)) {
        h.denied();
        return () => {};
      }
      return onValue(
        ref(db, linkLivePath(tokenHash)),
        (snap) => h.value(snap.val()),
        // Hata nesnesi yolu (özet) içerir; günlüğe YAZILMAZ.
        (err) => (isPermissionDenied(err) ? h.denied() : h.failed()),
      );
    },
    onConnection(cb) {
      return onValue(ref(db, '.info/connected'), (snap) => cb(snap.val() === true));
    },
    onServerTimeOffset(cb) {
      return onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
        const v = Number(snap.val());
        cb(Number.isFinite(v) ? v : 0);
      });
    },
  };
}
