/**
 * Web önizleme haritasının geometrisi (Kadıköy / Moda): kara, iskeleler, parklar, adlı caddeler, etiketler.
 *
 * YALNIZCA web paketi: önizleme haritası (`features/map/PreviewMap.web.tsx`) bunu çizer, demo sunucusu
 * (`demo/server/routing.ts`) aynı caddeler üzerinde sahte rota (route_compute) ve sahte adres (geocode_reverse)
 * üretir. Böylece rota çizgisi haritadaki yollara oturur.
 *
 * Buradaki her şey gerçek coğrafyanın KABA bir taslağıdır; cadde adları ve konumları yalnızca önizleme içindir,
 * navigasyon için değildir. Telefonda harita, rota ve adres Google Maps SDK / Routes API / Geocoding API'den gelir.
 */

/** [enlem, boylam] */
export type LL = readonly [lat: number, lng: number];

/** İlk görünüm: Moda (demo dünyasının merkezi; world.ts `MAP_HOME` ile aynı). */
export const HOME: LL = [40.9862, 29.0275];

/** Kıyı çizgisi: Harem → Haydarpaşa → Kadıköy iskelesi → Moda Burnu → Kalamış → Fenerbahçe → doğu. */
export const COAST: readonly LL[] = [
  [41.03, 29.004], [41.012, 29.008], [41.004, 29.0128], [40.999, 29.017], [40.9973, 29.0158], [40.9963, 29.0165],
  [40.9967, 29.0188], [40.9956, 29.0203], [40.9941, 29.0213], [40.9929, 29.0221], [40.9916, 29.0231], [40.9903, 29.0229],
  [40.989, 29.0221], [40.987, 29.0217], [40.985, 29.0219], [40.983, 29.0221], [40.9812, 29.0227], [40.9795, 29.0235],
  [40.9783, 29.0247], [40.9779, 29.0264], [40.9785, 29.0285], [40.979, 29.031], [40.9788, 29.0335], [40.9783, 29.036],
  [40.9776, 29.0378], [40.9762, 29.0391], [40.9745, 29.0395], [40.9725, 29.0391], [40.9705, 29.0379], [40.9688, 29.0367],
  [40.967, 29.0357], [40.9655, 29.0351], [40.9648, 29.0369], [40.9658, 29.0394], [40.9678, 29.0421], [40.9697, 29.046],
  [40.9712, 29.052], [40.9728, 29.06], [40.9742, 29.07], [40.9748, 29.09], [40.9748, 29.12],
];
export const LAND: readonly LL[] = [...COAST, [41.04, 29.12], [41.04, 29.004]];

/** Vapur iskeleleri (küçük kara çıkıntıları). */
export const PIERS: readonly (readonly LL[])[] = [
  [[40.9934, 29.0218], [40.9937, 29.0206], [40.9934, 29.0204], [40.9931, 29.0217]],
  [[40.9921, 29.0228], [40.9923, 29.0216], [40.992, 29.0215], [40.9918, 29.0227]],
  [[40.9779, 29.0379], [40.977, 29.0368], [40.9767, 29.0371], [40.9776, 29.0382]],
];

export interface NamedArea {
  name: string;
  ring: readonly LL[];
}

export const PARKS: readonly NamedArea[] = [
  { name: 'Yoğurtçu Parkı', ring: [[40.9859, 29.0323], [40.9861, 29.0349], [40.9839, 29.0353], [40.9836, 29.0326]] },
  {
    name: 'Moda Sahil Parkı',
    ring: [[40.9864, 29.0218], [40.9864, 29.0227], [40.983, 29.023], [40.9806, 29.0239], [40.9791, 29.025], [40.9787, 29.0264],
      [40.9781, 29.0264], [40.9783, 29.0247], [40.9795, 29.0235], [40.9812, 29.0227], [40.983, 29.0221], [40.985, 29.0219]],
  },
  {
    name: 'Kalamış Parkı',
    ring: [[40.9783, 29.0388], [40.9776, 29.0378], [40.9762, 29.0391], [40.9745, 29.0395], [40.9725, 29.0391], [40.9721, 29.0412],
      [40.9748, 29.0417], [40.977, 29.0406]],
  },
  {
    name: 'Fenerbahçe Parkı',
    ring: [[40.9694, 29.0373], [40.967, 29.0357], [40.9655, 29.0351], [40.9648, 29.0369], [40.9658, 29.0394], [40.9682, 29.0406],
      [40.9696, 29.0394]],
  },
  { name: 'Kuşdili Çayırı', ring: [[40.9962, 29.0298], [40.9963, 29.0338], [40.9936, 29.0344], [40.9934, 29.0304]] },
  { name: 'Haydarpaşa Korusu', ring: [[41.0035, 29.0175], [41.0045, 29.0225], [41.0005, 29.0235], [40.9995, 29.019]] },
  { name: 'Feneryolu Parkı', ring: [[40.9832, 29.0458], [40.9834, 29.0492], [40.9808, 29.0496], [40.9806, 29.0462]] },
];

export interface NamedRoad {
  name: string;
  major: boolean;
  line: readonly LL[];
}

