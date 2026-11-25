/**
 * Faz 6 yerel widget köprüsü: (1) yerel modül yoksa güvenli no-op, (2) olay / yetenek ayrıştırma, (3) belirteç
 * doğrulaması, (4) sözleşme — Swift (Codable, convertFromSnakeCase) ve Kotlin (org.json) tarafının okuduğu anahtarlar
 * core `buildWidgetSnapshot` çıktısında birebir var. Yerel kod burada derlenemediği için anahtar listesi kaynaktan
 * okunur (bir alan yeniden adlandırılırsa bu test kırılır).
 */
import { buildWidgetSnapshot, quickShareDeepLink, WIDGET_SNAPSHOT_KEY } from '@konum/core';
import {
  __setNativeWidgetsModuleForTests,
  capabilities,
  consumeEvents,
  isWidgetModuleAvailable,
  parseWidgetEvents,
  reload,
  saveAvatar,
  setQuickShareCredential,
  setSnapshot,
} from '../src/services/widgets/widgetBridge';

// Mobil tsconfig yalnızca jest tiplerini yükler (@types/node yok): Node API'leri jest ortamından gevşek tiple alınır.
declare const __dirname: string;
const fs = require('fs') as { readFileSync(p: string, enc: 'utf8'): string };
const path = require('path') as { join(...parts: string[]): string };
const ROOT = path.join(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

function fakeNative() {
  const calls: string[] = [];
  return {
    calls,
    mod: {
      setSnapshot: async (json: string) => void calls.push(`snap:${json.length}`),
      reload: async () => void calls.push('reload'),
      saveAvatar: async (uid: string) => (uid === 'bad' ? '../x.jpg' : `${uid}.jpg`),
      removeAvatar: async () => undefined,
      setQuickShareCredential: async (t: string, e: string, x: number) => (calls.push(`cred:${t}:${e}:${x}`), true),
      clearQuickShareCredential: async () => void calls.push('clear'),
      consumeEvents: async () =>
        JSON.stringify([
          { type: 'quick_share', to_uid: 'u2', status: 'started', at: 1_700_000_000_000, expires_at: 1_700_003_600_000, source: 'ios_widget' },
          { type: 'quick_share', to_uid: 'u3', status: 'error', error: 'rate_limited', at: 1_700_000_000_500 },
          { type: 'other', to_uid: 'u4', status: 'x', at: 1 },
          { type: 'quick_share', to_uid: '', status: 'started', at: 5 },
        ]),
      capabilities: () => ({ platform: 'ios', interactive: true, lockScreen: true, quickTile: false, available: true }),
    },
  };
}

afterEach(() => __setNativeWidgetsModuleForTests(undefined));

describe('widget köprüsü', () => {
  it('yerel modül yoksa her şey no-op ve güvenli varsayılan', async () => {
    __setNativeWidgetsModuleForTests(null);
    expect(isWidgetModuleAvailable()).toBe(false);
    await expect(setSnapshot('{}')).resolves.toBeUndefined();
    expect(() => reload()).not.toThrow();
    expect(await saveAvatar('u1', 'file:///tmp/a.jpg')).toBeNull();
    expect(await consumeEvents()).toEqual([]);
    expect(capabilities()).toMatchObject({ interactive: false, lockScreen: false, available: false });
  });

  it('olaylar doğrulanır, bozuk kayıtlar atılır; dosya adı yol kaçışına izin vermez', async () => {
    const f = fakeNative();
    __setNativeWidgetsModuleForTests(f.mod);
    const ev = await consumeEvents();
    expect(ev).toEqual([
      { type: 'quick_share', to_uid: 'u2', status: 'started', at: 1_700_000_000_000, expires_at: 1_700_003_600_000, source: 'ios_widget' },
      { type: 'quick_share', to_uid: 'u3', status: 'error', error: 'rate_limited', at: 1_700_000_000_500 },
    ]);
    expect(parseWidgetEvents('bozuk')).toEqual([]);
    expect(await saveAvatar('u1', 'file:///tmp/a.jpg')).toBe('u1.jpg');
    expect(await saveAvatar('bad', 'file:///tmp/a.jpg')).toBeNull();
    expect(capabilities()).toEqual({ platform: 'ios', interactive: true, lockScreen: true, quickTile: false, available: true });
  });

  it('belirteç: geçerliyse yazılır (tam URL ya da callable adı), null / geçersizse silinir', async () => {
    const f = fakeNative();
    __setNativeWidgetsModuleForTests(f.mod);
    await setQuickShareCredential({ token: 't'.repeat(43), endpoint: 'widget_quick_share', expires_at: 1_700_000_000_000.4 });
    await setQuickShareCredential({ token: 'abc', endpoint: 'https://europe-west1-p.cloudfunctions.net/widget_quick_share', expires_at: 5 });
    await setQuickShareCredential({ token: 'abc', endpoint: 'ftp://x', expires_at: 5 });
    await setQuickShareCredential(null);
    expect(f.calls).toEqual([
      `cred:${'t'.repeat(43)}:widget_quick_share:1700000000000`,
      'cred:abc:https://europe-west1-p.cloudfunctions.net/widget_quick_share:5',
      'clear',
      'clear',
    ]);
  });
});

describe('yerel sözleşme: snapshot anahtarları ve derin bağlantı', () => {
  const now = 1_700_000_000_000;
  const snap = buildWidgetSnapshot({
    now,
    signed_in: true,
    me: { display_name: 'Burak Yılmaz' },
    favorite_ids: ['u_ayse'],
    friends: [
      {
        uid: 'u_ayse',
        display_name: 'Ayşe Demir',
        gender: 'female',
        avatar_file: 'u_ayse.jpg',
        incoming: { active: true, last_seen_at: now - 60_000, battery_pct: 40, place: 'Ev' },
      },
    ],
    outgoing: [{ receiver_id: 'u_ayse', status: 'active', expires_at: now + 3_600_000 }],
    quick: { token_expires_at: now + 86_400_000, bg_location_ok: true },
  });
  const topKeys = new Set(Object.keys(snap));
  const favKeys = new Set(Object.keys(snap.favorites[0]!));
  const nestedKeys = new Set([...Object.keys(snap.quick), ...Object.keys(snap.privacy)]);
  const all = new Set([...topKeys, ...favKeys, ...nestedKeys]);

  it('Kotlin (org.json) okuduğu her anahtar core çıktısında var', () => {
    const src = read('modules/konum-widgets/android/src/main/java/expo/modules/konumwidgets/WidgetSnapshot.kt');
    const body = src.slice(src.indexOf('fun parseSnapshot'), src.indexOf('fun ringFor'));
    const keys = [...body.matchAll(/\(\s*(?:f|o|quick\?|privacy\?)\.?\s*,?\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    const viaOpt = [...body.matchAll(/opt(?:Int|Boolean|JSONArray|JSONObject)\("([a-z_]+)"/g)].map((m) => m[1]!);
    const used = new Set([...keys, ...viaOpt]);
    expect(used.size).toBeGreaterThan(15);
    for (const k of used) expect(all.has(k) || k === 'favorites' || k === 'quick' || k === 'privacy').toBe(true);
    for (const k of favKeys) expect(used.has(k)).toBe(true);
  });

  it('Swift (Codable, convertFromSnakeCase) özellikleri core anahtarlarıyla eşleşir', () => {
    const src = read('targets/widgets/WidgetModel.swift');
    const structBody = (name: string) => {
      const start = src.indexOf(`struct ${name}: Decodable {`);
      return src.slice(start, src.indexOf('\n}\n', start));
    };
    const props = (name: string) =>
      [...structBody(name).matchAll(/^\s{2}let (\w+):/gm)].map((m) => m[1]!.replace(/[A-Z]/g, (c: string) => `_${c.toLowerCase()}`));
    for (const k of props('WFavorite')) expect(favKeys.has(k)).toBe(true);
    for (const k of props('WSnapshot')) expect(topKeys.has(k)).toBe(true);
    for (const k of [...props('WQuick'), ...props('WPrivacy')]) expect(nestedKeys.has(k)).toBe(true);
    expect(props('WFavorite').sort()).toEqual([...favKeys].sort());
  });

  it('App Group anahtarı ve derin bağlantı biçimi iki yerel tarafta core ile aynı', () => {
    expect(read('targets/widgets/WidgetStore.swift')).toContain(`"${WIDGET_SNAPSHOT_KEY}"`);
    expect(read('modules/konum-widgets/ios/KonumWidgetsModule.swift')).toContain(`"${WIDGET_SNAPSHOT_KEY}"`);
    expect(read('modules/konum-widgets/android/src/main/java/expo/modules/konumwidgets/WidgetStore.kt')).toContain(`"${WIDGET_SNAPSHOT_KEY}"`);
    // Yerel taraf `scheme=konum, host=quick-share, ?to=&src=` kurar → core biçimiyle aynı.
    expect(quickShareDeepLink('u_ayse', 'android_widget')).toBe('konum://quick-share?to=u_ayse&src=android_widget');
  });
});
