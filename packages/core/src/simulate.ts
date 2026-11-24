/**
 * Faz 3: deterministik simülasyon düzeneği.
 *
 * Sentetik bir iz (trace) üzerinde hareket makinesi + takip matrisi + `shouldPublish` + çevrimdışı kuyruk +
 * düşük pil tetikleyicisi + alıcı durumu birlikte koşturulur. Cihaz/ağ davranışı basit modellerdir:
 *  - OS etkinlik tanıma gerçek etkinliği `osActivityLatencyMs` gecikmeyle, yüksek güvenle bildirir.
 *  - Uyku çiti çıkışı, gerçek konum yarıçapı aştıktan `geofenceLatencyMs` sonra gelir.
 *  - GPS örnekleri plan satırındaki aralık + mesafe filtresiyle üretilir; gürültü doğrulukla sınırlıdır.
 *  - GPS kapalıyken (sabit) kalp atışı zamanında tek seferlik düşük güçlü ölçüm alınır.
 *  - Toplu teslim (`deferMs`) modellenmez (gönderim sayısını değiştirmez, yalnızca uyanma sayısını düşürür).
 * Sonuçlar pil tüketimi ölçümü DEĞİLDİR; sahada ölçülecek göstergelerin (GPS örnek sayısı, gönderim,
 * uyku oranı) göreli karşılaştırmasıdır.
 */
import { shouldPublish, type AppPhase, type LastPublished } from './cadence';
import type { ShareMode } from './duration';
import { haversineM, roundCoord, type LatLng } from './geo';
import { lowBatteryTrigger, type LowBatteryState } from './battery';
import { initialMotion, motionReducer, motionToActivity, type MotionEvent, type MotionMachine, type MotionState, MOTION_STATES } from './motion';
import { ackOutbox, emptyOutbox, enqueueOutbox, planFlush, type OutboxState, type OutboxTarget } from './outbox';
import type { ActivityState, NormalizedSample } from './packet';
import { RECEIVER_STATUSES, receiverStatusOf, type ReceiverStatus } from './receiverStatus';
import { DAY, HOUR, MINUTE, SECOND, type EpochMs } from './time';
import { needsHeartbeatAnnounce, selectTrackingPlan, type BatteryBand, type TrackingPlan } from './trackingMatrix';

export type TraceKind = 'still' | 'walk' | 'run' | 'cycle' | 'drive' | 'highway';

export interface TraceSegment {
  kind: TraceKind;
  durationMs: number;
  /** Varsayılan: türe göre (yürüme 1,4 m/s, araç 12 m/s, otoyol 25 m/s …). */
  speedMps?: number;
  /** Gerçek kuzeye göre derece. */
  headingDeg?: number;
  /** İnternet var mı (varsayılan true). */
  online?: boolean;
  /** Konum alınabiliyor mu (tünel: false; varsayılan true). */
  gps?: boolean;
  /** Bölüm başı/sonu pil yüzdesi (doğrusal). Verilmezse önceki değer korunur. */
  battery?: [number, number];
  charging?: boolean;
  appPhase?: AppPhase;
}

export interface Trace {
  name: string;
  startAt: EpochMs;
  origin: LatLng;
  shareMode: ShareMode;
  expiresAt: EpochMs | null;
  segments: TraceSegment[];
  seed?: number;
}

export interface SimOptions {
  osActivityLatencyMs?: number;
  geofenceLatencyMs?: number;
  canUseGeofence?: boolean;
  /** Ek olarak bir QR bağlantısı hedefi (iz yazılmaz, yalnızca canlı). */
  withLink?: boolean;
}

export interface SimReport {
  name: string;
  durationMs: number;
  /** İşletim sisteminin teslim ettiği sürekli GPS örnekleri. */
  gpsFixes: number;
  /** Kalp atışı / önemli değişiklik için tek seferlik düşük güçlü ölçümler. */
  oneShotFixes: number;
  /** Canlı düğüm yazmaları (kuyruktan gelen canlı yazma dahil). */
  sends: number;
  trailWrites: number;
  queuedTotal: number;
  queuedMax: number;
  syncedPoints: number;
  lostPoints: number;
  thinnedPoints: number;
  droppedForEndedTargets: number;
  lowBatteryAlerts: number;
  lowBatteryAlertAt: EpochMs[];
  /** GPS kapalı (uyku) geçen dakika. */
  sleepMinutes: number;
  /** Uyku dakikası / etkin paylaşım dakikası. */
  sleepShare: number;
  sendsPerHour: number;
  maxSilenceMs: number;
  transitions: number;
  motionMinutes: Record<MotionState, number>;
  /** Alıcının her dakika gördüğü durum. */
  receiverMinutes: Record<ReceiverStatus, number>;
}

