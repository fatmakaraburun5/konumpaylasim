/**
 * FCM bildirimleri. Bildirim KOORDİNAT, telefon numarası ya da başka alıcı bilgisi TAŞIMAZ;
 * `data` alanı core `PushData` biçimindedir.
 *
 * Token sahipliği: istemci token'ı `devices/{uid}/tokens/{token}` altına yazar. Aynı cihazda A çıkış yapıp B
 * girerse aynı token iki uid altında kalabilir; A'nın bildirimleri (isteyen adları) B'nin kullandığı cihaza
 * gitmesin diye gönderimden önce token'ın SON sahibi bulunur: `collectionGroup('tokens').where('token', '==', t)`,
 * sunucu `updateTime`'ı en yeni olan belge kazanır. Eski sahibin kopyası silinir. Kullanıcı başına en yeni 10
 * token kullanılır, fazlası silinir [Varsayım]; gönderim 500'lük parçalar hâlinde yapılır.
 * İstemci de çıkışta kendi token belgesini silmelidir (mobil ekip).
 */
import {
  NOTIFICATION_CHANNELS_F4,
  PING_LIMITS,
  type PingKind,
  type PushData,
  SOS_LIMITS,
  type SosAlert,
  type UserId,
  lowBatteryPushText,
  pingPushText,
  sosAckPushText,
  sosPushText,
  sosResolvedPushText,
  turkishGenitive,
} from '@konum/core';
import type { DocumentReference, Timestamp } from 'firebase-admin/firestore';
import type { MulticastMessage } from 'firebase-admin/messaging';
import * as logger from 'firebase-functions/logger';
import { db, messaging } from './admin';
import { IS_EMULATOR, LIMITS, SOS_CRITICAL_ALERTS } from './config';
import { refs } from './docs';
import { chunk } from './util';

/**
 * `data` = core `PushData` (Faz 3: `battery_low` alıcıya görünür; `resume_tracking` gönderenin kendi cihazına yalnızca
 * veri; `tracking_stalled` gönderene görünür). Değerler FCM gereği string.
 */
export type PushMessage = Omit<MulticastMessage, 'tokens'> & { data: PushData };

/**
 * [Varsayım] Kilit ekranında adı gizleme tercihi Faz 1'de yok; ad bildirim metninde görünür.
 * Tercih eklendiğinde `requesterName` yerine genel metin kullanılır.
 */
export function buildLocationRequestPush(requesterName: string, requestId: string): PushMessage {
  return {
    notification: { title: 'Konum isteği', body: `${requesterName || 'Bir arkadaşın'} konumunu paylaşmanı istiyor` },
    data: { type: 'location_request', request_id: requestId },
    android: { priority: 'high', notification: { channelId: 'location_requests' } },
    apns: { payload: { aps: { category: 'LOCATION_REQUEST' } } },
  };
}

export function buildFriendRequestPush(requesterName: string, friendshipId: string): PushMessage {
  return {
    notification: { title: 'Arkadaşlık isteği', body: `${requesterName || 'Biri'} seni arkadaş olarak eklemek istiyor` },
    data: { type: 'friend_request', friendship_id: friendshipId },
    android: { notification: { channelId: 'friend_requests' } },
    apns: { payload: { aps: { category: 'FRIEND_REQUEST' } } },
  };
}

const STALE_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

interface TokenRef {
  ref: DocumentReference;
  token: string;
  updated: number;
}

const ms = (t: Timestamp | undefined): number => (t ? t.toMillis() : 0);

/**
 * Kullanıcıya gönderilebilecek token'lar: son sahibi bu kullanıcı olanlar, en yeni N tanesi.
 * Başka uid'e geçmiş ya da sınırı aşan eski token belgeleri silinir (yan etki).
 */
