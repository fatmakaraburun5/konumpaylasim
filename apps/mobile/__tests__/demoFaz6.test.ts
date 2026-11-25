/**
 * Web demo sunucusu (yalnızca tarayıcı önizlemesi) Faz 6 sözleşmesi: kayıtta zorunlu cinsiyet, avatar Storage
 * kuralları + `checkAvatarPair`, `favorites_set`, widget token'ı ve OTURUMSUZ `widget_quick_share` (started /
 * extended / already_active, hata sırası, hız sınırı, op_id), `widget_refresh` push'u ve core `buildWidgetSnapshot`
 * girdisi. Backend `handlers/user.ts`, `favorites.ts`, `widget.ts` ile aynı anlamı denetler.
 */
import {
  buildWidgetSnapshot,
  GENDER_RING,
  HOUR,
  MINUTE,
  uuidV4,
  WidgetQuickShareResponseSchema,
  WidgetTokenIssueResponseSchema,
  type WidgetQuickShareResponse,
} from '@konum/core';
import { DemoStorageError } from '../src/demo/server/avatars';
import { DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, PEOPLE } from '../src/demo/server/world';
import { demoWidgetInput } from '../src/demo/web/widgetModel';

jest.setTimeout(30_000);

const servers: DemoServer[] = [];
function server(): DemoServer {
  const s = new DemoServer();
  servers.push(s);
  return s;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.reset();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TZ = 'Europe/Istanbul';
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { details?: { code?: string }; code?: string }).details?.code ?? (e as { code?: string }).code ?? String(e);
  }
};
/** Küçük, geçerli base64 "JPEG" (sunucu yalnızca biçim + boyut denetler). */
const jpeg = (bytes: number) => `data:image/jpeg;base64,${'BwcH'.repeat(Math.ceil(bytes / 3))}`; // 0x07 baytları

async function issueToken(s: DemoServer, device = 'test-device-1') {
  return WidgetTokenIssueResponseSchema.parse(await s.call('widget_token_issue', { op_id: uuidV4(), device_id: device }, DEMO_ME));
}
const quick = (s: DemoServer, token: string, to: string, op_id = uuidV4()) =>
  s.call('widget_quick_share', { token, to_uid: to, op_id, source: 'ios_widget' }, null) as Promise<WidgetQuickShareResponse>;

