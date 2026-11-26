/**
 * Web demo: FCM yerine demo sunucusunun push kanalı (native `push.ts` ile aynı dışa aktarımlar).
 *  - `registerPushToken(uid)` → sunucu aboneliği; uygulama ÖNDEYKEN gelen `battery_low` native'deki gibi yerel
 *    bildirimle gösterilir (demo kabuğu bunu telefon çerçevesinde bildirim kartı olarak çizer).
 *  - Simüle bağlantı yokken push gelmez; bağlantı gelince bekleyenler iletilir.
 *  - `resume_tracking` / arka plan mesaj işleyicisi demoda yok (gönderen bekçisi demo sunucusunda çalışmaz).
 * Koordinat taşımaz (core `PushData`).
 * Faz 7: etkinlik bildirimleri / "yola çıktı" bildirim kartı; dokunuş → f7Services.
 * Faz 8: izin isteği / izin verildi bildirim kartı; dokunuş (`respondToDemoNotification`) → f8Services → Arkadaşlar.
 */
import { lowBatteryPushText, type PushData, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import type { DemoPushMessage } from '../../demo/server/server';
import { demoOnline, onDemoNetworkChange } from '../../demo/web/network';
import { demoScreenLocked } from '../../demo/web/screen';
import * as Notifications from './expoNotifications';
import { f4ForegroundContent } from './f4Push';
import { f5ForegroundContent, isF5PushType, routeF5Received } from './f5Push';
import { f6ForegroundContent, isF6PushType, routeF6Received } from './f6Push';
import { f7ForegroundContent, isF7PushType, routeF7Received } from './f7Push';
import { f8ForegroundContent, isF8PushType, routeF8Received } from './f8Push';
import { f9ForegroundContent, isF9PushType, routeF9Received } from './f9Push';
import { friendsStore, selectFriends } from '../../state/friendsStore';
import { locationRequestLocalContent } from './locationRequestPush';

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
  // Faz 5: bölge olayı / buluşma yanıtı bildirim kartı; buluşma önerisi uygulama içi kart (kilitliyken bildirim).
  if (isF5PushType(m.data?.type)) {
    routeF5Received(m.data);
    const f5 = f5ForegroundContent(m, { includeMeetup: demoScreenLocked() });
    if (!f5) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: f5.title, body: f5.body, data: f5.data, interruptionLevel: f5.interruptionLevel },
      trigger: { channelId: f5.channelId },
    });
    return;
  }
  // Faz 6: widget paylaşımı onayı bildirim kartı; `widget_refresh` sessiz (f6Services → requestWidgetSync).
  if (isF6PushType(m.data?.type)) {
    routeF6Received(m.data);
    const f6 = f6ForegroundContent(m);
    if (!f6) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: f6.title, body: f6.body, data: f6.data, interruptionLevel: f6.interruptionLevel },
      trigger: { channelId: f6.channelId },
    });
    return;
  }
  // Konum İste: Onayla / Reddet eylemli bildirim kartı (demo kabuğu eylemleri çizer).
  const lr = locationRequestLocalContent(m, (id) => selectFriends(friendsStore.getState()).find((f) => f.uid === id)?.displayName || null);
  if (lr) {
    await Notifications.scheduleNotificationAsync({
      content: { title: lr.title, body: lr.body, data: lr.data, interruptionLevel: 'active', ...(lr.categoryIdentifier ? { categoryIdentifier: lr.categoryIdentifier } : {}) },
      trigger: { channelId: lr.channelId },
    });
    return;
  }
  // Faz 7: etkinlik ve "yola çıktı" bildirim kartı (dokunuş → f7Services → etkinlik ekranı / harita).
  if (isF7PushType(m.data?.type)) {
    routeF7Received(m.data);
    const f7 = f7ForegroundContent(m, (id) => selectFriends(friendsStore.getState()).find((f) => f.uid === id)?.displayName || null);
    if (!f7) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: f7.title, body: f7.body, data: f7.data, interruptionLevel: f7.interruptionLevel },
      trigger: { channelId: f7.channelId },
    });
    return;
  }
  if (isF8PushType(m.data?.type)) {
    routeF8Received(m.data);
    const f8 = f8ForegroundContent(m, (id) => selectFriends(friendsStore.getState()).find((f) => f.uid === id)?.displayName || null);
    if (!f8) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: f8.title, body: f8.body, data: f8.data, interruptionLevel: f8.interruptionLevel },
      trigger: { channelId: f8.channelId },
    });
    return;
  }
  // Faz 9: "Neredeyse vardım" (movement kanalı) ve Güvenli Dönüş başladı / bitti bildirim kartı; sahibin "Güvende
  // misin?" push'u önde gösterilmez (uygulama içi son uyarı + planlanmış yerel bildirim), yalnızca durum tazelenir.
  if (isF9PushType(m.data?.type)) {
    routeF9Received(m.data);
    const f9 = f9ForegroundContent(m, (id) => selectFriends(friendsStore.getState()).find((f) => f.uid === id)?.displayName || null);
    if (!f9) return;
    await Notifications.scheduleNotificationAsync({
      content: { title: f9.title, body: f9.body, data: f9.data, interruptionLevel: f9.interruptionLevel },
      trigger: { channelId: f9.channelId },
    });
    return;
  }
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
