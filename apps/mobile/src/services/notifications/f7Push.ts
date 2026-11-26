/**
 * Faz 7 push verisi (core `PUSH_TYPES_F7`: event_invite, event_stage, event_rsvp, event_reminder, event_cancelled,
 * movement) — platformdan bağımsız, saf yardımcılar.
 *
 *  - `parseF7Data`: FCM `data` / yerel bildirim `data` → tipli olay (bozuk veri null).
 *  - `f7ForegroundContent`: uygulama ÖNDEYKEN FCM bildirimi sistemce gösterilmez → yerel bildirim içeriği.
 *    Etkinlik bildirimleri `events` kanalında (hatırlatıcılar `event_reminders`, zamana duyarlı); "yola çıktı"
 *    `movement` kanalında (IMPORTANCE_HIGH → heads-up banner; iOS `timeSensitive`).
 *  - `routeF7Received` (önde alındı) / `routeF7Open` (bildirime dokunuldu) → f7Services işleyicisi:
 *    etkinlik türleri → `/events/{id}`, `movement` → haritada göndereni vurgula. İşleyici henüz kurulmadıysa
 *    (soğuk açılış) son dokunma bekletilir.
 * Push yükünde koordinat YOKTUR: etkinlik bildirimi yalnızca kimlik ve metin, hareket bildirimi yalnızca göndereni taşır.
 */
import {
  EVENT_REMINDER_KINDS,
  EVENT_STAGE_NOTICES,
  MOVEMENT_KINDS,
  NOTIFICATION_CHANNELS_F7,
  PUSH_TYPES_F7,
  ATTENDANCE_STATUSES,
  movementPushText,
  type AttendanceStatus,
  type EventReminderKind,
  type EventStageNotice,
  type MovementKind,
} from '@konum/core';
import type { F4LocalContent, F4PushLike } from './f4Push';

export type F7PushType = (typeof PUSH_TYPES_F7)[number];

export type F7EventPush =
  | { type: 'event_invite'; event_id: string; from: string }
  | { type: 'event_stage'; event_id: string; notice: EventStageNotice }
  | { type: 'event_rsvp'; event_id: string; by: string; status: AttendanceStatus }
  | { type: 'event_reminder'; event_id: string; kind: EventReminderKind }
  | { type: 'event_cancelled'; event_id: string };

export type F7PushEvent = F7EventPush | { type: 'movement'; from: string; kind: MovementKind };

export const isF7PushType = (t: unknown): t is F7PushType => typeof t === 'string' && (PUSH_TYPES_F7 as readonly string[]).includes(t);

const str = (v: unknown, max = 128): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => ((list as readonly string[]).includes(String(v)) ? (v as T) : null);

export function parseF7Data(data: Record<string, unknown> | null | undefined): F7PushEvent | null {
  if (!data || !isF7PushType(data.type)) return null;
  if (data.type === 'movement') {
    const from = str(data.from);
    const kind = oneOf(MOVEMENT_KINDS, data.kind);
    return from && kind ? { type: 'movement', from, kind } : null;
  }
  const event_id = str(data.event_id, 64);
  if (!event_id) return null;
  switch (data.type) {
    case 'event_invite': {
      const from = str(data.from);
      return from ? { type: 'event_invite', event_id, from } : null;
    }
    case 'event_stage': {
      const notice = oneOf(EVENT_STAGE_NOTICES, data.notice);
      return notice ? { type: 'event_stage', event_id, notice } : null;
    }
    case 'event_rsvp': {
      const by = str(data.by);
      const status = oneOf(ATTENDANCE_STATUSES, data.status);
      return by && status ? { type: 'event_rsvp', event_id, by, status } : null;
    }
    case 'event_reminder': {
      const kind = oneOf(EVENT_REMINDER_KINDS, data.kind);
      return kind ? { type: 'event_reminder', event_id, kind } : null;
    }
    case 'event_cancelled':
      return { type: 'event_cancelled', event_id };
  }
  return null;
}

