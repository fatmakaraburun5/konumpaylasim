/**
 * Faz 5: bölgeler (varış / ayrılış tetikleyicileri) ve buluşma noktası. İşleyiciler test sürecinde sahte FCM ve sahte
 * Google `fetch` ile doğrudan çağrılır (bildirim ve istek içeriği görülsün); birkaç çağrı Functions emülatörü üzerinden
 * gider (dışa aktarım, şema ve hata eşlemesi).
 */
import {
  ALL_DAYS_MASK,
  MEETUP_LIMITS,
  MINUTE,
  MeetupShareRequestSchema,
  MeetupSuggestRequestSchema,
  PLACES_FIELD_MASK,
  PLACES_NEARBY_URL,
  ROUTE_MATRIX_FIELD_MASK,
  ROUTE_MATRIX_URL,
  ZONE_LIMITS,
  ZoneEventReportRequestSchema,
  ZoneUpsertRequestSchema,
  friendshipId,
  localClock,
  offsetFnForTimeZone,
  quotaDay,
} from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import type { MapsDeps, MapsFetch } from '../../functions/src/handlers/maps';
import { meetupCancel, meetupRespond, meetupShare, meetupSuggest } from '../../functions/src/handlers/meetup';
import { sweepExpired } from '../../functions/src/handlers/sweeper';
import { zoneDelete, zoneEventReport, zoneUpsert } from '../../functions/src/handlers/zones';
import type { PushMessage, PushSender } from '../../functions/src/push';
import { type TestUser, call, callError, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';
import { befriend } from '../review/helpers';

afterAll(async () => {
  await cleanupRulesEnv();
});

function fakeFcm() {
  const sent: { uid: string; msg: PushMessage }[] = [];
  const send: PushSender = async (uid, msg) => {
    sent.push({ uid, msg });
    return { sent: 1, removed: 0 };
  };
  return { sent, send };
}

const TZ = 'Europe/Istanbul';
const HOME = { lat: 41.0, lng: 29.0 };
const ctxOf = (u: TestUser, now = Date.now()): CallCtx => ({ uid: u.uid, phone_e164: null, now });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { details?: { code?: string } }) => e.details?.code ?? String(e));
const upIn = (x: Record<string, unknown>) => ZoneUpsertRequestSchema.parse({ op_id: opId(), zone_id: null, kind: 'home', name: 'Ev', center: HOME, radius_m: 150, time_zone: TZ, ...x });
const evIn = (x: Record<string, unknown>) => ZoneEventReportRequestSchema.parse({ op_id: opId(), ...x });
const rule = (id: string, trigger: 'arrive' | 'leave', action: 'notify' | 'start_share', recipient_ids: string[], extra: Record<string, unknown> = {}) => ({
  rule_id: id,
  trigger,
  action,
  recipient_ids,
  share_duration: action === 'start_share' ? { kind: 'preset', preset: 'h1' } : null,
  ...extra,
});

let A: TestUser; // Ayşe
let B: TestUser; // Bora
let C: TestUser; // Can
let D: TestUser; // Deniz (arkadaşlığı test içinde biter)
let X: TestUser; // yabancı

beforeAll(async () => {
  [A, B, C, D, X] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Deniz'), newUser('Xenon')]);
  await Promise.all([befriend(A, B), befriend(A, C), befriend(A, D)]);
});

// ---------------------------------------------------------------------------
// zone_upsert / zone_delete
// ---------------------------------------------------------------------------

