import type { ShareSession } from '@konum/core';
import { buildDeckItems, collapsedSummary, cycle, focusIndex, itemStatus, itemTitle, peekCount, stoppable } from '../src/features/map/shareDeckModel';
import type { LinkSession } from '../src/state/linkStore';

const T0 = 1_764_000_000_000;
const MIN = 60_000;
const share = (id: string, to: string[], phase: ShareSession['phase'], minsLeft: number | null, over: Partial<ShareSession> = {}): ShareSession => ({
  session_id: id,
  phase,
  active_receiver_ids: to,
  ended_receivers: [],
  share_mode: 'duration',
  started_at: T0 - 10 * MIN,
  expires_at: minsLeft === null ? null : T0 + minsLeft * MIN,
  prompt_at: null,
  end_reason: null,
  error: null,
  confirmed: true,
  ...over,
} as ShareSession);
const link = (id: string, phase: LinkSession['phase'], minsLeft: number): LinkSession => ({
  link_id: id as LinkSession['link_id'],
  session_id: `ls_${id}`,
  token_hash: 'x',
  phase,
  share_mode: 'duration' as LinkSession['share_mode'],
  started_at: T0 - MIN,
  expires_at: T0 + minsLeft * MIN,
  prompt_at: null,
  end_reason: null,
  version: 1,
  extended_count: 0,
  url: null,
  error: null,
});
const names = { ayse: 'Ayşe Yılmaz', mehmet: 'Mehmet Demir', zeynep: 'Zeynep Arslan', can: 'Can Öztürk' };

describe('shareDeckModel', () => {
  it('sıralar: bitmek üzere > hata > süren (en az kalan önde, süresiz sonda) > biten', () => {
    const items = buildDeckItems(
      [
        share('a', ['ayse'], 'active', 60),
        share('b', ['mehmet'], 'ended', null, { end_reason: 'expired' }),
        share('c', ['zeynep'], 'active', null),
        share('d', ['can'], 'expiring_soon', 4),
        share('e', ['ayse'], 'failed', 60),
      ],
      [link('q', 'active', 15)],
    );
    expect(items.map((i) => i.key)).toEqual(['s:d', 's:e', 'l:q', 's:a', 's:c', 's:b']);
  });

  it('odak anahtarı yoksa ilk kart; halka gibi döner; arka katman en çok 2', () => {
    const items = buildDeckItems([share('a', ['ayse'], 'active', 10), share('b', ['mehmet'], 'active', 20)], []);
    expect(focusIndex(items, 'yok')).toBe(0);
    expect(focusIndex(items, 's:b')).toBe(1);
    expect(cycle(1, 1, 2)).toBe(0);
    expect(cycle(0, -1, 4)).toBe(3);
    expect([1, 2, 3, 4, 9].map(peekCount)).toEqual([0, 1, 2, 2, 2]);
  });

  it('başlık ve durum satırı', () => {
    const [one] = buildDeckItems([share('a', ['ayse'], 'active', 60)], []);
    expect(itemTitle(one!, names)).toBe('Ayşe Yılmaz');
    expect(itemStatus(one!, names, null)).toEqual({ text: 'Konumun paylaşılıyor', tone: 'live' });
    expect(itemStatus(one!, names, 'Konum alınamıyor').tone).toBe('warning');
    const [multi] = buildDeckItems([share('m', ['ayse', 'mehmet', 'zeynep'], 'active', 60)], []);
    expect(itemTitle(multi!, names)).toBe('Ayşe, Mehmet +1');
  });

  it('küçük çubuk özeti ve "Tümünü durdur" kapsamı', () => {
    const items = buildDeckItems(
      [share('a', ['ayse'], 'active', 60), share('b', ['mehmet'], 'starting', 60), share('c', ['can'], 'ended', null)],
      [link('q', 'stopping', 15)],
    );
    expect(collapsedSummary(items, names, T0).text).toMatch(/^3 paylaşım · ilk bitiş \d\d:\d\d$/);
    expect(stoppable(items).map((i) => i.key)).toEqual(['s:a']);
    const exp = buildDeckItems([share('d', ['can'], 'expiring_soon', 4)], []);
    expect(collapsedSummary(exp, names, T0)).toEqual({ text: 'Can Öztürk: 4 dk içinde bitiyor', tone: 'warning' });
  });
});
