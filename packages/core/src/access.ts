/**
 * Faz 8: kişiden kişiye YÖNLÜ izinler (`permission_grants/{granter}_{grantee}`), bkz. docs/PHASE8.md §1–§4.
 *
 * İlkeler:
 *  - Arkadaşlık izin DEĞİLDİR. Arkadaş kabulü hiçbir izin yazmaz (`grantsOnFriendAccept() === []`); arkadaşlığın tek
 *    varsayılan hakkı karşı taraftan izin İSTEMEKtir.
 *  - İzin yönlüdür: A'nın B'ye verdiği izin, B'nin A'ya izin verdiği anlamına gelmez.
 *  - Bu dosyadaki karar fonksiyonları (`canShareLocation`, `canPing`, …) §4 matrisinin TEK kaynağıdır: backend
 *    callable'ları ve tarayıcı demosunun sahte sunucusu aynı fonksiyonları çağırır.
 *  - Bilgi sızmaz: arkadaşa "iznini geri aldı" denmez; ret push'u yoktur; ret soğumasındaki istek sessizce `sent` döner.
 *
 * Bu modül işletim sistemi izinlerinden (`permissionFlow.ts`, `PermissionKind`) AYRIDIR; ad karışmasın diye
 * kapsam tipi `AccessScope`tur.
 */
import { z } from 'zod';
import { DurationChoiceSchema } from './contracts';
import type { DurationChoice } from './duration';
import type { SessionId, UserId } from './model';
import type { OutgoingShareView } from './sharing';
import { HOUR, MINUTE, type EpochMs } from './time';

// --- kapsamlar ------------------------------------------------------------------------------

/** "granter, grantee'nin şunu yapmasına izin verir". Sıra arayüzdeki sıradır. */
export const ACCESS_SCOPES = ['location_view', 'ping', 'zone_notify', 'meetup_invite', 'sos_alert'] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

/** İstenebilen / anahtarla açılıp kapanabilen kapsamlar. `sos_alert` yalnızca `emergency_contacts_set` ile doğar. */
export const REQUESTABLE_SCOPES = ['location_view', 'ping', 'zone_notify', 'meetup_invite'] as const satisfies readonly AccessScope[];
export type RequestableScope = (typeof REQUESTABLE_SCOPES)[number];

export const AccessScopeSchema = z.enum(ACCESS_SCOPES);
export const RequestableScopeSchema = z.enum(REQUESTABLE_SCOPES);

export const GRANT_VIAS = ['request', 'manual', 'share', 'location_request', 'emergency_contact', 'migration'] as const;
/**
 * İznin nasıl doğduğu: `request` istek onayı, `manual` kişi izinleri anahtarı, `share` paylaşım başlatırken verilen
 * onay (`grant_location_view`), `location_request` konum isteğinin kabulü, `emergency_contact` acil kişi seçimi,
 * `migration` Faz 8 öncesi etkin paylaşımdan göç.
 */
export type GrantVia = (typeof GRANT_VIAS)[number];

export function isAccessScope(s: unknown): s is AccessScope {
  return typeof s === 'string' && (ACCESS_SCOPES as readonly string[]).includes(s);
}

export function isRequestableScope(s: unknown): s is RequestableScope {
  return typeof s === 'string' && (REQUESTABLE_SCOPES as readonly string[]).includes(s);
}

/** Tekilleştirir ve `ACCESS_SCOPES` sırasına dizer (bilinmeyenler düşer). */
export function normalizeScopes<S extends AccessScope>(list: readonly S[]): S[] {
  const set = new Set<string>(list);
  return ACCESS_SCOPES.filter((s) => set.has(s)) as S[];
}

// --- belge ----------------------------------------------------------------------------------

export interface ScopeGrant {
  granted_at: EpochMs;
  via: GrantVia;
}

export interface PermissionPending {
  scopes: RequestableScope[];
  requested_at: EpochMs;
  expires_at: EpochMs;
}

/**
 * `permission_grants/{granter_id}_{grantee_id}` (Firestore; okuma yalnızca iki taraf, yazma yalnızca callable).
 * Kimlik: `grantId(granter, grantee)` (ids.ts), yol: `PATHS.permissionGrant`.
 */
