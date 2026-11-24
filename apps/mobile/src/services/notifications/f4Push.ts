/**
 * Faz 4 push verisi (core `PUSH_TYPES_F4`: ping, sos, sos_resolved, sos_ack) — platformdan bağımsız, saf yardımcılar.
 *
 *  - `parseF4Data`: FCM `data` / yerel bildirim `data` → tipli olay (bozuk veri null).
 *  - `f4ForegroundContent`: uygulama ÖNDEYKEN FCM bildirimi sistemce gösterilmez → yerel bildirim içeriği
 *    (SOS ön planda da gösterilir; ping ön planda uygulama içi kartla gösterildiği için varsayılan olarak atlanır).
 *  - `routeF4Open` / `setF4OpenHandler`: bildirime dokunma (FCM `onNotificationOpenedApp` / soğuk açılış
 *    `getInitialNotification` / yerel bildirim yanıtı) → koordinatörün işleyicisi (`sos` → tam ekran kart,
 *    `ping` → göndereni haritada vurgula). İşleyici henüz kurulmadıysa (soğuk açılış) son olay bekletilir.
 * Push yükünde koordinat YOKTUR; tam konum `sos_alerts` / `ping_inbox`'tan okunur.
 */
import {
  NOTIFICATION_CHANNELS_F4,
  PING_KINDS,
  pingPushText,
  PUSH_TYPES_F4,
  sosAckPushText,
  sosResolvedPushText,
  SOS_MESSAGE,
  type PingKind,
} from '@konum/core';

export type F4PushType = (typeof PUSH_TYPES_F4)[number];

export type F4PushEvent =
  | { type: 'ping'; ping_id: string; from: string; kind: PingKind }
  | { type: 'sos'; sos_id: string; sender_id: string }
  | { type: 'sos_resolved'; sos_id: string; sender_id: string }
  | { type: 'sos_ack'; sos_id: string; by: string };

/** Testlerde de kurulabilen asgari mesaj biçimi (push.ts `PushLike` ile aynı). */
export interface F4PushLike {
  data?: Record<string, unknown> | undefined;
  notification?: { title?: string; body?: string } | undefined;
}

export const isF4PushType = (t: unknown): t is F4PushType => typeof t === 'string' && (PUSH_TYPES_F4 as readonly string[]).includes(t);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : null);

export function parseF4Data(data: Record<string, unknown> | null | undefined): F4PushEvent | null {
  if (!data || !isF4PushType(data.type)) return null;
  switch (data.type) {
    case 'ping': {
      const ping_id = str(data.ping_id);
      const from = str(data.from);
      const kind = (PING_KINDS as readonly string[]).includes(String(data.kind)) ? (data.kind as PingKind) : null;
      return ping_id && from && kind ? { type: 'ping', ping_id, from, kind } : null;
    }
    case 'sos':
    case 'sos_resolved': {
      const sos_id = str(data.sos_id);
      const sender_id = str(data.sender_id);
      return sos_id && sender_id ? { type: data.type, sos_id, sender_id } : null;
    }
    case 'sos_ack': {
      const sos_id = str(data.sos_id);
      const by = str(data.by);
      return sos_id && by ? { type: 'sos_ack', sos_id, by } : null;
    }
  }
  return null;
}

export interface F4LocalContent {
  title: string;
  body: string;
  /** Android kanalı (core `NOTIFICATION_CHANNELS_F4`). */
  channelId: string;
  data: Record<string, string>;
  /** iOS 15+: SOS zamana duyarlı (odak modunu deler); diğerleri etkin. */
  interruptionLevel: 'active' | 'timeSensitive';
  sound: boolean;
}

/**
 * Ön plan yerel bildirimi. Sunucunun başlığı/gövdesi varsa o (adres, pil vb. sunucu metni), yoksa core metinleri.
 * `includePing` false iken ping için null (uygulama içi PingToast gösterir).
 */
export function f4ForegroundContent(m: F4PushLike, opts: { includePing: boolean }): F4LocalContent | null {
  const ev = parseF4Data(m.data);
  if (!ev) return null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.data ?? {})) if (typeof v === 'string') data[k] = v;
  const pick = (fallback: { title: string; body: string }) => ({
    title: m.notification?.title ?? fallback.title,
    body: m.notification?.body ?? fallback.body,
  });
  switch (ev.type) {
    case 'ping':
      if (!opts.includePing) return null;
      return { ...pick(pingPushText('Arkadaşın', ev.kind)), channelId: NOTIFICATION_CHANNELS_F4.ping, data, interruptionLevel: 'active', sound: true };
    case 'sos':
      return {
        ...pick({ title: 'ACİL DURUM', body: `${SOS_MESSAGE}. Konumu görmek için dokun.` }),
        channelId: NOTIFICATION_CHANNELS_F4.sos,
        data,
        interruptionLevel: 'timeSensitive',
        sound: true,
      };
    case 'sos_resolved':
      return { ...pick(sosResolvedPushText('Arkadaşın')), channelId: NOTIFICATION_CHANNELS_F4.ping, data, interruptionLevel: 'active', sound: true };
    case 'sos_ack':
      return { ...pick(sosAckPushText('Acil kişin')), channelId: NOTIFICATION_CHANNELS_F4.ping, data, interruptionLevel: 'active', sound: false };
  }
}

// --- bildirime dokunma yönlendirmesi ---------------------------------------------------------

type OpenHandler = (ev: F4PushEvent) => void;
let openHandler: OpenHandler | null = null;
let pendingOpen: F4PushEvent | null = null;

/** Koordinatör kurar (null = kaldır). Bekleyen (soğuk açılış) olay hemen iletilir. */
export function setF4OpenHandler(h: OpenHandler | null): void {
  openHandler = h;
  if (h && pendingOpen) {
    const ev = pendingOpen;
    pendingOpen = null;
    h(ev);
  }
}

/** Bildirime dokunuldu: Faz 4 verisiyse işleyiciye yönlendirir. Dönen: Faz 4 bildirimi miydi. */
export function routeF4Open(data: Record<string, unknown> | null | undefined): boolean {
  const ev = parseF4Data(data);
  if (!ev) return false;
  if (openHandler) openHandler(ev);
  else pendingOpen = ev;
  return true;
}
