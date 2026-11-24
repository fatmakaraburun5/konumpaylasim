import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LINK_DOMAIN_DEFAULT,
  LINK_DURATION_OPTIONS,
  LINK_HASH_RE,
  LINK_LIVE_FIELDS,
  LINK_SENDER_NAME_FALLBACK,
  LINK_TOKEN_BYTES,
  LINK_TOKEN_LENGTH,
  LINK_TOKEN_RE,
  LINK_VIEW_DETAIL,
  LINK_VIEW_TEXT,
  MINUTE,
  PATHS,
  SERVER_TIMESTAMP,
  base64UrlDecode,
  base64UrlEncode,
  buildLinkLiveWrite,
  buildLinkUrl,
  encodeLinkToken,
  extendExpiry,
  extendPromptAt,
  generateLinkToken,
  isLinkToken,
  isLinkTokenHash,
  linkSenderName,
  linkTokenHash,
  linkViewState,
  parseLinkLive,
  parseLinkToken,
  selectLinkPublishTargets,
  sha256Hex,
  toLinkLiveUpdate,
  utf8Encode,
  type LinkLiveLocation,
  type LinkShareView,
  type LinkViewInput,
  type LinkViewState,
  type NormalizedSample,
} from '../src';

const NOW = Date.UTC(2026, 10, 24, 9, 0, 0);
const HOUR_MS = 60 * MINUTE;
const nodeSha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** Tekrarlanabilir sözde rastgele (xorshift32). */
function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

const ALPHABETS = [
  'abcçdefgğhıijklmnoöprsştuüvyzABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ0123456789 .,:;-_/?#&=',
  'çğıöşüÇĞİÖŞÜ€£¥©®™±×÷',
  '漢字かなカナ한국어العربيةעברית',
  '😀🎉🚗📍🗺️👩‍👩‍👧‍👦🇹🇷',
];

function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < len; i++) {
    const alpha = [...(ALPHABETS[Math.floor(rand() * ALPHABETS.length)] as string)];
    s += alpha[Math.floor(rand() * alpha.length)];
  }
  return s;
}

describe('sha256Hex (saf TS)', () => {
  it('FIPS 180-4 test vektörleri', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('blok sınırlarında Node crypto ile aynı (rastgele baytlar)', () => {
    for (const len of [0, 1, 31, 32, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4097]) {
      for (let k = 0; k < 3; k++) {
        const bytes = new Uint8Array(randomBytes(len));
        expect(sha256Hex(bytes)).toBe(nodeSha(bytes));
      }
    }
  });

  it('Türkçe, emoji, CJK ve karışık metinlerde Node crypto ile aynı (2000 girdi)', () => {
    const rand = prng(20261124);
    for (let i = 0; i < 2000; i++) {
      const s = randomString(rand, 200);
      expect(sha256Hex(s)).toBe(nodeSha(s));
    }
  });

  it('eşsiz vekil (lone surrogate) TextEncoder / Buffer gibi U+FFFD olur', () => {
    for (const s of ['\ud83d', 'a\udc00b', '\udc00\ud800', 'x😀\ud83dy']) {
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(Buffer.from(s, 'utf8')));
      expect(sha256Hex(s)).toBe(nodeSha(s));
    }
  });

  it('utf8Encode Buffer.from ile aynı', () => {
    const rand = prng(7);
    for (let i = 0; i < 500; i++) {
      const s = randomString(rand, 60);
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(Buffer.from(s, 'utf8')));
    }
  });
});

describe('base64url', () => {
  it('Node base64url ile aynı, dolgusuz, çift yönlü', () => {
    for (let len = 0; len < 70; len++) {
      const bytes = new Uint8Array(randomBytes(len));
      const enc = base64UrlEncode(bytes);
      expect(enc).toBe(Buffer.from(bytes).toString('base64url'));
      expect(enc).not.toMatch(/[=+/]/);
      expect(Array.from(base64UrlDecode(enc) ?? [])).toEqual(Array.from(bytes));
    }
  });
  it('geçersiz girdide null', () => {
    expect(base64UrlDecode('abc+')).toBeNull();
    expect(base64UrlDecode('a')).toBeNull();
    expect(base64UrlDecode('ab=')).toBeNull();
  });
});