export interface PermissionGrantDoc {
  granter_id: UserId;
  grantee_id: UserId;
  /** Verilmiş kapsamlar. Anahtar yoksa izin yok. */
  scopes: Partial<Record<AccessScope, ScopeGrant>>;
  /** grantee'nin bekleyen isteği (granter onaylayacak). Süresi geçmişse yok sayılır (`pendingScopes`). */
  pending: PermissionPending | null;
  /** Son ret zamanı (kapsam başına), tekrar isteme soğuması için. */
  declined_at: Partial<Record<AccessScope, EpochMs>>;
  updated_at: EpochMs;
  version: number;
}

/** Karar fonksiyonlarının kabul ettiği en küçük şekil (demo ve testler kısmi nesne verebilir). */
export type GrantLike = Pick<PermissionGrantDoc, 'scopes'> | null | undefined;

/** Bekleyen isteğin ömrü. [Varsayım] */
export const PERMISSION_REQUEST_TTL_MS = 48 * HOUR;
/** Aynı çift için iki istek arasında en az (bekleyen istek varken yeni kapsam eklemek dahil). [Varsayım] */
export const PERMISSION_REQUEST_PAIR_COOLDOWN_MS = 10 * MINUTE;
/** Ret sonrası AYNI kapsam için yeniden isteme soğuması. [Varsayım] */
export const PERMISSION_REQUEST_DECLINE_COOLDOWN_MS = 24 * HOUR;
/** Kullanıcı başına günlük en çok izin isteği (`rate_limits`). [Varsayım] */
export const PERMISSION_REQUESTS_PER_DAY = 30;

export const PERMISSION_REQUEST_LIMITS = {
  ttlMs: PERMISSION_REQUEST_TTL_MS,
  pairCooldownMs: PERMISSION_REQUEST_PAIR_COOLDOWN_MS,
  declineCooldownMs: PERMISSION_REQUEST_DECLINE_COOLDOWN_MS,
  perDay: PERMISSION_REQUESTS_PER_DAY,
} as const;

/** İzin verirken "Şimdi paylaş" varsayılan süresi: 1 saat. */
export const PERMISSION_SHARE_DEFAULT: DurationChoice = { kind: 'preset', preset: 'h1' };

export function hasGrant(doc: GrantLike, scope: AccessScope): boolean {
  return doc?.scopes?.[scope] != null;
}

export function grantedScopes(doc: GrantLike): AccessScope[] {
  return ACCESS_SCOPES.filter((s) => hasGrant(doc, s));
}

/** Bekleyen, süresi geçmemiş ve henüz verilmemiş kapsamlar. Süresi geçmiş istek → []. */
export function pendingScopes(doc: Pick<PermissionGrantDoc, 'scopes' | 'pending'> | null | undefined, now: EpochMs): RequestableScope[] {
  const p = doc?.pending;
  if (!p || p.expires_at <= now) return [];
  return normalizeScopes(p.scopes.filter(isRequestableScope)).filter((s) => !hasGrant(doc, s));
}

export function inDeclineCooldown(doc: Pick<PermissionGrantDoc, 'declined_at'> | null | undefined, scope: AccessScope, now: EpochMs): boolean {
  const at = doc?.declined_at?.[scope];
  return at != null && now - at < PERMISSION_REQUEST_DECLINE_COOLDOWN_MS;
}

/**
 * Bekleyen istekte granter'ın REDDETTİĞİ (gizli) kapsamlar: ret anı isteğin anından sonra (`declined_at[s] >=
 * pending.requested_at`). `doc.declined_at` = sunucuya özel ret anları (`permission_declines`; istemci belgesinde
 * her zaman boştur, yalnızca granter'ın kendi belgelerine birleştirilir).
 *
 * Ret isteyene sızmasın diye (§8.1) reddedilen kapsam istemci belgesindeki `pending` içinde süresi dolana kadar KALIR
 * ve belge ret anında hiç yazılmaz: isteyen "bekliyor" görür. Granter'ın "İzin istekleri" kartı bu kapsamları
 * göstermez (`liveRequestScopes`).
 */
