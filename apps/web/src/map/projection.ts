/**
 * Yedek harita (anahtar yokken) için yerel düzlem izdüşümü: kısa mesafede (birkaç km) metre
 * cinsinden doğu / kuzey farkı. Saf; testli.
 */
import type { LatLng } from '@konum/core';

const R = 6_371_008.8;
const M_PER_DEG = (Math.PI / 180) * R;

/** `anchor` → `p` farkı: x doğu (+), y kuzey (+), metre. Boylam farkı 180. meridyende kısa yoldan. */
export function offsetMeters(anchor: LatLng, p: LatLng): { x: number; y: number } {
  let dLng = p.lng - anchor.lng;
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;
  return {
    x: dLng * M_PER_DEG * Math.cos((anchor.lat * Math.PI) / 180),
    y: (p.lat - anchor.lat) * M_PER_DEG,
  };
}

/** Pozitif mod (desen kaydırma için). */
export const posMod = (v: number, m: number): number => ((v % m) + m) % m;

/**
 * Ölçek çubuğu: `maxPx` genişliği geçmeyen en büyük 1·2·5×10ⁿ metre.
 * `pxPerM` = 1 metrenin piksel karşılığı.
 */
export function scaleBar(pxPerM: number, maxPx = 96): { meters: number; px: number; label: string } {
  const maxM = maxPx / pxPerM;
  const exp = Math.floor(Math.log10(maxM));
  let meters = 10 ** exp;
  for (const f of [5, 2, 1]) {
    if (f * 10 ** exp <= maxM) {
      meters = f * 10 ** exp;
      break;
    }
  }
  const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  return { meters, px: meters * pxPerM, label };
}
