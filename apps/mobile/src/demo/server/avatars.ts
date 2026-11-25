/**
 * Faz 6 demo: profil fotoğrafları (avatar) ve sahte Firebase Storage.
 *
 *  - Bot fotoğrafları ÇİZİMDİR: basit, soyut SVG yüzler (gerçek kişi fotoğrafı YOK). Can'in fotoğrafı yoktur
 *    (baş harfli varsayılan avatar görünsün); isim havuzundaki sanal kişilerin de yoktur.
 *  - Profil kayıtlarında adresler üretimdeki gibi indirme-token'lı Storage URL'leridir
 *    (`https://firebasestorage.googleapis.com/v0/b/{kova}/o/avatars%2F{uid}%2F{sürüm}.jpg?alt=media&token=...`);
 *    sunucu `user_bootstrap`'te bu biçimi core `checkAvatarPair` ile doğrular.
 *  - [Demo] Tarayıcı önizlemesi ağa çıkmaz: dinleyicilere giden profillerde bu adresler yerel içeriğe çözülür
 *    (yüklenen JPEG için `data:image/jpeg`, bot çizimi için `data:image/svg+xml`; `blob:` KULLANILMAZ, sıkı CSP engelliyor). Çözülemeyen adres `null` olur ve
 *    istemci baş harflere düşer.
 *  - Yüklenen nesneler `storage.rules` ile aynı kurallardan geçer: yalnızca sahibi `avatars/{uid}/{dosya}` yazar,
 *    dosya adı core `AVATAR_FILE_RE`, tür `image/jpeg`, boyut ana ≤ `mainMaxBytes`, küçük ≤ `thumbMaxBytes`.
 */
import { AVATAR_FILE_RE, AVATAR_LIMITS, avatarObjectPathFromUrl, parseAvatarObjectPath, type EpochMs, type UserId } from '@konum/core';
import { safeStorage } from './storage';

export const DEMO_STORAGE_BUCKET = 'konum-demo.appspot.com';
export const DEMO_STORAGE_HOST = 'firebasestorage.googleapis.com';
/** Sahte Storage nesneleri (uygulamanın `ui/avatarUri.web.ts` kaydı `konum.demo.avatars.v1` ayrı bir anahtardır). */
export const DEMO_AVATARS_KEY = 'konum.demo.storage.v1';
/** Bot fotoğraflarının sabit sürümü (13 haneli epoch ms: 2025-01-01). */
export const BOT_AVATAR_VERSION = 1_735_689_600_000;

/** Üretimdeki indirme adresi biçimi (yüzde-kodlu nesne yolu + indirme token'ı). */
export function demoDownloadUrl(path: string, token: string): string {
  return `https://${DEMO_STORAGE_HOST}/v0/b/${DEMO_STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// ---------------------------------------------------------------------------
// Çizim yüzler (SVG)
// ---------------------------------------------------------------------------

type Hair = 'long' | 'short' | 'bun' | 'curly';

interface Face {
  bg: string;
  skin: string;
  hair: string;
  shirt: string;
  style: Hair;
  beard?: boolean;
}

/** Botların çizim yüzleri. Can yok (fotoğrafsız → baş harfler). Elif'in bekleyen istek profili yalnızca ad taşır. */
const FACES: Record<string, Face> = {
  ayse: { bg: '#FDE7C7', skin: '#F2C29B', hair: '#5B3A29', shirt: '#E0567A', style: 'long' },
  mehmet: { bg: '#D6E6FB', skin: '#D9A07A', hair: '#2B2B2B', shirt: '#2F6FD6', style: 'short', beard: true },
  zeynep: { bg: '#D9F2E3', skin: '#E8B48F', hair: '#8A4B2A', shirt: '#7C5BD6', style: 'bun' },
  elif: { bg: '#F7DCEB', skin: '#F0BE98', hair: '#1F1A17', shirt: '#14A38B', style: 'curly' },
};

export const hasBotFace = (uid: UserId): boolean => uid in FACES;

/** Saç: `back` başın arkasına, `front` önüne çizilir. */
function hairParts(f: Face): { back: string; front: string } {
  const fill = `fill="${f.hair}"`;
  switch (f.style) {
    case 'long':
      return {
        back: `<path d="M42 80c0-29 16-47 38-47s38 18 38 47v40H42Z" ${fill}/>`,
        front: `<path d="M48 72c2-21 15-33 32-33s30 12 32 33c-9-9-20-13-32-13s-23 4-32 13Z" ${fill}/>`,
      };
    case 'short':
      return { back: '', front: `<path d="M47 68c0-21 14-35 33-35s33 14 33 35c-8-9-19-13-33-13s-25 4-33 13Z" ${fill}/>` };
    case 'bun':
      return {
        back: `<circle cx="80" cy="32" r="14" ${fill}/>`,
        front: `<path d="M47 70c0-21 15-34 33-34s33 13 33 34c-8-10-19-15-33-15s-25 5-33 15Z" ${fill}/>`,
      };
    case 'curly':
      return {
        back: '',
        front: [40, 53, 66, 80, 94, 107, 120].map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 46 : 54}" r="12" ${fill}/>`).join(''),
      };
  }
}

