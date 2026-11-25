import type { ExtensionMinutes } from '@konum/core';

export const SHARE_EXPIRING_CATEGORY = 'SHARE_EXPIRING';
export const ACTION_EXTEND: Record<ExtensionMinutes, string> = { 30: 'EXTEND_30', 60: 'EXTEND_60' };

/** Android bildirim kanalları. */
export const CHANNELS = {
  shareExpiring: 'share_expiring',
  /** FCM tarafı (backend `android.notification.channel_id`) ile aynı ad. */
  locationRequests: 'location_requests',
  /** Faz 3: düşük pil / "paylaşımın duraksadı" (backend FCM `channel_id: share_status`). */
  shareStatus: 'share_status',
  /** Faz 4: acil durum (core `NOTIFICATION_CHANNELS_F4.sos`; backend FCM `channel_id: sos`). */
  sos: 'sos',
  /** Faz 4: "Buradayım / Yoldayım" (core `NOTIFICATION_CHANNELS_F4.ping`). */
  ping: 'ping',
  /** Faz 8: arkadaşlık ve izin istekleri / izin verildi (backend FCM `channel_id: friend_requests`). */
  friendRequests: 'friend_requests',
} as const;

export const expiryNotificationId = (sessionId: string) => `share-expiring-${sessionId}`;
export const EXPIRY_ID_PREFIX = 'share-expiring-';

/** Süresiz paylaşımın haftalık "hâlâ paylaşıyorsun" hatırlatması: `share-reminder-<oturum>#<hafta>`. */
export const REMINDER_ID_PREFIX = 'share-reminder-';
export const reminderNotificationId = (sessionId: string, week: number) => `${REMINDER_ID_PREFIX}${sessionId}#${week}`;

/** expo-notifications arka plan görevi (Android: uygulama kapalıyken eylem düğmesi). */
export const NOTIFICATION_TASK_NAME = 'konum-notification-actions';