/** Ana ve ikincil caddeler (çizim sırası: ikinciller altta). Kavşaklar demo sunucusunda geometriden bulunur. */
export const ROADS: readonly NamedRoad[] = [
  { name: 'Rıhtım Cd.', major: true, line: [[40.9985, 29.0205], [40.996, 29.0213], [40.994, 29.0224], [40.9928, 29.0232], [40.9915, 29.0242], [40.99, 29.024]] },
  {
    name: 'Söğütlüçeşme Cd.',
    major: true,
    line: [[40.9915, 29.0242], [40.991, 29.0265], [40.9905, 29.029], [40.99, 29.033], [40.9895, 29.037], [40.989, 29.042], [40.9885, 29.05], [40.9882, 29.06]],
  },
  { name: 'Kuşdili Cd.', major: true, line: [[40.9905, 29.029], [40.9925, 29.03], [40.995, 29.0315], [40.9985, 29.033], [41.003, 29.0348], [41.01, 29.037]] },
  {
    name: 'Bahariye Cd.',
    major: true,
    line: [[40.9905, 29.029], [40.9888, 29.0285], [40.9872, 29.0279], [40.9858, 29.0272], [40.98455, 29.0266], [40.9832, 29.0262], [40.9815, 29.0262]],
  },
  { name: 'Dr. Esat Işık Cd.', major: true, line: [[40.9815, 29.0262], [40.981, 29.029], [40.9808, 29.032]] },
  {
    name: 'Kalamış Fener Cd.',
    major: true,
    line: [[40.9808, 29.032], [40.9803, 29.035], [40.9797, 29.0378], [40.9784, 29.0398], [40.976, 29.0419], [40.973, 29.043], [40.97, 29.042], [40.968, 29.0403]],
  },
  {
    name: 'Bağdat Cd.',
    major: true,
    line: [[40.9808, 29.032], [40.9835, 29.0365], [40.9845, 29.0405], [40.9835, 29.045], [40.981, 29.05], [40.979, 29.055], [40.977, 29.062], [40.9755, 29.07], [40.975, 29.085]],
  },
  { name: 'Haydarpaşa Rıhtım Cd.', major: true, line: [[40.9985, 29.0205], [41.003, 29.0185], [41.012, 29.012], [41.03, 29.008]] },
  { name: 'D-100 Karayolu', major: true, line: [[41.003, 29.0348], [40.998, 29.045], [40.994, 29.055], [40.991, 29.07], [40.989, 29.09]] },
  // ikincil
  { name: 'Moda Cd.', major: false, line: [[40.9905, 29.0262], [40.9885, 29.0258], [40.986, 29.025], [40.9835, 29.0248], [40.9812, 29.025], [40.9793, 29.0256]] },
  { name: 'Mühürdar Cd.', major: false, line: [[40.99, 29.024], [40.988, 29.0232], [40.986, 29.023], [40.984, 29.0232]] },
  { name: 'General Asım Gündüz Cd.', major: false, line: [[40.9905, 29.029], [40.988, 29.032], [40.9865, 29.035], [40.9845, 29.0405]] },
  { name: 'Şair Nefi Sk.', major: false, line: [[40.9872, 29.0279], [40.9868, 29.031], [40.9862, 29.035], [40.9835, 29.0365]] },
  { name: 'Ferit Tek Sk.', major: false, line: [[40.9858, 29.0272], [40.9853, 29.023]] },
  { name: 'Leylek Sk.', major: false, line: [[40.9832, 29.0262], [40.9828, 29.0225]] },
  { name: 'Bademaltı Sk.', major: false, line: [[40.9888, 29.0285], [40.9885, 29.0232]] },
  { name: 'Moda Burnu Sk.', major: false, line: [[40.9815, 29.0262], [40.9797, 29.0236]] },
  { name: 'Münir Nurettin Selçuk Cd.', major: false, line: [[40.9845, 29.0405], [40.9815, 29.041], [40.9784, 29.0398]] },
];

export interface MapLabel {
  at: LL;
  text: string;
  kind: 'district' | 'water' | 'park';
}

export const LABELS: readonly MapLabel[] = [
  { at: [40.9945, 29.0262], text: 'KADIKÖY', kind: 'district' },
  { at: [40.9812, 29.0298], text: 'MODA', kind: 'district' },
  { at: [40.9758, 29.0452], text: 'KALAMIŞ', kind: 'district' },
  { at: [40.9665, 29.0438], text: 'FENERBAHÇE', kind: 'district' },
  { at: [40.9978, 29.0244], text: 'HAYDARPAŞA', kind: 'district' },
  { at: [40.9872, 29.0405], text: 'OSMANAĞA', kind: 'district' },
  { at: [40.9842, 29.0128], text: 'Marmara Denizi', kind: 'water' },
  { at: [40.9947, 29.016], text: 'Kadıköy Koyu', kind: 'water' },
  { at: [40.9829, 29.0339], text: 'Yoğurtçu', kind: 'park' },
];

/** Adres etiketindeki semt (en yakın merkez). [Varsayım] Mahalle sınırları kaba yaklaşımdır. */
export const NEIGHBOURHOODS: readonly { name: string; at: LL }[] = [
  { name: 'Moda', at: [40.9828, 29.0262] },
  { name: 'Caferağa', at: [40.9872, 29.0255] },
  { name: 'Osmanağa', at: [40.9925, 29.0295] },
  { name: 'Rasimpaşa', at: [40.9995, 29.0225] },
  { name: 'Kalamış', at: [40.9785, 29.038] },
  { name: 'Fenerbahçe', at: [40.9688, 29.0405] },
  { name: 'Koşuyolu', at: [41.005, 29.036] },
  { name: 'Feneryolu', at: [40.982, 29.048] },
];

/** Nokta çokgenin içinde mi (ışın atma; [enlem, boylam] düzleminde, bu ölçekte yeterli). */
export function insideRing(lat: number, lng: number, ring: readonly LL[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i] as LL;
    const [yj, xj] = ring[j] as LL;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Karada mı (deniz değil; iskeleler kara sayılır). */
export function onLand(lat: number, lng: number): boolean {
  return insideRing(lat, lng, LAND) || PIERS.some((p) => insideRing(lat, lng, p));
}
