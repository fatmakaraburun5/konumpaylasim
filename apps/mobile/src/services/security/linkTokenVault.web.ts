/**
 * Web demo: bağlantı token kasası (native `linkTokenVault.ts` → expo-secure-store; web'de güvenli depo yoktur).
 *
 * Önizlemede token'lar demo sunucusunun ürettiği SAHTE bağlantılara aittir ve hiçbir gerçek konuma erişim
 * vermez; yeniden yüklemede QR görünmeye devam etsin diye demo deposunda (`konum.demo.linkvault.v1`,
 * localStorage, erişilemezse bellek) tutulur. "Demoyu sıfırla" bu anahtarı da siler.
 * Native paket bu dosyayı hiç görmez: telefonda URL yalnızca Anahtar Zinciri / Keystore'dadır.
 */
import type { LinkId } from '@konum/core';
import { safeStorage } from '../../demo/server/storage';
// Yalnızca tip: çalışma zamanında silinir (web'de './linkTokenVault' bu dosyanın kendisine çözülürdü).
import type { LinkTokenVault } from './linkTokenVault';

export type { LinkTokenVault };

const KEY = 'konum.demo.linkvault.v1';

function read(): Record<LinkId, string> {
  try {
    const raw = safeStorage.get(KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

function write(m: Record<LinkId, string>): void {
  if (Object.keys(m).length === 0) safeStorage.remove(KEY);
  else safeStorage.set(KEY, JSON.stringify(m));
}

export const linkTokenVault: LinkTokenVault = {
  save: async (linkId, secret) => write({ ...read(), [linkId]: secret }),
  load: async (linkId) => read()[linkId] ?? null,
  remove: async (linkId) => {
    const m = read();
    delete m[linkId];
    write(m);
  },
  retainOnly: async (linkIds) => {
    const keep = new Set(linkIds);
    write(Object.fromEntries(Object.entries(read()).filter(([id]) => keep.has(id))));
  },
  clear: async () => write({}),
};

/** Bellek içi kasa (native dosyadakiyle aynı imza; web'de yalnızca tutarlılık için). */
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
