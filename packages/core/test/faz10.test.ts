import { describe, expect, it } from 'vitest';
import {
  CALLABLES,
  CONSENT_EXEMPT_CALLABLES,
  ETA_BOARD_LIMITS,
  MINUTE,
  ONBOARDING_STEPS,
  SECURITY_LIMITS,
  buildEtaBoard,
  calendarAddStep,
  calendarEntryFromEvent,
  calendarSyncAction,
  checkOtp,
  compareMigration,
  eventReminderRecipients,
  googleCalendarUrl,
  icsFromEntry,
  maskEmail,
  migrationDigest,
  nextOnboardingStep,
  normalizeEmail,
  onboardingDoneForUpgrade,
  orderedDigest,
  permissionCenterRows,
  revokedDeviceKey,
  type ChallengeRecord,
  type EtaBoardPoint,
  type EventDoc,
  type PermissionSnapshot,
} from '../src';

const T = Date.UTC(2026, 10, 28, 15, 0); // 18:00 İstanbul
const VENUE = { lat: 40.9819, lng: 29.0254 };

function finalEvent(over: Partial<EventDoc> = {}): EventDoc {
  return {
    event_id: 'ev1',
    owner_id: 'ayse',
    title: 'Moda’da buluşma',
    description: null,
    date: '2026-11-28',
    time_zone: 'Europe/Istanbul',
    invitee_ids: ['me', 'mehmet', 'zeynep', 'can'],
    member_ids: ['ayse', 'me', 'mehmet', 'zeynep', 'can'],
    names: { ayse: 'Ayşe Yılmaz', me: 'Deniz Kaya', mehmet: 'Mehmet Demir', zeynep: 'Zeynep Arslan', can: 'Can Öztürk' },
    stage: 'final',
    respond_by: null,
    vote_window_ms: 0,
    answers: {
      me: { status: 'going', note: null, venue_option_id: 'v1', time_option_id: 't2', at: 0 },
      mehmet: { status: 'going', note: null, venue_option_id: 'v1', time_option_id: 't2', at: 0 },
      zeynep: { status: 'going', note: null, venue_option_id: 'v1', time_option_id: 't2', at: 0 },
      can: { status: 'not_going', note: 'İşim var', venue_option_id: null, time_option_id: null, at: 0 },
    },
    venue_options: [{ option_id: 'v1', name: 'Moda Sahili Çay Bahçesi', address: 'Moda, Kadıköy', location: VENUE, place_id: null }],
    time_options: [{ option_id: 't2', minute_of_day: 19 * 60, starts_at: T + 60 * MINUTE }],
    results_at: null,
    results_reason: null,
    venue_option_id: 'v1',
    time_option_id: 't2',
    starts_at: T + 60 * MINUTE,
    finalized_at: T - 60 * MINUTE,
    expires_at: T + 6 * 60 * MINUTE,
    end_reason: null,
    ended_at: null,
    seq: 2,
    created_at: 0,
    updated_at: 0,
    version: 3,
    ...over,
  };
}

/** Mekana `m` metre kuzeyde bir nokta. */
const north = (uid: string, m: number, at: number, extra: Partial<EtaBoardPoint> = {}): EtaBoardPoint => ({
  uid,
  lat: VENUE.lat + m / 111_320,
  lng: VENUE.lng,
  accuracy: 10,
  timestamp: at,
  activity_state: 'walking',
  ...extra,
});

describe('Faz 10 · takvim kaydı', () => {
  it('yalnızca final + başlamamış + katılan üye için; başlık, saat, mekan, koordinat, harita, katılımcı özeti', () => {
    const r = calendarEntryFromEvent(finalEvent(), 'me', T);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toMatchObject({ title: 'Moda’da buluşma', starts_at: T + 60 * MINUTE, ends_at: T + 180 * MINUTE, location: 'Moda Sahili Çay Bahçesi, Moda, Kadıköy' });
    expect(r.entry.maps_url).toContain('query=40.981900%2C29.025400');
    expect(r.entry.notes).toContain('Katılacak (4): Ayşe Yılmaz, Sen, Mehmet Demir, Zeynep Arslan');
    expect(r.entry.notes).toContain('Katılamayacak (1): Can Öztürk');
    expect(r.entry.attendees.going).toHaveLength(4);
    expect(calendarEntryFromEvent(finalEvent({ stage: 'voting' }), 'me', T)).toEqual({ ok: false, reason: 'not_final' });
    expect(calendarEntryFromEvent(finalEvent(), 'can', T)).toEqual({ ok: false, reason: 'not_going' });
    expect(calendarEntryFromEvent(finalEvent(), 'stranger', T)).toEqual({ ok: false, reason: 'not_member' });
    expect(calendarEntryFromEvent(finalEvent(), 'me', T + 61 * MINUTE)).toEqual({ ok: false, reason: 'started' });
  });

  it('ICS: CRLF, GEO, VALARM, kaçış ve 75 sekizli katlama; Google şablonu', () => {
    const r = calendarEntryFromEvent(finalEvent({ title: 'Kahve; sohbet, gülüş' }), 'me', T);
    if (!r.ok) throw new Error('entry');
    const ics = icsFromEntry(r.entry, T);
    expect(ics).toContain('SUMMARY:Kahve\\; sohbet\\, gülüş');
    expect(ics).toContain('GEO:40.981900;29.025400');
    expect(ics).toContain('TRIGGER:-PT45M');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(googleCalendarUrl(r.entry)).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=/);
  });

  it('ekleme adımı ve eşitleme kararı', () => {
    expect(calendarAddStep('ios', 'undetermined', false)).toBe('consent');
    expect(calendarAddStep('ios', 'write_only', false)).toBe('write');
    expect(calendarAddStep('android', 'denied', true)).toBe('system_form');
    expect(calendarAddStep('web', 'unavailable', false)).toBe('fallback_link');
    const r = calendarEntryFromEvent(finalEvent(), 'me', T);
    if (!r.ok) throw new Error('entry');
    expect(calendarSyncAction({ fingerprint: r.entry.fingerprint }, r, 'write_only', 'final')).toBe('none');
    expect(calendarSyncAction({ fingerprint: 'x' }, r, 'write_only', 'final')).toBe('offer_update');
    expect(calendarSyncAction({ fingerprint: 'x' }, r, 'full', 'final')).toBe('update');
    expect(calendarSyncAction({ fingerprint: 'x' }, { ok: false, reason: 'not_final' }, 'granted', 'cancelled')).toBe('remove');
  });
});

