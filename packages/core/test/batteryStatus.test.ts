import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECEIVER_HB_MS,
  HOUR,
  LOW_BATTERY_PCT,
  MINUTE,
  fixedOffset,
  lastVerifiedLabel,
  lastVerifiedLocation,
  lowBatteryBadge,
  lowBatteryPushText,
  lowBatteryTrigger,
  receiverStatusOf,
  syncedPointsText,
  type LowBatteryState,
  type ReceivedFix,
} from '../src';

const T0 = Date.UTC(2026, 10, 24, 11, 5, 0); // 14:05 İstanbul
const TR = fixedOffset(180);

describe('lowBatteryTrigger', () => {
  const feed = (seq: Array<[number | null, boolean | null]>, stepMs = MINUTE) => {
    let s: LowBatteryState | null = null;
    const fires: number[] = [];
    seq.forEach(([pct, ch], i) => {
      const r = lowBatteryTrigger(s, pct, ch, T0 + i * stepMs);
      s = r.state;
      if (r.fire) fires.push(i);
    });
    return { fires, state: s as LowBatteryState | null };
  };

  it('%15 sınırında bir kez; titreme (15↔16) tekrar tetiklemez', () => {
    expect(LOW_BATTERY_PCT).toBe(15);
    const { fires } = feed([[17, false], [16, false], [15, false], [16, false], [15, false], [14, false], [13, false]]);
    expect(fires).toEqual([2]);
  });

  it('%20 ya da şarj yeniden kurar; sonraki düşüş yeniden bildirir', () => {
    const r = feed([[15, false], [20, false], [15, false]], 40 * MINUTE);
    expect(r.fires).toEqual([0, 2]);
    const c = feed([[14, false], [14, true], [14, false]], 40 * MINUTE);
    expect(c.fires).toEqual([0, 2]);
  });

  it('tak-çık 30 dk içinde ikinci bildirim üretmez', () => {
    const c = feed([[14, false], [14, true], [14, false], [13, false]], 5 * MINUTE);
    expect(c.fires).toEqual([0]);
  });

  it('şarjdayken ve bilinmeyen pilde tetiklemez; düşük başlayan paylaşım ilk okumada bildirir', () => {
    expect(feed([[10, true], [9, true]]).fires).toEqual([]);
    expect(feed([[null, null], [null, false]]).fires).toEqual([]);
    expect(feed([[12, false], [11, false]]).fires).toEqual([0]);
  });

  it('bildirim metni koordinat içermez', () => {
    const t = lowBatteryPushText('Ayşe', 14);
    expect(t.title).toBe("Ayşe'nin pili azaldı");
    expect(t.body).toBe('Pil %14. Konum daha seyrek güncellenecek.');
    expect(`${t.title} ${t.body}`).not.toMatch(/\d+\.\d{3,}/);
  });
});

describe('alıcı durumu', () => {
  const fixAt = (o: Partial<ReceivedFix> = {}): ReceivedFix => ({
    lat: 41.0082,
    lng: 28.9784,
    accuracy: 12,
    timestamp: T0,
    server_ts: T0,
    battery_pct: 42,
    hb: 2 * MINUTE,
    ...o,
  });

  it('hb’ye göre: canlı → gecikiyor (>2·hb) → kopmuş olabilir (>4·hb) → eski', () => {
    const f = fixAt();
    expect(receiverStatusOf(f, T0 + MINUTE)).toBe('live');
    expect(receiverStatusOf(f, T0 + 3 * MINUTE)).toBe('recent');
    expect(receiverStatusOf(f, T0 + 5 * MINUTE)).toBe('delayed');
    expect(receiverStatusOf(f, T0 + 9 * MINUTE)).toBe('offline_suspected');
    expect(receiverStatusOf(f, T0 + 7 * HOUR)).toBe('stale');
  });

  it('sabit gönderen (hb 15 dk): 25 dk sessizlik normal, 70 dk kopmuş olabilir', () => {
    const f = fixAt({ hb: 15 * MINUTE });
    expect(receiverStatusOf(f, T0 + 25 * MINUTE)).toBe('recent');
    expect(receiverStatusOf(f, T0 + 40 * MINUTE)).toBe('delayed');
    expect(receiverStatusOf(f, T0 + 70 * MINUTE)).toBe('offline_suspected');
  });

  it('hb yoksa (Faz 1/2 göndereni) varsayılan aralık kullanılır', () => {
    const f = fixAt({ hb: undefined });
    expect(receiverStatusOf(f, T0 + 2 * DEFAULT_RECEIVER_HB_MS)).toBe('recent');
    expect(receiverStatusOf(f, T0 + 2 * DEFAULT_RECEIVER_HB_MS + MINUTE)).toBe('delayed');
  });

  it('son doğrulanmış konum: ≤100 m doğruluklu en son ölçüm; pil en son paketten', () => {
    const good = fixAt({ timestamp: T0, server_ts: T0, accuracy: 15, battery_pct: 44 });
    const cell = fixAt({ lat: 41.1, timestamp: T0 + 5 * MINUTE, server_ts: T0 + 5 * MINUTE, accuracy: 900, battery_pct: 42 });
    const r = lastVerifiedLocation([cell, good], T0 + 6 * MINUTE, TR)!;
    expect(r.lat).toBe(good.lat);
    expect(r.recorded_at).toBe(T0);
    expect(r.battery_pct).toBe(42);
    expect(r.status).toBe('recent'); // gösterilen nokta 6 dk önce: "Canlı" denmez
    expect(r.label).toBe('Son doğrulanmış konum · 14:05 · %42');
    // Hepsi kötüyse en sonuncusu.
    const only = lastVerifiedLocation([cell], T0 + 6 * MINUTE, TR)!;
    expect(only.lat).toBe(41.1);
    expect(lastVerifiedLocation([], T0)).toBeNull();
  });

  it('kopmuş olabilir metni ve kuyruktan gelen nokta işareti', () => {
    const q = fixAt({ q: 1, timestamp: T0 - 10 * MINUTE, server_ts: T0 });
    const r = lastVerifiedLocation([q], T0 + 20 * MINUTE, TR)!;
    expect(r.status).toBe('offline_suspected');
    expect(r.statusText).toBe('Bağlantısı kopmuş olabilir');
    expect(r.fromQueue).toBe(true);
    expect(r.label).toBe('Son doğrulanmış konum · 13:55 · %42');
  });

  it('metinler', () => {
    expect(syncedPointsText(12)).toBe('Çevrimdışıyken kaydedilen 12 nokta eşitlendi');
    expect(syncedPointsText(0)).toBeNull();
    expect(lastVerifiedLabel(T0, null, TR, true)).toBe('Canlı · 14:05');
    expect(lowBatteryBadge(14)).toBe('Pil %14');
    expect(lowBatteryBadge(16)).toBeNull();
  });
});
