/**
 * Demo dünyası: İstanbul Kadıköy / Moda çevresi (yaklaşık 2 km içinde).
 *
 * Buradaki her şey KURGUDUR: kişiler, davet kodları ve konumlar yalnızca tarayıcı önizlemesi içindir.
 * Harita çizimi (deniz, parklar, yollar, etiketler) gerçek coğrafyanın kaba bir taslağıdır; navigasyon
 * için değil, uygulama arayüzünü göstermek için çizilmiştir.
 */
import { haversineM, type LatLng } from '@konum/core';

export const DEMO_ME = 'deniz';
export const DEMO_ME_NAME = 'Deniz Kaya';
export const DEMO_ME_INVITE = 'LOC-7KQ2MX';
export const DEMO_OTP = '123456';

export interface DemoPerson {
  uid: string;
  name: string;
  invite: string;
}

export const PEOPLE = {
  ayse: { uid: 'ayse', name: 'Ayşe Yılmaz', invite: 'LOC-A7S3YN' },
  mehmet: { uid: 'mehmet', name: 'Mehmet Demir', invite: 'LOC-M3HM7D' },
  zeynep: { uid: 'zeynep', name: 'Zeynep Arslan', invite: 'LOC-Z3YN4P' },
  can: { uid: 'can', name: 'Can Öztürk', invite: 'LOC-C4N5TK' },
  elif: { uid: 'elif', name: 'Elif Şahin', invite: 'LOC-E2FS4H' },
} as const satisfies Record<string, DemoPerson>;

/** Davet koduyla eklenen yeni (sanal) arkadaşlar ve "Arkadaşlık isteği gelsin" için isim havuzu. */
export const NAME_POOL = [
  'Burak Koç',
  'Selin Aydın',
  'Emre Çelik',
  'Ece Kurt',
  'Kerem Aksoy',
  'Defne Polat',
  'Mert Yıldız',
  'Naz Erdem',
  'Oğuz Şen',
  'İrem Doğan',
] as const;

// --- yerler ----------------------------------------------------------------------------------

export const PLACES = {
  kadikoyIskele: { lat: 40.9926, lng: 29.023 },
  altiyol: { lat: 40.9905, lng: 29.029 },
  rihtim: { lat: 40.9918, lng: 29.0242 },
  yogurtcu: { lat: 40.9849, lng: 29.0338 },
  modaParki: { lat: 40.9818, lng: 29.0258 },
} as const;

/** İlk görünüm: Moda Caddesi civarı. */
export const MAP_HOME: LatLng = { lat: 40.9862, lng: 29.0275 };

/** Benim yürüyüşüm: Moda Caddesi → Moda Parkı → sahil → geri (kapalı döngü). */
export const MY_LOOP: readonly LatLng[] = [
  { lat: 40.98555, lng: 29.02605 },
  { lat: 40.9838, lng: 29.0264 },
  { lat: 40.9822, lng: 29.02595 },
  { lat: 40.98175, lng: 29.0247 },
  { lat: 40.9822, lng: 29.0236 },
  { lat: 40.9839, lng: 29.0232 },
  { lat: 40.98545, lng: 29.0236 },
  { lat: 40.9858, lng: 29.0249 },
];

/** Ayşe: Bahariye Caddesi boyunca Altıyol'a gidip gelir. */
export const AYSE_PATH: readonly LatLng[] = [
  { lat: 40.98455, lng: 29.0266 },
  { lat: 40.9858, lng: 29.0272 },
  { lat: 40.9872, lng: 29.0279 },
  { lat: 40.9888, lng: 29.0285 },
  { lat: 40.99025, lng: 29.0289 },
];

/**
 * Faz 3 "Araca bin": Moda Cd. → Söğütlüçeşme → Altıyol → Kuşdili → Dr. Esat Işık → Moda Cd. (kapalı döngü, ~2,4 km).
 * Moda Cd. parçası yürüyüş döngüsüne (MY_LOOP) yakındır: araca binerken konum sıçramaz.
 */
