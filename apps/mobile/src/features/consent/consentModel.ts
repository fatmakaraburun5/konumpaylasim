/**
 * Faz 8: onay kapısının saf mantığı (docs/PHASE8.md §5.1).
 *
 *  - Kaydırma kararı core `isScrolledToBottom` (tolerans 24 px; metin ekrana sığıyorsa doğrudan true). Bir kez sona
 *    ulaşıldı mı kalıcıdır (`latchScrolled`): yazı boyutu / döndürme sonrası içerik uzasa da düğme yeniden kapanmaz.
 *  - Alt çubuk: sona kaydırılmadan düğme pasif ve altında "Onaylamak için metni sonuna kadar kaydır" yazar; sonra
 *    kısa bir onay notuna döner. Hata olursa metin gösterilir, düğme yeniden denemek için açık kalır.
 */
import {
  CONSENT_UI_TEXT,
  CONSENT_VERSION,
  deviceOffset,
  isScrolledToBottom,
  type EpochMs,
  type OffsetFn,
  type ProfileConsent,
  type ScrollMetrics,
} from '@konum/core';

/** İlk onay mı, güncellenen metnin yeniden onayı mı ("Metin güncellendi" + değişiklik özeti). */
export type ConsentGateMode = 'first' | 'updated';

export function consentGateMode(consent: ProfileConsent | null | undefined, current: string = CONSENT_VERSION): ConsentGateMode {
  return consent && consent.version !== current ? 'updated' : 'first';
}

/** Sona bir kez ulaşıldıysa açık kalır. */
export function latchScrolled(prev: boolean, m: ScrollMetrics): boolean {
  return prev || isScrolledToBottom(m);
}

export const CONSENT_READY_NOTE = 'Metnin tamamını gördün. Onaylayınca uygulamaya geçersin.';

export interface ConsentFooterView {
  disabled: boolean;
  note: string;
  tone: 'hint' | 'ok' | 'error';
}

export function consentFooterView(s: { scrolled: boolean; busy: boolean; error: string | null }): ConsentFooterView {
  if (!s.scrolled) return { disabled: true, note: CONSENT_UI_TEXT.scrollHint, tone: 'hint' };
  if (s.error && !s.busy) return { disabled: false, note: s.error, tone: 'error' };
  return { disabled: false, note: CONSENT_READY_NOTE, tone: 'ok' };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Onay tarihi: "25.11.2026 14:30" (cihaz saat dilimi). */
export function formatConsentAcceptedAt(at: EpochMs, offsetAt: OffsetFn = deviceOffset): string {
  const d = new Date(at + offsetAt(at) * 60_000);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
