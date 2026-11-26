/**
 * Faz 9 push verisi (core `PUSH_TYPES_F9`) — platformdan bağımsız, saf yardımcılar. Ayrıntı: docs/PHASE9.md §5.
 *
 *  - `approach` (oturumun alıcılarına, heads-up): "Ayşe: Neredeyse vardım (1 dk)" · "Ev". Faz 7 `movement` kanalı,
 *    iOS `timeSensitive`. Dokununca göndereni haritada vurgula.
 *  - `safe_return_started` / `safe_return_ended` (acil kişilere): `safe_return` kanalı, `active`. Dokununca harita.
 *  - `safe_return_due` (sahibin KENDİ cihazlarına): "Güvende misin?", kategori `SAFE_RETURN` (Güvendeyim / +15 dk
 *    eylemleri, `safeReturnActions`). Uygulama öndeyken sistem bildirimi GÖSTERİLMEZ (uygulama içi son uyarı ve
 *    planlanmış yerel bildirim zaten var); dokununca Güvenli Dönüş ekranı.
 *  - Güvenli Dönüş alarmı Faz 4 `sos` türüyle gelir (`origin: 'safe_return'`): `sosOriginOf`.
 * Push'ta koordinat YOK.
 */
import {
  approachPushText,
  NOTIFICATION_CATEGORIES_F9,
  NOTIFICATION_CHANNELS_F7,
  NOTIFICATION_CHANNELS_F9,
  PUSH_TYPES_F9,
  safeReturnDuePushText,
  safeReturnEndedPushText,
  SOS_ORIGINS,
  type SosOrigin,
  type UserId,
} from '@konum/core';
import type { F4LocalContent, F4PushLike } from './f4Push';

export type F9PushType = (typeof PUSH_TYPES_F9)[number];

export type SafeReturnEndReason = 'arrived' | 'checked_in' | 'cancelled';

export type F9PushEvent =
  | { type: 'approach'; from: UserId; dest_name: string; eta_min: number }
  | { type: 'safe_return_started'; safe_return_id: string; from: UserId; due_at: number }
  | { type: 'safe_return_ended'; safe_return_id: string; from: UserId; reason: SafeReturnEndReason }
  | { type: 'safe_return_due'; safe_return_id: string; grace_until: number };

/** Ön plan yerel bildirimi (Faz 4 içeriği + isteğe bağlı iOS kategori). */
export type F9LocalContent = F4LocalContent & { categoryIdentifier?: string };

export const isF9PushType = (t: unknown): t is F9PushType => typeof t === 'string' && (PUSH_TYPES_F9 as readonly string[]).includes(t);

const uidOf = (v: unknown): UserId | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null);
const idOf = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const numOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const END_REASONS: readonly SafeReturnEndReason[] = ['arrived', 'checked_in', 'cancelled'];

export function parseF9Data(data: Record<string, unknown> | null | undefined): F9PushEvent | null {
  if (!data || !isF9PushType(data.type)) return null;
  switch (data.type) {
    case 'approach': {
      const from = uidOf(data.from);
      const dest_name = typeof data.dest_name === 'string' && data.dest_name.length <= 64 ? data.dest_name : null;
      const eta = numOf(data.eta_min);
      return from && dest_name !== null && eta !== null ? { type: 'approach', from, dest_name, eta_min: Math.max(0, Math.round(eta)) } : null;
    }
    case 'safe_return_started': {
      const id = idOf(data.safe_return_id);
      const from = uidOf(data.from);
      const due = numOf(data.due_at);
      return id && from && due !== null ? { type: 'safe_return_started', safe_return_id: id, from, due_at: due } : null;
    }
    case 'safe_return_ended': {
      const id = idOf(data.safe_return_id);
      const from = uidOf(data.from);
      const reason = END_REASONS.includes(data.reason as SafeReturnEndReason) ? (data.reason as SafeReturnEndReason) : null;
      return id && from && reason ? { type: 'safe_return_ended', safe_return_id: id, from, reason } : null;
    }
    case 'safe_return_due': {
      const id = idOf(data.safe_return_id);
      const grace = numOf(data.grace_until);
      return id && grace !== null ? { type: 'safe_return_due', safe_return_id: id, grace_until: grace } : null;
    }
  }
  return null;
}

/** Faz 4 `sos` push'unun kaynağı (eski sunucu / istemci için 'manual'). */
export function sosOriginOf(data: Record<string, unknown> | null | undefined): SosOrigin {
  const o = data?.origin;
  return typeof o === 'string' && (SOS_ORIGINS as readonly string[]).includes(o) ? (o as SosOrigin) : 'manual';
}

/** Sunucu her zaman başlık/gövde gönderir; yalnızca eksikse kullanılan yedek metinler. */
function fallbackText(ev: F9PushEvent, nameOf: (uid: UserId) => string | null): { title: string; body: string } {
  switch (ev.type) {
    case 'approach':
      return approachPushText(nameOf(ev.from), ev.dest_name, ev.eta_min);
    case 'safe_return_started':
      return { title: `${nameOf(ev.from) ?? 'Arkadaşın'} Güvenli Dönüş başlattı`, body: 'Süre dolmadan varmazsa ve yanıt vermezse sana haber vereceğiz.' };
    case 'safe_return_ended':
      return safeReturnEndedPushText(nameOf(ev.from) ?? 'Arkadaşın', 'Hedef', ev.reason);
    case 'safe_return_due':
      return safeReturnDuePushText('acil kişilerin');
  }
}

/**
 * Ön plan yerel bildirimi (FCM önde gösterilmez). `safe_return_due` için null: uygulama içi son uyarı + planlanmış
 * yerel bildirim yeterli (aynı uyarı iki kez çalmasın).
 */
export function f9ForegroundContent(m: F4PushLike, nameOf: (uid: UserId) => string | null = () => null): F9LocalContent | null {
  const ev = parseF9Data(m.data);
  if (!ev || ev.type === 'safe_return_due') return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (typeof v === 'string') data[k] = v;
  const fb = fallbackText(ev, nameOf);
  const text = { title: m.notification?.title ?? fb.title, body: m.notification?.body ?? fb.body };
  if (ev.type === 'approach') return { ...text, channelId: NOTIFICATION_CHANNELS_F7.movement, data, interruptionLevel: 'timeSensitive', sound: true };
  return { ...text, channelId: NOTIFICATION_CHANNELS_F9.safeReturn, data, interruptionLevel: 'active', sound: true };
}

/** Arka planda gelen `safe_return_due` için iOS kategori (eylem düğmeleri). */
export const SAFE_RETURN_DUE_CATEGORY = NOTIFICATION_CATEGORIES_F9.safeReturn;

// --- yönlendirme ---------------------------------------------------------------------------------

export interface F9Handlers {
  /** Uygulama öndeyken push alındı. */
  received: (ev: F9PushEvent) => void;
  /** Bildirime dokunuldu. */
  open: (ev: F9PushEvent) => void;
}

let handlers: F9Handlers | null = null;
let pendingOpen: F9PushEvent | null = null;

export function setF9Handlers(h: F9Handlers | null): void {
  handlers = h;
  if (h && pendingOpen) {
    const ev = pendingOpen;
    pendingOpen = null;
    h.open(ev);
  }
}

/** Dönen: Faz 9 verisi miydi. */
export function routeF9Received(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF9Data(data);
  if (!ev) return false;
  handlers?.received(ev);
  return true;
}

export function routeF9Open(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF9Data(data);
  if (!ev) return false;
  if (handlers) handlers.open(ev);
  else pendingOpen = ev;
  return true;
}
