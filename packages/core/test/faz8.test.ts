import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_SCOPE_TEXT,
  CALLABLES,
  canInvite,
  canPing,
  canRequestPermission,
  canSendSos,
  canShareLocation,
  canZoneNotify,
  CONSENT_DOCUMENT,
  CONSENT_PLACEHOLDERS,
  CONSENT_TEXT,
  CONSENT_TEXT_SHA256,
  CONSENT_TITLE,
  CONSENT_VERSION,
  ConsentAcceptRequestSchema,
  consentExemptCall,
  clientConsentRequired,
  consentNewerThanApp,
  consentRequired,
  emptyGrantDoc,
  ERROR_CODES,
  grantId,
  grantsOnFriendAccept,
  incomingPermissionRequests,
  INVISIBLE_TEXT,
  InvisibleSetRequestSchema,
  isCurrentConsent,
  isScrolledToBottom,
  meetupEtaAllowed,
  noteAudienceAllowed,
  pairAccessSummary,
  PAIR_ACCESS_TEXT,
  PATHS,
  pendingScopes,
  PERMISSION_REQUEST_TTL_MS,
  PermissionRequestRespondSchema,
  PermissionRequestSendSchema,
  PermissionSetSchema,
  permissionRequestText,
  pingLocationAllowed,
  planInvisibleOn,
  planInvisibleRestore,
  planPermissionRequest,
  liveRequestScopes,
  declinedPendingScopes,
  PUSH_TYPES_F8,
  resolveDuration,
  restorableEntries,
  restoreDuration,
  REVOKE_EFFECTS,
  ShareStartRequestSchema,
  withGranted,
  withPendingRequest,
  withResponse,
  withRevoked,
  type InvisibleSnapshotEntry,
  type PermissionGrantDoc,
} from '../src';

const NOW = 1_764_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const OP = '7f8a3c2e-1b4d-4e5f-9a6b-0c1d2e3f4a5b';

/** A'nın B'ye verdiği izin belgesi. */
const grant = (granter: string, grantee: string, scopes: PermissionGrantDoc['scopes'] = {}): PermissionGrantDoc => ({
  ...emptyGrantDoc(granter, grantee, NOW),
  scopes,
});
const LV = { location_view: { granted_at: NOW, via: 'request' as const } };

describe('Faz 8 izinler: yön ve varsayılan kapalı', () => {
  it('A→B izni B→A yetkisi doğurmaz; belge kimliği yönlüdür', () => {
    expect(grantId('a', 'b')).toBe('a_b');
    expect(grantId('b', 'a')).toBe('b_a');
    expect(() => grantId('a', 'a')).toThrow();
    expect(PATHS.permissionGrant('a', 'b')).toBe('permission_grants/a_b');

    const aToB = grant('a', 'b', LV);
    // A, B'ye konumunu gösterebilir…
    expect(canShareLocation({ friend: true, grantXtoY: aToB, invisibleX: false, consentX: true })).toBe(true);
    // …ama B, A'ya gösteremez (ters yönde belge yok); A'nın izni B'nin konumunu açmaz.
    expect(canShareLocation({ friend: true, grantXtoY: null, invisibleX: false, consentX: true })).toBe(false);
    expect(pairAccessSummary(aToB, null)).toBe('they_see_me'); // A'nın bakışı
    expect(pairAccessSummary(null, aToB)).toBe('i_see_them'); // B'nin bakışı
    expect(pairAccessSummary(aToB, grant('b', 'a', LV))).toBe('mutual');
    expect(PAIR_ACCESS_TEXT).toEqual({
      none: 'Karşılıklı kapalı',
      they_see_me: 'O seni görebilir',
      i_see_them: 'Sen onu görebilirsin',
      mutual: 'Karşılıklı',
    });

    // Tek taraflı onay: B'nin isteğini A onaylar → yalnızca A→B belgesi değişir.
    const pending = withPendingRequest(emptyGrantDoc('a', 'b', NOW), ['location_view'], NOW);
    const r = withResponse(pending, ['location_view'], NOW + MIN);
    expect(r.doc.granter_id).toBe('a');
    expect(r.doc.grantee_id).toBe('b');
    expect(r.granted).toEqual(['location_view']);
  });

  it('arkadaş kabulü hiçbir izin yazmaz; izinsiz arkadaş hiçbir şey yapamaz', () => {
    expect(grantsOnFriendAccept()).toEqual([]);
    const none = { friend: true, grantXtoY: null, grantYtoX: emptyGrantDoc('y', 'x', NOW), invisibleX: false, consentX: true };
    expect(canShareLocation(none)).toBe(false);
    expect(canPing(none)).toBe(false);
    expect(canZoneNotify(none)).toBe(false);
    expect(canInvite(none)).toBe(false);
    expect(canSendSos(none)).toBe(false);
    expect(noteAudienceAllowed(none)).toBe(false);
    expect(pairAccessSummary(null, undefined)).toBe('none');
    // Tek varsayılan hak: izin istemek (onay şart).
    expect(canRequestPermission(none)).toBe(true);
    expect(canRequestPermission({ friend: true, consentX: false })).toBe(false);
    expect(canRequestPermission({ friend: false, consentX: true })).toBe(false);
  });
});