export function declinedPendingScopes(doc: Pick<PermissionGrantDoc, 'scopes' | 'pending' | 'declined_at'> | null | undefined, now: EpochMs): RequestableScope[] {
  const p = doc?.pending;
  if (!p) return [];
  return pendingScopes(doc, now).filter((s) => {
    const at = doc.declined_at?.[s];
    return at != null && at >= p.requested_at;
  });
}

/** Granter'ın yanıtlayacağı (reddetmediği) bekleyen kapsamlar. */
export function liveRequestScopes(doc: Pick<PermissionGrantDoc, 'scopes' | 'pending' | 'declined_at'> | null | undefined, now: EpochMs): RequestableScope[] {
  const hidden = declinedPendingScopes(doc, now);
  return pendingScopes(doc, now).filter((s) => !hidden.includes(s));
}

/** Arkadaş kabulünde yazılacak izinler: HİÇBİRİ (varsayılan kapalı; testle sabitlenir). */
export function grantsOnFriendAccept(): readonly AccessScope[] {
  return [];
}

/** Firestore'dan okunan ham belgeyi hoşgörülü ayrıştırır: bilinmeyen kapsamlar düşer, bozuk belge → null. */
export function parsePermissionGrantDoc(raw: unknown): PermissionGrantDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.granter_id !== 'string' || typeof r.grantee_id !== 'string') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const scopes: Partial<Record<AccessScope, ScopeGrant>> = {};
  const rawScopes = r.scopes && typeof r.scopes === 'object' ? (r.scopes as Record<string, unknown>) : {};
  for (const s of ACCESS_SCOPES) {
    const g = rawScopes[s] as Record<string, unknown> | undefined;
    if (!g || typeof g !== 'object') continue;
    const via = (GRANT_VIAS as readonly string[]).includes(g.via as string) ? (g.via as GrantVia) : 'manual';
    scopes[s] = { granted_at: num(g.granted_at) ?? 0, via };
  }
  const declined_at: Partial<Record<AccessScope, EpochMs>> = {};
  const rawDeclined = r.declined_at && typeof r.declined_at === 'object' ? (r.declined_at as Record<string, unknown>) : {};
  for (const s of ACCESS_SCOPES) {
    const at = num(rawDeclined[s]);
    if (at !== null) declined_at[s] = at;
  }
  let pending: PermissionPending | null = null;
  const p = r.pending as Record<string, unknown> | null | undefined;
  if (p && typeof p === 'object' && Array.isArray(p.scopes)) {
    const requested_at = num(p.requested_at);
    const expires_at = num(p.expires_at);
    const ps = normalizeScopes((p.scopes as unknown[]).filter(isRequestableScope));
    if (requested_at !== null && expires_at !== null && ps.length) pending = { scopes: ps, requested_at, expires_at };
  }
  return {
    granter_id: r.granter_id,
    grantee_id: r.grantee_id,
    scopes,
    pending,
    declined_at,
    updated_at: num(r.updated_at) ?? 0,
    version: num(r.version) ?? 0,
  };
}

// --- saf belge geçişleri (backend ve demo aynı geçişi uygular) -------------------------------

export function emptyGrantDoc(granterId: UserId, granteeId: UserId, now: EpochMs): PermissionGrantDoc {
  return { granter_id: granterId, grantee_id: granteeId, scopes: {}, pending: null, declined_at: {}, updated_at: now, version: 0 };
}

const bump = (doc: PermissionGrantDoc, now: EpochMs, patch: Partial<PermissionGrantDoc>): PermissionGrantDoc => ({
  ...doc,
  ...patch,
  updated_at: now,
  version: doc.version + 1,
});

/** Kapsamları verir (zaten verilmiş olanın `granted_at`/`via` değeri korunur); bekleyen istekten düşer. */
export function withGranted(doc: PermissionGrantDoc, scopes: readonly AccessScope[], via: GrantVia, now: EpochMs): PermissionGrantDoc {
  const next = { ...doc.scopes };
  for (const s of normalizeScopes(scopes)) next[s] ??= { granted_at: now, via };
  const left = doc.pending ? doc.pending.scopes.filter((s) => next[s] == null) : [];
  const pending = doc.pending && left.length ? { ...doc.pending, scopes: left } : null;
  return bump(doc, now, { scopes: next, pending });
}

