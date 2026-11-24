import { describe, expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  initialSharingState,
  resolveDuration,
  selectPublishTargets,
  selectSessions,
  sharingReducer,
  type OutgoingShareView,
  type SharingEvent,
  type SharingState,
} from '../src';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const run = (events: SharingEvent[], s: SharingState = initialSharingState(NOW)) => events.reduce(sharingReducer, s);

const share = (receiver: string, over: Partial<OutgoingShareView> = {}): OutgoingShareView => ({
  share_id: `me_${receiver}`,
  session_id: 's1',
  receiver_id: receiver,
  status: 'active',
  share_mode: 'timed',
  started_at: NOW,
  expires_at: NOW + HOUR,
  end_reason: null,
  version: 1,
  ...over,
});

const start: SharingEvent = {
  type: 'START_REQUESTED',
  op_id: 'op1',
  session_id: 's1',
  receiver_ids: ['a', 'b'],
  resolved: resolveDuration({ kind: 'preset', preset: 'h1' }, NOW),
  now: NOW,
};

describe('paylaşım durum makinesi', () => {
  it('sunucu onaylamadan yayın hedefi yoktur', () => {
    const s = run([start]);
    expect(selectSessions(s)[0]).toMatchObject({ phase: 'starting', confirmed: false });
    expect(selectPublishTargets(s)).toEqual([]);
  });

  it('onaydan sonra aktif ve iki alıcıya yayın', () => {
    const s = run([start, { type: 'START_SUCCEEDED', session_id: 's1', shares: [share('a'), share('b')] }]);
    expect(selectSessions(s)[0]).toMatchObject({ phase: 'active', active_receiver_ids: ['a', 'b'], expires_at: NOW + HOUR });
    expect(selectPublishTargets(s).map((t) => t.receiver_id)).toEqual(['a', 'b']);
  });

  it('başlatma hatası', () => {
    const s = run([start, { type: 'START_FAILED', session_id: 's1', error: { code: 'not_friends', message: 'x' } }]);
    expect(selectSessions(s)[0]).toMatchObject({ phase: 'failed', error: { code: 'not_friends' } });
    expect(selectSessions(run([{ type: 'DISMISS', session_id: 's1' }], s))).toEqual([]);
  });

  it('süre dolmak üzere → uzatma → aktif', () => {
    let s = run([start, { type: 'START_SUCCEEDED', session_id: 's1', shares: [share('a')] }]);
    s = run([{ type: 'TICK', now: NOW + 50 * MINUTE }], s);
    expect(selectSessions(s)[0]!.phase).toBe('expiring_soon');
    s = run([{ type: 'EXTEND_REQUESTED', session_id: 's1', op_id: 'op2', minutes: 30 }], s);
    expect(selectSessions(s)[0]!.phase).toBe('extending');
    expect(selectPublishTargets(s)).toHaveLength(1); // uzatma sırasında yayın sürer
    s = run([{ type: 'EXTEND_SUCCEEDED', session_id: 's1', shares: [share('a', { expires_at: NOW + 90 * MINUTE, version: 2 })] }], s);
    expect(selectSessions(s)[0]).toMatchObject({ phase: 'active', expires_at: NOW + 90 * MINUTE });
  });

  it('süre yerel saatle dolunca yayın sunucu yanıtını beklemeden durur', () => {
    let s = run([start, { type: 'START_SUCCEEDED', session_id: 's1', shares: [share('a')] }]);
    s = run([{ type: 'TICK', now: NOW + HOUR }], s);
    expect(selectPublishTargets(s)).toEqual([]);
    expect(selectSessions(s)[0]).toMatchObject({ phase: 'ended', end_reason: 'expired' });
  });

  it('Durdur: yayın anında kesilir; sunucu hatası olsa da kapalı kalır', () => {
    let s = run([start, { type: 'START_SUCCEEDED', session_id: 's1', shares: [share('a')] }]);
    s = run([{ type: 'STOP_REQUESTED', session_id: 's1', op_id: 'op3' }], s);
    expect(selectPublishTargets(s)).toEqual([]);
    expect(selectSessions(s)[0]!.phase).toBe('stopping');
    const failed = run([{ type: 'STOP_FAILED', session_id: 's1', error: { code: 'unavailable', message: 'x' } }], s);
    expect(selectPublishTargets(failed)).toEqual([]);
    const ok = run([{ type: 'STOP_SUCCEEDED', session_id: 's1', shares: [share('a', { status: 'ended', end_reason: 'stopped_by_sender', version: 2 })] }], s);
    expect(selectSessions(ok)[0]).toMatchObject({ phase: 'ended', end_reason: 'stopped_by_sender' });
  });

  it('sunucu anlık görüntüsü kazanır: alıcılardan biri kapatırsa yalnızca o düşer', () => {
    let s = run([start, { type: 'START_SUCCEEDED', session_id: 's1', shares: [share('a'), share('b')] }]);
    s = run([{ type: 'SERVER_SNAPSHOT', shares: [share('a'), share('b', { status: 'ended', end_reason: 'revoked_by_receiver', version: 2 })] }], s);
    const session = selectSessions(s)[0]!;
    expect(session.active_receiver_ids).toEqual(['a']);
    expect(session.ended_receivers).toEqual([{ receiver_id: 'b', reason: 'revoked_by_receiver' }]);
    expect(selectPublishTargets(s).map((t) => t.receiver_id)).toEqual(['a']);
  });

  it('geç gelen eski sürüm yeni sürümü ezemez', () => {
    let s = run([start, { type: 'START_SUCCEEDED', session_id: 's1', shares: [share('a', { version: 3, status: 'ended', end_reason: 'blocked' })] }]);
    s = run([{ type: 'EXTEND_SUCCEEDED', session_id: 's1', shares: [share('a', { version: 2 })] }], s);
    expect(selectPublishTargets(s)).toEqual([]);
  });

  it('süresiz oturumun bitişi ve uyarısı yoktur', () => {
    const s = run([
      { ...start, resolved: resolveDuration({ kind: 'indefinite' }, NOW) },
      { type: 'START_SUCCEEDED', session_id: 's1', shares: [share('a', { share_mode: 'indefinite', expires_at: null })] },
      { type: 'TICK', now: NOW + 400 * HOUR },
    ]);
    expect(selectSessions(s)[0]).toMatchObject({ phase: 'active', expires_at: null, prompt_at: null });
  });
});