describe('zone_upsert / zone_delete', () => {
  it('arkadaş olmayan alıcılar sessizce düşer, alıcısı kalmayan kural silinir; düzenlemede created_at korunur', async () => {
    const now = Date.now();
    const r = await zoneUpsert(
      ctxOf(A, now),
      upIn({
        name: '  Ev   tatlı ev  ',
        rules: [rule('r1', 'arrive', 'notify', [B.uid, X.uid, A.uid, B.uid]), rule('r2', 'leave', 'start_share', [X.uid])],
      }),
    );
    expect(r.zone).toMatchObject({ owner_id: A.uid, name: 'Ev tatlı ev', radius_m: 150, time_zone: TZ, created_at: now, enabled: true });
    expect(r.zone.rules).toHaveLength(1);
    expect(r.zone.rules[0]).toMatchObject({ rule_id: 'r1', recipient_ids: [B.uid], share_duration: null, days_mask: ALL_DAYS_MASK, window: null });
    expect(new Set(r.dropped_recipient_ids)).toEqual(new Set([X.uid, A.uid]));
    const stored = (await db().doc(`users/${A.uid}/zones/${r.zone.zone_id}`).get()).data();
    expect(stored?.rules).toHaveLength(1);

    const edited = await zoneUpsert(ctxOf(A, now + 1_000), upIn({ zone_id: r.zone.zone_id, name: 'Ev', radius_m: 300, rules: [] }));
    expect(edited.zone).toMatchObject({ zone_id: r.zone.zone_id, created_at: now, updated_at: now + 1_000, radius_m: 300, rules: [] });
    expect(edited.dropped_recipient_ids).toEqual([]);

    expect(await codeOf(zoneUpsert(ctxOf(A), upIn({ name: '   ' })))).toBe('invalid_argument');
    expect(await codeOf(zoneUpsert(ctxOf(A), upIn({ time_zone: 'Mars/Olympus' })))).toBe('invalid_argument');
    expect(await codeOf(zoneUpsert(ctxOf(A), upIn({ zone_id: 'yok-boyle-bolge' })))).toBe('zone_not_found');
    expect(await codeOf(zoneUpsert(ctxOf(A), upIn({ rules: [rule('d', 'arrive', 'notify', [B.uid]), rule('d', 'leave', 'notify', [B.uid])] })))).toBe('invalid_argument');

    expect(await zoneDelete(ctxOf(A), { op_id: opId(), zone_id: r.zone.zone_id })).toMatchObject({ deleted: true });
    expect(await call('zone_delete', { op_id: opId(), zone_id: r.zone.zone_id }, A)).toMatchObject({ zone_id: r.zone.zone_id, deleted: false });
  });

  it('en fazla 15 bölge: 16. yeni bölge zone_limit_reached (callable üzerinden)', async () => {
    const batch = db().batch();
    for (let i = 0; i < ZONE_LIMITS.maxZones; i++) batch.set(db().doc(`users/${C.uid}/zones/z${i}`), { zone_id: `z${i}`, owner_id: C.uid, rules: [] });
    await batch.commit();
    const e = await callError('zone_upsert', { op_id: opId(), zone_id: null, kind: 'custom', name: 'Spor', center: HOME, radius_m: 200, time_zone: TZ }, C);
    expect(e.status).toBe('RESOURCE_EXHAUSTED');
    expect(e.details?.code).toBe('zone_limit_reached');
    // Mevcut bölgeyi düzenlemek sınırdan etkilenmez.
    const ok = await call('zone_upsert', { op_id: opId(), zone_id: 'z0', kind: 'work', name: 'İş', center: HOME, radius_m: 200, time_zone: TZ }, C);
    expect(ok.zone).toMatchObject({ zone_id: 'z0', name: 'İş', kind: 'work' });
  });
});

// ---------------------------------------------------------------------------
// zone_event_report
// ---------------------------------------------------------------------------