const SPEED: Record<TraceKind, number> = { still: 0, walk: 1.4, run: 3, cycle: 5.5, drive: 12, highway: 25 };
const OS_ACTIVITY: Record<TraceKind, ActivityState> = {
  still: 'still',
  walk: 'walking',
  run: 'running',
  cycle: 'cycling',
  drive: 'automotive',
  highway: 'automotive',
};

/** mulberry32: küçük, deterministik PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG_LAT = 111_320;
function move(p: LatLng, headingDeg: number, meters: number): LatLng {
  const h = (headingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(h)) / M_PER_DEG_LAT;
  const dLng = (meters * Math.sin(h)) / (M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

export function simulateTrace(trace: Trace, options: SimOptions = {}): SimReport {
  const osLatency = options.osActivityLatencyMs ?? 45 * SECOND;
  const fenceLatency = options.geofenceLatencyMs ?? 60 * SECOND;
  const rand = prng(trace.seed ?? 7);
  const totalMs = trace.segments.reduce((s, x) => s + x.durationMs, 0);
  const endAt = trace.expiresAt === null ? trace.startAt + totalMs : Math.min(trace.startAt + totalMs, trace.expiresAt);

  const share: OutboxTarget = {
    kind: 'share',
    share_id: 'sender_receiver',
    receiver_id: 'receiver',
    share_mode: trace.shareMode,
    expires_at: trace.expiresAt,
    started_at: trace.startAt,
  };
  const link: OutboxTarget | null = options.withLink
    ? { kind: 'link', token_hash: 'h'.repeat(43), share_mode: trace.shareMode, expires_at: trace.expiresAt, sender_name: 'Ayşe', started_at: trace.startAt }
    : null;
  const targets = (): OutboxTarget[] => (link ? [share, link] : [share]);

  const report: SimReport = {
    name: trace.name,
    durationMs: endAt - trace.startAt,
    gpsFixes: 0,
    oneShotFixes: 0,
    sends: 0,
    trailWrites: 0,
    queuedTotal: 0,
    queuedMax: 0,
    syncedPoints: 0,
    lostPoints: 0,
    thinnedPoints: 0,
    droppedForEndedTargets: 0,
    lowBatteryAlerts: 0,
    lowBatteryAlertAt: [],
    sleepMinutes: 0,
    sleepShare: 0,
    sendsPerHour: 0,
    maxSilenceMs: 0,
    transitions: 0,
    motionMinutes: Object.fromEntries(MOTION_STATES.map((s) => [s, 0])) as Record<MotionState, number>,
    receiverMinutes: Object.fromEntries(RECEIVER_STATUSES.map((s) => [s, 0])) as Record<ReceiverStatus, number>,
  };

  let t = trace.startAt;
  let pos: LatLng = { ...trace.origin };
  let machine: MotionMachine = initialMotion(t);
  let battery: number | null = trace.segments[0]?.battery?.[0] ?? null;
  let prevBand: BatteryBand | undefined;
  let lowState: LowBatteryState | null = null;
  let outbox: OutboxState = emptyOutbox();
  let last: LastPublished | null = null;
  let lastOsFixAt = -Infinity;
  let lastDelivered: LatLng | null = null;
  let lastPlanKey = '';
  let pendingActivity: { activity: ActivityState; at: EpochMs } | null = null;
  let fenceExitAt: EpochMs | null = null;
  let wasOnline = true;
  let lastSentHb: number | null = null;
  let sleepMs = 0;
  let nextMinute = trace.startAt + MINUTE;
  const recv = { ts: null as EpochMs | null, serverTs: null as EpochMs | null, hb: null as number | null };

  const step = (ev: MotionEvent) => {
    const r = motionReducer(machine, ev, t);
    if (r.transition) report.transitions++;
    machine = r.machine;
    if (r.setGeofence || r.clearGeofence) fenceExitAt = null;
  };
  const plan = (seg: TraceSegment): TrackingPlan => {
    const p = selectTrackingPlan({
      hasActiveOutgoingShare: t < endAt,
      appPhase: seg.appPhase ?? 'background',
      motion: machine.state,
      batteryPct: battery,
      isCharging: seg.charging ?? false,
      prevBattery: prevBand,
      canUseGeofence: options.canUseGeofence ?? true,
    });
    prevBand = p.battery;
    return p;
  };

  const flush = () => {
    if (outbox.points.length === 0) return;
    const fp = planFlush(outbox, targets(), t);
    report.droppedForEndedTargets += fp.drop.length;
    for (const w of fp.liveWrites) {
      if (w.target.kind !== 'share') continue; // bağlantı canlı yazması ayrı çağrı; sayım arkadaş hedefi üzerinden
      if (recv.ts === null || w.point.timestamp > recv.ts) {
        recv.ts = w.point.timestamp;
        recv.hb = w.point.hb;
      }
      report.sends++;
    }
    let acked = [...fp.drop, ...fp.liveOnlyPointIds];
    for (const b of fp.trailBatches) {
      report.trailWrites += b.writes.length;
      acked = acked.concat(b.pointIds);
    }
    report.syncedPoints += acked.length - fp.drop.length;
    outbox = ackOutbox(outbox, acked);
    recv.serverTs = t;
  };

  let segIdx = 0;
  let segStart = trace.startAt;
  let prevKind: TraceKind | null = null;

  while (t < endAt && segIdx < trace.segments.length) {
    const seg = trace.segments[segIdx] as TraceSegment;
    const segEnd = segStart + seg.durationMs;
    if (seg.kind !== prevKind) {
      pendingActivity = { activity: OS_ACTIVITY[seg.kind], at: t + osLatency };
      prevKind = seg.kind;
    }
    const online = seg.online ?? true;
    const gpsAvail = seg.gps ?? true;

    // Pil (OS tam sayı yüzde bildirir).
    if (seg.battery) {
      const f = seg.durationMs > 0 ? (t - segStart) / seg.durationMs : 0;
      battery = Math.round(seg.battery[0] + (seg.battery[1] - seg.battery[0]) * f);
    }
    const lb = lowBatteryTrigger(lowState, battery, seg.charging ?? false, t);
    lowState = lb.state;
    if (lb.fire) {
      report.lowBatteryAlerts++;
      report.lowBatteryAlertAt.push(t);
    }

    // OS etkinliği ve uyku çiti olayları.
    if (pendingActivity && t >= pendingActivity.at) {
      step({ type: 'activity', activity: pendingActivity.activity, confidence: 'high', at: t });
      pendingActivity = null;
    }
    if (machine.geofence) {
      if (haversineM(pos, machine.geofence) > machine.geofence.radiusM) {
        fenceExitAt ??= t + fenceLatency;
        if (t >= fenceExitAt) step({ type: 'geofence_exit', at: t });
      }
    }
    step({ type: 'tick', at: t });

    // Bağlantı geri geldi: kuyruğu boşalt.
    if (online && !wasOnline) flush();
    wasOnline = online;

    let p = plan(seg);
    const key = `${p.row.gps}|${p.row.osIntervalMs}|${p.row.distanceFilterM}`;
    if (key !== lastPlanKey) {
      lastOsFixAt = -Infinity; // plan değişti: OS güncellemeleri yeniden başlar, kısa sürede örnek gelir
      lastPlanKey = key;
    }

    // Kalp atışı uzadıysa (sabite geçiş, düşük pil) alıcıya yeni `hb` hemen bildirilir.
    const announce = needsHeartbeatAnnounce(lastSentHb, p);

    // Örnek üretimi.
    let fix: { lat: number; lng: number; accuracy: number; speed: number | null } | null = null;
    if (p.active && gpsAvail) {
      const speed = seg.speedMps ?? SPEED[seg.kind];
      const noisy = (acc: number) => {
        const r = acc * 0.8 * rand();
        const a = rand() * 360;
        const q = move(pos, a, r);
        return { lat: roundCoord(q.lat), lng: roundCoord(q.lng), accuracy: acc, speed: speed > 0 ? speed * (0.95 + 0.1 * rand()) : 0.2 * rand() };
      };
      const baseAcc = p.row.gps === 'high' ? 5 : p.row.gps === 'balanced' ? 15 : 50;
      const acc = seg.kind === 'still' ? Math.max(baseAcc, 20) : baseAcc;
      if (p.row.gps !== 'off' && p.row.osIntervalMs > 0 && t - lastOsFixAt >= p.row.osIntervalMs) {
        lastOsFixAt = t;
        const cand = noisy(acc);
        if (!lastDelivered || haversineM(lastDelivered, cand) >= p.row.distanceFilterM) {
          fix = cand;
          report.gpsFixes++;
        }
      }
      if (!fix && p.row.significantChanges && lastDelivered && haversineM(lastDelivered, pos) >= 500) {
        fix = noisy(100);
        report.oneShotFixes++;
      }
      if (!fix && (!last || t - last.sent_at >= p.row.heartbeatMs || announce)) {
        fix = noisy(35);
        report.oneShotFixes++;
      }
    }

    if (fix) {
      lastDelivered = fix;
      step({ type: 'fix', lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, speed_mps: fix.speed, at: t });
      p = plan(seg);
      const sample: NormalizedSample = { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, speed_mps: fix.speed, heading: null, timestamp: t, mocked: false };
      const activity = motionToActivity(machine.state);
      const d = shouldPublish(last, { sample, battery_pct: battery, activity }, p.profile, t, needsHeartbeatAnnounce(lastSentHb, p));
      if (d.publish) {
        last = { lat: fix.lat, lng: fix.lng, sent_at: t, battery_pct: battery, activity };
        lastSentHb = p.row.heartbeatMs;
        if (online) {
          flush();
          report.sends++;
          recv.ts = t;
          recv.serverTs = t;
          recv.hb = p.row.heartbeatMs;
        } else {
          outbox = enqueueOutbox(
            outbox,
            {
              lat: fix.lat,
              lng: fix.lng,
              accuracy: fix.accuracy,
              speed_mps: fix.speed,
              heading: null,
              activity_state: activity,
              battery_pct: battery,
              is_charging: seg.charging ?? false,
              timestamp: t,
              recorded_at: t,
              hb: p.row.heartbeatMs,
            },
            targets(),
            t,
          );
          report.queuedTotal++;
          report.queuedMax = Math.max(report.queuedMax, outbox.points.length);
        }
      }
    }

    // Adım uzunluğu: GPS kapalıyken 30 sn, açıkken OS aralığı (1–10 sn).
    const dt = Math.max(
      SECOND,
      Math.min(p.row.gps === 'off' ? 30 * SECOND : Math.min(10 * SECOND, Math.max(SECOND, p.row.osIntervalMs)), segEnd - t),
    );
    if (p.active && p.row.gps === 'off') sleepMs += dt;
    report.motionMinutes[machine.state] += dt / MINUTE;

    // Gerçek konumu ilerlet.
    const speed = seg.speedMps ?? SPEED[seg.kind];
    if (speed > 0) pos = move(pos, seg.headingDeg ?? 90, (speed * dt) / SECOND);
    t += dt;

    // Alıcı durumu, dakikada bir.
    while (nextMinute <= t && nextMinute <= endAt) {
      if (recv.serverTs !== null && recv.ts !== null) {
        const st = receiverStatusOf({ timestamp: recv.ts, server_ts: recv.serverTs, hb: recv.hb }, nextMinute);
        report.receiverMinutes[st]++;
        report.maxSilenceMs = Math.max(report.maxSilenceMs, nextMinute - recv.serverTs);
      }
      nextMinute += MINUTE;
    }

    if (t >= segEnd) {
      segIdx++;
      segStart = segEnd;
    }
  }

  // Son durum: çevrimiçiyse kuyruğu boşalt.
  const lastSeg = trace.segments[Math.min(segIdx, trace.segments.length - 1)];
  if (lastSeg && (lastSeg.online ?? true)) flush();

  report.lostPoints = outbox.lost + (lastSeg && !(lastSeg.online ?? true) ? 0 : outbox.points.length);
  report.thinnedPoints = outbox.thinned;
  const activeMin = report.durationMs / MINUTE;
  report.sleepMinutes = Math.round(sleepMs / MINUTE);
  report.sleepShare = activeMin > 0 ? sleepMs / MINUTE / activeMin : 0;
  report.sendsPerHour = report.durationMs > 0 ? report.sends / (report.durationMs / HOUR) : 0;
  for (const s of MOTION_STATES) report.motionMinutes[s] = Math.round(report.motionMinutes[s]);
  return report;
}

// ---------------------------------------------------------------------------
// Hazır izler
// ---------------------------------------------------------------------------

/** 24.11.2026 00:00 Europe/Istanbul. */
export const SIM_START = Date.UTC(2026, 10, 23, 21, 0, 0);
const ISTANBUL: LatLng = { lat: 41.0082, lng: 28.9784 };
const min = (n: number) => n * MINUTE;