describe('Faz 8 etkileşim matrisi (§4)', () => {
  const full: PermissionGrantDoc['scopes'] = {
    location_view: { granted_at: NOW, via: 'manual' },
    ping: { granted_at: NOW, via: 'manual' },
    zone_notify: { granted_at: NOW, via: 'manual' },
    meetup_invite: { granted_at: NOW, via: 'manual' },
    sos_alert: { granted_at: NOW, via: 'emergency_contact' },
  };

  it('alıcının izni gereken etkileşimler g(Y→X) ile, sahibin izni gerekenler g(X→Y) ile karar verir', () => {
    const xToY = grant('x', 'y', full);
    const yToX = grant('y', 'x', full);
    // Ping / bölge / davet yalnızca alıcının (Y) verdiği izinle.
    expect(canPing({ friend: true, grantYtoX: yToX, consentX: true })).toBe(true);
    // Y yalnızca konum izni verdiyse X ping atamaz (X'in kendi ping izni de işe yaramaz).
    expect(canPing({ friend: true, grantYtoX: grant('y', 'x', LV), consentX: true })).toBe(false);
    expect(canPing({ friend: true, grantYtoX: yToX, consentX: false })).toBe(false);
    expect(canZoneNotify({ friend: true, grantYtoX: yToX })).toBe(true);
    expect(canInvite({ friend: true, grantYtoX: yToX })).toBe(true);
    expect(canInvite({ friend: false, grantYtoX: yToX })).toBe(false);
    // Konum ve SOS yalnızca sahibin (X) verdiği izinle.
    expect(canSendSos({ friend: true, grantXtoY: xToY })).toBe(true);
    expect(canSendSos({ friend: true, grantXtoY: grant('x', 'y', LV) })).toBe(false);
    expect(meetupEtaAllowed({ grantXtoY: xToY, invisibleX: false })).toBe(true);
    expect(meetupEtaAllowed({ grantXtoY: null, invisibleX: false })).toBe(false);
    // Onaysız paylaşım yok; arkadaşlık bitince izin belgesi tek başına yetmez.
    expect(canShareLocation({ friend: true, grantXtoY: xToY, invisibleX: false, consentX: false })).toBe(false);
    expect(canShareLocation({ friend: false, grantXtoY: xToY, invisibleX: false, consentX: true })).toBe(false);
  });

  it('görünmez mod: paylaşım, ping konumu ve ETA kapanır; ping ve SOS yine gider', () => {
    const xToY = grant('x', 'y', full);
    const yToX = grant('y', 'x', full);
    expect(canShareLocation({ friend: true, grantXtoY: xToY, invisibleX: true, consentX: true })).toBe(false);
    expect(pingLocationAllowed({ grantXtoY: xToY, invisibleX: true })).toBe(false);
    expect(pingLocationAllowed({ grantXtoY: xToY, invisibleX: false })).toBe(true);
    expect(pingLocationAllowed({ grantXtoY: grant('x', 'y'), invisibleX: false })).toBe(false);
    expect(meetupEtaAllowed({ grantXtoY: xToY, invisibleX: true })).toBe(false);
    expect(canPing({ friend: true, grantYtoX: yToX, consentX: true })).toBe(true);
    expect(canSendSos({ friend: true, grantXtoY: xToY })).toBe(true);
  });

  it('geri alma zinciri ve belge geçişleri', () => {
    expect(REVOKE_EFFECTS.location_view).toContain('end_shares');
    expect(REVOKE_EFFECTS.location_view).toContain('remove_from_favorites');
    expect(REVOKE_EFFECTS.zone_notify).toEqual(['remove_from_zone_notify']);
    expect(REVOKE_EFFECTS.ping).toEqual([]);
    const d1 = withGranted(emptyGrantDoc('x', 'y', NOW), ['location_view', 'ping'], 'manual', NOW);
    expect(d1.version).toBe(1);
    const d2 = withRevoked(d1, ['location_view'], NOW + MIN);
    expect(Object.keys(d2.scopes)).toEqual(['ping']);
    expect(d2.version).toBe(2);
    // granted_at korunur (yeniden vermek eski kaydı ezmez)
    expect(withGranted(d1, ['ping'], 'request', NOW + HOUR).scopes.ping).toEqual({ granted_at: NOW, via: 'manual' });
  });
});

