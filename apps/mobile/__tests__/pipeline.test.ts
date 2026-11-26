/**
 * Konum hattı: oturum yoklaması zaman aşımı, eşzamanlı "Durdur" altında karşılaştır-değiştir hedef
 * güncellemesi, çevrimdışı yazmama, kesin çıkışta ek süre. Firebase ve konum motoru sahte; AsyncStorage sahte.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HOUR, MINUTE, type DeliveredLocationWrite, type PublishTarget, type RawLocationSample } from '@konum/core';
import type { PublisherDeps } from '../src/services/firebase/publisher';
import { createSamplePipeline, type AuthProbe, type PipelineDeps } from '../src/services/location/pipeline';
import { loadCursor, loadTargets, saveCursor, saveTargets, type PersistedTarget } from '../src/state/persist';
import { __resetStopIntentsMemoryForTests, addStopIntent, hydrateStopIntents, isShareBlocked } from '../src/state/stopIntents';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const raw: RawLocationSample = { latitude: 41.0082, longitude: 28.9784, accuracy: 12, speed: 1.2, heading: 90, timestamp: NOW - 1_000 };
const target = (r: string, over: Partial<PersistedTarget> = {}): PersistedTarget => ({
  share_id: `me_${r}`,
  receiver_id: r,
  share_mode: 'timed',
  expires_at: NOW + HOUR,
  session_id: 'srv1',
  started_at: NOW - MINUTE,
  version: 1,
  ...over,
});
const permissionDenied = Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'database/permission-denied' });

function setup(over: Partial<PipelineDeps> = {}) {
  const write = jest.fn<Promise<void>, [Record<string, DeliveredLocationWrite>]>().mockResolvedValue(undefined);
  const refreshTargets = jest.fn<Promise<PublishTarget[]>, []>().mockResolvedValue([]);
  const publisher: PublisherDeps = { write, refreshTargets };
  const engine = {
    stopBackground: jest.fn(async () => undefined),
    startBackground: jest.fn(async () => undefined),
    canReconfigureNow: () => false,
  };
  const probeAuth = jest.fn<Promise<AuthProbe>, []>().mockResolvedValue({ kind: 'signed_in', uid: 'me' });
  let clock = NOW;
  const pipeline = createSamplePipeline({
    batteryShare: async () => true,
    reportDeparture: async () => undefined,
    probeAuth,
    publisherDeps: () => publisher,
    waitOnline: async () => true,
    readDevice: async () => ({ batteryLevel: 0.5, isCharging: false }),
    engine,
    appPhase: () => 'background',
    deviceNow: () => clock,
    isBlocked: isShareBlocked,
    hydrateBlocks: hydrateStopIntents,
    ...over,
  });
  return { pipeline, write, refreshTargets, engine, probeAuth, setClock: (t: number) => (clock = t) };
}

async function seed(targets: PersistedTarget[], uid: string | null = 'me') {
  await saveTargets({ uid, targets, serverOffsetMs: 0, notificationBody: '1 kişiyle' });
}

describe('konum hattı', () => {
  beforeEach(async () => {
    __resetStopIntentsMemoryForTests();
    await AsyncStorage.clear();
  });

  it('normal örnek: v + share_id içeren kopyaları yazar, imleci kaydeder', async () => {
    await seed([target('a')]);
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(t.write.mock.calls[0]![0]['live_locations/a/me_a']).toMatchObject({ v: 1, share_id: 'me_a', sender_id: 'me' });
    expect((await loadCursor()).lastPublished).toMatchObject({ lat: 41.0082, lng: 28.9784 });
  });

  it('oturum yoklaması zaman aşımına uğrarsa: hedefler SİLİNMEZ, takip kapanmaz, yazma olmaz', async () => {
    await seed([target('a')]);
    const t = setup({ probeAuth: async () => ({ kind: 'unknown' }) });
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).not.toHaveBeenCalled();
    expect(t.engine.stopBackground).not.toHaveBeenCalled();
    expect(await loadTargets()).toMatchObject({ uid: 'me', targets: [{ share_id: 'me_a' }] });
  });

  it('kesin çıkış: ilk örnekte ek süre tanır, süre geçince hedefleri siler ve takibi kapatır', async () => {
    await seed([target('a', { expires_at: NOW + 2 * HOUR })]);
    const t = setup({ probeAuth: async () => ({ kind: 'signed_out' }) });
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.engine.stopBackground).not.toHaveBeenCalled();
    expect((await loadTargets()).targets).toHaveLength(1);
    expect((await loadCursor()).authMissingSince).toBe(NOW);

    t.setClock(NOW + 11 * MINUTE);
    await t.pipeline.handleSamples([{ ...raw, timestamp: NOW + 11 * MINUTE - 1_000 }], 'task');
    expect(t.write).not.toHaveBeenCalled();
    expect(t.engine.stopBackground).toHaveBeenCalled();
    expect(await loadTargets()).toMatchObject({ uid: null, targets: [] });
  });

  it('başka hesap: eski hesabın hedefleriyle yazmaz, listeyi siler', async () => {
    await seed([target('a')]);
    const t = setup({ probeAuth: async () => ({ kind: 'signed_in', uid: 'other' }) });
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).not.toHaveBeenCalled();
    expect(await loadTargets()).toMatchObject({ uid: null, targets: [] });
    expect(t.engine.stopBackground).toHaveBeenCalled();
  });

  it('çevrimdışı: RTDB kuyruğuna yazmaz, kalıcı durumu değiştirmez', async () => {
    await seed([target('a')]);
    const t = setup({ waitOnline: async () => false });
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).not.toHaveBeenCalled();
    expect((await loadTargets()).targets).toHaveLength(1);
  });

  it('yayın sırasında "Durdur" (CAS): durdurulan hedef ne yeniden denemede yazılır ne de kalıcı listeye geri döner', async () => {
    await seed([target('a'), target('b')]);
    const t = setup();
    // İlk yazma reddedilir; tazeleme beklenirken ön plan a'yı durdurur (niyet + yeni tam liste).
    t.write.mockRejectedValueOnce(permissionDenied);
    t.refreshTargets.mockImplementation(async () => {
      void addStopIntent({ session_id: 'srv1', op_id: 'op', shares: [{ share_id: 'me_a', version: 1 }], requested_at: NOW });
      await seed([target('b')]); // sharingCoordinator'ın yeni listesi
      return [target('a'), target('b', { expires_at: NOW + 2 * HOUR })];
    });
    await t.pipeline.handleSamples([raw], 'task');

    expect(t.write).toHaveBeenCalledTimes(2);
    expect(Object.keys(t.write.mock.calls[1]![0])).toEqual(['live_locations/b/me_b']);
    const after = await loadTargets();
    // a geri gelmedi; b'nin bitişi sunucudan güncellendi (yalnızca listede olduğu için).
    expect(after.targets.map((x) => x.share_id)).toEqual(['me_b']);
    expect(after.targets[0]!.expires_at).toBe(NOW + 2 * HOUR);
  });

  it('tazeleme sırasında yeni başlayan paylaşım silinmez (liste yalnızca daralır, eklenen korunur)', async () => {
    await seed([target('a'), target('b')]);
    const t = setup();
    t.write.mockRejectedValueOnce(permissionDenied);
    t.refreshTargets.mockImplementation(async () => {
      await seed([target('a'), target('b'), target('c')]); // ön planda c ile yeni paylaşım başladı
      return [target('a')]; // sunucuya göre b bitti
    });
    await t.pipeline.handleSamples([raw], 'task');
    expect((await loadTargets()).targets.map((x) => x.share_id)).toEqual(['me_a', 'me_c']);
  });

  it('tüm hedefler durdurulduysa yazmaz, takibi kapatır ve kendi son konumunu siler', async () => {
    await seed([target('a')]);
    await saveCursor({ lastPublished: { lat: 1, lng: 2, sent_at: NOW - MINUTE, battery_pct: 50, activity: 'still' } });
    await addStopIntent({ session_id: 'srv1', op_id: 'op', shares: [{ share_id: 'me_a', version: 1 }], requested_at: NOW });
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).not.toHaveBeenCalled();
    expect(t.engine.stopBackground).toHaveBeenCalled();
    expect((await loadTargets()).targets).toEqual([]);
    expect((await loadCursor()).lastPublished).toBeNull();
  });

  it('başsız bağlam (bellek boş): diskteki durdurma niyeti yazmayı engeller', async () => {
    await seed([target('a'), target('b')]);
    await addStopIntent({ session_id: 'srv1', op_id: 'op', shares: [{ share_id: 'me_a', version: 1 }], requested_at: NOW });
    __resetStopIntentsMemoryForTests(); // yeni JS bağlamı
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(Object.keys(t.write.mock.calls[0]![0])).toEqual(['live_locations/b/me_b']);
  });
});
