/**
 * Faz 4: tam konumlu acil durum (SOS).
 *
 * Tetikleme (yanlış basmayı azaltan ama hız kaybettirmeyen akış, bkz. `SOS_FLOW`):
 *   SOS düğmesine BASILI TUT (`holdMs`, halka dolar; erken bırakma iptal) → `countdownS` saniyelik geri sayım ekranı
 *   (büyük "İptal" + "Hemen gönder") → gönderim. Ekran okuyucu kullanıcıları için erişilebilirlik eylemi doğrudan geri
 *   sayımı açar (güvenlik geri sayımdadır). Gönderildikten sonra "Güvendeyim" ile kapatılır (onaylı).
 *
 * Veri: Firestore `sos_alerts/{sos_id}` (yalnızca sunucu yazar; gönderen ve `recipient_ids` okur). Paket TAM
 * koordinat, doğruluk yarıçapı, okunabilir adres, harita bağlantısı, anlık pil ve varsa rota/ETA taşır. Aktifken
 * istemci `sos_update` ile en sık `updateMinIntervalMs`'de bir konumu tazeler.
 *
 * Push: alıcılara yüksek öncelikli (Android `sos` kanalı, iOS `critical` ya da `time-sensitive`) bildirim. Kilit
 * ekranında okunabilsin diye gövde adres + doğruluk + pil içerir; HAM KOORDİNAT push yükünde YOK (uygulama açılınca
 * Firestore'dan okunur). [Varsayım] Bu, "push koordinat taşımaz" kuralının SOS için bilinçli tek istisnasıdır:
 * adres metni gönderilir, koordinat gönderilmez.
 */
import { z } from 'zod';
import type { UserId } from './model';
import { formatDistanceTr, formatEtaDuration } from './mapsPolicy';
import { HOUR, MINUTE, SECOND, type EpochMs } from './time';

export const SOS_LIMITS = {
  /** Seçilebilecek en fazla acil durum kişisi. */
  maxContacts: 5,
  /** Düğmeyi basılı tutma süresi. [Varsayım] */
  holdMs: 1_500,
  /** Gönderim öncesi iptal penceresi (saniye). [Varsayım] */
  countdownS: 5,
  /** Aktif SOS konum tazeleme aralığı (istemci ve sunucu kısıtı). */
  updateMinIntervalMs: 15 * SECOND,
  /** Aktif SOS en uzun süre; sonra süpürücü `resolved` (timeout) yapar. */
  activeMaxMs: 24 * HOUR,
  /** Kullanıcı başına saatlik en fazla SOS (kötüye kullanım tavanı; acil durumu engellemeyecek kadar yüksek). */
  maxSendsPerHour: 10,
  /** SOS ile birlikte acil kişilere başlatılan canlı paylaşım süresi (dk). [Varsayım] */
  autoShareMinutes: 60,
  /** Gönderimden önce taze konum için en çok bekleme; dolarsa son bilinen konum gönderilir. */
  freshFixTimeoutMs: 8 * SECOND,
  /** Bundan eski konum "eski konum" uyarısıyla gösterilir. */
  staleLocationMs: 2 * MINUTE,
  /** Çözülmüş SOS alıcıda bu süre "güvende" kartıyla görünür. */
  resolvedVisibleMs: HOUR,
  /** Adres araması en çok bu kadar beklenir (gönderimi geciktirmez). */
  addressTimeoutMs: 2 * SECOND,
} as const;

/** Uyarı metni (değişmez; alıcı kartı ve push başlığında). */
export const SOS_MESSAGE = 'Şu anda olduğum konumda tehlikedeyim';
/** Türkiye acil çağrı numarası. */
export const EMERGENCY_NUMBER = '112';

export type SosStatus = 'active' | 'resolved';
export type SosResolveReason = 'safe' | 'timeout' | 'account_deleted';