describe('Faz 10 · "Kim ne kadar uzakta?" şeridi', () => {
  const now = T + 20 * MINUTE; // başlangıca 40 dk
  const pts = [north('ayse', 400, now), north('mehmet', 1100, now), north('zeynep', 1700, now - 12 * MINUTE), north('can', 200, now), north('me', 600, now)];

  it('45 dk kala açılır; yalnızca katılanlar ve konumu gelenler; yakından uzağa; eski konum sonda', () => {
    expect(buildEtaBoard({ doc: finalEvent(), viewer: 'me', now: T + 10 * MINUTE, points: pts }).state).toBe('hidden');
    const b = buildEtaBoard({ doc: finalEvent(), viewer: 'me', now, points: pts });
    expect(b.state).toBe('open');
    expect(b.entries.map((e) => e.name)).toEqual(['Ayşe', 'Sen', 'Mehmet', 'Zeynep']);
    expect(b.entries.map((e) => e.uid)).not.toContain('can');
    expect(b.entries[0]!.label).toMatch(/^Ayşe · \d+ dk$/);
    expect(b.entries[3]!.status).toBe('stale');
    expect(b.entries[3]!.label).toMatch(/^Zeynep · ~\d+ dk$/);
    expect(b.headline).toBe('Buluşmaya 40 dk');
  });

  it('izin denetimi ve gelmeyen katılımcı sayısı', () => {
    const b = buildEtaBoard({ doc: finalEvent(), viewer: 'me', now, points: pts, allowed: (u) => u !== 'mehmet' });
    expect(b.entries.map((e) => e.uid)).toEqual(['ayse', 'me', 'zeynep']);
    expect(b.hidden_count).toBe(1);
  });

  it('paketteki Faz 9 hedefi önceliklidir; varan "Vardı" olur', () => {
    const b = buildEtaBoard({
      doc: finalEvent(),
      viewer: 'me',
      now,
      points: [north('ayse', 2000, now, { dest_name: 'Moda Sahili Çay Bahçesi', dest_state: 'near', dest_eta: 3 }), north('mehmet', 50, now)],
    });
    expect(b.entries.map((e) => e.label)).toEqual(['Mehmet · Vardı', 'Ayşe · 3 dk']);
  });

  it('başlangıç + 30 dk ya da herkes varınca kapanır; etkinlik final değilse kapalı', () => {
    expect(buildEtaBoard({ doc: finalEvent(), viewer: 'me', now: T + 60 * MINUTE + ETA_BOARD_LIMITS.closeAfterStartMs, points: pts }).state).toBe('closed');
    const arrived = [north('ayse', 20, T + 65 * MINUTE), north('me', 30, T + 65 * MINUTE)];
    expect(buildEtaBoard({ doc: finalEvent(), viewer: 'me', now: T + 65 * MINUTE, points: arrived }).state).toBe('closed');
    expect(buildEtaBoard({ doc: finalEvent({ stage: 'cancelled' }), viewer: 'me', now, points: pts }).state).toBe('closed');
  });

  it('45 dk hatırlatması yalnızca katılanlara', () => {
    expect(eventReminderRecipients(finalEvent(), 'eta_window')).toEqual(['ayse', 'me', 'mehmet', 'zeynep']);
  });
});