/** Kapsamları kaldırır. Zincirleme temizlik için `REVOKE_EFFECTS`. */
export function withRevoked(doc: PermissionGrantDoc, scopes: readonly AccessScope[], now: EpochMs): PermissionGrantDoc {
  const next = { ...doc.scopes };
  for (const s of scopes) delete next[s];
  return bump(doc, now, { scopes: next });
}

/** Bekleyen isteği yazar (`planPermissionRequest` → `send` sonucunun birleşik kapsamlarıyla). */
export function withPendingRequest(doc: PermissionGrantDoc, scopes: readonly RequestableScope[], now: EpochMs): PermissionGrantDoc {
  return bump(doc, now, { pending: { scopes: normalizeScopes(scopes), requested_at: now, expires_at: now + PERMISSION_REQUEST_TTL_MS } });
}

export interface PermissionResponseResult {
  /**
   * Yeni belge. Yalnızca bir şey VERİLDİYSE değişir (kapsam eklenir, verilen bekleyen istekten düşer; reddedilenler
   * `pending` içinde kalır). Hiçbir şey verilmediyse (salt ret) belge AYNEN kalır (sürüm / zaman damgası dahil):
   * isteyen ret anında hiçbir değişiklik görmez. `declined_at` = sunucuya özel ret anlarının yeni hâli.
   */
  doc: PermissionGrantDoc;
  /** Verilen kapsamlar (`grant ∩ live`). */
  granted: RequestableScope[];
  /** Reddedilen kapsamlar (`live − grant`); ret anları `doc.declined_at`ta (yalnızca sunucuya özel kayda yazılır). */
  declined: RequestableScope[];
}

/**
 * `permission_request_respond`: granter'ın görüp yanıtladığı (`liveRequestScopes`) kapsamlardan `grantScopes` ile
 * kesişen verilir, geri kalanı reddedilir. Boş dizi = ret. Bekleyen istek yoksa / süresi geçtiyse / hepsi zaten
 * reddedildiyse hiçbir şey değişmez (`granted`/`declined` boş, belge aynı). `doc.declined_at` sunucu ret anlarıyla
 * birleşik verilmelidir.
 */
export function withResponse(
  doc: PermissionGrantDoc,
  grantScopes: readonly RequestableScope[],
  now: EpochMs,
  via: GrantVia = 'request',
): PermissionResponseResult {
  const live = liveRequestScopes(doc, now);
  if (!live.length) return { doc, granted: [], declined: [] };
  const want = new Set<string>(grantScopes);
  const granted = live.filter((s) => want.has(s));
  const declined = live.filter((s) => !want.has(s));
  const declined_at = { ...doc.declined_at };
  for (const s of declined) declined_at[s] = now;
  if (!granted.length) return { doc: { ...doc, declined_at }, granted, declined };
  const scopes = { ...doc.scopes };
  for (const s of granted) scopes[s] ??= { granted_at: now, via };
  const left = doc.pending ? doc.pending.scopes.filter((s) => scopes[s] == null) : [];
  const pending = doc.pending && left.length ? { ...doc.pending, scopes: left } : null;
  return { doc: bump(doc, now, { scopes, pending, declined_at }), granted, declined };
}

export type PermissionRequestPlan =
  /** İstenen kapsamların hepsi zaten verilmiş: yanıt `already_granted`, yazma / push yok. */
  | { kind: 'already_granted' }
  /** Aynı çift için 10 dk dolmadı ve bekleyen isteğe yeni kapsam eklenecekti: `permission_cooldown`. */
  | { kind: 'cooldown' }
  /** İstenenlerin hepsi isteyenin gördüğü bekleyen istekte zaten var: yanıt yine `sent`, yazma / push YOK. */
  | { kind: 'noop' }
  /**
   * Bekleyen isteği `scopes` (eski + yeni birleşik) ile yaz (`withPendingRequest`). `hidden` granter'a gösterilmeyecek
   * kapsamlardır (önceden reddedilmiş ya da ret soğumasında): sunucuya özel ret anları yeni istek anına taşınır, isteyen
   * yine "bekliyor" görür. `added` boş değilse granter'a `live` kapsamlarla push gider; boşsa push YOK. Ret soğuması
   * ve ret isteyene hiçbir yoldan sızmaz: yazma, çift soğuması ve günlük sınır her iki durumda da aynıdır.
   */
  | { kind: 'send'; scopes: RequestableScope[]; added: RequestableScope[]; hidden: RequestableScope[]; live: RequestableScope[] };

