/**
 * "Süre dolmak üzere" yerel bildirimi: oturumun `prompt_at` anında (core `extendPromptAt`)
 * SHARE_EXPIRING kategorisiyle, "+30 dk" ve "+1 saat" eylemleriyle planlanır.
 * Uzatma, durdurma ve bitişte iptal edilip yeniden planlanır (`syncExpiryNotifications`).
 *
 * Uzlaştırma kuralı: "uyarı anı geçti" ile "artık ilgisiz" ayrı şeylerdir. Oturum aynı `prompt_at` ile
 * hâlâ sürüyorsa planlı ya da TESLİM EDİLMİŞ bildirime dokunulmaz (uyarı anında evre active →
 * expiring_soon döner; bu yüzden silinseydi "+30 dk / +1 saat" kullanıcıya hiç ulaşmazdı).
 * Yalnızca oturum bitince/durdurulunca ya da `prompt_at` değişince (uzatma) iptal + kaldırma yapılır;
 * geçmişe düşecek YENİ bildirim planlanmaz.
 *
 * Eylemlerin `op_id`'leri bildirim planlanırken üretilip veriye gömülür: aynı dokunuş hem ön plan
 * dinleyicisine hem arka plan görevine ulaşırsa sunucu tek bir uzatma uygular.
 *
 * Süresiz paylaşımlarda bitiş yoktur; bunun yerine başlangıçtan itibaren her hafta
 * (core `DURATION_LIMITS.indefiniteReminderMs`) "Konumun hâlâ paylaşılıyor" hatırlatması planlanır.
 * Uygulama haftalarca açılmasa da hatırlatma sürsün diye önden birkaç hafta planlanır.
 *
 * Faz 2: bağlantı (QR) paylaşımları AYNI yoldan geçer: aynı kategori ve eylemler (+30 dk / +1 saat),
 * kimlik `share-expiring-link:<link_id>`, veri `kind: 'link_expiring'` + `link_id` (eylem `link_share_extend`
 * çağırır). Süresiz bağlantı için de haftalık "Konum bağlantın hâlâ açık" hatırlatması planlanır.
 */
import { DURATION_LIMITS, formatClock, NOTIFICATION_CHANNELS_F4, uuidV4, type EpochMs, type LinkId, type ShareSession } from '@konum/core';
import * as Notifications from './expoNotifications';
import { Platform } from 'react-native';
import { lightColors } from '../../ui/tokens';
import { isF4PushType } from './f4Push';
import {
  ACTION_EXTEND,
  CHANNELS,
  EXPIRY_ID_PREFIX,
  expiryNotificationId,
  REMINDER_ID_PREFIX,
  reminderNotificationId,
  SHARE_EXPIRING_CATEGORY,
} from './constants';

export interface ExpiryNotificationData {
  kind: 'share_expiring';
  session_id: string;
  expires_at: number;
  /** Sunucu saatiyle uyarı anı; yeniden açılışta planlı bildirimi tanımak için. */
  prompt_at: number;
  op_ids: { '30': string; '60': string };
  [key: string]: unknown;
}

/** Faz 2: bağlantı paylaşımının "bitmek üzere" bildirimi verisi. */
export interface LinkExpiryNotificationData {
  kind: 'link_expiring';
  link_id: LinkId;
  expires_at: number;
  prompt_at: number;
  op_ids: { '30': string; '60': string };
  [key: string]: unknown;
}

/** Bildirim planlamasının bağlantıdan ihtiyaç duyduğu alanlar (linkStore `LinkSession` uyar). */
export interface LinkExpirySubject {
  link_id: LinkId;
  phase: 'active' | 'expiring_soon' | 'extending' | 'stopping' | 'ended';
  started_at: EpochMs;
  expires_at: EpochMs | null;
  prompt_at: EpochMs | null;
}

/** Bildirim kimliği soneki ve planlama anahtarı: arkadaş oturumu → session_id, bağlantı → `link:<id>`. */
export const linkNotificationKey = (linkId: LinkId) => `link:${linkId}`;

/** Planlama için ortak biçim (arkadaş oturumu ya da bağlantı). */
interface Subject {
  key: string;
  prompt_at: EpochMs;
  expires_at: EpochMs;
  content: () => { title: string; body: string; categoryIdentifier: string; data: Record<string, unknown>; sound: boolean };
}

let configured: Promise<void> | null = null;

/**
 * Faz 4 Android kanalları (kanal ayarları ilk oluşturmadan sonra yalnızca kullanıcı tarafından değiştirilebilir):
 *  - `sos`: IMPORTANCE_MAX, rahatsız etme modunu aşar (`bypassDnd`; kullanıcı "Rahatsız Etme erişimi" verdiyse,
 *    ACCESS_NOTIFICATION_POLICY), kilit ekranında tam içerik, alarm sesi + uzun titreşim.
 *  - `ping`: IMPORTANCE_HIGH (afiş + ses).
 */