export async function resolvePushTokens(uid: UserId): Promise<TokenRef[]> {
  const snap = await refs.deviceTokens(uid).get();
  const mine: TokenRef[] = snap.docs
    .map((d) => ({ ref: d.ref, token: d.get('token') as unknown, updated: ms(d.updateTime) }))
    .filter((t): t is TokenRef => typeof t.token === 'string' && t.token.length > 0);
  if (mine.length === 0) return [];

  const owned: TokenRef[] = [];
  const stale: DocumentReference[] = [];
  for (const part of chunk(mine, 10)) {
    const res = await Promise.all(part.map((t) => db().collectionGroup('tokens').where('token', '==', t.token).get()));
    part.forEach((t, i) => {
      // Aynı token daha yeni bir kayıtla başka uid'e geçtiyse bu kullanıcıya ait değil.
      const takenOver = (res[i]?.docs ?? []).some((d) => d.ref.path !== t.ref.path && ms(d.updateTime) > t.updated);
      if (takenOver) stale.push(t.ref);
      else owned.push(t);
    });
  }
  owned.sort((a, b) => b.updated - a.updated);
  const keep = owned.slice(0, LIMITS.maxDeviceTokensPerUser);
  stale.push(...owned.slice(LIMITS.maxDeviceTokensPerUser).map((t) => t.ref));
  await Promise.all(stale.map((r) => r.delete().catch(() => undefined)));
  return keep;
}

/** Kullanıcının token'larına gönderir; geçersiz token'ları siler. */
export async function sendPushToUser(uid: UserId, message: PushMessage): Promise<{ sent: number; removed: number }> {
  const tokens = await resolvePushTokens(uid);
  if (tokens.length === 0) return { sent: 0, removed: 0 };
  if (IS_EMULATOR) {
    // FCM emülatörü yok: gerçek gönderim yerine yalnızca kayıt.
    logger.info('[emülatör] push gönderilmedi', { uid, tokens: tokens.length, data: message.data });
    return { sent: 0, removed: 0 };
  }
  let sent = 0;
  let removed = 0;
  for (const part of chunk(tokens, LIMITS.fcmMulticastMax)) {
    const res = await messaging().sendEachForMulticast({ ...message, tokens: part.map((t) => t.token) });
    const stale = res.responses
      .map((r, i) => (!r.success && r.error && STALE_TOKEN_ERRORS.has(r.error.code) ? part[i] : null))
      .filter((t): t is TokenRef => t !== null && t !== undefined);
    await Promise.all(stale.map((t) => t.ref.delete()));
    sent += res.successCount;
    removed += stale.length;
  }
  return { sent, removed };
}

// ---------------------------------------------------------------------------
// Faz 3: düşük pil ve duraksama bildirimleri (koordinat YOK)
// ---------------------------------------------------------------------------

/** Türkçe tamlayan eki core'da (`turkishGenitive`); geriye dönük dışa aktarım. */
export { turkishGenitive };

/**
 * Alıcıya düşük pil bildirimi: metin core `lowBatteryPushText` ("Ayşe'nin pili azaldı" / "Pil %14. Konum daha seyrek
 * güncellenecek."; mobil ön plan bildirimi ve web görüntüleyici aynı metni kullanır). Koordinat taşımaz.
 */
export function buildBatteryLowPush(senderName: string, pct: number, shareId: string): PushMessage {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return {
    notification: lowBatteryPushText(senderName, p),
    data: { type: 'battery_low', share_id: shareId, battery_pct: String(p) },
    android: { priority: 'high', collapseKey: `battery_low_${shareId}`, notification: { channelId: 'share_status', tag: `battery_low_${shareId}` } },
    apns: { headers: { 'apns-collapse-id': `battery_low_${shareId}`.slice(0, 64) }, payload: { aps: { category: 'BATTERY_LOW' } } },
  };
}

