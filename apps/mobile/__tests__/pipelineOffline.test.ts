/**
 * Faz 3 konum hattı: tünel / internet kesintisi (kalıcı kuyruk → bağlantı gelince taze yayından ÖNCE boşaltma),
 * paketteki `hb`, %15 pil düşüşünde tek bildirim (çevrimdışıysa kuyruğa, aynı op_id ile sonradan), "Durdur".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HOUR, MINUTE, type DeliveredLocationWrite, type PublishTarget, type RawLocationSample } from '@konum/core';
import type { PublisherDeps } from '../src/services/firebase/publisher';
import { createAdaptiveController, type AdaptiveStorage } from '../src/services/location/adaptive/adaptiveController';
import { initialSnapshot, type AdaptiveSnapshot } from '../src/services/location/adaptive/adaptiveCore';
import { createSamplePipeline, sessionKeysOf, type PipelineDeps } from '../src/services/location/pipeline';
import { createOutboxRepo } from '../src/services/outbox/outboxRepo';
import { asyncStorageOutboxStore, type PendingCall } from '../src/services/outbox/outboxStore';
import { loadCursor, saveTargets, type PersistedTarget } from '../src/state/persist';
import { __resetStopIntentsMemoryForTests, hydrateStopIntents, isShareBlocked } from '../src/state/stopIntents';

const NOW = Date.UTC(2026, 10, 24, 7, 0, 0);
const raw = (at: number, d = 0, speed = 12): RawLocationSample => ({ latitude: 41 + d, longitude: 29, accuracy: 10, speed, heading: 0, timestamp: at - 500 });
const target = (r: string, over: Partial<PersistedTarget> = {}): PersistedTarget => ({
  share_id: `me_${r}`,
  receiver_id: r,
  share_mode: 'indefinite',
  expires_at: null,
  session_id: 'srv1',
  started_at: NOW - HOUR,
  version: 1,
  ...over,
});

function memAdaptive(): AdaptiveStorage {
  let v: AdaptiveSnapshot | null = null;
  return {
    load: async (now) => v ?? initialSnapshot(now),
    save: async (s) => {
      v = s;
    },
    clear: async () => {
      v = null;
    },
  };
}

function setup(over: Partial<PipelineDeps> = {}) {
  let online = true;
  let clock = NOW;
  let battery = 0.5;
  const write = jest.fn<Promise<void>, [Record<string, DeliveredLocationWrite>]>().mockResolvedValue(undefined);
  const refreshTargets = jest.fn<Promise<PublishTarget[]>, []>().mockResolvedValue([]);
  const publisher: PublisherDeps = { write, refreshTargets };
  const writeRaw = jest.fn<Promise<void>, [Record<string, unknown>]>().mockResolvedValue(undefined);
  const callPending = jest.fn<Promise<'ok' | 'retry' | 'drop'>, [PendingCall]>().mockResolvedValue('ok');
  const engine = { stopBackground: jest.fn(async () => undefined), startBackground: jest.fn(async () => undefined), canReconfigureNow: () => false };
  const outbox = createOutboxRepo(() => asyncStorageOutboxStore);
  let op = 0;
  const pipeline = createSamplePipeline({
    probeAuth: async () => ({ kind: 'signed_in', uid: 'me' }),
    publisherDeps: () => publisher,
    waitOnline: async () => online,
    isOnline: () => online,
    readDevice: async () => ({ batteryLevel: battery, isCharging: false }),
    engine,
    appPhase: () => 'background',
    deviceNow: () => clock,
    isBlocked: isShareBlocked,
    hydrateBlocks: hydrateStopIntents,
    adaptive: createAdaptiveController({ io: () => engine, storage: memAdaptive() }),
    outbox,
    writeRaw,
    lastActivity: () => null,
    canUseGeofence: async () => false,
    callPending,
    newOpId: () => `00000000-0000-4000-8000-${String(++op).padStart(12, '0')}`,
    ...over,
  });
  return {
    pipeline,
    write,
    writeRaw,
    callPending,
    outbox,
    setOnline: (v: boolean) => (online = v),
    setClock: (t: number) => (clock = t),
    setBattery: (v: number) => (battery = v),
  };
}

const seed = (targets: PersistedTarget[]) => saveTargets({ uid: 'me', targets, serverOffsetMs: 0, notificationBody: '1 kişiyle' });

describe('Faz 3 konum hattı: çevrimdışı dayanıklılık', () => {
  beforeEach(async () => {
    __resetStopIntentsMemoryForTests();
    await AsyncStorage.clear();
  });

  it('çevrimiçi yayın: pakette gönderenin beklenen aralığı (hb) var', async () => {
    await seed([target('a')]);
    const t = setup();
    await t.pipeline.handleSamples([raw(NOW)], 'task');
    const pkt = t.write.mock.calls[0]![0]['live_locations/a/me_a']!;
    expect(typeof pkt.hb).toBe('number');
    expect(pkt.hb).toBeGreaterThan(0);
    expect((await loadCursor()).lastLiveTs).toBe(pkt.timestamp);
  });

  it('tünel: çevrimdışı örnekler kalıcı kuyruğa; bağlantı gelince kuyruk taze yayından ÖNCE boşaltılır', async () => {
    await seed([target('a')]);
    const t = setup();
    t.setOnline(false);
    for (let i = 0; i < 3; i++) {
      t.setClock(NOW + i * 2 * MINUTE);
      await t.pipeline.handleSamples([raw(NOW + i * 2 * MINUTE, i * 0.01)], 'task');
    }
    expect(t.write).not.toHaveBeenCalled();
    expect(t.writeRaw).not.toHaveBeenCalled();
    expect(await t.outbox.pendingCount()).toBe(3);

    t.setOnline(true);
    t.setClock(NOW + 8 * MINUTE);
    await t.pipeline.handleSamples([raw(NOW + 8 * MINUTE, 0.05)], 'task');
    expect(await t.outbox.pendingCount()).toBe(0);
    // Sıra: kuyruk (canlı q:1 + iz) → taze yayın; taze nokta canlı düğümde kalır.
    expect(t.writeRaw.mock.invocationCallOrder[0]!).toBeLessThan(t.write.mock.invocationCallOrder[0]!);
    const maps = t.writeRaw.mock.calls.map((c) => c[0]);
    const live = maps.find((m) => 'live_locations/a/me_a' in m)!['live_locations/a/me_a'] as Record<string, unknown>;
    expect(live).toMatchObject({ q: 1 });
    expect(maps.flatMap((m) => Object.keys(m)).filter((k) => k.startsWith('live_trail/a/me_a/'))).toHaveLength(3);
    expect(t.write.mock.calls[0]![0]['live_locations/a/me_a']).toMatchObject({ timestamp: NOW + 8 * MINUTE - 500 });
    expect(t.write.mock.calls[0]![0]['live_locations/a/me_a']!.q).toBeUndefined();
  });

  it('yazma zaman aşımı (çevrimiçi ama başarısız): nokta kuyruğa alınır', async () => {
    await seed([target('a')]);
    const t = setup();
    t.write.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'timeout' }));
    await t.pipeline.handleSamples([raw(NOW)], 'task');
    expect(await t.outbox.pendingCount()).toBe(1);
  });

  it('%15 pil: oturum başına BİR bildirim; çevrimdışıysa kuyruğa, bağlantı gelince aynı op_id ile', async () => {
    await seed([target('a'), target('b')]); // aynı oturum (srv1) → tek çağrı
    expect(sessionKeysOf([target('a'), target('b')], [])).toEqual(['s:srv1']);
    const t = setup();
    t.setOnline(false);
    t.setBattery(0.16);
    await t.pipeline.handleSamples([raw(NOW)], 'task');
    t.setBattery(0.14);
    t.setClock(NOW + 2 * MINUTE);
    await t.pipeline.handleSamples([raw(NOW + 2 * MINUTE, 0.01)], 'task');
    t.setBattery(0.13);
    t.setClock(NOW + 4 * MINUTE);
    await t.pipeline.handleSamples([raw(NOW + 4 * MINUTE, 0.02)], 'task');
    expect(t.callPending).not.toHaveBeenCalled();
    const calls = (await t.outbox.load()).meta.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toMatchObject({ session_id: 'srv1', battery_pct: 14, is_charging: false });

    t.setOnline(true);
    t.setClock(NOW + 6 * MINUTE);
    await t.pipeline.handleSamples([raw(NOW + 6 * MINUTE, 0.03)], 'task');
    expect(t.callPending).toHaveBeenCalledTimes(1);
    expect(t.callPending.mock.calls[0]![0].op_id).toBe(calls[0]!.op_id);
    expect((await t.outbox.load()).meta.calls).toEqual([]);
  });

  it('%15 pil çevrimiçi: tetiklenince hemen yayın + tek battery_low_notify', async () => {
    await seed([target('a')]);
    const t = setup();
    t.setBattery(0.2);
    await t.pipeline.handleSamples([raw(NOW)], 'task');
    t.setBattery(0.15);
    // Gönderim kadansı dolmadan (10 sn sonra, aynı yerde) bile pil tetikleyicisi yayını zorlar.
    t.setClock(NOW + 10_000);
    await t.pipeline.handleSamples([raw(NOW + 10_000)], 'task');
    expect(t.write).toHaveBeenCalledTimes(2);
    expect(t.write.mock.calls[1]![0]['live_locations/a/me_a']).toMatchObject({ battery_pct: 15 });
    expect(t.callPending).toHaveBeenCalledTimes(1);
    expect(t.callPending.mock.calls[0]![0]).toMatchObject({ name: 'battery_low_notify', payload: { session_id: 'srv1', battery_pct: 15 } });
  });

  it('"Durdur" sonrası kuyruktaki noktalar gönderilmez (kesme anahtarı)', async () => {
    await seed([target('a')]);
    let blocked = false;
    const t = setup({ isBlocked: () => blocked });
    t.setOnline(false);
    await t.pipeline.handleSamples([raw(NOW)], 'task');
    expect(await t.outbox.pendingCount()).toBe(1);
    blocked = true;
    t.setOnline(true);
    await t.pipeline.flushOutbox(true);
    expect(t.writeRaw).not.toHaveBeenCalled();
  });
});
