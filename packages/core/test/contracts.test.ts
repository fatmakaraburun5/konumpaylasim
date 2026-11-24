import { describe, expect, it } from 'vitest';
import {
  CALLABLES,
  ERROR_CODES,
  GeocodeReverseRequestSchema,
  GeocodeReverseResponseSchema,
  LINK_DOMAIN_DEFAULT,
  LINK_DURATION_OPTIONS,
  LinkShareCreateRequestSchema,
  LinkShareCreateResponseSchema,
  LinkShareExtendRequestSchema,
  LinkShareExtendResponseSchema,
  LinkShareStopRequestSchema,
  LinkShareStopResponseSchema,
  LinkShareViewSchema,
  PATHS,
  RouteComputeRequestSchema,
  RouteComputeResponseSchema,
  buildLinkUrl,
  generateLinkToken,
  linkTokenHash,
  uuidV4,
  type LinkShareCreateResponse,
  type LinkSharePhase2,
  type LinkShare,
} from '../src';

const NOW = Date.UTC(2026, 10, 24, 9, 0, 0);

describe('Faz 2 callable adları ve yollar', () => {
  it('yeni callable adları, çakışma yok', () => {
    expect(CALLABLES.linkShareCreate).toBe('link_share_create');
    expect(CALLABLES.linkShareExtend).toBe('link_share_extend');
    expect(CALLABLES.linkShareStop).toBe('link_share_stop');
    expect(CALLABLES.routeCompute).toBe('route_compute');
    expect(CALLABLES.geocodeReverse).toBe('geocode_reverse');
    const names = Object.values(CALLABLES);
    expect(new Set(names).size).toBe(names.length);
    // Faz 1 adları değişmedi
    expect(CALLABLES.shareStart).toBe('share_start');
  });

  it('yollar', () => {
    const h = linkTokenHash(generateLinkToken());
    expect(PATHS.linkShares).toBe('link_shares');
    expect(PATHS.linkShare('lnk1')).toBe('link_shares/lnk1');
    expect(PATHS.linkAcl(h)).toBe(`link_acl/${h}`);
    expect(PATHS.linkLive(h)).toBe(`link_live/${h}`);
    expect(PATHS.routeCache('k')).toBe('route_cache/k');
    expect(PATHS.geocodeCache('sxk97b2')).toBe('geocode_cache/sxk97b2');
    expect(PATHS.mapsQuota('u1', '2026-11-24')).toBe('maps_quota/u1_2026-11-24');
  });

  it('yeni hata kodları Türkçe mesajlı', () => {
    for (const code of ['link_not_found', 'link_limit_reached', 'maps_unavailable', 'quota_exceeded', 'route_not_found'] as const) {
      expect(ERROR_CODES[code].message.length).toBeGreaterThan(5);
    }
    expect(ERROR_CODES.maps_unavailable.retryable).toBe(true);
    expect(ERROR_CODES.quota_exceeded.retryable).toBe(false);
    expect(ERROR_CODES.link_limit_reached.message).toContain('5');
  });
});

