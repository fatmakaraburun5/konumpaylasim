/**
 * Faz 5 mobil veri katmanı (odaklı): bölge izleme çekirdeği (OS olayı + taze konum → rapor; GPS sapması → rapor yok;
 * `start_share` yanıtı → paylaşım başlatma) ve buluşma önerisi katılımcı kurulumu (`missingFriendIds`).
 */
import {
  initialZoneFilterState,
  uuidV4,
  ZONE_FILTER,
  type MeetupSuggestRequest,
  type MeetupSuggestResponse,
  type ZoneEventReportResponse,
  type ZoneFilterState,
  type ZoneUpsertResponse,
} from '@konum/core';
import { DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, MAP_HOME, PEOPLE } from '../src/demo/server/world';
import { createZoneMonitorCore, type ZoneMonitorDeps } from '../src/services/location/zoneMonitorCore';
import { createMeetupStore } from '../src/state/meetupStore';
import type { PendingZoneReport, PersistedZone } from '../src/state/persist';
import { acceptConsent, grant } from './demoTestUtils';

const T0 = 1_800_000_000_000;
const C = { lat: 41.0, lng: 29.0 };
const ZONE: PersistedZone = { zone_id: 'home', name: 'Ev', center: C, radius_m: 150, enabled: true };
/** Merkezin `m` metre kuzeyi. */
const north = (m: number) => ({ lat: C.lat + m / 111_195, lng: C.lng });
const sample = (m: number, at: number, accuracy = 8) => ({ ...north(m), accuracy, at });

const insideState = (at: number): ZoneFilterState => ({
  ...initialZoneFilterState(),
  presence: 'inside',
  last_sample: { ...north(20), at },
});

function harness(opts: { state?: ZoneFilterState; response?: Partial<ZoneEventReportResponse>; sharingWith?: string[]; fixes?: ReturnType<typeof sample>[] } = {}) {
  let clock = T0;
  let filters = { uid: 'me' as string | null, states: opts.state ? { home: opts.state } : ({} as Record<string, ZoneFilterState>) };
  let reports = { uid: 'me' as string | null, reports: [] as PendingZoneReport[] };
  const fixes = [...(opts.fixes ?? [])];
  const report = jest.fn(async () => ({ notified: 1, start_share: [], suppressed: null, server_now: clock, ...opts.response }) as ZoneEventReportResponse);
  const startShare = jest.fn(async () => true);
  const sleep = jest.fn(async (ms: number) => {
    clock += ms;
  });
  const deps: ZoneMonitorDeps = {
    myUid: async () => 'me',
    loadZones: async () => ({ uid: 'me', zones: [ZONE] }),
    loadFilters: async () => JSON.parse(JSON.stringify(filters)),
    saveFilters: async (v) => {
      filters = JSON.parse(JSON.stringify(v));
    },
    loadReports: async () => JSON.parse(JSON.stringify(reports)),
    saveReports: async (v) => {
      reports = JSON.parse(JSON.stringify(v));
    },
    report,
    sharingWith: async () => new Set(opts.sharingWith ?? []),
    startShare,
    getFreshSample: async () => {
      const f = fixes.shift() ?? null;
      if (f) clock = Math.max(clock, f.at);
      return f;
    },
    toServerTime: (d) => d + 500,
    deviceNow: () => clock,
    sleep,
    newOpId: () => '00000000-0000-4000-8000-000000000001',
  };
  return { core: createZoneMonitorCore(deps), report, startShare, sleep, pending: () => reports.reports, state: () => filters.states.home };
}

describe('zoneMonitorCore', () => {
  it('OS "çıktı" olayı + taze konum (ikinci örnek ≥ 20 sn sonra) → ayrılış raporu; koordinat gönderilmez', async () => {
    const h = harness({ state: insideState(T0 - 60_000), fixes: [sample(320, T0 + 1_000), sample(340, T0 + 22_000)] });
    await h.core.handleOsEvent('home', 'exit', T0);
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledTimes(1);
    const req = (h.report.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(req).toMatchObject({ zone_id: 'home', transition: 'leave', occurred_at: T0 + 22_000 + 500, accuracy_m: 8 });
    expect(req).not.toHaveProperty('lat');
    expect(h.state()?.presence).toBe('outside');
    expect(h.pending()).toEqual([]); // gönderildi → kuyruktan çıktı
  });

  it('GPS sapması: kötü doğruluk + tek uzak sıçrama → rapor yok, durum değişmez', async () => {
    const h = harness({ state: insideState(T0 - 5_000) });
    await h.core.feedSamples([sample(400, T0, 450)], 'foreground'); // low_accuracy
    await h.core.handleOsEvent('home', 'exit', T0 + 100); // aday
    await h.core.feedSamples([sample(1_500, T0 + 2_000, 20)], 'foreground'); // teleport
    await h.core.feedSamples([sample(15, T0 + 7_000)], 'foreground'); // içeride → aday düşer
    expect(h.report).not.toHaveBeenCalled();
    expect(h.state()?.presence).toBe('inside');
    expect(h.state()?.candidate).toBeNull();
  });

  it('çevrimdışı: rapor kuyrukta kalır, aynı op_id ile yeniden gönderilir', async () => {
    const h = harness({ state: insideState(T0 - 60_000) });
    h.report.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'functions/unavailable' }));
    await h.core.feedSamples([sample(300, T0), sample(320, T0 + ZONE_FILTER.minConfirmSpanMs)], 'background');
    expect(h.pending()).toHaveLength(1);
    await h.core.flushReports();
    expect(h.report).toHaveBeenCalledTimes(2);
    const ids = h.report.mock.calls.map((c) => ((c as unknown[])[0] as { op_id: string }).op_id);
    expect(ids[0]).toBe(ids[1]);
    expect(h.pending()).toEqual([]);
  });

  it('start_share yanıtı → zaten paylaşım almayan alıcılarla startShare', async () => {
    const h = harness({
      state: insideState(T0 - 60_000),
      sharingWith: ['mehmet'],
      response: { start_share: [{ rule_id: 'r1', recipient_ids: ['ayse', 'mehmet'], duration: { kind: 'preset', preset: 'h1' } }] },
    });
    await h.core.feedSamples([sample(300, T0), sample(320, T0 + 25_000)], 'foreground');
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.startShare).toHaveBeenCalledWith(['ayse'], { kind: 'preset', preset: 'h1' });
  });
});

