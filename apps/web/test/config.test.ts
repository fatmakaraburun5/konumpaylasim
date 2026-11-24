import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, referrerPolicy } from '../build/htmlPolicy';
import { readConfig } from '../src/env';
import { isPermissionDenied } from '../src/data/source';
import { offsetMeters, posMod, scaleBar } from '../src/map/projection';

describe('readConfig', () => {
  it('emülatör: proje ve ad alanı demo-konum, 127.0.0.1:9000', () => {
    const c = readConfig({ VITE_USE_EMULATORS: '1' });
    expect(c.firebase).toEqual({
      projectId: 'demo-konum',
      databaseURL: 'https://demo-konum.firebaseio.com',
      emulator: { host: '127.0.0.1', port: 9000 },
    });
    expect(readConfig({ VITE_USE_EMULATORS: '1', VITE_RTDB_EMULATOR_HOST: 'localhost:9100' }).firebase?.emulator).toEqual({
      host: 'localhost',
      port: 9100,
    });
  });

  it('üretim: https veritabanı adresi ve proje zorunlu; yoksa null', () => {
    expect(readConfig({}).firebase).toBeNull();
    expect(readConfig({ VITE_FIREBASE_PROJECT_ID: 'p', VITE_FIREBASE_DATABASE_URL: 'http://x' }).firebase).toBeNull();
    const c = readConfig({
      VITE_FIREBASE_PROJECT_ID: 'konum-prod',
      VITE_FIREBASE_DATABASE_URL: 'https://konum-prod-default-rtdb.europe-west1.firebasedatabase.app',
      VITE_FIREBASE_API_KEY: ' AIza ',
    });
    expect(c.firebase).toMatchObject({ projectId: 'konum-prod', apiKey: 'AIza', emulator: null });
  });

  it('Maps anahtarı boşsa null; mağaza adresleri yalnızca https', () => {
    expect(readConfig({ VITE_GOOGLE_MAPS_WEB_KEY: '  ' }).mapsKey).toBeNull();
    expect(readConfig({ VITE_GOOGLE_MAPS_WEB_KEY: 'k' }).mapsKey).toBe('k');
    expect(readConfig({ VITE_APP_STORE_URL: 'javascript:alert(1)' }).appStoreUrl).toBeNull();
    expect(readConfig({ VITE_PLAY_STORE_URL: 'https://play.google.com/store/apps/details?id=x' }).playStoreUrl).toContain('https://');
  });
});

describe('HTML politikası (referrer + CSP)', () => {
  it('anahtarsız: no-referrer ve Google alanı yok', () => {
    expect(referrerPolicy({ mapsKey: false })).toBe('no-referrer');
    const csp = contentSecurityPolicy({ mapsKey: false, databaseUrl: null, emulatorHost: null });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('wss://*.firebaseio.com');
    expect(csp).not.toContain('google');
    expect(csp).toContain("frame-src 'none'");
  });

  it('anahtarlı: strict-origin (referrer kısıtlı anahtar kaynağı görmeli, yol gitmez) ve Maps alanları', () => {
    expect(referrerPolicy({ mapsKey: true })).toBe('strict-origin');
    const csp = contentSecurityPolicy({ mapsKey: true, databaseUrl: null, emulatorHost: null });
    expect(csp).toMatch(/script-src [^;]*https:\/\/\*\.googleapis\.com/);
    expect(csp).toMatch(/img-src [^;]*https:\/\/\*\.gstatic\.com/);
  });

  it('emülatör ve özel veritabanı alanı', () => {
    const csp = contentSecurityPolicy({ mapsKey: false, databaseUrl: 'https://db.example.org', emulatorHost: '127.0.0.1:9000' });
    expect(csp).toContain('ws://127.0.0.1:9000');
    expect(csp).toContain('wss://db.example.org');
    const std = contentSecurityPolicy({
      mapsKey: false,
      databaseUrl: 'https://x.europe-west1.firebasedatabase.app',
      emulatorHost: null,
    });
    expect(std.match(/firebasedatabase\.app/g)?.length).toBe(3); // tekrar eklenmez
  });
});

describe('isPermissionDenied', () => {
  it('RTDB SDK hata biçimi', () => {
    const e = Object.assign(new Error('permission_denied at /link_live/ab: Client doesn\'t have permission'), { code: 'PERMISSION_DENIED' });
    expect(isPermissionDenied(e)).toBe(true);
    expect(isPermissionDenied(new Error('permission_denied at /x'))).toBe(true);
    expect(isPermissionDenied(Object.assign(new Error('x'), { code: 'UNAVAILABLE' }))).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
  });
});

describe('yedek harita izdüşümü', () => {
  it('1° enlem ≈ 111,2 km; boylam 180. meridyende kısa yol', () => {
    expect(offsetMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }).y).toBeCloseTo(111_195, -1);
    const o = offsetMeters({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
    expect(o.x).toBeGreaterThan(0);
    expect(o.x).toBeLessThan(25_000);
  });

  it('ölçek çubuğu 1·2·5 basamakları', () => {
    expect(scaleBar(1.1).label).toBe('50 m');
    expect(scaleBar(0.05).label).toBe('1 km');
    expect(scaleBar(1.1).px).toBeCloseTo(55);
    expect(posMod(-10, 72)).toBe(62);
  });
});