export const DRIVE_LOOP: readonly LatLng[] = [
  { lat: 40.9839, lng: 29.0263 },
  { lat: 40.986, lng: 29.0262 },
  { lat: 40.9885, lng: 29.026 },
  { lat: 40.9908, lng: 29.0258 },
  { lat: 40.9918, lng: 29.0246 },
  { lat: 40.9911, lng: 29.0268 },
  { lat: 40.9905, lng: 29.029 },
  { lat: 40.9896, lng: 29.0302 },
  { lat: 40.988, lng: 29.0315 },
  { lat: 40.9861, lng: 29.0322 },
  { lat: 40.9845, lng: 29.0328 },
  { lat: 40.9843, lng: 29.0327 },
  { lat: 40.9842, lng: 29.0312 },
  { lat: 40.984, lng: 29.029 },
];

export const MEHMET_SPOT: LatLng = { lat: 40.99165, lng: 29.0247 };
export const ZEYNEP_SPOT: LatLng = { lat: 40.98505, lng: 29.03345 };
/** Davetle eklenen yeni arkadaşların paylaşım yaptığında görüneceği yerler. */
export const EXTRA_SPOTS: readonly LatLng[] = [
  { lat: 40.9897, lng: 29.0318 },
  { lat: 40.98, lng: 29.0372 },
  { lat: 40.9884, lng: 29.0236 },
  { lat: 40.9832, lng: 29.0302 },
];

// --- yol üzerinde konum (deterministik) ------------------------------------------------------

function segLengths(path: readonly LatLng[], closed: boolean): number[] {
  const out: number[] = [];
  const n = closed ? path.length : path.length - 1;
  for (let i = 0; i < n; i++) out.push(haversineM(path[i] as LatLng, path[(i + 1) % path.length] as LatLng));
  return out;
}

export interface PathPoint extends LatLng {
  /** Gerçek kuzeye göre derece. */
  heading: number;
}

/**
 * `meters` kadar yol alınmış noktayı verir. Kapalı döngüde başa sarar; açık yolda git-gel yapar.
 */
export function pointAlong(path: readonly LatLng[], meters: number, closed: boolean): PathPoint {
  const lens = segLengths(path, closed);
  const total = lens.reduce((a, b) => a + b, 0);
  let d: number;
  let reverse = false;
  if (closed) d = ((meters % total) + total) % total;
  else {
    const cycle = ((meters % (2 * total)) + 2 * total) % (2 * total);
    reverse = cycle > total;
    d = reverse ? 2 * total - cycle : cycle;
  }
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i] as number;
    if (d <= len || i === lens.length - 1) {
      const a = path[i] as LatLng;
      const b = path[(i + 1) % path.length] as LatLng;
      const t = len === 0 ? 0 : Math.min(1, d / len);
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      const from = reverse ? b : a;
      const to = reverse ? a : b;
      return { lat, lng, heading: bearing(from, to) };
    }
    d -= len;
  }
  const last = path[0] as LatLng;
  return { ...last, heading: 0 };
}

/**
 * Yol üzerinde `p`'ye en yakın noktanın baştan uzaklığı (metre). Kip değişince (yürü ↔ araç) konum sıçramasın diye
 * yeni yol bu noktadan devam ettirilir. Küçük alan: yerel düzlem izdüşümü yeterli.
 */
export function nearestMetersOnPath(path: readonly LatLng[], p: LatLng, closed: boolean): number {
  const lens = segLengths(path, closed);
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 111_320;
  let best = Infinity;
  let bestM = 0;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    const a = path[i] as LatLng;
    const b = path[(i + 1) % path.length] as LatLng;
    const ax = (a.lng - p.lng) * kx;
    const ay = (a.lat - p.lat) * ky;
    const bx = (b.lng - p.lng) * kx;
    const by = (b.lat - p.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const d = Math.hypot(cx, cy);
    if (d < best) {
      best = d;
      bestM = acc + (lens[i] as number) * t;
    }
    acc += lens[i] as number;
  }
  return bestM;
}

function bearing(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
  const x =
    Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
  const deg = (Math.atan2(y, x) / toRad + 360) % 360;
  return Math.round(deg * 10) / 10 === 360 ? 0 : Math.round(deg * 10) / 10;
}

/** Küçük, deterministik GPS titremesi (metre cinsinden ±). */
export function jitter(seed: number, meters: number): LatLng {
  const s1 = Math.sin(seed * 12.9898) * 43758.5453;
  const s2 = Math.sin(seed * 78.233) * 12345.6789;
  const fx = (s1 - Math.floor(s1) - 0.5) * 2;
  const fy = (s2 - Math.floor(s2) - 0.5) * 2;
  return { lat: (fy * meters) / 111_320, lng: (fx * meters) / (111_320 * Math.cos((41 * Math.PI) / 180)) };
}

