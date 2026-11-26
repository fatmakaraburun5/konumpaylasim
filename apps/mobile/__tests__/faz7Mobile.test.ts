/**
 * Faz 7 mobil: bildirim yönlendirmesi (kanal / iOS kesinti düzeyi / ses), SOS alarm kanalı, pil alanı süzgeci,
 * harita stili ve tema tercihi, gizlilik deposunun sıra garantisi, etkinlik deposunun eşitlik ekleri.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NOTIFICATION_CHANNELS_F7, resolveColorScheme, SOS_ALARM_SOUND, type EventDoc, type PrivacySettings } from '@konum/core';
import { KonumError } from '../src/lib/errors';
import { stripBatteryFields, withoutBattery } from '../src/services/location/pipeline';
import { f4ForegroundContent, localSound } from '../src/services/notifications/f4Push';
import { f7EventRoute, f7ForegroundContent, parseF7Data } from '../src/services/notifications/f7Push';
import { createEventsStore } from '../src/state/eventsStore';
import { batteryShareAllowed, loadPrivacy, savePrivacy, __resetPrivacyCacheForTests } from '../src/state/persist';
import { createPrivacyStore } from '../src/state/privacyStore';
import { MAP_STYLES, mapStyleFor, themeFor } from '../src/ui/theme';
import { __resetThemePrefForTests, setThemePref, themePrefStore } from '../src/ui/themePref';

describe('Faz 7 bildirimleri', () => {
  it('veri doğrulanır: bilinmeyen aşama / eksik alan reddedilir', () => {
    expect(parseF7Data({ type: 'event_invite', event_id: 'e1', from: 'ayse' })).toEqual({ type: 'event_invite', event_id: 'e1', from: 'ayse' });
    expect(parseF7Data({ type: 'event_stage', event_id: 'e1', notice: 'uydurma' })).toBeNull();
    expect(parseF7Data({ type: 'event_rsvp', event_id: 'e1', by: 'can', round: 'initial' })).toBeNull();
    expect(parseF7Data({ type: 'movement', from: 'mehmet', kind: 'departed' })).toEqual({ type: 'movement', from: 'mehmet', kind: 'departed' });
    expect(parseF7Data({ type: 'sos', sos_id: 'x' })).toBeNull();
  });

  it('kanal ve kesinti düzeyi: hareket ve hatırlatma "time sensitive", yanıtlar sessiz', () => {
    const move = f7ForegroundContent({ data: { type: 'movement', from: 'mehmet', kind: 'departed' }, notification: { title: 'Mehmet yola çıktı', body: 'x' } });
    expect(move).toMatchObject({ channelId: NOTIFICATION_CHANNELS_F7.movement, interruptionLevel: 'timeSensitive', sound: true, title: 'Mehmet yola çıktı' });
    const rem = f7ForegroundContent({ data: { type: 'event_reminder', event_id: 'e1', kind: 'morning' } });
    expect(rem).toMatchObject({ channelId: NOTIFICATION_CHANNELS_F7.eventReminders, interruptionLevel: 'timeSensitive', title: 'Bugün etkinliğin var' });
    const rsvp = f7ForegroundContent({ data: { type: 'event_rsvp', event_id: 'e1', by: 'can', round: 'initial', status: 'not_going' } }, () => 'Can');
    expect(rsvp).toMatchObject({ channelId: NOTIFICATION_CHANNELS_F7.events, sound: false, body: 'Can katılamayacak' });
    expect(f7EventRoute({ type: 'event_cancelled', event_id: 'e 1' })).toBe('/events/e%201');
    expect(f7EventRoute({ type: 'movement', from: 'm', kind: 'departed' })).toBeNull();
  });

  it('SOS ön plan bildirimi yeni alarm kanalında ve özel sesle', () => {
    const c = f4ForegroundContent({ data: { type: 'sos', sos_id: 's1', sender_id: 'ayse' }, notification: { title: 'SOS', body: 'Ayşe yardım istiyor' } }, { includePing: true });
    expect(c?.channelId).toBe(NOTIFICATION_CHANNELS_F7.sosAlarm);
    expect(c ? localSound(c) : null).toBe(SOS_ALARM_SOUND.ios);
    expect(localSound({ sound: false })).toBe(false);
    expect(localSound({ sound: true })).toBe('default');
  });
});

describe('Faz 7 pil paylaşımı (istemci)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    __resetPrivacyCacheForTests();
  });

  it('kuyruk yazılarından pil alanları ayıklanır (yol sonu ve iç içe)', () => {
    const out = stripBatteryFields({
      'live_locations/a/s1': { lat: 1, lng: 2, battery_pct: 50, is_charging: true },
      'live_locations/a/s2/battery_pct': 40,
      'live_trail/a/s1/p1': { lat: 1, battery_pct: 30 },
    });
    expect(out).toEqual({ 'live_locations/a/s1': { lat: 1, lng: 2 }, 'live_trail/a/s1/p1': { lat: 1 } });
    expect(withoutBattery({ batteryLevel: 0.1, isCharging: false } as never)).toEqual({ batteryLevel: null, isCharging: null });
  });

  it('kayıt yoksa ya da başka hesabınsa pil paylaşılmaz', async () => {
    expect(await batteryShareAllowed('u1')).toBe(false);
  });

  it('kapatırken cihaz kopyası sunucu yanıtından ÖNCE kapanır; açarken ancak onaydan SONRA açılır', async () => {
    let profile: { privacy: PrivacySettings | null } = { privacy: { battery_share: true, movement_alerts: true, updated_at: 1 } };
    const auth = { getState: () => ({ uid: 'u1', profile, patchProfileLocal: (p: { privacy: PrivacySettings }) => (profile = { ...profile, ...p }) }) };
    const seen: boolean[] = [];
    let release: () => void = () => undefined;
    const api = {
      privacySettingsSet: jest.fn(async (patch: { battery_share?: boolean }) => {
        seen.push((await loadPrivacy())?.battery_share ?? false);
        await new Promise<void>((r) => (release = r));
        return { privacy: { battery_share: patch.battery_share ?? true, movement_alerts: true, updated_at: 2 }, server_now: 2 };
      }),
    };
    const store = createPrivacyStore({ api: api as never, auth: auth as never, persist: savePrivacy });
    const off = store.getState().set({ battery_share: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([false]); // API çağrılırken kopya zaten kapalı
    expect(store.getState().pending).toEqual({ battery_share: false });
    release();
    expect(await off).toEqual({ ok: true });
    expect(profile.privacy?.battery_share).toBe(false);

    const on = store.getState().set({ battery_share: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[1]).toBe(false); // açılış henüz onaylanmadı
    release();
    await on;
    expect(await batteryShareAllowed('u1')).toBe(true);
    expect(await batteryShareAllowed('u2')).toBe(false);
  });
});

describe('Faz 7 harita teması', () => {
  afterEach(() => __resetThemePrefForTests());

  it('stil dizileri önceden hesaplanır: aynı şema aynı başvuru (anında geçiş, yeniden çizim yok)', () => {
    expect(mapStyleFor(themeFor('dark'))).toBe(MAP_STYLES.dark);
    expect(mapStyleFor(themeFor('light'))).toBe(MAP_STYLES.light);
    expect(MAP_STYLES.dark).not.toEqual(MAP_STYLES.light);
    expect(Object.isFrozen(MAP_STYLES)).toBe(true);
  });

  it('tercih: Sistem cihazı izler, Açık / Koyu sabitler ve cihazda saklanır', async () => {
    expect(resolveColorScheme('system', 'dark')).toBe('dark');
    expect(resolveColorScheme('light', 'dark')).toBe('light');
    setThemePref('dark');
    expect(themePrefStore.getState().pref).toBe('dark');
    await new Promise((r) => setTimeout(r, 0));
    const keys = await AsyncStorage.getAllKeys();
    expect(keys.some((k) => k.includes('theme'))).toBe(true);
  });
});

describe('Faz 7 etkinlik deposu', () => {
  const doc = (version: number): EventDoc =>
    ({ event_id: 'e1', version, owner_id: 'me', member_ids: ['me', 'a'], invitee_ids: ['a'], stage: 'venue_vote' }) as unknown as EventDoc;

  it('eşit oyda sunucunun liderleri `extra` ile döner; yüksek sürüm kazanır', async () => {
    const api = {
      eventAdvance: jest.fn(async () => {
        throw new KonumError('event_vote_tie', undefined, undefined, { code: 'event_vote_tie', leaders: ['v1', 'v2'] });
      }),
      eventVote: jest.fn(async () => ({ event: doc(3), skipped_count: 0, server_now: 1 })),
    };
    const store = createEventsStore({ api: api as never, now: () => 1 });
    store.getState().setEvents('me', [doc(2)]);
    const r = await store.getState().advance('e1', 'close_venue_vote');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('event_vote_tie');
      expect(r.extra.leaders).toEqual(['v1', 'v2']);
    }
    await store.getState().vote('e1', 'venue', 'v1');
    expect(store.getState().events.e1?.version).toBe(3);
    store.getState().setEvents('me', [doc(2)]); // eski dinleyici anlık görüntüsü geri almaz
    expect(store.getState().events.e1?.version).toBe(3);
  });
});