/** Soyut, çizim bir yüz (yaklaşık 1 KB SVG). */
export function botFaceSvg(f: Face): string {
  const hair = hairParts(f);
  const beard = f.beard ? `<path d="M56 82c3 19 12 26 24 26s21-7 24-26c-6 7-14 10-24 10s-18-3-24-10Z" fill="${f.hair}"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">` +
    `<rect width="160" height="160" fill="${f.bg}"/>` +
    hair.back +
    `<path d="M26 160c4-30 26-44 54-44s50 14 54 44Z" fill="${f.shirt}"/>` +
    `<rect x="70" y="96" width="20" height="22" rx="8" fill="${f.skin}"/>` +
    `<circle cx="80" cy="76" r="32" fill="${f.skin}"/>` +
    hair.front +
    beard +
    `<circle cx="68" cy="79" r="3.6" fill="#2A1E1A"/><circle cx="92" cy="79" r="3.6" fill="#2A1E1A"/>` +
    `<path d="M70 93q10 8 20 0" stroke="#7A3B2E" stroke-width="3.2" fill="none" stroke-linecap="round"/>` +
    `</svg>`
  );
}

const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const botFaceCache = new Map<string, string>();

function botFaceUrl(uid: UserId): string | null {
  const f = FACES[uid];
  if (!f) return null;
  let url = botFaceCache.get(uid);
  if (!url) {
    url = svgDataUrl(botFaceSvg(f));
    botFaceCache.set(uid, url);
  }
  return url;
}

