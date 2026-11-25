/**
 * "Konum İste": bir arkadaştan anlık konum isteme ve süre seçerek onaylama.
 *
 * Kayıt: `location_requests/{requester}_{target}` (çift başına tek belge; iki taraf okur, yalnızca callable yazar).
 *
 * Durum akışı:
 *
 *   (yok) ──send──▶ pending ──respond(accept, süre)──▶ approved   (hedef → isteyen paylaşımı AYNI transaction'da başlar)
 *                     │      ──respond(reject)────────▶ rejected
 *                     │      ──cancel (isteyen)───────▶ cancelled
 *                     └──── 15 dk yanıt yok ───────────▶ expired   (süre dolumu taraması; istemci de süresi geçmiş
 *                                                                    `pending`i `expired` sayar: `effectiveRequestStatus`)
 *
 * Kurallar:
 *  - Yalnızca kabul edilmiş, engelsiz arkadaşa istek gidebilir. İstemek izin gerektirmez (Faz 8: arkadaşlığın tek
 *    varsayılan hakkı karşı taraftan bir şey istemektir); ama ONAY, hedef → isteyen `location_view` iznini de yazar.
 *    Ters yön (isteyen → hedef) asla yazılmaz.
 *  - Spam: aynı anda çift başına tek bekleyen istek (yeniden basmak aynı isteği döndürür, yeni push yok); aynı çift
 *    için iki istek arasında 10 dk; kullanıcı başına günde 30 istek. Geri çekmek bekleme süresini sıfırlamaz.
 *  - Hedef isteyene zaten paylaşıyorsa yeni istek oluşmaz (`already_sharing`, push yok).
 *  - Hedef görünmezse istek yine ulaşır (görünmezlik sızmaz) ama onay `invisible_mode` ile reddedilir; ret ve geri
 *    çekme her zaman çalışır (onay/KVKK olmadan da).
 *  - Push'lar KOORDİNAT taşımaz. Ret isteyene sade bir metinle bildirilir: "… şu an konumunu paylaşamıyor".
 */
import { z } from 'zod';
import { CALLABLES } from './contracts';
import type { DurationChoice } from './duration';
import type { LocationRequest, LocationRequestStatus, RequestId, SessionId, UserId } from './model';
import type { OutgoingShareView } from './sharing';
import { MINUTE, type EpochMs } from './time';

export const LOCATION_REQUEST_LIMITS = {
  /** Yanıtlanmayan istek bu süre sonunda `expired`. [Varsayım] */
  ttlMs: 15 * MINUTE,
  /** Aynı çift için iki istek arasındaki en kısa süre (ret / geri çekme / süre dolumu sonrası da). [Varsayım] */
  pairCooldownMs: 10 * MINUTE,
  /** Kullanıcı başına günlük istek sınırı. [Varsayım] */
  perDay: 30,
} as const;

/**
 * Bildirim kategorisi (iOS `aps.category`, Android yerel bildirim `categoryIdentifier`) ve eylemleri.
 * İki eylem de uygulamayı öne getirir: "Onayla" süre seçiciyi açar, "Reddet" isteği hemen reddeder.
 */
export const LOCATION_REQUEST_NOTIFICATION = {
  category: 'LOCATION_REQUEST',
  approveAction: 'LOCATION_REQUEST_APPROVE',
  rejectAction: 'LOCATION_REQUEST_REJECT',
  /** Android bildirim kanalı (yüksek önemde). */
  channelId: 'location_requests',
} as const;

// --- callable şemaları ----------------------------------------------------------------------------

const opId = z.uuid();
const requestIdSchema = z.string().min(1).max(300);

export const LocationRequestCancelSchema = z.object({ op_id: opId, request_id: requestIdSchema });
export type LocationRequestCancel = z.input<typeof LocationRequestCancelSchema>;

export interface LocationRequestSendResponse {
  request_id: RequestId;
  /** `already_sharing`: hedef zaten paylaşıyor, istek oluşmadı. */
  status: 'pending' | 'already_sharing';
  /** Bekleyen isteğin bitişi; `already_sharing` için null. */
  expires_at: EpochMs | null;
  server_now: EpochMs;
}

export interface LocationRequestRespondResponse {
  request_id: RequestId;
  status: 'approved' | 'rejected';
  session_id: SessionId | null;
  share: OutgoingShareView | null;
  server_now: EpochMs;
}