describe('bağlantı token', () => {
  it('32 bayt → 43 karakter, kanonik biçim', () => {
    expect(LINK_TOKEN_BYTES).toBe(32);
    for (let i = 0; i < 500; i++) {
      const bytes = new Uint8Array(randomBytes(32));
      const t = encodeLinkToken(bytes);
      expect(t).toHaveLength(LINK_TOKEN_LENGTH);
      expect(t).toMatch(LINK_TOKEN_RE);
      expect(isLinkToken(t)).toBe(true);
      expect(Array.from(base64UrlDecode(t) ?? [])).toEqual(Array.from(bytes));
    }
    expect(encodeLinkToken(new Uint8Array(32))).toBe('A'.repeat(43));
    expect(encodeLinkToken(new Uint8Array(32).fill(255))).toBe(`${'_'.repeat(42)}8`);
  });

  it('yanlış uzunluk reddedilir', () => {
    expect(() => encodeLinkToken(new Uint8Array(31))).toThrow();
    expect(() => encodeLinkToken(new Uint8Array(33))).toThrow();
  });

  it('generateLinkToken verilen üreteci kullanır', () => {
    const t = generateLinkToken((n) => new Uint8Array(n).fill(0));
    expect(t).toBe('A'.repeat(43));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateLinkToken());
    expect(seen.size).toBe(200);
  });

  it('isLinkToken biçim dışını reddeder', () => {
    const t = encodeLinkToken(new Uint8Array(randomBytes(32)));
    expect(isLinkToken(t.slice(1))).toBe(false);
    expect(isLinkToken(`${t}A`)).toBe(false);
    expect(isLinkToken(`${t.slice(0, 42)}B`)).toBe(false); // alt 2 bit 0 değil → kanonik değil
    expect(isLinkToken(`${t.slice(0, 41)}+A`)).toBe(false);
    expect(isLinkToken(`${t.slice(0, 41)}=A`)).toBe(false);
    expect(isLinkToken(42 as unknown)).toBe(false);
    expect(isLinkToken(null)).toBe(false);
  });

  it('token_hash = SHA-256 hex (Node ve tarayıcı ile aynı)', () => {
    for (let i = 0; i < 200; i++) {
      const t = generateLinkToken();
      const h = linkTokenHash(t);
      expect(h).toMatch(LINK_HASH_RE);
      expect(isLinkTokenHash(h)).toBe(true);
      expect(h).toBe(nodeSha(t));
    }
    expect(isLinkTokenHash('A'.repeat(64))).toBe(false);
    expect(PATHS.linkLive(linkTokenHash('A'.repeat(43)))).toMatch(/^link_live\/[0-9a-f]{64}$/);
  });
});

describe('bağlantı URL', () => {
  const token = encodeLinkToken(new Uint8Array(randomBytes(32)));

  it('buildLinkUrl', () => {
    expect(buildLinkUrl(LINK_DOMAIN_DEFAULT, token)).toBe(`https://konum.example.com/s/${token}`);
    expect(buildLinkUrl('https://Konum.Example.com/', token)).toBe(`https://konum.example.com/s/${token}`);
    expect(buildLinkUrl('localhost:5173', token)).toBe(`https://localhost:5173/s/${token}`);
    expect(() => buildLinkUrl('konum.example.com', 'kısa')).toThrow();
    expect(() => buildLinkUrl('kötü alan', token)).toThrow();
    expect(() => buildLinkUrl('a/b', token)).toThrow();
  });

  it('parseLinkToken kabul ettikleri', () => {
    const url = buildLinkUrl(LINK_DOMAIN_DEFAULT, token);
    expect(parseLinkToken(url)).toBe(token);
    expect(parseLinkToken(`  ${url}  `)).toBe(token);
    expect(parseLinkToken(`${url}/`)).toBe(token);
    expect(parseLinkToken(`${url}?utm=qr#harita`)).toBe(token);
    expect(parseLinkToken(`HTTPS://KONUM.EXAMPLE.COM/s/${token}`)).toBe(token);
    expect(parseLinkToken(`konum://s/${token}`)).toBe(token);
    expect(parseLinkToken(`konum:///s/${token}`)).toBe(token);
    expect(parseLinkToken(token)).toBe(token);
    expect(parseLinkToken(`https://ikinci.example.org/s/${token}`, ['konum.example.com', 'ikinci.example.org'])).toBe(token);
    expect(parseLinkToken(`http://localhost:5173/s/${token}`, ['localhost:5173'])).toBe(token);
  });

  it('parseLinkToken reddettikleri', () => {
    expect(parseLinkToken(`https://evil.example.com/s/${token}`)).toBeNull();
    expect(parseLinkToken(`https://konum.example.com.evil.com/s/${token}`)).toBeNull();
    expect(parseLinkToken(`https://user@konum.example.com/s/${token}`)).toBeNull();
    expect(parseLinkToken(`http://konum.example.com/s/${token}`)).toBeNull();
    expect(parseLinkToken(`http://localhost:5173/s/${token}`)).toBeNull(); // listede değil
    expect(parseLinkToken(`https://konum.example.com/x/${token}`)).toBeNull();
    expect(parseLinkToken(`https://konum.example.com/s/${token}/fazla`)).toBeNull();
    expect(parseLinkToken(`https://konum.example.com/s/${token.slice(1)}`)).toBeNull();
    expect(parseLinkToken(`otherapp://s/${token}`)).toBeNull();
    expect(parseLinkToken('')).toBeNull();
    expect(parseLinkToken('LOC-7KQ2MX')).toBeNull();
  });
});

