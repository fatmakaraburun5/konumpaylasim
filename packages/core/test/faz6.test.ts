import { describe, expect, it } from 'vitest';
import {
  AVATAR_FILE_RE,
  avatarObjectPaths,
  avatarViewOf,
  buildWidgetSnapshot,
  checkAvatarPair,
  CALLABLES,
  ERROR_CODES,
  FAVORITES_LIMIT,
  FavoritesSetRequestSchema,
  formatCountdown,
  GENDER_RING,
  genderRingColor,
  initialsOf,
  parseQuickShareDeepLink,
  parseWidgetSnapshot,
  PUSH_TYPES_F6,
  QUICK_SHARE_ERRORS,
  quickShareDeepLink,
  quickShareExpiry,
  quickShareRoute,
  resolveProfileGender,
  sanitizeFavorites,
  snapshotBytes,
  toggleFavorite,
  widgetSnapshotChanged,
  widgetStatusText,
  type WidgetBuildInput,
  type WidgetFavorite,
} from '../src';

const NOW = 1_764_000_000_000;
const MIN = 60_000;
const OP = '7f8a3c2e-1b4d-4e5f-9a6b-0c1d2e3f4a5b';

describe('Faz 6 profil: cinsiyet çerçevesi ve avatar yolları', () => {
  it('genderRingColor: kadın pembe, erkek mavi, bilinmeyen gri', () => {
    expect(genderRingColor('female')).toBe('#EC4899');
    expect(genderRingColor('male')).toBe('#3B82F6');
    expect(genderRingColor(null)).toBe(GENDER_RING.unknown);
    expect(genderRingColor(undefined)).toBe(GENDER_RING.unknown);
    expect(avatarViewOf({ display_name: 'ayşe yılmaz', avatar_url: 'https://x/m', avatar_thumb_url: 'https://x/t', gender: 'female' }, 'thumb')).toEqual({
      name: 'ayşe yılmaz',
      initials: 'AY',
      photo_url: 'https://x/t',
      ring: '#EC4899',
      gender: 'female',
    });
    expect(avatarViewOf({ display_name: 'ilker', avatar_url: null }, 'main')).toMatchObject({ initials: 'İ', photo_url: null, ring: GENDER_RING.unknown });
    expect(initialsOf('  ')).toBe('?');
  });

  it('avatarObjectPaths / AVATAR_FILE_RE ve küçük boy kardeş kuralı', () => {
    const v = 1_764_000_000_123;
    const p = avatarObjectPaths('u1', v);
    expect(p).toEqual({ main: `avatars/u1/${v}.jpg`, thumb: `avatars/u1/${v}_160.jpg` });
    expect(AVATAR_FILE_RE.test(`${v}.jpg`)).toBe(true);
    expect(AVATAR_FILE_RE.test(`${v}_160.jpg`)).toBe(true);
    for (const bad of ['123.jpg', `${v}.png`, `${v}_320.jpg`, `../${v}.jpg`]) expect(AVATAR_FILE_RE.test(bad)).toBe(false);
    expect(() => avatarObjectPaths('u1', 123)).toThrow();
    const url = (o: string) => `https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/${encodeURIComponent(o)}?alt=media&token=t`;
    expect(checkAvatarPair(url(p.main), url(p.thumb), 'u1')).toBe('ok');
    expect(checkAvatarPair(url(p.main), url(avatarObjectPaths('u1', v + 1).thumb), 'u1')).toBe('thumb_mismatch');
    expect(checkAvatarPair(url(p.main), url(p.thumb), 'u2')).toBe('thumb_mismatch');
    expect(checkAvatarPair(null, url(p.thumb), 'u1')).toBe('thumb_without_main');
    expect(resolveProfileGender(null, undefined, true)).toEqual({ ok: false, code: 'gender_required' });
    expect(resolveProfileGender('male', undefined, false)).toEqual({ ok: true, gender: 'male', changed: false });
  });
});

