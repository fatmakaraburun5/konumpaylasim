/**
 * Faz 4: tek dokunuşla "Buradayım / Yoldayım" sinyali (ping).
 *
 * Akış: gönderen `ping_send` callable'ını çağırır → sunucu arkadaşlığı ve hız sınırını doğrular → alıcının
 * RTDB kutusuna `ping_inbox/{to}/{ping_id}` yazar (yalnızca alıcı okur ve siler) → alıcıya görünür push
 * (koordinat YOK). Alıcı uygulaması açıksa kutu dinleyicisi anında kart/pin vurgusu üretir; kapalıysa push gelir.
 *
 * Konum: "Buradayım" varsayılan olarak o anki konumu (tek nokta, `ttlMs` boyunca) taşır; böylece alıcı gönderenle
 * canlı paylaşımı olmasa bile noktayı görür. "Yoldayım" isteğe bağlı ETA (sn) taşır. Konum alıcı başına, sunucu
 * üzerinden ve yalnızca o alıcının kutusuna gider; push yükünde koordinat bulunmaz.
 */
import { z } from 'zod';
import type { UserId } from './model';
import { formatEtaDuration } from './mapsPolicy';
import { MINUTE, SECOND, HOUR, type EpochMs } from './time';

export const PING_KINDS = ['here', 'on_way'] as const;
export type PingKind = (typeof PING_KINDS)[number];

/** Düğme ve bildirim metinleri. */
export const PING_TEXT: Record<PingKind, string> = { here: 'Buradayım', on_way: 'Yoldayım' };
export const PING_EMOJI: Record<PingKind, string> = { here: '📍', on_way: '🚶' };

export const PING_LIMITS = {
  /** Ping bu süre sonra kutudan düşer (sunucu süpürücüsü de siler). [Varsayım] */
  ttlMs: 15 * MINUTE,
  /** Aynı kişiye iki ping arası en az bu kadar (yanlışlıkla çift dokunma, taciz koruması). [Varsayım] */
  perPairCooldownMs: 20 * SECOND,
  /** Kullanıcı başına saatlik tavan. [Varsayım] */
  perUserPerHour: 30,
  maxEtaS: 24 * 3600,
  /** Ping konumunun en fazla yaşı; daha eski nokta gönderilmez (istemci konumsuz gönderir). */
  maxLocationAgeMs: 5 * MINUTE,
  /** Haritada pin vurgusunun (nabız halkası) süresi. */
  highlightMs: 8 * SECOND,
} as const;

export interface PingLocation {
  lat: number;
  lng: number;
  /** Doğruluk yarıçapı, metre. */
  accuracy: number;
  /** Ölçüm anı (sunucu saatine çevrilmiş). */
  timestamp: EpochMs;
}

/** RTDB `ping_inbox/{to}/{ping_id}` kaydı (yalnızca sunucu yazar; alıcı okur ve siler). */
export interface Ping {
  ping_id: string;
  from: UserId;
  kind: PingKind;
  sent_at: EpochMs;
  expires_at: EpochMs;
  location: PingLocation | null;
  eta_s: number | null;
}

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const PingLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(5_000),
  timestamp: z.number().int().positive(),
});

export const PingSendRequestSchema = z.object({
  op_id: z.uuid(),
  to: uid,
  kind: z.enum(PING_KINDS),
  location: PingLocationSchema.nullable().default(null),
  eta_s: z.number().int().min(0).max(PING_LIMITS.maxEtaS).nullable().default(null),
});
export type PingSendRequest = z.input<typeof PingSendRequestSchema>;

export interface PingSendResponse {
  ping_id: string;
  expires_at: EpochMs;
  server_now: EpochMs;
}
export const PingSendResponseSchema: z.ZodType<PingSendResponse> = z.object({
  ping_id: z.string().min(1),
  expires_at: z.number(),
  server_now: z.number(),
});

/** Okuma tarafı (RTDB null saklamaz: eksik `location`/`eta_s` null olur). Bozuk kayıt null. */
const PingReadSchema = z.object({
  ping_id: z.string().min(1),
  from: uid,
  kind: z.enum(PING_KINDS),
  sent_at: z.number(),
  expires_at: z.number(),
  location: PingLocationSchema.nullable().optional().catch(null),
  eta_s: z.number().nullable().optional().catch(null),
});

export function parsePing(raw: unknown, idFallback?: string): Ping | null {
  const obj = raw && typeof raw === 'object' ? { ping_id: idFallback, ...(raw as Record<string, unknown>) } : raw;
  const r = PingReadSchema.safeParse(obj);
  if (!r.success) return null;
  return { ...r.data, location: r.data.location ?? null, eta_s: r.data.eta_s ?? null };
}

export const isPingActive = (p: Pick<Ping, 'expires_at'>, now: EpochMs): boolean => p.expires_at > now;

/** Gönderen tarafı: bu kişiye şimdi ping atılabilir mi (soğuma süresi)? `lastAt` = son başarılı gönderim. */
export function pingCooldownLeftMs(lastAt: EpochMs | null | undefined, now: EpochMs): number {
  if (!lastAt) return 0;
  return Math.max(0, lastAt + PING_LIMITS.perPairCooldownMs - now);
}

/** Bildirim metni (push ve uygulama içi kart). Koordinat İÇERMEZ. */
export function pingPushText(senderName: string, kind: PingKind, etaS: number | null = null): { title: string; body: string } {
  const body =
    kind === 'on_way'
      ? etaS !== null && etaS > 0
        ? `${PING_EMOJI.on_way} Yoldayım · yaklaşık ${formatEtaDuration(etaS)} içinde oradayım`
        : `${PING_EMOJI.on_way} Yoldayım`
      : `${PING_EMOJI.here} Buradayım`;
  return { title: senderName, body };
}

/** Saatlik tavan penceresi (sunucu sayaç anahtarı için). */
export const pingHourBucket = (now: EpochMs): number => Math.floor(now / HOUR);
