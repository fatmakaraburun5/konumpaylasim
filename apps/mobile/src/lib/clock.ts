/**
 * Sunucu saati. Tüm süre karşılaştırmaları (bitiş, tazelik) SUNUCU saatine göre yapılır;
 * cihaz saati yanlış olsa bile süresi dolan paylaşım zamanında gizlenir.
 * Fark RTDB `.info/serverTimeOffset` ile gelir (bkz. liveRepo) ve arka plan görevi için saklanır.
 */
import { serverNow, type EpochMs } from '@konum/core';

let offsetMs = 0;
const listeners = new Set<(offset: number) => void>();

export function getServerOffsetMs(): number {
  return offsetMs;
}

export function setServerOffsetMs(next: number): void {
  if (!Number.isFinite(next) || next === offsetMs) return;
  offsetMs = next;
  for (const l of listeners) l(next);
}

export function onServerOffsetChange(l: (offset: number) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Sunucu saatine göre şimdi (epoch ms). */
export function now(): EpochMs {
  return serverNow(offsetMs);
}