export interface LocationRequestCancelResponse {
  request_id: RequestId;
  /** `cancelled`; istek zaten yanıtlanmış / süresi dolmuşsa onun durumu (hata yok, idempotent). */
  status: LocationRequestStatus;
  server_now: EpochMs;
}

// --- saf durum yardımcıları ----------------------------------------------------------------------

/** Süresi geçmiş `pending` → `expired` (tarama gecikse de istemci ve sunucu aynı sonucu görür). */
export function effectiveRequestStatus(req: Pick<LocationRequest, 'status' | 'expires_at'>, now: EpochMs): LocationRequestStatus {
  return req.status === 'pending' && req.expires_at <= now ? 'expired' : req.status;
}

export const isPendingRequest = (req: Pick<LocationRequest, 'status' | 'expires_at'> | null | undefined, now: EpochMs): boolean =>
  !!req && effectiveRequestStatus(req, now) === 'pending';

/** Bu çift için bir sonraki istek ne zaman gönderilebilir (bekleyen istek varken null: zaten bekliyor). */
export function nextRequestAt(req: Pick<LocationRequest, 'status' | 'expires_at' | 'created_at'> | null | undefined, now: EpochMs): EpochMs {
  if (!req) return now;
  return Math.max(now, req.created_at + LOCATION_REQUEST_LIMITS.pairCooldownMs);
}

/** İsteyenin ekranındaki durum (arkadaş satırı / kişi sayfası). */
export type OutgoingRequestState =
  | { kind: 'none' }
  | { kind: 'sharing' }
  | { kind: 'pending'; request_id: RequestId; expires_at: EpochMs }
  | { kind: 'rejected'; request_id: RequestId; retry_at: EpochMs }
  | { kind: 'expired'; request_id: RequestId; retry_at: EpochMs }
  | { kind: 'cancelled'; request_id: RequestId; retry_at: EpochMs };

/** Son yanıtlanmış durum bu kadar süre gösterilir; sonra düğme yeniden "Konum iste" olur (bekleme sürerse süreli). */
export const OUTGOING_RESULT_VISIBLE_MS = 30 * MINUTE;

/**
 * İsteyenin gördüğü durum. `sharingWithMe` = hedef şu an bana aktif paylaşım yapıyor (o zaman düğme gizlenir).
 */
export function outgoingRequestState(
  req: Pick<LocationRequest, 'request_id' | 'status' | 'expires_at' | 'created_at' | 'responded_at'> | null | undefined,
  sharingWithMe: boolean,
  now: EpochMs,
): OutgoingRequestState {
  if (sharingWithMe) return { kind: 'sharing' };
  if (!req) return { kind: 'none' };
  const status = effectiveRequestStatus(req, now);
  if (status === 'pending') return { kind: 'pending', request_id: req.request_id, expires_at: req.expires_at };
  const retry_at = nextRequestAt(req, now);
  const endedAt = req.responded_at ?? (status === 'expired' ? req.expires_at : req.created_at);
  // Eski sonuç: bekleme de bittiyse hiç yokmuş gibi.
  if (now - endedAt > OUTGOING_RESULT_VISIBLE_MS && retry_at <= now) return { kind: 'none' };
  // Onaylandı ama paylaşım artık yok (bitti / durduruldu): yeniden istenebilir (bekleme sunucuda denetlenir).
  if (status === 'approved') return { kind: 'none' };
  return { kind: status, request_id: req.request_id, retry_at };
}

/** Hedefin bekleyen gelen istekleri: en yakın bitecek önde. */
export function incomingPendingRequests<T extends Pick<LocationRequest, 'status' | 'expires_at' | 'target_id'>>(
  docs: readonly T[],
  me: UserId,
  now: EpochMs,
): T[] {
  return docs.filter((d) => d.target_id === me && isPendingRequest(d, now)).sort((a, b) => a.expires_at - b.expires_at);
}

// --- onay sırasında süre seçimi -------------------------------------------------------------------

export interface RequestDurationOption {
  id: 'm15' | 'h1' | 'h8' | 'eod' | 'week' | 'forever' | 'until';
  label: string;
  /** `until` için null: kullanıcı saat seçer (`custom_until`). */
  choice: DurationChoice | null;
}

