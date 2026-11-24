/**
 * Web demo: Firebase başlatma yok. Tüm "Firebase" çağrıları bellek içi demo sunucusuna gider
 * (bkz. src/demo/server). Native `init.ts` ile aynı dışa aktarımlar.
 */
import { demoServer } from '../../demo/server';

/** Cloud Functions bölgesi (backend: europe-west1). Web demoda yalnızca bilgi amaçlı. */
export const FUNCTIONS_REGION = 'europe-west1';

let ready: Promise<void> | null = null;

export function ensureFirebase(): Promise<void> {
  if (!ready) {
    // Demo sunucusu ilk erişimde kurulur (kalıcı durum yüklenir / dünya tohumlanır, botlar yürür).
    demoServer();
    ready = Promise.resolve();
  }
  return ready;
}