describe('Faz 8 izin istekleri: bekleme süresi ve soğuma', () => {
  it('süresi geçen istek bekleyen sayılmaz', () => {
    const d = withPendingRequest(emptyGrantDoc('me', 'can', NOW), ['location_view', 'ping'], NOW);
    expect(d.pending?.expires_at).toBe(NOW + PERMISSION_REQUEST_TTL_MS);
    expect(PERMISSION_REQUEST_TTL_MS).toBe(48 * HOUR);
    expect(pendingScopes(d, NOW + HOUR)).toEqual(['location_view', 'ping']);
    expect(pendingScopes(d, NOW + PERMISSION_REQUEST_TTL_MS)).toEqual([]);
    expect(incomingPermissionRequests([d], 'me', NOW + HOUR)).toHaveLength(1);
    expect(incomingPermissionRequests([d], 'me', NOW + 49 * HOUR)).toEqual([]);
    // İsteyenin listesinde görünmez (granter = me olanlar gelen istektir).
    expect(incomingPermissionRequests([d], 'can', NOW + HOUR)).toEqual([]);
    expect(permissionRequestText('Can', ['location_view'])).toBe('Can senden konumunu görmek istiyor');
    // Süresi geçen isteğe yanıt hiçbir şey vermez.
    expect(withResponse(d, ['location_view'], NOW + 49 * HOUR).granted).toEqual([]);
  });

  it('planPermissionRequest: verilmişler düşer, bekleyene birleşir, 10 dk soğuma, ret sessizce yutulur', () => {
    expect(planPermissionRequest(grant('t', 'r', LV), ['location_view'], NOW)).toEqual({ kind: 'already_granted' });
    expect(planPermissionRequest(null, ['ping', 'location_view'], NOW)).toEqual({
      kind: 'send',
      scopes: ['location_view', 'ping'],
      added: ['location_view', 'ping'],
      hidden: [],
      live: ['location_view', 'ping'],
    });
    const pending = withPendingRequest(emptyGrantDoc('t', 'r', NOW), ['location_view'], NOW);
    expect(planPermissionRequest(pending, ['location_view'], NOW + MIN)).toEqual({ kind: 'noop' });
    expect(planPermissionRequest(pending, ['ping'], NOW + 5 * MIN)).toEqual({ kind: 'cooldown' });
    expect(planPermissionRequest(pending, ['ping'], NOW + 11 * MIN)).toEqual({
      kind: 'send',
      scopes: ['location_view', 'ping'],
      added: ['ping'],
      hidden: [],
      live: ['location_view', 'ping'],
    });
  });

  it('ret isteyene sızmaz: reddedilen kapsam istemci belgesinde süresi dolana kadar bekler, granter kartında görünmez', () => {
    const req = withPendingRequest(emptyGrantDoc('t', 'r', NOW), ['location_view', 'ping'], NOW);
    // Kısmi onay: verilen bekleyenden düşer, reddedilen `pending` içinde kalır (aynı istek anı ve bitişle).
    const r = withResponse(req, ['ping'], NOW + MIN);
    expect(r).toMatchObject({ granted: ['ping'], declined: ['location_view'] });
    expect(r.doc.pending).toEqual({ ...req.pending, scopes: ['location_view'] });
    expect(r.doc.declined_at.location_view).toBe(NOW + MIN);
    // İsteyenin gördüğü belge (ret anları boş): hâlâ bekliyor. Granter'ın kartı (ret anları birleşik): istek yok.
    const asRequester = { ...r.doc, declined_at: {} };
    expect(pendingScopes(asRequester, NOW + 2 * MIN)).toEqual(['location_view']);
    expect(liveRequestScopes(r.doc, NOW + 2 * MIN)).toEqual([]);
    expect(declinedPendingScopes(r.doc, NOW + 2 * MIN)).toEqual(['location_view']);
    expect(incomingPermissionRequests([r.doc], 't', NOW + 2 * MIN)).toEqual([]);
    // Yeniden istemek: zaten "bekliyor" → noop (yanıt yine `sent`); süresi dolunca ve soğuma bitince gerçek istek.
    expect(planPermissionRequest(r.doc, ['location_view'], NOW + 2 * HOUR)).toEqual({ kind: 'noop' });
    expect(planPermissionRequest(r.doc, ['location_view'], NOW + 25 * HOUR)).toEqual({ kind: 'noop' });
    expect(planPermissionRequest(r.doc, ['location_view'], NOW + 49 * HOUR)).toMatchObject({ kind: 'send', added: ['location_view'], hidden: [] });

    // Salt ret: istemci belgesi HİÇ değişmez (sürüm / zaman damgası dahil); yalnızca sunucuya özel ret anları.
    const d = withResponse(req, [], NOW + MIN);
    expect(d.declined).toEqual(['location_view', 'ping']);
    expect({ ...d.doc, declined_at: {} }).toEqual(req);
    expect(withResponse(d.doc, ['location_view'], NOW + 2 * MIN)).toMatchObject({ granted: [], declined: [] });

    // İstek süresi dolduktan sonra, ret soğumasında yeniden istemek: yine yazılır (isteyen "bekliyor" görür) ama
    // granter'a gizli kalır ve push gitmez (`added` boş).
    const late = withResponse(req, [], NOW + 47 * HOUR);
    const plan = planPermissionRequest(late.doc, ['location_view'], NOW + 49 * HOUR);
    expect(plan).toEqual({ kind: 'send', scopes: ['location_view'], added: [], hidden: ['location_view'], live: [] });
    // Gizli kapsamın ret anı yeni istek anına taşınınca kartta görünmez.
    const at = NOW + 49 * HOUR;
    const next = { ...withPendingRequest(late.doc, ['location_view'], at), declined_at: { ...late.doc.declined_at, location_view: at } };
    expect(incomingPermissionRequests([next], 't', at + MIN)).toEqual([]);
    const nextAsRequester = { ...next, declined_at: {} };
    expect(pendingScopes(nextAsRequester, at + MIN)).toEqual(['location_view']);
  });

  it('şemalar: sos_alert istenemez, kapsamlar tekilleşir, ret = boş dizi', () => {
    expect(PermissionRequestSendSchema.parse({ op_id: OP, target_id: 'u2', scopes: ['ping', 'location_view', 'ping'] }).scopes).toEqual([
      'location_view',
      'ping',
    ]);
    expect(PermissionRequestSendSchema.safeParse({ op_id: OP, target_id: 'u2', scopes: ['sos_alert'] }).success).toBe(false);
    expect(PermissionRequestSendSchema.safeParse({ op_id: OP, target_id: 'u2', scopes: [] }).success).toBe(false);
    expect(PermissionSetSchema.safeParse({ op_id: OP, grantee_id: 'u2', scope: 'sos_alert', granted: true }).success).toBe(false);
    const decline = PermissionRequestRespondSchema.parse({ op_id: OP, requester_id: 'u2', grant_scopes: [] });
    expect(decline).toMatchObject({ grant_scopes: [], share: null });
    const withShare = PermissionRequestRespondSchema.parse({
      op_id: OP,
      requester_id: 'u2',
      grant_scopes: ['location_view'],
      share: { duration: { kind: 'preset', preset: 'h1' }, time_zone: 'Europe/Istanbul' },
    });
    expect(withShare.share?.duration).toEqual({ kind: 'preset', preset: 'h1' });
    // share_start varsayılanı: izin YAZILMAZ.
    expect(ShareStartRequestSchema.parse({ op_id: OP, receiver_ids: ['u2'], duration: { kind: 'preset', preset: 'h1' }, time_zone: 'Europe/Istanbul' }).grant_location_view).toBe(false);
    expect(ACCESS_SCOPE_TEXT.location_view.given.title).toBe('Konumumu görebilir');
    expect(ACCESS_SCOPE_TEXT.location_view.received.title).toBe('Konumunu görebilirsin');
  });
});

