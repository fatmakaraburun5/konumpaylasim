/**
 * Faz 8 arayüz saf mantığı: onay kapısı (kaydırma kapısı, yeniden onay), seçicilerde izin YÖNÜ, "İzin ver…" sayfası
 * (varsayılanlar, görünmezken paylaşım yok), Kişi izinleri satırları, paylaşım başlatırken izin onayı metni,
 * görünür olurken geri yükleme (varsayılan hiçbiri) ve görünmez onay metni.
 */
import { CONSENT_UI_TEXT, CONSENT_VERSION, ERROR_CODES, fixedOffset, HOUR, splitGrants, type PermissionGrantDoc } from '@konum/core';
import {
  grantOnShareConfirmText,
  initialGrantSheet,
  missingRequestable,
  needsLocationGrant,
  pickerRowAccess,
  pickerRowPressable,
  receivedRows,
  requestFeedback,
  respondPlan,
  toggleGrantScope,
  type CanFn,
} from '../src/features/access/accessModel';
import { consentFooterView, consentGateMode, latchScrolled } from '../src/features/consent/consentModel';
import {
  activeShareCount,
  initialRestoreSelection,
  invisibleConfirmBody,
  restoreOutcome,
  restoreRequestIds,
  restoreRows,
  skipReason,
  toggleRestore,
} from '../src/features/invisible/invisibleModel';
import { selectCan } from '../src/state/grantsStore';

const NOW = Date.UTC(2026, 10, 25, 11, 0, 0);
const ME = 'me';
const doc = (granter: string, grantee: string, scopes: string[], over: Partial<PermissionGrantDoc> = {}): PermissionGrantDoc => ({
  granter_id: granter,
  grantee_id: grantee,
  scopes: Object.fromEntries(scopes.map((s) => [s, { granted_at: NOW - HOUR, via: 'manual' }])),
  pending: null,
  declined_at: {},
  updated_at: NOW - HOUR,
  version: 1,
  ...over,
});

/** grantsStore ile aynı yön: given = benim verdiğim, received = bana verilen. */
const canOf = (docs: PermissionGrantDoc[]): CanFn => {
  const s = splitGrants(docs, ME);
  return (scope, uid, dir) => selectCan(s, scope, uid, dir);
};

describe('onay kapısı', () => {
  it('düğme metin sonuna kaydırılana kadar pasif; ipucu gösterilir', () => {
    const v = consentFooterView({ scrolled: false, busy: false, error: null });
    expect(v).toMatchObject({ disabled: true, note: CONSENT_UI_TEXT.scrollHint });
    expect(consentFooterView({ scrolled: true, busy: false, error: null }).disabled).toBe(false);
    // Hata: metin gösterilir, yeniden denemek için açık kalır.
    expect(consentFooterView({ scrolled: true, busy: false, error: 'Bağlantı yok' })).toMatchObject({ disabled: false, note: 'Bağlantı yok', tone: 'error' });
  });

  it('ölçüm yokken açılmaz; sona gelince açılır ve açık kalır; sığan metin doğrudan açık', () => {
    expect(latchScrolled(false, { offsetY: 0, viewportH: 0, contentH: 0 })).toBe(false);
    expect(latchScrolled(false, { offsetY: 100, viewportH: 600, contentH: 2000 })).toBe(false);
    const at = latchScrolled(false, { offsetY: 1390, viewportH: 600, contentH: 2000 });
    expect(at).toBe(true);
    // İçerik sonradan uzasa da (yazı boyutu) kapanmaz.
    expect(latchScrolled(at, { offsetY: 1390, viewportH: 600, contentH: 4000 })).toBe(true);
    expect(latchScrolled(false, { offsetY: 0, viewportH: 800, contentH: 700 })).toBe(true);
  });

  it('eski sürüm onayı "Metin güncellendi" kipini açar', () => {
    expect(consentGateMode(null)).toBe('first');
    expect(consentGateMode({ version: '2020-01-01', accepted_at: NOW })).toBe('updated');
    expect(consentGateMode({ version: CONSENT_VERSION, accepted_at: NOW })).toBe('first');
  });
});

describe('seçicilerde izin yönü', () => {
  // Ayşe bana konum + ping vermiş; ben Can'a konum vermişim; Can bana hiçbir şey vermemiş.
  const can = canOf([doc('ayse', ME, ['location_view', 'ping']), doc(ME, 'can', ['location_view'])]);

  it('paylaşım benim verdiğim konum iznine bakar (onun bana verdiğine değil); izin yoksa etiketli ama seçilebilir', () => {
    expect(pickerRowAccess('share', 'can', can)).toBeNull();
    const a = pickerRowAccess('share', 'ayse', can);
    expect(a).toMatchObject({ tag: 'izin yok', disabledReason: null });
    expect(pickerRowPressable(a, false)).toBe(true);
    expect(needsLocationGrant(['ayse', 'can'], can)).toEqual(['ayse']);
  });

  it('ping / bölge bildirimi / buluşma onun bana verdiği izne bakar; yoksa pasif (seçiliyse yalnızca çıkarılır)', () => {
    expect(pickerRowAccess('ping', 'ayse', can)).toBeNull();
    expect(pickerRowAccess('ping', 'can', can)?.disabledReason).toBe(ERROR_CODES.not_permitted.message);
    const zone = pickerRowAccess('zone_notify', 'ayse', can);
    expect(zone?.disabledReason).toBeTruthy();
    expect(pickerRowPressable(zone, false)).toBe(false);
    expect(pickerRowPressable(zone, true)).toBe(true);
    expect(pickerRowAccess('meetup_invite', 'can', can)?.disabledReason).toBeTruthy();
    // Bölge start_share / yer notu / favori: benim konum iznim.
    expect(pickerRowAccess('zone_start_share', 'can', can)).toBeNull();
    expect(pickerRowAccess('zone_start_share', 'ayse', can)?.disabledReason).toBe('Ona konum izni vermedin.');
    expect(pickerRowAccess('favorite', 'ayse', can)?.disabledReason).toBeTruthy();
  });

  it('paylaşım onayı Türkçe ekle tek cümle', () => {
    expect(grantOnShareConfirmText(['Ayşe', 'Can'])).toBe("Ayşe ve Can'a konumunu görme izni de verilecek. Bu izni Arkadaşlar > kişi > İzinler'den geri alabilirsin.");
    expect(grantOnShareConfirmText(['Ayşe', 'Mehmet', 'Zeynep']).startsWith("Ayşe, Mehmet ve Zeynep'e ")).toBe(true);
  });
});

