import { describe, expect, it } from 'vitest';
import {
  classifyZoneSample,
  geoMidpoint,
  haversineM,
  initialZoneFilterState,
  inTimeWindow,
  localClock,
  matchZoneRules,
  meetupCenter,
  parseRouteMatrixResponse,
  rankMeetupCandidates,
  zoneFilterReduce,
  type ZoneFilterState,
  type ZoneRule,
  type ZoneSample,
} from '../src';

const zone = { center: { lat: 41.0, lng: 29.0 }, radius_m: 150 };
/** Merkezden kuzeye `m` metre. */
const north = (m: number) => ({ lat: 41.0 + m / 111_320, lng: 29.0 });
const s = (m: number, at: number, accuracy = 10): ZoneSample => ({ ...north(m), accuracy, at });

function run(samples: ZoneSample[], start: ZoneFilterState = initialZoneFilterState()) {
  let st = start;
  const emits: string[] = [];
  for (const x of samples) {
    const r = zoneFilterReduce(zone, st, { type: 'sample', sample: x });
    st = r.state;
    if (r.emit) emits.push(r.emit);
  }
  return { st, emits };
}

describe('Faz 5 bölge sapma filtresi', () => {
  it('sınıflandırma: içeri / gri bant / dışarı', () => {
    expect(classifyZoneSample(zone, { ...north(50), accuracy: 20 })).toBe('inside');
    expect(classifyZoneSample(zone, { ...north(160), accuracy: 10 })).toBe('grey');
    expect(classifyZoneSample(zone, { ...north(260), accuracy: 20 })).toBe('outside');
  });

  it('ilk örnek durumu tetik üretmeden kurar (evde açılınca "vardı" gitmez)', () => {
    const r = run([s(20, 0)]);
    expect(r.st.presence).toBe('inside');
    expect(r.emits).toEqual([]);
  });

  it('tek sapmalı örnek çıkış üretmez; iki güvenli örnek (≥20 sn) üretir', () => {
    const inside = run([s(20, 0)]).st;
    expect(run([s(400, 10 * 60_000)], inside).emits).toEqual([]);
    expect(run([s(400, 10 * 60_000), s(420, 10 * 60_000 + 30_000)], inside).emits).toEqual(['leave']);
  });

  it('kötü doğruluk ve ışınlanma yok sayılır', () => {
    const inside = run([s(20, 0)]).st;
    expect(zoneFilterReduce(zone, inside, { type: 'sample', sample: s(400, 60_000, 400) }).reason).toBe('low_accuracy');
    expect(zoneFilterReduce(zone, inside, { type: 'sample', sample: s(50_000, 10_000) }).reason).toBe('teleport');
  });

  it('gri bantta salınım durum değiştirmez', () => {
    const inside = run([s(20, 0)]).st;
    const r = run([s(160, 60_000), s(170, 120_000), s(155, 180_000), s(165, 240_000)], inside);
    expect(r.st.presence).toBe('inside');
    expect(r.emits).toEqual([]);
  });

  it('çıkıştan hemen sonra geri dönüş min_stay ile bastırılır', () => {
    const inside = run([s(20, 0)]).st;
    const out = run([s(400, 600_000), s(420, 630_000)], inside);
    expect(out.emits).toEqual(['leave']);
    const back = zoneFilterReduce(zone, out.st, { type: 'sample', sample: s(10, 660_000) });
    expect(back.emit).toBeNull();
    expect(back.reason).toBe('min_stay');
  });

  it('OS olayı yalnızca adaydır; taze konum dışarıdaysa varış olmaz', () => {
    const outside = run([s(800, 0)]).st;
    const os = zoneFilterReduce(zone, outside, { type: 'os_event', event: 'enter', at: 600_000 });
    expect(os.emit).toBeNull();
    const fix = zoneFilterReduce(zone, os.state, { type: 'sample', sample: s(800, 605_000) });
    expect(fix.emit).toBeNull();
    expect(fix.state.presence).toBe('outside');
  });
});

describe('Faz 5 kural eşleme', () => {
  const rule = (p: Partial<ZoneRule>): ZoneRule => ({
    rule_id: 'r',
    trigger: 'arrive',
    action: 'notify',
    recipient_ids: ['u2'],
    share_duration: null,
    days_mask: 127,
    window: null,
    enabled: true,
    ...p,
  });
  it('gün ve gece yarısını aşan saat penceresi', () => {
    expect(inTimeWindow({ from_min: 22 * 60, to_min: 6 * 60 }, 23 * 60)).toBe(true);
    expect(inTimeWindow({ from_min: 22 * 60, to_min: 6 * 60 }, 12 * 60)).toBe(false);
    // 2026-11-23 Pazartesi 09:00 İstanbul (UTC+3)
    const clock = localClock(Date.UTC(2026, 10, 23, 6, 0), 180);
    expect(clock).toEqual({ weekday: 0, minute: 540 });
    const z = { enabled: true, rules: [rule({}), rule({ rule_id: 'w', days_mask: 1 << 5 }), rule({ rule_id: 'l', trigger: 'leave' })] };
    expect(matchZoneRules(z, 'arrive', clock).map((r) => r.rule_id)).toEqual(['r']);
  });
});

describe('Faz 5 buluşma noktası', () => {
  it('orta nokta iki noktaya eşit uzaklıkta', () => {
    const a = { lat: 40.99, lng: 29.02 };
    const b = { lat: 41.04, lng: 28.98 };
    const m = geoMidpoint(a, b);
    expect(Math.abs(haversineM(a, m) - haversineM(b, m))).toBeLessThan(1);
  });

  it('geometrik medyan uç noktaya çekilmez', () => {
    const pts = [
      { lat: 41.0, lng: 29.0 },
      { lat: 41.001, lng: 29.0 },
      { lat: 41.2, lng: 29.0 },
    ];
    const c = meetupCenter(pts);
    expect(haversineM(c, pts[1]!)).toBeLessThan(200);
  });

  it('adalet sıralaması: daha dengeli aday önde, eksik ETA elenir', () => {
    const place = (name: string) => ({ place_id: name, name, address: null, location: { lat: 41, lng: 29 }, primary_type: null, category: 'cafe' as const });
    const eta = (key: string, d: number) => ({ key, duration_s: d, distance_m: 0, estimated: false });
    const ranked = rankMeetupCandidates(
      [
        { place: place('A'), etas: [eta('me', 300), eta('u2', 1500)] },
        { place: place('B'), etas: [eta('me', 800), eta('u2', 900)] },
        { place: place('C'), etas: [eta('me', 100)] },
      ],
      ['me', 'u2'],
      { lat: 41, lng: 29 },
    );
    expect(ranked.map((r) => r.place.name)).toEqual(['B', 'A']);
  });

  it('rota matrisi yanıtı ızgaraya çevrilir', () => {
    const g = parseRouteMatrixResponse(
      [
        { originIndex: 0, destinationIndex: 1, duration: '600s', distanceMeters: 4000, condition: 'ROUTE_EXISTS' },
        { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND' },
      ],
      2,
      2,
    );
    expect(g[0]![1]).toEqual({ duration_s: 600, distance_m: 4000 });
    expect(g[1]![0]).toBeNull();
  });
});