/**
 * Gönderenin cihazına YALNIZCA veri içeren yüksek öncelikli uyandırma (`resume_tracking`).
 *
 * [Varsayım: cihazda doğrulanmadı] Platform sınırları:
 *  - Android: `priority: high` veri mesajı Doze'da bile iletilir ve uygulamaya ~10 sn işlem süresi verir; FCM yüksek
 *    öncelikli mesajdan sonra arka plandan konum ön plan hizmeti (FGS) başlatmaya izin verir (Android 12+ istisnası),
 *    ama konuma erişim için `ACCESS_BACKGROUND_LOCATION` gerekir. Görünür bildirime dönüşmeyen yüksek öncelikli
 *    mesajlar zamanla normal önceliğe düşürülebilir (bu yüzden ikinci kaçırmada görünür bildirim). Kullanıcı
 *    uygulamayı "Zorla durdur" ile kapattıysa ya da üretici pil yöneticisi (Xiaomi/Huawei/Samsung "uyuyan
 *    uygulamalar") uygulamayı kısıtladıysa mesaj HİÇ iletilmez.
 *  - iOS: `content-available: 1` + `apns-push-type: background` + öncelik 5. Sistem saatte birkaç taneyle sınırlar,
 *    Düşük Güç Modu'nda geciktirir; kullanıcı uygulamayı uygulama değiştiriciden kaydırıp kapattıysa İLETMEZ.
 *    Uyanınca ~30 sn vardır: konum oturumu/önemli konum değişikliği izlemesi yeniden kurulur (Always izni gerekir).
 *  - TTL 15 dk: geç gelen uyandırmanın anlamı yok (bir sonraki bekçi turu yenisini gönderir).
 */
export const RESUME_PUSH_TTL_MS = 15 * 60 * 1000;

export function buildResumeTrackingPush(sessionIds: readonly string[], level: number, now: number = Date.now()): PushMessage {
  return {
    data: { type: 'resume_tracking', session_ids: sessionIds.join(','), level: String(level) },
    android: { priority: 'high', ttl: RESUME_PUSH_TTL_MS, collapseKey: 'resume_tracking' },
    apns: {
      headers: {
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-expiration': String(Math.floor((now + RESUME_PUSH_TTL_MS) / 1000)),
      },
      payload: { aps: { contentAvailable: true } },
    },
  };
}

/** İkinci kaçırma: gönderene görünür bildirim (dokununca uygulama ön plana gelir ve takibi yeniden başlatır). */
export function buildTrackingStalledPush(sessionIds: readonly string[]): PushMessage {
  return {
    notification: { title: 'Konum paylaşımı', body: 'Konum paylaşımın duraksadı. Devam etmek için dokun.' },
    data: { type: 'tracking_stalled', session_ids: sessionIds.join(',') },
    android: {
      priority: 'high',
      collapseKey: 'tracking_stalled',
      notification: { channelId: 'share_status', tag: 'tracking_stalled' },
    },
    apns: {
      headers: { 'apns-collapse-id': 'tracking_stalled' },
      payload: { aps: { contentAvailable: true, category: 'TRACKING_STALLED' } },
    },
  };
}

// ---------------------------------------------------------------------------
// Faz 4: ping ve acil durum (SOS) bildirimleri
// ---------------------------------------------------------------------------

/** APNs başlıkları string ister; `apns-collapse-id` en çok 64 bayt. */
const collapseId = (s: string): string => s.slice(0, 64);

/**
 * "Buradayım / Yoldayım": alıcıya görünür, yüksek öncelikli. Koordinat YOK (konum `ping_inbox`'tan okunur).
 * Aynı göndericiden gelen yeni ping eskisinin yerine geçer (Android `tag`, iOS `apns-collapse-id`). Ping süresi
 * dolunca iletmenin anlamı yok: TTL = kalan süre.
 */
export function buildPingPush(
  senderName: string,
  p: { ping_id: string; from: UserId; kind: PingKind; eta_s: number | null; expires_at: number },
  now: number = Date.now(),
): PushMessage {
  const ttl = Math.max(0, Math.min(PING_LIMITS.ttlMs, p.expires_at - now));
  return {
    notification: pingPushText(senderName || 'Bir arkadaşın', p.kind, p.eta_s),
    data: { type: 'ping', ping_id: p.ping_id, from: p.from, kind: p.kind },
    android: {
      priority: 'high',
      ttl,
      collapseKey: `ping_${p.from}`,
      notification: { channelId: NOTIFICATION_CHANNELS_F4.ping, tag: `ping_${p.from}`, sound: 'default' },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-collapse-id': collapseId(`ping_${p.from}`),
        'apns-expiration': String(Math.floor(p.expires_at / 1000)),
      },
      payload: { aps: { category: NOTIFICATION_CHANNELS_F4.ping, sound: 'default', 'interruption-level': 'active' } },
    },
  };
}

