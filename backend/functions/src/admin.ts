/**
 * Admin SDK'nın tembel (lazy) başlatılması. Cloud Functions'ta yapılandırma `FIREBASE_CONFIG`
 * ortam değişkeninden gelir; emülatör testleri de aynı değişkeni kurar (bkz. test/setup.ts).
 */
import { type App, deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Database, getDatabase } from 'firebase-admin/database';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { type Messaging, getMessaging } from 'firebase-admin/messaging';

let app: App | undefined;
let firestore: Firestore | undefined;

export function adminApp(): App {
  if (!app) app = getApps()[0] ?? initializeApp();
  return app;
}

export function db(): Firestore {
  if (!firestore) {
    firestore = getFirestore(adminApp());
    // Yanıtlar `ops` içinde saklanır; isteğe bağlı alanlar `undefined` olabilir.
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore;
}

export function rtdb(): Database {
  return getDatabase(adminApp());
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}

export function messaging(): Messaging {
  return getMessaging(adminApp());
}

/** Testler: açık RTDB/Firestore bağlantılarını kapatır (işlem asılı kalmasın). */
export async function closeAdmin(): Promise<void> {
  const apps = getApps();
  app = undefined;
  firestore = undefined;
  await Promise.all(apps.map((a) => deleteApp(a)));
}
