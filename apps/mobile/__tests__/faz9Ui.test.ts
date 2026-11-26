/**
 * Faz 9 arayüz modelleri (saf): pin rozetleri, fotoğraf görüntüleyici hâli, Güvenli Dönüş geri sayımı, hedef metinleri.
 */
import { PROOF_TEXT, SAFE_RETURN_TEXT, type DeliveredLocation, type EventDoc, type Meetup } from '@konum/core';
import { eventMeetupOptions, myDestStatusText, pointDestName } from '../src/features/approach/destModel';
import { friendBadge, friendBadges } from '../src/features/map/friendBadges';
import { proofLeft, proofViewState } from '../src/features/proof/proofModel';
import { defaultSafeReturnZone, formatCountdown, isSafeReturnLive, safeReturnBannerText } from '../src/features/safeReturn/safeReturnModel';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const loc = (extra: Partial<DeliveredLocation>): DeliveredLocation =>
  ({ v: 1, lat: 41, lng: 29, accuracy: 10, timestamp: NOW, sender_id: 'ayse', expires_at: NOW + 60 * MIN, ...extra }) as unknown as DeliveredLocation;

describe('Faz 9 pin rozetleri', () => {
  it('fotoğraf yalnızca süresi geçmemişse, hedef ad + durumla', () => {
    const b = friendBadge(loc({ photo_id: 'A'.repeat(20), photo_exp: NOW + 52 * MIN, dest_name: 'Ev', dest_state: 'near', dest_eta: 1 }), NOW);
    expect(b?.photo).toEqual({ photo_id: 'A'.repeat(20), photo_exp: NOW + 52 * MIN });
    expect(b?.dest).toEqual({ text: 'Neredeyse vardı · Ev · ~1 dk', state: 'near' });
    expect(friendBadge(loc({ photo_id: 'A'.repeat(20), photo_exp: NOW - 1 }), NOW)).toBeNull();
    expect(friendBadges([{ shareId: 's1', location: loc({ dest_name: 'İş', dest_state: 'arrived' }) }, { shareId: 's2', location: loc({}) }], NOW)).toEqual({
      s1: { photo: null, dest: { text: 'İş konumuna vardı', state: 'arrived' } },
    });
  });
});

describe('Faz 9 fotoğraf görüntüleyici', () => {
  it('süre dolunca görsel her durumda gizlenir', () => {
    expect(proofViewState({ expiresAt: NOW + MIN, now: NOW, status: 'ready', uri: 'file://x' })).toBe('ready');
    expect(proofViewState({ expiresAt: NOW, now: NOW, status: 'ready', uri: 'file://x' })).toBe('expired');
    expect(proofViewState({ expiresAt: NOW + MIN, now: NOW, status: 'not_found', uri: null })).toBe('unavailable');
    expect(proofViewState({ expiresAt: NOW + MIN, now: NOW, status: 'loading', uri: null })).toBe('loading');
    expect(proofLeft(NOW + 52 * MIN, NOW).text).toBe('52 dk kaldı');
    expect(proofLeft(NOW - 1, NOW)).toEqual({ text: 'Süresi doldu', ratio: 0, expired: true });
    expect(PROOF_TEXT.expired).toBe('Fotoğrafın süresi doldu');
  });
});

describe('Faz 9 Güvenli Dönüş arayüzü', () => {
  it('geri sayım ve bant metni', () => {
    expect(formatCountdown(125_000)).toBe('02:05');
    expect(formatCountdown(65 * MIN)).toBe('1 sa 05 dk');
    expect(safeReturnBannerText('running', 'Ev', 12 * MIN)).toBe(SAFE_RETURN_TEXT.banner('Ev', '12:00'));
    expect(safeReturnBannerText('alarm', 'Ev', 0)).toBe(SAFE_RETURN_TEXT.alarmSent);
    expect(isSafeReturnLive('final_warning')).toBe(true);
    expect(isSafeReturnLive('ended')).toBe(false);
  });

  it('varsayılan hedef Ev bölgesi', () => {
    expect(defaultSafeReturnZone([{ zone_id: 'w', kind: 'work', name: 'İş' }, { zone_id: 'h', kind: 'home', name: 'Evim' }])).toBe('h');
    expect(defaultSafeReturnZone([{ zone_id: 'x', kind: 'custom', name: 'EV' }])).toBe('x');
    expect(defaultSafeReturnZone([])).toBeNull();
  });
});

describe('Faz 9 hedef metinleri', () => {
  it('gönderen durumu ve nokta adı', () => {
    expect(myDestStatusText('Ev', { state: 'near', distance_m: 150 })).toBe('Hedef: Ev · Neredeyse vardın');
    expect(myDestStatusText('Ev', { state: 'arrived', distance_m: 10 })).toBe('Hedef: Ev · Vardın');
    expect(myDestStatusText('Ev', null)).toBe('Hedef: Ev');
    expect(pointDestName('Bağdat Cd. No:12, Kadıköy, İstanbul')).toBe('Bağdat Cd. No:12');
    expect(pointDestName(null)).toBe('Seçilen nokta');
  });

  it('etkinlik mekanı ve buluşma noktası seçenekleri', () => {
    const ev = {
      event_id: 'e1',
      title: 'Doğum günü',
      venue_options: [{ option_id: 'v1', name: 'Kafe', address: null, location: { lat: 41, lng: 29 }, place_id: null }],
      venue_option_id: 'v1',
      end_reason: null,
      expires_at: NOW + 60 * MIN,
    } as unknown as EventDoc;
    const m = { meetup_id: 'm1', status: 'active', expires_at: NOW + MIN, place: { name: 'Meydan', location: { lat: 41.1, lng: 29.1 } } } as unknown as Meetup;
    const opts = eventMeetupOptions([ev], [m, { ...m, meetup_id: 'm2', status: 'cancelled' } as Meetup], NOW);
    expect(opts.map((o) => [o.kind, o.name])).toEqual([
      ['event', 'Kafe'],
      ['meetup', 'Meydan'],
    ]);
  });
});