describe('zone_event_report', () => {
  it('notify push (koordinatsız) → soğuma → start_share yanıtı → stale; olaylar kaydedilir; tekrar op_id yeni push üretmez', async () => {
    const fcm = fakeFcm();
    const now = Date.now();
    const z = (
      await zoneUpsert(
        ctxOf(A, now),
        upIn({
          name: 'Ev',
          center: { lat: 41.012345, lng: 29.054321 },
          rules: [rule('n1', 'arrive', 'notify', [B.uid, C.uid]), rule('n2', 'arrive', 'notify', [B.uid, D.uid]), rule('s1', 'leave', 'start_share', [B.uid, X.uid])],
        }),
      )
    ).zone;
    expect(z.rules.map((r) => r.rule_id)).toEqual(['n1', 'n2', 's1']);

    // 1. Varış: alıcı birleşimi B, C, D (tekil), push yalnızca bölge adını taşır.
    const arrive = evIn({ zone_id: z.zone_id, transition: 'arrive', occurred_at: now - 30_000, accuracy_m: 12 });
    const r1 = await zoneEventReport(ctxOf(A, now), arrive, fcm);
    expect(r1).toEqual({ notified: 3, start_share: [], suppressed: null, server_now: now });
    expect(new Set(fcm.sent.map((s) => s.uid))).toEqual(new Set([B.uid, C.uid, D.uid]));
    expect(fcm.sent[0]?.msg.data).toEqual({ type: 'zone_event', from: A.uid, zone_name: 'Ev', transition: 'arrive' });
    // Faz 7: bölge türüne göre doğal metin ("Ayşe eve girdi") ve heads-up `movement` kanalı.
    expect(fcm.sent[0]?.msg.notification).toEqual({ title: 'Ayşe eve girdi', body: 'Ev' });
    expect(fcm.sent[0]?.msg.android?.notification?.channelId).toBe('movement');
    expect(fcm.sent[0]?.msg.apns?.payload?.aps).toMatchObject({ 'interruption-level': 'time-sensitive' });
    expect(JSON.stringify(fcm.sent)).not.toMatch(/41\.01|29\.05|"lat"/);

    // Aynı op_id tekrarı: aynı yanıt, ikinci push yok.
    expect(await zoneEventReport(ctxOf(A, now + 500), arrive, fcm)).toEqual(r1);
    expect(fcm.sent).toHaveLength(3);

    // 2. 1 dk sonra yeniden varış: sunucu soğuması.
    const r2 = await zoneEventReport(ctxOf(A, now + MINUTE), evIn({ zone_id: z.zone_id, transition: 'arrive', occurred_at: now + MINUTE }), fcm);
    expect(r2).toMatchObject({ notified: 0, start_share: [], suppressed: 'cooldown' });
    expect(fcm.sent).toHaveLength(3);

    // 3. Ayrılış: start_share yanıtı (yabancı X süzülür), push yok. Gelecekteki occurred_at sunucu saatine kırpılır.
    const t3 = now + 2 * MINUTE;
    const leaveOp = opId();
    const r3 = await zoneEventReport(ctxOf(A, t3), evIn({ op_id: leaveOp, zone_id: z.zone_id, transition: 'leave', occurred_at: t3 + 10 * MINUTE }), fcm);
    expect(r3).toEqual({ notified: 0, start_share: [{ rule_id: 's1', recipient_ids: [B.uid], duration: { kind: 'preset', preset: 'h1' } }], suppressed: null, server_now: t3 });
    const log = (await db().doc(`users/${A.uid}/zone_events/${leaveOp}`).get()).data();
    expect(log).toMatchObject({ zone_id: z.zone_id, transition: 'leave', occurred_at: t3, notified: 0, suppressed: null });
    expect(log?.purge_at).toBeDefined();
    expect(JSON.stringify(log)).not.toMatch(/41\.01|29\.05|center/);

    // 4. Eski olay (31 dk): kaydedilir, push yok, start_share boş.
    const t4 = now + 20 * MINUTE;
    const r4 = await zoneEventReport(ctxOf(A, t4), evIn({ zone_id: z.zone_id, transition: 'leave', occurred_at: t4 - 31 * MINUTE }), fcm);
    expect(r4).toMatchObject({ notified: 0, start_share: [], suppressed: 'stale' });
    expect(fcm.sent).toHaveLength(3);

    // 5. Gün dışı kural: outside_window; olmayan bölge: zone_not_found (callable üzerinden).
    const today = localClock(now, offsetFnForTimeZone(TZ)(now)).weekday;
    const off = (await zoneUpsert(ctxOf(A, now), upIn({ name: 'İş', kind: 'work', rules: [rule('w', 'arrive', 'notify', [B.uid], { days_mask: ALL_DAYS_MASK & ~(1 << today) })] }))).zone;
    expect(await zoneEventReport(ctxOf(A, now), evIn({ zone_id: off.zone_id, transition: 'arrive', occurred_at: now }), fcm)).toMatchObject({ suppressed: 'outside_window', notified: 0 });
    const e = await callError('zone_event_report', { op_id: opId(), zone_id: 'yok', transition: 'arrive', occurred_at: now }, A);
    expect(e.details?.code).toBe('zone_not_found');
    expect(e.status).toBe('NOT_FOUND');

    // 6. Arkadaşlık biter: karşı taraf bölge kurallarından çıkar (n2 artık yalnızca B).
    await call('friendship_remove', { op_id: opId(), friendship_id: friendshipId(A.uid, D.uid) }, D);
    const after = (await db().doc(`users/${A.uid}/zones/${z.zone_id}`).get()).data() as { rules: { rule_id: string; recipient_ids: string[] }[] };
    expect(after.rules.find((r) => r.rule_id === 'n2')?.recipient_ids).toEqual([B.uid]);
    expect(JSON.stringify(after.rules)).not.toContain(D.uid);
  });
});

