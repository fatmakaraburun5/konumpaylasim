export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6_371_008.8; // ortalama dünya yarıçapı, metre

/** İki nokta arası büyük daire mesafesi (metre). */
export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 6 ondalık ≈ 11 cm. Daha fazla hassasiyet boyut artırır, bilgi taşımaz. */
export const roundCoord = (v: number): number => Math.round(v * 1e6) / 1e6;