describe('link_live paketi', () => {
  const sample: NormalizedSample = {
    lat: 41.008237,
    lng: 28.978359,
    accuracy: 8.4,
    speed_mps: null,
    heading: 90,
    timestamp: NOW - 1_000,
    mocked: true,
  };
  const hash = linkTokenHash(encodeLinkToken(new Uint8Array(32).fill(7)));
  const view = (over: Partial<LinkShareView> = {}): LinkShareView => ({
    link_id: 'lnk1',
    session_id: 'sess1',
    token_hash: hash,
    status: 'active',
    share_mode: 'timed',
    started_at: NOW - 10 * MINUTE,
    expires_at: NOW + 50 * MINUTE,
    end_reason: null,
    version: 1,
    extended_count: 0,
    ...over,
  });

  it('yalnızca izinli alanlar, null yok, sunucu zaman damgası yer tutucu', () => {
    const w = buildLinkLiveWrite(sample, { batteryLevel: 0.42, isCharging: true }, {
      share_mode: 'timed',
      expires_at: NOW + HOUR_MS,
      sender_name: '  Ayşe   Yılmaz ',
    });
    expect(w).toEqual({
      v: 1,
      lat: 41.008237,
      lng: 28.978359,
      accuracy: 8.4,
      heading: 90,
      battery_pct: 42,
      timestamp: NOW - 1_000,
      server_ts: SERVER_TIMESTAMP,
      sender_name: 'Ayşe Yılmaz',
      expires_at: NOW + HOUR_MS,
      share_mode: 'timed',
    });
    for (const k of Object.keys(w)) expect(LINK_LIVE_FIELDS as readonly string[]).toContain(k);
    for (const banned of ['sender_id', 'share_id', 'receiver_ids', 'link_id', 'session_id', 'is_charging', 'activity_state', 'mocked', 'phone_e164', 'avatar_url']) {
      expect(w).not.toHaveProperty(banned);
    }
  });

  it('süresiz paylaşımda expires_at, pil bilinmiyorsa battery_pct yazılmaz', () => {
    const w = buildLinkLiveWrite(sample, { batteryLevel: -1, isCharging: null }, { share_mode: 'indefinite', expires_at: null, sender_name: '' });
    expect(w).not.toHaveProperty('expires_at');
    expect(w).not.toHaveProperty('battery_pct');
    expect(w).not.toHaveProperty('speed_mps');
    expect(w.sender_name).toBe(LINK_SENDER_NAME_FALLBACK);
  });

  it('hedef seçimi ve yol haritası: biten / süresi dolan atlanır', () => {
    const links = [
      view(),
      view({ link_id: 'lnk2', status: 'ended', end_reason: 'stopped_by_sender' }),
      view({ link_id: 'lnk3', expires_at: NOW - 1 }),
      view({ link_id: 'lnk4', expires_at: null, share_mode: 'indefinite', token_hash: linkTokenHash('B'.repeat(43)) }),
      view({ link_id: 'lnk5', token_hash: 'bozuk' }),
    ];
    const targets = selectLinkPublishTargets(links, 'Ayşe', NOW);
    expect(targets.map((t) => t.link_id)).toEqual(['lnk1', 'lnk4']);
    const update = toLinkLiveUpdate(sample, { batteryLevel: null, isCharging: null }, targets, NOW);
    expect(Object.keys(update).sort()).toEqual([PATHS.linkLive(hash), PATHS.linkLive(linkTokenHash('B'.repeat(43)))].sort());
    expect(toLinkLiveUpdate(sample, { batteryLevel: null, isCharging: null }, targets, NOW + HOUR_MS)).toHaveProperty([
      PATHS.linkLive(linkTokenHash('B'.repeat(43))),
    ]);
    expect(Object.keys(toLinkLiveUpdate(sample, { batteryLevel: null, isCharging: null }, targets, NOW + HOUR_MS))).toHaveLength(1);
  });

  it('parseLinkLive: eksik alanlar null, bozuk kayıt null, bilinmeyen alan atılır', () => {
    const raw = { v: 1, lat: 41, lng: 29, accuracy: 5, timestamp: NOW, server_ts: NOW + 50, sender_name: 'Ayşe', share_mode: 'weekly', extra: 1 };
    const p = parseLinkLive(raw);
    expect(p).toEqual({
      v: 1,
      lat: 41,
      lng: 29,
      accuracy: 5,
      heading: null,
      speed_mps: null,
      battery_pct: null,
      timestamp: NOW,
      server_ts: NOW + 50,
      sender_name: 'Ayşe',
      expires_at: null,
      share_mode: 'weekly',
    });
    expect(parseLinkLive({ ...raw, lat: 200 })).toBeNull();
    expect(parseLinkLive(null)).toBeNull();
    expect(parseLinkLive({ ...raw, share_mode: 'forever' })).toBeNull();
  });

  it('linkSenderName: 40 karakter sınırı (emoji bölünmez)', () => {
    expect(linkSenderName('x'.repeat(60))).toHaveLength(40);
    expect([...linkSenderName('😀'.repeat(50))]).toHaveLength(40);
    expect(linkSenderName(null)).toBe(LINK_SENDER_NAME_FALLBACK);
  });

  it('Faz 1 süre motoru bağlantı görünümüyle çalışır (+30 dk / +1 saat, uyarı anı)', () => {
    const v = view({ started_at: NOW, expires_at: NOW + HOUR_MS });
    expect(extendExpiry(v, 30, NOW + 50 * MINUTE)).toEqual({ share_mode: 'timed', expires_at: NOW + HOUR_MS + 30 * MINUTE });
    expect(extendPromptAt(v)).toBe(NOW + HOUR_MS - 12 * MINUTE);
  });
});

