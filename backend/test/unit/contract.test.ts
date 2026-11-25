/**
 * Emülatör gerektirmeyen sözleşme testleri: kurallar ve fonksiyonlar core ile aynı dili konuşuyor mu?
 */
import { readFileSync } from 'node:fs';
import {
  ACTIVITY_STATES,
  CALLABLES,
  DELIVERED_FIELDS,
  LINK_LIMITS,
  LINK_LIVE_FIELDS,
  LINK_PATH_PREFIX,
  LIVE_PACKET_VERSION,
  LINK_TRAIL_ENABLED,
  OUTBOX_LIMITS,
  PACKET_LIMITS,
  SHARE_MODES,
  TRAIL_FIELDS,
  buildLinkLiveWrite,
  isLinkToken,
} from '@konum/core';
import { describe, expect, it } from 'vitest';
import { aclValue } from '../../functions/src/acl';
import { EXPIRY_TASK_FUNCTION } from '../../functions/src/config';
import { newLinkToken } from '../../functions/src/handlers/links';
import { linkAclValue } from '../../functions/src/linkAcl';
import { BatteryLowNotifyRequestSchema, PUSH_TYPES_F3, lowBatteryPushText } from '@konum/core';
import { BatteryLowNotifySchema } from '../../functions/src/schemas';
import { buildBatteryLowPush, buildLocationRequestPush, buildResumeTrackingPush, buildTrackingStalledPush, turkishGenitive } from '../../functions/src/push';
import { linkExpiryTaskFor } from '../../functions/src/tasks';
import {
  DELIVERED_OPTIONAL_F4_FIELDS,
  NOTIFICATION_CHANNELS_F4,
  PACKET_NOTE_MAX_CHARS,
  PUSH_TYPES_F4,
  pingPushText,
  sosPushText,
} from '@konum/core';
import { SOS_CRITICAL_ALERTS } from '../../functions/src/config';
import { buildPingPush, buildSosAckPush, buildSosPush, buildSosResolvedPush } from '../../functions/src/push';

const rules = JSON.parse(readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8'));
const liveNode: Record<string, unknown> = rules.rules.live_locations.$receiver_id.$share_id;

const regexAlternatives = (rule: string): string[] => {
  const m = /\^\(([^)]+)\)\$/.exec(rule);
  if (!m?.[1]) throw new Error(`regex bulunamadı: ${rule}`);
  return m[1].split('|');
};

describe('database.rules.json ↔ core sözleşmesi', () => {
  it('izin verilen canlı alanlar kümesi core DELIVERED_FIELDS ile birebir aynı', () => {
    const allowed = Object.keys(liveNode).filter((k) => !k.startsWith('.') && !k.startsWith('$'));
    expect(new Set(allowed)).toEqual(new Set(DELIVERED_FIELDS));
    expect(allowed).toHaveLength(DELIVERED_FIELDS.length);
    // Diğer her alt düğüm reddedilir.
    expect(liveNode.$other).toEqual({ '.validate': false });
  });

  it('zorunlu alanlar DELIVERED_FIELDS alt kümesi; receiver_ids yok', () => {
    // Yapı kontrolü `.write` içindedir: alt alan yazmalarında da birleşik (merged) yeni veriye bakılır.
    const write = String(liveNode['.write']);
    const required = /hasChildren\(\[([^\]]+)\]\)/.exec(write)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, '')) ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const f of required) expect(DELIVERED_FIELDS).toContain(f);
    expect(Object.keys(liveNode)).not.toContain('receiver_ids');
  });

  it('share_mode ve activity_state regex değerleri core listeleriyle aynı', () => {
    const sm = (liveNode.share_mode as Record<string, string>)['.validate'] as string;
    const as = (liveNode.activity_state as Record<string, string>)['.validate'] as string;
    expect(new Set(regexAlternatives(sm))).toEqual(new Set(SHARE_MODES));
    expect(new Set(regexAlternatives(as))).toEqual(new Set(ACTIVITY_STATES));
  });

  it('v, doğruluk ve zaman penceresi core sabitleriyle aynı', () => {
    const v = (liveNode.v as Record<string, string>)['.validate'];
    expect(v).toContain(`=== ${LIVE_PACKET_VERSION}`);
    const acc = (liveNode.accuracy as Record<string, string>)['.validate'];
    expect(acc).toContain(`<= ${PACKET_LIMITS.maxAccuracyM}`);
    const spd = (liveNode.speed_mps as Record<string, string>)['.validate'];
    expect(spd).toContain(`<= ${PACKET_LIMITS.maxSpeedMps}`);
    const write = String(liveNode['.write']);
    expect(write).toContain(`now - ${PACKET_LIMITS.maxSampleAgeMs}`);
    expect(write).toContain(`now + ${PACKET_LIMITS.maxFutureSkewMs}`);
  });

  it('Faz 3: q penceresi ve hb sınırları core PACKET_LIMITS ile aynı', () => {
    const write = String(liveNode['.write']);
    expect(write).toContain(`newData.child('q').val() === 1 && newData.child('timestamp').val() >= now - ${PACKET_LIMITS.maxQueuedSampleAgeMs}`);
    // Taze pencere yalnızca q OLMAYAN paket için: kuyruk noktası 2 dk içinde de olsa "düğümden yeni" + started_at kuralına tabi.
    expect(write).toContain(`(newData.child('q').val() !== 1 && newData.child('timestamp').val() >= now - ${PACKET_LIMITS.maxSampleAgeMs})`);
    const hb = (liveNode.hb as Record<string, string>)['.validate'];
    expect(hb).toContain(`>= ${PACKET_LIMITS.minHeartbeatMs}`);
    expect(hb).toContain(`<= ${PACKET_LIMITS.maxHeartbeatMs}`);
    expect((liveNode.q as Record<string, string>)['.validate']).toContain('=== 1');
  });

  it('share_acl istemciye tamamen kapalı (yalnızca sunucu dizinleri)', () => {
    expect(rules.rules.share_acl).toEqual({ '.read': false, '.write': false, '.indexOn': ['status', 'ended_at'] });
  });

  it('paket ACL ile bağlıdır: share_mode ve expires_at birleşik veride ACL ile eşitlenir', () => {
    const write = String(liveNode['.write']);
    expect(write).toContain("newData.child('share_mode').val() === root.child('share_acl').child($share_id).child('share_mode').val()");
    expect(write).toContain("newData.child('expires_at').val() === root.child('share_acl').child($share_id).child('expires_at').val()");
    expect(write).toContain("!newData.child('expires_at').exists()");
  });
});