describe('Faz 8 görünmez mod', () => {
  it('anlık görüntü yalnızca etkin paylaşımlar; geri yükleme varsayılan hiçbiri, eski bitişe kadar', () => {
    const snap = planInvisibleOn(
      [
        { receiver_id: 'ayse', status: 'active', share_mode: 'timed', started_at: NOW - HOUR, expires_at: NOW + 2 * HOUR },
        { receiver_id: 'mehmet', status: 'active', share_mode: 'indefinite', started_at: NOW - HOUR, expires_at: null },
        { receiver_id: 'zeynep', status: 'ended', share_mode: 'timed', started_at: NOW - HOUR, expires_at: NOW + HOUR },
        { receiver_id: 'can', status: 'active', share_mode: 'timed', started_at: NOW - HOUR, expires_at: NOW + 3 * MIN },
      ],
      NOW,
    );
    expect(snap.map((e) => e.receiver_id)).toEqual(['ayse', 'mehmet', 'can']);

    const later = NOW + 30 * MIN;
    // süresi dolan ve 5 dk'dan az kalan düşer; süresiz kalır
    expect(restorableEntries(snap, later).map((e) => e.receiver_id)).toEqual(['ayse', 'mehmet']);
    const ayse = snap[0] as InvisibleSnapshotEntry;
    expect(restoreDuration(ayse)).toEqual({ kind: 'custom_until', until: NOW + 2 * HOUR });
    expect(restoreDuration({ expires_at: null })).toEqual({ kind: 'indefinite' });
    expect(resolveDuration(restoreDuration(ayse), later).expires_at).toBe(NOW + 2 * HOUR);

    // Seçim yoksa hiçbir şey başlamaz.
    expect(planInvisibleRestore(snap, undefined, later).restore).toEqual([]);
    const plan = planInvisibleRestore(snap, ['ayse', 'mehmet', 'can', 'yabanci'], later, (id) => id !== 'mehmet');
    expect(plan.restore.map((r) => r.entry.receiver_id)).toEqual(['ayse']);
    expect(plan.skipped_receiver_ids).toEqual(['mehmet', 'can', 'yabanci']);

    expect(InvisibleSetRequestSchema.safeParse({ op_id: OP, invisible: true }).success).toBe(true);
    expect(INVISIBLE_TEXT.banner).toBe('Görünmezsin · kimse konumunu görmüyor');
    expect(INVISIBLE_TEXT.confirmBody(3)).toContain('3 paylaşımın duracak');
    expect(INVISIBLE_TEXT.confirmBody(3)).toContain('Arkadaşlarına görünmez olduğun söylenmez.');
    expect(INVISIBLE_TEXT.confirmBody(0)).not.toContain('SOS');
    expect(INVISIBLE_TEXT.confirmBody(0, true)).toContain('acil durum kişilerin SOS konumunu görmeye devam eder');
  });
});