export interface SosLocation {
  lat: number;
  lng: number;
  /** Doğruluk yarıçapı, metre. */
  accuracy: number;
  /** Ölçüm anı (sunucu saatine çevrilmiş). */
  timestamp: EpochMs;
}

export interface SosRoute {
  /** "Ayşe Yılmaz" / "Seçilen nokta"; yoksa null. */
  destination_label: string | null;
  eta_s: number;
  distance_m: number;
}

export interface SosAlert {
  sos_id: string;
  sender_id: UserId;
  /** Yalnızca görünen ad. */
  sender_name: string;
  recipient_ids: UserId[];
  status: SosStatus;
  resolve_reason: SosResolveReason | null;
  message: string;
  location: SosLocation;
  /** Okunabilir adres (ters geocode); bulunamazsa null. */
  address: string | null;
  /** Evrensel harita bağlantısı (Google Maps arama URL'si; iOS/Android/web açar). */
  maps_url: string;
  battery_pct: number | null;
  is_charging: boolean | null;
  route: SosRoute | null;
  created_at: EpochMs;
  updated_at: EpochMs;
  resolved_at: EpochMs | null;
  /** Alıcı → "Gördüm" anı. */
  acks: Record<UserId, EpochMs>;
  update_count: number;
}

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const SosLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10_000),
  timestamp: z.number().int().positive(),
});

export const SosRouteSchema = z.object({
  destination_label: z.string().max(80).nullable().default(null),
  eta_s: z.number().int().min(0).max(7 * 24 * 3600),
  distance_m: z.number().min(0).max(5_000_000),
});

export const EmergencyContactsSetRequestSchema = z.object({
  op_id: z.uuid(),
  contact_ids: z.array(uid).max(SOS_LIMITS.maxContacts),
});
export type EmergencyContactsSetRequest = z.input<typeof EmergencyContactsSetRequestSchema>;
export interface EmergencyContactsSetResponse {
  /** Kabul edilen (arkadaş olan) kişiler; diğerleri sessizce atlanır. */
  contact_ids: UserId[];
  server_now: EpochMs;
}
export const EmergencyContactsSetResponseSchema: z.ZodType<EmergencyContactsSetResponse> = z.object({
  contact_ids: z.array(uid),
  server_now: z.number(),
});

export const SosSendRequestSchema = z.object({
  op_id: z.uuid(),
  /** Tam konum ZORUNLU. */
  location: SosLocationSchema,
  battery_pct: z.number().int().min(0).max(100).nullable().default(null),
  is_charging: z.boolean().nullable().default(null),
  route: SosRouteSchema.nullable().default(null),
  /** İstemcinin önbellekte bildiği adres; yoksa sunucu ters geocode dener (kota dışı, önbellekli). */
  address: z.string().max(200).nullable().default(null),
});
export type SosSendRequest = z.input<typeof SosSendRequestSchema>;

export interface SosSendResponse {
  sos: SosAlert;
  /** Push gönderilen alıcı sayısı. */
  recipients: number;
  server_now: EpochMs;
}

export const SosUpdateRequestSchema = z.object({
  op_id: z.uuid(),
  sos_id: z.string().min(1).max(64),
  location: SosLocationSchema,
  battery_pct: z.number().int().min(0).max(100).nullable().default(null),
  is_charging: z.boolean().nullable().default(null),
  route: SosRouteSchema.nullable().default(null),
});
export type SosUpdateRequest = z.input<typeof SosUpdateRequestSchema>;

export const SosResolveRequestSchema = z.object({ op_id: z.uuid(), sos_id: z.string().min(1).max(64) });
export type SosResolveRequest = z.input<typeof SosResolveRequestSchema>;

export const SosAckRequestSchema = z.object({ op_id: z.uuid(), sos_id: z.string().min(1).max(64) });
export type SosAckRequest = z.input<typeof SosAckRequestSchema>;

export interface SosAlertResponse {
  sos: SosAlert;
  server_now: EpochMs;
}

