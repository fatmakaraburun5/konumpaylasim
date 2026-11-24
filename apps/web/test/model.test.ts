import { describe, expect, it } from 'vitest';
import { MINUTE, fixedOffset, linkViewState, type LinkLiveLocation } from '@konum/core';
import {
  FIX_HISTORY_MAX,
  PHASE_TEXT,
  SYNC_NOTE_MS,
  formatAccuracy,
  googleMapsUrl,
  initialOf,
  initialViewerModel,
  isOffline,
  livePresentation,
  showsMarker,
  untilText,
  viewerPhase,
  viewerReducer,
  type ViewerEvent,
  type ViewerModel,
} from '../src/viewer/model';

// 2026-11-24 14:00:00 Europe/Istanbul (UTC+3) = 11:00 UTC
const NOW = Date.UTC(2026, 10, 24, 11, 0, 0);
const TR = fixedOffset(180);

const packet = (o: Partial<Record<string, unknown>> = {}) => ({
  v: 1,
  lat: 40.98712,
  lng: 29.02561,
  accuracy: 12,
  heading: 118,
  speed_mps: 1.3,
  battery_pct: 64,
  timestamp: NOW - 5_000,
  server_ts: NOW - 4_000,
  sender_name: 'Ayşe Yılmaz',
  share_mode: 'timed',
  expires_at: NOW + 42 * MINUTE,
  ...o,
});

const run = (events: ViewerEvent[], start: ViewerModel = initialViewerModel(true)) => events.reduce(viewerReducer, start);

