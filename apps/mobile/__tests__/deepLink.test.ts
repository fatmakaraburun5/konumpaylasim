/**
 * Derin bağlantı: `app/s/[token].tsx` parametresi → token + özet (yalnızca uygulamanın alan adı), görüntüleyici
 * ekran durumu (canlı / bekleniyor / sona erdi / geçersiz), app.config.ts Universal Links + App Links,
 * pin hareket planı.
 */
import {
  HOUR,
  LINK_DOMAIN_DEFAULT,
  linkTokenHash,
  MINUTE,
  SECOND,
  type LinkLiveLocation,
} from '@konum/core';
import { INITIAL_LINK_LIVE, linkViewerModel, resolveLinkParam } from '../src/features/link/linkViewerModel';
import { planMarkerMove, unwrapLng } from '../src/features/map/markerMotionPlan';

const TOKEN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const DOMAINS = ['konum.example.com'];
const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);

describe('resolveLinkParam', () => {
  it('çıplak token (expo-router parametresi) → token + sha256 özeti', () => {
    expect(resolveLinkParam(TOKEN, DOMAINS)).toEqual({ token: TOKEN, hash: linkTokenHash(TOKEN) });
    expect(linkTokenHash(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveLinkParam([TOKEN, 'x'], DOMAINS)?.token).toBe(TOKEN);
  });

  it('Universal/App Link ve özel şema biçimleri', () => {
    expect(resolveLinkParam(`https://konum.example.com/s/${TOKEN}`, DOMAINS)?.token).toBe(TOKEN);
    expect(resolveLinkParam(`https://konum.example.com/s/${TOKEN}/?utm=qr#x`, DOMAINS)?.token).toBe(TOKEN);
    expect(resolveLinkParam(`konum://s/${TOKEN}`, DOMAINS)?.token).toBe(TOKEN);
    expect(resolveLinkParam(encodeURIComponent(`https://konum.example.com/s/${TOKEN}`), DOMAINS)?.token).toBe(TOKEN);
  });

  it('başka alan adı, http, kısa/bozuk/kanonik olmayan token → null (Bağlantı geçersiz)', () => {
    expect(resolveLinkParam(`https://evil.example.org/s/${TOKEN}`, DOMAINS)).toBeNull();
    expect(resolveLinkParam(`http://konum.example.com/s/${TOKEN}`, DOMAINS)).toBeNull();
    expect(resolveLinkParam(TOKEN.slice(0, 42), DOMAINS)).toBeNull();
    expect(resolveLinkParam(`${TOKEN.slice(0, 42)}B`, DOMAINS)).toBeNull(); // son karakterin alt bitleri 0 değil
    expect(resolveLinkParam(`${TOKEN.slice(0, 41)}!A`, DOMAINS)).toBeNull();
    expect(resolveLinkParam(undefined, DOMAINS)).toBeNull();
    expect(resolveLinkParam('', DOMAINS)).toBeNull();
    expect(resolveLinkParam('%E0%A4%A', DOMAINS)).toBeNull(); // bozuk yüzde kodlaması çökertmez
  });
});

describe('linkViewerModel', () => {
  const live = (over: Partial<LinkLiveLocation> = {}): LinkLiveLocation => ({
    v: 1,
    lat: 41,
    lng: 29,
    accuracy: 10,
    heading: null,
    speed_mps: null,
    battery_pct: 80,
    timestamp: NOW - 10 * SECOND,
    server_ts: NOW - 9 * SECOND,
    sender_name: 'Ayşe',
    expires_at: NOW + HOUR,
    share_mode: 'timed',
    ...over,
  });

  it('geçersiz token: "Bağlantı geçersiz", pin yok', () => {
    expect(linkViewerModel(false, INITIAL_LINK_LIVE, NOW)).toMatchObject({ state: 'invalid', title: 'Bağlantı geçersiz', showMarker: false });
  });

  it('yükleniyor → bekleniyor → canlı (ad, tazelik, "HH:MM\'e kadar")', () => {
    expect(linkViewerModel(true, INITIAL_LINK_LIVE, NOW).state).toBe('loading');
    expect(linkViewerModel(true, { ...INITIAL_LINK_LIVE, loaded: true }, NOW)).toMatchObject({ state: 'waiting' });
    const m = linkViewerModel(true, { live: live(), loaded: true, denied: false, seenLive: true }, NOW);
    expect(m).toMatchObject({ state: 'live', title: 'Ayşe', showMarker: true, freshness: 'live' });
    expect(m.subtitle).toMatch(/^Canlı · \d{2}:\d{2}'(e|a|ye|ya) kadar$/);
    expect(linkViewerModel(true, { live: live({ expires_at: null, timestamp: NOW - 30 * MINUTE }), loaded: true, denied: false, seenLive: true }, NOW).subtitle).toBe(
      '30 dk önce · Süresiz',
    );
  });

  it('düğüm silindi (durdur), ACL reddi ya da süre doldu: "Paylaşım sona erdi", pin kalkar', () => {
    const removed = linkViewerModel(true, { live: null, loaded: true, denied: false, seenLive: true }, NOW);
    expect(removed).toMatchObject({ state: 'ended', title: 'Paylaşım sona erdi', showMarker: false });
    // Boş anlık görüntü okunmuştu (erişim vardı), sonra ACL reddi → sona erdi.
    expect(linkViewerModel(true, { live: null, loaded: true, denied: true, seenLive: false, hadAccess: true }, NOW).state).toBe('ended');
    expect(linkViewerModel(true, { live: live({ expires_at: NOW - 1 }), loaded: true, denied: false, seenLive: true }, NOW)).toMatchObject({
      state: 'ended',
      showMarker: false,
    });
  });
});

describe('linkViewerModel: ilk okuma reddi (web ile aynı core kuralı)', () => {
  it('hiç erişim olmadan ret: "Bağlantı geçersiz ya da süresi dolmuş" (var olmayan / bitmiş ayırt edilmez)', () => {
    const m = linkViewerModel(true, { ...INITIAL_LINK_LIVE, loaded: true, denied: true }, NOW);
    expect(m).toMatchObject({
      state: 'unavailable',
      title: 'Bağlantı geçersiz ya da süresi dolmuş',
      subtitle: 'Konumu görmek için paylaşan kişiden yeni bir bağlantı isteyebilirsin.',
      showMarker: false,
    });
  });
});

describe('app.config.ts bağlantı yapılandırması', () => {
  const load = (env: Record<string, string | undefined> = {}) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let cfg: Record<string, any> = {};
      jest.isolateModules(() => {
        cfg = require('../app.config').default({ config: {} });
      });
      return cfg;
    } finally {
      warn.mockRestore();
      process.env = saved;
    }
  };

  it('varsayılan alan adı core ile aynı; iOS applinks + Android autoVerify /s/', () => {
    const cfg = load({ LINK_DOMAIN: undefined });
    expect(cfg.scheme).toBe('konum');
    expect(cfg.extra.linkDomain).toBe(LINK_DOMAIN_DEFAULT);
    expect(cfg.ios.associatedDomains).toEqual([`applinks:${LINK_DOMAIN_DEFAULT}`]);
    expect(cfg.android.intentFilters).toEqual([
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: LINK_DOMAIN_DEFAULT, pathPrefix: '/s/' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ]);
  });

  it('LINK_DOMAIN ortamdan (normalize edilir)', () => {
    const cfg = load({ LINK_DOMAIN: 'https://Konum.Ornek.com/' });
    expect(cfg.extra.linkDomain).toBe('konum.ornek.com');
    expect(cfg.ios.associatedDomains).toEqual(['applinks:konum.ornek.com']);
    expect(cfg.android.intentFilters[0].data[0].host).toBe('konum.ornek.com');
  });
});