/**
 * `permission_request_send` kararı (`doc` = permission_grants/{target}_{requester}, yani hedef = granter; `declined_at`
 * sunucuya özel ret anlarıyla birleşik). Arkadaşlık + engel + onay ve günlük sınır (`PERMISSION_REQUESTS_PER_DAY`)
 * çağıranın işidir.
 */
export function planPermissionRequest(
  doc: PermissionGrantDoc | null | undefined,
  requested: readonly RequestableScope[],
  now: EpochMs,
): PermissionRequestPlan {
  const wanted = normalizeScopes(requested.filter(isRequestableScope)).filter((s) => !hasGrant(doc, s));
  if (!wanted.length) return { kind: 'already_granted' };
  const pending = pendingScopes(doc, now);
  const fresh = wanted.filter((s) => !pending.includes(s));
  if (!fresh.length) return { kind: 'noop' };
  if (pending.length && doc?.pending && now - doc.pending.requested_at < PERMISSION_REQUEST_PAIR_COOLDOWN_MS) return { kind: 'cooldown' };
  const cooling = fresh.filter((s) => inDeclineCooldown(doc, s, now));
  const added = fresh.filter((s) => !cooling.includes(s));
  const scopes = normalizeScopes([...pending, ...fresh]);
  const hidden = normalizeScopes([...declinedPendingScopes(doc, now), ...cooling]);
  return { kind: 'send', scopes, added, hidden, live: scopes.filter((s) => !hidden.includes(s)) };
}

// --- §4 etkileşim matrisi (X → Y) -----------------------------------------------------------

/**
 * Bir çiftin (X = eylemi yapan, Y = karşı taraf) sunucuda bilinen durumu.
 *  - `friend`: kabul edilmiş arkadaşlık VE iki yönde de engel yok.
 *  - `grantXtoY`: X'in Y'ye verdiği izin belgesi (`permission_grants/{X}_{Y}`).
 *  - `grantYtoX`: Y'nin X'e verdiği izin belgesi (`permission_grants/{Y}_{X}`).
 *  - `invisibleX`: X görünmez modda. `consentX`: X güncel onay sürümünü kabul etmiş.
 */
export interface PairAccessInput {
  friend: boolean;
  grantXtoY: GrantLike;
  grantYtoX: GrantLike;
  invisibleX: boolean;
  consentX: boolean;
}

/** Canlı paylaşım X→Y (share_start, share_extend, widget, bölge start_share, konum isteği kabulü, görünür olunca geri yükleme). */
export function canShareLocation(i: Pick<PairAccessInput, 'friend' | 'grantXtoY' | 'invisibleX' | 'consentX'>): boolean {
  return i.friend && hasGrant(i.grantXtoY, 'location_view') && !i.invisibleX && i.consentX;
}

/** Ping X→Y: alıcının (Y) izni gerekir. */
export function canPing(i: Pick<PairAccessInput, 'friend' | 'grantYtoX' | 'consentX'>): boolean {
  return i.friend && hasGrant(i.grantYtoX, 'ping') && i.consentX;
}

/** Ping'e X'in konumu eklenebilir mi? Değilse konum SESSİZCE çıkarılır (ping yine gider). */
export function pingLocationAllowed(i: Pick<PairAccessInput, 'grantXtoY' | 'invisibleX'>): boolean {
  return hasGrant(i.grantXtoY, 'location_view') && !i.invisibleX;
}

/**
 * X'in bölge (varış/ayrılış) olayı Y'ye bildirilebilir mi? Alıcının (Y) izni gerekir. X görünmezse olay hiç
 * gönderilmez (`suppressed:'invisible'`): bunu olay başında `invisibleX` ile ayrıca denetle.
 */
