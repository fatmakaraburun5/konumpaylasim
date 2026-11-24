/**
 * Web demo: FCM yerine demo sunucusunun push kanalı (native `push.ts` ile aynı dışa aktarımlar).
 *  - `registerPushToken(uid)` → sunucu aboneliği; uygulama ÖNDEYKEN gelen `battery_low` native'deki gibi yerel
 *    bildirimle gösterilir (demo kabuğu bunu telefon çerçevesinde bildirim kartı olarak çizer).
 *  - Simüle bağlantı yokken push gelmez; bağlantı gelince bekleyenler iletilir.
 *  - `resume_tracking` / arka plan mesaj işleyicisi demoda yok (gönderen bekçisi demo sunucusunda çalışmaz).
 * Koordinat taşımaz (core `PushData`).
 */
import { lowBatteryPushText, type PushData, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import type { DemoPushMessage } from '../../demo/server/server';
import { demoOnline, onDemoNetworkChange } from '../../demo/web/network';
import { demoScreenLocked } from '../../demo/web/screen';
import * as Notifications from './expoNotifications';
import { f4ForegroundContent } from './f4Push';

/** Testlerde de kurulabilen asgari mesaj biçimi (native ile aynı). */
export interface PushLike {
  data?: Record<string, unknown> | undefined;
  notification?: { title?: string; body?: string } | undefined;
}

export function pushType(m: PushLike): PushData['type'] | (string & {}) | null {
  const t = m.data?.type;
  return typeof t === 'string' ? t : null;
}

/** Native `batteryLowContent` ile aynı: sunucunun başlığı varsa o, yoksa core `lowBatteryPushText`. */
export function batteryLowContent(m: PushLike): { title: string; body: string } | null {
  if (pushType(m) !== 'battery_low') return null;
  const pct = Number(m.data?.battery_pct);
  const fallback = Number.isFinite(pct)
    ? lowBatteryPushText('', pct)
    : { title: 'Arkadaşının pili azaldı', body: 'Pil azaldı. Konum daha seyrek güncellenecek.' };
  return { title: m.notification?.title ?? fallback.title, body: m.notification?.body ?? fallback.body };
}

async function handleForegroundMessage(m: PushLike): Promise<void> {
  const content = batteryLowContent(m);
  if (content) {
    await Notifications.scheduleNotificationAsync({
      content: { title: content.title, body: content.body, data: { type: 'battery_low', share_id: m.data?.share_id ?? null } },
      trigger: null,
    });
    return;
  }
  // Faz 4: SOS / güvende / gördü her zaman bildirim kartı; ping yalnızca ekran kilitliyken (uygulama öndeyken
  // native'deki gibi uygulama içi PingToast gösterilir). Kart dokunuşu `respondToDemoNotification` → koordinatör.
  const f4 = f4ForegroundContent(m, { includePing: demoScreenLocked() });
  if (!f4) return;
  await Notifications.scheduleNotificationAsync({
    content: { title: f4.title, body: f4.body, data: f4.data, interruptionLevel: f4.interruptionLevel },
    trigger: { channelId: f4.channelId },
  });
}

export async function registerPushToken(uid: UserId): Promise<() => void> {
  const waiting: DemoPushMessage[] = [];
  const unPush = demoServer().subscribePush(uid, (m) => {
    if (demoOnline()) void handleForegroundMessage(m).catch(() => undefined);
    else waiting.push(m);
  });
  const unNet = onDemoNetworkChange((online) => {
    if (!online) return;
    for (const m of waiting.splice(0)) void handleForegroundMessage(m).catch(() => undefined);
  });
  return () => {
    unPush();
    unNet();
  };
}

export async function unregisterPushToken(_uid: UserId, _timeoutMs?: number): Promise<void> {
  // no-op
}

export function registerBackgroundMessageHandler(): void {
  // no-op
}
