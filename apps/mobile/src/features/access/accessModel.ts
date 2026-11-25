/**
 * Faz 8: yönlü izin arayüzünün saf mantığı (docs/PHASE8.md §4, §5.4–§5.5).
 *
 * Yön (grantsStore ile aynı): `given` = BENİM o kişiye verdiğim, `received` = O kişinin BANA verdiği.
 *  - Paylaşım / bölge `start_share` / yer notu / favori → benim `location_view` iznim (given).
 *  - Ping / bölge `notify` / buluşma daveti → onun bana verdiği izin (received).
 * Seçicilerde izin yoksa satır ya "izin yok" etiketiyle seçilebilir (paylaşım: başlatırken izin de verilir) ya da
 * kısa bir nedenle pasif olur (seçiliyse yalnızca çıkarılabilir). Hata almak yerine önceden gösterilir.
 */
import {
  ACCESS_SCOPE_TEXT,
  ACCESS_TEXT,
  ERROR_CODES,
  REQUESTABLE_SCOPES,
  type AccessScope,
  type DurationChoice,
  type GrantLike,
  type RequestableScope,
  type UserId,
} from '@konum/core';
import { turkishDative } from '../zones/zoneModel';

export type CanFn = (scope: AccessScope, uid: UserId, direction: 'given' | 'received') => boolean;

// --- seçiciler -------------------------------------------------------------------------------

export type PickerPurpose = 'share' | 'zone_notify' | 'zone_start_share' | 'meetup_invite' | 'note_audience' | 'favorite' | 'ping';

export interface PickerRowAccess {
  /** Satırdaki kısa etiket ("izin yok"). */
  tag: string;
  /** Verilirse satır pasiftir ve bu neden gösterilir. */
  disabledReason: string | null;
}

export const PICKER_REASON = {
  /** Onun bana vermediği izin. */
  fromThem: ACCESS_TEXT.pickerNoGrantHint,
  /** Benim ona vermediğim konum izni. */
  fromMe: 'Ona konum izni vermedin.',
} as const;

/** Bu amaç için gereken izin ve yönü. */
export const PICKER_REQUIREMENT: Record<PickerPurpose, { scope: AccessScope; direction: 'given' | 'received' }> = {
  share: { scope: 'location_view', direction: 'given' },
  zone_start_share: { scope: 'location_view', direction: 'given' },
  note_audience: { scope: 'location_view', direction: 'given' },
  favorite: { scope: 'location_view', direction: 'given' },
  zone_notify: { scope: 'zone_notify', direction: 'received' },
  meetup_invite: { scope: 'meetup_invite', direction: 'received' },
  ping: { scope: 'ping', direction: 'received' },
};

/** İzin varsa null; yoksa etiket + (paylaşım dışında) pasiflik nedeni. */
export function pickerRowAccess(purpose: PickerPurpose, uid: UserId, can: CanFn): PickerRowAccess | null {
  const req = PICKER_REQUIREMENT[purpose];
  if (can(req.scope, uid, req.direction)) return null;
  // Paylaşım: seçilebilir; başlatırken bir kez "konumunu görme izni de verilecek" onayı alınır.
  if (purpose === 'share') return { tag: ACCESS_TEXT.noGrantBadge, disabledReason: null };
  return { tag: ACCESS_TEXT.noGrantBadge, disabledReason: req.direction === 'given' ? PICKER_REASON.fromMe : PICKER_REASON.fromThem };
}

/** Pasif satır yalnızca seçiliyse (çıkarmak için) dokunulabilir. */
export function pickerRowPressable(access: PickerRowAccess | null, selected: boolean): boolean {
  return !access?.disabledReason || selected;
}

/** Seçimden yalnızca izinli olanlar (şablon değişince / otomatik eklemede). */
export function permittedIds(purpose: PickerPurpose, ids: readonly UserId[], can: CanFn): UserId[] {
  return ids.filter((id) => pickerRowAccess(purpose, id, can) === null);
}

// --- paylaşım başlatırken izin ---------------------------------------------------------------

/** Konum izni (ben → o) olmayan seçili alıcılar. */
export function needsLocationGrant(ids: readonly UserId[], can: CanFn): UserId[] {
  return ids.filter((id) => !can('location_view', id, 'given'));
}

/** "Ayşe'ye" · "Ayşe ve Mehmet'e" · "Ayşe, Can ve Zeynep'e" (ek yalnızca sondakine). */
export function namesDative(names: readonly string[]): string {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (list.length === 0) return 'Seçtiğin kişilere';
  const last = list[list.length - 1] as string;
  const lastDative = turkishDative(last) ?? `${last}'e`;
  if (list.length === 1) return lastDative;
  return `${list.slice(0, -1).join(', ')} ve ${lastDative}`;
}

export function grantOnShareConfirmText(names: readonly string[]): string {
  return `${namesDative(names)} konumunu görme izni de verilecek. Bu izni Arkadaşlar > kişi > İzinler'den geri alabilirsin.`;
}

// --- "İzin ver…" sayfası ---------------------------------------------------------------------

export type ShareNowId = 'm15' | 'h1' | 'h8' | 'eod' | 'none';

