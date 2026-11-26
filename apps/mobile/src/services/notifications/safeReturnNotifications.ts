/**
 * Faz 9: Güvenli Dönüş yerel bildirimleri, Android kanalı ve iOS / Android kategorisi.
 *
 *  - Kanal `safe_return` (core `NOTIFICATION_CHANNELS_F9.safeReturn`): IMPORTANCE_HIGH, varsayılan ses (sahip
 *    tehlikedeyse yüksek alarm sesi onu ele vermesin) [Varsayım]. Android kanal ayarları sonradan değişmez: farklı
 *    davranış gerekirse YENİ kanal kimliği açılmalı.
 *  - Kategori `SAFE_RETURN`: "Güvendeyim" (`SAFE_RETURN_OK`, kilit açmayı ister) ve "+15 dk" (`SAFE_RETURN_EXTEND`).
 *    Aynı kategori sunucunun `safe_return_due` push'unda da kullanılır (APNs `aps.category`).
 *  - Yerel plan (core `safeReturnLocalSchedule`): bitişten 5 dk önce hatırlatma, bitişte "Güvende misin?", son
 *    çağrı (son uyarı bitmeden 30 sn önce). Kimlikler `safe-return-<id>-<kind>`; uzatmada iptal edilip yeniden kurulur.
 *    Uygulama kapalıyken de çalar; zamanlayıcının asıl sahibi yine SUNUCUDUR (alarm cihaza bağlı değil).
 *  - Eylem `op_id`'leri bildirim planlanırken üretilip veriye gömülür (aynı dokunuş iki yoldan gelirse sunucu bir
 *    kez uygular).
 */
import {
  NOTIFICATION_CATEGORIES_F9,
  NOTIFICATION_CHANNELS_F9,
  SAFE_RETURN_LIMITS,
  SAFE_RETURN_TEXT,
  safeReturnDuePushText,
  safeReturnLocalSchedule,
  uuidV4,
  type EpochMs,
  type SafeReturnDoc,
} from '@konum/core';
import { Platform } from 'react-native';
import * as Notifications from './expoNotifications';

export const SAFE_RETURN_NOTIFICATION_PREFIX = 'safe-return-';
export type SafeReturnLocalKind = 'reminder' | 'due' | 'last_call';
export const safeReturnNotificationId = (safeReturnId: string, kind: SafeReturnLocalKind) => `${SAFE_RETURN_NOTIFICATION_PREFIX}${safeReturnId}-${kind}`;

/** Yerel bildirim verisi (`type` ön plan sunum kuralı için; push türlerinden ayrı). */
export interface SafeReturnLocalData {
  type: 'safe_return_local';
  kind: SafeReturnLocalKind;
  safe_return_id: string;
  op_ids: { safe: string; extend: string };
  [key: string]: unknown;
}

/** "Annem", "Annem ve Babam", "Annem, Babam ve Ablam"; boşsa "acil kişilerin". */
export function formatContactNames(names: readonly (string | null | undefined)[]): string {
  const list = names.map((n) => (n ?? '').trim()).filter((n) => n.length > 0);
  if (list.length === 0) return 'acil kişilerin';
  if (list.length === 1) return list[0]!;
  return `${list.slice(0, -1).join(', ')} ve ${list[list.length - 1]}`;
}

/** Yerel bildirimin başlık / metin / verisi (saf). */
export function safeReturnLocalContent(
  doc: Pick<SafeReturnDoc, 'safe_return_id' | 'destination'>,
  kind: SafeReturnLocalKind,
  names: string,
  opIds: { safe: string; extend: string } = { safe: uuidV4(), extend: uuidV4() },
): { title: string; body: string; data: SafeReturnLocalData; categoryIdentifier: string } {
  const data: SafeReturnLocalData = { type: 'safe_return_local', kind, safe_return_id: doc.safe_return_id, op_ids: opIds };
  const categoryIdentifier = NOTIFICATION_CATEGORIES_F9.safeReturn;
  switch (kind) {
    case 'reminder':
      return { title: `${SAFE_RETURN_TEXT.title} · ${doc.destination.name}`, body: SAFE_RETURN_TEXT.endingSoon(`${Math.round(SAFE_RETURN_LIMITS.reminderBeforeMs / 60_000)} dk`), data, categoryIdentifier };
    case 'due':
      return { ...safeReturnDuePushText(names), data, categoryIdentifier };
    case 'last_call':
      return { title: SAFE_RETURN_TEXT.finalWarningTitle, body: SAFE_RETURN_TEXT.finalWarningBody(30, names), data, categoryIdentifier };
  }
}