describe('Faz 8 Güvenlik Sözleşmesi ve KVKK onayı', () => {
  it('metin özeti sabit ve Node crypto ile aynı (metin değişirse CONSENT_VERSION artırılmalı)', () => {
    expect(CONSENT_VERSION).toBe('2026-11-25');
    expect(CONSENT_TEXT_SHA256).toBe('2f36ecc72ef442db9f95a69a73258194c8cb12714c77d2c31521c8651bde3839');
    expect(createHash('sha256').update(CONSENT_TEXT).digest('hex')).toBe(CONSENT_TEXT_SHA256);
    expect(CONSENT_TEXT.startsWith(`${CONSENT_TITLE}\nSürüm: ${CONSENT_VERSION}`)).toBe(true);
    for (const p of CONSENT_PLACEHOLDERS) expect(CONSENT_TEXT).toContain(p);
    for (const t of ['m.5/2-c', 'm.5/2-ç', 'm.5/2-f', 'm.9', 'm.11', 'eur3', 'europe-west1', '48 saat', '15 dakika']) expect(CONSENT_TEXT).toContain(t);
    expect(CONSENT_DOCUMENT.at(-1)?.paragraphs?.[0]).toContain('“Okudum, Onaylıyorum”');
    expect(new Set(CONSENT_DOCUMENT.map((s) => s.id)).size).toBe(CONSENT_DOCUMENT.length);
  });

  it('onay kapısı ve sürüm / özet eşleşmesi', () => {
    expect(consentRequired(null)).toBe(true);
    expect(consentRequired(undefined)).toBe(true);
    expect(consentRequired({ version: '2026-01-01', accepted_at: NOW })).toBe(true);
    expect(consentRequired({ version: CONSENT_VERSION, accepted_at: NOW })).toBe(false);
    // Başka cihazda daha yeni sürüm onaylandı: sunucu kararı değişmez, istemci kapıda kilitlenmez.
    expect(consentRequired({ version: '2999-01-01', accepted_at: NOW })).toBe(true);
    expect(consentNewerThanApp({ version: '2999-01-01', accepted_at: NOW })).toBe(true);
    expect(clientConsentRequired({ version: '2999-01-01', accepted_at: NOW })).toBe(false);
    expect(clientConsentRequired({ version: '2026-01-01', accepted_at: NOW })).toBe(true);
    expect(clientConsentRequired(null)).toBe(true);
    expect(isCurrentConsent({ version: CONSENT_VERSION, text_sha256: CONSENT_TEXT_SHA256 })).toBe(true);
    expect(isCurrentConsent({ version: CONSENT_VERSION, text_sha256: '0'.repeat(64) })).toBe(false);
    // Koruyucu işlemler onaysız çalışır; açma yönü çalışmaz.
    expect(consentExemptCall(CALLABLES.shareStop)).toBe(true);
    expect(consentExemptCall(CALLABLES.permissionSet, { granted: false })).toBe(true);
    expect(consentExemptCall(CALLABLES.permissionSet, { granted: true })).toBe(false);
    expect(consentExemptCall(CALLABLES.invisibleSet, { invisible: true })).toBe(true);
    expect(consentExemptCall(CALLABLES.invisibleSet, { invisible: false })).toBe(false);
    expect(consentExemptCall(CALLABLES.shareStart)).toBe(false);
    expect(consentExemptCall(CALLABLES.permissionRequestSend)).toBe(false);
  });

  it('kaydırma kapısı: sona gelince (24 px pay) ya da metin sığıyorsa true, ölçüm yoksa false', () => {
    expect(isScrolledToBottom({ offsetY: 0, viewportH: 800, contentH: 3000 })).toBe(false);
    expect(isScrolledToBottom({ offsetY: 2175, viewportH: 800, contentH: 3000 })).toBe(false);
    expect(isScrolledToBottom({ offsetY: 2176, viewportH: 800, contentH: 3000 })).toBe(true);
    expect(isScrolledToBottom({ offsetY: 2300, viewportH: 800, contentH: 3000 })).toBe(true); // iOS sıçrama
    expect(isScrolledToBottom({ offsetY: 0, viewportH: 800, contentH: 600 })).toBe(true);
    expect(isScrolledToBottom({ offsetY: 0, viewportH: 800, contentH: 800 })).toBe(true);
    expect(isScrolledToBottom({ offsetY: 0, viewportH: 0, contentH: 0 })).toBe(false);
    expect(isScrolledToBottom({ offsetY: Number.NaN, viewportH: 800, contentH: 3000 })).toBe(false);
    expect(isScrolledToBottom({ offsetY: 2100, viewportH: 800, contentH: 3000 }, 100)).toBe(true);
  });

  it('consent_accept şeması scrolled_to_bottom için yalnızca true kabul eder', () => {
    const ok = { op_id: OP, version: CONSENT_VERSION, text_sha256: CONSENT_TEXT_SHA256, scrolled_to_bottom: true, platform: 'ios', app_version: '0.1.0' };
    expect(ConsentAcceptRequestSchema.safeParse(ok).success).toBe(true);
    expect(ConsentAcceptRequestSchema.safeParse({ ...ok, scrolled_to_bottom: false }).success).toBe(false);
    const { scrolled_to_bottom: _s, ...missing } = ok;
    expect(ConsentAcceptRequestSchema.safeParse(missing).success).toBe(false);
    expect(ConsentAcceptRequestSchema.safeParse({ ...ok, platform: 'windows' }).success).toBe(false);
    expect(ConsentAcceptRequestSchema.safeParse({ ...ok, text_sha256: 'ABC' }).success).toBe(false);
  });
});

