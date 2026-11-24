/**
 * Web demo · Faz 5: bölge senaryoları ("Evden çık", "Eve var", "GPS sapması") ve filtre kararlarının panele
 * aktarılması. `zoneMonitor.web.ts` yüklenince kancalarını buraya kaydeder; panel (Faz5.web.tsx) bu modülü kullanır.
 *
 * [Demo kısaltması] Yürüyüş ~70 sn sürer: örnekler GERİYE TARİHLİ olarak tek seferde filtreye oynatılır (Faz 3'teki
 * etkinlik olayı kısaltmasıyla aynı fikir), telefon varış noktasına konur. Filtre kuralları (doğruluk kapısı, gri bant,
 * 2 güvenli örnek ≥ 20 sn, ters geçiş için 3 dk, ışınlanma reddi) DEĞİŞMEZ; ör. ayrılıştan 3 dk geçmeden "Eve var"
 * `min_stay` ile bekler ve süre dolunca gerçek örnekle onaylanır.
 */
import { ZONE_FILTER, type LatLng, type ZoneFilterInput, type ZoneFilterState } from '@konum/core';
import type { ZoneDecision } from '../../services/location/zoneMonitorCore';
import { placeDemoPhone } from './device';

export interface DemoZoneHooks {
  replay: (zoneId: string, inputs: readonly ZoneFilterInput[]) => Promise<void>;
  decisions: () => ZoneDecision[];
  onDecision: (l: (d: ZoneDecision) => void) => () => void;
  states: () => Readonly<Record<string, ZoneFilterState>>;
}

let hooks: DemoZoneHooks | null = null;
const readyListeners = new Set<() => void>();

export function registerDemoZoneHooks(h: DemoZoneHooks): void {
  hooks = h;
  for (const l of [...readyListeners]) l();
}

export function demoZoneDecisions(): ZoneDecision[] {
  return hooks?.decisions() ?? [];
}

export function demoZoneState(zoneId: string): ZoneFilterState | null {
  return hooks?.states()[zoneId] ?? null;
}

/** Karar dinleyicisi (kancalar sonradan kaydedilse de bağlanır). */
export function onDemoZoneDecision(l: (d: ZoneDecision) => void): () => void {
  let un: (() => void) | null = hooks ? hooks.onDecision(l) : null;
  const ready = () => {
    un?.();
    un = hooks ? hooks.onDecision(l) : null;
  };
  readyListeners.add(ready);
  return () => {
    readyListeners.delete(ready);
    un?.();
  };
}

export interface DemoZone {
  zone_id: string;
  center: LatLng;
  radius_m: number;
}

/** Merkezden doğuya `m` metre (demo yolu). */
function east(c: LatLng, m: number): LatLng {
  return { lat: c.lat, lng: c.lng + m / (111_320 * Math.cos((c.lat * Math.PI) / 180)) };
}

const exitBuffer = (r: number) => Math.max(ZONE_FILTER.minExitBufferM, r * ZONE_FILTER.exitBufferRatio);
/** "Dışarıdaki" bekleme noktası: dışarı eşiğinin 300 m ötesi. */
const outsidePoint = (z: DemoZone) => east(z.center, z.radius_m + exitBuffer(z.radius_m) + 300);

/** Geriye tarihli yol örnekleri; `osAfter` indeksinden sonra OS bölge olayı. */
function timeline(z: DemoZone, distances: readonly number[], osAfter: number, os: 'enter' | 'exit', now: number): ZoneFilterInput[] {
  const end = now - 1_000;
  const start = now - 70_000;
  const step = (end - start) / (distances.length - 1);
  const out: ZoneFilterInput[] = [];
  distances.forEach((d, i) => {
    const p = east(z.center, d);
    const at = Math.round(start + i * step);
    out.push({ type: 'sample', sample: { lat: p.lat, lng: p.lng, accuracy: 8, at } });
    if (i === osAfter) out.push({ type: 'os_event', event: os, at: at + Math.round(step / 2) });
  });
  return out;
}

/** "Evden çık": bölge içinden dışarıya ~70 sn'lik yürüyüş → ayrılış onaylanır (2 güvenli dış örnek ≥ 20 sn). */
export async function demoZoneLeave(z: DemoZone): Promise<boolean> {
  if (!hooks) return false;
  const r = z.radius_m;
  const b = exitBuffer(r);
  const now = Date.now();
  const inputs = timeline(z, [0.1 * r, 0.5 * r, r + b / 2, r + b + 40, r + b + 150, r + b + 300], 2, 'exit', now);
  placeDemoPhone(outsidePoint(z), now);
  await hooks.replay(z.zone_id, inputs);
  return true;
}

/** "Eve var": dışarıdan merkeze yürüyüş → varış onaylanır (ayrılıştan 3 dk geçmediyse `min_stay` ile bekler). */
export async function demoZoneArrive(z: DemoZone): Promise<boolean> {
  if (!hooks) return false;
  const r = z.radius_m;
  const b = exitBuffer(r);
  const now = Date.now();
  const inputs = timeline(z, [r + b + 300, r + b + 100, r + b / 4, 0.6 * r, 0.3 * r, 0.05 * r], 1, 'enter', now);
  placeDemoPhone(z.center, now);
  await hooks.replay(z.zone_id, inputs);
  return true;
}

/**
 * "GPS sapması (tek sıçrama)": telefon yerinde; önce doğruluğu kötü (±400 m) bir örnek, sonra OS'un sahte "çıktı"
 * olayı ve 1,5 km uzağa tek sıçrama. Beklenen: `low_accuracy` → `os_candidate` → `teleport`; sonraki gerçek örnek
 * adayı düşürür (`no_change`). Tetik YOK.
 */
export async function demoZoneGlitch(z: DemoZone): Promise<boolean> {
  if (!hooks) return false;
  const now = Date.now();
  const far = east(z.center, z.radius_m + 1_500);
  const nearOut = east(z.center, z.radius_m + 120);
  await hooks.replay(z.zone_id, [
    { type: 'sample', sample: { lat: nearOut.lat, lng: nearOut.lng, accuracy: 400, at: now } },
    { type: 'os_event', event: 'exit', at: now },
    { type: 'sample', sample: { lat: far.lat, lng: far.lng, accuracy: 30, at: now } },
  ]);
  return true;
}
