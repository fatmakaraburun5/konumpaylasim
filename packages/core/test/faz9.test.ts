import { describe, expect, it } from 'vitest';
import {
  APPROACH_LIMITS,
  ApproachReportRequestSchema,
  CALLABLES,
  CONSENT_EXEMPT_CALLABLES,
  DEFAULT_SMS_FALLBACK,
  PROOF_LIMITS,
  ProofCreateRequestSchema,
  SAFE_RETURN_LIMITS,
  addSmsNumber,
  approachReduce,
  approachStatusText,
  base64ToBytes,
  bytesToBase64,
  canViewProof,
  createSafeReturnDoc,
  destinationKey,
  formatProofLeft,
  isFreshCapture,
  jpegInfo,
  makeDestination,
  offlineSosDecision,
  onboardingDoneForUpgrade,
  parseSmsFallback,
  reduceSafeReturn,
  safeReturnLocalSchedule,
  safeReturnPhase,
  sosSmsBody,
  stripJpegMetadata,
  validateProofJpeg,
  type ApproachState,
} from '../src';

const T0 = Date.UTC(2026, 10, 26, 19, 0, 0);
const MIN = 60_000;

/** SOI + APP0 + APP1(EXIF/GPS) + COM + SOF0(w×h) + SOS + veri + EOI. */
function fakeJpeg(width = 640, height = 480): Uint8Array {
  const seg = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
  const exif = Array.from('Exif\0\0GPS-41.0,29.0').map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, exif),
    ...seg(0xfe, [0x68, 0x69]),
    ...seg(0xc0, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12, 0x34, 0x56,
    0xff, 0xd9,
  ]);
}

describe('Faz 9 · anlık fotoğraf ispatı', () => {
  it('EXIF/GPS ve yorum bölümleri atılır, boyut okunur, base64 gidiş-dönüş bozulmaz', () => {
    const raw = fakeJpeg();
    expect(jpegInfo(raw)).toEqual({ width: 640, height: 480 });
    const clean = stripJpegMetadata(raw)!;
    expect(clean.length).toBeLessThan(raw.length);
    expect(Array.from(clean).some((b, i) => b === 0xff && clean[i + 1] === 0xe1)).toBe(false);
    expect(Array.from(clean).some((b, i) => b === 0xff && clean[i + 1] === 0xe0)).toBe(true);
    expect(base64ToBytes(bytesToBase64(raw))).toEqual(raw);
    const v = validateProofJpeg(bytesToBase64(raw), { width: 640, height: 480 });
    expect(v.ok).toBe(true);
    expect(validateProofJpeg(bytesToBase64(raw), { width: 641, height: 480 })).toEqual({ ok: false, reason: 'bad_dimensions' });
    expect(validateProofJpeg(bytesToBase64(new Uint8Array([1, 2, 3, 4])), { width: 1, height: 1 })).toEqual({ ok: false, reason: 'not_jpeg' });
    expect(validateProofJpeg(bytesToBase64(fakeJpeg(2000, 1000)), { width: 2000, height: 1000 })).toEqual({ ok: false, reason: 'bad_dimensions' });
  });

  it('yalnızca kamera kaynağı ve taze çekim kabul edilir', () => {
    const base = {
      op_id: '0d6c6f0e-3a8b-4e51-9a0b-2f2a1d0c9e11',
      source: 'camera',
      jpeg_b64: bytesToBase64(fakeJpeg()),
      width: 640,
      height: 480,
      captured_at: T0,
      caption: 'Masamız burası',
      position: { lat: 41.0, lng: 29.0, accuracy: 12, timestamp: T0 },
    };
    expect(ProofCreateRequestSchema.safeParse(base).success).toBe(true);
    expect(ProofCreateRequestSchema.safeParse({ ...base, source: 'gallery' }).success).toBe(false);
    expect(isFreshCapture(T0, T0 + MIN)).toBe(true);
    expect(isFreshCapture(T0, T0 + PROOF_LIMITS.captureMaxAgeMs + 1)).toBe(false);
    expect(isFreshCapture(T0 + 5 * MIN, T0)).toBe(false);
  });

  it('erişim: sahibi + etkin paylaşım alan görür; süresi dolunca kimse görmez; erişimsize varlığı sızmaz', () => {
    const proof = { owner_id: 'A', state: 'active' as const, expires_at: T0 + PROOF_LIMITS.ttlMs };
    expect(canViewProof({ proof, viewerId: 'A', now: T0, hasActiveShareFromOwner: false, ownerInvisible: false })).toBe('ok');
    expect(canViewProof({ proof, viewerId: 'B', now: T0, hasActiveShareFromOwner: true, ownerInvisible: false })).toBe('ok');
    expect(canViewProof({ proof, viewerId: 'C', now: T0, hasActiveShareFromOwner: false, ownerInvisible: false })).toBe('not_found');
    expect(canViewProof({ proof, viewerId: 'B', now: T0, hasActiveShareFromOwner: true, ownerInvisible: true })).toBe('not_found');
    expect(canViewProof({ proof, viewerId: 'B', now: T0 + PROOF_LIMITS.ttlMs, hasActiveShareFromOwner: true, ownerInvisible: false })).toBe('expired');
    expect(formatProofLeft(T0 + 52 * MIN, T0)).toBe('52 dk kaldı');
    expect(formatProofLeft(T0 + 45_000, T0)).toBe('45 sn kaldı');
    expect(formatProofLeft(T0, T0)).toBe('Süresi doldu');
  });
});

