/**
 * Faz 5: konum hattından bölge filtresine ince bağlantı (pipeline → zoneMonitor). Döngüsel içe aktarmayı önler:
 * pipeline yalnızca bu modülü bilir, zoneMonitor yüklenince kendini kaydeder (başsız açılışta backgroundTask.ts
 * zoneMonitor'ü içe aktarır). Ek GPS yoktur: yalnızca zaten alınmış örnekler beslenir.
 */
import type { RawLocationSample } from '@konum/core';

export type ZoneTapSource = 'task' | 'watch' | 'heartbeat';
type Tap = (raws: readonly RawLocationSample[], source: ZoneTapSource) => void;

let tap: Tap | null = null;

export function setZoneSampleTap(t: Tap | null): void {
  tap = t;
}

export function tapZoneSamples(raws: readonly RawLocationSample[], source: ZoneTapSource): void {
  if (!tap || raws.length === 0) return;
  try {
    tap(raws, source);
  } catch {
    // bölge filtresi hatası konum hattını etkilemez
  }
}
