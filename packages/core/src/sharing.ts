/**
 * Gönderen tarafı paylaşım durumu: saf reducer + seçiciler.
 * Mobil uygulama bunu zustand içinde kullanır; web (Faz 2) ve testler aynı kodu kullanır.
 *
 * Kurallar:
 *  - Sunucu (Firestore `location_shares`, sender_id == ben) DOĞRUDUR. `SERVER_SNAPSHOT` her zaman kazanır.
 *  - İyimser durum yalnızca arayüz içindir: sunucu onaylamadan hiçbir alıcıya konum YAYINLANMAZ.
 *  - Kullanıcı "Durdur"a bastığı an yayın durur (sunucu yanıtı beklenmez).
 */
import {
  type ExtensionMinutes,
  type ResolvedDuration,
  type ShareMode,
  extendPromptAt,
  isExpired,
  isNearExpiry,
} from './duration';
import type { SessionId, ShareEndReason, ShareId, ShareStatus, UserId } from './model';
import type { PublishTarget } from './packet';
import type { EpochMs } from './time';

export interface OutgoingShareView {
  share_id: ShareId;
  session_id: SessionId;
  receiver_id: UserId;
  status: ShareStatus;
  share_mode: ShareMode;
  started_at: EpochMs;
  expires_at: EpochMs | null;
  end_reason: ShareEndReason | null;
  version: number;
}

export type SessionPhase = 'starting' | 'active' | 'expiring_soon' | 'extending' | 'stopping' | 'ended' | 'failed';

export interface SharingError {
  code: string;
  message: string;
}

interface PendingOp {
  kind: 'start' | 'extend' | 'stop';
  op_id: string;
  minutes?: ExtensionMinutes;
}

interface LocalSessionMeta {
  pending: PendingOp | null;
  error: SharingError | null;
  /** Sunucu onayından önce arayüzde gösterilecek taslak. */
  draft: { receiver_ids: UserId[]; share_mode: ShareMode; expires_at: EpochMs | null; started_at: EpochMs } | null;
  /** Durdurma başarısız olsa bile yayın kapalı kalır (kullanıcı niyeti). */
  paused: boolean;
}

export interface SharingState {
  now: EpochMs;
  shares: Record<ShareId, OutgoingShareView>;
  local: Record<SessionId, LocalSessionMeta>;
}

export const initialSharingState = (now: EpochMs): SharingState => ({ now, shares: {}, local: {} });

export type SharingEvent =
  | { type: 'START_REQUESTED'; op_id: string; session_id: SessionId; receiver_ids: UserId[]; resolved: ResolvedDuration; now: EpochMs }
  | { type: 'START_SUCCEEDED'; session_id: SessionId; shares: OutgoingShareView[] }
  | { type: 'START_FAILED'; session_id: SessionId; error: SharingError }
  | { type: 'EXTEND_REQUESTED'; session_id: SessionId; op_id: string; minutes: ExtensionMinutes }
  | { type: 'EXTEND_SUCCEEDED'; session_id: SessionId; shares: OutgoingShareView[] }
  | { type: 'EXTEND_FAILED'; session_id: SessionId; error: SharingError }
  | { type: 'STOP_REQUESTED'; session_id: SessionId; op_id: string }
  | { type: 'STOP_SUCCEEDED'; session_id: SessionId; shares: OutgoingShareView[] }
  | { type: 'STOP_FAILED'; session_id: SessionId; error: SharingError }
  | { type: 'SERVER_SNAPSHOT'; shares: OutgoingShareView[] }
  | { type: 'TICK'; now: EpochMs }
  | { type: 'DISMISS'; session_id: SessionId };

const emptyMeta = (): LocalSessionMeta => ({ pending: null, error: null, draft: null, paused: false });

function withMeta(state: SharingState, id: SessionId, patch: Partial<LocalSessionMeta>): SharingState {
  const prev = state.local[id] ?? emptyMeta();
  return { ...state, local: { ...state.local, [id]: { ...prev, ...patch } } };
}

