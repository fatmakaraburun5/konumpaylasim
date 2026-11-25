import { describe, expect, it } from 'vitest';
import {
  consentExemptCall,
  effectiveRequestStatus,
  incomingPendingRequests,
  LOCATION_REQUEST_LIMITS,
  LocationRequestCancelSchema,
  locationRequestAnsweredText,
  MINUTE,
  outgoingRequestState,
  outgoingStateText,
  REQUEST_DURATION_OPTIONS,
  type LocationRequest,
} from '../src';

const NOW = 1_764_000_000_000;
const req = (over: Partial<LocationRequest> = {}): LocationRequest => ({
  request_id: 'a_b',
  requester_id: 'a',
  target_id: 'b',
  status: 'pending',
  created_at: NOW,
  expires_at: NOW + LOCATION_REQUEST_LIMITS.ttlMs,
  responded_at: null,
  share_id: null,
  ...over,
});

describe('Konum İste', () => {
  it('süresi geçmiş bekleyen istek expired sayılır', () => {
    expect(effectiveRequestStatus(req(), NOW)).toBe('pending');
    expect(effectiveRequestStatus(req(), NOW + 15 * MINUTE)).toBe('expired');
    expect(effectiveRequestStatus(req({ status: 'rejected' }), NOW + 15 * MINUTE)).toBe('rejected');
  });

  it('isteyenin durumu: bekliyor → ret (bekleme süreli) → zamanla yeniden istenebilir', () => {
    expect(outgoingRequestState(null, false, NOW)).toEqual({ kind: 'none' });
    expect(outgoingRequestState(req(), true, NOW)).toEqual({ kind: 'sharing' });
    const p = outgoingRequestState(req(), false, NOW + MINUTE);
    expect(p.kind).toBe('pending');
    expect(outgoingStateText(p, NOW + MINUTE)).toBe('Konum isteği gönderildi · Yanıt bekleniyor (14 dk)');
    const r = outgoingRequestState(req({ status: 'rejected', responded_at: NOW + MINUTE }), false, NOW + 2 * MINUTE);
    expect(r).toEqual({ kind: 'rejected', request_id: 'a_b', retry_at: NOW + 10 * MINUTE });
    expect(outgoingRequestState(req({ status: 'rejected', responded_at: NOW + MINUTE }), false, NOW + 40 * MINUTE)).toEqual({ kind: 'none' });
    expect(outgoingRequestState(req({ status: 'approved', responded_at: NOW }), false, NOW + MINUTE)).toEqual({ kind: 'none' });
  });

  it('gelen bekleyenler: yalnızca bana ve süresi dolmamış, en yakın biten önde', () => {
    const list = [req({ request_id: 'x', expires_at: NOW + 9 * MINUTE }), req({ request_id: 'y', expires_at: NOW + 3 * MINUTE }), req({ request_id: 'z', target_id: 'c' }), req({ request_id: 'w', expires_at: NOW - 1 })];
    expect(incomingPendingRequests(list, 'b', NOW).map((d) => d.request_id)).toEqual(['y', 'x']);
  });

  it('ret sade metin; ret ve geri çekme onaysız çalışır, onaylamak çalışmaz', () => {
    expect(locationRequestAnsweredText('Ayşe', 'rejected').body).toBe('Ayşe şu an konumunu paylaşamıyor');
    expect(consentExemptCall('location_request_respond', { accept: false })).toBe(true);
    expect(consentExemptCall('location_request_respond', { accept: true })).toBe(false);
    expect(consentExemptCall('location_request_cancel', {})).toBe(true);
    expect(consentExemptCall('location_request_send', {})).toBe(false);
  });

  it('süre seçenekleri haftalık, süresiz ve saat seçimini içerir', () => {
    expect(REQUEST_DURATION_OPTIONS.map((o) => o.id)).toEqual(['m15', 'h1', 'h8', 'eod', 'week', 'forever', 'until']);
    expect(LocationRequestCancelSchema.safeParse({ op_id: '7f8a6a1c-2c1e-4b8e-9a51-0c6a1d2a3b4c', request_id: 'a_b' }).success).toBe(true);
  });
});
