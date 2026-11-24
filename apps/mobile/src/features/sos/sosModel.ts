/**
 * Faz 4: SOS arayüzünün saf yardımcıları (gönderen ve alıcı ekranı, harita; testler de kullanır).
 */
import { isSosActive, type EpochMs, type SosAlert, type SosFlowState, type SosRoute, type UserId } from '@konum/core';

/** SOS ekranları tema renginden bağımsız yüksek kontrastlı kırmızıdır (açık tema `danger`: beyaz yazıyla ~6.5:1). */
export const SOS_FG = '#FFFFFF';

export interface SosAckRow {
  uid: UserId;
  name: string;
  /** "Gördüm" anı; görmediyse null. */
  ackedAt: EpochMs | null;
}

/** Gönderen ekranı: alıcılar, görenler önce (en erken gören en üstte), sonra görmeyenler (alıcı sırası). */
export function sosAckRows(a: Pick<SosAlert, 'recipient_ids' | 'acks'>, names: Record<UserId, string>): SosAckRow[] {
  const rows = a.recipient_ids.map((uid) => ({ uid, name: names[uid] ?? 'Arkadaş', ackedAt: a.acks[uid] ?? null }));
  const seen = rows.filter((r) => r.ackedAt !== null).sort((x, y) => (x.ackedAt as number) - (y.ackedAt as number));
  return [...seen, ...rows.filter((r) => r.ackedAt === null)];
}

/** "2 kişiden 1'i gördü" özeti. */
export function sosAckSummary(a: Pick<SosAlert, 'recipient_ids' | 'acks'>): string {
  const total = a.recipient_ids.length;
  const seen = a.recipient_ids.filter((u) => a.acks[u] !== undefined).length;
  if (total === 0) return 'Alıcı yok';
  if (seen === 0) return total === 1 ? 'Uyarı iletildi, henüz görülmedi' : `${total} kişiye iletildi, henüz görülmedi`;
  if (seen === total) return total === 1 ? 'Uyarını gördü' : `${total} kişinin hepsi gördü`;
  return `${total} kişiden ${seen} kişi gördü`;
}

/**
 * Haritada açık rota hedefi + ETA sonucu → SOS paketi rotası. [Varsayım] "Aktif rota" = SOS anında haritada açık
 * olan rota kartı (arkadaşa ya da seçilen noktaya); yoksa null.
 */
export function sosRouteFrom(title: string | null, result: { duration_s: number; distance_m: number } | null | undefined): SosRoute | null {
  if (!result || !Number.isFinite(result.duration_s) || !Number.isFinite(result.distance_m)) return null;
  return {
    destination_label: title ? title.slice(0, 80) : null,
    eta_s: Math.max(0, Math.round(result.duration_s)),
    distance_m: Math.max(0, Math.round(result.distance_m)),
  };
}

/** Basılı tutma erken bırakıldı mı (ipucu "Göndermek için basılı tut" gösterilir)? */
export const isEarlyRelease = (prev: SosFlowState['phase'], next: SosFlowState['phase']): boolean => prev === 'holding' && next === 'idle';

/** Haritada ayrı SOS pini: aktif ve göndereni canlı arkadaş pini olarak görünmeyen uyarılar. */
export function sosPins(alerts: readonly SosAlert[], liveSenders: ReadonlySet<UserId>): SosAlert[] {
  return alerts.filter((a) => isSosActive(a) && !liveSenders.has(a.sender_id));
}

/** Pil satırı: "Pil %23 · şarj oluyor". */
export function sosBatteryText(a: Pick<SosAlert, 'battery_pct' | 'is_charging'>): string | null {
  if (a.battery_pct === null) return null;
  return a.is_charging ? `Pil %${a.battery_pct} · şarj oluyor` : `Pil %${a.battery_pct}`;
}