function upsertShares(state: SharingState, shares: readonly OutgoingShareView[]): SharingState {
  if (shares.length === 0) return state;
  const next = { ...state.shares };
  for (const s of shares) {
    const prev = next[s.share_id];
    // Eski sürüm yeni sürümü ezemez (geç gelen yanıt).
    if (!prev || s.version >= prev.version) next[s.share_id] = s;
  }
  return { ...state, shares: next };
}

export function sharingReducer(state: SharingState, ev: SharingEvent): SharingState {
  switch (ev.type) {
    case 'START_REQUESTED':
      return withMeta({ ...state, now: ev.now }, ev.session_id, {
        pending: { kind: 'start', op_id: ev.op_id },
        error: null,
        paused: false,
        draft: { receiver_ids: [...ev.receiver_ids], share_mode: ev.resolved.share_mode, expires_at: ev.resolved.expires_at, started_at: ev.now },
      });
    case 'START_SUCCEEDED':
      return withMeta(upsertShares(state, ev.shares), ev.session_id, { pending: null, error: null, draft: null });
    case 'START_FAILED':
      return withMeta(state, ev.session_id, { pending: null, error: ev.error });
    case 'EXTEND_REQUESTED':
      return withMeta(state, ev.session_id, { pending: { kind: 'extend', op_id: ev.op_id, minutes: ev.minutes }, error: null });
    case 'EXTEND_SUCCEEDED':
      return withMeta(upsertShares(state, ev.shares), ev.session_id, { pending: null, error: null });
    case 'EXTEND_FAILED':
      return withMeta(state, ev.session_id, { pending: null, error: ev.error });
    case 'STOP_REQUESTED':
      return withMeta(state, ev.session_id, { pending: { kind: 'stop', op_id: ev.op_id }, error: null, paused: true });
    case 'STOP_SUCCEEDED':
      return withMeta(upsertShares(state, ev.shares), ev.session_id, { pending: null, error: null });
    case 'STOP_FAILED':
      return withMeta(state, ev.session_id, { pending: null, error: ev.error, paused: true });
    case 'SERVER_SNAPSHOT': {
      const shares: Record<ShareId, OutgoingShareView> = {};
      for (const s of ev.shares) shares[s.share_id] = s;
      // Sunucu gerçeği tam liste olarak gelir: listede olmayan paylaşım artık yoktur.
      let next: SharingState = { ...state, shares };
      // Sunucunun yeniden başlattığı (aktif) oturumlarda yerel "durduruldu" bayrağı kalkmaz:
      // yalnızca kullanıcı yeni START verirse kalkar. Böylece durdurma yarışında konum sızmaz.
      for (const s of ev.shares) {
        const meta = next.local[s.session_id];
        if (meta?.draft && meta.pending?.kind !== 'start') next = withMeta(next, s.session_id, { draft: null });
      }
      return next;
    }
    case 'TICK':
      return ev.now === state.now ? state : { ...state, now: ev.now };
    case 'DISMISS': {
      const { [ev.session_id]: _gone, ...rest } = state.local;
      const shares = Object.fromEntries(
        Object.entries(state.shares).filter(([, s]) => !(s.session_id === ev.session_id && s.status === 'ended')),
      );
      return { ...state, local: rest, shares };
    }
    default: {
      const never: never = ev;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------
// Seçiciler
// ---------------------------------------------------------------------------

export interface ShareSession {
  session_id: SessionId;
  phase: SessionPhase;
  /** Hâlâ konum alan alıcılar. */
  active_receiver_ids: UserId[];
  /** Bu oturumda paylaşımı biten alıcılar ve nedeni. */
  ended_receivers: { receiver_id: UserId; reason: ShareEndReason }[];
  share_mode: ShareMode;
  started_at: EpochMs;
  expires_at: EpochMs | null;
  /** "Süre dolmak üzere" uyarısının zamanı. */
  prompt_at: EpochMs | null;
  end_reason: ShareEndReason | null;
  error: SharingError | null;
  confirmed: boolean;
}

function effectiveStatus(s: OutgoingShareView, now: EpochMs): { active: boolean; reason: ShareEndReason | null } {
  if (s.status === 'ended') return { active: false, reason: s.end_reason ?? 'stopped_by_sender' };
  if (isExpired(s, now)) return { active: false, reason: 'expired' };
  return { active: true, reason: null };
}

export function selectSessions(state: SharingState): ShareSession[] {
  const bySession = new Map<SessionId, OutgoingShareView[]>();
  for (const s of Object.values(state.shares)) {
    const list = bySession.get(s.session_id);
    if (list) list.push(s);
    else bySession.set(s.session_id, [s]);
  }
  const ids = new Set<SessionId>([...bySession.keys(), ...Object.keys(state.local)]);
  const out: ShareSession[] = [];
  for (const id of ids) {
    const meta = state.local[id] ?? emptyMeta();
    const shares = bySession.get(id) ?? [];
    if (shares.length === 0) {
      if (!meta.draft) continue;
      out.push({
        session_id: id,
        phase: meta.pending?.kind === 'start' ? 'starting' : 'failed',
        active_receiver_ids: [],
        ended_receivers: [],
        share_mode: meta.draft.share_mode,
        started_at: meta.draft.started_at,
        expires_at: meta.draft.expires_at,
        prompt_at: null,
        end_reason: null,
        error: meta.error,
        confirmed: false,
      });
      continue;
    }
    const active: OutgoingShareView[] = [];
    const ended: { receiver_id: UserId; reason: ShareEndReason }[] = [];
    for (const s of shares) {
      const st = effectiveStatus(s, state.now);
      if (st.active) active.push(s);
      else ended.push({ receiver_id: s.receiver_id, reason: st.reason as ShareEndReason });
    }
    // Oturumun süresi = aktif paylaşımların en geç bitişi (hepsi aynı oturumda genelde eşittir).
    const ref = active[0] ?? shares[0]!;
    const expires_at = active.length
      ? active.some((s) => s.expires_at === null)
        ? null
        : Math.max(...active.map((s) => s.expires_at as number))
      : ref.expires_at;
    const view = { status: active.length ? ('active' as const) : ('ended' as const), share_mode: ref.share_mode, started_at: Math.min(...shares.map((s) => s.started_at)), expires_at };
    let phase: SessionPhase;
    if (active.length === 0) phase = 'ended';
    else if (meta.pending?.kind === 'stop' || meta.paused) phase = 'stopping';
    else if (meta.pending?.kind === 'extend') phase = 'extending';
    else if (isNearExpiry(view, state.now)) phase = 'expiring_soon';
    else phase = 'active';
    const reasons = new Set(ended.map((e) => e.reason));
    out.push({
      session_id: id,
      phase,
      active_receiver_ids: active.map((s) => s.receiver_id).sort(),
      ended_receivers: ended,
      share_mode: view.share_mode,
      started_at: view.started_at,
      expires_at,
      prompt_at: active.length ? extendPromptAt(view) : null,
      end_reason: active.length === 0 ? (reasons.size === 1 ? [...reasons][0]! : 'stopped_by_sender') : null,
      error: meta.error,
      confirmed: true,
    });
  }
  return out.sort((a, b) => b.started_at - a.started_at);
}

/**
 * Konum yayıncısının yazabileceği hedefler: sunucunun onayladığı, süresi dolmamış,
 * kullanıcının durdurmadığı paylaşımlar. Bu liste boşsa takip kapanır.
 */
export function selectPublishTargets(state: SharingState): PublishTarget[] {
  const out: PublishTarget[] = [];
  for (const s of Object.values(state.shares)) {
    if (!effectiveStatus(s, state.now).active) continue;
    const meta = state.local[s.session_id];
    if (meta?.paused || meta?.pending?.kind === 'stop') continue;
    out.push({ share_id: s.share_id, receiver_id: s.receiver_id, share_mode: s.share_mode, expires_at: s.expires_at });
  }
  return out.sort((a, b) => a.share_id.localeCompare(b.share_id));
}

export function hasActiveOutgoing(state: SharingState): boolean {
  return selectPublishTargets(state).length > 0;
}

/** Alıcı listesi değişti mi (yayıncı hemen yeni paket göndersin diye). */
export function publishTargetsKey(targets: readonly PublishTarget[]): string {
  return targets.map((t) => `${t.share_id}:${t.expires_at ?? '-'}`).join('|');
}