describe('Faz 10 · kurtarma ve cihaz oturumları', () => {
  const rec: ChallengeRecord = {
    challenge_id: 'c'.repeat(20),
    owner_id: 'me',
    channel: 'email',
    purpose: 'device_second_factor',
    to: 'deniz@gmail.com',
    to_masked: maskEmail('deniz@gmail.com'),
    code_hash: 'h:123456',
    attempts: 0,
    sends: 1,
    state: 'pending',
    created_at: T,
    expires_at: T + SECURITY_LIMITS.otpTtlMs,
    resend_at: T + SECURITY_LIMITS.otpResendMs,
    dsid: 'd'.repeat(20),
  };
  const h = (c: string) => `h:${c}`;

  it('OTP: doğru kod, yanlış kod sayacı, kilit, süre dolumu', () => {
    expect(checkOtp(rec, '123456', h, T + 1000)).toMatchObject({ ok: true, record: { state: 'verified' } });
    expect(checkOtp(rec, '000000', h, T)).toMatchObject({ ok: false, code: 'otp_invalid', record: { attempts: 1 } });
    expect(checkOtp({ ...rec, attempts: 4 }, '000000', h, T)).toMatchObject({ ok: false, code: 'otp_locked', record: { state: 'failed' } });
    expect(checkOtp(rec, '123456', h, T + SECURITY_LIMITS.otpTtlMs)).toMatchObject({ ok: false, code: 'otp_expired' });
  });

  it('e-posta doğrulama ve maskeleme; kara liste anahtarı', () => {
    expect(normalizeEmail('  Deniz.Kaya@Gmail.com ')).toBe('deniz.kaya@gmail.com');
    expect(normalizeEmail('deniz@')).toBeNull();
    expect(maskEmail('deniz.kaya@gmail.com')).toBe('d••••••••a@gmail.com');
    expect(revokedDeviceKey('u1', null)).toBe('u1_legacy');
  });

  it('taşıma bildirimi: sayı + özet eşleşmesi', () => {
    const manifest = {
      generated_at: T,
      items: {
        friendships: migrationDigest(['ayse', 'mehmet']),
        permission_grants: migrationDigest(['ayse>me:location_view']),
        favorites: orderedDigest(['ayse', 'mehmet']),
        zones: migrationDigest(['z1']),
        consents: migrationDigest(['2026-11-27@1']),
      },
    };
    const rows = compareMigration(manifest, {
      friendships: migrationDigest(['mehmet', 'ayse']),
      permission_grants: migrationDigest([]),
      favorites: orderedDigest(['mehmet', 'ayse']),
      zones: migrationDigest(['z1']),
    });
    expect(rows.map((r) => r.ok)).toEqual([true, false, false, true, false]);
  });

  it('kayıt: callable adları ve onay muafiyetleri', () => {
    expect(CALLABLES.deviceRevoke).toBe('device_revoke');
    expect(CONSENT_EXEMPT_CALLABLES).toContain(CALLABLES.deviceRevoke);
    expect(CONSENT_EXEMPT_CALLABLES).not.toContain(CALLABLES.recoveryChannelStart);
  });
});

describe('Faz 10 · ilk açılış v3 ve İzin Merkezi', () => {
  const perms: PermissionSnapshot = {
    platform: 'ios',
    osVersion: 18,
    foreground: 'granted',
    foregroundCanAskAgain: true,
    background: 'granted',
    backgroundCanAskAgain: true,
    precise: true,
    notifications: 'granted',
    notificationsCanAskAgain: true,
    timeSensitive: true,
    criticalAlerts: null,
    camera: 'granted',
    cameraCanAskAgain: true,
    photos: 'granted',
    photosCanAskAgain: true,
    motion: 'granted',
    batteryOptimization: null,
    contacts: 'granted',
    contactsCanAskAgain: true,
    smsAvailable: true,
    calendar: 'undetermined',
    calendarCanAskAgain: true,
  };

  it('v2 bitirene yalnızca takvim; v1 bitirene rehber + SMS + takvim', () => {
    expect(ONBOARDING_STEPS).toContain('calendar');
    const fromV2 = onboardingDoneForUpgrade(2, ['done']);
    expect(fromV2).not.toContain('calendar');
    expect(fromV2).toContain('contacts');
    const fromV1 = onboardingDoneForUpgrade(1, ['done']);
    expect(fromV1).not.toContain('contacts');
    expect(fromV1).not.toContain('calendar');
    expect(nextOnboardingStep({ perms, batteryShareDecided: true, smsFallbackDecided: true, done: fromV2 })).toEqual({ step: 'calendar', action: 'system_prompt' });
  });

  it('takvim satırı: yalnızca ekleme izni "tamam" sayılır', () => {
    const row = permissionCenterRows({ ...perms, calendar: 'write_only' }).find((r) => r.id === 'calendar');
    expect(row).toMatchObject({ status: 'Yalnızca ekleme', tone: 'ok', action: null });
    const off = permissionCenterRows({ ...perms, calendar: 'denied', calendarCanAskAgain: false }).find((r) => r.id === 'calendar');
    expect(off).toMatchObject({ status: 'Kapalı', action: 'settings' });
  });
});
