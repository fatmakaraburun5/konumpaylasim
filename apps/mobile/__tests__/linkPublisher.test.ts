/**
 * Bağlantı yayıncısı ve konum hattı: `link_live/{hash}` paketinde yalnızca izinli alanlar, arkadaş fan-out'undan
 * AYRI yazma, PERMISSION_DENIED → tazele + tek tekrar, kesme anahtarı, yalnızca bağlantı varken de takip sürer,
 * durdurulan bağlantıya yazılmaz.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  HOUR,
  LINK_LIVE_FIELDS,
  linkTokenHash,
  MINUTE,
  SERVER_TIMESTAMP,
  type DeliveredLocationWrite,
  type LinkLiveLocationWrite,
  type LinkPublishTarget,
  type NormalizedSample,
  type PublishTarget,
  type RawLocationSample,
} from '@konum/core';
import { publishLinkSample, type LinkPublisherDeps } from '../src/services/firebase/linkPublisher';
import type { PublisherDeps } from '../src/services/firebase/publisher';
import { combinedTargetsKey, createSamplePipeline, type PipelineDeps } from '../src/services/location/pipeline';
import { __resetLinkStopsMemoryForTests, addLinkStop, hydrateLinkStops, isLinkBlocked } from '../src/state/linkStops';
import { loadCursor, loadTargets, saveTargets, type PersistedLinkTarget, type PersistedTarget } from '../src/state/persist';
import { __resetStopIntentsMemoryForTests, hydrateStopIntents, isShareBlocked } from '../src/state/stopIntents';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const HASH_A = linkTokenHash('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
const HASH_B = linkTokenHash('_____________________________________________w'.slice(0, 42) + 'w');
const sample: NormalizedSample = { lat: 41.0082, lng: 28.9784, accuracy: 12, speed_mps: 1.2, heading: 90, timestamp: NOW - 1_000, mocked: false };
const device = { batteryLevel: 0.42, isCharging: true };
const link = (id: string, hash: string, over: Partial<PersistedLinkTarget> = {}): PersistedLinkTarget => ({
  link_id: id,
  token_hash: hash,
  share_mode: 'timed',
  expires_at: NOW + HOUR,
  sender_name: 'Ayşe Yılmaz',
  session_id: `s_${id}`,
  started_at: NOW - MINUTE,
  version: 1,
  ...over,
});
const permissionDenied = Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'database/permission-denied' });

function linkDeps() {
  const write = jest.fn<Promise<void>, [Record<string, LinkLiveLocationWrite>]>().mockResolvedValue(undefined);
  const refreshTargets = jest.fn<ReturnType<LinkPublisherDeps['refreshTargets']>, []>().mockResolvedValue([]);
  return { write, refreshTargets };
}

describe('publishLinkSample', () => {
  it('link_live/{hash} yazar: yalnızca LINK_LIVE_FIELDS; gönderen kimliği, şarj, etkinlik YOK', async () => {
    const d = linkDeps();
    const res = await publishLinkSample({ sample, device, targets: [link('a', HASH_A)], now: NOW }, d);
    expect(res).toMatchObject({ status: 'published', retried: false });
    const map = d.write.mock.calls[0]![0];
    expect(Object.keys(map)).toEqual([`link_live/${HASH_A}`]);
    const copy = map[`link_live/${HASH_A}`]!;
    expect(copy).toEqual({
      v: 1,
      lat: 41.0082,
      lng: 28.9784,
      accuracy: 12,
      heading: 90,
      speed_mps: 1.2,
      battery_pct: 42,
      timestamp: NOW - 1_000,
      server_ts: SERVER_TIMESTAMP,
      sender_name: 'Ayşe Yılmaz',
      expires_at: NOW + HOUR,
      share_mode: 'timed',
    });
    for (const k of Object.keys(copy)) expect(LINK_LIVE_FIELDS).toContain(k);
  });

  it('PERMISSION_DENIED: tazeler, biten bağlantı olmadan BİR KEZ yeniden dener (yerelde olmayan eklenmez)', async () => {
    const d = linkDeps();
    d.write.mockRejectedValueOnce(permissionDenied);
    d.refreshTargets.mockResolvedValue([
      { link_id: 'a', token_hash: HASH_A, share_mode: 'timed', expires_at: NOW + 2 * HOUR },
      { link_id: 'zz', token_hash: HASH_B, share_mode: 'timed', expires_at: NOW + HOUR },
    ]);
    const res = await publishLinkSample({ sample, device, targets: [link('a', HASH_A), link('b', HASH_B)], now: NOW }, d);
    expect(d.write).toHaveBeenCalledTimes(2);
    expect(Object.keys(d.write.mock.calls[1]![0])).toEqual([`link_live/${HASH_A}`]);
    expect(d.write.mock.calls[1]![0][`link_live/${HASH_A}`]!.expires_at).toBe(NOW + 2 * HOUR);
    expect(res).toMatchObject({ status: 'published', retried: true, dropped: ['b'] });
  });

  it('kesme anahtarı: durdurulan bağlantıya yazmaz', async () => {
    const d = { ...linkDeps(), isAllowed: (id: string) => id !== 'a' };
    await expect(publishLinkSample({ sample, device, targets: [link('a', HASH_A)], now: NOW }, d)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'blocked',
    });
    expect(d.write).not.toHaveBeenCalled();
  });
});

describe('konum hattı + bağlantı hedefleri', () => {
  const raw: RawLocationSample = { latitude: 41.0082, longitude: 28.9784, accuracy: 12, speed: 1.2, heading: 90, timestamp: NOW - 1_000 };
  const friend = (r: string): PersistedTarget => ({ share_id: `me_${r}`, receiver_id: r, share_mode: 'timed', expires_at: NOW + HOUR, session_id: 'srv1', started_at: NOW, version: 1 });

  beforeEach(async () => {
    __resetStopIntentsMemoryForTests();
    __resetLinkStopsMemoryForTests();
    await AsyncStorage.clear();
  });

  function setup(over: Partial<PipelineDeps> = {}) {
    const write = jest.fn<Promise<void>, [Record<string, DeliveredLocationWrite>]>().mockResolvedValue(undefined);
    const publisher: PublisherDeps = { write, refreshTargets: jest.fn<Promise<PublishTarget[]>, []>().mockResolvedValue([]) };
    const ld = linkDeps();
    const engine = { stopBackground: jest.fn(async () => undefined), startBackground: jest.fn(async () => undefined), canReconfigureNow: () => false };
    const pipeline = createSamplePipeline({
      probeAuth: async () => ({ kind: 'signed_in', uid: 'me' }),
      publisherDeps: () => publisher,
      linkPublisherDeps: () => ld,
      waitOnline: async () => true,
      readDevice: async () => ({ batteryLevel: 0.5, isCharging: false }),
      engine,
      appPhase: () => 'background',
      deviceNow: () => NOW,
      isBlocked: isShareBlocked,
      hydrateBlocks: hydrateStopIntents,
      isLinkBlocked,
      hydrateLinkBlocks: hydrateLinkStops,
      ...over,
    });
    return { pipeline, write, linkWrite: ld.write, engine };
  }

  it('arkadaş + bağlantı: iki AYRI yazma; imleç anahtarı ikisini de kapsar', async () => {
    await saveTargets({ uid: 'me', targets: [friend('a')], linkTargets: [link('l1', HASH_A)], serverOffsetMs: 0, notificationBody: '' });
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(Object.keys(t.write.mock.calls[0]![0])).toEqual(['live_locations/a/me_a']);
    expect(Object.keys(t.linkWrite.mock.calls[0]![0])).toEqual([`link_live/${HASH_A}`]);
    expect((await loadCursor()).lastTargetsKey).toBe(combinedTargetsKey([friend('a')], [link('l1', HASH_A)]));
  });

  it('yalnızca bağlantı varken de yayınlar ve takibi KAPATMAZ', async () => {
    await saveTargets({ uid: 'me', targets: [], linkTargets: [link('l1', HASH_A)], serverOffsetMs: 0, notificationBody: '' });
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).not.toHaveBeenCalled();
    expect(t.linkWrite).toHaveBeenCalledTimes(1);
    expect(t.engine.stopBackground).not.toHaveBeenCalled();
  });

  it('durdurulan (niyetli) tek bağlantı: yazmaz, kalıcı listeden çıkarır ve takibi kapatır', async () => {
    await saveTargets({ uid: 'me', targets: [], linkTargets: [link('l1', HASH_A)], serverOffsetMs: 0, notificationBody: '' });
    void addLinkStop({ link_id: 'l1', op_id: 'op', version: 1, requested_at: NOW });
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.linkWrite).not.toHaveBeenCalled();
    expect((await loadTargets()).linkTargets).toEqual([]);
    expect(t.engine.stopBackground).toHaveBeenCalled();
  });

  it('süresi dolan bağlantıya yazmaz; arkadaş yayını sürer', async () => {
    await saveTargets({ uid: 'me', targets: [friend('a')], linkTargets: [link('l1', HASH_A, { expires_at: NOW - 1 })], serverOffsetMs: 0, notificationBody: '' });
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(t.linkWrite).not.toHaveBeenCalled();
  });

  it('eski (Faz 1) kalıcı kayıt: linkTargets yoksa boş liste sayılır', async () => {
    await AsyncStorage.setItem('konum.bg.targets.v1', JSON.stringify({ uid: 'me', targets: [friend('a')], serverOffsetMs: 0, notificationBody: '' }));
    expect((await loadTargets()).linkTargets).toEqual([]);
    const t = setup();
    await t.pipeline.handleSamples([raw], 'task');
    expect(t.write).toHaveBeenCalledTimes(1);
    expect((await loadCursor()).lastTargetsKey).toBe(combinedTargetsKey([friend('a')], []));
  });
});

// Tip kontrolü: test hedefi gerçek LinkPublishTarget ile uyumlu.
const _t: LinkPublishTarget = link('x', HASH_A);
void _t;
