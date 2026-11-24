/**
 * Web demo: `@react-native-async-storage/async-storage` yerine geçen güvenli depo (metro.config.js yalnızca
 * `platform === 'web'` iken bu dosyaya yönlendirir; native paketler gerçek AsyncStorage'ı kullanır).
 *
 * Neden: AsyncStorage'ın web uygulaması doğrudan `window.localStorage` kullanır ve korumalı iframe'de,
 * gizli pencerede ya da site verisi engellenmişken her çağrıda HATA FIRLATIR. Uygulamanın kalıcı durumu
 * (yayın hedefleri, durdurma niyetleri, izin akışı) bu durumda yazılamaz ve kendi konum yayını hiç başlamazdı.
 * Burada aynı API `safeStorage` üzerinden çalışır: localStorage yoksa bellek içi yedek kullanılır.
 */
import { safeStorage } from '../server/storage';

type Callback<T> = ((error?: Error | null, result?: T) => void) | undefined;
type Entry = readonly [string, string | null];

function run<T>(fn: () => T, cb?: Callback<T>): Promise<T> {
  try {
    const v = fn();
    cb?.(null, v);
    return Promise.resolve(v);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    cb?.(err);
    return Promise.reject(err);
  }
}

function merge(oldRaw: string | null, patchRaw: string): string {
  if (!oldRaw) return patchRaw;
  const a = JSON.parse(oldRaw) as unknown;
  const b = JSON.parse(patchRaw) as unknown;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return JSON.stringify({ ...(a as object), ...(b as object) });
  }
  return patchRaw;
}

const AsyncStorage = {
  getItem: (key: string, cb?: Callback<string | null>) => run(() => safeStorage.get(key), cb),
  setItem: (key: string, value: string, cb?: Callback<void>) => run(() => safeStorage.set(key, value), cb),
  removeItem: (key: string, cb?: Callback<void>) => run(() => safeStorage.remove(key), cb),
  mergeItem: (key: string, value: string, cb?: Callback<void>) => run(() => safeStorage.set(key, merge(safeStorage.get(key), value)), cb),
  clear: (cb?: Callback<void>) => run(() => safeStorage.removePrefix(''), cb),
  getAllKeys: (cb?: Callback<readonly string[]>) => run(() => safeStorage.keys(), cb),
  flushGetRequests: () => undefined,
  multiGet: (keys: readonly string[], cb?: Callback<readonly Entry[]>) => run(() => keys.map((k) => [k, safeStorage.get(k)] as const), cb),
  multiSet: (pairs: readonly (readonly [string, string])[], cb?: Callback<void>) =>
    run(() => pairs.forEach(([k, v]) => safeStorage.set(k, v)), cb),
  multiRemove: (keys: readonly string[], cb?: Callback<void>) => run(() => keys.forEach((k) => safeStorage.remove(k)), cb),
  multiMerge: (pairs: readonly (readonly [string, string])[], cb?: Callback<void>) =>
    run(() => pairs.forEach(([k, v]) => safeStorage.set(k, merge(safeStorage.get(k), v))), cb),
};

export default AsyncStorage;
