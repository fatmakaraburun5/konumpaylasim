/**
 * Faz 5: bölge algılama çekirdeği (platformdan bağımsız; native `zoneMonitor.ts` ve web demo `zoneMonitor.web.ts`
 * aynı çekirdeği kullanır, testler sahte bağımlılıklarla çalıştırır).
 *
 * Akış (core `zones.ts` sapma filtresi):
 *   OS bölge olayı (aday) → `zoneFilterReduce(os_event)` → taze konum (`getFreshSample`, en çok
 *   `ZONE_FILTER.osEventFixTimeoutMs`) → `zoneFilterReduce(sample)` → hâlâ "bekliyor"sa `minConfirmSpanMs` sonra
 *   İKİNCİ taze konum (arka planda başka örnek gelmeyebilir) → onaylanan geçiş → `zone_event_report`.
 *   Ön plan / Faz 3 arka plan görevi örnekleri de tüm etkin bölgelerin filtresine beslenir (ek GPS yok).
 *
 *  - Filtre durumu bölge başına KALICI (persist.ts `konum.bg.zoneFilter.v1`): süreç ölüp OS olayıyla yeniden
 *    başlasa da aday / bekleme / soğuma bilgisi korunur. Bekleme öncesi durum diske yazılır.
 *  - Rapor önce kalıcı kuyruğa yazılır, sonra gönderilir (`konum.bg.zoneReports.v1`): çevrimdışı / geçici hatada
 *    AYNI op_id ile yeniden denenir (sunucu bir kez uygular). Kalıcı hata (bölge silindi, şema) → atılır.
 *    [Varsayım] Faz 3 `outboxRepo` kuyruğu kullanılmaz: paylaşım bitince tümüyle silinir, bölge olayları ise paylaşım
 *    olmadan da gönderilmelidir.
 *  - Yanıttaki `start_share` için, alıcılardan bana zaten canlı paylaşım almayanlarla `startShare` çağrılır.
 *  - Sunucuya koordinat GİTMEZ: yalnızca bölge kimliği, yön, an ve doğruluk.
 * Zamanlar: filtre cihaz saatiyle (örnek zaman damgaları), rapor `occurred_at` sunucu saatine çevrilir.
 */
import {
  haversineM,
  initialZoneFilterState,
  ZONE_FILTER,
  ZONE_LIMITS,
  zoneFilterReduce,
  type DurationChoice,
  type EpochMs,
  type UserId,
  type ZoneEventReportRequest,
  type ZoneEventReportResponse,
  type ZoneFilterInput,
  type ZoneFilterReason,
  type ZoneFilterState,
  type ZonePresence,
  type ZoneSample,
  type ZoneTrigger,
} from '@konum/core';
import { toKonumError } from '../../lib/errors';
import type { PendingZoneReport, PersistedZone, PersistedZoneFilters, PersistedZoneReports } from '../../state/persist';

export type ZoneSampleSource = 'os_fix' | 'foreground' | 'background' | 'demo';

/** Son filtre kararı (demo paneli ve teşhis; cihazda kalır). */
export interface ZoneDecision {
  zone_id: string;
  zone_name: string;
  input: ZoneFilterInput['type'];
  source: ZoneSampleSource | 'os';
  reason: ZoneFilterReason;
  emit: ZoneTrigger | null;
  presence: ZonePresence;
  at: EpochMs;
  accuracy: number | null;
  /** Bölge merkezine uzaklık (m; yalnızca cihazda). */
  distance_m: number | null;
}

/** Gönderilen (ya da kuyruğa alınan) bölge olayının sonucu. */
export interface ZoneReportOutcome {
  zone_id: string;
  transition: ZoneTrigger;
  /** Sunucu saati. */
  at: EpochMs;
  notified: number;
  suppressed: ZoneEventReportResponse['suppressed'] | 'queued' | 'dropped';
  started_share: UserId[];
}