describe('Faz 6 favoriler', () => {
  it('toggleFavorite sınırı ve FavoritesSetRequestSchema', () => {
    let list: string[] = [];
    for (const id of ['a', 'b', 'c', 'd']) list = toggleFavorite(list, id).list;
    expect(list).toHaveLength(FAVORITES_LIMIT);
    expect(toggleFavorite(list, 'e')).toEqual({ list, error: 'limit' });
    expect(toggleFavorite(list, 'b')).toEqual({ list: ['a', 'c', 'd'], error: null });
    expect(FavoritesSetRequestSchema.safeParse({ op_id: OP, favorite_ids: ['a', 'a'] }).success).toBe(false);
    expect(FavoritesSetRequestSchema.safeParse({ op_id: OP, favorite_ids: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(FavoritesSetRequestSchema.safeParse({ op_id: OP, favorite_ids: ['a', 'b'] }).success).toBe(true);
  });

  it('sanitizeFavorites: arkadaş olmayanı atar, tekrarı siler, sırayı korur, keser', () => {
    const friends = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(sanitizeFavorites(['x', 'b', 'a', 'b', 'c', 'd', 'e'], friends)).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('Faz 6 tek tuşla paylaşım', () => {
  const base = { signed_in: true, target_uid: 'u2', token_expires_at: NOW + 10 * 86_400_000, bg_location_ok: true, interactive_supported: true, now: NOW };

  it('quickShareRoute dalları (ilk uyan kazanır)', () => {
    expect(quickShareRoute(base)).toEqual({ kind: 'background' });
    expect(quickShareRoute({ ...base, signed_in: false, target_uid: null })).toEqual({ kind: 'open_app', reason: 'signed_out' });
    expect(quickShareRoute({ ...base, target_uid: null })).toEqual({ kind: 'open_app', reason: 'no_favorite' });
    expect(quickShareRoute({ ...base, interactive_supported: false, token_expires_at: null })).toEqual({ kind: 'open_app', reason: 'ios_too_old' });
    expect(quickShareRoute({ ...base, token_expires_at: null })).toEqual({ kind: 'open_app', reason: 'no_token' });
    expect(quickShareRoute({ ...base, token_expires_at: NOW + 60_000 })).toEqual({ kind: 'open_app', reason: 'token_expiring' });
    expect(quickShareRoute({ ...base, bg_location_ok: false })).toEqual({ kind: 'open_app', reason: 'no_bg_location' });
  });

  it('sunucu kararı: başlat / uzat / zaten açık', () => {
    const share = (expires_at: number | null) => ({ status: 'active' as const, share_mode: 'timed' as const, started_at: NOW - MIN, expires_at });
    expect(quickShareExpiry(null, NOW)).toEqual({ status: 'started', expires_at: NOW + 60 * MIN, share_mode: 'timed' });
    expect(quickShareExpiry(share(NOW + 10 * MIN), NOW)).toMatchObject({ status: 'extended', expires_at: NOW + 60 * MIN });
    expect(quickShareExpiry(share(NOW + 90 * MIN), NOW)).toMatchObject({ status: 'already_active', expires_at: NOW + 90 * MIN });
    expect(quickShareExpiry(share(null), NOW)).toMatchObject({ status: 'already_active', expires_at: null });
    expect(quickShareExpiry({ ...share(NOW - MIN) }, NOW).status).toBe('started');
  });

  it('derin bağlantı gidiş-dönüş, bozuk girdiler null', () => {
    const url = quickShareDeepLink('u_2-x', 'ios_widget');
    expect(url).toBe('konum://quick-share?to=u_2-x&src=ios_widget');
    expect(parseQuickShareDeepLink(url)).toEqual({ to: 'u_2-x', src: 'ios_widget' });
    expect(parseQuickShareDeepLink('konum:///quick-share?src=android_tile&to=abc')).toEqual({ to: 'abc', src: 'android_tile' });
    expect(parseQuickShareDeepLink('konum://quick-share?to=a%2Fb')).toBeNull();
    expect(parseQuickShareDeepLink('https://evil.example/quick-share?to=abc')).toBeNull();
    expect(parseQuickShareDeepLink('konum://quick-share?to=abc&src=<x>')).toEqual({ to: 'abc', src: 'unknown' });
  });

  it('sözleşme: callable adları, hata kodları ve push türleri', () => {
    expect(CALLABLES.widgetQuickShare).toBe('widget_quick_share');
    expect(new Set(Object.values(CALLABLES)).size).toBe(Object.values(CALLABLES).length);
    for (const e of QUICK_SHARE_ERRORS) expect(ERROR_CODES[e].message.length).toBeGreaterThan(5);
    expect(ERROR_CODES.gender_required.retryable).toBe(false);
    expect(PUSH_TYPES_F6).toEqual(['quick_share_started', 'widget_refresh']);
  });
});

describe('Faz 6 widget snapshot', () => {
  const input = (over: Partial<WidgetBuildInput> = {}): WidgetBuildInput => ({
    now: NOW,
    signed_in: true,
    me: { display_name: 'Erim Kaya' },
    favorite_ids: ['u1', 'gone', 'u2', 'u3', 'u4', 'u5'],
    friends: [
      { uid: 'u1', display_name: 'Ayşe Nur Yılmazoğlu Demirtaş', gender: 'female', avatar_file: 'u1_1764.jpg', incoming: { active: true, last_seen_at: NOW - 3 * MIN, battery_pct: 12, place: 'Moda Caddesi, Kadıköy' } },
      { uid: 'u2', display_name: 'Mehmet', gender: 'male', avatar_file: 'https://cdn.example/x.jpg', incoming: { active: true, last_seen_at: NOW - 22 * MIN, battery_pct: 80, place: '41.012345, 29.045678' } },
      { uid: 'u3', display_name: 'Can', incoming: null },
      { uid: 'u4', display_name: 'Deniz', gender: 'female', incoming: { active: true, paused: true, last_seen_at: NOW - MIN } },
      { uid: 'u5', display_name: 'Ece', gender: 'female' },
    ],
    outgoing: [
      { receiver_id: 'u3', status: 'active', expires_at: NOW + 59 * MIN },
      { receiver_id: 'u1', status: 'ended', expires_at: NOW + 10 * MIN },
    ],
    quick: { token_expires_at: NOW + 20 * 86_400_000, bg_location_ok: true },
    ...over,
  });

  it('buildWidgetSnapshot: sıra, kesme, durum, gizlilik', () => {
    const s = buildWidgetSnapshot(input());
    expect(s.favorites.map((f) => f.uid)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(s.default_uid).toBe('u1');
    expect(s.me_initials).toBe('EK');
    const [ayse, mehmet, can, deniz] = s.favorites as [WidgetFavorite, WidgetFavorite, WidgetFavorite, WidgetFavorite];
    expect(Array.from(ayse.name).length).toBeLessThanOrEqual(18);
    expect(ayse.name.endsWith('…')).toBe(true);
    expect(ayse).toMatchObject({ initials: 'AD', ring: '#EC4899', status: 'sharing_live', battery_low: true, place: 'Moda Caddesi, Kadıköy', my_share_expires_at: null });
    // Koordinata benzeyen yer etiketi ve URL avatar atılır
    expect(mehmet).toMatchObject({ status: 'sharing_stale', place: null, avatar_file: null, ring: '#3B82F6' });
    expect(can).toMatchObject({ status: 'not_sharing', ring: GENDER_RING.unknown, my_share_expires_at: NOW + 59 * MIN, my_share_active: true });
    expect(deniz.status).toBe('paused');
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/41\.0123|https?:|token"/);
    expect(s.quick).toEqual({ token_ok: true, bg_location_ok: true });
    expect(s.privacy).toEqual({ lock_screen_details: false });
    expect(parseWidgetSnapshot(json)).toEqual(s);
    // Oturum kapalı: hiçbir kişisel veri yok
    const out = buildWidgetSnapshot(input({ signed_in: false }));
    expect(out).toMatchObject({ signed_in: false, favorites: [], default_uid: null, me_initials: null, quick: { token_ok: false } });
  });

  it('maxBytes: önce yer, sonra avatar, en son favori atılır', () => {
    const full = buildWidgetSnapshot(input());
    const noPlace = { ...full, favorites: full.favorites.map((f) => ({ ...f, place: null })) };
    const s1 = buildWidgetSnapshot(input({ max_bytes: snapshotBytes(noPlace) }));
    expect(s1.favorites).toHaveLength(4);
    expect(s1.favorites.every((f) => f.place === null)).toBe(true);
    expect(s1.favorites[0]!.avatar_file).toBe('u1_1764.jpg');
    const s2 = buildWidgetSnapshot(input({ max_bytes: snapshotBytes(noPlace) - 1 }));
    expect(s2.favorites.every((f) => f.avatar_file === null)).toBe(true);
    const s3 = buildWidgetSnapshot(input({ max_bytes: 900 }));
    expect(snapshotBytes(s3)).toBeLessThanOrEqual(900);
    expect(s3.favorites.length).toBeLessThan(4);
    expect(s3.default_uid).toBe(s3.favorites[0]?.uid ?? null);
    expect(snapshotBytes(full)).toBeLessThan(16_384);
  });

  it('widgetSnapshotChanged: major / minor / none', () => {
    const a = buildWidgetSnapshot(input());
    expect(widgetSnapshotChanged(null, a)).toBe('major');
    expect(widgetSnapshotChanged(a, buildWidgetSnapshot(input({ now: NOW + 1 })))).toBe('none');
    const later = input();
    (later.friends[0]!.incoming as { battery_pct: number }).battery_pct = 50;
    expect(widgetSnapshotChanged(a, buildWidgetSnapshot(later))).toBe('minor');
    expect(widgetSnapshotChanged(a, buildWidgetSnapshot(input({ outgoing: [] })))).toBe('major');
    expect(widgetSnapshotChanged(a, buildWidgetSnapshot(input({ favorite_ids: ['u2', 'u1'] })))).toBe('major');
    expect(widgetSnapshotChanged(a, buildWidgetSnapshot(input({ quick: { token_expires_at: null, bg_location_ok: true } })))).toBe('major');
  });

  it('widgetStatusText ve formatCountdown', () => {
    const s = buildWidgetSnapshot(input());
    const [ayse, mehmet, can, deniz] = s.favorites as [WidgetFavorite, WidgetFavorite, WidgetFavorite, WidgetFavorite];
    expect(widgetStatusText(ayse, NOW, false)).toBe('Paylaşıyor · 3 dk önce');
    expect(widgetStatusText(ayse, NOW, true)).toBe('Paylaşıyor · 3 dk');
    // Zaman çizelgesi ilerleyince canlı → bağlantı yok
    expect(widgetStatusText(ayse, NOW + 20 * MIN, false)).toBe('Bağlantı yok · 23 dk');
    expect(widgetStatusText(mehmet, NOW, false)).toBe('Bağlantı yok · 22 dk');
    expect(widgetStatusText(can, NOW, false)).toBe('Paylaşmıyor');
    expect(widgetStatusText(deniz, NOW, true)).toBe('Duraklatıldı');
    expect(formatCountdown(60 * MIN)).toBe('1 sa');
    expect(formatCountdown(59 * MIN + 1)).toBe('1 sa');
    expect(formatCountdown(59 * MIN)).toBe('59 dk');
    expect(formatCountdown(90 * MIN)).toBe('1 sa 30 dk');
    expect(formatCountdown(20_000)).toBe('1 dk');
    expect(formatCountdown(0)).toBe('0 dk');
  });
});
