/**
 * Faz 12: "Mola" — paylaşım süreleri İŞLEMEYE devam ederken konum yayınını kısa süre bekletir.
 *
 *  - Yalnızca cihazdadır (sunucu belgesi yok): `konum.bg.break.v1` (persist.ts) + kesme anahtarı (`publishHold`).
 *    Başsız arka plan görevi de kaydı okur: `until` geçtiyse mola kendiliğinden biter, yayın geri gelir.
 *  - Mola başlarken durum notu "☕ Moladayım" (bitişe kadar) yazılır ve TEK paket gönderilir; alıcı son konumu + notu
 *    görür, sonra pin "x dk önce" olur. Koordinat yeni pakette gitmez (son paket mola öncesi konumdur).
 *  - Paylaşım süreleri uzamaz: 1 saatlik paylaşımın 15 dk molası yine 1 saatin içindedir. [Varsayım]
 *  - Görünmez Ol molayı siler (görünmez zaten her şeyi keser); tüm paylaşımlar bitince mola da biter.
 *  - Yeni paylaşım başlatmak (kısayol / paylaş sayfası) molayı bitirir: kullanıcı "paylaş" dediyse yayın açılmalı.
 */
import { MINUTE, type EpochMs } from './time';

export const BREAK_MINUTES = [15, 30] as const;
export type BreakMinutes = (typeof BREAK_MINUTES)[number];

export interface BreakState {
  started_at: EpochMs;
  until: EpochMs;
}

export const BREAK_NOTE = { emoji: '☕', text: 'Moladayım' } as const;

export function startBreak(now: EpochMs, minutes: BreakMinutes): BreakState {
  return { started_at: now, until: now + minutes * MINUTE };
}

/** Mola şu an sürüyor mu (kayıt var ve bitiş gelmedi). */
export function isOnBreak(b: BreakState | null | undefined, now: EpochMs): b is BreakState {
  return !!b && Number.isFinite(b.until) && b.until > now && b.started_at <= now + MINUTE;
}

/** Diskten okunan kaydı doğrular (bozuk / aşırı uzun kayıt yok sayılır: en çok 1 saat). */
export function parseBreakState(v: unknown): BreakState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = o.started_at;
  const u = o.until;
  if (typeof s !== 'number' || typeof u !== 'number' || !Number.isFinite(s) || !Number.isFinite(u)) return null;
  if (u <= s || u - s > 60 * MINUTE) return null;
  return { started_at: s, until: u };
}

export const BREAK_TEXT = {
  action: 'Mola',
  pick: 'Ne kadar mola?',
  on: (left: string) => `Moladasın · ${left}`,
  resume: 'Devam et',
  hint: 'Paylaşım süren işlemeye devam eder; mola boyunca yeni konum gitmez.',
  endsOnShare: 'Yeni paylaşım başlatınca molan biter.',
} as const;