/** Bot profilinin saklanan (üretim biçimli) adresleri; çizimi olmayan bot için null. */
export function botAvatarUrls(uid: UserId): { avatar_url: string; avatar_thumb_url: string; avatar_version: number } | null {
  if (!hasBotFace(uid)) return null;
  const token = `demo-${uid}`;
  return {
    avatar_url: demoDownloadUrl(`avatars/${uid}/${BOT_AVATAR_VERSION}.jpg`, token),
    avatar_thumb_url: demoDownloadUrl(`avatars/${uid}/${BOT_AVATAR_VERSION}_160.jpg`, token),
    avatar_version: BOT_AVATAR_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Sahte Storage (yüklenen nesneler)
// ---------------------------------------------------------------------------

/** RNFB Storage hata biçimi (`storage/...`). */
export class DemoStorageError extends Error {
  constructor(
    readonly code: 'storage/unauthorized' | 'storage/unauthenticated' | 'storage/invalid-argument' | 'storage/object-not-found',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DemoStorageError';
  }
}

interface StoredObject {
  data_url: string;
  content_type: string;
  size: number;
  token: string;
  updated_at: EpochMs;
}

const BASE64_RE = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/;

/** base64 veri adresinin çözülmüş bayt sayısı (istemcinin bildirdiği boyuta güvenilmez). */
export function dataUrlBytes(dataUrl: string): number | null {
  const m = BASE64_RE.exec(dataUrl);
  if (!m?.[2]) return null;
  const b64 = m[2];
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Yerel gösterim adresi: veri adresinin KENDİSİ. Eskiden `blob:` adresine çevriliyordu; sıkı CSP'li görüntüleyiciler
 * (img-src yalnızca data:) blob: görselini engellediği için yüklenen fotoğraf hiç görünmüyordu.
 */
function toObjectUrl(dataUrl: string): string {
  return dataUrl;
}

/** Bellek içi + `localStorage` (yalnızca yüklemede / silmede yazılır; ana demo durumundan ayrı tutulur). */
export class DemoAvatarStore {
  private objects: Record<string, StoredObject>;
  /** Yol → yerel gösterim adresi (sürüm değişene kadar aynı dize; dinleyici farkları kararlı kalsın). */
  private objectUrls = new Map<string, { at: EpochMs; url: string }>();
  private disposed = false;

  constructor() {
    this.objects = this.load();
  }

  private load(): Record<string, StoredObject> {
    try {
      const raw = safeStorage.get(DEMO_AVATARS_KEY);
      const v = raw ? (JSON.parse(raw) as Record<string, StoredObject>) : null;
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    if (this.disposed) return;
    safeStorage.set(DEMO_AVATARS_KEY, JSON.stringify(this.objects));
  }

  /**
   * `storage.rules` karşılığı + yazma. Dönen: indirme adresi (üretim biçimi). Yalnızca base64 JPEG veri adresi kabul
   * edilir; boyut veriden hesaplanır.
   */
  put(path: string, dataUrl: string, contentType: string, authUid: UserId | null, now: EpochMs, token: string): { download_url: string; size: number } {
    if (!authUid) throw new DemoStorageError('storage/unauthenticated');
    const m = /^avatars\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m || m[1] !== authUid || !AVATAR_FILE_RE.test(m[2] ?? '')) throw new DemoStorageError('storage/unauthorized', 'Yalnızca kendi avatars/{uid}/{sürüm}.jpg dosyan');
    if (contentType !== 'image/jpeg') throw new DemoStorageError('storage/unauthorized', 'Yalnızca image/jpeg');
    const size = dataUrlBytes(dataUrl);
    if (size === null || !dataUrl.startsWith('data:image/jpeg')) throw new DemoStorageError('storage/invalid-argument', 'JPEG veri adresi bekleniyor');
    const max = (m[2] ?? '').includes('_160') ? AVATAR_LIMITS.thumbMaxBytes : AVATAR_LIMITS.mainMaxBytes;
    if (size <= 0 || size > max) throw new DemoStorageError('storage/unauthorized', `Dosya çok büyük (${size} > ${max} bayt)`);
    this.objects[path] = { data_url: dataUrl, content_type: contentType, size, token, updated_at: now };
    this.objectUrls.delete(path);
    this.persist();
    return { download_url: demoDownloadUrl(path, token), size };
  }

  /** Sahibi siler (kural: `delete` yalnızca sahibine). Yoksa sessizce geçer (Admin SDK `ignoreNotFound`). */
  remove(path: string, authUid: UserId | 'server'): boolean {
    const ref = parseAvatarObjectPath(path);
    if (authUid !== 'server' && (!ref || ref.uid !== authUid)) throw new DemoStorageError('storage/unauthorized');
    if (!this.objects[path]) return false;
    delete this.objects[path];
    const cached = this.objectUrls.get(path);
    if (cached) {
      this.objectUrls.delete(path);
      try {
        (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL?.revokeObjectURL?.(cached.url);
      } catch {
        // önemsiz
      }
    }
    this.persist();
    return true;
  }

  has(path: string): boolean {
    return !!this.objects[path];
  }

  /** Kullanıcının tüm nesneleri (hesap silme / test). */
  pathsOf(uid: UserId): string[] {
    return Object.keys(this.objects).filter((p) => p.startsWith(`avatars/${uid}/`));
  }

  /**
   * Saklanan Storage adresini tarayıcının gösterebileceği yerel adrese çevirir: yüklenen nesne → `data:`, bot çizimi → SVG veri adresi. Bilinmeyen / silinmiş nesne → null (istemci baş harflere düşer).
   */
  resolve(url: string | null | undefined): string | null {
    if (!url) return null;
    const path = avatarObjectPathFromUrl(url);
    if (!path) return null;
    const obj = this.objects[path];
    if (obj) {
      const cached = this.objectUrls.get(path);
      if (cached && cached.at === obj.updated_at) return cached.url;
      const local = toObjectUrl(obj.data_url);
      this.objectUrls.set(path, { at: obj.updated_at, url: local });
      return local;
    }
    const ref = parseAvatarObjectPath(path);
    if (ref && ref.version === BOT_AVATAR_VERSION) return botFaceUrl(ref.uid);
    return null;
  }

  reset(): void {
    this.disposed = true;
    safeStorage.remove(DEMO_AVATARS_KEY);
  }
}

/**
 * Yükleme kaynağını base64 veri adresine çevirir: veri adresi olduğu gibi; `blob:` / dosya adresi tarayıcıda
 * `fetch` + `FileReader` ile okunur (web görüntü düzenleyicisi ikisinden birini döndürür).
 */
export async function uriToDataUrl(uri: string): Promise<string> {
  if (uri.startsWith('data:')) return uri;
  const g = globalThis as { fetch?: typeof fetch; FileReader?: typeof FileReader };
  if (typeof g.fetch !== 'function' || typeof g.FileReader !== 'function') throw new DemoStorageError('storage/invalid-argument', 'Dosya okunamadı');
  const blob = await (await g.fetch(uri)).blob();
  return new Promise<string>((resolve, reject) => {
    const r = new g.FileReader!();
    r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new DemoStorageError('storage/invalid-argument')));
    r.onerror = () => reject(new DemoStorageError('storage/invalid-argument', 'Dosya okunamadı'));
    r.readAsDataURL(blob);
  });
}