export function canZoneNotify(i: Pick<PairAccessInput, 'friend' | 'grantYtoX'>): boolean {
  return i.friend && hasGrant(i.grantYtoX, 'zone_notify');
}

/** Buluşma daveti X→Y: alıcının (Y) izni gerekir. */
export function canInvite(i: Pick<PairAccessInput, 'friend' | 'grantYtoX'>): boolean {
  return i.friend && hasGrant(i.grantYtoX, 'meetup_invite');
}

/** Buluşmada X'in varış süresi (ETA) Y'ye gösterilebilir mi? Değilse X'in ETA'sı Y için çıkarılır. */
export function meetupEtaAllowed(i: Pick<PairAccessInput, 'grantXtoY' | 'invisibleX'>): boolean {
  return hasGrant(i.grantXtoY, 'location_view') && !i.invisibleX;
}

/** X'in yer notunun `visible_to` listesinde Y olabilir mi? */
export function noteAudienceAllowed(i: Pick<PairAccessInput, 'grantXtoY'>): boolean {
  return hasGrant(i.grantXtoY, 'location_view');
}

/** SOS X→Y: X'in acil kişi seçimi (`sos_alert`). Görünmez mod SOS'u ENGELLEMEZ. */
export function canSendSos(i: Pick<PairAccessInput, 'friend' | 'grantXtoY'>): boolean {
  return i.friend && hasGrant(i.grantXtoY, 'sos_alert');
}

/** İzin isteği X→Y (soğuma ve günlük sınır ayrıca: `planPermissionRequest`). */
export function canRequestPermission(i: Pick<PairAccessInput, 'friend' | 'consentX'>): boolean {
  return i.friend && i.consentX;
}

/**
 * İzin geri alınınca (ya da belge silinince) zincirleme temizlik, granter = G, grantee = E:
 *  - `location_view`: G→E paylaşımları `stopped_by_sender` ile biter; E, G'nin yer notu `visible_to` listesinden, G'nin
 *    bölge `start_share` kurallarından ve G'nin `favorite_ids` listesinden çıkar.
 *  - `zone_notify`: G, E'nin bölge `notify` kurallarının alıcılarından çıkar.
 *  - `ping`, `meetup_invite`: yalnızca yeni etkileşim engellenir; geçmiş kayıtlar kalır.
 *  - `sos_alert`: yalnızca `emergency_contacts_set` ile değişir.
 */
export type RevokeEffect = 'end_shares' | 'remove_from_note_audience' | 'remove_from_zone_start_share' | 'remove_from_favorites' | 'remove_from_zone_notify';

export const REVOKE_EFFECTS: Record<AccessScope, readonly RevokeEffect[]> = {
  location_view: ['end_shares', 'remove_from_note_audience', 'remove_from_zone_start_share', 'remove_from_favorites'],
  ping: [],
  zone_notify: ['remove_from_zone_notify'],
  meetup_invite: [],
  sos_alert: [],
};

// --- istemci görünümleri ----------------------------------------------------------------------

/** Benim belgelerim: `given` = benim verdiklerim (granter = ben), `received` = bana verilenler (grantee = ben). */
export function splitGrants(
  docs: readonly PermissionGrantDoc[],
  me: UserId,
): { given: Record<UserId, PermissionGrantDoc>; received: Record<UserId, PermissionGrantDoc> } {
  const given: Record<UserId, PermissionGrantDoc> = {};
  const received: Record<UserId, PermissionGrantDoc> = {};
  for (const d of docs) {
    if (d.granter_id === me && d.grantee_id !== me) given[d.grantee_id] = d;
    else if (d.grantee_id === me && d.granter_id !== me) received[d.granter_id] = d;
  }
  return { given, received };
}

export interface IncomingPermissionRequest {
  requester_id: UserId;
  scopes: RequestableScope[];
  requested_at: EpochMs;
  expires_at: EpochMs;
}

/**
 * "İzin istekleri" kartı: bana gelen, süresi geçmemiş ve reddetmediğim istekler, en yenisi önce. Reddedilen kapsamlar
 * için belgeye benim ret anlarım (`permission_declines`, yalnızca granter okur) birleştirilmiş olmalıdır.
 */