describe('viewerPhase: durum makinesi', () => {
  it('bozuk token → invalid (veri kaynağına hiç bakılmaz)', () => {
    const m = run([{ type: 'snapshot', raw: packet() }], initialViewerModel(false));
    expect(viewerPhase(m, NOW)).toBe('invalid');
    expect(PHASE_TEXT.invalid.title).toBe('Bağlantı geçersiz');
  });

  it('ilk anlık görüntü gelene kadar loading', () => {
    expect(viewerPhase(initialViewerModel(true), NOW)).toBe('loading');
  });

  it('ilk okuma reddedildi (hiç erişim yok) → unavailable: "Bağlantı geçersiz ya da süresi dolmuş"', () => {
    const m = run([{ type: 'denied' }]);
    expect(viewerPhase(m, NOW)).toBe('unavailable');
    expect(PHASE_TEXT.unavailable.title).toBe('Bağlantı geçersiz ya da süresi dolmuş');
  });

  it('erişim var ama konum yok → waiting', () => {
    const m = run([{ type: 'snapshot', raw: null }]);
    expect(viewerPhase(m, NOW)).toBe('waiting');
  });

  it('konum → live; düğüm silinince → ended ve pin kalkar', () => {
    const live = run([{ type: 'snapshot', raw: packet() }]);
    expect(viewerPhase(live, NOW)).toBe('live');
    expect(showsMarker(viewerPhase(live, NOW))).toBe(true);
    const ended = viewerReducer(live, { type: 'snapshot', raw: null });
    expect(viewerPhase(ended, NOW)).toBe('ended');
    expect(showsMarker('ended')).toBe(false);
    expect(PHASE_TEXT.ended.title).toBe('Paylaşım sona erdi');
  });

  it('canlıyken dinleyici permission_denied ile kesilirse (Paylaşımı Durdur / süre doldu) → ended', () => {
    const m = run([{ type: 'snapshot', raw: packet() }, { type: 'denied' }]);
    expect(viewerPhase(m, NOW)).toBe('ended');
    expect(m.live).toBeNull();
  });

  it('beklerken (erişim vardı) reddedilirse → ended, unavailable değil', () => {
    const m = run([{ type: 'snapshot', raw: null }, { type: 'denied' }]);
    expect(viewerPhase(m, NOW)).toBe('ended');
  });

  it('paketteki expires_at geçince sunucu beklenmeden ended', () => {
    const m = run([{ type: 'snapshot', raw: packet({ expires_at: NOW + 1_000 }) }]);
    expect(viewerPhase(m, NOW)).toBe('live');
    expect(viewerPhase(m, NOW + 1_000)).toBe('ended');
  });

  it('süresiz paylaşım (expires_at yok) süreyle bitmez', () => {
    const p = packet({ share_mode: 'indefinite' }) as Record<string, unknown>;
    delete p.expires_at;
    const m = run([{ type: 'snapshot', raw: p }]);
    expect(viewerPhase(m, NOW + 30 * 24 * 60 * MINUTE)).toBe('live');
  });

  it('reddedildikten sonra gelen olay yok sayılır (kesilme kalıcı)', () => {
    const m = run([{ type: 'denied' }, { type: 'snapshot', raw: packet() }]);
    expect(viewerPhase(m, NOW)).toBe('unavailable');
  });

  it('bozuk paket konum sayılmaz', () => {
    const m = run([{ type: 'snapshot', raw: { lat: 'x' } }]);
    expect(viewerPhase(m, NOW)).toBe('waiting');
    expect(m.seenLive).toBe(false);
  });

  it('daha eski örnek konumu geri almaz; aynı zaman damgası (uzatma eşitlemesi) kabul edilir', () => {
    const m1 = run([{ type: 'snapshot', raw: packet({ lat: 41 }) }]);
    const older = viewerReducer(m1, { type: 'snapshot', raw: packet({ lat: 40, timestamp: NOW - 60_000 }) });
    expect(older.live?.lat).toBe(41);
    const extended = viewerReducer(m1, { type: 'snapshot', raw: packet({ lat: 41, expires_at: NOW + 72 * MINUTE }) });
    expect(extended.live?.expires_at).toBe(NOW + 72 * MINUTE);
  });

  it('dinleyici başka hatayla düşerse error (canlıyken bile "sona erdi" denmez)', () => {
    expect(viewerPhase(run([{ type: 'failed' }]), NOW)).toBe('error');
    expect(viewerPhase(run([{ type: 'snapshot', raw: packet() }, { type: 'failed' }]), NOW)).toBe('error');
  });

  it('çevrimdışı: tarayıcı offline ya da bağlantı zaman aşımı; ilk false sayılmaz', () => {
    expect(viewerPhase(run([{ type: 'connection', connected: false }]), NOW)).toBe('loading');
    expect(viewerPhase(run([{ type: 'connect_timeout' }]), NOW)).toBe('offline');
    expect(viewerPhase(run([{ type: 'browser_online', online: false }]), NOW)).toBe('offline');
    expect(viewerPhase(initialViewerModel(true, false), NOW)).toBe('offline');
    const upDown = run([{ type: 'connection', connected: true }, { type: 'connection', connected: false }]);
    expect(isOffline(upDown)).toBe(true);
    expect(isOffline(viewerReducer(upDown, { type: 'connection', connected: true }))).toBe(false);
    // Bağlandıktan sonra zaman aşımı etkisiz.
    expect(isOffline(run([{ type: 'connection', connected: true }, { type: 'connect_timeout' }]))).toBe(false);
  });

  it('canlıyken bağlantı koparsa live kalır (son bilinen konum), çevrimdışı işaretlenir', () => {
    const m = run([
      { type: 'connection', connected: true },
      { type: 'snapshot', raw: packet() },
      { type: 'connection', connected: false },
    ]);
    expect(viewerPhase(m, NOW)).toBe('live');
    expect(isOffline(m)).toBe(true);
  });

  it('web ayrımları (offline / error) dışında core linkViewState ile aynı karar (unavailable dahil)', () => {
    const lives = [null, packet(), packet({ expires_at: NOW - 1 })];
    for (const loaded of [false, true])
      for (const denied of [false, true])
        for (const seenLive of [false, true])
          for (const hadAccess of [false, true])
            for (const raw of lives) {
              const live = raw ? (viewerReducer(initialViewerModel(true), { type: 'snapshot', raw }).live as LinkLiveLocation) : null;
              const m: ViewerModel = { ...initialViewerModel(true), loaded, denied, seenLive, live, hadAccess };
              const core = linkViewState({ tokenValid: true, loaded, denied, live, seenLive, hadAccess, now: NOW });
              expect(viewerPhase(m, NOW)).toBe(core);
            }
  });
});