describe('functions ↔ core', () => {
  it('dışa aktarılan fonksiyon adları core CALLABLES ile aynı', () => {
    const src = readFileSync(new URL('../../functions/src/index.ts', import.meta.url), 'utf8');
    // Faz 6: `tokenCallable` = oturumsuz callable (widget_quick_share).
    const exported = [...src.matchAll(/export const (\w+) = (?:callable|tokenCallable)\('(\w+)'/g)].map((m) => {
      expect(m[1]).toBe(m[2]);
      return m[1];
    });
    // Faz 3: battery_low_notify artık core CALLABLES içinde (backend'e özel ad kalmadı).
    expect(new Set(exported)).toEqual(new Set(Object.values(CALLABLES)));
    expect(exported).toContain(CALLABLES.batteryLowNotify);
    // Yalnızca widget_quick_share oturumsuzdur.
    expect([...src.matchAll(/export const (\w+) = tokenCallable\(/g)].map((m) => m[1])).toEqual([CALLABLES.widgetQuickShare]);
  });

  it('süre dolumu görevi config EXPIRY_TASK_FUNCTION adıyla dışa aktarılır', () => {
    const src = readFileSync(new URL('../../functions/src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(new RegExp(`export const ${EXPIRY_TASK_FUNCTION} = onTaskDispatched`));
    // Kuyruk kimliği kuralı (Cloud Tasks): yalnızca harf, rakam, tire; en çok 100 karakter.
    expect(EXPIRY_TASK_FUNCTION).toMatch(/^[A-Za-z0-9-]{1,100}$/);
  });

  it('ACL değeri: aktif → core ShareAcl alanları, süresizde expires_at yok; bitmiş → mezar taşı', () => {
    const base = {
      share_id: 'a_b',
      sender_id: 'a',
      receiver_id: 'b',
      version: 3,
      share_mode: 'timed',
      ended_at: null,
      end_reason: null,
    } as const;
    expect(aclValue({ ...base, status: 'active', expires_at: 123 })).toEqual({
      sender_id: 'a',
      receiver_id: 'b',
      status: 'active',
      share_mode: 'timed',
      expires_at: 123,
      version: 3,
    });
    expect(aclValue({ ...base, status: 'active', expires_at: null })).not.toHaveProperty('expires_at');
    // Mezar taşı uid çifti taşımaz; ended_at belgeden (yoksa şimdi) gelir.
    expect(aclValue({ ...base, status: 'ended', expires_at: 123, ended_at: 456, end_reason: 'stopped_by_sender' })).toEqual({
      status: 'ended',
      version: 3,
      ended_at: 456,
    });
    expect(aclValue({ ...base, status: 'ended', expires_at: 123 }, 789)).toEqual({ status: 'ended', version: 3, ended_at: 789 });
  });

  it('konum isteği bildirimi koordinat taşımaz; data = {type, request_id}', () => {
    const msg = buildLocationRequestPush('Ayşe', 'uA_uB');
    expect(msg.data).toEqual({ type: 'location_request', request_id: 'uA_uB' });
    const json = JSON.stringify(msg);
    for (const banned of ['lat', 'lng', 'accuracy', 'phone', 'receiver']) expect(json).not.toContain(banned);
  });
});

// ---------------------------------------------------------------------------
// Faz 2: bağlantı (QR) kuralları, TTL alanları, barındırma (Universal Links / App Links)
// ---------------------------------------------------------------------------

describe('Faz 2: database.rules.json ↔ core link sözleşmesi', () => {
  const linkNode: Record<string, unknown> = rules.rules.link_live.$token_hash;

  it('link_live izinli alanları core LINK_LIVE_FIELDS ile birebir aynı; diğer her alan reddedilir', () => {
    const allowed = Object.keys(linkNode).filter((k) => !k.startsWith('.') && !k.startsWith('$'));
    expect(new Set(allowed)).toEqual(new Set(LINK_LIVE_FIELDS));
    expect(allowed).toHaveLength(LINK_LIVE_FIELDS.length);
    expect(linkNode.$other).toEqual({ '.validate': false });
    for (const banned of ['sender_id', 'share_id', 'link_id', 'session_id', 'receiver_ids', 'is_charging', 'activity_state', 'mocked']) {
      expect(Object.keys(linkNode)).not.toContain(banned);
    }
  });

  it('zorunlu alanlar LINK_LIVE_FIELDS alt kümesi; core paketi (buildLinkLiveWrite) zorunluları taşır', () => {
    const write = String(linkNode['.write']);
    const required = /hasChildren\(\[([^\]]+)\]\)/.exec(write)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, '')) ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const f of required) expect(LINK_LIVE_FIELDS).toContain(f);
    const w = buildLinkLiveWrite(
      { lat: 41, lng: 29, accuracy: 10, speed_mps: null, heading: null, timestamp: 1, mocked: false },
      { batteryLevel: null, isCharging: null },
      { share_mode: 'indefinite', expires_at: null, sender_name: '' },
    );
    for (const f of required) expect(w).toHaveProperty(f);
  });

  it('okuma yalnızca aktif ve süresi dolmamış link_acl ile; yazma gönderen + paket ACL ile bağlı', () => {
    const read = String(linkNode['.read']);
    expect(read).toContain("root.child('link_acl').child($token_hash).child('status').val() === 'active'");
    expect(read).toContain("root.child('link_acl').child($token_hash).child('expires_at').val() > now");
    expect(read).not.toContain('auth');
    const write = String(linkNode['.write']);
    expect(write).toContain("root.child('link_acl').child($token_hash).child('sender_id').val() === auth.uid");
    expect(write).toContain("newData.child('share_mode').val() === root.child('link_acl').child($token_hash).child('share_mode').val()");
    expect(write).toContain("newData.child('expires_at').val() === root.child('link_acl').child($token_hash).child('expires_at').val()");
    expect(write).toContain(`now - ${PACKET_LIMITS.maxSampleAgeMs}`);
    expect(write).toContain(`now + ${PACKET_LIMITS.maxFutureSkewMs}`);
  });

  it('share_mode, v ve sender_name sınırları core ile aynı', () => {
    const sm = (linkNode.share_mode as Record<string, string>)['.validate'] as string;
    expect(new Set(regexAlternatives(sm))).toEqual(new Set(SHARE_MODES));
    expect((linkNode.v as Record<string, string>)['.validate']).toContain(`=== ${LIVE_PACKET_VERSION}`);
    // core linkSenderName 40 kod noktası keser; UTF-16'da en çok 80 birim.
    expect((linkNode.sender_name as Record<string, string>)['.validate']).toContain(`<= ${LINK_LIMITS.senderNameMaxLength * 2}`);
  });

  it('link_acl istemciye tamamen kapalı; link_live üst düğümü listelenemez', () => {
    expect(rules.rules.link_acl).toEqual({ '.read': false, '.write': false, '.indexOn': ['status', 'ended_at'] });
    expect(Object.keys(rules.rules.link_live)).toEqual(['$token_hash']);
    expect(rules.rules['.read']).toBe(false);
  });

  it('bağlantı ACL değeri: aktif → gönderen + mod + bitiş + link_id; bitmiş → mezar taşı (uid yok)', () => {
    const base = {
      link_id: 'L1',
      sender_id: 'a',
      token_hash: 'f'.repeat(64),
      share_mode: 'timed',
      version: 2,
      ended_at: null,
      end_reason: null,
    } as const;
    expect(linkAclValue({ ...base, status: 'active', expires_at: 123 })).toEqual({
      status: 'active',
      sender_id: 'a',
      link_id: 'L1',
      share_mode: 'timed',
      expires_at: 123,
      version: 2,
    });
    expect(linkAclValue({ ...base, status: 'active', expires_at: null })).not.toHaveProperty('expires_at');
    expect(linkAclValue({ ...base, status: 'ended', expires_at: 123, ended_at: 456, end_reason: 'stopped_by_sender' })).toEqual({
      status: 'ended',
      version: 2,
      ended_at: 456,
      end_reason: 'stopped_by_sender',
    });
  });

  it('bağlantı süre dolumu görevi aynı kuyruğa, çakışmayan kimlikle', () => {
    const t = linkExpiryTaskFor({ link_id: 'Abc_1', status: 'active', expires_at: 2_000, version: 3 }, 1_000);
    expect(t?.id).toBe('link-Abc_1-v3-2000');
    expect(t?.data).toEqual({ link_id: 'Abc_1', version: 3 });
    expect(linkExpiryTaskFor({ link_id: 'x', status: 'active', expires_at: null, version: 1 })).toBeNull();
  });

  it('sunucu token üreteci: 32 bayt, kanonik base64url, her çağrıda farklı', () => {
    const a = newLinkToken();
    const b = newLinkToken();
    expect(isLinkToken(a)).toBe(true);
    expect(a).toHaveLength(43);
    expect(a).not.toBe(b);
  });
});