describe('planMarkerMove (pin yumuşak hareketi)', () => {
  const fix = (lat: number, lng: number, timestamp: number) => ({ lat, lng, timestamp });

  it('ilk konum anında; yakın yeni örnek iki örnek arası süre kadar (300 ms – 2 sn) kayar', () => {
    expect(planMarkerMove(null, fix(41, 29, NOW))).toMatchObject({ kind: 'snap', reason: 'first' });
    expect(planMarkerMove(fix(41, 29, NOW), fix(41.0005, 29, NOW + 15 * SECOND))).toEqual({ kind: 'animate', to: { lat: 41.0005, lng: 29 }, durationMs: 2_000 });
    expect(planMarkerMove(fix(41, 29, NOW), fix(41.0001, 29, NOW + 100))).toMatchObject({ kind: 'animate', durationMs: 300 });
  });

  it('büyük sıçrama / uzun ara anında; eski ya da yinelenen örnek yok sayılır', () => {
    expect(planMarkerMove(fix(41, 29, NOW), fix(41.1, 29, NOW + 10 * SECOND))).toMatchObject({ kind: 'snap', reason: 'jump' });
    expect(planMarkerMove(fix(41, 29, NOW), fix(41.0001, 29, NOW + 5 * MINUTE))).toMatchObject({ kind: 'snap', reason: 'gap' });
    expect(planMarkerMove(fix(41, 29, NOW), fix(41.0001, 29, NOW - 1))).toEqual({ kind: 'ignore' });
    expect(planMarkerMove(fix(41, 29, NOW), fix(41, 29, NOW))).toEqual({ kind: 'ignore' });
  });

  it('180. meridyen kısa yoldan', () => {
    expect(unwrapLng(179.99, -179.99)).toBeCloseTo(180.01, 6);
    expect(unwrapLng(-179.99, 179.99)).toBeCloseTo(-180.01, 6);
    expect(unwrapLng(29, 29.01)).toBe(29.01);
  });
});