describe('Faz 9 · 200 m yaklaşma', () => {
  const center = { lat: 41.0, lng: 29.0 };
  const dest = makeDestination({ kind: 'zone', ref_id: 'home', name: 'Ev', center, radius_m: 80, now: T0 });
  // ~111 m / 0.001° enlem
  const at = (metersNorth: number, t: number, accuracy = 10) => ({ lat: 41.0 + metersNorth / 111_195, lng: 29.0, accuracy, speed_mps: 1.4, activity: 'walking' as const, at: t });

  it('uzaktan gelip 200 m halkasına girince tek sefer tetiklenir; tekrar girişte yeniden tetiklenmez', () => {
    let st: ApproachState | null = null;
    const fires: number[] = [];
    const run = (m: number, t: number) => {
      const r = approachReduce(st, at(m, t), dest);
      st = r.state;
      if (r.fire) fires.push(t);
      return r;
    };
    expect(run(600, T0).dest_state).toBe('en_route');
    run(190, T0 + 10_000); // halka içinde 1. örnek (açıkça içeride değil)
    const r = run(185, T0 + 16_000); // 2. örnek, 6 sn sonra → tetik
    expect(fires).toHaveLength(1);
    expect(r.fire?.eta_min).toBe(2);
    expect(r.dest_state).toBe('near');
    run(400, T0 + 60_000); // dışarı çıktı
    run(150, T0 + 90_000); // tekrar girdi
    expect(fires).toHaveLength(1);
    const arr = run(10, T0 + 200_000);
    expect(arr.arrived).toBe(true);
    expect(arr.dest_state).toBe('arrived');
    expect(approachStatusText(1)).toBe('Neredeyse vardım (1 dk)');
  });

  it('zaten yakındayken başlatılan paylaşım tetiklemez; kötü doğruluklu örnek yok sayılır', () => {
    let r = approachReduce(null, at(120, T0), dest);
    r = approachReduce(r.state, at(110, T0 + 30_000), dest);
    expect(r.fire).toBeNull();
    const far = approachReduce(null, at(600, T0), dest);
    const noisy = approachReduce(far.state, at(50, T0 + 10_000, APPROACH_LIMITS.maxAccuracyM + 1), dest);
    expect(noisy.fire).toBeNull();
    expect(noisy.state.phase).toBe('armed');
  });

  it('hedef değişince yeni tek hak; rapor şeması mesafe sınırını uygular', () => {
    const other = destinationKey('point', null, { lat: 41.01, lng: 29.01 });
    expect(other).not.toBe(dest.key);
    const ok = { op_id: '0d6c6f0e-3a8b-4e51-9a0b-2f2a1d0c9e11', session_ids: ['s1'], dest_key: dest.key, dest_name: 'Ev', dest_kind: 'zone', distance_m: 180, eta_min: 1, at: T0 };
    expect(ApproachReportRequestSchema.safeParse(ok).success).toBe(true);
    expect(ApproachReportRequestSchema.safeParse({ ...ok, distance_m: 900 }).success).toBe(false);
  });
});

