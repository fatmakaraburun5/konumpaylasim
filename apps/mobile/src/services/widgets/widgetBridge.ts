/**
 * Faz 6: yerel widget modülünün (modules/konum-widgets) tipli JS sarmalayıcısı.
 *
 *  - iOS: App Group UserDefaults + kapsayıcı + paylaşılan anahtarlık (KonumWidgetsModule.swift); widget'ın kendisi
 *    ayrı WidgetKit hedefidir (targets/widgets).
 *  - Android: SharedPreferences + Keystore AES-GCM + RemoteViews çizimi (KonumWidgetsModule.kt / WidgetRenderer.kt).
 *
 * Anlık görüntü core `WidgetSnapshot` JSON'udur (snake_case, `v: 1`; `buildWidgetSnapshot` üretir). Yerel kod bilinmeyen
 * sürümü / bozuk JSON'u "boş / giriş yap" durumu olarak çizer. Belirteç anlık görüntüye GİRMEZ: yalnızca
 * `setQuickShareCredential` ile anahtarlığa / şifreli tercihe yazılır.
 *
 * Yerel modül yoksa (Expo Go, jest, modülsüz eski derleme) `requireOptionalNativeModule` null döner ve tüm işlevler
 * güvenli varsayılanlarla no-op olur. Web: widgetBridge.web.ts. [Varsayım] Yerel kod bu ortamda derlenmedi.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type WidgetPlatform = 'ios' | 'android';

export interface WidgetCapabilities {
  platform: WidgetPlatform;
  /** Widget düğmesi uygulamayı açmadan arka planda çalışabilir mi (iOS 17+ / Android). */
  interactive: boolean;
  /** Kilit ekranı widget'ı var mı (iOS 17+; Android telefonda yok — Hızlı Ayarlar kutucuğu `quickTile`). */
  lockScreen: boolean;
  /** Android Hızlı Ayarlar "Konum: 1 sa paylaş" kutucuğu. */
  quickTile: boolean;
  /** Yerel modül bağlı mı (false → tüm çağrılar no-op). */
  available: boolean;
}

export interface QuickShareCredential {
  token: string;
  /**
   * Callable uç noktası: tam URL (ör. emülatör `http://10.0.2.2:5001/<proje>/europe-west1/widget_quick_share`) ya da
   * yalnızca callable adı (core `endpoint_path` = 'widget_quick_share'); ad verilirse yerel kod
   * `https://europe-west1-<PROJECT_ID>.cloudfunctions.net/<ad>` kurar (iOS GoogleService-Info.plist, Android
   * google-services `project_id`).
   */
  endpoint: string;
  /** EpochMs */
  expires_at: number;
}

export interface WidgetQuickShareEvent {
  type: 'quick_share';
  to_uid: string;
  /** 'started' | 'extended' | 'already_active' | 'error' */
  status: string;
  /** Cihaz saati (ms). */
  at: number;
  /** status === 'error' iken core QuickShareError. */
  error?: string;
  source?: string;
  expires_at?: number;
  share_id?: string;
  to_name?: string;
}

interface KonumWidgetsNative {
  setSnapshot(json: string): Promise<void>;
  reload(): Promise<void> | void;
  saveAvatar(uid: string, uri: string): Promise<string | null>;
  removeAvatar(uid: string): Promise<void>;
  setQuickShareCredential(token: string, endpoint: string, expiresAt: number): Promise<boolean>;
  clearQuickShareCredential(): Promise<void>;
  consumeEvents(): Promise<string>;
  capabilities(): unknown;
}

let native: KonumWidgetsNative | null | undefined;
function mod(): KonumWidgetsNative | null {
  if (native === undefined) {
    try {
      native = requireOptionalNativeModule<KonumWidgetsNative>('KonumWidgets');
    } catch {
      native = null;
    }
  }
  return native;
}

/** Testler için yerel modülü değiştirir (null = yok, undefined = yeniden çöz). */
export function __setNativeWidgetsModuleForTests(m: KonumWidgetsNative | null | undefined): void {
  native = m;
}

export function isWidgetModuleAvailable(): boolean {
  return mod() !== null;
}

const AVATAR_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.jpg$/;
const ENDPOINT_RE = /^(https?:\/\/[^\s]+|[a-z0-9_]{1,64})$/;

