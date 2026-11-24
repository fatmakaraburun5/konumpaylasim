/**
 * Alıcı tarafı görünürlük: paylaşım belgesi varsa karar ondan (uzatma sonrası eski paketin bitişi
 * arkadaşı gizlemez); belge yoksa paketin bitişi kullanılır; biten paylaşım hemen gizlenir.
 */
import { HOUR, MINUTE, type DeliveredLocation } from '@konum/core';
import type { ShareDoc } from '../src/lib/schemas';
import { selectVisibleIncoming } from '../src/state/incomingStore';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const loc = (over: Partial<DeliveredLocation> = {}): DeliveredLocation => ({
  v: 1,
  share_id: 'u1_me',
  sender_id: 'u1',
  lat: 41,
  lng: 29,
  accuracy: 10,
  speed_mps: null,
  heading: null,
  battery_pct: 80,
  is_charging: false,
  activity_state: 'still',
  timestamp: NOW - 10 * MINUTE,
  expires_at: NOW - MINUTE, // eski bitiş (uzatmadan önceki paket)
  share_mode: 'timed',
  server_ts: NOW - 10 * MINUTE,
  ...over,
});
const doc = (over: Partial<ShareDoc> = {}): ShareDoc => ({
  share_id: 'u1_me',
  session_id: 's1',
  sender_id: 'u1',
  receiver_id: 'me',
  status: 'active',
  share_mode: 'timed',
  started_at: NOW - HOUR,
  expires_at: NOW + 29 * MINUTE, // +30 dk uzatıldı
  ended_at: null,
  end_reason: null,
  version: 2,
  ...over,
});

describe('selectVisibleIncoming', () => {
  it('uzatılan paylaşım: paket eski bitişi taşısa da arkadaş görünür, bitiş belgeden gelir', () => {
    const out = selectVisibleIncoming({ shares: { u1_me: doc() }, locations: { u1_me: loc() }, hiddenSenders: {} }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ senderId: 'u1', expiresAt: NOW + 29 * MINUTE, freshness: 'recent' });
  });

  it('belge yoksa paketin bitişi geçerlidir', () => {
    expect(selectVisibleIncoming({ shares: {}, locations: { u1_me: loc() }, hiddenSenders: {} }, NOW)).toEqual([]);
    expect(selectVisibleIncoming({ shares: {}, locations: { u1_me: loc({ expires_at: NOW + MINUTE }) }, hiddenSenders: {} }, NOW)).toHaveLength(1);
  });

  it('belge bitti ya da süresi doldu → gizli', () => {
    expect(selectVisibleIncoming({ shares: { u1_me: doc({ status: 'ended' }) }, locations: { u1_me: loc() }, hiddenSenders: {} }, NOW)).toEqual([]);
    expect(selectVisibleIncoming({ shares: { u1_me: doc({ expires_at: NOW }) }, locations: { u1_me: loc() }, hiddenSenders: {} }, NOW)).toEqual([]);
  });
});