function desk2h(): Trace {
  return {
    name: 'desk_2h',
    startAt: SIM_START + 9 * HOUR,
    origin: ISTANBUL,
    shareMode: 'timed',
    expiresAt: SIM_START + 11 * HOUR,
    segments: [{ kind: 'still', durationMs: 2 * HOUR, battery: [80, 77] }],
  };
}

function walkThenDrive1h(): Trace {
  return {
    name: 'walk_then_drive_1h',
    startAt: SIM_START + 8 * HOUR,
    origin: ISTANBUL,
    shareMode: 'timed',
    expiresAt: SIM_START + 9 * HOUR,
    segments: [
      { kind: 'walk', durationMs: min(15), headingDeg: 45, battery: [70, 69] },
      { kind: 'still', durationMs: min(2), battery: [69, 69] },
      { kind: 'drive', durationMs: min(30), headingDeg: 90, battery: [69, 66] },
      { kind: 'highway', durationMs: min(13), headingDeg: 100, battery: [66, 65] },
    ],
  };
}

function tunnelOffline10min(): Trace {
  return {
    name: 'tunnel_offline_10min',
    startAt: SIM_START + 18 * HOUR,
    origin: ISTANBUL,
    shareMode: 'until_end_of_day',
    expiresAt: SIM_START + DAY,
    segments: [
      { kind: 'drive', durationMs: min(10), headingDeg: 60, battery: [55, 54] },
      // Tünel: ne konum ne internet.
      { kind: 'drive', durationMs: min(2), headingDeg: 60, gps: false, online: false, battery: [54, 54] },
      // Kırsal yol: konum var, internet yok → kuyruk.
      { kind: 'drive', durationMs: min(8), headingDeg: 60, online: false, battery: [54, 53] },
      { kind: 'drive', durationMs: min(10), headingDeg: 60, battery: [53, 52] },
    ],
  };
}