/** Onay sayfasındaki süre seçenekleri; varsayılan 1 saat. */
export const REQUEST_DURATION_OPTIONS: readonly RequestDurationOption[] = [
  { id: 'm15', label: '15 dk', choice: { kind: 'preset', preset: 'm15' } },
  { id: 'h1', label: '1 saat', choice: { kind: 'preset', preset: 'h1' } },
  { id: 'h8', label: '8 saat', choice: { kind: 'preset', preset: 'h8' } },
  { id: 'eod', label: 'Gün sonuna kadar', choice: { kind: 'end_of_day' } },
  { id: 'week', label: 'Haftalık', choice: { kind: 'weekly' } },
  { id: 'forever', label: 'Süresiz', choice: { kind: 'indefinite' } },
  { id: 'until', label: 'Saat seç', choice: null },
];
export const DEFAULT_REQUEST_DURATION_ID: RequestDurationOption['id'] = 'h1';

// --- metinler -----------------------------------------------------------------------------------

const nameOr = (name: string | null | undefined, fallback: string) => (name && name.trim() ? name.trim() : fallback);

/** Hedefe giden bildirim (ana ekran / bildirim merkezi). */
export function locationRequestPushText(requesterName: string | null | undefined): { title: string; body: string } {
  return { title: 'Konum isteği', body: `${nameOr(requesterName, 'Bir arkadaşın')} konumunu paylaşmanı istiyor` };
}

/** İsteyene giden yanıt bildirimi. Ret sade ve gizliliği koruyan bir ifadedir (neden söylenmez). */
export function locationRequestAnsweredText(
  targetName: string | null | undefined,
  status: 'approved' | 'rejected',
): { title: string; body: string } {
  const n = nameOr(targetName, 'Arkadaşın');
  return status === 'approved'
    ? { title: 'Konum isteğin onaylandı', body: `${n} konumunu seninle paylaşıyor` }
    : { title: 'Konum isteği', body: `${n} şu an konumunu paylaşamıyor` };
}

export const LOCATION_REQUEST_TEXT = {
  action: 'Konum iste',
  sent: 'Konum isteği gönderildi',
  waiting: 'Yanıt bekleniyor',
  cancel: 'Geri çek',
  cancelled: 'İstek geri çekildi',
  rejected: 'Şu an paylaşamıyor',
  expired: 'Yanıt gelmedi',
  approved: 'Onayladı',
  approve: 'Onayla',
  reject: 'Reddet',
  share: 'Paylaşmaya başla',
  sheetQuestion: 'Konumunu ne kadar süre paylaşmak istersin?',
  grantNote: 'Onaylarsan bu kişi seçtiğin süre boyunca konumunu görür. Konum görme iznini Kişi izinleri\'nden geri alabilirsin.',
  invisibleNote: 'Görünmez moddasın. Paylaşmak için önce görünür olman gerekiyor.',
  becomeVisibleAndShare: 'Görünür ol ve paylaş',
  noLongerValid: 'Bu istek artık geçerli değil.',
  inAppCard: 'konumunu paylaşmanı istiyor',
} as const;

/** "14 dk" gibi kalan süre (yukarı yuvarlanır, en az 1 dk). */
export function minutesLeftText(until: EpochMs, now: EpochMs): string {
  // Yarım dakikadan az sapma yukarı taşmasın (sunucu saati farkı): 15 dk kalan "16 dk" görünmez.
  const m = Math.max(1, Math.ceil((until - now - 30_000) / MINUTE));
  return `${m} dk`;
}

/** İsteyenin satırındaki kısa durum metni. */
export function outgoingStateText(s: OutgoingRequestState, now: EpochMs): string | null {
  switch (s.kind) {
    case 'pending':
      return `${LOCATION_REQUEST_TEXT.sent} · ${LOCATION_REQUEST_TEXT.waiting} (${minutesLeftText(s.expires_at, now)})`;
    case 'rejected':
      return LOCATION_REQUEST_TEXT.rejected;
    case 'expired':
      return LOCATION_REQUEST_TEXT.expired;
    case 'cancelled':
      return LOCATION_REQUEST_TEXT.cancelled;
    default:
      return null;
  }
}

/** Tekrar istemek için kalan bekleme ("8 dk sonra tekrar isteyebilirsin"); bekleme yoksa null. */
export function retryText(retryAt: EpochMs, now: EpochMs): string | null {
  return retryAt > now ? `${minutesLeftText(retryAt, now)} sonra tekrar isteyebilirsin` : null;
}

/** Sözleşme testi için: bu dosyanın callable adları. */
export const LOCATION_REQUEST_CALLABLES = [CALLABLES.locationRequestSend, CALLABLES.locationRequestRespond, CALLABLES.locationRequestCancel] as const;
