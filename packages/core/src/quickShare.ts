/**
 * Faz 6: widget / kilit ekranı / Android hızlı ayar kutucuğundan TEK TUŞLA 1 saatlik paylaşım.
 *
 * Kimlik: widget uzantısı (iOS) ve AppWidget alıcısı (Android) Firebase Auth oturumuna ve App Check'e erişemez.
 * Bu yüzden uygulama oturum açıkken `widget_token_issue` ile CİHAZA ÖZEL bir widget token'ı alır (32 bayt,
 * base64url 43 karakter; Faz 2 bağlantı token'ı ile aynı biçim) ve onu paylaşılan anahtar zincirine (iOS) /
 * şifreli tercihlere (Android) yazar. Sunucu düz token'ı SAKLAMAZ: `widget_tokens/{sha256Hex(token)}`.
 *  - `widget_quick_share` kimliksiz çağrılır, yalnızca token + favori hedef ile; token yalnızca sahibinin
 *    FAVORİLERİNE 1 saatlik paylaşım başlatabilir/uzatabilir (başka hiçbir yetkisi yoktur).
 *  - iOS'ta intent `authenticationPolicy = .requiresAuthentication`: kilitli telefondan Face ID/parola olmadan
 *    paylaşım başlamaz. Android kutucuğu `unlockAndRun` kullanır.
 *  - Token 30 gün geçerlidir, son 7 günde uygulama ön plandayken yenilenir; çıkışta / hesap silmede iptal edilir.
 *  - Token başına saatte en çok 6 hızlı paylaşım (kötüye kullanım sınırı).
 *
 * Karar (`quickShareRoute`): arka planda dene ya da uygulamayı derin bağlantıyla aç. Arka plan çağrısı başarısız
 * olursa `quickShareErrorAction` uygulamaya mı düşüleceğini, yoksa widget'ta kısa hata metni mi gösterileceğini söyler.
 */
import { z } from 'zod';
import { DURATION_LIMITS, type DurationChoice, type ExpiringShareLike, type ShareMode } from './duration';
import { generateLinkToken, LINK_SCHEME, LINK_TOKEN_RE, sha256Hex } from './link';
import type { ShareId, UserId } from './model';
import { DAY, MINUTE, type EpochMs } from './time';

export const QUICK_SHARE_DURATION_MIN = 60;
/** Uygulama içi "1 sa" düğmesi ve sunucunun yeni paylaşımı: mevcut `share_start` hazır süresi. */
export const QUICK_SHARE_DURATION: DurationChoice = { kind: 'preset', preset: 'h1' };

export const QUICK_SHARE_LIMITS = {
  perTokenPerHour: 6,
  tokenTtlMs: 30 * DAY,
  tokenRefreshBeforeMs: 7 * DAY,
} as const;

/** Bitişe bundan az kalmış token arka planda kullanılmaz (saat kayması payı); uygulama açılıp yenilenir. [Varsayım] */
export const WIDGET_TOKEN_EXPIRY_MARGIN_MS = 5 * MINUTE;

export const WIDGET_TOKEN_BYTES = 32; // base64url 43 karakter; sunucu yalnızca sha256 hex saklar
export const WIDGET_TOKEN_RE = LINK_TOKEN_RE;
export const WIDGET_QUICK_SHARE_ENDPOINT = 'widget_quick_share' as const;
/**
 * `quick_share_started` görünür push'unun iOS bildirim kategorisi (backend APNs `aps.category`) ve "Durdur" eylemi.
 * Uygulama kategoriyi eylemiyle kaydeder; eylem yalnızca o kişiye açık oturumu durdurur (çok kişilikse harita kartı).
 */
export const QUICK_SHARE_NOTIFICATION = { category: 'QUICK_SHARE', stopAction: 'QUICK_SHARE_STOP' } as const;

