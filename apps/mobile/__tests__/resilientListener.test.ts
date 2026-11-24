/**
 * Dinleyici hata verince geri çekilmeli yeniden abonelik; veri gelince geri çekilme sıfırlanır;
 * öne gelince / bağlantı dönünce bekleyen deneme hemen yapılır.
 */
import { resilientListener, type ListenerHandlers } from '../src/services/resilientListener';

describe('resilientListener', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function fake() {
    const subs: { h: ListenerHandlers; unsub: jest.Mock }[] = [];
    const subscribe = jest.fn((h: ListenerHandlers) => {
      const unsub = jest.fn();
      subs.push({ h, unsub });
      return unsub;
    });
    return { subs, subscribe };
  }

  it('hata → eski abonelik bırakılır → 2 sn, 5 sn sonra yeniden; veri gelince sağlıklı', () => {
    const f = fake();
    const status = jest.fn();
    const l = resilientListener('outgoing', f.subscribe, { onStatus: status });
    expect(f.subscribe).toHaveBeenCalledTimes(1);

    f.subs[0]!.h.error(new Error('permission-denied'));
    expect(f.subs[0]!.unsub).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('outgoing', false, expect.any(Error));
    expect(l.failing).toBe(true);
    jest.advanceTimersByTime(1_999);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(f.subscribe).toHaveBeenCalledTimes(2);

    f.subs[1]!.h.error(new Error('again'));
    jest.advanceTimersByTime(4_999);
    expect(f.subscribe).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(f.subscribe).toHaveBeenCalledTimes(3);

    f.subs[2]!.h.ok();
    expect(l.failing).toBe(false);
    expect(status).toHaveBeenLastCalledWith('outgoing', true);
    // Eski aboneliklerin geç gelen olayları yok sayılır.
    f.subs[0]!.h.error(new Error('late'));
    expect(l.failing).toBe(false);
    l.dispose();
    expect(f.subs[2]!.unsub).toHaveBeenCalled();
  });

  it('resubscribeNow bekleyen denemeyi hemen yapar; dispose sonrası deneme yok', () => {
    const f = fake();
    const l = resilientListener('inbox', f.subscribe);
    f.subs[0]!.h.error(new Error('x'));
    l.resubscribeNow();
    expect(f.subscribe).toHaveBeenCalledTimes(2);
    f.subs[1]!.h.error(new Error('y'));
    l.dispose();
    jest.advanceTimersByTime(120_000);
    expect(f.subscribe).toHaveBeenCalledTimes(2);
  });

  it('abonelik sırasında senkron hata da yeniden denenir', () => {
    let first = true;
    const subscribe = jest.fn((h: ListenerHandlers) => {
      if (first) {
        first = false;
        h.error(new Error('sync'));
      }
      return () => undefined;
    });
    resilientListener('friends', subscribe);
    jest.advanceTimersByTime(2_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});
