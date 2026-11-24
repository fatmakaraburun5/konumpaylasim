/**
 * Faz 3 sözleşme eklemeleri: backend/mobil/web'in aynı adları, şemaları ve metinleri kullandığını sabitler.
 */
import { describe, expect, it } from 'vitest';
import {
  BATTERY_LOW_NOTIFY_STATUSES,
  BatteryLowNotifyRequestSchema,
  BatteryLowNotifyResponseSchema,
  CALLABLES,
  DELIVERED_FIELDS,
  DELIVERED_OPTIONAL_F3_FIELDS,
  LINK_LIVE_FIELDS,
  LINK_TRAIL_ENABLED,
  PATHS,
  PUSH_TYPES_F3,
  TRAIL_FIELDS,
  liveTrailPath,
  lowBatteryPushText,
  PACKET_LIMITS,
  safeRecordedAt,
  turkishGenitive,
  uuidV4,
  type LinkAclActive,
  type PermissionKind,
  type PushData,
  type ShareAcl,
} from '../src';

describe('Faz 3 callable: battery_low_notify', () => {
  it('ad core CALLABLES içinde, eski adlar değişmedi, çakışma yok', () => {
    expect(CALLABLES.batteryLowNotify).toBe('battery_low_notify');
    expect(CALLABLES.shareStart).toBe('share_start');
    expect(CALLABLES.linkShareCreate).toBe('link_share_create');
    const names = Object.values(CALLABLES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('istek şeması: op_id uuid, session_id güvenli, pil tam sayı 0–100', () => {
    const ok = { op_id: uuidV4(), session_id: 'a1b2-c3', battery_pct: 14 };
    expect(BatteryLowNotifyRequestSchema.parse(ok)).toEqual(ok);
    expect(BatteryLowNotifyRequestSchema.parse({ ...ok, is_charging: true }).is_charging).toBe(true);
    for (const bad of [
      { ...ok, op_id: 'x' },
      { ...ok, session_id: 'a/b' },
      { ...ok, session_id: '' },
      { ...ok, battery_pct: 14.5 },
      { ...ok, battery_pct: 101 },
      { ...ok, battery_pct: -1 },
      { ...ok, is_charging: 'yes' },
    ]) {
      expect(BatteryLowNotifyRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('yanıt şeması dört durumu kabul eder', () => {
    expect(BATTERY_LOW_NOTIFY_STATUSES).toEqual(['notified', 'rearmed', 'suppressed', 'noop']);
    for (const status of BATTERY_LOW_NOTIFY_STATUSES) {
      expect(BatteryLowNotifyResponseSchema.safeParse({ status, armed: false, receivers: 2, server_now: 1 }).success).toBe(true);
    }
    expect(BatteryLowNotifyResponseSchema.safeParse({ status: 'sent', armed: false, receivers: 0, server_now: 1 }).success).toBe(false);
  });
});

describe('Faz 3 yollar ve alanlar', () => {
  it('live_trail ve battery_alerts yolları', () => {
    expect(PATHS.liveTrail('r1')).toBe('live_trail/r1');
    expect(liveTrailPath('r1', 's1', '1764000000000-001')).toBe(`${PATHS.liveTrail('r1')}/s1/1764000000000-001`);
    expect(PATHS.batteryAlert('u1', 'sess-1')).toBe('battery_alerts/u1_sess-1');
  });

  it('paket alanları yalnızca eklendi; bağlantıda recorded_at yok, iz kapalı', () => {
    expect([...DELIVERED_OPTIONAL_F3_FIELDS].sort()).toEqual(['hb', 'q', 'recorded_at']);
    for (const f of DELIVERED_OPTIONAL_F3_FIELDS) expect(DELIVERED_FIELDS).toContain(f);
    expect(LINK_LIVE_FIELDS).toContain('hb');
    expect(LINK_LIVE_FIELDS).toContain('q');
    expect(LINK_LIVE_FIELDS).not.toContain('recorded_at' as never);
    expect(LINK_TRAIL_ENABLED).toBe(false);
    expect(TRAIL_FIELDS).toContain('q');
    expect(TRAIL_FIELDS).not.toContain('sender_id' as never);
  });

  it('ACL tiplerinde started_at isteğe bağlı (Faz 3 öncesi aynalar geçerli)', () => {
    const old: ShareAcl = { sender_id: 'a', receiver_id: 'b', status: 'active', expires_at: null, version: 1 };
    const f3: ShareAcl = { ...old, started_at: 1 };
    const link: LinkAclActive = { status: 'active', sender_id: 'a', link_id: 'l', share_mode: 'indefinite', version: 1, started_at: 1 };
    expect([old.started_at, f3.started_at, link.started_at]).toEqual([undefined, 1, 1]);
  });

  it("PermissionKind 'motion' içerir", () => {
    const k: PermissionKind = 'motion';
    expect(k).toBe('motion');
  });
});

describe('Faz 3 FCM veri türleri', () => {
  it('PushData yeni türleri koordinat taşımaz', () => {
    const samples: PushData[] = [
      { type: 'battery_low', share_id: 's1', battery_pct: '14' },
      { type: 'resume_tracking', session_ids: 'a,b', level: '1' },
      { type: 'tracking_stalled', session_ids: 'a' },
    ];
    expect(samples.map((s) => s.type)).toEqual([...PUSH_TYPES_F3]);
    for (const s of samples) {
      for (const v of Object.values(s)) expect(typeof v).toBe('string');
      expect(Object.keys(s)).not.toContain('lat');
      expect(Object.keys(s)).not.toContain('lng');
    }
  });
});

describe('düşük pil bildirim metni (backend, mobil ve web ortak)', () => {
  it('Türkçe tamlayan eki', () => {
    expect(turkishGenitive('Ayşe')).toBe("Ayşe'nin");
    expect(turkishGenitive('Can')).toBe("Can'ın");
    expect(turkishGenitive('Bora')).toBe("Bora'nın");
    expect(turkishGenitive('Ümit')).toBe("Ümit'in");
    expect(turkishGenitive('Ayşe Y.')).toBe("Ayşe Y.'nin");
    expect(turkishGenitive('Ayşe Yılmaz')).toBe("Ayşe Yılmaz'ın");
    expect(turkishGenitive('Oğuz')).toBe("Oğuz'un");
    expect(turkishGenitive('Gül')).toBe("Gül'ün");
    expect(turkishGenitive('JR')).toBeNull();
    expect(turkishGenitive('  ')).toBeNull();
  });

  it('ürün metni; ad yoksa genel başlık; yüzde yuvarlanır ve sınırlanır', () => {
    expect(lowBatteryPushText('Ayşe', 14)).toEqual({ title: "Ayşe'nin pili azaldı", body: 'Pil %14. Konum daha seyrek güncellenecek.' });
    expect(lowBatteryPushText('', 9.6).title).toBe('Arkadaşının pili azaldı');
    expect(lowBatteryPushText('JR', 9.6).body).toBe('Pil %10. Konum daha seyrek güncellenecek.');
    expect(lowBatteryPushText('Can', 140).body).toContain('%100');
  });
});

describe('recorded_at güvenli değer (RTDB kuralı: 2017 ≤ recorded_at ≤ now + 1 sa)', () => {
  const T = Date.UTC(2026, 10, 24, 9, 0, 0);
  it('normal sapmada cihaz saati korunur; aşırı ileri / bozuk saatte sunucu ölçüm anı', () => {
    expect(safeRecordedAt(T - 3_000, T)).toBe(T - 3_000);
    expect(safeRecordedAt(T + 50 * 60_000, T)).toBe(T + 50 * 60_000);
    expect(safeRecordedAt(T + 56 * 60_000, T)).toBe(T);
    expect(safeRecordedAt(T + 3 * 3_600_000, T)).toBe(T);
    expect(safeRecordedAt(0, T)).toBe(T);
    expect(safeRecordedAt(Number.NaN, T)).toBe(T);
    expect(PACKET_LIMITS.maxRecordedAheadMs).toBe(3_600_000);
    expect(PACKET_LIMITS.minRecordedAtMs).toBe(1_500_000_000_000);
  });
});