export const generateWidgetToken = (rand?: (n: number) => Uint8Array): string => generateLinkToken(rand);
export const widgetTokenHash = (token: string): string => sha256Hex(token);
export const isWidgetToken = (s: unknown): s is string => typeof s === 'string' && WIDGET_TOKEN_RE.test(s);

/** Token yenilenmeli mi (uygulama ön planda / oturum açılışında). */
export function widgetTokenNeedsRefresh(expiresAt: EpochMs | null, now: EpochMs): boolean {
  return expiresAt === null || expiresAt - now <= QUICK_SHARE_LIMITS.tokenRefreshBeforeMs;
}

// ---------------------------------------------------------------------------
// Şemalar
// ---------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
/** Kurulum başına kimlik (uygulama ilk açılışta UUID üretip saklar). */
export const DeviceIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const QUICK_SHARE_SOURCES = ['ios_widget', 'ios_lock', 'android_widget', 'android_tile'] as const;
export type QuickShareSource = (typeof QUICK_SHARE_SOURCES)[number];

/** `widget_token_issue` (oturum + App Check). Aynı cihaz için yeniden çağrı eski token'ı iptal eder. */
export const WidgetTokenIssueRequestSchema = z.object({ op_id: z.uuid(), device_id: DeviceIdSchema });
export type WidgetTokenIssueRequest = z.input<typeof WidgetTokenIssueRequestSchema>;
export interface WidgetTokenIssueResponse {
  /** YALNIZCA bu yanıtta döner; cihaz güvenli depoya yazar, snapshot'a ASLA girmez. */
  token: string;
  expires_at: EpochMs;
  /** Callable adı; yerel kod tam URL'yi bölge + proje kimliğinden kurar. */
  endpoint_path: typeof WIDGET_QUICK_SHARE_ENDPOINT;
}
export const WidgetTokenIssueResponseSchema: z.ZodType<WidgetTokenIssueResponse> = z.object({
  token: z.string().regex(WIDGET_TOKEN_RE),
  expires_at: z.number().int().positive(),
  endpoint_path: z.literal(WIDGET_QUICK_SHARE_ENDPOINT),
});

/** `widget_token_revoke` (oturum). `device_id: null` = kullanıcının tüm widget token'ları. */
export const WidgetTokenRevokeRequestSchema = z.object({ op_id: z.uuid(), device_id: DeviceIdSchema.nullable() });
export type WidgetTokenRevokeRequest = z.input<typeof WidgetTokenRevokeRequestSchema>;
export interface WidgetTokenRevokeResponse {
  revoked: number;
}
export const WidgetTokenRevokeResponseSchema: z.ZodType<WidgetTokenRevokeResponse> = z.object({
  revoked: z.number().int().nonnegative(),
});

/** `widget_quick_share`: oturum / App Check YOK; yetki = token. `op_id` token başına tekilleştirilir. */
export const WidgetQuickShareRequestSchema = z.object({
  token: z.string().regex(WIDGET_TOKEN_RE),
  to_uid: uid,
  op_id: z.uuid(),
  source: z.enum(QUICK_SHARE_SOURCES),
});
export type WidgetQuickShareRequest = z.input<typeof WidgetQuickShareRequestSchema>;

export const QUICK_SHARE_STATUSES = ['started', 'extended', 'already_active'] as const;
export type QuickShareStatus = (typeof QUICK_SHARE_STATUSES)[number];

export interface WidgetQuickShareResponse {
  status: QuickShareStatus;
  share_id: ShareId;
  /** null YALNIZCA zaten süresiz bir paylaşım varsa (`already_active`). */
  expires_at: EpochMs | null;
  /** Alıcının görünen adı (widget geri bildirimi: "Ayşe ile 1 sa"). */
  to_name: string;
}
export const WidgetQuickShareResponseSchema: z.ZodType<WidgetQuickShareResponse> = z.object({
  status: z.enum(QUICK_SHARE_STATUSES),
  share_id: z.string().min(1).max(300),
  expires_at: z.number().int().positive().nullable(),
  to_name: z.string().max(80),
});