// --- harita çizimi ---------------------------------------------------------------------------

export type MapFeature =
  | { kind: 'sea'; ring: readonly LatLng[] }
  | { kind: 'park'; ring: readonly LatLng[]; name?: string }
  | { kind: 'road'; line: readonly LatLng[]; major: boolean; name?: string }
  | { kind: 'path'; line: readonly LatLng[] }
  | { kind: 'pier'; line: readonly LatLng[] };

const P = (lat: number, lng: number): LatLng => ({ lat, lng });

export const MAP_FEATURES: readonly MapFeature[] = [
  {
    kind: 'sea',
    ring: [
      P(41.02, 28.96),
      P(41.02, 29.0165),
      P(40.9985, 29.0175),
      P(40.9968, 29.0188),
      P(40.995, 29.0205),
      P(40.9935, 29.0218),
      P(40.9926, 29.0224),
      P(40.9906, 29.0218),
      P(40.988, 29.0211),
      P(40.9856, 29.0206),
      P(40.9832, 29.021),
      P(40.981, 29.022),
      P(40.9792, 29.0232),
      P(40.9782, 29.0246),
      P(40.9781, 29.0262),
      P(40.9789, 29.0281),
      P(40.98, 29.0298),
      P(40.9808, 29.0318),
      P(40.9812, 29.0336),
      P(40.9806, 29.0354),
      P(40.9794, 29.0372),
      P(40.9781, 29.0388),
      P(40.9764, 29.0402),
      P(40.9742, 29.0414),
      P(40.9712, 29.0424),
      P(40.95, 29.045),
      P(40.95, 28.96),
    ],
  },
  {
    kind: 'park',
    name: 'Moda Sahil Parkı',
    ring: [P(40.9848, 29.0208), P(40.9848, 29.0221), P(40.983, 29.0225), P(40.9812, 29.0234), P(40.9798, 29.0246), P(40.9794, 29.0262), P(40.9786, 29.0262), P(40.9787, 29.0247), P(40.9796, 29.0234), P(40.9812, 29.0222), P(40.9832, 29.0212)],
  },
  { kind: 'park', name: 'Yoğurtçu Parkı', ring: [P(40.9861, 29.0323), P(40.986, 29.0349), P(40.9839, 29.0353), P(40.9837, 29.0327)] },
  { kind: 'park', name: 'Moda Parkı', ring: [P(40.9823, 29.0251), P(40.9822, 29.0266), P(40.9813, 29.0266), P(40.9814, 29.0251)] },
  { kind: 'park', name: 'Kalamış Parkı', ring: [P(40.9812, 29.0352), P(40.9802, 29.0373), P(40.979, 29.0386), P(40.9786, 29.0379), P(40.9798, 29.0362), P(40.9806, 29.0349)] },
  { kind: 'pier', line: [P(40.9927, 29.0226), P(40.9934, 29.0212)] },
  { kind: 'pier', line: [P(40.9912, 29.0219), P(40.9917, 29.0204)] },
  // ara sokaklar
  { kind: 'road', major: false, line: [P(40.9895, 29.0233), P(40.9893, 29.026), P(40.9889, 29.0285)] },
  { kind: 'road', major: false, line: [P(40.9871, 29.0228), P(40.9872, 29.0261), P(40.9872, 29.0279)] },
  { kind: 'road', major: false, line: [P(40.9855, 29.0225), P(40.9858, 29.0262), P(40.9858, 29.0272), P(40.9861, 29.0322)] },
  { kind: 'road', major: false, line: [P(40.9838, 29.0221), P(40.9839, 29.0263)] },
  { kind: 'road', major: false, line: [P(40.982, 29.0262), P(40.9816, 29.029), P(40.9811, 29.0312)] },
  { kind: 'road', major: false, line: [P(40.9875, 29.0281), P(40.9874, 29.031), P(40.9871, 29.0345)] },
  { kind: 'road', major: false, line: [P(40.9895, 29.0233), P(40.9871, 29.0228), P(40.9855, 29.0225), P(40.9838, 29.0221)] },
  { kind: 'road', major: false, line: [P(40.9918, 29.0262), P(40.9908, 29.0258)] },
  { kind: 'road', major: false, line: [P(40.9925, 29.03), P(40.991, 29.0312), P(40.9898, 29.0335)] },
  { kind: 'road', major: false, line: [P(40.9855, 29.0295), P(40.9865, 29.0312)] },
  // ana caddeler
  { kind: 'road', major: true, name: 'Rıhtım Cd.', line: [P(40.9962, 29.0208), P(40.9945, 29.0222), P(40.9932, 29.0232), P(40.9918, 29.0246)] },
  { kind: 'road', major: true, name: 'Söğütlüçeşme Cd.', line: [P(40.9918, 29.0246), P(40.9911, 29.0268), P(40.9905, 29.029), P(40.9901, 29.0328), P(40.9896, 29.0372)] },
  { kind: 'road', major: true, name: 'Bahariye Cd.', line: [P(40.9905, 29.029), P(40.9888, 29.0285), P(40.9872, 29.0279), P(40.9858, 29.0272), P(40.9845, 29.0266)] },
  { kind: 'road', major: true, name: 'Moda Cd.', line: [P(40.9908, 29.0258), P(40.9885, 29.026), P(40.986, 29.0262), P(40.9839, 29.0263), P(40.982, 29.0262), P(40.9806, 29.0256)] },
  { kind: 'road', major: true, name: 'Mühürdar Cd.', line: [P(40.9918, 29.0246), P(40.9906, 29.0236), P(40.9895, 29.0233)] },
  { kind: 'road', major: true, name: 'Kuşdili Cd.', line: [P(40.9905, 29.029), P(40.9896, 29.0302), P(40.988, 29.0315), P(40.9861, 29.0322), P(40.9845, 29.0328)] },
  { kind: 'road', major: true, name: 'Dr. Esat Işık Cd.', line: [P(40.9839, 29.0263), P(40.984, 29.029), P(40.9842, 29.0312), P(40.9843, 29.0327)] },
  { kind: 'road', major: true, name: 'Kalamış Fener Cd.', line: [P(40.9843, 29.0327), P(40.9826, 29.0342), P(40.9812, 29.0356), P(40.98, 29.0373), P(40.9786, 29.039), P(40.9768, 29.0405)] },
  { kind: 'road', major: true, name: 'Moda Cd.', line: [P(40.9845, 29.0266), P(40.9839, 29.0263)] },
  // sahil yürüyüş yolu
  { kind: 'path', line: [P(40.9905, 29.0222), P(40.988, 29.0215), P(40.9852, 29.0211), P(40.983, 29.0217), P(40.9809, 29.0228), P(40.9792, 29.0242), P(40.9787, 29.0262), P(40.9795, 29.0284), P(40.9807, 29.0306), P(40.9811, 29.0332)] },
];