describe('Faz 8 sözleşme eklemeleri', () => {
  it('callable adları, yollar, hata kodları ve push türleri', () => {
    expect([
      CALLABLES.permissionRequestSend,
      CALLABLES.permissionRequestRespond,
      CALLABLES.permissionSet,
      CALLABLES.invisibleSet,
      CALLABLES.consentAccept,
      CALLABLES.consentWithdraw,
    ]).toEqual(['permission_request_send', 'permission_request_respond', 'permission_set', 'invisible_set', 'consent_accept', 'consent_withdraw']);
    expect(new Set(Object.values(CALLABLES)).size).toBe(Object.values(CALLABLES).length);
    expect(PATHS.permissionGrants).toBe('permission_grants');
    expect(PATHS.consent('u1', CONSENT_VERSION)).toBe(`users/u1/consents/${CONSENT_VERSION}`);
    expect(ERROR_CODES.not_permitted.message).toBe('Bu kişi sana bu izni vermedi.');
    expect(ERROR_CODES.invisible_mode.message).toBe('Görünmez moddasın. Paylaşmak için önce görünür ol.');
    expect(ERROR_CODES.consent_required.message).toBe('Devam etmek için güncel Güvenlik Sözleşmesi ve KVKK metnini onaylaman gerekiyor.');
    expect(ERROR_CODES.permission_cooldown.message).toBe('Bu kişiden kısa süre önce izin istedin. Biraz sonra tekrar dene.');
    expect(PUSH_TYPES_F8).toEqual(['permission_request', 'permission_granted']);
  });
});