export const SosAlertSchema: z.ZodType<SosAlert> = z.object({
  sos_id: z.string().min(1),
  sender_id: uid,
  sender_name: z.string(),
  recipient_ids: z.array(uid),
  status: z.enum(['active', 'resolved']),
  resolve_reason: z.enum(['safe', 'timeout', 'account_deleted']).nullable(),
  message: z.string(),
  location: SosLocationSchema,
  address: z.string().nullable(),
  maps_url: z.string(),
  battery_pct: z.number().nullable(),
  is_charging: z.boolean().nullable(),
  route: z.object({ destination_label: z.string().nullable(), eta_s: z.number(), distance_m: z.number() }).nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  resolved_at: z.number().nullable(),
  acks: z.record(z.string(), z.number()),
  update_count: z.number(),
});

export const SosSendResponseSchema: z.ZodType<SosSendResponse> = z.object({
  sos: SosAlertSchema,
  recipients: z.number(),
  server_now: z.number(),
});
export const SosAlertResponseSchema: z.ZodType<SosAlertResponse> = z.object({ sos: SosAlertSchema, server_now: z.number() });

/** Okuma tarafı: bozuk belge atılır. Firestore Timestamp'leri okuyucu önceden epoch ms'ye çevirmelidir. */
export function parseSosAlert(raw: unknown): SosAlert | null {
  const r = SosAlertSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// --- yardımcılar --------------------------------------------------------------------------

/** 6 ondalık (~11 cm) — ekranda ve kopyalamada. */
export const formatCoord = (v: number): string => v.toFixed(6);
export const formatCoords = (lat: number, lng: number): string => `${formatCoord(lat)}, ${formatCoord(lng)}`;
export const formatAccuracyTr = (m: number): string => `±${m < 10 ? m.toFixed(0) : Math.round(m)} m`;

/** Evrensel harita bağlantısı (uygulama yoksa tarayıcıda açılır). */
export function sosMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${formatCoord(lat)}%2C${formatCoord(lng)}`;
}

/** Yol tarifi bağlantısı (alıcının konumundan SOS konumuna). */
export function sosDirectionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${formatCoord(lat)}%2C${formatCoord(lng)}`;
}

export const isSosActive = (a: Pick<SosAlert, 'status'>): boolean => a.status === 'active';

/** Alıcı ekranında gösterilecek mi: aktif ya da yakın zamanda çözülmüş. */
export function isSosVisible(a: Pick<SosAlert, 'status' | 'resolved_at'>, now: EpochMs): boolean {
  if (a.status === 'active') return true;
  return a.resolved_at !== null && now - a.resolved_at <= SOS_LIMITS.resolvedVisibleMs;
}

/** Konum yaşı uyarısı ("Konum 3 dk önce alındı") gerekiyor mu? */
export const isSosLocationStale = (loc: Pick<SosLocation, 'timestamp'>, now: EpochMs): boolean =>
  now - loc.timestamp > SOS_LIMITS.staleLocationMs;

/** Push metni. Ham koordinat İÇERMEZ (bkz. dosya başı). */
export function sosPushText(a: Pick<SosAlert, 'sender_name' | 'address' | 'location' | 'battery_pct'>): { title: string; body: string } {
  const parts = [a.address ?? 'Adres bulunamadı, konumu görmek için dokun', formatAccuracyTr(a.location.accuracy)];
  if (a.battery_pct !== null) parts.push(`Pil %${a.battery_pct}`);
  return { title: `ACİL: ${a.sender_name} tehlikede`, body: `${SOS_MESSAGE}. ${parts.join(' · ')}` };
}

export function sosResolvedPushText(senderName: string): { title: string; body: string } {
  return { title: `${senderName} güvende`, body: 'Acil durum uyarısı kapatıldı.' };
}

export function sosAckPushText(ackerName: string): { title: string; body: string } {
  return { title: `${ackerName} uyarını gördü`, body: 'Acil durum uyarın karşı tarafa ulaştı.' };
}