describe('token sahibinin ekran durumu', () => {
  const live: LinkLiveLocation = {
    v: 1,
    lat: 41,
    lng: 29,
    accuracy: 5,
    heading: null,
    speed_mps: null,
    battery_pct: null,
    timestamp: NOW,
    server_ts: NOW,
    sender_name: 'Ayşe',
    expires_at: NOW + MINUTE,
    share_mode: 'timed',
  };
  const base: LinkViewInput = { tokenValid: true, loaded: true, denied: false, live: null, seenLive: false, now: NOW };

  it('durumlar', () => {
    expect(linkViewState({ ...base, tokenValid: false })).toBe('invalid');
    expect(linkViewState({ ...base, loaded: false })).toBe('loading');
    expect(linkViewState(base)).toBe('waiting');
    expect(linkViewState({ ...base, live })).toBe('live');
    expect(linkViewState({ ...base, live, now: NOW + MINUTE })).toBe('ended'); // süre doldu: pin kalkar
    expect(linkViewState({ ...base, live: { ...live, expires_at: null }, now: NOW + 100 * HOUR_MS })).toBe('live');
    expect(linkViewState({ ...base, seenLive: true })).toBe('ended'); // link_live silindi
    expect(linkViewState({ ...base, denied: true, live })).toBe('ended'); // ACL mezar taşı
    expect(linkViewState({ ...base, denied: true, seenLive: true })).toBe('ended'); // canlı görüldü, sonra ret
    expect(LINK_VIEW_TEXT.ended).toBe('Paylaşım sona erdi');
  });

  it('ilk okuma reddi: var olmayan / bitmiş / süresi dolmuş ayırt edilmez (unavailable)', () => {
    // hadAccess verilmezse seenLive || live sayılır.
    expect(linkViewState({ ...base, denied: true, loaded: false })).toBe('unavailable');
    expect(linkViewState({ ...base, denied: true })).toBe('unavailable');
    expect(linkViewState({ ...base, denied: true, hadAccess: false })).toBe('unavailable');
    // Boş anlık görüntü okundu (bekleniyor), sonra durduruldu: erişim vardı → sona erdi.
    expect(linkViewState({ ...base, denied: true, hadAccess: true })).toBe('ended');
    expect(linkViewState({ ...base, hadAccess: true })).toBe('waiting');
    // Geçersiz biçim her zaman önce gelir.
    expect(linkViewState({ ...base, tokenValid: false, denied: true })).toBe('invalid');
    expect(LINK_VIEW_TEXT.unavailable).toBe('Bağlantı geçersiz ya da süresi dolmuş');
  });

  it('her durumun başlığı ve açıklama alanı var', () => {
    const states: LinkViewState[] = ['invalid', 'unavailable', 'loading', 'waiting', 'live', 'ended'];
    for (const st of states) {
      expect(LINK_VIEW_TEXT[st].length).toBeGreaterThan(0);
      expect(typeof LINK_VIEW_DETAIL[st]).toBe('string');
    }
    expect(LINK_VIEW_DETAIL.ended).toBe('Paylaşan kişi konum paylaşımını durdurdu ya da süresi doldu.');
  });
});

describe('bağlantı süre seçenekleri', () => {
  it('15 dk, 1 saat, 8 saat, gün sonu, haftalık, süresiz', () => {
    expect(LINK_DURATION_OPTIONS.map((o) => o.id)).toEqual(['m15', 'h1', 'h8', 'eod', 'week', 'forever']);
    expect(LINK_DURATION_OPTIONS.every((o) => o.choice !== null)).toBe(true);
  });
});
