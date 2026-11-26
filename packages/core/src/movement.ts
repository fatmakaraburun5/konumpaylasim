/**
 * Faz 7: hareket ve bölge olaylarının arka plan heads-up bildirimleri ("Ayşe eve girdi", "Mehmet yola çıktı").
 *
 *  - Bölge (Faz 5 `zone_event_report`): metin bölge türüne göre doğal Türkçe (`zoneHeadsUpText`); kanal
 *    `movement` (Android IMPORTANCE_HIGH → kilit ekranında ve uygulama dışındayken üstten banner; iOS
 *    `time-sensitive`). Koordinat YOK, yalnızca bölge adı.
 *  - "Yola çıktı" (`movement_report`): paylaşım sürerken gönderenin hareket makinesi en az `stillBeforeMs` sabit
 *    kaldıktan sonra yürüme/araç bandına geçerse istemci bildirir (`shouldReportDeparture`). Sunucu yalnızca o an
 *    ETKİN paylaşımın alıcılarına (onlar zaten canlı konumu görüyor: yeni bilgi sızmaz) ve `movement_alerts`
 *    tercihi kapalı olmayanlara gönderir; gönderen başına `cooldownMs` soğuma. Görünmez modda hiç gitmez.
 */
import { z } from 'zod';
import type { MotionState } from './motion';
import type { ZoneKind, ZoneTrigger } from './zones';
import { MINUTE, type EpochMs } from './time';

export const MOVEMENT_LIMITS = {
  /** "Yola çıktı" sayılması için önceki sabit kalma süresi. [Varsayım] */
  stillBeforeMs: 10 * MINUTE,
  /** Aynı göndericiden en sık bu aralıkla. [Varsayım] */
  cooldownMs: 30 * MINUTE,
  /** İstemcinin bildirdiği an en çok bu kadar eski olabilir. */
  maxReportAgeMs: 5 * MINUTE,
  /** Bildirim TTL (geç gelen "yola çıktı" yanıltıcıdır). */
  pushTtlMs: 15 * MINUTE,
} as const;

export const MOVEMENT_KINDS = ['departed'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

const MOVING: readonly MotionState[] = ['walking', 'running', 'cycling', 'driving', 'fast'];

/**
 * İstemci: hareket makinesi geçişi "yola çıktı" mı? `stillSince` = sabite giriş anı (null = sabit değildi).
 * Kısa duraklamalar (trafik ışığı, market) sayılmaz.
 */
export function shouldReportDeparture(prev: MotionState, next: MotionState, stillSince: EpochMs | null, now: EpochMs, lastReportAt: EpochMs | null): boolean {
  if (prev !== 'stationary' || !MOVING.includes(next)) return false;
  if (stillSince === null || now - stillSince < MOVEMENT_LIMITS.stillBeforeMs) return false;
  if (lastReportAt !== null && now - lastReportAt < MOVEMENT_LIMITS.cooldownMs) return false;
  return true;
}

export const MovementReportRequestSchema = z.object({
  op_id: z.uuid(),
  kind: z.enum(MOVEMENT_KINDS),
  /** Geçişin cihazdaki anı (sunucu saatine çevrilmiş). */
  at: z.number().int().positive(),
});
export type MovementReportRequest = z.input<typeof MovementReportRequestSchema>;

export const MOVEMENT_REPORT_STATUSES = ['sent', 'cooldown', 'no_recipients', 'stale', 'invisible'] as const;
export type MovementReportStatus = (typeof MOVEMENT_REPORT_STATUSES)[number];

export interface MovementReportResponse {
  status: MovementReportStatus;
  /** Bildirim giden kişi SAYISI (kimlik yok). */
  notified_count: number;
  server_now: EpochMs;
}

export const MovementReportResponseSchema: z.ZodType<MovementReportResponse> = z.object({
  status: z.enum(MOVEMENT_REPORT_STATUSES),
  notified_count: z.number().int().nonnegative(),
  server_now: z.number(),
});

/** "Mehmet yola çıktı" · "Canlı konumunu haritada görebilirsin". */
export function movementPushText(senderName: string | null | undefined, kind: MovementKind): { title: string; body: string } {
  const n = senderName && senderName.trim() ? senderName.trim() : 'Arkadaşın';
  switch (kind) {
    case 'departed':
      return { title: `${n} yola çıktı`, body: 'Canlı konumunu haritada görebilirsin' };
  }
}

/** Bölge türüne göre doğal ifade: [varış, ayrılış]. Özel noktalarda ad kullanılır. */
const KIND_PHRASE: Record<Exclude<ZoneKind, 'custom'>, { arrive: string; leave: string }> = {
  home: { arrive: 'eve girdi', leave: 'evden çıktı' },
  work: { arrive: 'işe vardı', leave: 'işten çıktı' },
  school: { arrive: 'okula vardı', leave: 'okuldan çıktı' },
};

/**
 * Heads-up metni: başlık tek bakışta okunur ("Ayşe eve girdi"), gövde bölge adı. Faz 5 `zoneEventPushText` ile
 * aynı bilgi (koordinat yok); yalnızca dil doğallaştırıldı. `kind` bilinmiyorsa ad ile.
 */
export function zoneHeadsUpText(senderName: string | null | undefined, zoneName: string, kind: ZoneKind | null, transition: ZoneTrigger): { title: string; body: string } {
  const n = senderName && senderName.trim() ? senderName.trim() : 'Arkadaşın';
  if (kind && kind !== 'custom') {
    const p = KIND_PHRASE[kind];
    return { title: `${n} ${transition === 'arrive' ? p.arrive : p.leave}`, body: zoneName };
  }
  return transition === 'arrive' ? { title: `${n} ${zoneName} konumuna vardı`, body: zoneName } : { title: `${n} ${zoneName} konumundan ayrıldı`, body: zoneName };
}