describe('Faz 2: Firestore dizinleri ve TTL alanları', () => {
  const idx = JSON.parse(readFileSync(new URL('../../firestore.indexes.json', import.meta.url), 'utf8')) as {
    indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[];
    fieldOverrides: { collectionGroup: string; fieldPath: string; ttl: boolean }[];
  };
  it('süreli koleksiyonların TTL politikası var', () => {
    const ttl = new Set(idx.fieldOverrides.filter((f) => f.ttl).map((f) => `${f.collectionGroup}.${f.fieldPath}`));
    for (const k of ['link_shares.purge_at', 'route_cache.expire_at', 'geocode_cache.expire_at', 'maps_quota.purge_at', 'maps_budget.purge_at']) {
      expect(ttl).toContain(k);
    }
  });
  it('bağlantı sorgularının bileşik dizinleri var', () => {
    const has = (c: string, ...f: string[]) =>
      idx.indexes.some((i) => i.collectionGroup === c && i.fields.map((x) => x.fieldPath).join(',') === f.join(','));
    expect(has('link_shares', 'status', 'expires_at')).toBe(true);
    expect(has('link_shares', 'sender_id', 'status')).toBe(true);
  });
});

describe('Faz 2: barındırma (Universal Links / App Links, web haritası)', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const fb = JSON.parse(read('firebase.json')) as {
    hosting: {
      public: string;
      ignore: string[];
      rewrites: { source: string; destination: string }[];
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
  };
  const headerOf = (source: string, key: string) =>
    fb.hosting.headers.find((h) => h.source === source)?.headers.find((x) => x.key.toLowerCase() === key.toLowerCase())?.value;

  it('AASA: applinks /s/* yolu, uygulama kimliği', () => {
    const aasa = JSON.parse(read('hosting/public/.well-known/apple-app-site-association'));
    const d = aasa.applinks.details[0];
    expect(d.appIDs[0]).toMatch(/^[A-Z0-9]+\.com\.example\.konum$/);
    expect(d.components.map((c: { '/': string }) => c['/'])).toEqual([`${LINK_PATH_PREFIX}*`]);
  });

  it('assetlinks.json: handle_all_urls, paket adı, SHA-256 biçimi', () => {
    const links = JSON.parse(read('hosting/public/.well-known/assetlinks.json'));
    expect(links[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(links[0].target.package_name).toBe('com.example.konum');
    for (const p of links[0].target.sha256_cert_fingerprints) expect(p).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('firebase.json: doğru Content-Type, /s/** web haritasına, nokta dosyaları yayınlanır', () => {
    expect(headerOf('/.well-known/apple-app-site-association', 'Content-Type')).toBe('application/json');
    expect(headerOf('/.well-known/assetlinks.json', 'Content-Type')).toBe('application/json');
    expect(fb.hosting.rewrites).toContainEqual({ source: `${LINK_PATH_PREFIX}**`, destination: '/index.html' });
    // Token URL'de: başka sitelere Referer ile sızmasın (strict-origin yalnızca kökü gönderir, yolu ASLA;
    // HTTP referrer kısıtlı Maps JS anahtarı için kök gerekir, anahtarsız sayfa meta ile no-referrer'a sıkılaştırır),
    // aranmasın, önbelleğe alınmasın, başka siteye çerçevelenmesin.
    expect(headerOf('/s/**', 'Referrer-Policy')).toBe('strict-origin');
    expect(headerOf('**', 'Referrer-Policy')).toBe('strict-origin');
    expect(headerOf('/s/**', 'Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(headerOf('/s/**', 'X-Frame-Options')).toBe('DENY');
    expect(headerOf('/s/**', 'Cache-Control')).toContain('no-store');
    expect(headerOf('/s/**', 'X-Robots-Tag')).toContain('noindex');
    expect(fb.hosting.ignore.some((g) => g === '**/.*')).toBe(false);
    expect(fb.hosting.public).toBe('hosting/dist');
  });
});

// ---------------------------------------------------------------------------
// Faz 3: live_trail, kuyruk alt sınırı, bildirim metinleri
// ---------------------------------------------------------------------------

describe('Faz 3: database.rules.json ↔ core outbox sözleşmesi', () => {
  const trailNode: Record<string, unknown> = rules.rules.live_trail.$receiver_id.$share_id.$point_id;

  it('live_trail alanları core TRAIL_FIELDS ile birebir aynı; diğer her alan reddedilir; q === 1', () => {
    const allowed = Object.keys(trailNode).filter((k) => !k.startsWith('.') && !k.startsWith('$'));
    expect(new Set(allowed)).toEqual(new Set(TRAIL_FIELDS));
    expect(trailNode.$other).toEqual({ '.validate': false });
    expect((trailNode.q as Record<string, string>)['.validate']).toContain('=== 1');
    const required = /hasChildren\(\[([^\]]+)\]\)/.exec(String(trailNode['.write']))?.[1]?.split(',').map((x) => x.trim().replace(/'/g, '')) ?? [];
    for (const f of required) expect(TRAIL_FIELDS).toContain(f);
    expect(required).not.toContain('battery_pct'); // pil bilinmiyorsa core yazmaz
  });

  it('iz penceresi core kuyruk yaşıyla aynı; alıcı okur; yazma ACL + gönderen + süre', () => {
    const ts = (trailNode.timestamp as Record<string, string>)['.validate'];
    expect(ts).toContain(`now - ${PACKET_LIMITS.maxQueuedSampleAgeMs}`);
    expect(PACKET_LIMITS.maxQueuedSampleAgeMs).toBe(OUTBOX_LIMITS.maxAgeMs);
    expect(ts).toContain(`now + ${PACKET_LIMITS.maxFutureSkewMs}`);
    expect(ts).toContain("child('started_at')");
    const w = String(trailNode['.write']);
    for (const part of ["child('status').val() === 'active'", "child('sender_id').val() === auth.uid", "child('receiver_id').val() === $receiver_id", "child('expires_at').val() > now"]) {
      expect(w).toContain(part);
    }
    expect(rules.rules.live_trail.$receiver_id['.read']).toBe('auth != null && auth.uid === $receiver_id');
  });

  it('bağlantılara iz yok (core LINK_TRAIL_ENABLED = false): link_trail düğümü tanımlı değil', () => {
    expect(LINK_TRAIL_ENABLED).toBe(false);
    expect(rules.rules).not.toHaveProperty('link_trail');
  });

  it('kuyruk noktası paylaşım / bağlantı başlangıcından eski olamaz (ACL started_at)', () => {
    expect(String(liveNode['.write'])).toContain("root.child('share_acl').child($share_id).child('started_at')");
    expect(String(rules.rules.link_live.$token_hash['.write'])).toContain("root.child('link_acl').child($token_hash).child('started_at')");
    const base = { share_id: 'a_b', sender_id: 'a', receiver_id: 'b', version: 1, share_mode: 'weekly', ended_at: null, end_reason: null } as const;
    expect(aclValue({ ...base, status: 'active', expires_at: 9, started_at: 5 })).toMatchObject({ started_at: 5 });
    expect(aclValue({ ...base, status: 'ended', expires_at: 9, started_at: 5, ended_at: 7 })).toEqual({ status: 'ended', version: 1, ended_at: 7 });
  });
});

describe('Faz 3: bildirimler koordinat taşımaz', () => {
  it('Türkçe tamlayan eki', () => {
    expect(turkishGenitive('Ayşe')).toBe("Ayşe'nin");
    expect(turkishGenitive('Can')).toBe("Can'ın");
    expect(turkishGenitive('Bora')).toBe("Bora'nın");
    expect(turkishGenitive('Ümit')).toBe("Ümit'in");
    expect(turkishGenitive('Oğuz')).toBe("Oğuz'un");
    expect(turkishGenitive('Gül')).toBe("Gül'ün");
    expect(turkishGenitive('IŞIK')).toBe("IŞIK'ın");
    expect(turkishGenitive('Ayşe Y.')).toBe("Ayşe Y.'nin");
    expect(turkishGenitive('JR')).toBeNull();
    expect(turkishGenitive('  ')).toBeNull();
  });

  it('düşük pil: "Ayşe\'nin pili azaldı" / "Pil %14. Konum daha seyrek güncellenecek."', () => {
    const m = buildBatteryLowPush('Ayşe', 14, 'uA_uB');
    expect(m.notification).toEqual({ title: "Ayşe'nin pili azaldı", body: 'Pil %14. Konum daha seyrek güncellenecek.' });
    expect(m.data).toEqual({ type: 'battery_low', share_id: 'uA_uB', battery_pct: '14' });
    expect(buildBatteryLowPush('', 9.6, 'x').notification).toEqual({ title: 'Arkadaşının pili azaldı', body: 'Pil %10. Konum daha seyrek güncellenecek.' });
    // Tek kaynak: core metni (mobil ön plan bildirimi ve web görüntüleyici de bunu kullanır).
    expect(m.notification).toEqual(lowBatteryPushText('Ayşe', 14));
    expect(BatteryLowNotifySchema).toBe(BatteryLowNotifyRequestSchema);
  });

  it('resume_tracking yalnızca veri (sessiz); tracking_stalled görünür', () => {
    const now = 1_700_000_000_000;
    const r = buildResumeTrackingPush(['s1', 's2'], 1, now);
    expect(r.notification).toBeUndefined();
    expect(r.data).toEqual({ type: 'resume_tracking', session_ids: 's1,s2', level: '1' });
    expect(r.android).toMatchObject({ priority: 'high', ttl: 15 * 60 * 1000 });
    expect(r.apns?.headers).toMatchObject({ 'apns-push-type': 'background', 'apns-priority': '5', 'apns-expiration': String(now / 1000 + 900) });
    expect(r.apns?.payload?.aps).toEqual({ contentAvailable: true });
    const v = buildTrackingStalledPush(['s1']);
    expect(v.notification?.body).toBe('Konum paylaşımın duraksadı. Devam etmek için dokun.');
    for (const m of [r, v, buildBatteryLowPush('Ayşe', 14, 'a_b')]) {
      expect(PUSH_TYPES_F3).toContain(m.data.type);
      const json = JSON.stringify(m);
      for (const banned of ['"lat"', '"lng"', 'accuracy', 'phone']) expect(json).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Faz 4: bildirim yükleri (ping / SOS) ve kural düğümleri
// ---------------------------------------------------------------------------

describe('Faz 4: push yükleri ve RTDB düğümleri', () => {
  const sos = {
    sos_id: 'S1',
    sender_id: 'uA',
    sender_name: 'Ayşe',
    address: 'Kadıköy, İstanbul',
    location: { lat: 40.990123, lng: 29.020456, accuracy: 8, timestamp: 1 },
    battery_pct: 23,
  };

  it('ping ve SOS bildirimleri koordinat taşımaz; veri türleri core PUSH_TYPES_F4', () => {
    const msgs = [
      buildPingPush('Ayşe', { ping_id: 'p1', from: 'uA', kind: 'on_way', eta_s: 720, expires_at: 2_000_000 }, 1_000_000),
      buildSosPush(sos, false),
      buildSosPush(sos, true),
      buildSosResolvedPush('Ayşe', 'S1', 'uA'),
      buildSosAckPush('Bora', 'S1', 'uB'),
    ];
    for (const m of msgs) {
      expect(PUSH_TYPES_F4).toContain(m.data.type);
      const json = JSON.stringify(m);
      for (const banned of ['"lat"', '"lng"', '40.99', '29.02', 'phone']) expect(json).not.toContain(banned);
    }
    expect(msgs[0]?.data).toEqual({ type: 'ping', ping_id: 'p1', from: 'uA', kind: 'on_way' });
    expect(msgs[0]?.notification).toEqual(pingPushText('Ayşe', 'on_way', 720));
    expect(msgs[0]?.android?.notification?.channelId).toBe(NOTIFICATION_CHANNELS_F4.ping);
    expect(msgs[1]?.notification).toEqual(sosPushText(sos));
    expect(msgs[1]?.data).toEqual({ type: 'sos', sos_id: 'S1', sender_id: 'uA' });
  });

  it('SOS: Android yüksek öncelik + sos kanalı + kilit ekranında görünür; iOS kritik yalnızca bayrakla', () => {
    const normal = buildSosPush(sos, false);
    expect(normal.android).toMatchObject({ priority: 'high', notification: { channelId: 'sos', visibility: 'public', sound: 'default' } });
    expect(normal.apns?.headers?.['apns-priority']).toBe('10');
    expect(normal.apns?.payload?.aps).toMatchObject({ 'interruption-level': 'time-sensitive', sound: 'default' });
    const critical = buildSosPush(sos, true);
    expect(critical.apns?.payload?.aps).toMatchObject({ 'interruption-level': 'critical', sound: { critical: true, name: 'default', volume: 1 } });
    expect(SOS_CRITICAL_ALERTS).toBe(false); // varsayılan kapalı (Apple onayı)
  });

  it('canlı pakette not alanları; ping_inbox yalnızca alıcı okur/siler; ping_expiry kapalı', () => {
    for (const f of DELIVERED_OPTIONAL_F4_FIELDS) expect(Object.keys(liveNode)).toContain(f);
    expect(String((liveNode.note as Record<string, string>)['.validate'])).toContain(`<= ${PACKET_NOTE_MAX_CHARS}`);
    expect(rules.rules.ping_inbox.$uid['.read']).toBe('auth != null && auth.uid === $uid');
    expect(rules.rules.ping_inbox.$uid.$ping_id['.write']).toBe('auth != null && auth.uid === $uid && !newData.exists()');
    expect(rules.rules.ping_expiry).toMatchObject({ '.read': false, '.write': false });
    expect(Object.keys(rules.rules.link_live.$token_hash)).not.toContain('note');
  });
});

describe('Faz 5: bildirimler koordinat taşımaz', () => {
  it('zone_event / meetup / meetup_response: data türleri core PUSH_TYPES_F5, Faz 4 ping kanalı, yalnızca ad', async () => {
    const { PUSH_TYPES_F5 } = await import('@konum/core');
    const { buildMeetupPush, buildMeetupResponsePush, buildZoneEventPush } = await import('../../functions/src/push');
    const place = { name: 'Moda Kahve', location: { lat: 40.98765, lng: 29.02345 } };
    const msgs = [
      buildZoneEventPush('Erim', 'u1', 'Ev', 'arrive'),
      buildMeetupPush('Ayşe', { meetup_id: 'm1', from: 'u2', place, expires_at: Date.now() + 60_000 }),
      buildMeetupResponsePush('Bora', { meetup_id: 'm1', place }, 'u3', 'declined'),
    ];
    expect(msgs.map((m) => m.data.type)).toEqual([...PUSH_TYPES_F5]);
    expect(msgs[0]?.notification).toEqual({ title: 'Erim', body: 'Ev konumuna vardı' });
    for (const m of msgs) {
      expect(m.android?.notification?.channelId).toBe(NOTIFICATION_CHANNELS_F4.ping);
      expect(JSON.stringify(m)).not.toMatch(/40\.98|29\.02|"lat"|"lng"/);
      for (const v of Object.values(m.data)) expect(typeof v).toBe('string');
    }
  });
});

describe('Faz 6: Storage kuralları, push yükleri, widget yenileme kararı', () => {
  it('storage.rules dosya adı ve boyut sınırları core AVATAR_LIMITS / AVATAR_FILE_RE ile aynı', async () => {
    const { AVATAR_FILE_RE, AVATAR_LIMITS } = await import('@konum/core');
    const storage = readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8');
    expect(storage).toContain(`request.resource.size <= ${AVATAR_LIMITS.mainMaxBytes}`);
    expect(storage).toContain(`request.resource.size <= ${AVATAR_LIMITS.thumbMaxBytes}`);
    expect(storage).toContain("request.resource.contentType == 'image/jpeg'");
    expect(storage).toContain('match /avatars/{uid}/{file}');
    // Kuraldaki iki desen birlikte core düzenli ifadesiyle aynı dili tanır.
    const main = /^[0-9]{13}[.]jpg$/;
    const thumb = /^[0-9]{13}_160[.]jpg$/;
    for (const f of ['1732500000000.jpg', '1732500000000_160.jpg', 'a.jpg', '1732500000000.png', '173250000000.jpg', '1732500000000_80.jpg']) {
      expect(main.test(f) || thumb.test(f)).toBe(AVATAR_FILE_RE.test(f));
    }
    const fb = JSON.parse(readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'));
    expect(fb.storage).toEqual({ rules: 'storage.rules' });
    expect(fb.emulators.storage.port).toBe(9199);
  });

  it('quick_share_started görünür (QUICK_SHARE kategorisi), widget_refresh yalnızca veri; koordinat yok, değerler string', async () => {
    const { PUSH_TYPES_F6 } = await import('@konum/core');
    const { QUICK_SHARE_CATEGORY, buildQuickShareStartedPush, buildWidgetRefreshPush } = await import('../../functions/src/push');
    const now = Date.now();
    const started = buildQuickShareStartedPush('Ayşe', { share_id: 's_1', status: 'started', expires_at: now + 3_600_000 }, now);
    const refresh = buildWidgetRefreshPush('u1', now);
    expect([started.data.type, refresh.data.type]).toEqual([...PUSH_TYPES_F6]);
    expect(started.notification).toEqual({ title: 'Konum paylaşımı başladı', body: 'Ayşe ile 1 saatlik paylaşım başladı' });
    expect(started.data).toEqual({ type: 'quick_share_started', share_id: 's_1', to_name: 'Ayşe', expires_at: String(now + 3_600_000) });
    expect(started.apns?.payload?.aps?.category).toBe(QUICK_SHARE_CATEGORY);
    expect(refresh.notification).toBeUndefined();
    expect(refresh.apns?.headers?.['apns-push-type']).toBe('background');
    expect(refresh.apns?.payload?.aps?.contentAvailable).toBe(true);
    const indefinite = buildQuickShareStartedPush('Ayşe', { share_id: 's_1', status: 'already_active', expires_at: null }, now);
    expect(indefinite.data.expires_at).toBe('');
    for (const m of [started, refresh, indefinite]) {
      expect(JSON.stringify(m)).not.toMatch(/"lat"|"lng"/);
      for (const v of Object.values(m.data)) expect(typeof v).toBe('string');
    }
  });

  it('widget_refresh kararı: yalnızca aktiflik değişince alıcıya (uzatma / duraksama kaydı → yok)', async () => {
    const { widgetRefreshFor } = await import('../../functions/src/handlers/widget');
    const s = (status: 'active' | 'ended') => ({ sender_id: 'a1', receiver_id: 'b1', status, audience: 'friend' as const });
    expect(widgetRefreshFor(null, s('active'))).toEqual({ receiver: 'b1', from: 'a1' });
    expect(widgetRefreshFor(s('active'), s('ended'))).toEqual({ receiver: 'b1', from: 'a1' });
    expect(widgetRefreshFor(s('ended'), s('active'))).toEqual({ receiver: 'b1', from: 'a1' });
    expect(widgetRefreshFor(s('active'), s('active'))).toBeNull();
    expect(widgetRefreshFor(s('ended'), null)).toBeNull();
    expect(widgetRefreshFor(s('active'), null)).toEqual({ receiver: 'b1', from: 'a1' });
  });
});

describe('Faz 8: izin bildirimleri, onay muafiyetleri ve TTL', () => {
  it('izin isteği / izin verildi bildirimleri koordinat taşımaz; veri türleri core PUSH_TYPES_F8; değerler metin', async () => {
    const { PUSH_TYPES_F8, permissionGrantedText, permissionRequestText } = await import('@konum/core');
    const { buildPermissionGrantedPush, buildPermissionRequestPush } = await import('../../functions/src/push');
    const req = buildPermissionRequestPush('Can', 'uC', ['ping', 'location_view']);
    const ok = buildPermissionGrantedPush('Ayşe', 'uA', ['location_view']);
    expect([req.data.type, ok.data.type]).toEqual([...PUSH_TYPES_F8]);
    expect(req.data).toEqual({ type: 'permission_request', from: 'uC', scopes: 'location_view,ping' });
    expect(req.notification?.body).toBe(permissionRequestText('Can', ['location_view', 'ping']));
    expect(ok.data).toEqual({ type: 'permission_granted', by: 'uA', scopes: 'location_view' });
    expect(ok.notification?.body).toBe(permissionGrantedText('Ayşe', ['location_view']));
    for (const m of [req, ok]) {
      expect(JSON.stringify(m)).not.toMatch(/"lat"|"lng"|"accuracy"/);
      for (const v of Object.values(m.data)) expect(typeof v).toBe('string');
    }
  });

  it('onay kapısı muafiyetleri: yalnızca koruyucu yönler (izni kapatmak, görünmez olmak)', async () => {
    const { consentExemptCall } = await import('@konum/core');
    expect(consentExemptCall(CALLABLES.userBootstrap)).toBe(true);
    expect(consentExemptCall(CALLABLES.consentAccept)).toBe(true);
    expect(consentExemptCall(CALLABLES.userBlock)).toBe(true);
    expect(consentExemptCall(CALLABLES.permissionSet, { granted: false })).toBe(true);
    expect(consentExemptCall(CALLABLES.permissionSet, { granted: true })).toBe(false);
    expect(consentExemptCall(CALLABLES.invisibleSet, { invisible: true })).toBe(true);
    expect(consentExemptCall(CALLABLES.invisibleSet, { invisible: false })).toBe(false);
    for (const n of [CALLABLES.shareStart, CALLABLES.linkShareCreate, CALLABLES.pingSend, CALLABLES.permissionRequestSend]) {
      expect(consentExemptCall(n)).toBe(false);
    }
  });

  it('ret soğuması kayıtlarının TTL politikası var', () => {
    const idx = JSON.parse(readFileSync(new URL('../../firestore.indexes.json', import.meta.url), 'utf8')) as {
      fieldOverrides: { collectionGroup: string; fieldPath: string; ttl: boolean }[];
    };
    expect(idx.fieldOverrides.some((f) => f.ttl && f.collectionGroup === 'permission_declines' && f.fieldPath === 'purge_at')).toBe(true);
  });
});
