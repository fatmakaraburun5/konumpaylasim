/**
 * Faz 9: Güvenli Dönüş arayüzünün saf yardımcıları (test edilir). Metinler core `SAFE_RETURN_TEXT`.
 */
import { isLateNight, SAFE_RETURN_TEXT, type SafeReturnPhase, type Zone } from '@konum/core';

/** Geri sayım: "12:05" (1 saatin altında) ya da "1 sa 05 dk". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} sa ${String(m).padStart(2, '0')} dk`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Harita bandı metni (core `SAFE_RETURN_TEXT.banner` / `endingSoon`). */
export function safeReturnBannerText(phase: SafeReturnPhase | 'idle', destName: string, leftMs: number): string {
  switch (phase) {
    case 'ending_soon':
      return SAFE_RETURN_TEXT.endingSoon(formatCountdown(leftMs));
    case 'final_warning':
      return `${SAFE_RETURN_TEXT.finalWarningTitle} · ${formatCountdown(leftMs)}`;
    case 'alarm':
      return SAFE_RETURN_TEXT.alarmSent;
    default:
      return SAFE_RETURN_TEXT.banner(destName, formatCountdown(leftMs));
  }
}

/** Şu an yerel saatle gece geç mi (22:00–06:00)? */
export function lateNightNow(d: Date = new Date()): boolean {
  return isLateNight(d.getHours() * 60 + d.getMinutes());
}

/** Varsayılan hedef: "Ev" türündeki (ya da adlı) bölge, yoksa ilk bölge. */
export function defaultSafeReturnZone(zones: readonly Pick<Zone, 'zone_id' | 'kind' | 'name'>[]): string | null {
  const home = zones.find((z) => z.kind === 'home') ?? zones.find((z) => z.name.trim().toLocaleLowerCase('tr') === 'ev');
  return (home ?? zones[0])?.zone_id ?? null;
}

/** Bant / son uyarı görünür mü? */
export const isSafeReturnLive = (phase: SafeReturnPhase | 'idle'): boolean => phase === 'running' || phase === 'ending_soon' || phase === 'final_warning' || phase === 'alarm';