/** Kart özet satırı: "12 dk · 4,2 km" (rota varsa). */
export function formatSosRoute(r: SosRoute | null): string | null {
  if (!r) return null;
  const head = r.destination_label ? `${r.destination_label} yönüne` : 'Rota';
  return `${head}: ${formatEtaDuration(r.eta_s)} · ${formatDistanceTr(r.distance_m)}`;
}

// --- tetikleme akışı (saf durum makinesi; UI ve testler aynı kuralı kullanır) ------------------

export type SosFlowState =
  | { phase: 'idle' }
  | { phase: 'holding'; started_at: EpochMs }
  | { phase: 'countdown'; started_at: EpochMs }
  | { phase: 'sending' }
  | { phase: 'active'; sos_id: string }
  | { phase: 'error'; message: string };

export type SosFlowEvent =
  | { type: 'press_in'; at: EpochMs }
  | { type: 'press_out'; at: EpochMs }
  | { type: 'a11y_activate'; at: EpochMs }
  | { type: 'tick'; at: EpochMs }
  | { type: 'cancel' }
  | { type: 'send_now' }
  | { type: 'sent'; sos_id: string }
  | { type: 'failed'; message: string }
  | { type: 'resolved' };

/** Basılı tutma ilerlemesi 0..1. */
export function sosHoldProgress(s: SosFlowState, now: EpochMs): number {
  return s.phase === 'holding' ? Math.min(1, Math.max(0, (now - s.started_at) / SOS_LIMITS.holdMs)) : 0;
}

/** Geri sayımda kalan tam saniye (5, 4, … 1; 0 = gönder). */
export function sosCountdownLeft(s: SosFlowState, now: EpochMs): number {
  if (s.phase !== 'countdown') return 0;
  return Math.max(0, Math.ceil((s.started_at + SOS_LIMITS.countdownS * SECOND - now) / SECOND));
}

/**
 * Saf geçiş fonksiyonu. `sending` dönüşü, çağıranın `sos_send`'i başlatması gerektiğini söyler.
 *  - holding: `holdMs` dolmadan bırakma → idle; dolunca (tick ya da press_out) → countdown.
 *  - countdown: süre dolunca (tick) ya da "Hemen gönder" → sending; "İptal" → idle.
 *  - sending → active (sent) | error (failed). error'dan yeni basış tekrar akışı başlatır.
 */
export function sosFlowReduce(s: SosFlowState, e: SosFlowEvent): SosFlowState {
  switch (e.type) {
    case 'press_in':
      return s.phase === 'idle' || s.phase === 'error' ? { phase: 'holding', started_at: e.at } : s;
    case 'a11y_activate':
      return s.phase === 'idle' || s.phase === 'error' ? { phase: 'countdown', started_at: e.at } : s;
    case 'press_out':
      if (s.phase !== 'holding') return s;
      return e.at - s.started_at >= SOS_LIMITS.holdMs ? { phase: 'countdown', started_at: e.at } : { phase: 'idle' };
    case 'tick':
      if (s.phase === 'holding' && e.at - s.started_at >= SOS_LIMITS.holdMs) return { phase: 'countdown', started_at: e.at };
      if (s.phase === 'countdown' && sosCountdownLeft(s, e.at) === 0) return { phase: 'sending' };
      return s;
    case 'cancel':
      return s.phase === 'holding' || s.phase === 'countdown' || s.phase === 'error' ? { phase: 'idle' } : s;
    case 'send_now':
      return s.phase === 'countdown' ? { phase: 'sending' } : s;
    case 'sent':
      return s.phase === 'sending' ? { phase: 'active', sos_id: e.sos_id } : s;
    case 'failed':
      return s.phase === 'sending' ? { phase: 'error', message: e.message } : s;
    case 'resolved':
      return s.phase === 'active' ? { phase: 'idle' } : s;
  }
}

/** Saatlik tavan penceresi (sunucu sayaç anahtarı). */
export const sosHourBucket = (now: EpochMs): number => Math.floor(now / HOUR);