function battery16to14(): Trace {
  return {
    name: 'battery_16_to_14',
    startAt: SIM_START + 20 * HOUR,
    origin: ISTANBUL,
    shareMode: 'until_end_of_day',
    expiresAt: SIM_START + DAY,
    segments: [
      { kind: 'walk', durationMs: min(10), headingDeg: 0, battery: [16, 15] },
      // Ölçüm titremesi: 15 ↔ 16 tekrar bildirim üretmemeli.
      { kind: 'walk', durationMs: min(10), headingDeg: 0, battery: [15, 16] },
      { kind: 'still', durationMs: min(10), battery: [16, 15] },
      { kind: 'still', durationMs: min(30), battery: [15, 14] },
    ],
  };
}

/** Günlük rutin: gece ev (şarjda), sabah işe araç, ofis, öğle yürüyüşü, akşam dönüş (tünelli), akşam ev. */
function routineDay(dayIndex: number): TraceSegment[] {
  const evening: [number, number] = dayIndex === 2 ? [62, 12] : [62, 40]; // 3. gün pil %15 altına iner
  return [
    { kind: 'still', durationMs: min(450), charging: true, battery: [40, 100] }, // 00:00–07:30
    { kind: 'walk', durationMs: min(10), headingDeg: 45, battery: [100, 99] },
    { kind: 'drive', durationMs: min(40), headingDeg: 45, battery: [99, 96] },
    { kind: 'walk', durationMs: min(5), headingDeg: 45, battery: [96, 96] },
    { kind: 'still', durationMs: min(245), battery: [96, 86] }, // ofis 08:25–12:30
    { kind: 'walk', durationMs: min(22), headingDeg: 90, battery: [86, 85] },
    { kind: 'walk', durationMs: min(23), headingDeg: 270, battery: [85, 84] },
    { kind: 'still', durationMs: min(255), battery: [84, 72] }, // 13:15–17:30
    { kind: 'walk', durationMs: min(5), headingDeg: 225, battery: [72, 72] },
    { kind: 'drive', durationMs: min(18), headingDeg: 225, battery: [72, 70] },
    { kind: 'drive', durationMs: min(4), headingDeg: 225, gps: false, online: false, battery: [70, 70] }, // tünel
    { kind: 'drive', durationMs: min(18), headingDeg: 225, battery: [70, 68] },
    { kind: 'walk', durationMs: min(10), headingDeg: 225, battery: [68, 67] },
    { kind: 'still', durationMs: min(95), battery: [67, evening[0]] }, // 18:25–20:00
    { kind: 'still', durationMs: min(240), battery: evening }, // 20:00–24:00
  ];
}