describe('demo Faz 6: cinsiyet ve profil fotoğrafı', () => {
  it('ad verilirken cinsiyet zorunlu (gender_required), null reddedilir, sonra korunur ve arkadaş kopyasına yayılır', async () => {
    const s = server();
    expect(s.profileOf(DEMO_ME)?.gender).toBeNull();
    // Girişteki kalp atışı (ad / cinsiyet yok) profil oluşturmaz, hata vermez.
    expect(await codeOf(s.call('user_bootstrap', { op_id: uuidV4(), time_zone: TZ }, DEMO_ME))).toBe('ok');
    expect(await codeOf(s.call('user_bootstrap', { op_id: uuidV4(), time_zone: TZ, display_name: 'Deniz Kaya' }, DEMO_ME))).toBe('gender_required');
    expect(await codeOf(s.call('user_bootstrap', { op_id: uuidV4(), time_zone: TZ, display_name: 'Deniz Kaya', gender: null }, DEMO_ME))).toBe('invalid_argument');
    await s.call('user_bootstrap', { op_id: uuidV4(), time_zone: TZ, display_name: 'Deniz Kaya', gender: 'female' }, DEMO_ME);
    await s.call('user_bootstrap', { op_id: uuidV4(), time_zone: TZ, display_name: 'Deniz K.' }, DEMO_ME);
    expect(s.profileOf(DEMO_ME)).toMatchObject({ display_name: 'Deniz K.', gender: 'female' });
    const ayseSide = s.friendshipsOf(PEOPLE.ayse.uid).find((f) => f.member_ids.includes(DEMO_ME));
    expect(ayseSide?.member_profiles[DEMO_ME]).toMatchObject({ display_name: 'Deniz K.', gender: 'female' });

    // Botlar: cinsiyet + çizim avatar (yerel SVG adresi); Can fotoğrafsız; bekleyen istek (Elif) yalnızca ad.
    const mine = s.friendshipsOf(DEMO_ME);
    const prof = (uid: string) => mine.find((f) => f.member_ids.includes(uid))?.member_profiles[uid];
    expect(prof(PEOPLE.ayse.uid)).toMatchObject({ gender: 'female' });
    expect(prof(PEOPLE.ayse.uid)?.avatar_url).toMatch(/^data:image\/svg\+xml/);
    expect(prof(PEOPLE.mehmet.uid)?.gender).toBe('male');
    expect(prof(PEOPLE.can.uid)).toMatchObject({ gender: 'male', avatar_url: null, avatar_thumb_url: null });
    expect(prof(PEOPLE.elif.uid)).toMatchObject({ gender: null, avatar_url: null });
  });

  it('Storage kuralları (sahibi, JPEG, boyut) ve avatar çifti doğrulaması; değişince eski sürüm silinir', async () => {
    const s = server();
    const v1 = 1_764_000_000_000;
    const up = (path: string, data = jpeg(2_000), type = 'image/jpeg', uid: string | null = DEMO_ME) => s.storageUpload(path, data, type, uid);
    expect(await codeOf(up(`avatars/${PEOPLE.ayse.uid}/${v1}.jpg`))).toBe('storage/unauthorized');
    expect(await codeOf(up(`avatars/${DEMO_ME}/${v1}.jpg`, jpeg(2_000), 'image/png'))).toBe('storage/unauthorized');
    expect(await codeOf(up(`avatars/${DEMO_ME}/${v1}_160.jpg`, jpeg(61_000)))).toBe('storage/unauthorized');
    expect(await codeOf(up(`avatars/${DEMO_ME}/foto.jpg`))).toBe('storage/unauthorized');
    expect(await codeOf(up(`avatars/${DEMO_ME}/${v1}.jpg`, jpeg(2_000), 'image/jpeg', null))).toBe('storage/unauthenticated');
    await expect(up(`avatars/${PEOPLE.ayse.uid}/${v1}.jpg`)).rejects.toBeInstanceOf(DemoStorageError);

    const main = await up(`avatars/${DEMO_ME}/${v1}.jpg`, jpeg(30_000));
    const thumb = await up(`avatars/${DEMO_ME}/${v1}_160.jpg`, jpeg(5_000));
    expect(main.download_url).toMatch(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/avatars%2Fdeniz%2F\d{13}\.jpg\?alt=media&token=/);
    const boot = (extra: Record<string, unknown>) => s.call('user_bootstrap', { op_id: uuidV4(), time_zone: TZ, ...extra }, DEMO_ME);
    expect(await codeOf(boot({ avatar_url: 'https://example.com/a.jpg' }))).toBe('invalid_argument');
    expect(await codeOf(boot({ avatar_url: main.download_url, avatar_thumb_url: main.download_url }))).toBe('invalid_argument');
    await boot({ avatar_url: main.download_url, avatar_thumb_url: thumb.download_url });
    const p = s.profileOf(DEMO_ME);
    expect(p?.avatar_version).toBe(v1);
    // Okumada yerel adrese çözülür (tarayıcı ağa çıkmaz).
    expect(p?.avatar_url && !p.avatar_url.startsWith('https:')).toBe(true);
    expect(p?.avatar_thumb_url).toBeTruthy();

    const v2 = v1 + 1_000;
    const main2 = await up(`avatars/${DEMO_ME}/${v2}.jpg`);
    const thumb2 = await up(`avatars/${DEMO_ME}/${v2}_160.jpg`);
    await boot({ avatar_url: main2.download_url, avatar_thumb_url: thumb2.download_url });
    expect(s.storageHas(`avatars/${DEMO_ME}/${v1}.jpg`)).toBe(false);
    expect(s.storageHas(`avatars/${DEMO_ME}/${v1}_160.jpg`)).toBe(false);
    await boot({ avatar_url: null });
    expect(s.profileOf(DEMO_ME)).toMatchObject({ avatar_url: null, avatar_thumb_url: null, avatar_version: null });
  });
});

