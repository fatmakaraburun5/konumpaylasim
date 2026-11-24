/**
 * Demo sunucusunun "Google"ı (yalnızca web önizlemesi): Routes API `computeRoutes` ve Geocoding API (ters)
 * yanıtlarını önizleme haritasının caddeleri üzerinden ÜRETİR. Ağ isteği yok, anahtar yok.
 *
 * Yanıtlar Google'ın JSON biçimindedir ve backend'deki gibi core `parseRoutesResponse` /
 * `parseReverseGeocodeResponse` ile okunur; yani sözleşme (alan adları, "123s" süre biçimi, encoded polyline,
 * adres bileşenleri) gerçek akıştakiyle aynıdır, yalnızca değerler sahtedir:
 *
 *  - Rota: `mapGeometry.ROADS` çizgilerinden kavşakları bulunmuş bir yol ağı; başlangıç ve hedef en yakın
 *    caddeye bağlanır, Dijkstra ile en kısa SÜRELİ yol seçilir. Araç ana caddeleri tercih eder (ara sokaklar
 *    yavaş), yürüyüş en kısa mesafeyi alır. Süre = mesafe / mod hızı (+ araçta park, bisiklette kilit payı).
 *  - Adres: HÜCRE MERKEZİNE (core `geocodeQueryPoint`) en yakın cadde (≤ 90 m) + semt + "Kadıköy".
 *    Denizdeki nokta → ZERO_RESULTS (etiket yok). Parkın içindeki nokta → park adı.
 *
 * [Varsayım] Hızlar kaba şehir içi ortalamalardır; yalnızca ETA kartının davranışını göstermek içindir.
 */
import { encodePolyline, type LatLng, type TravelMode } from '@konum/core';
import { HOME, insideRing, NEIGHBOURHOODS, onLand, PARKS, ROADS, type LL } from '../web/mapGeometry';

// ── Yerel düzlem (metre) ─────────────────────────────────────────────────────────────────────────

interface XY {
  x: number;
  y: number;
}

const KY = 110_574;
const KX = 111_320 * Math.cos((HOME[0] * Math.PI) / 180);
const toXY = (lat: number, lng: number): XY => ({ x: (lng - HOME[1]) * KX, y: (lat - HOME[0]) * KY });
const toLL = (p: XY): LatLng => ({ lat: Math.round((HOME[0] + p.y / KY) * 1e6) / 1e6, lng: Math.round((HOME[1] + p.x / KX) * 1e6) / 1e6 });
const llXY = ([lat, lng]: LL): XY => toXY(lat, lng);
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/** Noktanın [a,b] doğru parçasına izdüşümü: parametre t (0..1) ve uzaklık. */
function project(p: XY, a: XY, b: XY): { t: number; d: number; at: XY } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  const at = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, d: dist(p, at), at };
}

// ── Yol ağı ──────────────────────────────────────────────────────────────────────────────────────

interface Seg {
  road: number;
  a: XY;
  b: XY;
}

interface Edge {
  to: number;
  len: number;
  /** ROADS dizini; -1 = bağlantı parçası (ikincil sayılır). */
  road: number;
}

interface Graph {
  nodes: XY[];
  adj: Edge[][];
  /** Rota başlangıç/hedefini bağlamak için düğümler arası kenarlar (tekrarsız). */
  edges: { u: number; v: number; road: number }[];
}

/** Kavşak sayılacak yakınlık: bir caddenin ucu başka caddeye bu kadar yakınsa birleşir. */
const END_SNAP_M = 60;
const MERGE_M = 4;

let graph: Graph | null = null;