export const SHARE_NOW_OPTIONS: readonly { id: Exclude<ShareNowId, 'none'>; label: string; choice: DurationChoice }[] = [
  { id: 'm15', label: '15 dk', choice: { kind: 'preset', preset: 'm15' } },
  { id: 'h1', label: '1 saat', choice: { kind: 'preset', preset: 'h1' } },
  { id: 'h8', label: '8 saat', choice: { kind: 'preset', preset: 'h8' } },
  { id: 'eod', label: 'Gün sonu', choice: { kind: 'end_of_day' } },
];

export const SHARE_NOW_DEFAULT: ShareNowId = 'h1';

export interface GrantSheetState {
  /** İstenip işaretli bırakılan kapsamlar. */
  scopes: RequestableScope[];
  /** `location_view` işaretliyse şimdi paylaşım süresi ("none" = yalnızca izin ver). */
  shareNow: ShareNowId;
}

/** İstenen her kapsam işaretli; konum istendiyse 1 saat paylaşım varsayılan. */
export function initialGrantSheet(requested: readonly RequestableScope[]): GrantSheetState {
  return { scopes: [...requested], shareNow: requested.includes('location_view') ? SHARE_NOW_DEFAULT : 'none' };
}

export function toggleGrantScope(state: GrantSheetState, scope: RequestableScope, requested: readonly RequestableScope[]): GrantSheetState {
  if (!requested.includes(scope)) return state;
  const on = state.scopes.includes(scope);
  const scopes = on ? state.scopes.filter((s) => s !== scope) : requested.filter((s) => s === scope || state.scopes.includes(s));
  let shareNow = state.shareNow;
  if (scope === 'location_view') shareNow = on ? 'none' : SHARE_NOW_DEFAULT;
  return { scopes, shareNow };
}

export interface RespondPlan {
  grantScopes: RequestableScope[];
  share: { duration: DurationChoice } | null;
}

/** Görünmezken paylaşım istenmez (sunucu da başlatmaz). */
export function respondPlan(state: GrantSheetState, opts: { invisible: boolean }): RespondPlan {
  const opt = SHARE_NOW_OPTIONS.find((o) => o.id === state.shareNow);
  const share = state.scopes.includes('location_view') && opt && !opts.invisible ? { duration: opt.choice } : null;
  return { grantScopes: [...state.scopes], share };
}

export function grantButtonTitle(plan: RespondPlan): string {
  return plan.share ? 'İzin ver ve paylaş' : 'İzin ver';
}

// --- Kişi izinleri ---------------------------------------------------------------------------

export interface GivenRow {
  scope: AccessScope;
  title: string;
  description: string;
  on: boolean;
  /** `sos_alert` yalnızca acil durum kişilerinden değişir. */
  editable: boolean;
}

export function givenRows(myGrant: GrantLike): GivenRow[] {
  const scopes: AccessScope[] = [...REQUESTABLE_SCOPES, 'sos_alert'];
  return scopes.map((scope) => ({
    scope,
    title: ACCESS_SCOPE_TEXT[scope].given.title,
    description: ACCESS_SCOPE_TEXT[scope].given.description,
    on: myGrant?.scopes?.[scope] != null,
    editable: scope !== 'sos_alert',
  }));
}

export type ReceivedState = 'granted' | 'pending' | 'missing' | 'not_requestable';

export interface ReceivedRow {
  scope: AccessScope;
  title: string;
  description: string;
  state: ReceivedState;
}

export function receivedRows(theirGrant: GrantLike, myPending: readonly RequestableScope[]): ReceivedRow[] {
  const scopes: AccessScope[] = [...REQUESTABLE_SCOPES, 'sos_alert'];
  return scopes.map((scope) => {
    const granted = theirGrant?.scopes?.[scope] != null;
    const state: ReceivedState = granted
      ? 'granted'
      : scope === 'sos_alert'
        ? 'not_requestable'
        : myPending.includes(scope as RequestableScope)
          ? 'pending'
          : 'missing';
    return { scope, title: ACCESS_SCOPE_TEXT[scope].received.title, description: ACCESS_SCOPE_TEXT[scope].received.description, state };
  });
}

/** "Tümünü iste": verilmemiş ve beklemeyen istenebilir kapsamlar. */
export function missingRequestable(rows: readonly ReceivedRow[]): RequestableScope[] {
  return rows.filter((r) => r.state === 'missing').map((r) => r.scope as RequestableScope);
}

export const RECEIVED_STATE_TEXT: Record<ReceivedState, string> = {
  granted: 'Açık',
  pending: 'İstek gönderildi',
  missing: 'Yok',
  not_requestable: 'Yok',
};

/** İstek sonucu metni; soğuma hatası nazikçe gösterilir (core metni). */
export function requestFeedback(r: { ok: true; status: 'sent' | 'already_granted' } | { ok: false; code: string; message: string }): { ok: boolean; text: string } {
  if (r.ok) return { ok: true, text: r.status === 'already_granted' ? ACCESS_TEXT.alreadyGranted : ACCESS_TEXT.requestSent };
  if (r.code === 'permission_cooldown') return { ok: false, text: ERROR_CODES.permission_cooldown.message };
  return { ok: false, text: r.message };
}

export const LOCATION_OFF_CONFIRM = {
  title: 'Konum iznini kapat',
  body: (name: string) => `${name} konumunu artık göremez; ona süren paylaşımın hemen durur.`,
  action: 'Kapat',
} as const;
