/**
 * Faz 5 push verisi (core `PUSH_TYPES_F5`: zone_event, meetup, meetup_response) — platformdan bağımsız, saf yardımcılar.
 *
 *  - `parseF5Data`: FCM `data` / yerel bildirim `data` → tipli olay (bozuk veri null).
 *  - `f5ForegroundContent`: uygulama ÖNDEYKEN FCM bildirimi sistemce gösterilmez → yerel bildirim içeriği.
 *    `meetup` önde gösterilmez (uygulama içi buluşma kartı açılır, `routeF5Received`), `includeMeetup` ile zorlanır.
 *  - `routeF5Received` (önde alındı) / `routeF5Open` (bildirime dokunuldu) → f5Services işleyicisi:
 *    `zone_event` → haritada göndereni vurgula, `meetup` / `meetup_response` → `meetupStore.focus`.
 *    İşleyici henüz kurulmadıysa (soğuk açılış) son dokunma bekletilir.
 * Push yükünde koordinat YOKTUR: bölge olayı yalnızca bölge ADINI, buluşma önerisi yalnızca kimliği taşır.
 */
import {
  meetupPushText,
  meetupResponsePushText,
  NOTIFICATION_CHANNELS_F4,
  PUSH_TYPES_F5,
  ZONE_TRIGGERS,
  zoneEventPushText,
  type ZoneTrigger,
} from '@konum/core';
import type { F4LocalContent, F4PushLike } from './f4Push';

export type F5PushType = (typeof PUSH_TYPES_F5)[number];

export type F5PushEvent =
  | { type: 'zone_event'; from: string; zone_name: string; transition: ZoneTrigger }
  | { type: 'meetup'; meetup_id: string; from: string }
  | { type: 'meetup_response'; meetup_id: string; by: string; response: 'accepted' | 'declined' };

export const isF5PushType = (t: unknown): t is F5PushType => typeof t === 'string' && (PUSH_TYPES_F5 as readonly string[]).includes(t);

const str = (v: unknown, max = 128): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export function parseF5Data(data: Record<string, unknown> | null | undefined): F5PushEvent | null {
  if (!data || !isF5PushType(data.type)) return null;
  switch (data.type) {
    case 'zone_event': {
      const from = str(data.from);
      const zone_name = str(data.zone_name, 64);
      const transition = (ZONE_TRIGGERS as readonly string[]).includes(String(data.transition)) ? (data.transition as ZoneTrigger) : null;
      return from && zone_name && transition ? { type: 'zone_event', from, zone_name, transition } : null;
    }
    case 'meetup': {
      const meetup_id = str(data.meetup_id);
      const from = str(data.from);
      return meetup_id && from ? { type: 'meetup', meetup_id, from } : null;
    }
    case 'meetup_response': {
      const meetup_id = str(data.meetup_id);
      const by = str(data.by);
      const response = data.response === 'accepted' || data.response === 'declined' ? data.response : null;
      return meetup_id && by && response ? { type: 'meetup_response', meetup_id, by, response } : null;
    }
  }
  return null;
}

/** Ön plan yerel bildirimi (Android kanal `ping`, iOS etkin). Sunucunun başlığı/gövdesi varsa o, yoksa core metinleri. */
export function f5ForegroundContent(m: F4PushLike, opts: { includeMeetup: boolean } = { includeMeetup: false }): F4LocalContent | null {
  const ev = parseF5Data(m.data);
  if (!ev) return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (typeof v === 'string') data[k] = v;
  const pick = (fallback: { title: string; body: string }) => ({ title: m.notification?.title ?? fallback.title, body: m.notification?.body ?? fallback.body });
  const base = { channelId: NOTIFICATION_CHANNELS_F4.ping, data, interruptionLevel: 'active' as const, sound: true };
  switch (ev.type) {
    case 'zone_event':
      return { ...pick(zoneEventPushText('Arkadaşın', ev.zone_name, ev.transition)), ...base };
    case 'meetup':
      if (!opts.includeMeetup) return null;
      return { ...pick(meetupPushText('Arkadaşın', { name: 'yeni bir yer' })), ...base };
    case 'meetup_response':
      return { ...pick(meetupResponsePushText('Arkadaşın', ev.response, { name: 'Buluşma noktası' })), ...base, sound: false };
  }
}

// --- yönlendirme ---------------------------------------------------------------------------------

export interface F5Handlers {
  /** Uygulama öndeyken push alındı. */
  received: (ev: F5PushEvent) => void;
  /** Bildirime dokunuldu. */
  open: (ev: F5PushEvent) => void;
}

let handlers: F5Handlers | null = null;
let pendingOpen: F5PushEvent | null = null;

export function setF5Handlers(h: F5Handlers | null): void {
  handlers = h;
  if (h && pendingOpen) {
    const ev = pendingOpen;
    pendingOpen = null;
    h.open(ev);
  }
}

/** Dönen: Faz 5 verisi miydi. */
export function routeF5Received(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF5Data(data);
  if (!ev) return false;
  handlers?.received(ev);
  return true;
}

export function routeF5Open(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF5Data(data);
  if (!ev) return false;
  if (handlers) handlers.open(ev);
  else pendingOpen = ev;
  return true;
}