// ---------------------------------------------------------------------------
// Sunucu kararı (backend ve demo sunucusu aynı fonksiyonu kullanır)
// ---------------------------------------------------------------------------

/**
 * Mevcut paylaşım (gönderen → hedef) varsa bitiş = max(mevcut, şimdi + 60 dk): uzadıysa `extended`, zaten o kadar
 * (ya da süresiz) ise `already_active`. Yoksa (ya da bitmişse) yeni 60 dk'lık paylaşım → `started`.
 * "Gün sonuna kadar" paylaşım uzatılınca `timed` olur (`extendExpiry` ile aynı kural).
 */
export function quickShareExpiry(
  current: ExpiringShareLike | null,
  now: EpochMs,
): { status: QuickShareStatus; expires_at: EpochMs | null; share_mode: ShareMode } {
  const target = now + QUICK_SHARE_DURATION_MIN * MINUTE;
  const active = current && current.status === 'active' && (current.expires_at === null || current.expires_at > now);
  if (!current || !active) return { status: 'started', expires_at: target, share_mode: 'timed' };
  if (current.expires_at === null) return { status: 'already_active', expires_at: null, share_mode: current.share_mode };
  if (current.expires_at >= target) return { status: 'already_active', expires_at: current.expires_at, share_mode: current.share_mode };
  const expires_at = Math.min(target, now + DURATION_LIMITS.maxTimedMs);
  return { status: 'extended', expires_at, share_mode: current.share_mode === 'until_end_of_day' ? 'timed' : current.share_mode };
}

/** Gönderenin görünür bildirimi (`quick_share_started`). Koordinat yok. */
export function quickSharePushText(toName: string, status: QuickShareStatus): { title: string; body: string } {
  const name = toName.trim() || 'Arkadaşın';
  if (status === 'started') return { title: 'Konum paylaşımı başladı', body: `${name} ile 1 saatlik paylaşım başladı` };
  if (status === 'extended') return { title: 'Konum paylaşımı uzatıldı', body: `${name} ile paylaşım 1 saate uzatıldı` };
  return { title: 'Konum paylaşımı zaten açık', body: `${name} konumunu zaten görüyor` };
}

// ---------------------------------------------------------------------------
// İstemci kararı: arka planda mı, uygulamayı açarak mı?
// ---------------------------------------------------------------------------

export const QUICK_SHARE_ERRORS = [
  'token_invalid',
  'token_expired',
  'not_favorite',
  'not_friend',
  'rate_limited',
  'unavailable',
  'internal',
] as const;
export type QuickShareError = (typeof QUICK_SHARE_ERRORS)[number];

export type QuickShareOpenReason =
  | 'signed_out'
  | 'no_favorite'
  | 'no_token'
  | 'token_expiring'
  | 'no_bg_location'
  | 'ios_too_old'
  | 'error_fallback';

/** Widget/istemci için tek karar: arka planda mı dene, uygulamayı mı aç. */
export type QuickShareRoute = { kind: 'background' } | { kind: 'open_app'; reason: QuickShareOpenReason };

/**
 * Sıra önemlidir (ilk uyan kazanır):
 *  1. oturum yok → uygulama (giriş);
 *  2. favori yok → uygulama (favori seçimi);
 *  3. etkileşimli widget yok (iOS 16) → uygulama (Link / widgetURL);
 *  4. token yok / süresi dolmuş ya da `WIDGET_TOKEN_EXPIRY_MARGIN_MS` içinde dolacak → uygulama (token yenilenir);
 *  5. "Her zaman" konum izni yok → uygulama (arka planda takip başlayamaz; mevcut izin akışı);
 *  6. aksi halde arka planda `widget_quick_share`.
 */
