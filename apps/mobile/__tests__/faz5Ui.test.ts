/**
 * Faz 5 arayüz saf mantığı: kural özeti / gün maskesi / son olay metni / izleme bandı ve buluşma sonuç satırları,
 * yedek metinler, yanıt satırları, yol tarifi bağlantısı.
 */
import { ALL_DAYS_MASK, fixedOffset, type MeetupSuggestResponse, type Zone, type ZoneRule } from '@konum/core';
import {
  defaultMeetupMode,
  directionsUrl,
  MEETUP_FALLBACK_TEXT,
  meetAtOptions,
  participantPoints,
  responseRows,
  showsCenterMark,
  suggestionRows,
  toggleMeetupFriend,
} from '../src/features/meetup/meetupModel';
import {
  applyTemplate,
  clampZoneRadius,
  describeDays,
  monitoringBanner,
  nameOnKindChange,
  recentEventText,
  ruleFromTemplate,
  ruleSummary,
  stepMinuteOfDay,
  toggleDay,
  turkishDative,
  validateRule,
  WEEKDAYS_MASK,
} from '../src/features/zones/zoneModel';

const names = { ayse: 'Ayşe', can: 'Can', mehmet: 'Mehmet', zeynep: 'Zeynep' };
const utc3 = fixedOffset(180);
const rule = (over: Partial<ZoneRule> = {}): ZoneRule => ({ ...ruleFromTemplate('arrive_notify', 'r1', ['ayse']), ...over });
const zone = (rules: ZoneRule[]): Zone => ({
  zone_id: 'z1',
  owner_id: 'me',
  kind: 'home',
  name: 'Ev',
  emoji: null,
  center: { lat: 41, lng: 29 },
  radius_m: 150,
  rules,
  enabled: true,
  time_zone: 'Europe/Istanbul',
  created_at: 1,
  updated_at: 1,
});

describe('bölge arayüzü', () => {
  it('Türkçe yönelme eki', () => {
    expect(turkishDative('Ayşe')).toBe("Ayşe'ye");
    expect(turkishDative('Can')).toBe("Can'a");
    expect(turkishDative('Mehmet')).toBe("Mehmet'e");
    expect(turkishDative('JR')).toBeNull();
  });

  it('kural özeti: alıcı yönelme ekiyle, süre ve gün/saat eklenir', () => {
    expect(ruleSummary(rule(), 'Ev', names)).toBe("Ev konumuna vardığımda Ayşe'ye bildir");
    expect(ruleSummary(rule({ recipient_ids: ['ayse', 'can', 'mehmet'] }), 'Ev', names)).toBe('Ev konumuna vardığımda Ayşe ve 2 kişiye bildir');
    const share = applyTemplate(rule({ days_mask: WEEKDAYS_MASK, window: { from_min: 480, to_min: 1080 } }), 'leave_share');
    expect(share.share_duration).toEqual({ kind: 'preset', preset: 'h1' });
    expect(ruleSummary(share, 'İş', names)).toBe('İş konumundan çıktığımda Ayşe ile paylaşımı başlat · 1 saat · Hafta içi 08:00–18:00');
    expect(applyTemplate(share, 'arrive_notify').share_duration).toBeNull();
  });

  it('kural denetimi ve gün maskesi', () => {
    expect(validateRule(rule({ recipient_ids: [] }))).toBe('En az bir kişi seç.');
    expect(validateRule(rule())).toBeNull();
    expect(validateRule({ ...applyTemplate(rule(), 'leave_share'), share_duration: { kind: 'weekly' } })).toBe('Paylaşım süresini seç.');
    expect(toggleDay(1, 0)).toBe(1); // son gün kapanmaz
    expect(toggleDay(ALL_DAYS_MASK, 6)).toBe(63);
    expect(describeDays(ALL_DAYS_MASK)).toBe('Her gün');
    expect(describeDays(0b0000101)).toBe('Pzt, Çar');
    expect(stepMinuteOfDay(0, -1)).toBe(1410);
    expect(clampZoneRadius(5_000)).toBe(2_000);
    expect(clampZoneRadius(42)).toBe(100);
  });

  it('tür değişince yalnızca varsayılan ad değişir', () => {
    expect(nameOnKindChange('home', 'work', 'Ev')).toBe('İş');
    expect(nameOnKindChange('home', 'work', '')).toBe('İş');
    expect(nameOnKindChange('home', 'work', 'Annemler')).toBe('Annemler');
  });

  it('son olay metni: bildirilen kişi adı ya da bastırma nedeni', () => {
    const at = Date.UTC(2026, 10, 24, 15, 42); // 18:42 (UTC+3)
    const z = zone([rule()]);
    expect(recentEventText({ zone_id: 'z1', transition: 'arrive', at, notified: 1, suppressed: null }, z, names, utc3)).toBe("Ev · vardın · 18:42 · Ayşe'ye bildirildi");
    expect(recentEventText({ zone_id: 'z1', transition: 'leave', at, notified: 0, suppressed: 'cooldown' }, z, names, utc3)).toBe('Ev · ayrıldın · 18:42 · az önce bildirilmişti');
    expect(recentEventText({ zone_id: 'zz', transition: 'arrive', at, notified: 3, suppressed: null }, undefined, names, utc3)).toBe('Silinmiş bölge · vardın · 18:42 · 3 kişiye bildirildi');
  });

  it('izleme bandı', () => {
    expect(monitoringBanner('needs_permission', 1)?.action).toBe('İzni ver');
    expect(monitoringBanner('needs_permission', 1)?.text).toContain("'Her zaman'");
    expect(monitoringBanner('needs_permission', 0)).toBeNull();
    expect(monitoringBanner('off', 2)).toBeNull();
  });
});