export async function configureF4Channels(): Promise<void> {
  await Notifications.setNotificationChannelAsync(CHANNELS.sos, {
    name: 'Acil durum (SOS)',
    description: 'Acil durum kişin olduğun biri tehlikede olduğunu bildirdiğinde',
    importance: Notifications.AndroidImportance.MAX,
    bypassDnd: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    sound: 'default',
    enableVibrate: true,
    vibrationPattern: [0, 800, 300, 800, 300, 1200],
    enableLights: true,
    lightColor: '#DC2626',
    // [Varsayım] Alarm akışı: medya sesi kısıkken de duyulur (kullanıcı kanal ayarından değiştirebilir).
    audioAttributes: { usage: Notifications.AndroidAudioUsage.ALARM },
  });
  await Notifications.setNotificationChannelAsync(CHANNELS.ping, {
    name: 'Buradayım / Yoldayım',
    description: 'Arkadaşın tek dokunuşla durumunu gönderdiğinde',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
  });
}

/** Kanallar, kategori ve ön plan sunum kuralı. İzin İSTEMEZ (izin PermissionFlow'da). */
export function configureNotifications(): Promise<void> {
  if (!configured) configured = doConfigure();
  return configured;
}

async function doConfigure(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      // Uygulama açıkken haritadaki ExpiryBanner zaten görünür: aynı uyarıyı afiş olarak tekrar gösterme.
      const isExpiry = n.request.content.categoryIdentifier === SHARE_EXPIRING_CATEGORY;
      // Faz 4: SOS (ve güvende / gördü) ön planda da afiş + ses (iOS); sessiz modda bile kritik bilgi görünür.
      const type = (n.request.content.data as { type?: unknown } | null | undefined)?.type;
      if (isF4PushType(type)) {
        const isSos = type === 'sos';
        return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: isSos || type === 'sos_resolved', shouldSetBadge: false, ...(isSos ? { priority: Notifications.AndroidNotificationPriority.MAX } : {}) };
      }
      return { shouldShowBanner: !isExpiry, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
    },
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNELS.shareExpiring, {
      name: 'Paylaşım süresi',
      description: 'Konum paylaşımın bitmek üzereyken hatırlatır',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: lightColors.primary,
    });
    await Notifications.setNotificationChannelAsync(CHANNELS.locationRequests, {
      name: 'Konum istekleri',
      description: 'Arkadaşların konumunu istediğinde',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    await Notifications.setNotificationChannelAsync(CHANNELS.shareStatus, {
      name: 'Paylaşım durumu',
      description: 'Arkadaşının pili azaldığında ya da kendi paylaşımın duraksadığında',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    await configureF4Channels();
  }

  /**
   * iOS: eylem uygulamayı öne getirir; böylece callable ekran açıkken güvenle tamamlanır.
   * Arka planda (opensAppToForeground:false) yanıtın JS'e ulaşıp ağ çağrısının bitmesi garanti değil,
   * özellikle uygulama kapatılmışsa. [Varsayım: doğrulanmalı]
   * Android: uygulamayı açmadan arka plan görevi (registerTaskAsync) çalışır.
   */
  const foreground = Platform.OS === 'ios';
  await Notifications.setNotificationCategoryAsync(SHARE_EXPIRING_CATEGORY, [
    { identifier: ACTION_EXTEND[30], buttonTitle: '+30 dk', options: { opensAppToForeground: foreground } },
    { identifier: ACTION_EXTEND[60], buttonTitle: '+1 saat', options: { opensAppToForeground: foreground } },
  ]);

  /**
   * Faz 4 iOS kategorileri (backend APNs `aps.category` = core `NOTIFICATION_CHANNELS_F4`). Eylem yok: dokunma
   * uygulamayı açar ve tam ekran kartı gösterir. Kullanıcı "Önizlemeleri göster: Asla / Kilit açıkken" seçmiş olsa
   * da SOS başlığı ("ACİL: Ad tehlikede") kilit ekranında görünür (`showTitle`). [Varsayım: cihazda doğrulanmalı]
   */
  await Notifications.setNotificationCategoryAsync(NOTIFICATION_CHANNELS_F4.sos, [], {
    showTitle: true,
    previewPlaceholder: 'Acil durum uyarısı — görmek için aç',
  }).catch(() => undefined);
  await Notifications.setNotificationCategoryAsync(NOTIFICATION_CHANNELS_F4.ping, [], { showTitle: true }).catch(() => undefined);
}

/** Planlanan (ya da teslim edilmiş) bildirimlerin `prompt_at` değerleri; -1 = önceki çalıştırmadan, anı bilinmiyor. */
const scheduled = new Map<string, EpochMs>();
let reconciled = false;

const SCHEDULABLE = new Set<ShareSession['phase']>(['active', 'expiring_soon', 'extending']);
const LINK_SCHEDULABLE = new Set<LinkExpirySubject['phase']>(['active', 'expiring_soon', 'extending']);
/** [Varsayım] Bundan yakın bir uyarıyı planlamayız; uygulama içindeki banner yeterli. */
const MIN_LEAD_MS = 5_000;

/**
 * Oturum listesine göre bildirimleri uzlaştırır. `now` sunucu saati; bildirim tetikleyicisi cihaz
 * saatiyle çalıştığı için `offsetMs` (sunucu - cihaz) düşülür.
 */
export async function syncExpiryNotifications(
  sessions: readonly ShareSession[],
  now: EpochMs,
  offsetMs: number,
  links: readonly LinkExpirySubject[] = [],
): Promise<void> {
  await configureNotifications();
  if (!reconciled) {
    reconciled = true;
    // Önceki çalıştırmadan kalanları öğren (uygulama yeniden başlatıldıysa).
    const existing = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
    for (const n of existing) {
      if (n.identifier.startsWith(EXPIRY_ID_PREFIX)) {
        const at = (n.content.data as { prompt_at?: unknown } | undefined)?.prompt_at;
        scheduled.set(n.identifier.slice(EXPIRY_ID_PREFIX.length), typeof at === 'number' ? at : -1);
      } else if (n.identifier.startsWith(REMINDER_ID_PREFIX)) reminders.set(n.identifier, -1);
    }
  }

  // Hâlâ ilgili oturumlar ve bağlantılar: süren (durdurulmamış, bitmemiş), bitişi olan.
  const relevant = new Map<string, Subject>();
  for (const s of sessions) {
    if (!SCHEDULABLE.has(s.phase) || s.prompt_at === null || s.expires_at === null) continue;
    relevant.set(s.session_id, { key: s.session_id, prompt_at: s.prompt_at, expires_at: s.expires_at, content: () => expiryNotificationContent(s) });
  }
  for (const l of links) {
    if (!LINK_SCHEDULABLE.has(l.phase) || l.prompt_at === null || l.expires_at === null) continue;
    const key = linkNotificationKey(l.link_id);
    relevant.set(key, { key, prompt_at: l.prompt_at, expires_at: l.expires_at, content: () => linkExpiryNotificationContent(l) });
  }

  for (const [sid, at] of [...scheduled]) {
    const s = relevant.get(sid);
    if (!s) await cancelExpiryNotification(sid); // bitti / durduruldu / artık yok
    else if (at !== -1 && at !== s.prompt_at) await cancelExpiryNotification(sid); // uzatıldı: eski uyarı geçersiz
  }
  for (const [sid, s] of relevant) {
    const at = scheduled.get(sid);
    if (at === s.prompt_at) continue; // planlı ya da teslim edildi: dokunma
    if (s.prompt_at - now < MIN_LEAD_MS) {
      // Geçmişe düşecek yeni bildirim planlanmaz; önceki çalıştırmadan kalan (-1) kayıt varsa olduğu gibi kalır.
      continue;
    }
    await scheduleOne(s, offsetMs);
  }

  await syncIndefiniteReminders(sessions, links, now, offsetMs);
}

// --- süresiz paylaşım: haftalık hatırlatma ------------------------------------------------------

/** Planlanmış hatırlatma kimlikleri → tetiklenme anı (sunucu saati; -1 = önceki çalıştırmadan). */
const reminders = new Map<string, EpochMs>();
/** [Varsayım] Önden planlanan hafta sayısı (iOS'ta uygulama başına 64 bekleyen bildirim sınırı var). */
const REMINDER_WEEKS_AHEAD = 4;

/** `started_at`'ten sonraki, `now`'dan ileri ilk `count` hatırlatma anı ve hafta numarası. Saf. */
export function nextIndefiniteReminders(startedAt: EpochMs, now: EpochMs, count: number): { week: number; at: EpochMs }[] {
  const step = DURATION_LIMITS.indefiniteReminderMs;
  const first = Math.max(1, Math.floor((now - startedAt) / step) + 1);
  return Array.from({ length: count }, (_, i) => ({ week: first + i, at: startedAt + (first + i) * step }));
}

async function syncIndefiniteReminders(
  sessions: readonly ShareSession[],
  links: readonly LinkExpirySubject[],
  now: EpochMs,
  offsetMs: number,
): Promise<void> {
  const wanted = new Map<string, { title: string; body: (week: number) => string; data: Record<string, unknown>; at: EpochMs; week: number }>();
  for (const s of sessions) {
    if (s.expires_at !== null || !SCHEDULABLE.has(s.phase) || !s.confirmed) continue;
    const receivers = s.active_receiver_ids.length;
    for (const r of nextIndefiniteReminders(s.started_at, now, REMINDER_WEEKS_AHEAD)) {
      if (r.at - now < MIN_LEAD_MS) continue;
      wanted.set(reminderNotificationId(s.session_id, r.week), {
        title: 'Konumun hâlâ paylaşılıyor',
        body: (week) => `Süresiz paylaşımın ${week} haftadır ${receivers} kişiyle sürüyor. Durdurmak için uygulamayı aç.`,
        data: { kind: 'share_reminder', session_id: s.session_id },
        ...r,
      });
    }
  }
  for (const l of links) {
    if (l.expires_at !== null || !LINK_SCHEDULABLE.has(l.phase)) continue;
    for (const r of nextIndefiniteReminders(l.started_at, now, REMINDER_WEEKS_AHEAD)) {
      if (r.at - now < MIN_LEAD_MS) continue;
      wanted.set(reminderNotificationId(linkNotificationKey(l.link_id), r.week), {
        title: 'Konum bağlantın hâlâ açık',
        body: (week) => `Süresiz konum bağlantın ${week} haftadır açık; bağlantıya sahip herkes konumunu görebilir. Durdurmak için uygulamayı aç.`,
        data: { kind: 'link_reminder', link_id: l.link_id },
        ...r,
      });
    }
  }
  for (const [id] of reminders) {
    if (wanted.has(id)) continue;
    reminders.delete(id);
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  }
  for (const [id, r] of wanted) {
    if (reminders.get(id) === r.at) continue;
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: {
        title: r.title,
        body: r.body(r.week),
        data: r.data,
        sound: false,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at - offsetMs, channelId: CHANNELS.shareExpiring },
    });
    reminders.set(id, r.at);
  }
}