/** Yerelden gelen olay listesini doğrular (bozuk / bilinmeyen kayıtlar atılır). */
export function parseWidgetEvents(raw: unknown): WidgetQuickShareEvent[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: WidgetQuickShareEvent[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const at = Number(o.at);
    if (o.type !== 'quick_share' || typeof o.to_uid !== 'string' || !o.to_uid || typeof o.status !== 'string') continue;
    if (!Number.isFinite(at) || at <= 0) continue;
    const e: WidgetQuickShareEvent = { type: 'quick_share', to_uid: o.to_uid, status: o.status, at: Math.round(at) };
    if (typeof o.error === 'string') e.error = o.error;
    if (typeof o.source === 'string') e.source = o.source;
    if (typeof o.share_id === 'string') e.share_id = o.share_id;
    if (typeof o.to_name === 'string') e.to_name = o.to_name;
    const exp = Number(o.expires_at);
    if (o.expires_at != null && Number.isFinite(exp) && exp > 0) e.expires_at = Math.round(exp);
    out.push(e);
  }
  return out;
}

function fallbackCapabilities(): WidgetCapabilities {
  return { platform: Platform.OS === 'ios' ? 'ios' : 'android', interactive: false, lockScreen: false, quickTile: false, available: false };
}

export function parseCapabilities(raw: unknown): WidgetCapabilities {
  const fb = fallbackCapabilities();
  if (!raw || typeof raw !== 'object') return fb;
  const o = raw as Record<string, unknown>;
  return {
    platform: o.platform === 'ios' || o.platform === 'android' ? o.platform : fb.platform,
    interactive: o.interactive === true,
    lockScreen: o.lockScreen === true,
    quickTile: o.quickTile === true,
    available: o.available !== false,
  };
}

/** core `WidgetSnapshot` JSON'unu yazar (yeniden çizim ayrı: `reload`). */
export async function setSnapshot(json: string): Promise<void> {
  const m = mod();
  if (!m) return;
  try {
    await m.setSnapshot(json);
  } catch {
    // En iyi çaba: bir sonraki yazım düzeltir.
  }
}

/** Zaman çizelgelerini / RemoteViews'u yeniden çizdirir. Kısıtlama (WIDGET_LIMITS) çağıranın işidir. */
export function reload(_kind: 'all' = 'all'): void {
  const m = mod();
  if (!m) return;
  try {
    const r = m.reload();
    if (r && typeof (r as Promise<void>).catch === 'function') void (r as Promise<void>).catch(() => undefined);
  } catch {
    // yok say
  }
}

/**
 * Yerel bir fotoğrafı (file:// ya da content://) 120 px kare JPEG olarak paylaşılan alana kopyalar; anlık görüntüdeki
 * `avatar_file` için dosya adını döner. Uzak URL kabul edilmez (önce yerel dosyaya indirin).
 */
export async function saveAvatar(uid: string, localFileUri: string): Promise<string | null> {
  const m = mod();
  if (!m || !uid || !localFileUri) return null;
  try {
    const name = await m.saveAvatar(uid, localFileUri);
    return typeof name === 'string' && AVATAR_FILE_RE.test(name) ? name : null;
  } catch {
    return null;
  }
}

export async function removeAvatar(uid: string): Promise<void> {
  const m = mod();
  if (!m || !uid) return;
  try {
    await m.removeAvatar(uid);
  } catch {
    // yok say
  }
}

/**
 * Hızlı paylaşım belirtecini yazar (null / geçersiz → siler). Yazılamazsa (ör. imzasız iOS simülatöründe anahtarlık
 * erişim grubu) yerel taraf bitiş zamanını da yazmaz: widget "belirteç yok" sayıp uygulamayı açar.
 */
export async function setQuickShareCredential(c: QuickShareCredential | null): Promise<void> {
  const m = mod();
  if (!m) return;
  try {
    const valid =
      c !== null &&
      typeof c.token === 'string' &&
      c.token.length > 0 &&
      typeof c.endpoint === 'string' &&
      ENDPOINT_RE.test(c.endpoint) &&
      Number.isFinite(c.expires_at) &&
      c.expires_at > 0;
    if (!valid) {
      await m.clearQuickShareCredential();
      return;
    }
    await m.setQuickShareCredential(c.token, c.endpoint, Math.round(c.expires_at));
  } catch {
    // yok say
  }
}

/** Widget'ın uygulama kapalıyken kaydettiği olayları okur ve siler (ön plana dönüşte çağrılır). */
export async function consumeEvents(): Promise<WidgetQuickShareEvent[]> {
  const m = mod();
  if (!m) return [];
  try {
    return parseWidgetEvents(await m.consumeEvents());
  } catch {
    return [];
  }
}

export function capabilities(): WidgetCapabilities {
  const m = mod();
  if (!m) return fallbackCapabilities();
  try {
    return parseCapabilities(m.capabilities());
  } catch {
    return fallbackCapabilities();
  }
}

/** Tek nesne olarak da kullanılabilir: `widgetBridge.setSnapshot(...)`. */
export const widgetBridge = {
  setSnapshot,
  reload,
  saveAvatar,
  removeAvatar,
  setQuickShareCredential,
  consumeEvents,
  capabilities,
  isAvailable: isWidgetModuleAvailable,
} as const;