/** Android kanalı (configureNotifications → doConfigure). */
export async function configureF9Channels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS_F9.safeReturn, {
    name: 'Güvenli Dönüş',
    description: 'Güvenli Dönüş zamanlayıcın dolmak üzereyken ve "Güvende misin?" sorusu; kişilerinin başlattığı Güvenli Dönüş',
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    sound: 'default',
    enableVibrate: true,
    vibrationPattern: [0, 400, 200, 400],
  });
}

/**
 * Kategori ve eylemler (iOS + Android). iOS'ta eylem uygulamayı öne getirir (callable güvenle tamamlansın;
 * öne gelmek kilit açmayı da ister). Android'de arka plan görevi (backgroundNotificationTask) çalışır.
 */
export async function configureF9Categories(): Promise<void> {
  const foreground = Platform.OS === 'ios';
  await Notifications.setNotificationCategoryAsync(
    NOTIFICATION_CATEGORIES_F9.safeReturn,
    [
      { identifier: NOTIFICATION_CATEGORIES_F9.actionSafe, buttonTitle: SAFE_RETURN_TEXT.checkIn, options: { opensAppToForeground: foreground, isAuthenticationRequired: true } },
      { identifier: NOTIFICATION_CATEGORIES_F9.actionExtend, buttonTitle: SAFE_RETURN_TEXT.extend, options: { opensAppToForeground: foreground } },
    ],
    { showTitle: true },
  ).catch(() => undefined);
}

/** Planlanmış kimlik → plan anahtarı (aynı plan yeniden kurulmasın). */
const planned = new Map<string, string>();

/**
 * Güvenli Dönüş'ün yerel bildirimlerini uzlaştırır: `now` sunucu saati, `offsetMs` (sunucu − cihaz) düşülür.
 * Etkin değilse hepsi iptal edilir. `names`: "Annem ve Babam".
 */
export async function scheduleSafeReturnLocal(
  doc: Pick<SafeReturnDoc, 'safe_return_id' | 'status' | 'due_at' | 'grace_until' | 'destination'>,
  now: EpochMs,
  offsetMs: number,
  names: string,
): Promise<void> {
  const key = `${doc.status}:${doc.due_at}:${doc.grace_until}`;
  if (doc.status !== 'active') {
    await cancelSafeReturnLocal(doc.safe_return_id);
    return;
  }
  if (planned.get(doc.safe_return_id) === key) return;
  await cancelSafeReturnLocal(doc.safe_return_id);
  const opIds = { safe: uuidV4(), extend: uuidV4() };
  for (const item of safeReturnLocalSchedule(doc, now)) {
    const c = safeReturnLocalContent(doc, item.kind, names, opIds);
    await Notifications.scheduleNotificationAsync({
      identifier: safeReturnNotificationId(doc.safe_return_id, item.kind),
      content: {
        title: c.title,
        body: c.body,
        data: c.data,
        categoryIdentifier: c.categoryIdentifier,
        sound: 'default',
        interruptionLevel: item.kind === 'reminder' ? 'active' : 'timeSensitive',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: item.at - offsetMs,
        channelId: NOTIFICATION_CHANNELS_F9.safeReturn,
      },
    }).catch(() => undefined);
  }
  planned.set(doc.safe_return_id, key);
}

/** Bir Güvenli Dönüş'ün (verilmezse hepsinin) planlı ve teslim edilmiş yerel bildirimlerini kaldırır. */
export async function cancelSafeReturnLocal(safeReturnId?: string | null): Promise<void> {
  if (safeReturnId) {
    planned.delete(safeReturnId);
    for (const kind of ['reminder', 'due', 'last_call'] as const) {
      const id = safeReturnNotificationId(safeReturnId, kind);
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
      await Notifications.dismissNotificationAsync(id).catch(() => undefined);
    }
    return;
  }
  planned.clear();
  const all = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  for (const n of all) {
    if (n.identifier.startsWith(SAFE_RETURN_NOTIFICATION_PREFIX)) await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => undefined);
  }
}

/** Testler: plan belleğini sıfırlar. */
export function __resetSafeReturnNotificationsForTests(): void {
  planned.clear();
}
