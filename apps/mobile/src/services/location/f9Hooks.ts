/**
 * Faz 9: konum hattının (ön plan + başsız arka plan) fotoğraf, hedef / yaklaşma ve Güvenli Dönüş kancaları.
 * React'e bağlı DEĞİL: arka plan konum görevi ve bölge görevi de çağırır. Depolar (state/*) aynı kalıcı kayıtları
 * kullanır ve buradaki değişiklikleri `onF9HookChange` ile öğrenir.
 *
 * Yaklaşma ("Neredeyse vardım (1 dk)", core `approachReduce`):
 *  - Tek etkin hedef (`konum.bg.destination.v1`) tüm ARKADAŞ paylaşım oturumlarına uygulanır; durum oturum başına.
 *  - Tetik: önce KALICI yazılır (`fired` + bekleyen rapor), sonra `approach_report` (4 sn yarış). Ağ yoksa bağlantı
 *    gelince (`flushPending`) `APPROACH_LIMITS.maxReportAgeMs` (2 dk) içinde aynı op_id ile denenir, sonra düşer.
 *  - Paket alanları: `dest_name`, `dest_state` (oturumların en ilerisi), `dest_eta` (yalnızca near). Koordinat YOK.
 * Fotoğraf: etkin fotoğrafım (`konum.bg.proof.v1`) süresi dolmadıysa `photo_id` + `photo_exp`.
 * Güvenli Dönüş:
 *  - En sık `SAFE_RETURN_LIMITS.updateMinIntervalMs` (60 sn) `safe_return_update` (son doğrulanmış konum + pil).
 *  - Hedef koordinatı varsa varış yarıçapına (dışarıdan) girince otomatik `safe_return_check_in {reason:'arrived'}`
 *    (önce kalıcı `arrived_pending`, aynı op_id ile yeniden denenir). Kayıtlı bölge hedefinde Faz 5 bölge izleyicisinin
 *    varış kararı da aynı yolu çağırır (`onZoneArrive`).
 *  - Yayın kesme anahtarı (görünmez / onay kapısı) Güvenli Dönüş'ü durdurmaz (kayıt yalnızca sahibine açık), yaklaşma
 *    raporunu durdurur.
 */
import {
  APPROACH_LIMITS,
  approachReduce,
  SAFE_RETURN_LIMITS,
  type ActivityState,
  type ApproachSample,
  type ApproachState,
  type ApproachStep,
  type DestState,
  type EpochMs,
  type PacketExtras,
  type SafeReturnDoc,
  type SafeReturnFix,
  type SessionId,
  type UserId,
  uuidV4,
} from '@konum/core';
import { toKonumError } from '../../lib/errors';
import {
  loadDestination,
  loadLastFix,
  loadProof,
  loadSafeReturn,
  saveDestination,
  saveSafeReturn,
  type PersistedDestination,
  type PersistedLastFix,
  type PersistedProof,
  type PersistedSafeReturn,
} from '../../state/persist';
import { approachApi, safeReturnApi, type ApproachApi, type SafeReturnApi } from '../firebase/callables';
import { isConnected } from '../firebase/liveRepo';
import { getServerOffsetMs, now as serverNow } from '../../lib/clock';
import { cancelSafeReturnLocal, formatContactNames, scheduleSafeReturnLocal } from '../notifications/safeReturnNotifications';
import { isPublishHeld } from '../../state/publishHold';

export type F9Extras = Pick<PacketExtras, 'photo_id' | 'photo_exp' | 'dest_name' | 'dest_state' | 'dest_eta'>;

export type F9HookEvent =
  | { kind: 'destination' }
  /** Sunucu yanıtı (check-in / güncelleme) ya da kaydın sonu (`doc: null`: etkin değil). */
  | { kind: 'safe_return'; doc: SafeReturnDoc | null };

export interface F9SampleInput {
  uid: UserId;
  /** Sunucu saatinde normalize örnek. */
  sample: { lat: number; lng: number; accuracy: number; speed_mps: number | null; timestamp: EpochMs };
  activity: ActivityState;
  now: EpochMs;
  /** Etkin arkadaş paylaşım oturumları (bağlantılar hariç). */
  sessionIds: readonly SessionId[];
  battery_pct: number | null;
  is_charging: boolean | null;
}

