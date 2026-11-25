/**
 * FCM: cihaz token'ını `devices/{uid}/tokens` altına kaydeder (sunucu konum isteği / arkadaşlık bildirimi
 * gönderir). Push verisi KOORDİNAT TAŞIMAZ (core `PushData`). Bildirim yükleri sistemce gösterilir.
 * Faz 3: `resume_tracking` (sessiz, gönderenin kendi cihazına) takibi yeniden başlatır; `battery_low` uygulama
 * öndeyken yerel bildirimle gösterilir (FCM ön planda bildirim göstermez).
 *
 * Token yaşam döngüsü (çıkış yapan cihaz başkasının bildirimini almasın):
 *  - Çıkıştan ÖNCE (oturum hâlâ açıkken) token belgesi silinir ve token geçersiz kılınır (`deleteToken`).
 *  - Token yenilenince eski token'ın belgesi silinir.
 *  - Bu cihazda en son hangi hesabın token kaydettiği saklanır; başka hesap girerse token önce döndürülür
 *    (çevrimdışı çıkışta eski token silinememiş olabilir: aynı token iki hesapta kayıtlı kalmasın).
 *
 * Faz 6: `quick_share_started` (widget'tan başlatılan paylaşım, gönderene görünür) önde yerel bildirimle gösterilir;
 * `widget_refresh` (yalnızca veri) widget'ı yeniler. Arka planda (başsız) widget paylaşımı kalıcı hedeflere alınır
 * (widgetBackground.ts) ve takip `resume_tracking` ile başlar.
 */
import { QUICK_SHARE_NOTIFICATION, lowBatteryPushText, type PushData, type UserId } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deleteToken,
  getInitialNotification,
  getMessaging,
  getToken,
  onMessage,
  onNotificationOpenedApp,
  onTokenRefresh,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { ensureFirebase } from '../firebase/init';
import { deleteDeviceToken, saveDeviceToken } from '../firebase/profileRepo';
import { resumeTracking } from '../location/resume';
import * as Notifications from './expoNotifications';
import { f4ForegroundContent, routeF4Open } from './f4Push';
import { f5ForegroundContent, isF5PushType, routeF5Open, routeF5Received } from './f5Push';
import { f6ForegroundContent, isF6PushType, routeF6Received } from './f6Push';
import { handleWidgetBackgroundPush } from '../widgets/widgetBackground';

const OWNER_KEY = 'konum.push.owner.v1';
/** [Varsayım] Çıkışta token silme en çok bu kadar bekletir (çevrimdışıysa çıkış yine yapılır). */
const UNREGISTER_TIMEOUT_MS = 5_000;

let currentToken: string | null = null;

