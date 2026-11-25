/**
 * Web demo: demo "Storage"ına yüklenen avatarlar gerçek bir sunucuda değildir. Yükleme (avatarUpload.web.ts)
 * Firebase biçiminde bir indirme adresi üretir (`https://firebasestorage.googleapis.com/v0/b/<demo kova>/o/
 * avatars%2F<uid>%2F<sürüm>.jpg?alt=media&token=…`; sunucu doğrulaması ve `checkAvatarPair` gerçekteki gibi çalışır)
 * ve görüntüyü burada data: URI olarak kaydeder. Avatar bileşeni bu adresi data: URI'ye çevirir.
 * Kayıt tarayıcıda (localStorage) en çok `MAX` girişle tutulur: sayfa yenilense de fotoğraf görünür.
 * Kayıtta yoksa demo sunucusunun sahte Storage'ı sorulur (`resolveAvatarUrl`: bot çizimleri, başka sekmede yüklenen).
 */
import { demoServer } from '../demo/server';

const KEY = 'konum.demo.avatars.v1';
const MAX = 12;

let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(arr)) {
      for (const e of arr) if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') cache.set(e[0], e[1]);
    }
  } catch {
    // bozuk / erişilemeyen depo: boş başla
  }
  return cache;
}

export function resolveAvatarUri(url: string): string {
  const local = load().get(url);
  if (local) return local;
  try {
    return demoServer().resolveAvatarUrl(url) ?? url;
  } catch {
    return url;
  }
}

export function registerAvatarDataUri(url: string, dataUri: string): void {
  const m = load();
  m.delete(url);
  m.set(url, dataUri);
  while (m.size > MAX) m.delete(m.keys().next().value as string);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...m.entries()]));
  } catch {
    // kota dolu: yalnızca bellekte kalır
  }
}
