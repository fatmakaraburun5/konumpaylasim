/**
 * Faz 9 (native): anlık fotoğraf önbelleğinin dosya deposu — `<önbellek>/proofs/` (expo-file-system).
 * Önbellek dizini cihaz yedeğine girmez; dosyalar süre dolunca / çıkışta `cache.ts` tarafından silinir.
 * Web demosu aynı adla `fileStore.web.ts` sağlar (bellek içi `memoryProofBlobStore`).
 */
import type { ProofBlobStore } from './cache';

type Fs = typeof import('expo-file-system');

function fs(): Fs | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-file-system') as Fs;
  } catch {
    return null;
  }
}

export function fileProofBlobStore(): ProofBlobStore {
  const dir = () => {
    const m = fs();
    if (!m) throw new Error('expo-file-system yok');
    return new m.Directory(m.Paths.cache, 'proofs');
  };
  const file = (name: string) => {
    const m = fs();
    if (!m) throw new Error('expo-file-system yok');
    return new m.File(dir(), name);
  };
  return {
    put: async (name, base64) => {
      const d = dir();
      if (!d.exists) d.create({ intermediates: true, idempotent: true });
      const f = file(name);
      await f.write(base64, { encoding: 'base64' });
      return f.uri;
    },
    remove: async (name) => {
      try {
        const f = file(name);
        if (f.exists) f.delete();
      } catch {
        // zaten yok
      }
    },
    list: async () => {
      try {
        const d = dir();
        if (!d.exists) return [];
        return d.list().map((x) => x.name);
      } catch {
        return [];
      }
    },
    uriOf: (name) => {
      try {
        const f = file(name);
        return f.exists ? f.uri : null;
      } catch {
        return null;
      }
    },
    clear: async () => {
      try {
        const d = dir();
        if (d.exists) d.delete();
      } catch {
        // önemsiz
      }
    },
  };
}