async function lastOwner(): Promise<UserId | null> {
  try {
    return await AsyncStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

export async function registerPushToken(uid: UserId): Promise<() => void> {
  await ensureFirebase();
  const messaging = getMessaging();
  try {
    const owner = await lastOwner();
    if (owner && owner !== uid) await deleteToken(messaging).catch(() => undefined);
    const token = await getToken(messaging);
    if (token) {
      currentToken = token;
      await saveDeviceToken(uid, token);
      await AsyncStorage.setItem(OWNER_KEY, uid).catch(() => undefined);
    }
  } catch (e) {
    if (__DEV__) console.warn('[konum] FCM token alınamadı', e);
  }
  const unRefresh = onTokenRefresh(messaging, (t) => {
    const old = currentToken;
    currentToken = t;
    saveDeviceToken(uid, t).catch(() => undefined);
    if (old && old !== t) deleteDeviceToken(uid, old).catch(() => undefined);
  });
  // Faz 3: uygulama ÖNDEYKEN gelen FCM bildirimleri sistemce gösterilmez → düşük pil uyarısı yerel bildirimle.
  const unMessage = onMessage(messaging, (m) => void handleForegroundMessage(m).catch(() => undefined));
  // Faz 4: sistemin gösterdiği FCM bildirimine dokunma (arka plan / kapalıyken) → SOS kartı / ping vurgusu.
  // Faz 5: bölge olayı → göndereni vurgula, buluşma önerisi / yanıtı → buluşma kartı.
  const openRoute = (data: Record<string, unknown> | undefined) => routeF4Open(data) || routeF5Open(data);
  const unOpened = onNotificationOpenedApp(messaging, (m) => void openRoute((m as unknown as PushLike).data));
  void getInitialNotification(messaging)
    .then((m) => (m ? openRoute((m as unknown as PushLike).data) : false))
    .catch(() => undefined);
  return () => {
    unRefresh();
    unMessage();
    unOpened();
  };
}

type RemoteMessage = Parameters<Parameters<typeof onMessage>[1]>[0];
/** Testlerde de kurulabilen asgari mesaj biçimi. */
export interface PushLike {
  data?: Record<string, unknown> | undefined;
  notification?: { title?: string; body?: string } | undefined;
}

/** FCM `data.type` (core `PushData['type']`; Faz 3: battery_low, resume_tracking, tracking_stalled). Bilinmeyen tür olduğu gibi döner. */
export function pushType(m: PushLike): PushData['type'] | (string & {}) | null {
  const t = m.data?.type;
  return typeof t === 'string' ? t : null;
}

/** Düşük pil bildirim metni: sunucunun başlığı varsa o, yoksa core `lowBatteryPushText` (aynı ürün metni). Koordinat yok. */
export function batteryLowContent(m: PushLike): { title: string; body: string } | null {
  if (pushType(m) !== 'battery_low') return null;
  const pct = Number(m.data?.battery_pct);
  const fallback = Number.isFinite(pct)
    ? lowBatteryPushText('', pct)
    : { title: 'Arkadaşının pili azaldı', body: 'Pil azaldı. Konum daha seyrek güncellenecek.' };
  return {
    title: m.notification?.title ?? fallback.title,
    body: m.notification?.body ?? fallback.body,
  };
}

async function handleForegroundMessage(msg: RemoteMessage): Promise<void> {
  const m = msg as unknown as PushLike;
  const type = pushType(m);
  if (type === 'resume_tracking') {
    await resumeTracking('push');
    return;
  }
  const content = batteryLowContent(m);
  if (content) {
    await Notifications.scheduleNotificationAsync({ content: { title: content.title, body: content.body, data: { type: 'battery_low' } }, trigger: null });
    return;
  }
  // Faz 4: SOS ön planda da sesli gösterilir (iOS'ta setNotificationHandler sos için banner + ses açar).
  // Ping ön planda uygulama içi kartla gösterilir (kutu dinleyicisi), sistem bildirimi gerekmez.
  // Faz 5: bölge olayı / buluşma yanıtı yerel bildirimle; buluşma önerisi uygulama içi kartla (routeF5Received).
  if (isF5PushType(m.data?.type)) {
    routeF5Received(m.data);
    const f5 = f5ForegroundContent(m);
    if (f5) {
      await Notifications.scheduleNotificationAsync({
        content: { title: f5.title, body: f5.body, data: f5.data, sound: f5.sound ? 'default' : false, interruptionLevel: f5.interruptionLevel },
        trigger: Platform.OS === 'android' ? { channelId: f5.channelId } : null,
      });
    }
    return;
  }
  // Faz 6: widget paylaşımı onayı yerel bildirimle; widget yenileme sessiz (f6Services → requestWidgetSync).
  if (isF6PushType(m.data?.type)) {
    routeF6Received(m.data);
    const f6 = f6ForegroundContent(m);
    if (f6) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: f6.title,
          body: f6.body,
          data: f6.data,
          sound: f6.sound ? 'default' : false,
          interruptionLevel: f6.interruptionLevel,
          // iOS: uzaktan gelenle aynı kategori → "Durdur" eylemi (f6Services.handleQuickShareResponse).
          categoryIdentifier: QUICK_SHARE_NOTIFICATION.category,
        },
        trigger: Platform.OS === 'android' ? { channelId: f6.channelId } : null,
      });
    }
    return;
  }
  const f4 = f4ForegroundContent(m, { includePing: false });
  if (f4) {
    await Notifications.scheduleNotificationAsync({
      content: { title: f4.title, body: f4.body, data: f4.data, sound: f4.sound ? 'default' : false, interruptionLevel: f4.interruptionLevel },
      trigger: Platform.OS === 'android' ? { channelId: f4.channelId } : null,
    });
  }
}

/** Çıkıştan önce, oturum hâlâ açıkken çağrılır. Hata ve zaman aşımı yutulur: çıkışı engellemez. */
export async function unregisterPushToken(uid: UserId, timeoutMs = UNREGISTER_TIMEOUT_MS): Promise<void> {
  const work = (async () => {
    await ensureFirebase();
    const messaging = getMessaging();
    const token = currentToken ?? (await getToken(messaging).catch(() => null));
    if (token) await deleteDeviceToken(uid, token).catch(() => undefined);
    await deleteToken(messaging).catch(() => undefined);
    currentToken = null;
    await AsyncStorage.removeItem(OWNER_KEY).catch(() => undefined);
  })().catch(() => undefined);
  await Promise.race([work, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

/** index.ts'ten üst seviyede çağrılır (Android başsız mesaj işleyicisi render'dan önce kayıtlı olmalı). */
export function registerBackgroundMessageHandler(): void {
  try {
    setBackgroundMessageHandler(getMessaging(), async (m) => {
      // Bildirim yükü (düşük pil, duraksadı) sistem tarafından gösterilir.
      // Faz 3: `resume_tracking` sessiz uyandırma → takibi yeniden ayağa kaldır (iOS ~30 sn, Android ~10 sn süre).
      // Faz 6: widget'tan başlatılan paylaşım kalıcı hedeflerde yoksa önce sunucudan alınır (widgetBackground).
      const p = m as unknown as PushLike;
      const type = pushType(p);
      if (type === 'resume_tracking') {
        await handleWidgetBackgroundPush(p.data).catch(() => undefined);
        await resumeTracking('push').catch(() => undefined);
        return;
      }
      if (isF6PushType(type)) await handleWidgetBackgroundPush(p.data).catch(() => undefined);
    });
  } catch {
    // Firebase yapılandırılmamışsa (ör. test) sessizce geç.
  }
}
