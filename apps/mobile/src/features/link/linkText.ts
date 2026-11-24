/** Bağlantı (QR) paylaşımı arayüz metinleri (saf). */
import { formatExpiryLabel, LINK_END_REASON_TEXT, type EpochMs } from '@konum/core';
import { fixUntilSuffix } from '../../lib/turkish';
import type { LinkSession } from '../../state/linkStore';

export const LINK_TITLE: Record<LinkSession['phase'], string> = {
  active: 'QR ile paylaşılıyor',
  expiring_soon: 'QR ile paylaşılıyor',
  extending: 'Süre uzatılıyor…',
  stopping: 'Paylaşım durduruluyor…',
  ended: 'Paylaşım sona erdi',
};

/** Kalan süre / bitiş satırı: "17:45'e kadar · 1 sa kaldı", bittiyse neden. */
export function linkSubtitle(l: LinkSession, now: EpochMs): string {
  if (l.phase === 'ended') return LINK_END_REASON_TEXT[l.end_reason ?? 'stopped_by_sender'];
  return fixUntilSuffix(formatExpiryLabel(l, now));
}

/** Paylaşım sayfasında karşı tarafa gidecek metin (URL ile birlikte). */
export function shareMessage(url: string): string {
  return `Canlı konumumu bu bağlantıdan görebilirsin: ${url}`;
}

export const QR_MISSING_TEXT = 'Bu bağlantının QR kodu bu cihazda yok. Paylaşımı durdurup yenisini oluşturabilirsin.';
