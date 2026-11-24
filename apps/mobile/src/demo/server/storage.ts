/**
 * Demo için güvenli tarayıcı depolaması. `localStorage` erişimi korumalı iframe'de, gizli pencerede ya da
 * site verisi engellenmişken HATA FIRLATABİLİR; bu durumda bellek içi yedek kullanılır (sayfa yine çalışır,
 * yalnızca yeniden yüklemede veri kalmaz).
 */
const memory = new Map<string, string>();

function nativeStorage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export const safeStorage = {
  get(key: string): string | null {
    try {
      const s = nativeStorage();
      const v = s ? s.getItem(key) : null;
      // localStorage'a yazılamamış (kota) değer yalnızca bellekte olabilir.
      if (v !== null) return v;
    } catch {
      // yedeğe düş
    }
    return memory.get(key) ?? null;
  },
  set(key: string, value: string): void {
    memory.set(key, value);
    try {
      nativeStorage()?.setItem(key, value);
    } catch {
      // kota / erişim yok: bellekte kalır
    }
  },
  remove(key: string): void {
    memory.delete(key);
    try {
      nativeStorage()?.removeItem(key);
    } catch {
      // önemsiz
    }
  },
  /** Tüm anahtarlar (localStorage + yalnızca bellekte kalanlar). */
  keys(): string[] {
    const out = new Set(memory.keys());
    try {
      const s = nativeStorage();
      if (s) {
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k) out.add(k);
        }
      }
    } catch {
      // yalnızca bellek
    }
    return [...out];
  },
  /** Verilen önekle başlayan tüm anahtarları siler (demo sıfırlama). */
  removePrefix(prefix: string): void {
    for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k);
    try {
      const s = nativeStorage();
      if (!s) return;
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      keys.forEach((k) => s.removeItem(k));
    } catch {
      // önemsiz
    }
  },
};