function buildGraph(): Graph {
  const segs: Seg[] = [];
  ROADS.forEach((r, ri) => {
    for (let i = 1; i < r.line.length; i++) segs.push({ road: ri, a: llXY(r.line[i - 1] as LL), b: llXY(r.line[i] as LL) });
  });
  const splits: number[][] = segs.map(() => [0, 1]);
  const connectors: [XY, XY][] = [];

  // Kesişen parçalar: iki tarafa da bölme noktası.
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i] as Seg;
      const q = segs[j] as Seg;
      const rx = s.b.x - s.a.x;
      const ry = s.b.y - s.a.y;
      const qx = q.b.x - q.a.x;
      const qy = q.b.y - q.a.y;
      const denom = cross(rx, ry, qx, qy);
      if (Math.abs(denom) < 1e-9) continue;
      const t = cross(q.a.x - s.a.x, q.a.y - s.a.y, qx, qy) / denom;
      const u = cross(q.a.x - s.a.x, q.a.y - s.a.y, rx, ry) / denom;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) {
        (splits[i] as number[]).push(t);
        (splits[j] as number[]).push(u);
      }
    }
  }

  // Cadde uçları: başka bir caddeye yakınsa oraya bağlanır (çizimdeki küçük boşluklar).
  ROADS.forEach((r, ri) => {
    for (const end of [r.line[0], r.line[r.line.length - 1]] as LL[]) {
      const p = llXY(end);
      let best: { i: number; t: number; d: number; at: XY } | null = null;
      segs.forEach((s, i) => {
        if (s.road === ri) return;
        const pr = project(p, s.a, s.b);
        if (pr.d < END_SNAP_M && (!best || pr.d < best.d)) best = { i, ...pr };
      });
      const b = best as { i: number; t: number; d: number; at: XY } | null;
      if (!b || b.d < 0.5) continue;
      (splits[b.i] as number[]).push(b.t);
      connectors.push([p, b.at]);
    }
  });

  const nodes: XY[] = [];
  const nodeAt = (p: XY): number => {
    for (let i = 0; i < nodes.length; i++) if (dist(nodes[i] as XY, p) < MERGE_M) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const edges: Graph['edges'] = [];
  const seen = new Set<string>();
  const addEdge = (u: number, v: number, road: number) => {
    if (u === v) return;
    const k = u < v ? `${u}-${v}` : `${v}-${u}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ u, v, road });
  };

  segs.forEach((s, i) => {
    const ts = [...new Set(splits[i])].sort((x, y) => x - y);
    let prev: number | null = null;
    for (const t of ts) {
      const n = nodeAt({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
      if (prev !== null) addEdge(prev, n, s.road);
      prev = n;
    }
  });
  for (const [a, b] of connectors) addEdge(nodeAt(a), nodeAt(b), -1);

  const adj: Edge[][] = nodes.map(() => []);
  for (const e of edges) {
    const len = dist(nodes[e.u] as XY, nodes[e.v] as XY);
    (adj[e.u] as Edge[]).push({ to: e.v, len, road: e.road });
    (adj[e.v] as Edge[]).push({ to: e.u, len, road: e.road });
  }
  return { nodes, adj, edges };
}

function theGraph(): Graph {
  graph ??= buildGraph();
  return graph;
}

// ── Hız ve süre ──────────────────────────────────────────────────────────────────────────────────

const OFFROAD_MPS = 1.3;
/** [Varsayım] Şehir içi ortalama hızlar (m/sn). */
function speedMps(mode: TravelMode, road: number): number {
  const major = road >= 0 && (ROADS[road]?.major ?? false);
  if (mode === 'WALK') return 1.35;
  if (mode === 'BICYCLE') return major ? 4.6 : 4.1;
  return major ? 6.9 : 3.6;
}
/** Sabit pay: araçta park yeri / çıkış, bisiklette kilit. */
const OVERHEAD_S: Record<TravelMode, number> = { DRIVE: 60, WALK: 0, BICYCLE: 20 };

/** Rotanın caddeye bağlanacağı en uzak mesafe; daha uzaksa "rota bulunamadı". */
const MAX_SNAP_M = 600;

interface Snap {
  u: number;
  v: number;
  road: number;
  t: number;
  at: XY;
  d: number;
}

function snap(p: XY, g: Graph): Snap | null {
  let best: Snap | null = null;
  for (const e of g.edges) {
    const pr = project(p, g.nodes[e.u] as XY, g.nodes[e.v] as XY);
    if (!best || pr.d < best.d) best = { u: e.u, v: e.v, road: e.road, t: pr.t, at: pr.at, d: pr.d };
  }
  return best;
}

export interface FakeRoute {
  points: LatLng[];
  distance_m: number;
  duration_s: number;
}

/** İki nokta arası demo rotası (yol ağı üzerinde); bulunamazsa null. */
export function demoRoute(origin: LatLng, destination: LatLng, mode: TravelMode): FakeRoute | null {
  if (!onLand(origin.lat, origin.lng) || !onLand(destination.lat, destination.lng)) return null;
  const g = theGraph();
  const o = toXY(origin.lat, origin.lng);
  const d = toXY(destination.lat, destination.lng);
  const so = snap(o, g);
  const sd = snap(d, g);
  if (!so || !sd || so.d > MAX_SNAP_M || sd.d > MAX_SNAP_M) return null;

  // Sanal düğümler: S (başlangıcın caddedeki izdüşümü) = n, T = n+1.
  const n = g.nodes.length;
  const S = n;
  const T = n + 1;
  const nodes = [...g.nodes, so.at, sd.at];
  const extra = new Map<number, Edge[]>();
  const link = (a: number, b: number, len: number, road: number) => {
    (extra.get(a) ?? extra.set(a, []).get(a)!).push({ to: b, len, road });
    (extra.get(b) ?? extra.set(b, []).get(b)!).push({ to: a, len, road });
  };
  const nodeXY = (i: number) => nodes[i] as XY;
  link(S, so.u, dist(so.at, nodeXY(so.u)), so.road);
  link(S, so.v, dist(so.at, nodeXY(so.v)), so.road);
  link(T, sd.u, dist(sd.at, nodeXY(sd.u)), sd.road);
  link(T, sd.v, dist(sd.at, nodeXY(sd.v)), sd.road);
  const sameEdge = (so.u === sd.u && so.v === sd.v) || (so.u === sd.v && so.v === sd.u);
  if (sameEdge) link(S, T, dist(so.at, sd.at), so.road);

  // Dijkstra (süre ağırlıklı; düğüm sayısı küçük → doğrusal seçim yeterli).
  const total = n + 2;
  const cost = new Array<number>(total).fill(Infinity);
  const prev = new Array<number>(total).fill(-1);
  const prevRoad = new Array<number>(total).fill(-1);
  const done = new Array<boolean>(total).fill(false);
  cost[S] = 0;
  for (;;) {
    let best = -1;
    for (let i = 0; i < total; i++) if (!done[i] && cost[i]! < Infinity && (best < 0 || cost[i]! < cost[best]!)) best = i;
    if (best < 0 || best === T) break;
    done[best] = true;
    const out = [...(best < n ? (g.adj[best] as Edge[]) : []), ...(extra.get(best) ?? [])];
    for (const e of out) {
      const c = cost[best]! + e.len / speedMps(mode, e.road);
      if (c < cost[e.to]!) {
        cost[e.to] = c;
        prev[e.to] = best;
        prevRoad[e.to] = e.road;
      }
    }
  }
  if (cost[T] === Infinity) return null;

  const chain: number[] = [];
  for (let at = T; at >= 0; at = prev[at]!) chain.unshift(at);
  const pts: XY[] = [];
  const push = (p: XY) => {
    const last = pts[pts.length - 1];
    if (!last || dist(last, p) > 0.5) pts.push(p);
  };
  push(o);
  for (const i of chain) push(nodeXY(i));
  push(d);

  let meters = 0;
  let seconds = OVERHEAD_S[mode];
  // Uç bacaklar (cadde dışı) yürüme hızında.
  meters += so.d + sd.d;
  seconds += (so.d + sd.d) / OFFROAD_MPS;
  for (let k = 1; k < chain.length; k++) {
    const a = chain[k - 1] as number;
    const b = chain[k] as number;
    const len = dist(nodeXY(a), nodeXY(b));
    meters += len;
    seconds += len / speedMps(mode, prevRoad[b]!);
  }
  return { points: pts.map(toLL), distance_m: Math.round(meters), duration_s: Math.round(seconds) };
}

// ── Sahte Google uçları (yanıt biçimi Google ile aynı) ───────────────────────────────────────────

/** Routes API `computeRoutes` gövdesi (core `routesRequestBody`) → Google biçiminde yanıt. */
export function fakeComputeRoutes(body: Record<string, unknown>): { status: number; json: unknown } {
  const pt = (k: 'origin' | 'destination'): LatLng | null => {
    const v = (body[k] as { location?: { latLng?: { latitude?: unknown; longitude?: unknown } } } | undefined)?.location?.latLng;
    return typeof v?.latitude === 'number' && typeof v.longitude === 'number' ? { lat: v.latitude, lng: v.longitude } : null;
  };
  const o = pt('origin');
  const d = pt('destination');
  const mode = body.travelMode as TravelMode;
  if (!o || !d || !['DRIVE', 'WALK', 'BICYCLE'].includes(mode)) return { status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT' } } };
  const r = demoRoute(o, d, mode);
  // Google: rota yoksa boş nesne döner (200).
  if (!r) return { status: 200, json: {} };
  return {
    status: 200,
    json: { routes: [{ distanceMeters: r.distance_m, duration: `${r.duration_s}s`, polyline: { encodedPolyline: encodePolyline(r.points) } }] },
  };
}

/** Geocoding API (ters) → Google biçiminde yanıt. `p` hücre merkezidir (tam konum değil). */
export function fakeReverseGeocode(p: LatLng): unknown {
  if (!onLand(p.lat, p.lng)) return { status: 'ZERO_RESULTS', results: [] };
  const xy = toXY(p.lat, p.lng);
  const park = PARKS.find((a) => insideRing(p.lat, p.lng, a.ring));
  let street: string | null = null;
  let best = 90;
  for (const r of ROADS) {
    for (let i = 1; i < r.line.length; i++) {
      const pr = project(xy, llXY(r.line[i - 1] as LL), llXY(r.line[i] as LL));
      if (pr.d < best) {
        best = pr.d;
        street = r.name;
      }
    }
  }
  let hood = NEIGHBOURHOODS[0]!.name;
  let hoodD = Infinity;
  for (const h of NEIGHBOURHOODS) {
    const dd = dist(xy, llXY(h.at));
    if (dd < hoodD) {
      hoodD = dd;
      hood = h.name;
    }
  }
  const components: { long_name: string; types: string[] }[] = [];
  if (street && !park) components.push({ long_name: street, types: ['route'] });
  components.push({ long_name: park?.name ?? hood, types: park ? ['park', 'neighborhood'] : ['neighborhood', 'political'] });
  components.push({ long_name: 'Kadıköy', types: ['administrative_area_level_2', 'political'] });
  components.push({ long_name: 'İstanbul', types: ['administrative_area_level_1', 'political'] });
  components.push({ long_name: 'Türkiye', types: ['country', 'political'] });
  const formatted = [park?.name ?? hood, street, 'Kadıköy/İstanbul', 'Türkiye'].filter(Boolean).join(', ');
  return { status: 'OK', results: [{ formatted_address: formatted, address_components: components }] };
}