export interface ZoneMonitorDeps {
  /** Oturumdaki kullanıcı (başsız açılışta kalıcı önbellekten). */
  myUid: () => Promise<UserId | null>;
  loadZones: () => Promise<{ uid: UserId | null; zones: PersistedZone[] }>;
  loadFilters: () => Promise<PersistedZoneFilters>;
  saveFilters: (v: PersistedZoneFilters) => Promise<void>;
  loadReports: () => Promise<PersistedZoneReports>;
  saveReports: (v: PersistedZoneReports) => Promise<void>;
  report: (req: ZoneEventReportRequest & { op_id: string }) => Promise<ZoneEventReportResponse>;
  /** Şu an canlı paylaşımımın gittiği kişiler ("zaten paylaşım yoksa"). */
  sharingWith: () => Promise<ReadonlySet<UserId>>;
  startShare: (recipients: UserId[], duration: DurationChoice) => Promise<boolean>;
  /** Taze yüksek doğruluklu konum (OS olayı sonrası); yoksa null. */
  getFreshSample: (timeoutMs: number) => Promise<ZoneSample | null>;
  /** Cihaz saati → sunucu saati. */
  toServerTime: (deviceMs: EpochMs) => EpochMs;
  deviceNow: () => EpochMs;
  sleep: (ms: number) => Promise<void>;
  newOpId: () => string;
  onDecision?: (d: ZoneDecision) => void;
  onReport?: (o: ZoneReportOutcome) => void;
  onPresence?: (presence: Record<string, ZonePresence>) => void;
}

export interface ZoneMonitorCore {
  /** Ön plan / arka plan görevi / demo örnekleri: tüm etkin bölgelerin filtresine. */
  feedSamples(samples: readonly ZoneSample[], source: ZoneSampleSource): Promise<void>;
  /** OS bölge olayı (aday) → taze konum → onay. */
  handleOsEvent(zoneId: string, event: 'enter' | 'exit', atDevice: EpochMs): Promise<void>;
  /**
   * Hazır girdi dizisini TEK bölgenin filtresinden geçirir (web demo "zaman atlamalı" senaryoları: yürüyüşün
   * örnekleri geriye tarihli oynatılır). Taze konum alınmaz; onaylanan geçiş raporlanır.
   */
  replay(zoneId: string, inputs: readonly ZoneFilterInput[], source: ZoneSampleSource): Promise<void>;
  /** Bekleyen raporları AYNI op_id ile yeniden dene (bağlantı geldi / ön plana dönüş). */
  flushReports(): Promise<void>;
  /** Bölge listesi değişti: silinen bölgelerin filtre durumu ve bekleyen raporu atılır. */
  pruneZones(zoneIds: readonly string[]): Promise<void>;
  /** Bellekteki filtre durumları (teşhis / demo paneli). */
  states(): Readonly<Record<string, ZoneFilterState>>;
  /** Bellek önbelleğini bırakır (çıkış); kalıcı durum ayrıca silinir. */
  reset(): void;
}

/** [Varsayım] OS olayından sonra ikinci taze konum için en çok bu kadar beklenir (iOS bölge olayı ~30 sn süre verir). */
export const SECOND_FIX_MAX_WAIT_MS = 25_000;
/** Kuyruktaki raporun en çok deneme sayısı ve yaşı (sunucu zaten `maxEventAgeMs` sonrası bildirim göndermez). */
const REPORT_MAX_ATTEMPTS = 20;
const REPORT_MAX_AGE_MS = 6 * 60 * 60_000;

