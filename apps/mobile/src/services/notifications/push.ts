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
 */
import { lowBatteryPushText, type PushData, type UserId } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deleteToken,
  getMessaging,
  getToken,
  onMessage,
  onTokenRefresh,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import { ensureFirebase } from '../firebase/init';
import { deleteDeviceToken, saveDeviceToken } from '../firebase/profileRepo';
import { resumeTracking } from '../location/resume';
import * as Notifications from './expoNotifications';

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
  return () => {
    unRefresh();
    unMessage();
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
      if (pushType(m as unknown as PushLike) === 'resume_tracking') await resumeTracking('push').catch(() => undefined);
    });
  } catch {
    // Firebase yapılandırılmamışsa (ör. test) sessizce geç.
  }
}