export function incomingPermissionRequests(docs: readonly PermissionGrantDoc[], me: UserId, now: EpochMs): IncomingPermissionRequest[] {
  const out: IncomingPermissionRequest[] = [];
  for (const d of docs) {
    if (d.granter_id !== me || !d.pending) continue;
    const scopes = liveRequestScopes(d, now);
    if (scopes.length) out.push({ requester_id: d.grantee_id, scopes, requested_at: d.pending.requested_at, expires_at: d.pending.expires_at });
  }
  return out.sort((a, b) => b.requested_at - a.requested_at);
}

/** Arkadaş satırındaki yön durumu (yalnızca `location_view`). */
export type PairAccess = 'none' | 'they_see_me' | 'i_see_them' | 'mutual';

export const PAIR_ACCESS_TEXT: Record<PairAccess, string> = {
  none: 'Karşılıklı kapalı',
  they_see_me: 'O seni görebilir',
  i_see_them: 'Sen onu görebilirsin',
  mutual: 'Karşılıklı',
};

export function pairAccessSummary(myGrantToThem: GrantLike, theirGrantToMe: GrantLike): PairAccess {
  const theySee = hasGrant(myGrantToThem, 'location_view');
  const iSee = hasGrant(theirGrantToMe, 'location_view');
  if (theySee && iSee) return 'mutual';
  if (theySee) return 'they_see_me';
  if (iSee) return 'i_see_them';
  return 'none';
}

// --- metinler -------------------------------------------------------------------------------

export interface AccessScopeText {
  /** Kısa ad (liste, push gövdesi): "konumunu görme". */
  short: string;
  /** Benim verdiğim yön (Kişi izinleri > "Senin verdiğin izinler" anahtarı). */
  given: { title: string; description: string };
  /** Bana verilen yön ("Onun sana verdiği izinler", salt okunur). */
  received: { title: string; description: string };
}

export const ACCESS_SCOPE_TEXT: Record<AccessScope, AccessScopeText> = {
  location_view: {
    short: 'konumunu görme',
    given: { title: 'Konumumu görebilir', description: 'Sen paylaşım başlattığında canlı konumunu görür. Paylaşım kendiliğinden başlamaz.' },
    received: { title: 'Konumunu görebilirsin', description: 'O paylaşım başlattığında canlı konumunu görürsün.' },
  },
  ping: {
    short: 'ping',
    given: { title: 'Bana ping gönderebilir', description: 'Sana “Buradayım” ya da “Yoldayım” gönderebilir.' },
    received: { title: 'Ona ping gönderebilirsin', description: 'Ona “Buradayım” ya da “Yoldayım” gönderebilirsin.' },
  },
  zone_notify: {
    short: 'varış / ayrılış bildirimi',
    given: { title: 'Bana varış bildirimi gönderebilir', description: 'Bir yere vardığında ya da ayrıldığında sana bildirim gelebilir.' },
    received: { title: 'Ona varış bildirimi gönderebilirsin', description: 'Bölgelerine vardığında ya da ayrıldığında ona bildirim gidebilir.' },
  },
  meetup_invite: {
    short: 'buluşma daveti',
    given: { title: 'Beni buluşmaya davet edebilir', description: 'Sana buluşma noktası önerisi gönderebilir.' },
    received: { title: 'Onu buluşmaya davet edebilirsin', description: 'Ona buluşma noktası önerisi gönderebilirsin.' },
  },
  sos_alert: {
    short: 'SOS uyarısı',
    given: { title: 'SOS uyarılarımı alır', description: 'Acil durumda tam konumunla uyarı alır. Acil durum kişilerinden değiştirilir.' },
    received: { title: 'SOS uyarılarını alırsın', description: 'Acil durumda tam konumuyla sana uyarı gelir.' },
  },
};