/** Sunucu her zaman başlık/gövde gönderir; yalnızca eksikse kullanılan yedek metinler (kişisel bilgi yok). */
function fallbackText(ev: F7PushEvent, nameOf: (uid: string) => string | null): { title: string; body: string } {
  switch (ev.type) {
    case 'movement':
      return movementPushText(nameOf(ev.from) ?? 'Arkadaşın', ev.kind);
    case 'event_invite':
      return { title: 'Etkinlik daveti', body: `${nameOf(ev.from) ?? 'Bir arkadaşın'} seni bir etkinliğe davet etti` };
    case 'event_stage':
      return ev.notice === 'results'
        ? { title: 'Sonuçlar hazır', body: 'Etkinliğinin yanıtları geldi, sonucu onaylayabilirsin' }
        : ev.notice === 'final'
          ? { title: 'Etkinlik kesinleşti', body: 'Mekan ve saat belli oldu' }
          : { title: 'Etkinlik güncellendi', body: 'Yanıtını gözden geçir' };
    case 'event_rsvp':
      return { title: 'Etkinlik yanıtı', body: `${nameOf(ev.by) ?? 'Bir davetli'} ${ev.status === 'going' ? 'katılacak' : 'katılamayacak'}` };
    case 'event_reminder':
      return { title: ev.kind === 'day_before' ? 'Yarın etkinliğin var' : 'Bugün etkinliğin var', body: 'Ayrıntılar için dokun' };
    case 'event_cancelled':
      return { title: 'Etkinlik iptal edildi', body: 'Düzenleyen etkinliği iptal etti' };
  }
}

/** Ön plan yerel bildirimi. `nameOf`: arkadaş adı (yalnızca sunucu metni eksikse). */
export function f7ForegroundContent(m: F4PushLike, nameOf: (uid: string) => string | null = () => null): F4LocalContent | null {
  const ev = parseF7Data(m.data);
  if (!ev) return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (typeof v === 'string') data[k] = v;
  const fb = fallbackText(ev, nameOf);
  const text = { title: m.notification?.title ?? fb.title, body: m.notification?.body ?? fb.body };
  if (ev.type === 'movement') return { ...text, channelId: NOTIFICATION_CHANNELS_F7.movement, data, interruptionLevel: 'timeSensitive', sound: true };
  if (ev.type === 'event_reminder') return { ...text, channelId: NOTIFICATION_CHANNELS_F7.eventReminders, data, interruptionLevel: 'timeSensitive', sound: true };
  // Tek tek yanıt bildirimleri (sonuçlardan sonra, yalnızca sahibe) sessiz: kalabalık davette telefonu sürekli çaldırmasın.
  return { ...text, channelId: NOTIFICATION_CHANNELS_F7.events, data, interruptionLevel: 'active', sound: ev.type !== 'event_rsvp' };
}

/** Etkinlik bildiriminin açacağı ekran (hareket bildirimi haritaya gider: null). */
export const f7EventRoute = (ev: F7PushEvent): string | null => (ev.type === 'movement' ? null : `/events/${encodeURIComponent(ev.event_id)}`);

// --- yönlendirme ---------------------------------------------------------------------------------

export interface F7Handlers {
  /** Uygulama öndeyken push alındı. */
  received: (ev: F7PushEvent) => void;
  /** Bildirime dokunuldu. */
  open: (ev: F7PushEvent) => void;
}

let handlers: F7Handlers | null = null;
let pendingOpen: F7PushEvent | null = null;

export function setF7Handlers(h: F7Handlers | null): void {
  handlers = h;
  if (h && pendingOpen) {
    const ev = pendingOpen;
    pendingOpen = null;
    h.open(ev);
  }
}

/** Dönen: Faz 7 verisi miydi. */
export function routeF7Received(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF7Data(data);
  if (!ev) return false;
  handlers?.received(ev);
  return true;
}

export function routeF7Open(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF7Data(data);
  if (!ev) return false;
  if (handlers) handlers.open(ev);
  else pendingOpen = ev;
  return true;
}