export interface F9HookDeps {
  loadProof: () => Promise<PersistedProof | null>;
  loadDestination: () => Promise<PersistedDestination | null>;
  saveDestination: (v: PersistedDestination | null) => Promise<void>;
  loadSafeReturn: () => Promise<PersistedSafeReturn | null>;
  saveSafeReturn: (v: PersistedSafeReturn | null) => Promise<void>;
  loadLastFix: () => Promise<PersistedLastFix | null>;
  approach: Pick<ApproachApi, 'approachReport'>;
  safeReturn: Pick<SafeReturnApi, 'safeReturnUpdate' | 'safeReturnCheckIn'>;
  isOnline: () => boolean;
  isHeld: () => boolean;
  newOpId: () => string;
  /** Kayıt bitince yerel bildirimler kaldırılır. */
  cancelLocal: (safeReturnId: string) => Promise<void>;
  /** Süre değişince (uzatma) yerel bildirimler yeniden planlanır. `names`: "Annem ve Babam". */
  scheduleLocal: (doc: SafeReturnDoc, names: string) => Promise<void>;
  /** Callable'ın konum hattını en çok bekletme süresi. */
  callTimeoutMs: number;
}

export interface F9Hooks {
  /** Konum hattı her örnekte (arkadaş paylaşımı varken): yaklaşma + Güvenli Dönüş; paket alanlarını döner. */
  onSample(input: F9SampleInput): Promise<F9Extras>;
  /** Yalnızca fotoğraf alanları (bağlantı yok / hedef yok). */
  proofExtras(uid: UserId, now: EpochMs): Promise<F9Extras>;
  /** Paylaşım olmadan da (ön plan izleyicisi): Güvenli Dönüş konum tazeleme + varış. */
  onSafeReturnSample(input: Omit<F9SampleInput, 'sessionIds'>): Promise<void>;
  /** Faz 5 bölge izleyicisi: kayıtlı bölgeye varış kararı. */
  onZoneArrive(zoneId: string, now: EpochMs): Promise<void>;
  /** Bağlantı geldi / öne gelindi: bekleyen yaklaşma raporu ve varış check-in'i. */
  flushPending(now: EpochMs): Promise<void>;
  /**
   * Depo dışından gelen Güvenli Dönüş yanıtı (başsız bildirim eylemi: Güvendeyim / +15 dk): kalıcı kayıt güncellenir
   * (bittiyse silinir), yerel bildirimler yeniden planlanır ve depolara duyurulur.
   */
  applySafeReturn(doc: SafeReturnDoc): Promise<void>;
  onChange(l: (e: F9HookEvent) => void): () => void;
}

const RANK: Record<DestState, number> = { en_route: 0, near: 1, arrived: 2 };

const defaultDeps = (): F9HookDeps => ({
  loadProof,
  loadDestination,
  saveDestination,
  loadSafeReturn,
  saveSafeReturn,
  loadLastFix,
  approach: approachApi,
  safeReturn: safeReturnApi,
  isOnline: isConnected,
  isHeld: isPublishHeld,
  newOpId: uuidV4,
  cancelLocal: (id) => cancelSafeReturnLocal(id),
  scheduleLocal: (doc, names) => scheduleSafeReturnLocal(doc, serverNow(), getServerOffsetMs(), names),
  callTimeoutMs: 4_000,
});

/** Fotoğraf paket alanları (süresi dolmuşsa / başka hesabınsa boş). Saf. */
export function proofExtrasOf(p: PersistedProof | null, uid: UserId, now: EpochMs): F9Extras {
  if (!p || p.uid !== uid || p.expires_at <= now) return {};
  return { photo_id: p.proof_id, photo_exp: p.expires_at };
}