export const ACCESS_TEXT = {
  requestsCardTitle: 'İzin istekleri',
  grantAction: 'İzin ver…',
  declineAction: 'Reddet',
  requestAction: 'İzin iste',
  requestSent: 'İzin isteği gönderildi',
  alreadyGranted: 'Bu izin zaten var',
  personPermissionsTitle: 'Kişi izinleri',
  givenTitle: 'Senin verdiğin izinler',
  receivedTitle: 'Onun sana verdiği izinler',
  shareNowTitle: 'Şimdi paylaş',
  grantOnlyOption: 'Yalnızca izin ver, şimdi paylaşma',
  reverseHint: 'Sen de onun konumunu görmek istersen ayrıca izin iste.',
  friendAcceptedHint: 'Arkadaş olmanız konumunuzu açmaz.',
  noGrantBadge: 'izin yok',
  grantOnShareConfirm: 'Konumunu görme izni de verilecek',
  pickerNoGrantHint: 'Bu kişi sana bu izni vermedi.',
} as const;

/** "Can senden konumunu görmek istiyor" · "Can senden izin istiyor: ping, buluşma daveti". */
export function permissionRequestText(name: string, scopes: readonly AccessScope[]): string {
  const list = normalizeScopes(scopes);
  if (list.length === 1 && list[0] === 'location_view') return `${name} senden konumunu görmek istiyor`;
  return `${name} senden izin istiyor: ${list.map((s) => ACCESS_SCOPE_TEXT[s].short).join(', ')}`;
}

/** İsteyene giden push: "Can konumunu görmene izin verdi" · "Can sana izin verdi: ping". */
export function permissionGrantedText(name: string, scopes: readonly AccessScope[]): string {
  const list = normalizeScopes(scopes);
  if (list.length === 1 && list[0] === 'location_view') return `${name} konumunu görmene izin verdi`;
  return `${name} sana izin verdi: ${list.map((s) => ACCESS_SCOPE_TEXT[s].short).join(', ')}`;
}

// --- callable şemaları --------------------------------------------------------------------------

const opId = z.uuid();
const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const requestableList = z.array(RequestableScopeSchema).max(REQUESTABLE_SCOPES.length * 2).transform((l) => normalizeScopes(l));

/** `permission_request_send`: arkadaş + engel yok + onay şart. Yanıt her zaman `sent` | `already_granted`. */
export const PermissionRequestSendSchema = z.object({
  op_id: opId,
  target_id: uid,
  scopes: z.array(RequestableScopeSchema).min(1).max(REQUESTABLE_SCOPES.length).transform((l) => normalizeScopes(l)),
});
export type PermissionRequestSendRequest = z.input<typeof PermissionRequestSendSchema>;

export interface PermissionRequestSendResponse {
  status: 'sent' | 'already_granted';
  server_now: EpochMs;
}

/**
 * `permission_request_respond` (çağıran = granter). `share` varsa ve `location_view` verildiyse ve görünmez değilse
 * aynı işlemde granter→requester paylaşımı başlar.
 */
export const PermissionRequestRespondSchema = z.object({
  op_id: opId,
  requester_id: uid,
  grant_scopes: requestableList,
  share: z
    .object({
      duration: DurationChoiceSchema,
      /** IANA saat dilimi (gün sonu hesabı için). */
      time_zone: z.string().min(1).max(64),
    })
    .nullable()
    .default(null),
});
export type PermissionRequestRespondRequest = z.input<typeof PermissionRequestRespondSchema>;

export interface PermissionRequestRespondResponse {
  granted_scopes: RequestableScope[];
  declined_scopes: RequestableScope[];
  /** Aynı işlemde başlayan paylaşım; `share` istenmediyse / başlatılamadıysa null. */
  share: { session_id: SessionId; shares: OutgoingShareView[] } | null;
  /** `share` istendi ama başlamadıysa neden (yalnızca çağırana): görünmez mod ya da konum izni verilmedi. */
  share_skipped: 'invisible' | 'no_location_view' | null;
  server_now: EpochMs;
}

/** `permission_set`: granter'ın doğrudan anahtarı. Açmak arkadaşlık + onay ister; kapatmak her zaman çalışır. */
export const PermissionSetSchema = z.object({
  op_id: opId,
  grantee_id: uid,
  scope: RequestableScopeSchema,
  granted: z.boolean(),
});
export type PermissionSetRequest = z.input<typeof PermissionSetSchema>;

export interface PermissionSetResponse {
  grantee_id: UserId;
  /** İşlemden sonra bu kişiye verdiğim kapsamların tamamı. */
  scopes: AccessScope[];
  server_now: EpochMs;
}