const result: MeetupSuggestResponse = {
  center: { lat: 40.99, lng: 29.03 },
  search_radius_m: 500,
  suggestions: [
    {
      place: { place_id: 'p1', name: 'Moda Kahve Durağı', address: 'Moda Cd. 1', location: { lat: 40.99, lng: 29.033 }, primary_type: 'cafe', category: 'cafe' },
      etas: [
        { key: 'ayse', duration_s: 720, distance_m: 900, estimated: false },
        { key: 'me', duration_s: 540, distance_m: 700, estimated: true },
      ],
      score: 800,
      max_duration_s: 720,
      spread_s: 180,
    },
  ],
  fallback: null,
  cached: false,
  server_now: 1,
};

describe('buluşma noktası arayüzü', () => {
  it('sonuç satırı: ad, ETA satırı (tahmini "~"), orta noktaya uzaklık', () => {
    const [row] = suggestionRows(result, names);
    expect(row?.number).toBe(1);
    expect(row?.etas).toBe('Ayşe 12 dk · Sen ~9 dk');
    expect(row?.estimated).toBe(true);
    expect(row?.fromCenter).toMatch(/^Orta noktaya /);
    expect(row?.emoji).toBe('☕');
    expect(suggestionRows(null, names)).toEqual([]);
  });

  it('yedek metinler ve orta nokta işareti', () => {
    expect(MEETUP_FALLBACK_TEXT.too_close).toBe('Zaten birbirinize çok yakınsınız');
    expect(MEETUP_FALLBACK_TEXT.quota_exceeded).toBe('Yalnızca orta nokta gösteriliyor');
    expect(showsCenterMark(result)).toBe(true);
    const mid = { ...result, suggestions: [{ ...result.suggestions[0]!, place: { ...result.suggestions[0]!.place, category: 'midpoint' as const } }] };
    expect(showsCenterMark(mid)).toBe(false);
  });

  it('katılımcılar: görünmeyen arkadaş eksik, seçili hedef konumun yerine geçer; mod yayılıma göre', () => {
    const me = { lat: 41, lng: 29 };
    const r = participantPoints(['ayse', 'can'], me, { ayse: { lat: 41.001, lng: 29.001 } }, { me: { lat: 41.002, lng: 29 } });
    expect(r.points.map((p) => p.key)).toEqual(['me', 'ayse']);
    expect(r.points[0]?.position).toEqual({ lat: 41.002, lng: 29 });
    expect(r.missing).toEqual(['can']);
    expect(defaultMeetupMode(r.points.map((p) => p.position))).toBe('WALK');
    expect(defaultMeetupMode([me, { lat: 41.2, lng: 29.2 }])).toBe('DRIVE');
    expect(toggleMeetupFriend(['a', 'b', 'c', 'd'], 'e').error).toMatch(/En çok 4/);
  });

  it('yanıt satırları, yol tarifi, buluşma saati', () => {
    expect(responseRows({ to: ['ayse', 'can'], responses: { ayse: 'accepted' } }, names).map((r) => r.text)).toEqual(['Ayşe: Geliyorum', 'Can: Yanıt bekleniyor']);
    expect(directionsUrl({ lat: 40.99, lng: 29.03 })).toBe('https://www.google.com/maps/dir/?api=1&destination=40.99,29.03');
    const opts = meetAtOptions(Date.UTC(2026, 10, 24, 15, 2), utc3);
    expect(opts[0]).toEqual({ id: 'none', label: 'Saat yok', at: null });
    expect(opts[1]?.label).toBe('30 dk sonra · 18:35');
  });
});
