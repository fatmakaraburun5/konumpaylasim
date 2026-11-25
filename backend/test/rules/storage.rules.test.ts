/**
 * Faz 6: Storage kuralları (avatars/{uid}/{sürüm}.jpg + {sürüm}_160.jpg). Yalnızca sahibi, yalnızca core
 * AVATAR_FILE_RE adlarıyla, yalnızca image/jpeg ve boyut sınırında yazar; başkası okuyamaz / silemez / listeleyemez.
 */
import { randomUUID } from 'node:crypto';
import { type RulesTestEnvironment, assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { AVATAR_LIMITS, avatarObjectPaths } from '@konum/core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { STORAGE_RULES } from '../helpers/emulator';
import { HOST, PROJECT_ID } from '../helpers/env';

let env: RulesTestEnvironment;
const A = `a${randomUUID().slice(0, 8)}`;
const B = `b${randomUUID().slice(0, 8)}`;
const V = 1_732_500_000_000;
const jpeg = { contentType: 'image/jpeg' };
const bytes = (n: number) => new Uint8Array(n);

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, storage: { host: HOST, port: 9199, rules: STORAGE_RULES } });
});

afterAll(async () => {
  await env?.cleanup();
});

const storageOf = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();

describe('storage.rules: avatarlar', () => {
  it('sahibi ana + küçük boyu yükler, meta verisini okur (getDownloadURL) ve siler', async () => {
    const { main, thumb } = avatarObjectPaths(A, V);
    const s = storageOf(A);
    await assertSucceeds(s.ref(main).put(bytes(1000), jpeg) as unknown as Promise<unknown>);
    await assertSucceeds(s.ref(thumb).put(bytes(1000), jpeg) as unknown as Promise<unknown>);
    await assertSucceeds(s.ref(main).getMetadata());
    await assertSucceeds(s.ref(thumb).delete());
  });

  it('başkası ve oturumsuz istemci yazamaz, okuyamaz, silemez, listeleyemez', async () => {
    const { main } = avatarObjectPaths(A, V + 1);
    await assertSucceeds(storageOf(A).ref(main).put(bytes(10), jpeg) as unknown as Promise<unknown>);
    await assertFails(storageOf(B).ref(avatarObjectPaths(A, V + 2).main).put(bytes(10), jpeg) as unknown as Promise<unknown>);
    await assertFails(storageOf(null).ref(avatarObjectPaths(A, V + 3).main).put(bytes(10), jpeg) as unknown as Promise<unknown>);
    await assertFails(storageOf(B).ref(main).getMetadata());
    await assertFails(storageOf(null).ref(main).getMetadata());
    await assertFails(storageOf(B).ref(main).delete());
    await assertFails(storageOf(A).ref(`avatars/${A}`).listAll());
  });

  it('yanlış ad / tür / boyut ve klasör dışı yollar reddedilir', async () => {
    const s = storageOf(A);
    await assertFails(s.ref(`avatars/${A}/a.jpg`).put(bytes(10), jpeg) as unknown as Promise<unknown>);
    await assertFails(s.ref(`avatars/${A}/${V}.png`).put(bytes(10), { contentType: 'image/png' }) as unknown as Promise<unknown>);
    await assertFails(s.ref(`avatars/${A}/${V}.jpg`).put(bytes(10), { contentType: 'image/png' }) as unknown as Promise<unknown>);
    await assertFails(s.ref(`avatars/${A}/${V}.jpg`).put(bytes(AVATAR_LIMITS.mainMaxBytes + 1), jpeg) as unknown as Promise<unknown>);
    await assertFails(s.ref(`avatars/${A}/${V}_160.jpg`).put(bytes(AVATAR_LIMITS.thumbMaxBytes + 1), jpeg) as unknown as Promise<unknown>);
    await assertFails(s.ref(`avatars/${A}/x/${V}.jpg`).put(bytes(10), jpeg) as unknown as Promise<unknown>);
    await assertFails(s.ref(`other/${A}/${V}.jpg`).put(bytes(10), jpeg) as unknown as Promise<unknown>);
  });
});