function weekly7d(): Trace {
  const segments: TraceSegment[] = [];
  for (let d = 0; d < 7; d++) segments.push(...routineDay(d));
  return { name: 'weekly_7d', startAt: SIM_START, origin: ISTANBUL, shareMode: 'weekly', expiresAt: SIM_START + 7 * DAY, segments };
}

/** Süresiz, hafif kullanım: çoğunlukla evde; günde bir yürüyüş; gece 02–04 arası modem kapalı. */
function indefinite30dLight(): Trace {
  const segments: TraceSegment[] = [];
  for (let d = 0; d < 30; d++) {
    segments.push(
      { kind: 'still', durationMs: min(120), charging: true, battery: [45, 70] }, // 00–02
      { kind: 'still', durationMs: min(120), charging: true, online: false, battery: [70, 95] }, // 02–04 modem kapalı
      { kind: 'still', durationMs: min(240), charging: true, battery: [95, 100] }, // 04–08
      { kind: 'still', durationMs: min(600), battery: [100, 75] }, // 08–18
      { kind: 'walk', durationMs: min(15), headingDeg: 30 + d, battery: [75, 74] },
      { kind: 'walk', durationMs: min(15), headingDeg: 210 + d, battery: [74, 73] },
      { kind: 'still', durationMs: min(330), battery: [73, 45] }, // 18:30–24
    );
  }
  return { name: 'indefinite_30d_light', startAt: SIM_START, origin: ISTANBUL, shareMode: 'indefinite', expiresAt: null, segments };
}