/** Yayın zorlama anahtarı (not anahtarına eklenir): fotoğraf / hedef değişince alıcı hemen görsün. Saf. */
export function f9ExtrasKey(x: F9Extras): string {
  const parts: string[] = [];
  if (x.photo_id) parts.push(`p:${x.photo_id}`);
  if (x.dest_name && x.dest_state) parts.push(`d:${x.dest_name}:${x.dest_state}:${x.dest_eta ?? ''}`);
  return parts.join('|');
}

/** Varış yalnızca DIŞARIDAN girişte sayılır (zamanlayıcı hedefin içinde başlatıldıysa hemen "vardı" olmasın). */
function wasOutside(prev: ApproachState | null, radiusM: number): boolean {
  return !!prev && prev.last_distance_m !== null && prev.last_distance_m > radiusM;
}

export function createF9Hooks(overrides: Partial<F9HookDeps> = {}): F9Hooks {
  let resolved: F9HookDeps | null = null;
  const deps = (): F9HookDeps => (resolved ??= { ...defaultDeps(), ...overrides });
  const listeners = new Set<(e: F9HookEvent) => void>();
  const emit = (e: F9HookEvent) => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch {
        // dinleyici hatası hattı durdurmasın
      }
    }
  };
  /** Aynı JS bağlamında üst üste (ön plan izleyicisi + konum hattı) çalışmasın. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    const next = chain.then(fn).catch(() => fallback);
    chain = next;
    return next;
  };
  const inflightApproach = new Set<string>();
  const inflightCheckIn = new Set<string>();

  const race = <T>(p: Promise<T>): Promise<T | 'timeout'> =>
    Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), deps().callTimeoutMs))]);

  // --- yaklaşma -----------------------------------------------------------------------------

  async function sendPendingApproach(now: EpochMs): Promise<void> {
    const d = deps();
    const rec = await d.loadDestination();
    const pending = rec?.pending_report;
    if (!rec || !pending) return;
    const drop = async (status: 'dropped' | 'invisible') => {
      const cur = await d.loadDestination();
      if (!cur || cur.pending_report?.request.op_id !== pending.request.op_id) return;
      await d.saveDestination({ ...cur, pending_report: null, last_report: { at: now, status, notified_count: 0 } });
      emit({ kind: 'destination' });
    };
    if (now - pending.created_at > APPROACH_LIMITS.maxReportAgeMs) return drop('dropped');
    if (d.isHeld()) return drop('invisible');
    if (!d.isOnline()) return;
    const opId = pending.request.op_id;
    if (inflightApproach.has(opId)) return;
    inflightApproach.add(opId);
    const call = d.approach
      .approachReport(pending.request)
      .then(async (res) => {
        const cur = await d.loadDestination();
        if (!cur || cur.pending_report?.request.op_id !== opId) return;
        await d.saveDestination({ ...cur, pending_report: null, last_report: { at: now, status: res.status, notified_count: res.notified_count } });
        emit({ kind: 'destination' });
      })
      .catch(async (e: unknown) => {
        // Geçici hata: kayıt kalır (aynı op_id, süre penceresi içinde); kalıcı hata: düşer.
        if (!toKonumError(e).retryable) await drop('dropped');
      })
      .finally(() => inflightApproach.delete(opId));
    await race(call);
  }

  async function runApproach(input: F9SampleInput): Promise<F9Extras> {
    const d = deps();
    const rec = await d.loadDestination();
    if (!rec || rec.uid !== input.uid) return {};
    const ids = [...new Set(input.sessionIds)];
    if (ids.length === 0) return {};
    const dest = rec.destination;
    const s: ApproachSample = {
      lat: input.sample.lat,
      lng: input.sample.lng,
      accuracy: input.sample.accuracy,
      speed_mps: input.sample.speed_mps,
      activity: input.activity,
      at: input.sample.timestamp,
    };
    const approach: Record<SessionId, ApproachState> = {};
    const fired: { sid: SessionId; step: ApproachStep }[] = [];
    let best: ApproachStep | null = null;
    for (const sid of ids) {
      const step = approachReduce(rec.approach[sid] ?? null, s, dest);
      approach[sid] = step.state;
      if (step.fire) fired.push({ sid, step });
      if (!best || RANK[step.dest_state] > RANK[best.dest_state]) best = step;
    }
    let pending = rec.pending_report;
    const firstFire = fired[0]?.step.fire;
    if (firstFire && !d.isHeld()) {
      const prevIds = pending ? pending.request.session_ids : [];
      pending = {
        request: {
          op_id: pending?.request.op_id ?? d.newOpId(),
          session_ids: [...new Set([...prevIds, ...fired.map((f) => f.sid)])].slice(0, 10),
          dest_key: dest.key,
          dest_name: dest.name,
          dest_kind: dest.kind,
          distance_m: Math.min(APPROACH_LIMITS.radiusM * 2, Math.max(0, firstFire.distance_m)),
          eta_min: firstFire.eta_min,
          at: Math.round(firstFire.at),
        },
        created_at: input.now,
      };
    }
    const next: PersistedDestination = { ...rec, approach, pending_report: pending };
    if (JSON.stringify(next) !== JSON.stringify(rec)) {
      // Önce kalıcı: çağrı sürerken gelen örnek ikinci kez tetiklemesin (`fired` kalıcı).
      await d.saveDestination(next);
      emit({ kind: 'destination' });
    }
    if (next.pending_report) await sendPendingApproach(input.now);
    if (!best) return {};
    return { dest_name: dest.name, dest_state: best.dest_state, ...(best.dest_eta !== null ? { dest_eta: best.dest_eta } : {}) };
  }

  // --- Güvenli Dönüş --------------------------------------------------------------------------

  const activeRec = (rec: PersistedSafeReturn | null, uid: UserId | null): rec is PersistedSafeReturn =>
    !!rec && rec.status === 'active' && (uid === null || rec.uid === uid);

  async function endRecord(rec: PersistedSafeReturn, doc: SafeReturnDoc | null): Promise<void> {
    const d = deps();
    const cur = await d.loadSafeReturn();
    if (cur && cur.safe_return_id === rec.safe_return_id) await d.saveSafeReturn(null);
    await d.cancelLocal(rec.safe_return_id).catch(() => undefined);
    emit({ kind: 'safe_return', doc });
  }

  async function sendArrival(rec: PersistedSafeReturn, fix: SafeReturnFix | null): Promise<void> {
    const d = deps();
    const pending = rec.arrived_pending;
    if (!pending || !d.isOnline() || inflightCheckIn.has(pending.op_id)) return;
    inflightCheckIn.add(pending.op_id);
    try {
      const res = await d.safeReturn.safeReturnCheckIn({ op_id: pending.op_id, safe_return_id: rec.safe_return_id, reason: 'arrived', fix });
      await endRecord(rec, res.safe_return);
    } catch (e) {
      const err = toKonumError(e);
      if (err.code === 'safe_return_not_active') await endRecord(rec, null);
      // Geçici hata: `arrived_pending` kalır, sonraki örnekte / bağlantı gelince aynı op_id ile.
    } finally {
      inflightCheckIn.delete(pending.op_id);
    }
  }

  async function runSafeReturn(input: Omit<F9SampleInput, 'sessionIds'>): Promise<void> {
    const d = deps();
    const rec = await d.loadSafeReturn();
    if (!activeRec(rec, input.uid)) return;
    const fix: SafeReturnFix = {
      lat: input.sample.lat,
      lng: input.sample.lng,
      accuracy: Math.min(10_000, Math.max(0, input.sample.accuracy)),
      timestamp: Math.round(input.sample.timestamp),
      battery_pct: input.battery_pct === null ? null : Math.round(input.battery_pct),
      is_charging: input.is_charging,
    };
    let next: PersistedSafeReturn = rec;
    // Varış (hedef koordinatı cihazda varsa).
    const c = rec.destination.center;
    const r = rec.destination.radius_m;
    if (c && r && !rec.arrived_pending) {
      const prev = rec.approach;
      const step = approachReduce(prev, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, speed_mps: input.sample.speed_mps, activity: input.activity, at: fix.timestamp }, { key: `sr:${rec.safe_return_id}`, center: c, radius_m: r });
      const state = { ...step.state };
      const arrived = step.arrived && wasOutside(prev, r);
      if (step.arrived && !arrived) state.arrived_at = null; // içeride başladı: dışarı çıkıp girince sayılır
      next = { ...next, approach: state, ...(arrived ? { arrived_pending: { op_id: d.newOpId(), at: input.now } } : {}) };
    }
    const updateDue =
      !next.arrived_pending &&
      fix.accuracy <= APPROACH_LIMITS.maxAccuracyM &&
      (next.last_update_at === null || input.now - next.last_update_at >= SAFE_RETURN_LIMITS.updateMinIntervalMs) &&
      d.isOnline();
    if (updateDue) next = { ...next, last_update_at: input.now };
    if (next !== rec) await d.saveSafeReturn(next);
    if (next.arrived_pending) {
      await sendArrival(next, fix);
      return;
    }
    if (!updateDue) return;
    try {
      const res = await race(d.safeReturn.safeReturnUpdate({ op_id: d.newOpId(), safe_return_id: next.safe_return_id, fix }));
      if (res !== 'timeout') {
        if (res.safe_return.status !== 'active') await endRecord(next, res.safe_return);
        else emit({ kind: 'safe_return', doc: res.safe_return });
      }
    } catch (e) {
      const err = toKonumError(e);
      if (err.code === 'safe_return_not_active') await endRecord(next, null);
    }
  }

  return {
    onSample: (input) =>
      serial(async () => {
        const proof = proofExtrasOf(await deps().loadProof().catch(() => null), input.uid, input.now);
        const dest = await runApproach(input).catch(() => ({}) as F9Extras);
        await runSafeReturn(input).catch(() => undefined);
        return { ...proof, ...dest };
      }, {} as F9Extras),

    proofExtras: async (uid, now) => proofExtrasOf(await deps().loadProof().catch(() => null), uid, now),

    onSafeReturnSample: (input) => serial(() => runSafeReturn(input), undefined),

    onZoneArrive: (zoneId, now) =>
      serial(async () => {
        const d = deps();
        const rec = await d.loadSafeReturn();
        if (!activeRec(rec, null) || rec.destination.zone_id !== zoneId) return;
        const next: PersistedSafeReturn = rec.arrived_pending ? rec : { ...rec, arrived_pending: { op_id: d.newOpId(), at: now } };
        if (next !== rec) await d.saveSafeReturn(next);
        const last = await d.loadLastFix().catch(() => null);
        const fix: SafeReturnFix | null = last && now - last.timestamp <= SAFE_RETURN_LIMITS.staleFixMs
          ? { lat: last.lat, lng: last.lng, accuracy: last.accuracy, timestamp: last.timestamp, battery_pct: last.battery_pct, is_charging: last.is_charging }
          : null;
        await sendArrival(next, fix);
      }, undefined),

    flushPending: (now) =>
      serial(async () => {
        await sendPendingApproach(now).catch(() => undefined);
        const rec = await deps().loadSafeReturn();
        if (activeRec(rec, null) && rec.arrived_pending) await sendArrival(rec, null);
      }, undefined),

    applySafeReturn: (doc) =>
      serial(async () => {
        const d = deps();
        const rec = await d.loadSafeReturn();
        if (rec && rec.safe_return_id === doc.safe_return_id) {
          if (doc.status !== 'active') {
            await endRecord(rec, doc);
            return;
          }
          await d.saveSafeReturn({ ...rec, due_at: doc.due_at, grace_until: doc.grace_until, extend_count: doc.extend_count, duration_min: doc.duration_min });
          await d.scheduleLocal(doc, rec.contact_label ?? formatContactNames([])).catch(() => undefined);
        } else if (doc.status !== 'active') {
          await d.cancelLocal(doc.safe_return_id).catch(() => undefined);
        }
        emit({ kind: 'safe_return', doc });
      }, undefined),

    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Uygulama genelindeki örnek (konum hattı, bölge izleyicisi, f9Services, depolar). */
export const f9Hooks = createF9Hooks();

/** Kancanın değişiklik olayları (depolar dinler). */
export const onF9HookChange = (l: (e: F9HookEvent) => void): (() => void) => f9Hooks.onChange(l);
