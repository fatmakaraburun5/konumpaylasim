/**
 * Test süreci ortamı. `firebase emulators:exec` emülatör adreslerini zaten verir; burada yalnızca
 * eksikse varsayılanlar kurulur ve Admin SDK'nın (functions/src/admin.ts) aynı projeye ve
 * aynı RTDB ad alanına (demo projesinde ad alanı = proje kimliği, bkz. helpers/env.ts) bağlanması sağlanır.
 */
import { afterAll } from 'vitest';
import { closeAdmin } from '../functions/src/admin';
import { AUTH_HOST, DB_HOST, FIRESTORE_HOST, PROJECT_ID, RTDB_URL } from './helpers/env';

// Emülatörde GCE metadata sunucusu yok: kimlik bilgisi aramasını atla (yalnızca uyarıyı susturur).
process.env.METADATA_SERVER_DETECTION ??= 'none';
process.env.GCLOUD_PROJECT ??= PROJECT_ID;
process.env.FIRESTORE_EMULATOR_HOST ??= FIRESTORE_HOST;
process.env.FIREBASE_DATABASE_EMULATOR_HOST ??= DB_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= AUTH_HOST;
process.env.FIREBASE_CONFIG ??= JSON.stringify({ projectId: PROJECT_ID, databaseURL: RTDB_URL });

afterAll(async () => {
  await closeAdmin();
});
