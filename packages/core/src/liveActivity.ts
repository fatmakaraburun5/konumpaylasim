/**
 * Faz 12: kilit ekranı canlı sayaç — iOS Live Activity / Dynamic Island ve Android canlı (ongoing) bildirim için
 * TEK veri modeli. Uygulama içi durum (paylaşım oturumları, mola, görünmez, ETA) → `LiveShareContent`; yerel taraf
 * (ActivityKit `ContentState`, Android `NotificationCompat`) yalnızca çizer.
 *
 * Sayaç yerelde akar: iOS `Text(timerInterval:)`, Android `setUsesChronometer + setChronometerCountDown`. Bu yüzden
 * her dakika güncelleme GEREKMEZ; güncelleme yalnızca içerik değişince gider (`planLiveActivity`). Bu, ActivityKit
 * güncelleme bütçesini korur ve pil harcamaz.
 *
 * Yaşam döngüsü:
 *   ilk arkadaş paylaşımı başladı               → start
 *   alıcı / öndeki kişi / mola / ETA değişti     → update
 *   son 5 dk                                     → update (phase `expiring`, turuncu)
 *   tüm paylaşımlar bitti (süre / durdur)        → `ended` kartı ENDED_LINGER_MS gösterilir, sonra end
 *   Görünmez Ol                                  → HEMEN end (kilit ekranında iz kalmaz)
 *   çıkış / hesap değişimi                       → HEMEN end
 *
 * Gizlilik: içerikte KOORDİNAT YOK. Yalnızca ad, baş harfler, çerçeve rengi, kalan süre, ETA dakikası, hedef adı.
 */
import { initialsOf, type Gender } from './profile';
import type { UserId } from './model';
import { MINUTE, type EpochMs } from './time';

export const LIVE_ACTIVITY_VERSION = 1;
/** Son dakikalar uyarısı (kitapçıktaki "bitmek üzere" ile aynı eşik). */
export const LIVE_EXPIRING_MS = 5 * MINUTE;
/** "Paylaşım sona erdi" kartı bu kadar kalır, sonra kapanır. */
export const LIVE_ENDED_LINGER_MS = 4 * MINUTE;
/** ETA bu kadar eskiyse gösterilmez (uygulama arkadayken rota yenilenmez). */
export const LIVE_ETA_STALE_MS = 20 * MINUTE;

export type LivePhase = 'sharing' | 'expiring' | 'paused' | 'ended';
export type LiveRing = 'female' | 'male' | 'none';
export type LiveEndReason = 'expired' | 'stopped' | 'invisible' | 'signed_out';

/** Sabit nitelikler (ActivityKit `ActivityAttributes`): etkinlik boyunca değişmez. */
export interface LiveShareAttributes {
  v: typeof LIVE_ACTIVITY_VERSION;
  /** Cihazda üretilen kimlik; yeni etkinlik = yeni kimlik. */
  activity_id: string;
  started_at: EpochMs;
}

export interface LivePerson {
  uid: UserId;
  name: string;
  initials: string;
  ring: LiveRing;
  /** Widget avatar dosyasının anahtarı (App Group / uygulama dosyası, Faz 6 `saveAvatar`); yoksa baş harfler. */
  avatar_key: string | null;
}

export interface LiveEta {
  /** "Ayşe" / "Ev" */
  label: string;
  kind: 'friend' | 'destination';
  /** Tahmini varış (mutlak saat; sayaç yerelde akar). */
  arrive_at: EpochMs;
  /** Rotanın hesaplandığı an (LIVE_ETA_STALE_MS'den eskiyse gösterilmez). */
  computed_at: EpochMs;
}

/** Değişen içerik (ActivityKit `ContentState`). JSON snake_case; yerel taraf sürüm `v`'yi denetler. */
export interface LiveShareContent {
  v: typeof LIVE_ACTIVITY_VERSION;
  phase: LivePhase;
  /** Öndeki paylaşımın bitişi (süresiz = null → sayaç yerine "Süresiz"). */
  ends_at: EpochMs | null;
  /** Öndeki paylaşımın başlangıcı (ilerleme çubuğu). */
  started_at: EpochMs;
  /** Mola bitişi (phase `paused`). */
  break_until: EpochMs | null;
  lead: LivePerson;
  /** Konumu gören toplam kişi. */
  receivers: number;
  eta: LiveEta | null;
  /**
   * Yerel tarafın doğrudan basabileceği hazır metinler (Android başlığı, erişilebilirlik). ETA alt metne girmez:
   * dakikası yerelde akar (iOS ayrı satır `Text(date, style: .relative)`, Android içerik metnine eklenir).
   */
  title: string;
  subtitle: string;
  /** Bu içeriğin üretildiği an. */
  at: EpochMs;
}