describe('Faz 9 · Güvenli Dönüş', () => {
  const fix = { lat: 41, lng: 29, accuracy: 10, timestamp: T0, battery_pct: 40 };
  const make = () =>
    createSafeReturnDoc({ safe_return_id: 'sr1', owner_id: 'A', owner_name: 'Ayşe', contact_ids: ['B', 'B', 'C'], destination: { kind: 'zone', name: 'Ev', zone_id: 'z1' }, duration_min: 30, fix: fix as never, time_zone: 'Europe/Istanbul', now: T0 });

  it('süre dolunca önce son uyarı, ardından alarm; alarmdan sonra check-in kabul edilmez', () => {
    let d = make();
    expect(d.contact_ids).toEqual(['B', 'C']);
    expect(safeReturnPhase(d, T0 + 26 * MIN)).toBe('ending_soon');
    expect(reduceSafeReturn(d, { type: 'tick' }, T0 + 29 * MIN).changed).toBe(false);
    const due = reduceSafeReturn(d, { type: 'tick' }, T0 + 30 * MIN);
    expect(due.effects).toEqual([{ kind: 'due' }]);
    d = due.doc;
    expect(safeReturnPhase(d, T0 + 31 * MIN)).toBe('final_warning');
    expect(reduceSafeReturn(d, { type: 'tick' }, T0 + 31 * MIN).changed).toBe(false);
    const alarm = reduceSafeReturn(d, { type: 'tick' }, d.grace_until);
    expect(alarm.doc.status).toBe('alarm');
    expect(alarm.effects).toEqual([{ kind: 'alarm' }]);
    expect(reduceSafeReturn(alarm.doc, { type: 'check_in', reason: 'safe' }, d.grace_until + 1).error).toBe('safe_return_not_active');
    expect(reduceSafeReturn(alarm.doc, { type: 'tick' }, d.grace_until + MIN).changed).toBe(false);
  });

  it('son uyarıda "Güvendeyim" alarmı önler; uzatma sınırı 3 saat', () => {
    const d = reduceSafeReturn(make(), { type: 'tick' }, T0 + 30 * MIN).doc;
    const ok = reduceSafeReturn(d, { type: 'check_in', reason: 'safe' }, T0 + 31 * MIN);
    expect(ok.doc.status).toBe('checked_in');
    expect(ok.effects).toEqual([{ kind: 'ended', reason: 'checked_in' }]);
    let e = make();
    let n = 0;
    for (;;) {
      const r = reduceSafeReturn(e, { type: 'extend' }, T0);
      if (r.error) {
        expect(r.error).toBe('safe_return_extend_limit');
        break;
      }
      e = r.doc;
      n++;
    }
    expect(e.due_at - e.started_at).toBeLessThanOrEqual(SAFE_RETURN_LIMITS.maxTotalMs);
    expect(n).toBe(10);
    expect(safeReturnLocalSchedule(make(), T0).map((x) => x.kind)).toEqual(['reminder', 'due', 'last_call']);
  });
});

describe('Faz 9 · çevrimdışı SOS SMS ve izinler', () => {
  it('SMS gövdesi: koordinat, zaman, pil, harita bağlantısı ayrı satırda', () => {
    const body = sosSmsBody({ senderName: 'Ayşe', fix: { lat: 41.00824, lng: 28.978359, accuracy: 12, timestamp: T0 - 3 * MIN }, battery_pct: 23, now: T0, offsetAt: () => 180 });
    const lines = body.split('\n');
    expect(lines[0]).toBe('ACİL: Ayşe tehlikede, internet yok.');
    expect(lines[1]).toContain('41.008240,28.978359 (±12 m)');
    expect(lines[1]).toContain('26.11.2026 21:57');
    expect(lines[1]).toContain('Pil %23');
    expect(lines[2]).toBe('https://maps.google.com/?q=41.008240,28.978359');
    expect(sosSmsBody({ senderName: '', fix: null, battery_pct: null, now: T0 })).toContain('Konum alınamadı');
  });

  it('SMS yalnızca açık onay + numara varken ve çevrimdışıyken önerilir; numara E.164 ve tekil', () => {
    const add = addSmsNumber({ ...DEFAULT_SMS_FALLBACK, enabled: true, numbers: [] }, { label: 'Annem', phone: '0532 123 45 67', source: 'contacts' });
    expect(add.ok && add.number.e164).toBe('+905321234567');
    const settings = add.ok ? add.settings : DEFAULT_SMS_FALLBACK;
    expect(addSmsNumber(settings, { label: 'x', phone: '+90 532 123 4567', source: 'manual' })).toEqual({ ok: false, reason: 'duplicate' });
    expect(parseSmsFallback({ enabled: true, numbers: [settings.numbers[0], settings.numbers[0], { e164: 'bad' }] }).numbers).toHaveLength(1);
    const d = (o: Partial<Parameters<typeof offlineSosDecision>[0]>) => offlineSosDecision({ online: false, outcome: 'pending', waitedMs: 0, settings, smsAvailable: true, ...o });
    expect(d({})).toBe('offer_sms');
    expect(d({ online: true })).toBe('online');
    expect(d({ online: null, outcome: 'failed_network' })).toBe('offer_sms');
    expect(d({ settings: { enabled: false, numbers: settings.numbers } })).toBe('sms_not_configured');
    expect(d({ smsAvailable: false })).toBe('sms_unavailable');
  });

  it('güncellenen uygulamada yalnızca yeni adımlar (rehber, SMS) sorulur; muafiyetler ve çağrılar kayıtlı', () => {
    expect(onboardingDoneForUpgrade(1, ['welcome', 'location', 'done'])).not.toContain('contacts');
    expect(onboardingDoneForUpgrade(1, ['welcome', 'location', 'done'])).toContain('camera_photos');
    expect(onboardingDoneForUpgrade(1, ['welcome'])).toEqual(['welcome']);
    expect(CALLABLES.safeReturnCheckIn).toBe('safe_return_check_in');
    for (const c of [CALLABLES.proofDelete, CALLABLES.safeReturnCheckIn, CALLABLES.safeReturnCancel]) expect(CONSENT_EXEMPT_CALLABLES).toContain(c);
  });
});
