/**
 * Faz 8 push verisi (core `PUSH_TYPES_F8`) — platformdan bağımsız, saf yardımcılar.
 *
 *  - `permission_request` (izni verecek kişiye, görünür): "Can senden konumunu görmek istiyor". Veri: from (isteyen),
 *    scopes (virgülle). Dokununca Arkadaşlar > İzin istekleri açılır, isteyen öne çıkar.
 *  - `permission_granted` (isteyene, görünür): "Can konumunu görmene izin verdi". Veri: by (veren), scopes.
 * Retde, geri almada ve görünmez olmada push YOKTUR (karşı taraf bunu öğrenmez). Push'ta koordinat YOK.
 * Uygulama öndeyken FCM bildirimi göstermez → yerel bildirim (`f8ForegroundContent`).
 */
import {
  ACCESS_SCOPES,
  PUSH_TYPES_F8,
  permissionGrantedText,
  permissionRequestText,
  REQUESTABLE_SCOPES,
  type AccessScope,
  type RequestableScope,
  type UserId,
} from '@konum/core';
import { CHANNELS } from './constants';
import type { F4LocalContent, F4PushLike } from './f4Push';

export type F8PushType = (typeof PUSH_TYPES_F8)[number];

export type F8PushEvent =
  | { type: 'permission_request'; from: UserId; scopes: RequestableScope[] }
  | { type: 'permission_granted'; by: UserId; scopes: AccessScope[] };

export const isF8PushType = (t: unknown): t is F8PushType => typeof t === 'string' && (PUSH_TYPES_F8 as readonly string[]).includes(t);

const uidOf = (v: unknown): UserId | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null);

function scopeList<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (typeof v !== 'string') return [];
  const out: T[] = [];
  for (const s of v.split(',')) {
    const t = s.trim() as T;
    if (allowed.includes(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

export function parseF8Data(data: Record<string, unknown> | null | undefined): F8PushEvent | null {
  if (!data || !isF8PushType(data.type)) return null;
  if (data.type === 'permission_request') {
    const from = uidOf(data.from);
    return from ? { type: 'permission_request', from, scopes: scopeList(data.scopes, REQUESTABLE_SCOPES) } : null;
  }
  const by = uidOf(data.by);
  return by ? { type: 'permission_granted', by, scopes: scopeList(data.scopes, ACCESS_SCOPES) } : null;
}

/** Ön plan yerel bildirimi. `nameOf` arkadaş adını verir (yoksa genel ifade). */
export function f8ForegroundContent(m: F4PushLike, nameOf: (uid: UserId) => string | null): F4LocalContent | null {
  const ev = parseF8Data(m.data);
  if (!ev) return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (typeof v === 'string') data[k] = v;
  const fallback =
    ev.type === 'permission_request'
      ? { title: 'İzin isteği', body: permissionRequestText(nameOf(ev.from) || 'Bir arkadaşın', ev.scopes.length ? ev.scopes : ['location_view']) }
      : { title: 'İzin verildi', body: permissionGrantedText(nameOf(ev.by) || 'Arkadaşın', ev.scopes.length ? ev.scopes : ['location_view']) };
  return {
    title: m.notification?.title ?? fallback.title,
    body: m.notification?.body ?? fallback.body,
    channelId: CHANNELS.friendRequests,
    data,
    interruptionLevel: 'active',
    sound: false,
  };
}

// --- yönlendirme ---------------------------------------------------------------------------------

export interface F8Handlers {
  /** Uygulama öndeyken push alındı. */
  received: (ev: F8PushEvent) => void;
  /** Bildirime dokunuldu. */
  open: (ev: F8PushEvent) => void;
}

let handlers: F8Handlers | null = null;
let pendingOpen: F8PushEvent | null = null;

export function setF8Handlers(h: F8Handlers | null): void {
  handlers = h;
  if (h && pendingOpen) {
    const ev = pendingOpen;
    pendingOpen = null;
    h.open(ev);
  }
}

/** Dönen: Faz 8 verisi miydi. */
export function routeF8Received(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF8Data(data);
  if (!ev) return false;
  handlers?.received(ev);
  return true;
}

/** Bildirime dokunuldu (soğuk açılışta işleyici kurulana kadar bekletilir). */
export function routeF8Open(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF8Data(data);
  if (!ev) return false;
  if (handlers) handlers.open(ev);
  else pendingOpen = ev;
  return true;
}
