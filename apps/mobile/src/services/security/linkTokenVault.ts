/**
 * Bağlantı token'ı kasası. Düz token YALNIZCA `link_share_create` yanıtında gelir; sunucu yalnızca
 * SHA-256 özetini saklar. QR'ı sonradan yeniden gösterebilmek için token'ı taşıyan paylaşım URL'si
 * (`https://<alan>/s/<token>`, sunucunun ürettiği biçimiyle) bu cihazda güvenli depoda
 * (iOS Anahtar Zinciri / Android Keystore, `expo-secure-store`) tutulur. URL saklanır ki
 * alan adı yapılandırması değişse de QR sunucunun verdiği bağlantıyı göstersin:
 *
 *  - `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: yedeğe girmez, yeni cihaza taşınmaz, kilitliyken okunmaz
 *    (token'a yalnızca ön planda QR gösterilirken ihtiyaç var; arka plan yayıncısı `token_hash` kullanır).
 *  - AsyncStorage'a, günlüklere ya da Firestore'a ASLA yazılmaz.
 *  - Bağlantı bitince / durdurulunca / çıkışta silinir.
 *
 * Güvenli depo yoksa (web önizleme, eski cihaz) token yalnızca bellekte tutulur: QR bu açılış boyunca
 * görünür, uygulama yeniden açılınca "QR bu cihazda yok" denir (bağlantı yine durdurulabilir).
 */
import type { LinkId } from '@konum/core';
import * as SecureStore from 'expo-secure-store';

/** SecureStore anahtarı yalnızca [A-Za-z0-9._-] kabul eder; link_id de bu kümededir. */
const keyFor = (linkId: LinkId) => `konum.link.token.${linkId}`;
/** Kasadaki bağlantı kimlikleri (çıkışta toplu silmek için; token içermez). */
const INDEX_KEY = 'konum.link.tokens.index';

const memory = new Map<LinkId, string>();
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

async function readIndex(): Promise<LinkId[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY, OPTIONS);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIndex(ids: readonly LinkId[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...new Set(ids)]), OPTIONS);
  } catch {
    // güvenli depo yok: yalnızca bellek
  }
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export interface LinkTokenVault {
  /** `secret`: token'ı taşıyan paylaşım URL'si. */
  save: (linkId: LinkId, secret: string) => Promise<void>;
  load: (linkId: LinkId) => Promise<string | null>;
  remove: (linkId: LinkId) => Promise<void>;
  /** Verilen kimlikler DIŞINDAKİ tüm token'ları siler (biten bağlantılar). */
  retainOnly: (linkIds: readonly LinkId[]) => Promise<void>;
  clear: () => Promise<void>;
}

export const linkTokenVault: LinkTokenVault = {
  save: (linkId, token) =>
    serial(async () => {
      memory.set(linkId, token);
      try {
        await SecureStore.setItemAsync(keyFor(linkId), token, OPTIONS);
        await writeIndex([...(await readIndex()), linkId]);
      } catch {
        // güvenli depo yok: yalnızca bellek
      }
    }),
  load: async (linkId) => {
    const m = memory.get(linkId);
    if (m) return m;
    try {
      const v = await SecureStore.getItemAsync(keyFor(linkId), OPTIONS);
      if (v) memory.set(linkId, v);
      return v;
    } catch {
      return null;
    }
  },
  remove: (linkId) =>
    serial(async () => {
      memory.delete(linkId);
      try {
        await SecureStore.deleteItemAsync(keyFor(linkId), OPTIONS);
        await writeIndex((await readIndex()).filter((id) => id !== linkId));
      } catch {
        // yok say
      }
    }),
  retainOnly: (linkIds) =>
    serial(async () => {
      const keep = new Set(linkIds);
      for (const id of [...memory.keys()]) if (!keep.has(id)) memory.delete(id);
      const stored = await readIndex();
      const drop = stored.filter((id) => !keep.has(id));
      if (drop.length === 0) return;
      for (const id of drop) await SecureStore.deleteItemAsync(keyFor(id), OPTIONS).catch(() => undefined);
      await writeIndex(stored.filter((id) => keep.has(id)));
    }),
  clear: () =>
    serial(async () => {
      memory.clear();
      for (const id of await readIndex()) await SecureStore.deleteItemAsync(keyFor(id), OPTIONS).catch(() => undefined);
      try {
        await SecureStore.deleteItemAsync(INDEX_KEY, OPTIONS);
      } catch {
        // yok say
      }
    }),
};

/** Bellek içi kasa (testler). */
export function createMemoryLinkTokenVault(): LinkTokenVault & { dump: () => Record<string, string> } {
  const m = new Map<LinkId, string>();
  return {
    save: async (id, t) => void m.set(id, t),
    load: async (id) => m.get(id) ?? null,
    remove: async (id) => void m.delete(id),
    retainOnly: async (ids) => {
      const keep = new Set(ids);
      for (const id of [...m.keys()]) if (!keep.has(id)) m.delete(id);
    },
    clear: async () => m.clear(),
    dump: () => Object.fromEntries(m),
  };
}