/**
 * Acil durum: her alıcıya en yüksek öncelik. Metin core `sosPushText` (adres + doğruluk + pil; HAM KOORDİNAT YOK).
 *  - Android: `priority: high` (Doze'da da iletilir), kanal `sos` (istemci IMPORTANCE_MAX + bypassDnd ile kurar),
 *    kilit ekranında herkese açık (`visibility: public`), ses + titreşim.
 *  - iOS: `apns-priority: 10`; `SOS_CRITICAL_ALERTS` açıksa `interruption-level: critical` + kritik ses (sessiz modu ve
 *    Odak'ı aşar; Apple yetkisi gerekir), kapalıysa `time-sensitive` (Odak'ı aşar, sessiz modu aşmaz).
 *  - Aynı SOS'un tekrar gönderimi (yeni konum) öncekinin yerine geçer (`tag` / `apns-collapse-id` = sos_id).
 */
export function buildSosPush(a: Pick<SosAlert, 'sos_id' | 'sender_id' | 'sender_name' | 'address' | 'location' | 'battery_pct'>, critical: boolean = SOS_CRITICAL_ALERTS): PushMessage {
  const tag = `sos_${a.sos_id}`;
  return {
    notification: sosPushText({ ...a, sender_name: a.sender_name || 'Bir arkadaşın' }),
    data: { type: 'sos', sos_id: a.sos_id, sender_id: a.sender_id },
    android: {
      priority: 'high',
      ttl: SOS_LIMITS.activeMaxMs,
      notification: {
        channelId: NOTIFICATION_CHANNELS_F4.sos,
        tag,
        priority: 'max',
        visibility: 'public',
        sound: 'default',
        defaultVibrateTimings: true,
        sticky: true,
      },
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert', 'apns-collapse-id': collapseId(tag) },
      payload: {
        aps: critical
          ? { category: NOTIFICATION_CHANNELS_F4.sos, 'interruption-level': 'critical', sound: { critical: true, name: 'default', volume: 1 } }
          : { category: NOTIFICATION_CHANNELS_F4.sos, 'interruption-level': 'time-sensitive', sound: 'default' },
      },
    },
  };
}

/**
 * "Güvendeyim": alıcılara görünür; aynı `tag` / `apns-collapse-id` ile acil durum bildiriminin YERİNE geçer.
 * [Varsayım] İyi haber alarm sesiyle çalmasın diye `sos` değil `ping` (HIGH) kanalı; iOS `time-sensitive`.
 */
export function buildSosResolvedPush(senderName: string, sosId: string, senderId: UserId): PushMessage {
  const tag = `sos_${sosId}`;
  return {
    notification: sosResolvedPushText(senderName || 'Arkadaşın'),
    data: { type: 'sos_resolved', sos_id: sosId, sender_id: senderId },
    android: { priority: 'high', notification: { channelId: NOTIFICATION_CHANNELS_F4.ping, tag, sound: 'default' } },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert', 'apns-collapse-id': collapseId(tag) },
      payload: { aps: { category: NOTIFICATION_CHANNELS_F4.sos, sound: 'default', 'interruption-level': 'time-sensitive' } },
    },
  };
}

/**
 * Gönderene: alıcı uyarıyı gördü. [Varsayım] Tehlikedeki kişinin telefonu yüksek sesle çalmasın: `ping` kanalı,
 * iOS `active` (kritik / zaman duyarlı değil).
 */
export function buildSosAckPush(ackerName: string, sosId: string, by: UserId): PushMessage {
  return {
    notification: sosAckPushText(ackerName || 'Bir arkadaşın'),
    data: { type: 'sos_ack', sos_id: sosId, by },
    android: { priority: 'high', notification: { channelId: NOTIFICATION_CHANNELS_F4.ping, tag: `sos_ack_${sosId}_${by}` } },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      payload: { aps: { category: NOTIFICATION_CHANNELS_F4.sos, 'interruption-level': 'active' } },
    },
  };
}

/** Bildirim gönderici (testler sahte gönderici enjekte eder). */
export type PushSender = (uid: UserId, message: PushMessage) => Promise<{ sent: number; removed: number }>;
