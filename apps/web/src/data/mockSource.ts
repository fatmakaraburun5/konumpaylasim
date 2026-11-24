/**
 * Bellekteki sahte veri kaynağı: YALNIZCA `--mode mock` derlemesinde pakete girer (Playwright testi
 * ve tasarım önizlemesi). Üretim derlemesinde `loadSource` bu dosyayı hiç içe aktarmaz.
 *
 * Testler `window.__konumMock` üzerinden sürer: emit / remove / deny / fail / setConnected.
 * `?senaryo=canli|bekliyor|bitti|gecersiz|cevrimdisi` (yalnızca mock) elle önizleme içindir.
 * Faz 3: `?senaryo=gecikiyor|kopuk|dusukpil|esitlendi` (hb'ye göre gecikme / bağlantı kopması, %14 pil,
 * kuyruktan `q: 1` paket).
 */
import { MINUTE, type EpochMs } from '@konum/core';
import type { LinkLiveHandlers, LinkLiveSource } from './source';

export type MockScenario =
  | 'manual'
  | 'live'
  | 'waiting'
  | 'ended'
  | 'denied'
  | 'offline'
  | 'delayed'
  | 'suspected'
  | 'low_battery'
  | 'synced';

export interface MockPacketOptions {
  lat?: number;
  lng?: number;
  timestamp?: EpochMs;
  expires_at?: EpochMs | null;
  sender_name?: string;
  accuracy?: number;
  battery_pct?: number | null;
  share_mode?: string;
  /** Faz 3: sunucuya ulaşma anı (verilmezse `timestamp`). */
  server_ts?: EpochMs;
  /** Faz 3: gönderenin kalp atışı (ms). */
  hb?: number | null;
  /** Faz 3: kuyruktan gelen nokta. */
  q?: 1 | null;
}

export interface MockControl {
  ready: true;
  /** Abone olunan özet (test token'ın değil özetin kullanıldığını doğrular). */
  subscribedHash: string | null;
  emit(raw: unknown): void;
  emitLive(opts?: MockPacketOptions): Record<string, unknown>;
  remove(): void;
  deny(): void;
  fail(): void;
  setConnected(connected: boolean): void;
  setServerOffset(ms: number): void;
  walk(stepMs?: number): void;
  stopWalk(): void;
}

declare global {
  interface Window {
    __konumMock?: MockControl;
  }
}

/** Moda sahili boyunca kısa bir yürüyüş [örnek veri]. */
const WALK: ReadonlyArray<[number, number]> = [
  [40.98712, 29.02561],
  [40.98689, 29.02634],
  [40.98661, 29.02702],
  [40.98628, 29.02759],
  [40.98589, 29.02803],
  [40.98545, 29.02839],
  [40.98502, 29.02881],
  [40.98471, 29.02940],
  [40.98452, 29.03009],
  [40.98441, 29.03083],
];

export function mockPacket(now: EpochMs, o: MockPacketOptions = {}): Record<string, unknown> {
  const p: Record<string, unknown> = {
    v: 1,
    lat: o.lat ?? (WALK[0] as [number, number])[0],
    lng: o.lng ?? (WALK[0] as [number, number])[1],
    accuracy: o.accuracy ?? 12,
    heading: 118,
    speed_mps: 1.3,
    timestamp: o.timestamp ?? now,
    server_ts: o.server_ts ?? o.timestamp ?? now,
    sender_name: o.sender_name ?? 'Ayşe Yılmaz',
    share_mode: o.share_mode ?? 'timed',
  };
  const battery = o.battery_pct === undefined ? 64 : o.battery_pct;
  if (battery !== null) p.battery_pct = battery;
  const exp = o.expires_at === undefined ? now + 42 * MINUTE : o.expires_at;
  if (exp !== null) p.expires_at = exp;
  if (typeof o.hb === 'number') p.hb = o.hb;
  if (o.q === 1) p.q = 1;
  return p;
}