export const SIM_TRACES = {
  desk_2h: desk2h,
  walk_then_drive_1h: walkThenDrive1h,
  tunnel_offline_10min: tunnelOffline10min,
  battery_16_to_14: battery16to14,
  weekly_7d: weekly7d,
  indefinite_30d_light: indefinite30dLight,
} as const satisfies Record<string, () => Trace>;

export type SimTraceName = keyof typeof SIM_TRACES;

/** Rapor tablosu (Markdown). */
export function formatSimTable(reports: readonly SimReport[]): string {
  const head = '| iz | süre | GPS örnek | tek sefer | gönderim | gönd./sa | iz yazma | kuyruk maks | eşitlenen | kayıp | düşük pil | uyku dk | uyku % | en uzun sessizlik | alıcı gecikti/kopuk dk |';
  const sep = '|' + ' --- |'.repeat(15);
  const rows = reports.map((r) => {
    const dur = r.durationMs >= DAY ? `${(r.durationMs / DAY).toFixed(0)} g` : `${(r.durationMs / HOUR).toFixed(1)} sa`;
    const silence = `${Math.round(r.maxSilenceMs / MINUTE)} dk`;
    return `| ${r.name} | ${dur} | ${r.gpsFixes} | ${r.oneShotFixes} | ${r.sends} | ${r.sendsPerHour.toFixed(1)} | ${r.trailWrites} | ${r.queuedMax} | ${r.syncedPoints} | ${r.lostPoints} | ${r.lowBatteryAlerts} | ${r.sleepMinutes} | ${(r.sleepShare * 100).toFixed(1)} | ${silence} | ${r.receiverMinutes.delayed}/${r.receiverMinutes.offline_suspected} |`;
  });
  return [head, sep, ...rows].join('\n');
}