// ---------------------------------------------------------------------------
// meetup_suggest
// ---------------------------------------------------------------------------

const KEY = 'AIzaTEST-not-a-real-key-0123456789abcd';
const ME = { lat: 41.0, lng: 29.0 };
const BORA = { lat: 41.03, lng: 29.0 };
/** Sahte yerler: ad → konum. */
const PLACES = [
  { id: 'p1', name: 'P1', lat: 41.015, lng: 29.001 },
  { id: 'p2', name: 'P2', lat: 41.016, lng: 29.0 },
  { id: 'p3', name: 'P3', lat: 41.014, lng: 28.999 },
  { id: 'p4', name: 'P4', lat: 41.02, lng: 29.0 },
];
/** Sahte süreler (sn): mod → yer → süre. P1 için 'me' (DRIVE) hücresi YOK → kuş uçuşu tahmini. */
const DUR: Record<string, Record<string, number | undefined>> = {
  DRIVE: { p1: undefined, p2: 500, p3: 900, p4: 300 },
  WALK: { p1: 600, p2: 700, p3: 400, p4: 1_200 },
};

interface GCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeGoogle(opts: { places?: unknown; placesStatus?: number } = {}) {
  const calls: GCall[] = [];
  const fetch: MapsFetch = async (url, init) => {
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    calls.push({ url, headers: init.headers, body });
    if (url === PLACES_NEARBY_URL) {
      const json = opts.places ?? { places: PLACES.map((p) => ({ id: p.id, displayName: { text: p.name }, formattedAddress: `${p.name} Sk.`, location: { latitude: p.lat, longitude: p.lng }, primaryType: 'cafe' })) };
      const status = opts.placesStatus ?? 200;
      return { ok: status < 300, status, json: async () => json };
    }
    if (url === ROUTE_MATRIX_URL) {
      const mode = String(body.travelMode);
      const dests = body.destinations as { waypoint: { location: { latLng: { latitude: number } } } }[];
      const rows = dests.flatMap((d, di) => {
        const p = PLACES.find((x) => Math.abs(x.lat - d.waypoint.location.latLng.latitude) < 1e-6);
        const dur = p ? DUR[mode]?.[p.id] : undefined;
        return dur === undefined ? [] : [{ originIndex: 0, destinationIndex: di, duration: `${dur}s`, distanceMeters: dur * 5, condition: 'ROUTE_EXISTS' }];
      });
      return { ok: true, status: 200, json: async () => rows };
    }
    throw new Error(`beklenmeyen URL ${url}`);
  };
  return { fetch, calls };
}

function gdeps(fetch: MapsFetch, over: Partial<MapsDeps> = {}): MapsDeps {
  return {
    fetch,
    apiKey: () => KEY,
    budget: async () => ({ disabled: false, route: 100_000, geocode: 100_000 }),
    random: () => 0.5,
    drivePreference: 'TRAFFIC_UNAWARE',
    timeoutMs: 2_000,
    ...over,
  };
}