describe('link_share_* şemaları', () => {
  it('create isteği: tüm QR süreleri geçer, saat dilimi varsayılanı', () => {
    for (const o of LINK_DURATION_OPTIONS) {
      const r = LinkShareCreateRequestSchema.parse({ op_id: uuidV4(), duration: o.choice });
      expect(r.time_zone).toBe('Europe/Istanbul');
    }
    expect(LinkShareCreateRequestSchema.parse({ op_id: uuidV4(), duration: { kind: 'weekly' }, time_zone: 'Europe/Berlin' }).time_zone).toBe(
      'Europe/Berlin',
    );
    expect(LinkShareCreateRequestSchema.safeParse({ op_id: 'x', duration: { kind: 'weekly' } }).success).toBe(false);
    expect(LinkShareCreateRequestSchema.safeParse({ op_id: uuidV4(), duration: { kind: 'monthly' } }).success).toBe(false);
  });

  const token = generateLinkToken();
  const created: LinkShareCreateResponse = {
    link_id: 'lnk_abc',
    session_id: 'sess_1',
    token_hash: linkTokenHash(token),
    status: 'active',
    share_mode: 'timed',
    started_at: NOW,
    expires_at: NOW + 3_600_000,
    end_reason: null,
    version: 1,
    extended_count: 0,
    token,
    url: buildLinkUrl(LINK_DOMAIN_DEFAULT, token),
    server_now: NOW,
  };

  it('create yanıtı', () => {
    expect(LinkShareCreateResponseSchema.parse(created)).toEqual(created);
    expect(LinkShareCreateResponseSchema.safeParse({ ...created, token: 'kısa' }).success).toBe(false);
    expect(LinkShareCreateResponseSchema.safeParse({ ...created, url: `http://konum.example.com/s/${token}` }).success).toBe(false);
    expect(LinkShareCreateResponseSchema.safeParse({ ...created, token_hash: 'ABC' }).success).toBe(false);
    // bilinmeyen bitiş nedeni yok sayılır (ileri uyumluluk)
    expect(LinkShareViewSchema.parse({ ...created, end_reason: 'gelecekteki_neden' }).end_reason).toBeNull();
  });

  it('extend / stop', () => {
    expect(LinkShareExtendRequestSchema.safeParse({ op_id: uuidV4(), link_id: 'lnk_abc', minutes: 30 }).success).toBe(true);
    expect(LinkShareExtendRequestSchema.safeParse({ op_id: uuidV4(), link_id: 'lnk_abc', minutes: 60 }).success).toBe(true);
    expect(LinkShareExtendRequestSchema.safeParse({ op_id: uuidV4(), link_id: 'lnk_abc', minutes: 45 }).success).toBe(false);
    expect(LinkShareExtendRequestSchema.safeParse({ op_id: uuidV4(), link_id: 'a/b', minutes: 30 }).success).toBe(false);
    expect(LinkShareStopRequestSchema.safeParse({ op_id: uuidV4(), link_id: 'lnk_abc' }).success).toBe(true);
    const { token: _t, url: _u, ...view } = created;
    const ended = { ...view, status: 'ended', end_reason: 'stopped_by_sender', version: 2 };
    expect(LinkShareStopResponseSchema.parse(ended)).toEqual(ended);
    expect(LinkShareExtendResponseSchema.parse({ ...view, extended_count: 1 })).toHaveProperty('extended_count', 1);
    // yanıt düz token taşımaz
    expect(LinkShareStopResponseSchema.parse({ ...ended, token })).not.toHaveProperty('token');
  });

  it('LinkSharePhase2 = LinkShare (Faz 1 adı korunur)', () => {
    const doc: LinkShare = {
      link_id: 'l',
      session_id: 's',
      audience: 'link',
      sender_id: 'u',
      token_hash: 'h',
      status: 'active',
      share_mode: 'weekly',
      started_at: NOW,
      expires_at: NOW + 1,
      ended_at: null,
      end_reason: null,
      version: 1,
      extended_count: 0,
    };
    const old: LinkSharePhase2 = doc;
    expect(old.audience).toBe('link');
  });
});

describe('route_compute / geocode_reverse şemaları', () => {
  it('route isteği', () => {
    const ok = { op_id: uuidV4(), origin: { lat: 41, lng: 29 }, destination: { lat: 41.1, lng: 29.1 }, travel_mode: 'WALK' };
    expect(RouteComputeRequestSchema.safeParse(ok).success).toBe(true);
    expect(RouteComputeRequestSchema.safeParse({ ...ok, travel_mode: 'TRANSIT' }).success).toBe(false);
    expect(RouteComputeRequestSchema.safeParse({ ...ok, origin: { lat: 91, lng: 0 } }).success).toBe(false);
    expect(RouteComputeRequestSchema.safeParse({ ...ok, origin: { lat: Number.NaN, lng: 0 } }).success).toBe(false);
    expect(RouteComputeRequestSchema.safeParse({ ...ok, op_id: undefined }).success).toBe(false);
  });

  it('route yanıtı', () => {
    const r = { distance_m: 3200, duration_s: 720, polyline: '_p~iF~ps|U', cached: false, computed_at: NOW };
    expect(RouteComputeResponseSchema.parse(r)).toEqual(r);
    expect(RouteComputeResponseSchema.safeParse({ ...r, duration_s: -1 }).success).toBe(false);
  });

  it('geocode', () => {
    expect(GeocodeReverseRequestSchema.safeParse({ lat: 41, lng: 29 }).success).toBe(true);
    expect(GeocodeReverseRequestSchema.safeParse({ lat: 41, lng: 181 }).success).toBe(false);
    expect(GeocodeReverseResponseSchema.safeParse({ label: 'Moda Caddesi, Kadıköy', cell: 'sxk97b2', cached: true }).success).toBe(true);
    expect(GeocodeReverseResponseSchema.safeParse({ label: null, cell: 'sxk97b2', cached: false }).success).toBe(true);
    expect(GeocodeReverseResponseSchema.safeParse({ label: 'x', cell: 'SXK', cached: false }).success).toBe(false);
  });
});