export interface LiveShareSession {
  session_id: string;
  started_at: EpochMs;
  expires_at: EpochMs | null;
  receiver_ids: UserId[];
}

export interface LiveBuildInput {
  /** Süren (başlatılmış / onaylı) arkadaş paylaşım oturumları. */
  sessions: readonly LiveShareSession[];
  people: (uid: UserId) => { name: string; gender: Gender | null; avatar_key: string | null } | null;
  breakUntil: EpochMs | null;
  invisible: boolean;
  eta: LiveEta | null;
  now: EpochMs;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

export function liveRemainingText(ms: number): string {
  if (ms <= 0) return 'süre doldu';
  const m = Math.ceil(ms / MINUTE);
  if (m < 60) return `${m} dk kaldı`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} sa ${r} dk kaldı` : `${h} sa kaldı`;
}

export function etaMinutes(eta: LiveEta, now: EpochMs): number {
  return Math.max(1, Math.round((eta.arrive_at - now) / MINUTE));
}

/**
 * Şu anki durum → gösterilecek içerik; gösterilecek bir şey yoksa null (paylaşım yok ya da görünmez).
 * Öndeki kişi: kitapçıkla aynı kural, en kısa süresi kalan oturumun ilk alıcısı.
 */
export function buildLiveShareContent(i: LiveBuildInput): LiveShareContent | null {
  if (i.invisible) return null;
  const live = i.sessions.filter((s) => s.receiver_ids.length > 0 && (s.expires_at === null || s.expires_at > i.now));
  if (!live.length) return null;
  const lead = [...live].sort((a, b) => (a.expires_at ?? Infinity) - (b.expires_at ?? Infinity) || a.started_at - b.started_at)[0]!;
  const receivers = new Set(live.flatMap((s) => s.receiver_ids));
  const leadUid = [...lead.receiver_ids].sort()[0]!;
  const p = i.people(leadUid);
  const name = p?.name ?? 'Arkadaşın';
  const person: LivePerson = {
    uid: leadUid,
    name,
    initials: initialsOf(name),
    ring: p?.gender === 'female' ? 'female' : p?.gender === 'male' ? 'male' : 'none',
    avatar_key: p?.avatar_key ?? null,
  };
  const paused = i.breakUntil !== null && i.breakUntil > i.now;
  const expiring = lead.expires_at !== null && lead.expires_at - i.now <= LIVE_EXPIRING_MS;
  const phase: LivePhase = paused ? 'paused' : expiring ? 'expiring' : 'sharing';
  const eta = i.eta && i.eta.arrive_at > i.now - MINUTE && i.now - i.eta.computed_at <= LIVE_ETA_STALE_MS ? i.eta : null;
  const others = receivers.size - 1;
  const who = others > 0 ? `${first(name)} +${others}` : first(name);
  const title = paused ? `Moladasın · ${who}` : `${who} konumunu görüyor`;
  const parts: string[] = [];
  if (paused) parts.push(`Mola ${liveRemainingText(i.breakUntil! - i.now).replace(' kaldı', '')} · yeni konum gitmiyor`);
  else parts.push(lead.expires_at === null ? 'Süresiz' : liveRemainingText(lead.expires_at - i.now));
  return {
    v: LIVE_ACTIVITY_VERSION,
    phase,
    ends_at: lead.expires_at,
    started_at: lead.started_at,
    break_until: paused ? i.breakUntil : null,
    lead: person,
    receivers: receivers.size,
    eta,
    title,
    subtitle: parts.join(' · '),
    at: i.now,
  };
}

/** Bitmiş kartı: son içeriğin "sona erdi" hâli (sayaç durur). */
export function endedContent(prev: LiveShareContent, reason: Exclude<LiveEndReason, 'invisible' | 'signed_out'>, now: EpochMs): LiveShareContent {
  return {
    ...prev,
    phase: 'ended',
    break_until: null,
    eta: null,
    title: reason === 'expired' ? 'Paylaşım süresi doldu' : 'Paylaşım durduruldu',
    subtitle: 'Konumun artık paylaşılmıyor',
    at: now,
  };
}

/** Yerel tarafa gidecek anlamlı alanlar (sayaç yerelde akar; `at` / metin içi dakika farkı güncelleme sebebi değil). */
function signature(c: LiveShareContent): string {
  return JSON.stringify([
    c.phase,
    c.ends_at,
    c.break_until,
    c.lead.uid,
    c.lead.name,
    c.lead.ring,
    c.lead.avatar_key,
    c.receivers,
    c.eta ? [c.eta.label, c.eta.kind, Math.round(c.eta.arrive_at / MINUTE)] : null,
  ]);
}

export interface LiveRuntime {
  /** Yerelde açık etkinlik (yoksa null). */
  active: { attributes: LiveShareAttributes; content: LiveShareContent } | null;
  /** `ended` kartı bu saatte kapanacak. */
  dismiss_at: EpochMs | null;
}

export type LiveOp =
  | { op: 'none' }
  | { op: 'start'; attributes: LiveShareAttributes; content: LiveShareContent }
  | { op: 'update'; content: LiveShareContent }
  /** `immediate`: kart hemen kalkar (görünmez / çıkış); değilse `ended` içerik `dismiss_at`'e kadar kalır. */
  | { op: 'end'; content: LiveShareContent | null; immediate: boolean; dismiss_at: EpochMs | null };

export interface LivePlanInput {
  rt: LiveRuntime;
  next: LiveShareContent | null;
  /** next null ise sebebi. */
  reason: LiveEndReason | null;
  now: EpochMs;
  newId: () => string;
}

/** Durum geçişi → yerel çağrı. Saf: çağıran `applyLiveOp` ile `LiveRuntime`'ı ilerletir. */
export function planLiveActivity(i: LivePlanInput): LiveOp {
  const cur = i.rt.active;
  if (i.next) {
    if (!cur || cur.content.phase === 'ended') {
      return { op: 'start', attributes: { v: LIVE_ACTIVITY_VERSION, activity_id: i.newId(), started_at: i.now }, content: i.next };
    }
    return signature(cur.content) === signature(i.next) ? { op: 'none' } : { op: 'update', content: i.next };
  }
  if (!cur) return { op: 'none' };
  const hard = i.reason === 'invisible' || i.reason === 'signed_out';
  if (hard) return { op: 'end', content: null, immediate: true, dismiss_at: null };
  if (cur.content.phase === 'ended') {
    return i.rt.dismiss_at !== null && i.now >= i.rt.dismiss_at ? { op: 'end', content: null, immediate: true, dismiss_at: null } : { op: 'none' };
  }
  const reason = i.reason === 'expired' ? 'expired' : 'stopped';
  return { op: 'end', content: endedContent(cur.content, reason, i.now), immediate: false, dismiss_at: i.now + LIVE_ENDED_LINGER_MS };
}

export function applyLiveOp(rt: LiveRuntime, op: LiveOp): LiveRuntime {
  switch (op.op) {
    case 'none':
      return rt;
    case 'start':
      return { active: { attributes: op.attributes, content: op.content }, dismiss_at: null };
    case 'update':
      return rt.active ? { active: { ...rt.active, content: op.content }, dismiss_at: null } : rt;
    case 'end':
      return op.immediate || !op.content || !rt.active ? { active: null, dismiss_at: null } : { active: { ...rt.active, content: op.content }, dismiss_at: op.dismiss_at };
  }
}

/** Oturumlar bitti: süre mi doldu, kullanıcı mı durdurdu? (en son biten oturumun bitişi geçmişse süre) */
export function endReasonOf(lastSessions: readonly LiveShareSession[], now: EpochMs): 'expired' | 'stopped' {
  return lastSessions.length > 0 && lastSessions.every((s) => s.expires_at !== null && s.expires_at <= now + 2_000) ? 'expired' : 'stopped';
}

/** Dynamic Island / Android kompakt metni: "42 dk" · "Mola 12 dk" · "∞". */
export function compactLabel(c: LiveShareContent, now: EpochMs): string {
  if (c.phase === 'ended') return 'Bitti';
  if (c.phase === 'paused' && c.break_until) return `Mola ${Math.max(1, Math.ceil((c.break_until - now) / MINUTE))} dk`;
  if (c.ends_at === null) return '∞';
  return `${Math.max(0, Math.ceil((c.ends_at - now) / MINUTE))} dk`;
}

/** İlerleme (0..1, kalan oran); süresizde null. Android `setProgress`, iOS `ProgressView(timerInterval:)` ile aynı. */
export function remainingFraction(c: Pick<LiveShareContent, 'started_at' | 'ends_at'>, now: EpochMs): number | null {
  if (c.ends_at === null) return null;
  const total = c.ends_at - c.started_at;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (c.ends_at - now) / total));
}
