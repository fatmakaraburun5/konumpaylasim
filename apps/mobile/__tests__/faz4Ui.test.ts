/**
 * Faz 4 arayüz saf mantığı: ping kartı/pin seçimi, SOS görenler özeti, rota paketi, erken bırakma ipucu.
 */
import { SOS_LIMITS, sosFlowReduce, type Ping, type SosAlert, type SosFlowState } from '@konum/core';
import { pingPins, pingToastItem } from '../src/features/ping/pingModel';
import { isEarlyRelease, sosAckRows, sosAckSummary, sosPins, sosRouteFrom } from '../src/features/sos/sosModel';

const NOW = 1_800_000_000_000;
const ping = (id: string, from: string, sentAgo: number, withLoc = true): Ping => ({
  ping_id: id,
  from,
  kind: 'here',
  sent_at: NOW - sentAgo,
  expires_at: NOW - sentAgo + 15 * 60_000,
  location: withLoc ? { lat: 41, lng: 29, accuracy: 10, timestamp: NOW - sentAgo } : null,
  eta_s: null,
});

describe('ping arayüzü', () => {
  const inbox = { a: ping('a', 'u1', 5_000), b: ping('b', 'u1', 1_000), c: ping('c', 'u2', 2_000, false), old: ping('old', 'u3', 20 * 60_000) };

  it('kayan kart en yeni, gizlenmemiş, süresi geçmemiş pingi gösterir', () => {
    expect(pingToastItem(inbox, new Set(), NOW)?.ping_id).toBe('b');
    expect(pingToastItem(inbox, new Set(['b']), NOW)?.ping_id).toBe('c');
    expect(pingToastItem({ old: inbox.old }, new Set(), NOW)).toBeNull();
  });

  it('ping pini: konumlu, göndereni canlı değil, kişi başına en yeni', () => {
    expect(pingPins(inbox, new Set(), NOW).map((p) => p.ping_id)).toEqual(['b']);
    expect(pingPins(inbox, new Set(['u1']), NOW)).toEqual([]);
  });
});

const alert = (over: Partial<SosAlert> = {}): SosAlert => ({
  sos_id: 's1',
  sender_id: 'ayse',
  sender_name: 'Ayşe',
  recipient_ids: ['me', 'mehmet', 'zeynep'],
  status: 'active',
  resolve_reason: null,
  message: 'x',
  location: { lat: 41, lng: 29, accuracy: 8, timestamp: NOW },
  address: null,
  maps_url: '',
  battery_pct: 23,
  is_charging: false,
  route: null,
  created_at: NOW,
  updated_at: NOW,
  resolved_at: null,
  acks: {},
  update_count: 0,
  ...over,
});

describe('SOS arayüzü', () => {
  it('görenler önce (erken gören üstte), özet metni', () => {
    const a = alert({ acks: { zeynep: NOW + 5, mehmet: NOW + 9 } });
    expect(sosAckRows(a, { me: 'Ben', mehmet: 'Mehmet' }).map((r) => r.uid)).toEqual(['zeynep', 'mehmet', 'me']);
    expect(sosAckSummary(a)).toBe('3 kişiden 2 kişi gördü');
    expect(sosAckSummary(alert())).toBe('3 kişiye iletildi, henüz görülmedi');
  });

  it('açık rota → SOS rotası; rota yoksa null', () => {
    expect(sosRouteFrom('Mehmet', { duration_s: 612.4, distance_m: 4180.6 })).toEqual({ destination_label: 'Mehmet', eta_s: 612, distance_m: 4181 });
    expect(sosRouteFrom('Mehmet', null)).toBeNull();
  });

  it('SOS pini yalnızca canlı pini olmayan aktif uyarılar için', () => {
    const list = [alert(), alert({ sos_id: 's2', sender_id: 'ali' }), alert({ sos_id: 's3', sender_id: 'can', status: 'resolved', resolved_at: NOW })];
    expect(sosPins(list, new Set(['ali'])).map((a) => a.sos_id)).toEqual(['s1']);
  });

  it('erken bırakma ipucu; tam basılı tutma geri sayıma geçer', () => {
    let s: SosFlowState = sosFlowReduce({ phase: 'idle' }, { type: 'press_in', at: 0 });
    const early = sosFlowReduce(s, { type: 'press_out', at: SOS_LIMITS.holdMs - 1 });
    expect(isEarlyRelease(s.phase, early.phase)).toBe(true);
    s = sosFlowReduce(s, { type: 'tick', at: SOS_LIMITS.holdMs });
    expect(s.phase).toBe('countdown');
    expect(isEarlyRelease('holding', s.phase)).toBe(false);
  });
});