export interface MapLabel {
  at: LatLng;
  text: string;
  kind: 'district' | 'water' | 'place';
  /** Bu yakınlaştırmadan itibaren görünür. */
  minZoom: number;
}

export const MAP_LABELS: readonly MapLabel[] = [
  { at: P(40.9918, 29.0285), text: 'Kadıköy', kind: 'district', minZoom: 13 },
  { at: P(40.9829, 29.0243), text: 'Moda', kind: 'district', minZoom: 13 },
  { at: P(40.9878, 29.0246), text: 'Caferağa', kind: 'district', minZoom: 14.5 },
  { at: P(40.9935, 29.0315), text: 'Osmanağa', kind: 'district', minZoom: 14.5 },
  { at: P(40.9825, 29.0395), text: 'Kalamış', kind: 'district', minZoom: 14 },
  { at: P(40.9853, 29.0165), text: 'Marmara Denizi', kind: 'water', minZoom: 13 },
  { at: P(40.9778, 29.0322), text: 'Moda Koyu', kind: 'water', minZoom: 14.5 },
  { at: P(40.9936, 29.0196), text: 'Kadıköy İskelesi', kind: 'place', minZoom: 15 },
  { at: P(40.9849, 29.0338), text: 'Yoğurtçu Parkı', kind: 'place', minZoom: 15.5 },
  { at: P(40.9779, 29.0236), text: 'Moda Burnu', kind: 'place', minZoom: 15 },
  { at: P(40.9887, 29.0291), text: 'Süreyya Operası', kind: 'place', minZoom: 16 },
];