/** "Süre dolmak üzere" bildiriminin içeriği (başlık, metin, kategori, eylem op_id'leri). Bitişi olan oturum ister. */
export function expiryNotificationContent(s: ShareSession) {
  const expiresAt = s.expires_at as number;
  const data: ExpiryNotificationData = {
    kind: 'share_expiring',
    session_id: s.session_id,
    expires_at: expiresAt,
    prompt_at: s.prompt_at as number,
    op_ids: { '30': uuidV4(), '60': uuidV4() },
  };
  return {
    title: 'Konum paylaşımın bitmek üzere',
    body: `Bitiş: ${formatClock(expiresAt)}. Uzatmak ister misin?`,
    categoryIdentifier: SHARE_EXPIRING_CATEGORY,
    data,
    sound: false,
  };
}

/** Bağlantının "bitmek üzere" bildirimi: aynı kategori ve eylemler, `link_share_extend` için veri. */
export function linkExpiryNotificationContent(l: LinkExpirySubject) {
  const expiresAt = l.expires_at as number;
  const data: LinkExpiryNotificationData = {
    kind: 'link_expiring',
    link_id: l.link_id,
    expires_at: expiresAt,
    prompt_at: l.prompt_at as number,
    op_ids: { '30': uuidV4(), '60': uuidV4() },
  };
  return {
    title: 'Konum bağlantın bitmek üzere',
    body: `QR ile paylaşım bitişi: ${formatClock(expiresAt)}. Uzatmak ister misin?`,
    categoryIdentifier: SHARE_EXPIRING_CATEGORY,
    data,
    sound: false,
  };
}

async function scheduleOne(s: Subject, offsetMs: number): Promise<void> {
  const id = expiryNotificationId(s.key);
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: s.content(),
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      // Sunucu saati → cihaz saati.
      date: s.prompt_at - offsetMs,
      channelId: CHANNELS.shareExpiring,
    },
  });
  scheduled.set(s.key, s.prompt_at);
}

export async function cancelExpiryNotification(sessionId: string): Promise<void> {
  const id = expiryNotificationId(sessionId);
  scheduled.delete(sessionId);
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  await Notifications.dismissNotificationAsync(id).catch(() => undefined);
}

/** Çıkışta tüm paylaşım uyarılarını ve haftalık hatırlatmaları sil. */
export async function cancelAllExpiryNotifications(): Promise<void> {
  const all = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  for (const n of all) {
    if (n.identifier.startsWith(EXPIRY_ID_PREFIX) || n.identifier.startsWith(REMINDER_ID_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => undefined);
    }
  }
  scheduled.clear();
  reminders.clear();
}