describe('sunum metinleri', () => {
  it('canlı kart: tazelik, bitiş, doğruluk, pil, Haritada göster bağlantısı', () => {
    const m = run([{ type: 'snapshot', raw: packet() }]);
    const p = livePresentation(m.live as LinkLiveLocation, NOW, TR);
    expect(p.senderName).toBe('Ayşe Yılmaz');
    expect(p.initial).toBe('A');
    expect(p.freshness).toBe('live');
    expect(p.freshnessLine).toBe('Canlı · şimdi');
    expect(p.until).toBe("14:42'ye kadar");
    expect(p.remaining).toBe('42 dk kaldı');
    expect(p.accuracy).toBe('±12 m');
    expect(p.battery).toBe('%64');
    expect(p.mapsUrl).toBe('https://www.google.com/maps?q=40.98712,29.02561');
  });

  it('eski ölçüm ama paket zamanında (hb yok → 10 dk): "Güncel · 18 dk önce", doğrulanmış etiket; pil yoksa null', () => {
    const raw = packet({ timestamp: NOW - 18 * MINUTE }) as Record<string, unknown>;
    delete raw.battery_pct;
    const m = run([{ type: 'snapshot', raw }]);
    const p = livePresentation(m.live as LinkLiveLocation, NOW, TR);
    expect(p.status).toBe('recent');
    expect(p.freshness).toBe('recent');
    expect(p.freshnessLine).toBe('Güncel · 18 dk önce');
    // 11:00 UTC − 18 dk = 13:42 İstanbul
    expect(p.verifiedLabel).toBe('Son doğrulanmış konum · 13:42');
    expect(p.battery).toBeNull();
    expect(p.lowBattery).toBeNull();
  });

  it('untilText: aynı gün saat, gece yarısı "00:00\'a kadar", haftalıkta tarih, süresizde "Süresiz"', () => {
    expect(untilText(null, NOW, TR)).toBe('Süresiz');
    expect(untilText(Date.UTC(2026, 10, 24, 14, 30), NOW, TR)).toBe("17:30'a kadar");
    // Gün sonu: yerel 25.11 00:00 = 24.11 21:00 UTC
    expect(untilText(Date.UTC(2026, 10, 24, 21, 0), NOW, TR)).toBe("00:00'a kadar");
    expect(untilText(Date.UTC(2026, 11, 1, 11, 0), NOW, TR)).toBe("01.12 14:00'e kadar");
    // Gece yarısını geçen kısa paylaşım: ertesi günün tarihi
    expect(untilText(Date.UTC(2026, 10, 24, 21, 5), Date.UTC(2026, 10, 24, 20, 50), TR)).toBe("25.11 00:05'e kadar");
  });

  it('küçük biçimlendiriciler', () => {
    expect(formatAccuracy(0.4)).toBe('±1 m');
    expect(formatAccuracy(1500)).toBe('±1,5 km');
    expect(initialOf('ilknur')).toBe('İ');
    expect(initialOf('  ')).toBe('?');
    expect(googleMapsUrl(41.0000004, -0.1234567)).toBe('https://www.google.com/maps?q=41,-0.123457');
  });
});

