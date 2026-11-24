/**
 * Adres çubuğundaki bağlantıdan token'ı alır ve adresten SİLER.
 *
 * Neden silinir: token = okuma yetkisi. Sayfaya yüklenen üçüncü taraf betikler (Google Maps JS API,
 * kimlik doğrulama isteğinde sayfa adresini gönderir) ve tarayıcı geçmişi token'ı görmesin.
 * Token yalnızca bellekte ve bu sekmenin sessionStorage'ında kalır (yenileme çalışsın); ağa yalnızca
 * özeti (`link_live/{sha256}`) çıkar. Adres `/s/canli` olur: Hosting'deki `/s/**` yeniden yazımına
 * uyar ve `trailingSlash: false` yönlendirmesine takılmaz. [Varsayım] ürün kararı: adres çubuğundan
 * kopyalanan bağlantı token içermez; paylaşılan asıl bağlantı mesajda durur.
 */
import { LINK_PATH_PREFIX, LINK_SCHEME, isLinkToken, linkTokenHash, parseLinkToken } from '@konum/core';

/** Token adresten silindikten sonra görünen yol. */
export const STRIPPED_PATH = `${LINK_PATH_PREFIX}canli`;
const STORAGE_KEY = 'konum.link.token';

export interface LocationLike {
  pathname: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

export type TokenSource = 'path' | 'session' | 'none';

export interface ResolvedToken {
  token: string | null;
  /** `link_live/{hash}` anahtarı; token yoksa null. */
  hash: string | null;
  source: TokenSource;
}

const PATH_RE = /^\/s\/([^/]+)\/?$/;

/** Yol → token (saf). `/s/<token>` ve `/s/<token>/` kabul edilir; başka her şey null. */
export function tokenFromPath(pathname: string): string | null {
  const m = PATH_RE.exec(pathname);
  if (!m) return null;
  let seg = m[1] as string;
  try {
    seg = decodeURIComponent(seg);
  } catch {
    return null;
  }
  // Çıplak token biçimi core'dan: kanonik 43 karakter base64url.
  return parseLinkToken(seg);
}

function safeGet(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // gizli pencere / engelli depolama: yenilemede token kaybolur, sayfa yine çalışır
  }
}

/**
 * Token'ı çözer, saklar ve adresten siler. Yan etkiler parametrelerden gelir (testte sahte nesneler).
 * Sıra önemli: bu fonksiyon Firebase'den ve Maps JS'ten ÖNCE çalışır.
 */
export function consumeToken(loc: LocationLike, storage: StorageLike | null, history: HistoryLike | null): ResolvedToken {
  const fromPath = tokenFromPath(loc.pathname);
  if (fromPath) {
    safeSet(storage, STORAGE_KEY, fromPath);
    try {
      history?.replaceState(null, '', STRIPPED_PATH);
    } catch {
      // replaceState engelliyse token adreste kalır; yine de çalışır
    }
    return { token: fromPath, hash: linkTokenHash(fromPath), source: 'path' };
  }
  if (loc.pathname === STRIPPED_PATH || loc.pathname === `${STRIPPED_PATH}/`) {
    const stored = safeGet(storage, STORAGE_KEY);
    if (stored && isLinkToken(stored)) return { token: stored, hash: linkTokenHash(stored), source: 'session' };
  }
  return { token: null, hash: null, source: 'none' };
}

/** "Uygulamada aç": özel şema (`konum://s/<token>`), uygulama kuruluysa doğrudan canlı haritaya gider. */
export function appLinkUrl(token: string): string {
  return `${LINK_SCHEME}://s/${token}`;
}
