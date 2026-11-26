/**
 * Faz 9: anlık fotoğraf önbelleği (gönderen: kendi kopyası; alıcı: `proof_get` ile indirilen kopya).
 *
 *  - Depolama bağımsız: görsel baytları enjekte edilen `ProofBlobStore`'a yazılır (native: önbellek dizini
 *    `fileStore.ts`; web demo / testler: `memoryProofBlobStore`). Dosya adı bitişi taşır
 *    (`<expires_at>.<owner>.<proof_id>.jpg`): açılışta ayrı dizin tutmadan süresi geçenler silinir.
 *  - Süre dolunca (`photo_exp` / `expires_at`, sunucu saati) kayıt ve dosya silinir: `get` süresi geçmişi asla
 *    döndürmez; `sweep` her `PROOF_LIMITS.cacheSweepMs`'de ve öne gelince çağrılır; `clear` çıkış / hesap silmede.
 *  - Kullanıcı başına tek etkin fotoğraf: aynı sahibin yeni fotoğrafı eskisini siler.
 */
import { proofCacheExpired, type EpochMs, type UserId } from '@konum/core';

export interface ProofBlobStore {
  /** JPEG base64'ü yazar; gösterilebilir adres döner (`file://…` ya da `data:`). */
  put(name: string, base64: string): Promise<string>;
  remove(name: string): Promise<void>;
  /** Saklanan dosya adları (açılış süpürmesi). */
  list(): Promise<string[]>;
  uriOf(name: string): string | null;
  clear(): Promise<void>;
}

export interface ProofCacheEntry {
  owner_id: UserId;
  proof_id: string;
  /** Sunucu saati. */
  expires_at: EpochMs;
  uri: string;
  name: string;
}

export interface ProofCache {
  /** Süresi geçmemiş kayıt; yoksa null (süresi geçmişse siler). */
  get(ownerId: UserId, proofId: string): ProofCacheEntry | null;
  put(ref: { owner_id: UserId; proof_id: string; expires_at: EpochMs }, base64: string): Promise<ProofCacheEntry | null>;
  remove(ownerId: UserId, proofId?: string): Promise<void>;
  /** Süresi geçenleri siler; silinen anahtarlar (`owner/proof`). */
  sweep(): Promise<string[]>;
  /** Açılışta: depodaki dosyalardan geçerli olanları yükler, süresi geçen / bozuk adları siler. */
  hydrate(): Promise<void>;
  clear(): Promise<void>;
  entries(): ProofCacheEntry[];
  subscribe(l: () => void): () => void;
}

export const proofBlobName = (ownerId: UserId, proofId: string, expiresAt: EpochMs): string => `${Math.round(expiresAt)}.${ownerId}.${proofId}.jpg`;

/** Dosya adı → kayıt alanları (bozuksa null). UID ve fotoğraf kimliğinde nokta yoktur. */
export function parseProofBlobName(name: string): { expires_at: EpochMs; owner_id: UserId; proof_id: string } | null {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{1,64})\.jpg$/.exec(name);
  if (!m) return null;
  return { expires_at: Number(m[1]), owner_id: m[2]!, proof_id: m[3]! };
}

const keyOf = (ownerId: UserId, proofId: string) => `${ownerId}/${proofId}`;

export function createProofCache(store: ProofBlobStore, now: () => EpochMs): ProofCache {
  const map = new Map<string, ProofCacheEntry>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // dinleyici hatası önemsiz
      }
    }
  };
  const drop = async (e: ProofCacheEntry) => {
    map.delete(keyOf(e.owner_id, e.proof_id));
    await store.remove(e.name).catch(() => undefined);
  };

  const cache: ProofCache = {
    get: (ownerId, proofId) => {
      const e = map.get(keyOf(ownerId, proofId));
      if (!e) return null;
      if (proofCacheExpired(e, now())) {
        void drop(e).then(notify);
        return null;
      }
      return e;
    },

    put: async (ref, base64) => {
      if (proofCacheExpired(ref, now())) return null;
      // Aynı sahibin önceki fotoğrafı (yerine geçti) silinir.
      for (const e of [...map.values()]) if (e.owner_id === ref.owner_id && e.proof_id !== ref.proof_id) await drop(e);
      const name = proofBlobName(ref.owner_id, ref.proof_id, ref.expires_at);
      const uri = await store.put(name, base64);
      const entry: ProofCacheEntry = { owner_id: ref.owner_id, proof_id: ref.proof_id, expires_at: ref.expires_at, uri, name };
      map.set(keyOf(ref.owner_id, ref.proof_id), entry);
      notify();
      return entry;
    },

    remove: async (ownerId, proofId) => {
      const victims = [...map.values()].filter((e) => e.owner_id === ownerId && (proofId === undefined || e.proof_id === proofId));
      for (const e of victims) await drop(e);
      if (victims.length) notify();
    },

    sweep: async () => {
      const t = now();
      const gone = [...map.values()].filter((e) => proofCacheExpired(e, t));
      for (const e of gone) await drop(e);
      // Bellekte olmayan (önceki çalıştırmadan) süresi geçmiş dosyalar da.
      const names = await store.list().catch(() => [] as string[]);
      const known = new Set([...map.values()].map((e) => e.name));
      for (const n of names) {
        if (known.has(n)) continue;
        const p = parseProofBlobName(n);
        if (!p || proofCacheExpired(p, t)) await store.remove(n).catch(() => undefined);
      }
      if (gone.length) notify();
      return gone.map((e) => keyOf(e.owner_id, e.proof_id));
    },

    hydrate: async () => {
      const t = now();
      const names = await store.list().catch(() => [] as string[]);
      for (const n of names) {
        const p = parseProofBlobName(n);
        if (!p || proofCacheExpired(p, t)) {
          await store.remove(n).catch(() => undefined);
          continue;
        }
        const uri = store.uriOf(n);
        if (uri) map.set(keyOf(p.owner_id, p.proof_id), { ...p, uri, name: n });
      }
      notify();
    },

    clear: async () => {
      map.clear();
      await store.clear().catch(() => undefined);
      notify();
    },

    entries: () => [...map.values()],

    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return cache;
}

/** Bellek içi depo (web demo, testler): adres `data:` URI. Uygulama kapanınca kendiliğinden silinir. */
export function memoryProofBlobStore(): ProofBlobStore & { size(): number } {
  const blobs = new Map<string, string>();
  return {
    put: async (name, base64) => {
      blobs.set(name, base64);
      return `data:image/jpeg;base64,${base64}`;
    },
    remove: async (name) => {
      blobs.delete(name);
    },
    list: async () => [...blobs.keys()],
    uriOf: (name) => {
      const b = blobs.get(name);
      return b === undefined ? null : `data:image/jpeg;base64,${b}`;
    },
    clear: async () => {
      blobs.clear();
    },
    size: () => blobs.size,
  };
}