describe('"İzin ver…" sayfası', () => {
  it('istenenler işaretli; konum istendiyse 1 saat paylaşım varsayılan', () => {
    const s = initialGrantSheet(['location_view', 'ping']);
    expect(s).toEqual({ scopes: ['location_view', 'ping'], shareNow: 'h1' });
    expect(respondPlan(s, { invisible: false })).toEqual({ grantScopes: ['location_view', 'ping'], share: { duration: { kind: 'preset', preset: 'h1' } } });
    expect(initialGrantSheet(['ping']).shareNow).toBe('none');
  });

  it('konum işareti kaldırılınca paylaşım da kalkar; görünmezken paylaşım istenmez; istenmeyen kapsam eklenemez', () => {
    const req = ['location_view', 'ping'] as const;
    const off = toggleGrantScope(initialGrantSheet(req), 'location_view', req);
    expect(respondPlan(off, { invisible: false })).toEqual({ grantScopes: ['ping'], share: null });
    expect(respondPlan(initialGrantSheet(req), { invisible: true }).share).toBeNull();
    expect(toggleGrantScope(initialGrantSheet(['ping']), 'location_view', ['ping']).scopes).toEqual(['ping']);
    const none = toggleGrantScope(off, 'ping', req);
    expect(respondPlan(none, { invisible: false }).grantScopes).toEqual([]);
  });
});

describe('Kişi izinleri', () => {
  it('bekleyen istek "İstek gönderildi"; sos istenemez; "Tümünü iste" yalnızca eksikleri ister', () => {
    const rows = receivedRows(doc('can', ME, ['ping']), ['location_view']);
    const by = Object.fromEntries(rows.map((r) => [r.scope, r.state]));
    expect(by).toEqual({ location_view: 'pending', ping: 'granted', zone_notify: 'missing', meetup_invite: 'missing', sos_alert: 'not_requestable' });
    expect(missingRequestable(rows)).toEqual(['zone_notify', 'meetup_invite']);
  });

  it('soğuma hatası core metniyle gösterilir', () => {
    expect(requestFeedback({ ok: false, code: 'permission_cooldown', message: 'x' }).text).toBe(ERROR_CODES.permission_cooldown.message);
    expect(requestFeedback({ ok: true, status: 'sent' })).toEqual({ ok: true, text: 'İzin isteği gönderildi' });
  });
});

describe('görünmez mod', () => {
  const entries = [
    { receiver_id: 'ayse', share_mode: 'timed' as const, expires_at: NOW + 2 * HOUR, started_at: NOW - HOUR },
    { receiver_id: 'can', share_mode: 'indefinite' as const, expires_at: null, started_at: NOW - HOUR },
  ];

  it('görünür olurken hiçbiri seçili değil; yalnızca seçilenler gönderilir', () => {
    const rows = restoreRows(entries, { ayse: 'Ayşe' }, NOW, fixedOffset(180));
    expect(rows.map((r) => r.name)).toEqual(['Ayşe', 'Arkadaşın']);
    expect(rows[0]?.label).toContain('kaldı');
    const sel = initialRestoreSelection();
    expect(restoreRequestIds(sel, rows)).toEqual([]);
    expect(restoreRequestIds(toggleRestore(sel, 'can'), rows)).toEqual(['can']);
    // Listede olmayan kimlik gönderilmez.
    expect(restoreRequestIds(new Set(['zeynep']), rows)).toEqual([]);
  });

  it('başlatılamayanların nedeni yalnızca bizim tarafımızdan', () => {
    const ctx = { isFriend: (id: string) => id !== 'eski', iGrantLocation: (id: string) => id === 'ayse' };
    expect(skipReason('eski', ctx)).toBe('not_friend');
    expect(skipReason('can', ctx)).toBe('no_grant');
    expect(skipReason('ayse', ctx)).toBe('expired');
    const out = restoreOutcome({ restoredReceiverIds: ['ayse'], skippedReceiverIds: ['can'] }, { ayse: 'Ayşe', can: 'Can' }, (id) => skipReason(id, ctx));
    expect(out).toEqual({ restored: 'Yeniden başladı: Ayşe', skipped: [{ id: 'can', text: 'Can · konum iznini kapatmışsın' }] });
  });

  it('onay metni süren paylaşımlardaki alıcı sayısını söyler', () => {
    const sessions = [
      { phase: 'active' as const, active_receiver_ids: ['ayse', 'can'] },
      { phase: 'expiring_soon' as const, active_receiver_ids: ['ayse'] },
      { phase: 'ended' as const, active_receiver_ids: ['zeynep'] },
    ];
    expect(activeShareCount(sessions)).toBe(2);
    expect(invisibleConfirmBody(sessions).startsWith('2 paylaşımın duracak')).toBe(true);
    expect(invisibleConfirmBody([])).toContain('Arkadaşlarına görünmez olduğun söylenmez.');
  });
});