describe('Faz 3: son doğrulanmış konum, hb\'ye göre durum, düşük pil, kuyruk notu', () => {
  const MIN2 = 2 * MINUTE;
  const present = (m: ViewerModel, now = NOW) =>
    livePresentation(m.live as LinkLiveLocation, now, TR, { fixes: m.fixes, queued: m.queued });

  it('canlı: etiket yok (üst satır yeterli), pin = paket', () => {
    const m = run([{ type: 'snapshot', raw: packet({ hb: MIN2 }) }]);
    const p = present(m);
    expect(p.status).toBe('live');
    expect(p.freshnessLine).toBe('Canlı · şimdi');
    expect(p.verifiedLabel).toBeNull();
    expect(p.statusDetail).toBeNull();
    expect(p.position).toEqual({ lat: 40.98712, lng: 29.02561, accuracy: 12, timestamp: NOW - 5_000 });
  });

  it('araçtaki gönderen (hb 2 dk): 5 dk sessizlik → gecikiyor, 9 dk → "Bağlantısı kopmuş olabilir" + saat + pil', () => {
    const m = run([{ type: 'snapshot', raw: packet({ hb: MIN2, timestamp: NOW, server_ts: NOW }) }]);
    const delayed = present(m, NOW + 5 * MINUTE);
    expect(delayed.status).toBe('delayed');
    expect(delayed.freshnessLine).toBe('Güncelleme gecikiyor · 5 dk önce');
    expect(delayed.verifiedLabel).toBe('Son doğrulanmış konum · 14:00 · %64');
    expect(delayed.statusDetail).toBeNull();
    const lost = present(m, NOW + 9 * MINUTE);
    expect(lost.status).toBe('offline_suspected');
    expect(lost.freshnessLine).toBe('Bağlantısı kopmuş olabilir · 9 dk önce');
    expect(lost.verifiedLabel).toBe('Son doğrulanmış konum · 14:00 · %64');
    expect(lost.statusDetail).toMatch(/kapalı olabilir/);
    expect(lost.freshness).toBe('stale');
    expect(lost.announcement).toBe('Ayşe Yılmaz: Bağlantısı kopmuş olabilir');
    // Pin ve bağlantı son doğrulanmış koordinatta kalır (paylaşım bitmedi).
    expect(lost.mapsUrl).toBe('https://www.google.com/maps?q=40.98712,29.02561');
  });

  it('sabit duran gönderen (hb 15 dk): 12 dk sessizlik sahte alarm değil → "Güncel"', () => {
    const m = run([{ type: 'snapshot', raw: packet({ hb: 15 * MINUTE, timestamp: NOW, server_ts: NOW }) }]);
    const p = present(m, NOW + 12 * MINUTE);
    expect(p.status).toBe('recent');
    expect(p.freshnessLine).toBe('Güncel · 12 dk önce');
    expect(present(m, NOW + 31 * MINUTE).status).toBe('delayed');
    expect(present(m, NOW + 61 * MINUTE).status).toBe('offline_suspected');
  });

  it('hb olmayan (Faz 2) gönderen: varsayılan 10 dk ile karar verilir', () => {
    const m = run([{ type: 'snapshot', raw: packet({ timestamp: NOW, server_ts: NOW }) }]);
    expect(present(m, NOW + 20 * MINUTE).status).toBe('recent');
    expect(present(m, NOW + 21 * MINUTE).status).toBe('delayed');
    expect(present(m, NOW + 41 * MINUTE).status).toBe('offline_suspected');
    expect(present(m, NOW + 7 * 60 * MINUTE).status).toBe('stale');
    expect(present(m, NOW + 7 * 60 * MINUTE).freshnessLine).toBe('Uzun süredir güncelleme yok · 7 sa önce');
  });

  it('kötü doğruluklu yeni ölçüm iyi GPS noktasını ezmez: pin ve "Haritada göster" doğrulanmış noktada', () => {
    const m = run([
      { type: 'snapshot', raw: packet({ hb: MIN2, timestamp: NOW - 60_000, server_ts: NOW - 60_000 }) },
      { type: 'snapshot', raw: packet({ hb: MIN2, lat: 41.1, lng: 29.1, accuracy: 900, timestamp: NOW - 5_000, server_ts: NOW - 4_000, battery_pct: 61 }) },
    ]);
    const p = present(m);
    expect(p.position.lat).toBe(40.98712);
    expect(p.accuracy).toBe('±12 m');
    expect(p.mapsUrl).toBe('https://www.google.com/maps?q=40.98712,29.02561');
    // Pil en son paketten.
    expect(p.battery).toBe('%61');
  });

  it('düşük pil: ≤ %15 bilgi notu (bildirimle aynı metin) + rozet; %16 not yok', () => {
    const low = present(run([{ type: 'snapshot', raw: packet({ battery_pct: 14 }) }]));
    expect(low.lowBattery).toEqual({
      badge: 'Pil %14',
      title: "Ayşe Yılmaz'ın pili azaldı",
      body: 'Pil %14. Konum daha seyrek güncellenecek.',
    });
    expect(low.announcement).toContain('pili azaldı');
    expect(present(run([{ type: 'snapshot', raw: packet({ battery_pct: 15 }) }])).lowBattery?.badge).toBe('Pil %15');
    expect(present(run([{ type: 'snapshot', raw: packet({ battery_pct: 16 }) }])).lowBattery).toBeNull();
  });

  it('kuyruktan gelen paket (q: 1): sakin not, durum yeniden güncel; 2 dk sonra not kalkar', () => {
    const m = run([
      { type: 'snapshot', raw: packet({ hb: MIN2, timestamp: NOW - 14 * MINUTE, server_ts: NOW - 14 * MINUTE }) },
      { type: 'snapshot', raw: packet({ hb: MIN2, q: 1, timestamp: NOW - 3 * MINUTE, server_ts: NOW }) },
    ]);
    const p = present(m);
    expect(m.queued).toEqual({ count: 1, lastServerTs: NOW });
    expect(p.syncNote).toBe('Bağlantı geri geldi · çevrimdışıyken kaydedilen konum eşitlendi');
    expect(p.status).toBe('recent');
    expect(p.verifiedLabel).toBe('Son doğrulanmış konum · 13:57 · %64');
    expect(present(m, NOW + SYNC_NOTE_MS + 1).syncNote).toBeNull();
    // Aynı patlamada ikinci kuyruk noktası: sayaç artar.
    const m2 = viewerReducer(m, { type: 'snapshot', raw: packet({ hb: MIN2, q: 1, timestamp: NOW - 2 * MINUTE, server_ts: NOW + 1_000 }) });
    expect(present(m2, NOW + 1_000).syncNote).toBe('Çevrimdışıyken kaydedilen 2 nokta eşitlendi');
    // Kuyruktan gelen daha eski nokta konumu geri almaz, sayılmaz.
    const m3 = viewerReducer(m2, { type: 'snapshot', raw: packet({ q: 1, lat: 40, timestamp: NOW - 10 * MINUTE, server_ts: NOW + 2_000 }) });
    expect(m3.live?.lat).toBe(40.98712);
    expect(m3.queued?.count).toBe(2);
  });

  it('uzatma eşitlemesi (aynı ölçüm) geçmişte tek kayıt; geçmiş sınırlı; bitince geçmiş silinir', () => {
    let m = run([{ type: 'snapshot', raw: packet() }]);
    m = viewerReducer(m, { type: 'snapshot', raw: packet({ expires_at: NOW + 72 * MINUTE }) });
    expect(m.fixes).toHaveLength(1);
    for (let i = 1; i <= FIX_HISTORY_MAX + 5; i++) {
      m = viewerReducer(m, { type: 'snapshot', raw: packet({ timestamp: NOW + i * 1_000, server_ts: NOW + i * 1_000 }) });
    }
    expect(m.fixes).toHaveLength(FIX_HISTORY_MAX);
    const ended = viewerReducer(m, { type: 'snapshot', raw: null });
    expect(ended.fixes).toEqual([]);
    expect(ended.queued).toBeNull();
    expect(viewerReducer(m, { type: 'denied' }).fixes).toEqual([]);
    expect(viewerReducer(m, { type: 'failed' }).fixes).toEqual([]);
  });

  it('gizlilik: bağlantı paketinde recorded_at / is_charging okunmaz, bilinmeyen alan modele girmez', () => {
    const m = run([{ type: 'snapshot', raw: packet({ recorded_at: NOW - 1, is_charging: true, sender_id: 'u1', hb: MIN2, q: 1 }) }]);
    const live = m.live as unknown as Record<string, unknown>;
    expect(live.recorded_at).toBeUndefined();
    expect(live.is_charging).toBeUndefined();
    expect(live.sender_id).toBeUndefined();
    expect(live.hb).toBe(MIN2);
  });
});