describe('meetupStore.suggest', () => {
  it('katılımcılar: ben + görünen arkadaş + seçili hedef; görünmeyen arkadaş missingFriendIds', async () => {
    const meetupSuggest = jest.fn(async (req: Omit<MeetupSuggestRequest, 'op_id'>) => ({
      center: req.participants[0]!.position,
      search_radius_m: 300,
      suggestions: [],
      fallback: 'no_results' as const,
      cached: false,
      server_now: T0,
    }));
    const store = createMeetupStore({
      api: { meetupSuggest, meetupShare: jest.fn(), meetupRespond: jest.fn(), meetupCancel: jest.fn() },
      now: () => T0,
      myUid: () => 'me',
      myPosition: () => ({ lat: 40.9862, lng: 29.0275 }),
      friendPositions: () => ({ ayse: { lat: 40.99, lng: 29.03 } }),
      newOpId: () => '00000000-0000-4000-8000-000000000002',
    });
    const r = await store.getState().suggest({
      friendIds: ['ayse', 'mehmet', 'zeynep', 'me'],
      category: 'cafe',
      modes: { ayse: 'BICYCLE' },
      positionOverrides: { zeynep: { lat: 40.985, lng: 29.033 } },
    });
    expect(r.ok).toBe(true);
    const req = meetupSuggest.mock.calls[0]![0];
    expect(req.participants.map((p) => p.key)).toEqual(['me', 'ayse', 'zeynep']);
    // Yayılım < 2 km → varsayılan Yürüyüş; Ayşe için seçilen mod korunur.
    expect(req.participants.map((p) => p.mode)).toEqual(['WALK', 'BICYCLE', 'WALK']);
    expect(req.category).toBe('cafe');
    expect(store.getState().missingFriendIds).toEqual(['mehmet']);
    expect(store.getState().status).toBe('ready');
  });

  it('konumu görünen arkadaş yoksa ağa çıkmadan hata', async () => {
    const meetupSuggest = jest.fn();
    const store = createMeetupStore({
      api: { meetupSuggest, meetupShare: jest.fn(), meetupRespond: jest.fn(), meetupCancel: jest.fn() },
      now: () => T0,
      myUid: () => 'me',
      myPosition: () => ({ lat: 40.9862, lng: 29.0275 }),
      friendPositions: () => ({}),
    });
    const r = await store.getState().suggest({ friendIds: ['mehmet'], category: 'transit' });
    expect(r.ok).toBe(false);
    expect(meetupSuggest).not.toHaveBeenCalled();
    expect(store.getState().missingFriendIds).toEqual(['mehmet']);
    expect(store.getState().status).toBe('error');
  });
});

