/**
 * Faz 7: İzin & Gizlilik Merkezi — kullanıcının paylaşım tercihleri (bkz. docs/PHASE7.md §5).
 *
 * Kayıt: `users/{uid}.privacy` (YALNIZCA `privacy_settings_set` callable yazar) + RTDB aynası `privacy/{uid}`
 * (yalnızca sunucu yazar). RTDB kuralları `battery_pct` / `is_charging` alanlarını aynadaki `battery_share`
 * açık değilse REDDEDER: istemci hata yapsa bile pil bilgisi alıcıya ulaşmaz (sunucu tarafı zorlama).
 *
 * Varsayılanlar (gizlilik öncelikli, KVKK m.4 ölçülülük):
 *  - `battery_share: false` — pil seviyesi ve şarj durumu ancak kullanıcı açıkça açarsa paylaşılır (ilk açılış
 *    izin akışında ve Gizlilik Merkezi'nde anahtar). Kapalıyken alıcıya %15 düşük pil bildirimi de GİTMEZ.
 *  - `movement_alerts: true` — bana konumunu paylaşan arkadaşın "yola çıktı" bildirimini alırım (alıcı tercihi).
 *
 * Sıralama (yarış koşulu): açarken önce RTDB aynası sonra Firestore; kapatırken önce Firestore (istemci hemen
 * bırakır) sonra RTDB. Böylece istemcinin bildiği değer hiçbir an aynadan daha "açık" olmaz.
 */
import { z } from 'zod';
import type { EpochMs } from './time';

export interface PrivacySettings {
  /** Canlı pakette pil yüzdesi + şarj durumu ve düşük pil bildirimi. */
  battery_share: boolean;
  /** Alıcı tercihi: paylaşan arkadaş "yola çıktı" heads-up bildirimi. */
  movement_alerts: boolean;
  updated_at: EpochMs | null;
}

export const DEFAULT_PRIVACY: PrivacySettings = Object.freeze({ battery_share: false, movement_alerts: true, updated_at: null });

/** `users/{uid}.privacy` alanını okur; eksik / bozuk alanlar varsayılana döner. */
export function parsePrivacy(raw: unknown): PrivacySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PRIVACY };
  const r = raw as Record<string, unknown>;
  return {
    battery_share: r.battery_share === true,
    movement_alerts: r.movement_alerts !== false,
    updated_at: typeof r.updated_at === 'number' ? r.updated_at : null,
  };
}

export const batterySharingAllowed = (p: Pick<PrivacySettings, 'battery_share'> | null | undefined): boolean => p?.battery_share === true;

/** Pakete yazılacak pil alanları: izin yoksa ikisi de null (alan hiç yazılmaz). */
export function packetBatteryFields(
  p: Pick<PrivacySettings, 'battery_share'> | null | undefined,
  batteryPct: number | null,
  isCharging: boolean | null,
): { battery_pct: number | null; is_charging: boolean | null } {
  if (!batterySharingAllowed(p)) return { battery_pct: null, is_charging: null };
  return { battery_pct: batteryPct, is_charging: isCharging };
}

export const PrivacySettingsSetRequestSchema = z
  .object({
    op_id: z.uuid(),
    battery_share: z.boolean().optional(),
    movement_alerts: z.boolean().optional(),
  })
  .refine((d) => d.battery_share !== undefined || d.movement_alerts !== undefined, { message: 'en az bir ayar' });
export type PrivacySettingsSetRequest = z.input<typeof PrivacySettingsSetRequestSchema>;

export interface PrivacySettingsResponse {
  privacy: PrivacySettings;
  server_now: EpochMs;
}

export const PrivacySettingsSchema: z.ZodType<PrivacySettings> = z.object({
  battery_share: z.boolean(),
  movement_alerts: z.boolean(),
  updated_at: z.number().nullable(),
});

export const PrivacySettingsResponseSchema: z.ZodType<PrivacySettingsResponse> = z.object({ privacy: PrivacySettingsSchema, server_now: z.number() });

export const PRIVACY_TEXT = {
  batteryTitle: 'Pil durumumu paylaş',
  batteryBody: 'Konumunu paylaştığın kişiler pil yüzdeni ve şarjda olup olmadığını görür; pilin %15\'in altına inince haber alır. Kapalıyken bu bilgiler hiç gönderilmez.',
  movementTitle: '"Yola çıktı" bildirimleri',
  movementBody: 'Sana konumunu paylaşan bir arkadaşın bir süre durduktan sonra harekete geçince bildirim alırsın.',
} as const;