describe('demo Faz 6: favoriler', () => {
  it('favorites_set arkadaş olmayanı / kendini sessizce atar, 5. kişi ve tekrar reddedilir; arkadaşlık bitince düşer', async () => {
    const s = server();
    expect(s.profileOf(DEMO_ME)?.favorite_ids).toEqual([PEOPLE.ayse.uid, PEOPLE.mehmet.uid, PEOPLE.zeynep.uid]);
    const set = (ids: string[]) => s.call('favorites_set', { op_id: uuidV4(), favorite_ids: ids }, DEMO_ME);
    expect(await set([PEOPLE.can.uid, PEOPLE.elif.uid, DEMO_ME, PEOPLE.ayse.uid])).toEqual({ favorite_ids: [PEOPLE.can.uid, PEOPLE.ayse.uid] });
    expect(await codeOf(set(['ayse', 'mehmet', 'zeynep', 'can', 'elif']))).toBe('invalid_argument');
    expect(await codeOf(set(['ayse', 'ayse']))).toBe('invalid_argument');
    expect(await codeOf(s.call('favorites_set', { op_id: uuidV4(), favorite_ids: [] }, null))).toBe('unauthenticated');
    const fid = s.friendshipsOf(DEMO_ME).find((f) => f.member_ids.includes(PEOPLE.can.uid))?.id as string;
    await s.call('friendship_remove', { op_id: uuidV4(), friendship_id: fid }, DEMO_ME);
    expect(s.profileOf(DEMO_ME)?.favorite_ids).toEqual([PEOPLE.ayse.uid]);
  });
});