describe('demo sunucusu (Faz 5)', () => {
  const servers: DemoServer[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.reset()));

  it('zone_upsert yabancıyı sessizce düşürür; zone_event_report notify → push, tekrar → cooldown, start_share yanıtta', async () => {
    const s = new DemoServer();
    servers.push(s);
    await acceptConsent(s); // Faz 8: onaysız hesap çağrı yapamaz
    const ayse = PEOPLE.ayse.uid;
    // Faz 8: bildirim için Ayşe'nin izni (zone_notify), paylaşım için benim iznim (location_view).
    await grant(s, ayse, DEMO_ME, 'zone_notify');
    await grant(s, DEMO_ME, ayse, 'location_view');
    const rule = (trigger: 'arrive' | 'leave', action: 'notify' | 'start_share') => ({
      rule_id: uuidV4(),
      trigger,
      action,
      recipient_ids: [ayse, 'yabanci'],
      share_duration: action === 'start_share' ? ({ kind: 'preset', preset: 'h1' } as const) : null,
      days_mask: 127,
      window: null,
      enabled: true,
    });
    const up = (await s.call(
      'zone_upsert',
      { op_id: uuidV4(), zone_id: null, kind: 'home', name: 'Ev', emoji: '🏠', center: MAP_HOME, radius_m: 150, rules: [rule('arrive', 'notify'), rule('leave', 'start_share')], enabled: true, time_zone: 'Europe/Istanbul' },
      DEMO_ME,
    )) as ZoneUpsertResponse;
    expect(up.dropped_recipient_ids).toEqual(['yabanci']);
    expect(up.zone.rules.every((r) => r.recipient_ids.length === 1)).toBe(true);
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(ayse, (m) => pushes.push(m));
    const report = (transition: 'arrive' | 'leave') =>
      s.call('zone_event_report', { op_id: uuidV4(), zone_id: up.zone.zone_id, transition, occurred_at: Date.now(), accuracy_m: 8 }, DEMO_ME) as Promise<ZoneEventReportResponse>;
    expect(await report('arrive')).toMatchObject({ notified: 1, suppressed: null, start_share: [] });
    expect(await report('arrive')).toMatchObject({ notified: 0, suppressed: 'cooldown' });
    expect((await report('leave')).start_share).toEqual([expect.objectContaining({ recipient_ids: [ayse], duration: { kind: 'preset', preset: 'h1' } })]);
    await new Promise((res) => setTimeout(res, 800));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.data).toEqual({ type: 'zone_event', from: DEMO_ME, zone_name: 'Ev', transition: 'arrive' });
    expect(JSON.stringify(pushes[0])).not.toContain(String(MAP_HOME.lat));
  });

  it('meetup_suggest: sahte Places + matris → sıralı öneriler; çok yakın → yalnızca orta nokta', async () => {
    const s = new DemoServer();
    servers.push(s);
    await acceptConsent(s); // Faz 8: onaysız hesap çağrı yapamaz
    const ask = (b: { lat: number; lng: number }) =>
      s.call(
        'meetup_suggest',
        { op_id: uuidV4(), category: 'cafe', participants: [{ key: 'me', position: MAP_HOME, mode: 'WALK' }, { key: PEOPLE.ayse.uid, position: b, mode: 'WALK' }] },
        DEMO_ME,
      ) as Promise<MeetupSuggestResponse>;
    const r = await ask({ lat: 40.9905, lng: 29.0335 });
    expect(r.fallback).toBeNull();
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions.length).toBeLessThanOrEqual(3);
    const scores = r.suggestions.map((x) => x.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(r.suggestions[0]?.etas.map((e) => e.key)).toEqual(['me', PEOPLE.ayse.uid]);
    expect((await ask({ lat: 40.9905, lng: 29.0335 })).cached).toBe(true);
    const close = await ask({ lat: MAP_HOME.lat + 0.0003, lng: MAP_HOME.lng });
    expect(close.fallback).toBe('too_close');
    expect(close.suggestions.map((x) => x.place.category)).toEqual(['midpoint']);
  });

  it('meetup önbelleği çağırana özel: aynı hücrelerde Ayşe\'nin önerisi benim kaydımı kullanmaz (ETA anahtarları karışmaz)', async () => {
    const s = new DemoServer();
    servers.push(s);
    await acceptConsent(s); // Faz 8: onaysız hesap çağrı yapamaz
    const ayse = PEOPLE.ayse.uid;
    // Ayşe'nin botun kullanacağı konumu (aynı hücre → eski kodda aynı önbellek anahtarı).
    const p = (s as unknown as { botPosition: (u: string) => { lat: number; lng: number } }).botPosition(ayse);
    const ayseAt = { lat: p.lat, lng: p.lng };
    // Ben: 'me' = MAP_HOME, Ayşe = ayseAt (önbelleğe yazılır).
    const mine = (await s.call(
      'meetup_suggest',
      { op_id: uuidV4(), category: 'cafe', participants: [{ key: 'me', position: MAP_HOME, mode: 'WALK' }, { key: ayse, position: ayseAt, mode: 'WALK' }] },
      DEMO_ME,
    )) as MeetupSuggestResponse;
    expect(mine.cached).toBe(false);
    // Ayşe aynı iki hücreyle önerir: 'me' = Ayşe, DEMO_ME = ben → paylaşılan önerinin ETA'larında iki farklı kişi.
    // Faz 8: Ayşe'nin bana davet atması benim iznimi (meetup_invite), ETA'mı görmesi location_view ister.
    await grant(s, DEMO_ME, ayse, 'meetup_invite', 'location_view');
    const id = s.botMeetupSuggest(ayse, MAP_HOME);
    expect(id).not.toBeNull();
    const shared = (s as unknown as { db: { meetups: Record<string, { etas: { key: string }[] }> } }).db.meetups[id!];
    // Faz 8: yalnızca önerenin ('me' → Ayşe) ETA'sı saklanır; benimki (başka katılımcı) hiç saklanmaz.
    expect(shared?.etas.map((e) => e.key)).toEqual([ayse]);
  });
});
