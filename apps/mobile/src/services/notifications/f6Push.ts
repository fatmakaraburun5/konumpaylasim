/**
 * Faz 6 push verisi (core `PUSH_TYPES_F6`) — platformdan bağımsız, saf yardımcılar.
 *
 *  - `quick_share_started` (gönderenin KENDİ cihazlarına, görünür): widget / kilit ekranından başlatılan 1 saatlik
 *    paylaşım ("Ayşe ile 1 saatlik paylaşım başladı"). Veri: share_id, to_name, expires_at (epoch ms metni; süresiz
 *    paylaşım zaten açıksa boş). KOORDİNAT YOK. Uygulama öndeyken FCM bildirimi göstermez → yerel bildirim.
 *  - `widget_refresh` (yalnızca veri, content-available): bir favorim bana paylaşımı başlattı / durdurdu → widget
 *    snapshot'ı yenilenir. `from` = paylaşanın uid'i.
 * İşleyiciler f6Services'te kurulur; arka plan (başsız) işleyicisi push.ts → widgetBackground.ts.
 */
import { NOTIFICATION_CHANNELS_F4, PUSH_TYPES_F6, quickSharePushText } from '@konum/core';
import type { F4LocalContent, F4PushLike } from './f4Push';

export type F6PushType = (typeof PUSH_TYPES_F6)[number];

export type F6PushEvent =
  | { type: 'quick_share_started'; share_id: string; to_name: string; expires_at: number | null }
  | { type: 'widget_refresh'; from: string };

export const isF6PushType = (t: unknown): t is F6PushType => typeof t === 'string' && (PUSH_TYPES_F6 as readonly string[]).includes(t);

const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export function parseF6Data(data: Record<string, unknown> | null | undefined): F6PushEvent | null {
  if (!data || !isF6PushType(data.type)) return null;
  if (data.type === 'quick_share_started') {
    const share_id = str(data.share_id);
    if (!share_id) return null;
    const exp = Number(data.expires_at);
    return {
      type: 'quick_share_started',
      share_id,
      to_name: typeof data.to_name === 'string' ? data.to_name.slice(0, 80) : '',
      expires_at: typeof data.expires_at === 'string' && data.expires_at !== '' && Number.isFinite(exp) && exp > 0 ? exp : null,
    };
  }
  const from = str(data.from, 128);
  return from ? { type: 'widget_refresh', from } : null;
}

/** Ön plan yerel bildirimi: yalnızca `quick_share_started` (widget_refresh sessizdir). */
export function f6ForegroundContent(m: F4PushLike): F4LocalContent | null {
  const ev = parseF6Data(m.data);
  if (!ev || ev.type !== 'quick_share_started') return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (typeof v === 'string') data[k] = v;
  const fallback = quickSharePushText(ev.to_name, 'started');
  return {
    title: m.notification?.title ?? fallback.title,
    body: m.notification?.body ?? fallback.body,
    channelId: NOTIFICATION_CHANNELS_F4.ping,
    data,
    interruptionLevel: 'active',
    sound: false,
  };
}

// --- yönlendirme ---------------------------------------------------------------------------------

export interface F6Handlers {
  received: (ev: F6PushEvent) => void;
}

let handlers: F6Handlers | null = null;

export function setF6Handlers(h: F6Handlers | null): void {
  handlers = h;
}

/** Dönen: Faz 6 verisi miydi. */
export function routeF6Received(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF6Data(data);
  if (!ev) return false;
  handlers?.received(ev);
  return true;
}