describe('demo Faz 6: widget token + tek tuşla paylaşım', () => {
  it('token yalnızca yanıtta; oturumsuz hızlı paylaşım started → extended, op_id tekrarı aynı yanıt; gönderene push', async () => {
    const s = server();
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => pushes.push(m));
    const t = await issueToken(s);
    expect(t.endpoint_path).toBe('widget_quick_share');
    expect(t.expires_at - Date.now()).toBeGreaterThan(29 * 24 * HOUR);
    expect(JSON.stringify((s as unknown as { db: unknown }).db)).not.toContain(t.token);

    const op = uuidV4();
    const before = Date.now();
    const r1 = WidgetQuickShareResponseSchema.parse(await quick(s, t.token, PEOPLE.ayse.uid, op));
    expect(r1).toMatchObject({ status: 'started', to_name: 'Ayşe Yılmaz' });
    expect((r1.expires_at as number) - before).toBeGreaterThanOrEqual(60 * MINUTE - 1_000);
    expect(s.sharesWhere('sender_id', DEMO_ME).find((x) => x.receiver_id === PEOPLE.ayse.uid)?.status).toBe('active');
    // Aynı op_id: aynı yanıt, sayaç artmaz.
    expect(await quick(s, t.token, PEOPLE.ayse.uid, op)).toEqual(r1);
    expect(s.widgetSource(DEMO_ME).tokens.find((x) => !x.revoked)?.uses.count).toBe(1);
    await wait(5);
    const r2 = await quick(s, t.token, PEOPLE.ayse.uid);
    expect(r2.status).toBe('extended');
    expect(r2.share_id).toBe(r1.share_id);
    expect(r2.expires_at as number).toBeGreaterThan(r1.expires_at as number);

    await wait(900);
    const visible = pushes.filter((m) => m.data.type === 'quick_share_started');
    expect(visible[0]?.notification?.body).toBe('Ayşe Yılmaz ile 1 saatlik paylaşım başladı');
    expect(visible[0]?.data).toMatchObject({ share_id: r1.share_id, expires_at: String(r1.expires_at) });
    expect(pushes.some((m) => m.data.type === 'resume_tracking')).toBe(true);
    // Push'ta koordinat yok.
    expect(JSON.stringify(pushes)).not.toMatch(/"lat"|"lng"/);
  });

  it('hata sırası: not_favorite, already_active, rate_limited, token_expired, iptalden sonra token_invalid', async () => {
    const s = server();
    const t = await issueToken(s);
    expect(await codeOf(quick(s, t.token, PEOPLE.can.uid))).toBe('not_favorite');
    expect(await codeOf(quick(s, t.token, DEMO_ME))).toBe('not_favorite');
    expect(await codeOf(quick(s, 'A'.repeat(43), PEOPLE.ayse.uid))).toBe('token_invalid');
    // Mehmet'e zaten 8 saatlik paylaşım var → already_active (bitiş değişmez).
    await s.call('share_start', { op_id: uuidV4(), receiver_ids: [PEOPLE.mehmet.uid], duration: { kind: 'preset', preset: 'h8' }, time_zone: TZ }, DEMO_ME);
    const h8 = s.sharesWhere('sender_id', DEMO_ME).find((x) => x.receiver_id === PEOPLE.mehmet.uid)?.expires_at;
    expect(await quick(s, t.token, PEOPLE.mehmet.uid)).toMatchObject({ status: 'already_active', expires_at: h8 });

    expect(s.exhaustWidgetTokens(DEMO_ME, null)).toBe(1);
    expect(await codeOf(quick(s, t.token, PEOPLE.ayse.uid))).toBe('rate_limited');
    expect(s.expireWidgetTokens(DEMO_ME, null)).toBe(1);
    expect(await codeOf(quick(s, t.token, PEOPLE.ayse.uid))).toBe('token_expired');

    // Aynı cihaz yeniden alınca eskisi iptal; çıkışta hepsi iptal.
    const a = await issueToken(s, 'test-device-2');
    const b = await issueToken(s, 'test-device-2');
    expect(await codeOf(quick(s, a.token, PEOPLE.ayse.uid))).toBe('token_invalid');
    // Backend ile aynı: iptal edilmemiş her token sayılır (süresi dolmuş test-device-1 + test-device-2).
    expect(await s.call('widget_token_revoke', { op_id: uuidV4(), device_id: null }, DEMO_ME)).toEqual({ revoked: 2 });
    expect(await codeOf(quick(s, b.token, PEOPLE.ayse.uid))).toBe('token_invalid');
  });

  it('widget_refresh: favorim bana paylaşımı durdurunca yalnızca veri push; snapshot core ile kurulur', async () => {
    const s = server();
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => pushes.push(m));
    const t = await issueToken(s);
    const { input, files } = demoWidgetInput(s.widgetSource(DEMO_ME), {
      now: Date.now(),
      signed_in: true,
      token_expires_at: t.expires_at,
      bg_location_ok: true,
      lock_screen_details: false,
      placeOf: () => 'Bahariye Cd.',
    });
    const snap = buildWidgetSnapshot(input);
    expect(snap.favorites.map((f) => f.uid)).toEqual([PEOPLE.ayse.uid, PEOPLE.mehmet.uid, PEOPLE.zeynep.uid]);
    expect(snap.default_uid).toBe(PEOPLE.ayse.uid);
    expect(snap.favorites[0]).toMatchObject({ ring: GENDER_RING.female, status: 'sharing_live', place: 'Bahariye Cd.' });
    expect(snap.favorites[1]?.ring).toBe(GENDER_RING.male);
    const file = snap.favorites[0]?.avatar_file as string;
    expect(file).toMatch(/^ayse_\d{13}\.jpg$/);
    expect(files[file]).toMatch(/^data:image\/svg\+xml/);
    expect(snap.quick).toEqual({ token_ok: true, bg_location_ok: true });
    expect(JSON.stringify(snap)).not.toMatch(/"lat"|"lng"|https?:/);

    s.botStopSharing(PEOPLE.ayse.uid);
    await wait(900);
    expect(pushes.find((m) => m.data.type === 'widget_refresh')).toEqual({ data: { type: 'widget_refresh', from: PEOPLE.ayse.uid } });
  });
});