export function createZoneMonitorCore(deps: ZoneMonitorDeps): ZoneMonitorCore {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    const next = chain.then(fn).catch((e: unknown) => {
      if (__DEV__) console.warn('[konum] bölge izleme hatası', e);
      return fallback;
    });
    chain = next;
    return next;
  };
  let filters: PersistedZoneFilters | null = null;
  let flushing: Promise<void> | null = null;

  async function context(): Promise<{ uid: UserId; zones: PersistedZone[]; f: PersistedZoneFilters } | null> {
    const uid = await deps.myUid();
    if (!uid) return null;
    const cache = await deps.loadZones();
    if (cache.uid !== uid) return { uid, zones: [], f: { uid, states: {} } };
    if (!filters || filters.uid !== uid) {
      const loaded = await deps.loadFilters();
      filters = loaded.uid === uid ? loaded : { uid, states: {} };
    }
    return { uid, zones: cache.zones.filter((z) => z.enabled), f: filters };
  }

  const presenceOf = (f: PersistedZoneFilters, zones: readonly PersistedZone[]): Record<string, ZonePresence> => {
    const out: Record<string, ZonePresence> = {};
    for (const z of zones) out[z.zone_id] = f.states[z.zone_id]?.presence ?? 'unknown';
    return out;
  };

  /** Tek girdi → filtre; karar yayınlanır. Dönen: onaylanan tetik. */
  function step(f: PersistedZoneFilters, z: PersistedZone, input: ZoneFilterInput, source: ZoneDecision['source']): ZoneTrigger | null {
    const prev: ZoneFilterState = f.states[z.zone_id] ?? initialZoneFilterState();
    const r = zoneFilterReduce(z, prev, input);
    f.states[z.zone_id] = r.state;
    const s = input.type === 'sample' ? input.sample : null;
    deps.onDecision?.({
      zone_id: z.zone_id,
      zone_name: z.name,
      input: input.type,
      source,
      reason: r.reason,
      emit: r.emit,
      presence: r.state.presence,
      at: s ? s.at : input.type === 'os_event' ? input.at : deps.deviceNow(),
      accuracy: s ? s.accuracy : null,
      distance_m: s ? Math.round(haversineM(z.center, s)) : null,
    });
    return r.emit;
  }

  async function persistFilters(f: PersistedZoneFilters, zones: readonly PersistedZone[]): Promise<void> {
    await deps.saveFilters(f);
    deps.onPresence?.(presenceOf(f, zones));
  }

  // --- raporlar --------------------------------------------------------------------------------

  async function queueReport(uid: UserId, r: PendingZoneReport): Promise<void> {
    const cur = await deps.loadReports();
    const reports = cur.uid === uid ? cur.reports : [];
    if (reports.some((x) => x.op_id === r.op_id)) return;
    await deps.saveReports({ uid, reports: [...reports, r] });
  }

  async function removeReport(uid: UserId, opId: string, update?: PendingZoneReport): Promise<void> {
    const cur = await deps.loadReports();
    if (cur.uid !== uid) return;
    const reports = cur.reports.flatMap((x) => (x.op_id !== opId ? [x] : update ? [update] : []));
    await deps.saveReports({ uid, reports });
  }

  async function handleResponse(r: PendingZoneReport, res: ZoneEventReportResponse): Promise<void> {
    const started: UserId[] = [];
    const already = res.start_share.length ? await deps.sharingWith().catch(() => new Set<UserId>()) : new Set<UserId>();
    for (const s of res.start_share) {
      const recipients = [...new Set(s.recipient_ids)].filter((u) => !already.has(u) && !started.includes(u));
      if (recipients.length === 0) continue;
      try {
        if (await deps.startShare(recipients, s.duration)) started.push(...recipients);
      } catch {
        // paylaşım başlatılamadı: bildirim yine gitti; kullanıcı elle başlatabilir
      }
    }
    deps.onReport?.({ zone_id: r.zone_id, transition: r.transition, at: r.occurred_at, notified: res.notified, suppressed: res.suppressed, started_share: started });
  }

  /** Tek raporu gönder. Dönen: kuyrukta kaldı mı. */
  async function send(uid: UserId, r: PendingZoneReport): Promise<boolean> {
    let res: ZoneEventReportResponse;
    try {
      res = await deps.report({ op_id: r.op_id, zone_id: r.zone_id, transition: r.transition, occurred_at: r.occurred_at, accuracy_m: r.accuracy_m });
    } catch (e) {
      const err = toKonumError(e);
      if (err.retryable && r.attempts + 1 < REPORT_MAX_ATTEMPTS) {
        await removeReport(uid, r.op_id, { ...r, attempts: r.attempts + 1 });
        if (r.attempts === 0) deps.onReport?.({ zone_id: r.zone_id, transition: r.transition, at: r.occurred_at, notified: 0, suppressed: 'queued', started_share: [] });
        return true;
      }
      await removeReport(uid, r.op_id);
      deps.onReport?.({ zone_id: r.zone_id, transition: r.transition, at: r.occurred_at, notified: 0, suppressed: 'dropped', started_share: [] });
      return false;
    }
    await removeReport(uid, r.op_id);
    await handleResponse(r, res);
    return false;
  }

  async function report(uid: UserId, z: PersistedZone, transition: ZoneTrigger, s: ZoneSample): Promise<void> {
    const r: PendingZoneReport = {
      op_id: deps.newOpId(),
      zone_id: z.zone_id,
      transition,
      occurred_at: Math.round(deps.toServerTime(s.at)),
      accuracy_m: Number.isFinite(s.accuracy) ? Math.min(5_000, Math.max(0, Math.round(s.accuracy))) : null,
      created_at: deps.deviceNow(),
      attempts: 0,
    };
    // Önce kalıcı kuyruk: gönderim sırasında süreç ölse de olay kaybolmaz (aynı op_id ile yeniden denenir).
    await queueReport(uid, r);
    await send(uid, r);
  }

  async function flushNow(): Promise<void> {
    const uid = await deps.myUid();
    if (!uid) return;
    const cur = await deps.loadReports();
    if (cur.uid !== uid) {
      if (cur.reports.length) await deps.saveReports({ uid, reports: [] });
      return;
    }
    const t = deps.deviceNow();
    const fresh = cur.reports.filter((r) => t - r.created_at <= REPORT_MAX_AGE_MS);
    if (fresh.length !== cur.reports.length) await deps.saveReports({ uid, reports: fresh });
    for (const r of fresh) {
      // İlk geçici hatada dur: bağlantı yok, sıradakiler de başarısız olur.
      if (await send(uid, r)) break;
    }
  }

  // --- girişler ----------------------------------------------------------------------------------

  async function processSamples(samples: readonly ZoneSample[], source: ZoneSampleSource): Promise<void> {
    const ctx = await context();
    if (!ctx || ctx.zones.length === 0) return;
    const sorted = [...samples].filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)).sort((a, b) => a.at - b.at);
    if (sorted.length === 0) return;
    const emits: { z: PersistedZone; t: ZoneTrigger; s: ZoneSample }[] = [];
    for (const z of ctx.zones) {
      for (const s of sorted) {
        const t = step(ctx.f, z, { type: 'sample', sample: s }, source);
        if (t) emits.push({ z, t, s });
      }
    }
    await persistFilters(ctx.f, ctx.zones);
    for (const e of emits) await report(ctx.uid, e.z, e.t, e.s);
  }

  async function processOsEvent(zoneId: string, event: 'enter' | 'exit', atDevice: EpochMs): Promise<void> {
    const ctx = await context();
    if (!ctx) return;
    const z = ctx.zones.find((x) => x.zone_id === zoneId);
    if (!z) return; // silinmiş / kapalı bölge: OS kaydı bir sonraki eşitlemede kalkar
    step(ctx.f, z, { type: 'os_event', event, at: atDevice }, 'os');
    await persistFilters(ctx.f, ctx.zones);
    const st = ctx.f.states[z.zone_id];
    if (!st?.candidate) return; // zaten o tarafta (no_change)
    const first = await deps.getFreshSample(ZONE_FILTER.osEventFixTimeoutMs);
    if (!first) return; // konum yok: aday kalıcı, sonraki örnek karar verir
    const t1 = step(ctx.f, z, { type: 'sample', sample: first }, 'os_fix');
    await persistFilters(ctx.f, ctx.zones);
    if (t1) {
      await report(ctx.uid, z, t1, first);
      return;
    }
    // Hâlâ bekliyor: arka planda başka örnek gelmeyebilir → `minConfirmSpanMs` sonra ikinci taze konum.
    const cand = ctx.f.states[z.zone_id]?.candidate;
    if (!cand) return;
    const waitMs = cand.since + ZONE_FILTER.minConfirmSpanMs + 1_000 - deps.deviceNow();
    if (waitMs > SECOND_FIX_MAX_WAIT_MS) return;
    if (waitMs > 0) await deps.sleep(waitMs);
    const second = await deps.getFreshSample(ZONE_FILTER.osEventFixTimeoutMs);
    if (!second) return;
    const t2 = step(ctx.f, z, { type: 'sample', sample: second }, 'os_fix');
    await persistFilters(ctx.f, ctx.zones);
    if (t2) await report(ctx.uid, z, t2, second);
  }

  async function processReplay(zoneId: string, inputs: readonly ZoneFilterInput[], source: ZoneSampleSource): Promise<void> {
    const ctx = await context();
    const z = ctx?.zones.find((x) => x.zone_id === zoneId);
    if (!ctx || !z) return;
    const emits: { t: ZoneTrigger; s: ZoneSample }[] = [];
    for (const input of inputs) {
      const t = step(ctx.f, z, input, input.type === 'sample' ? source : 'os');
      if (t && input.type === 'sample') emits.push({ t, s: input.sample });
    }
    await persistFilters(ctx.f, ctx.zones);
    for (const e of emits) await report(ctx.uid, z, e.t, e.s);
  }

  return {
    feedSamples: (samples, source) => enqueue(() => processSamples(samples, source), undefined),
    replay: (zoneId, inputs, source) => enqueue(() => processReplay(zoneId, inputs, source), undefined),
    // OS olayı (ikinci konum beklemesi dahil) sırada işlenir; bu arada gelen örnekler arkasından işlenir.
    handleOsEvent: (zoneId, event, at) => enqueue(() => processOsEvent(zoneId, event, at), undefined),
    flushReports: () => {
      flushing ??= enqueue(() => flushNow(), undefined).finally(() => {
        flushing = null;
      });
      return flushing;
    },
    pruneZones: (zoneIds) =>
      enqueue(async () => {
        const keep = new Set(zoneIds);
        const uid = await deps.myUid();
        if (!uid) return;
        const f = filters && filters.uid === uid ? filters : await deps.loadFilters();
        if (f.uid === uid) {
          let changed = false;
          for (const id of Object.keys(f.states)) {
            if (!keep.has(id)) {
              delete f.states[id];
              changed = true;
            }
          }
          filters = f;
          if (changed) await deps.saveFilters(f);
        }
        const cur = await deps.loadReports();
        if (cur.uid === uid && cur.reports.some((r) => !keep.has(r.zone_id))) {
          await deps.saveReports({ uid, reports: cur.reports.filter((r) => keep.has(r.zone_id)) });
        }
      }, undefined),
    states: () => ({ ...(filters?.states ?? {}) }),
    reset: () => {
      filters = null;
    },
  };
}

/** iOS toplam 20 bölge: uyku çiti + en çok `maxZones` bölge (core). OS'a kaydedilecek bölgeler (etkin, en yakın önce). */
export function zonesForOs<T extends PersistedZone>(zones: readonly T[], near: { lat: number; lng: number } | null): T[] {
  const enabled = zones.filter((z) => z.enabled);
  if (!near) return enabled.slice(0, ZONE_LIMITS.maxZones);
  return [...enabled].sort((a, b) => haversineM(near, a.center) - haversineM(near, b.center)).slice(0, ZONE_LIMITS.maxZones);
}

/** OS bölge kimliği: uyku çitinden (`konum-sleep`) ayrışsın diye önekli. */
export const ZONE_REGION_PREFIX = 'konum-zone:';
export const zoneRegionId = (zoneId: string): string => `${ZONE_REGION_PREFIX}${zoneId}`;
export const zoneIdFromRegion = (identifier: string | null | undefined): string | null =>
  identifier && identifier.startsWith(ZONE_REGION_PREFIX) ? identifier.slice(ZONE_REGION_PREFIX.length) : null;