export function quickShareRoute(s: {
  signed_in: boolean;
  target_uid: UserId | null;
  token_expires_at: EpochMs | null;
  bg_location_ok: boolean;
  interactive_supported: boolean;
  now: EpochMs;
}): QuickShareRoute {
  const open = (reason: QuickShareOpenReason): QuickShareRoute => ({ kind: 'open_app', reason });
  if (!s.signed_in) return open('signed_out');
  if (!s.target_uid) return open('no_favorite');
  if (!s.interactive_supported) return open('ios_too_old');
  if (s.token_expires_at === null) return open('no_token');
  if (s.token_expires_at - s.now <= WIDGET_TOKEN_EXPIRY_MARGIN_MS) return open('token_expiring');
  if (!s.bg_location_ok) return open('no_bg_location');
  return { kind: 'background' };
}

/**
 * Arka plan çağrısı başarısız olunca: token / yetki sorunlarında uygulama açılır (orada oturum ve arkadaşlık
 * durumu düzelir, paylaşım uygulamadan başlar); hız sınırı ve bağlantı yokluğunda widget'ta kısa metin gösterilir.
 */
export function quickShareErrorAction(e: QuickShareError): 'open_app' | 'show_error' {
  return e === 'rate_limited' || e === 'unavailable' ? 'show_error' : 'open_app';
}

const QUICK_SHARE_ERROR_TEXT: Record<QuickShareError, string> = {
  token_invalid: 'Uygulamayı açıp tekrar dene',
  token_expired: 'Oturum yenilenmeli',
  not_favorite: 'Kişi favorilerde değil',
  not_friend: 'Artık arkadaş değilsiniz',
  rate_limited: 'Çok sık denendi, bekle',
  unavailable: 'Bağlantı yok',
  internal: 'Bir sorun oluştu',
};

/** Widget boyutunda kısa Türkçe hata metni. */
export function quickShareErrorText(e: QuickShareError): string {
  return QUICK_SHARE_ERROR_TEXT[e] ?? QUICK_SHARE_ERROR_TEXT.internal;
}

/** Callable hata koduna (`HttpsError.details.code`) göre widget hatası; bilinmeyen → `internal`. */
export function toQuickShareError(code: string | null | undefined): QuickShareError {
  if (code === 'not_friends') return 'not_friend';
  if (code === 'unauthenticated') return 'token_invalid';
  return (QUICK_SHARE_ERRORS as readonly string[]).includes(code ?? '') ? (code as QuickShareError) : 'internal';
}

// ---------------------------------------------------------------------------
// Derin bağlantı: `konum://quick-share?to=<uid>&src=<kaynak>`
// ---------------------------------------------------------------------------

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SRC_RE = /^[a-z0-9_]{1,32}$/;
const QUICK_LINK_RE = new RegExp(`^${LINK_SCHEME}:\\/\\/\\/?quick-share\\/?\\?([^#]*)(?:#.*)?$`, 'i');

/** Widget'ın uygulamayı açtığı bağlantı (iOS `Link`/`widgetURL`, Android etkinlik niyeti). */
export function quickShareDeepLink(toUid: UserId, src: string): string {
  if (!UID_RE.test(toUid)) throw new Error('Geçersiz kullanıcı kimliği');
  const s = SRC_RE.test(src) ? src : 'unknown';
  return `${LINK_SCHEME}://quick-share?to=${toUid}&src=${s}`;
}

/** `konum://quick-share?...` ve `konum:///quick-share?...` (expo-router biçimi). Bozuk / eksik `to` → null. */
export function parseQuickShareDeepLink(url: string): { to: UserId; src: string } | null {
  if (typeof url !== 'string') return null;
  const m = QUICK_LINK_RE.exec(url.trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of (m[1] ?? '').split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      q[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  const to = q.to ?? '';
  if (!UID_RE.test(to)) return null;
  const src = q.src && SRC_RE.test(q.src) ? q.src : 'unknown';
  return { to, src };
}