export function createMockSource(scenario: MockScenario = 'manual'): LinkLiveSource {
  let handlers: LinkLiveHandlers | null = null;
  const connectionCbs = new Set<(c: boolean) => void>();
  const offsetCbs = new Set<(ms: number) => void>();
  let connected = false;
  let offset = 0;
  let walkTimer: ReturnType<typeof setInterval> | null = null;
  let walkIndex = 0;
  let last: Record<string, unknown> | null = null;

  const control: MockControl = {
    ready: true,
    subscribedHash: null,
    emit(raw) {
      last = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      handlers?.value(raw);
    },
    emitLive(opts) {
      const p = mockPacket(Date.now() + offset, { ...pickFromLast(last), ...opts });
      control.emit(p);
      return p;
    },
    remove() {
      control.stopWalk();
      control.emit(null);
    },
    deny() {
      control.stopWalk();
      handlers?.denied();
      handlers = null;
    },
    fail() {
      control.stopWalk();
      handlers?.failed();
      handlers = null;
    },
    setConnected(c) {
      connected = c;
      connectionCbs.forEach((cb) => cb(c));
    },
    setServerOffset(ms) {
      offset = ms;
      offsetCbs.forEach((cb) => cb(ms));
    },
    walk(stepMs = 3000) {
      control.stopWalk();
      walkTimer = setInterval(() => {
        walkIndex = (walkIndex + 1) % WALK.length;
        const [lat, lng] = WALK[walkIndex] as [number, number];
        control.emitLive({ lat, lng });
      }, stepMs);
    },
    stopWalk() {
      if (walkTimer) clearInterval(walkTimer);
      walkTimer = null;
    },
  };
  window.__konumMock = control;

  let started = false;
  const runScenario = () => {
    if (started || scenario === 'manual') return;
    started = true; // React StrictMode (geliştirme) aboneliği iki kez kurar: senaryo bir kez oynar
    if (scenario === 'offline') return; // hiç bağlanmaz: zaman aşımı "çevrimdışı" gösterir
    control.setConnected(true);
    if (scenario === 'denied') return control.deny();
    if (scenario === 'waiting') return control.emit(null);
    const now = Date.now();
    // Faz 3 önizlemeleri (araçtaki gönderen: hb 2 dk).
    if (scenario === 'delayed') return void control.emitLive({ hb: 2 * MINUTE, timestamp: now - 6 * MINUTE });
    if (scenario === 'suspected') return void control.emitLive({ hb: 2 * MINUTE, timestamp: now - 14 * MINUTE });
    if (scenario === 'low_battery') return void control.emitLive({ hb: 2 * MINUTE, battery_pct: 14 });
    if (scenario === 'synced') {
      control.emitLive({ hb: 2 * MINUTE, timestamp: now - 14 * MINUTE });
      return void control.emitLive({ hb: 2 * MINUTE, q: 1, timestamp: now - 3 * MINUTE, server_ts: now });
    }
    control.emitLive();
    if (scenario === 'live') control.walk();
    if (scenario === 'ended') setTimeout(() => control.remove(), 1500);
  };

  return {
    subscribe(tokenHash, h) {
      handlers = h;
      control.subscribedHash = tokenHash;
      setTimeout(runScenario, 0);
      return () => {
        control.stopWalk();
        if (handlers === h) handlers = null;
      };
    },
    onConnection(cb) {
      connectionCbs.add(cb);
      cb(connected);
      return () => connectionCbs.delete(cb);
    },
    onServerTimeOffset(cb) {
      offsetCbs.add(cb);
      cb(offset);
      return () => offsetCbs.delete(cb);
    },
  };
}

function pickFromLast(last: Record<string, unknown> | null): MockPacketOptions {
  if (!last) return {};
  const o: MockPacketOptions = {};
  if (typeof last.lat === 'number') o.lat = last.lat;
  if (typeof last.lng === 'number') o.lng = last.lng;
  if (typeof last.expires_at === 'number') o.expires_at = last.expires_at;
  if (typeof last.sender_name === 'string') o.sender_name = last.sender_name;
  if (typeof last.hb === 'number') o.hb = last.hb;
  if (typeof last.battery_pct === 'number') o.battery_pct = last.battery_pct;
  return o;
}

const SCENARIO_ALIASES: Record<string, MockScenario> = {
  canli: 'live',
  live: 'live',
  bekliyor: 'waiting',
  waiting: 'waiting',
  bitti: 'ended',
  ended: 'ended',
  gecersiz: 'denied',
  denied: 'denied',
  cevrimdisi: 'offline',
  offline: 'offline',
  gecikiyor: 'delayed',
  kopuk: 'suspected',
  dusukpil: 'low_battery',
  esitlendi: 'synced',
};

export function scenarioFromSearch(search: string): MockScenario {
  const m = /[?&]senaryo=([a-z]+)/.exec(search);
  return (m && SCENARIO_ALIASES[m[1] as string]) || 'manual';
}