const sugIn = (participants: unknown[], category = 'cafe') => MeetupSuggestRequestSchema.parse({ op_id: opId(), participants, category });
const twoOf = (me = ME, other = BORA) => [
  { key: 'me', position: me, mode: 'DRIVE' },
  { key: B.uid, position: other, mode: 'WALK' },
];

describe('meetup_suggest', () => {
  it('Places + mod başına matris → adalet sıralaması; eksik hücre kuş uçuşu; ikinci çağrı önbellekten (kota işlemez)', async () => {
    const g = fakeGoogle();
    const now = Date.now();
    const r = await meetupSuggest(ctxOf(A, now), sugIn(twoOf()), gdeps(g.fetch));
    expect(r.fallback).toBeNull();
    expect(r.cached).toBe(false);
    expect(r.suggestions.map((s) => s.place.name)).toEqual(['P1', 'P2', 'P3']);
    const [s1, s2] = r.suggestions;
    expect(s1?.etas.map((e) => e.key)).toEqual(['me', B.uid]);
    expect(s1?.etas[0]?.estimated).toBe(true); // P1 'me' hücresi yok → fallbackEta
    expect(s1?.etas[1]).toMatchObject({ duration_s: 600, estimated: false });
    expect(s2?.etas.map((e) => e.duration_s)).toEqual([500, 700]);
    expect(s2?.score).toBe(800);
    expect(s1?.place).toMatchObject({ place_id: 'p1', address: 'P1 Sk.', category: 'cafe' });

    // İstek biçimi: Places 1 çağrı + 2 mod (DRIVE, WALK) için 2 matris; alan maskeleri.
    const places = g.calls.filter((c) => c.url === PLACES_NEARBY_URL);
    const matrices = g.calls.filter((c) => c.url === ROUTE_MATRIX_URL);
    expect(places).toHaveLength(1);
    expect(places[0]?.headers['X-Goog-FieldMask']).toBe(PLACES_FIELD_MASK);
    expect(places[0]?.headers['X-Goog-Api-Key']).toBe(KEY);
    expect(places[0]?.body).toMatchObject({ includedTypes: ['cafe', 'coffee_shop', 'bakery'], rankPreference: 'DISTANCE' });
    expect(new Set(matrices.map((c) => c.body.travelMode))).toEqual(new Set(['DRIVE', 'WALK']));
    expect(matrices[0]?.headers['X-Goog-FieldMask']).toBe(ROUTE_MATRIX_FIELD_MASK);
    const quota = (await db().doc(`maps_quota/${A.uid}_${quotaDay(now)}`).get()).data();
    expect(quota?.meetup).toBe(1);

    const again = await meetupSuggest(ctxOf(A, now + 1_000), sugIn(twoOf()), gdeps(g.fetch));
    expect(again.cached).toBe(true);
    expect(again.suggestions).toEqual(r.suggestions);
    expect(g.calls).toHaveLength(3);
    expect((await db().doc(`maps_quota/${A.uid}_${quotaDay(now)}`).get()).data()?.meetup).toBe(1);
    // Önbellek kullanıcıya özel: başka kullanıcı aynı konumlarla önbellekten almaz.
    expect((await meetupSuggest(ctxOf(C, now), sugIn([{ key: 'me', position: ME, mode: 'DRIVE' }, { key: B.uid, position: BORA, mode: 'WALK' }]), gdeps(g.fetch))).cached).toBe(false);
  });

  it('too_close / too_far / places_unavailable / quota_exceeded / no_results yedekleri; anahtar kuralları', async () => {
    const g = fakeGoogle();
    const now = Date.now();
    const close = await meetupSuggest(ctxOf(B, now), sugIn(twoOf(ME, { lat: 41.0004, lng: 29.0 })), gdeps(g.fetch));
    expect(close.fallback).toBe('too_close');
    expect(close.suggestions).toHaveLength(1);
    expect(close.suggestions[0]?.place).toMatchObject({ place_id: null, name: 'Orta nokta', category: 'midpoint' });
    expect(close.suggestions[0]?.etas.every((e) => e.estimated)).toBe(true);
    const far = await meetupSuggest(ctxOf(B, now), sugIn(twoOf(ME, { lat: 39.9, lng: 32.85 })), gdeps(g.fetch));
    expect(far).toMatchObject({ fallback: 'too_far', suggestions: [] });
    expect(g.calls).toHaveLength(0);

    // Anahtar yok / kesme anahtarı: yalnızca orta nokta, Google'a gidilmez.
    const noKey = await meetupSuggest(ctxOf(B, now), sugIn(twoOf()), gdeps(g.fetch, { apiKey: () => null }));
    expect(noKey.fallback).toBe('places_unavailable');
    expect(noKey.suggestions.map((s) => s.place.category)).toEqual(['midpoint']);
    const killed = await meetupSuggest(ctxOf(B, now), sugIn(twoOf()), gdeps(g.fetch, { budget: async () => ({ disabled: true, route: 1, geocode: 1 }) }));
    expect(killed.fallback).toBe('places_unavailable');
    expect(g.calls).toHaveLength(0);
    // Places HTTP hatası da aynı yedeğe düşer.
    const g500 = fakeGoogle({ placesStatus: 503 });
    expect((await meetupSuggest(ctxOf(B, now), sugIn(twoOf()), gdeps(g500.fetch))).fallback).toBe('places_unavailable');

    // Places 0 sonuç → no_results + orta nokta.
    const g0 = fakeGoogle({ places: {} });
    const none = await meetupSuggest(ctxOf(B, now), sugIn(twoOf(ME, { lat: 41.04, lng: 29.0 })), gdeps(g0.fetch));
    expect(none).toMatchObject({ fallback: 'no_results' });
    expect(none.suggestions[0]?.place.category).toBe('midpoint');

    // Günlük kota doluysa: quota_exceeded + orta nokta.
    await db().doc(`maps_quota/${X.uid}_${quotaDay(now)}`).set({ uid: X.uid, meetup: MEETUP_LIMITS.perUserDailyLimit });
    const q = await meetupSuggest(ctxOf(X, now), sugIn(twoOf()), gdeps(g.fetch));
    expect(q.fallback).toBe('quota_exceeded');
    expect(q.suggestions.map((s) => s.place.category)).toEqual(['midpoint']);
    expect(g.calls).toHaveLength(0);

    // 'me' yok ya da yinelenen anahtar: invalid_argument (callable üzerinden; emülatörde anahtar yok).
    const noMe = await callError('meetup_suggest', { op_id: opId(), category: 'cafe', participants: [{ key: B.uid, position: ME, mode: 'DRIVE' }, { key: C.uid, position: BORA, mode: 'DRIVE' }] }, A);
    expect(noMe.details?.code).toBe('invalid_argument');
    const dup = await callError('meetup_suggest', { op_id: opId(), category: 'cafe', participants: [{ key: 'me', position: ME, mode: 'DRIVE' }, { key: 'me', position: BORA, mode: 'DRIVE' }] }, A);
    expect(dup.details?.code).toBe('invalid_argument');
    const emu = await call('meetup_suggest', { op_id: opId(), category: 'transit', participants: twoOf() }, A);
    expect(emu.fallback).toBe('places_unavailable');
  });
});

// ---------------------------------------------------------------------------
// meetup_share / meetup_respond / meetup_cancel
// ---------------------------------------------------------------------------

describe('meetup_share → meetup_respond → meetup_cancel', () => {
  it("alıcılar arkadaşlarla süzülür, 'me' uid'e çevrilir, push'lar koordinatsız; yanıt önerene gider; iptal sonrası yanıt yok", async () => {
    const fcm = fakeFcm();
    const now = Date.now();
    const place = { place_id: 'p1', name: 'Moda Kahve', address: 'Moda Cd. 1', location: { lat: 40.98765, lng: 29.02345 }, primary_type: 'cafe', category: 'cafe' };
    const shareIn = (to: string[]) =>
      MeetupShareRequestSchema.parse({
        op_id: opId(),
        to,
        place,
        etas: [
          { key: 'me', duration_s: 540, distance_m: 4_100, estimated: false },
          { key: B.uid, duration_s: 720, distance_m: 900, estimated: true },
        ],
        note: '  Kapıda   bekliyorum ',
      });
    const r = await meetupShare(ctxOf(A, now), shareIn([B.uid, X.uid]), fcm);
    const m = r.meetup;
    expect(m).toMatchObject({ from: A.uid, from_name: 'Ayşe', to: [B.uid], status: 'active', responses: {}, note: 'Kapıda bekliyorum', created_at: now, expires_at: now + MEETUP_LIMITS.shareTtlMs });
    // Faz 8: yalnızca önerenin ETA'sı saklanır (başka katılımcınınki süzgeç sonucuyla onun görünmezliğini sızdırırdı).
    expect(m.etas.map((e) => e.key)).toEqual([A.uid]);
    expect(fcm.sent).toHaveLength(1);
    expect(fcm.sent[0]?.uid).toBe(B.uid);
    expect(fcm.sent[0]?.msg.data).toEqual({ type: 'meetup', meetup_id: m.meetup_id, from: A.uid });
    expect(fcm.sent[0]?.msg.notification).toEqual({ title: 'Ayşe', body: 'Buluşma noktası önerdi: Moda Kahve' });
    expect(JSON.stringify(fcm.sent)).not.toMatch(/40\.98|29\.02/);
    expect(await codeOf(meetupShare(ctxOf(A, now), shareIn([X.uid]), fcm))).toBe('not_friends');

    // B kabul eder → önerene push; aynı yanıt tekrarı push üretmez.
    const resp = await meetupRespond(ctxOf(B, now + 1_000), { op_id: opId(), meetup_id: m.meetup_id, response: 'accepted' }, fcm);
    expect(resp.meetup.responses).toEqual({ [B.uid]: 'accepted' });
    expect(fcm.sent[1]?.uid).toBe(A.uid);
    expect(fcm.sent[1]?.msg.data).toEqual({ type: 'meetup_response', meetup_id: m.meetup_id, by: B.uid, response: 'accepted' });
    expect(fcm.sent[1]?.msg.notification?.body).toBe('Moda Kahve için "Geliyorum" dedi');
    await meetupRespond(ctxOf(B, now + 2_000), { op_id: opId(), meetup_id: m.meetup_id, response: 'accepted' }, fcm);
    expect(fcm.sent).toHaveLength(2);

    // Alıcı olmayan / yok: meetup_not_found (callable üzerinden).
    const e = await callError('meetup_respond', { op_id: opId(), meetup_id: m.meetup_id, response: 'declined' }, C);
    expect(e.details?.code).toBe('meetup_not_found');
    expect(e.status).toBe('NOT_FOUND');
    expect(await codeOf(meetupCancel(ctxOf(B), { op_id: opId(), meetup_id: m.meetup_id }))).toBe('meetup_not_found');

    // Öneren iptal eder (alıcıya push yok); sonra yanıt verilemez.
    const c = await meetupCancel(ctxOf(A, now + 3_000), { op_id: opId(), meetup_id: m.meetup_id });
    expect(c.meetup.status).toBe('cancelled');
    expect(fcm.sent).toHaveLength(2);
    expect(await codeOf(meetupRespond(ctxOf(B, now + 4_000), { op_id: opId(), meetup_id: m.meetup_id, response: 'declined' }, fcm))).toBe('meetup_not_found');

    // Süpürücü süresi geçen öneriyi siler.
    const sw = await sweepExpired({ now: now + MEETUP_LIMITS.shareTtlMs + 1, audit: false });
    expect(sw.purged_meetups).toBeGreaterThanOrEqual(1);
    expect((await db().doc(`meetups/${m.meetup_id}`).get()).exists).toBe(false);
  });
});
