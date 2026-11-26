/**
 * Web önizleme · Faz 3 (yalnızca tarayıcı paketi).
 *
 *  - Panel: "FAZ 3 SENARYOLARI" (masada bekle / yürü / araca bin / tünel / Ayşe'nin pili / Mehmet'in bağlantısı /
 *    ekran kilidi) + canlı gösterge (hareket durumu, GPS modu, gönderim aralığı, kuyruktaki nokta sayısı),
 *    "ALICI TARAFI" (paylaştığım kişinin gördüğü son doğrulanmış konum + çevrimdışı iz) ve "İZİNLER (SİMÜLASYON)".
 *  - Telefon katmanları: ekran kaplama katmanı (PermissionFlow portalı), uygulama içi push afişi, kilit ekranı,
 *    iOS sistem izin pencereleri / Ayarlar sayfası.
 *
 * Gösterge, uygulamanın kendi kalıcı durumunu okur (`konum.bg.adaptive.v1`, `konum.bg.outbox.v1`) ve core
 * `selectTrackingPlan` ile o anki matris satırını hesaplar; yani panel uygulamanın kararını GÖSTERİR, kendisi
 * karar vermez.
 */
import {
  HOUR,
  lastVerifiedLocation,
  MINUTE,
  selectTrackingPlan,
  syncedPointsText,
  type BatteryBand,
  type GpsPower,
  type MotionState,
  type ReceivedFix,
  type TrackingPlanRow,
} from '@konum/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { permissionFlowStore } from '../../state/permissionFlowState';
import { permissionsStore } from '../../state/permissionsStore';
import { Text, useTheme } from '../../ui';
import {
  AYSE_BATTERY,
  AYSE_LOW_BATTERY,
  demoControls,
  presentedDemoNotifications,
  respondToDemoNotification,
  subscribeDemoEvents,
  type DemoNotification,
  type DemoSnapshot,
} from '../controls';
import { isF4PushType } from '../../services/notifications/f4Push';
import { isF5PushType } from '../../services/notifications/f5Push';
import { isF7PushType } from '../../services/notifications/f7Push';
import { safeStorage } from '../server/storage';
import { demoBatteryPct, demoEngineState, demoMotionMode, type DemoEngineState, type DemoMotionMode } from '../web/device';
import { demoOnline, demoTunnelLeftMs } from '../web/network';
import { currentSystemPrompt, demoPerms, onSystemPromptChange, type DemoPerms, type SystemPromptRequest } from '../web/permissions';
import { demoScreenLocked } from '../web/screen';
import { setScreenHost } from '../web/screenHost';

/** Panel düğmesi (DemoShell ile ortak). */
export interface ControlRow {
  key: string;
  title: string;
  hint: string;
  run: () => string | Promise<string>;
  tone?: 'danger';
  /** Uygulamada başka ekrana geçer: dar ekranda alttan açılan panel kapanır. */
  navigates?: boolean;
}

/** Yalnızca tarayıcı: buzlu cam görünümü. */
const FROSTED = { backdropFilter: 'blur(18px)' } as unknown as ViewStyle;

const ADAPTIVE_KEY = 'konum.bg.adaptive.v1';
const OUTBOX_KEY = 'konum.bg.outbox.v1';
const PERMISSION_FLOW_KEY = 'konum.ui.permissionFlow.v2';
const TUNNEL_MS = 2 * MINUTE;

// ── Simüle telefon durumu ─────────────────────────────────────────────────────────────────────

interface AdaptiveView {
  state: MotionState;
  since: number;
  prevBattery: BatteryBand | null;
  fenceRadiusM: number | null;
  pendingSince: number | null;
}

export interface DeviceView {
  online: boolean;
  tunnelLeftMs: number | null;
  locked: boolean;
  motionMode: DemoMotionMode;
  perms: DemoPerms;
  engine: DemoEngineState;
  adaptive: AdaptiveView | null;
  queue: { points: number; calls: number; synced: number };
  battery: number;
}

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = safeStorage.get(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readAdaptive(): AdaptiveView | null {
  const s = readJson(ADAPTIVE_KEY);
  const m = s?.machine as { state?: MotionState; since?: number } | undefined;
  if (!s || !m || typeof m.state !== 'string' || typeof m.since !== 'number') return null;
  const fence = s.fence as { radiusM?: number } | null | undefined;
  const pending = s.pending as { since?: number } | null | undefined;
  return {
    state: m.state,
    since: m.since,
    prevBattery: (s.prevBattery as BatteryBand | null | undefined) ?? null,
    fenceRadiusM: typeof fence?.radiusM === 'number' ? fence.radiusM : null,
    pendingSince: typeof pending?.since === 'number' ? pending.since : null,
  };
}

function readQueue(): DeviceView['queue'] {
  const o = readJson(OUTBOX_KEY);
  const st = o?.state as { points?: unknown[] } | undefined;
  const meta = o?.meta as { calls?: unknown[]; synced?: number } | undefined;
  return {
    points: Array.isArray(st?.points) ? st.points.length : 0,
    calls: Array.isArray(meta?.calls) ? meta.calls.length : 0,
    synced: typeof meta?.synced === 'number' ? meta.synced : 0,
  };
}

export function readDevice(): DeviceView {
  return {
    online: demoOnline(),
    tunnelLeftMs: demoTunnelLeftMs(),
    locked: demoScreenLocked(),
    motionMode: demoMotionMode(),
    perms: demoPerms(),
    engine: demoEngineState(),
    adaptive: readAdaptive(),
    queue: readQueue(),
    battery: demoBatteryPct(),
  };
}

/** Simüle telefonun durumu; cihaz olaylarında ve saniyede bir yenilenir (tünel geri sayımı, süreler). */
export function useDemoDevice(tickMs = 1000): DeviceView {
  const [view, setView] = useState<DeviceView>(readDevice);
  useEffect(() => {
    const refresh = () => setView(readDevice());
    const id = setInterval(refresh, tickMs);
    const un = subscribeDemoEvents((e) => {
      if (e.type === 'device' || e.type === 'battery') refresh();
    });
    return () => {
      clearInterval(id);
      un();
    };
  }, [tickMs]);
  return view;
}

// ── Biçimlendirme ─────────────────────────────────────────────────────────────────────────────

const MOTION_TEXT: Record<MotionState, string> = {
  stationary: 'Hareketsiz',
  walking: 'Yürüyor',
  running: 'Koşuyor',
  cycling: 'Bisiklette',
  driving: 'Araçta',
  fast: 'Çok hızlı (tren / uçak)',
  unknown: 'Belirsiz',
};
const PHONE_MODE_TEXT: Record<DemoMotionMode, string> = { still: 'masada', walk: 'yürüyüş', drive: 'araçta' };
const GPS_TEXT: Record<GpsPower, string> = { high: 'Yüksek doğruluk', balanced: 'Dengeli', low: 'Düşük güç', off: 'Kapalı' };
const BAND_TEXT: Record<BatteryBand, string> = { normal: 'normal', low: 'düşük (≤ %15)', critical: 'kritik (≤ %5)', charging: 'şarjda' };

function dur(ms: number): string {
  if (ms >= HOUR) return `${Math.round(ms / HOUR)} sa`;
  if (ms >= MINUTE) return `${Math.round(ms / MINUTE)} dk`;
  return `${Math.max(1, Math.round(ms / 1000))} sn`;
}

/** "5 sn'de bir" · "15 dk'da bir" · "1 saatte bir" */
function every(ms: number): string {
  if (ms >= HOUR) return `${Math.round(ms / HOUR)} saatte bir`;
  if (ms >= MINUTE) return `${Math.round(ms / MINUTE)} dk'da bir`;
  return `${Math.max(1, Math.round(ms / 1000))} sn'de bir`;
}

const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const sameRow = (a: TrackingPlanRow | null, b: TrackingPlanRow) =>
  !!a && a.gps === b.gps && a.osIntervalMs === b.osIntervalMs && a.heartbeatMs === b.heartbeatMs && a.sendMinIntervalMs === b.sendMinIntervalMs;

// ── Panel: Faz 3 senaryoları + canlı gösterge ────────────────────────────────────────────────

interface Faz3Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactNode;
}

export function Faz3Section({ snap, renderRow }: Faz3Props) {
  const { colors, radius } = useTheme();
  const d = useDemoDevice();
  const sharing = d.engine.running || (snap?.myLiveTargets ?? 0) > 0;
  const noShare = 'Önce haritada "Konumumu paylaş" ile bir paylaşım başlat.';
  const motionNote = d.perms.motion === 'granted' ? '' : ' (Hareket izni yok: yalnızca hız ve yer değiştirmeden, ~4 dk içinde algılanır.)';
  const ayseLow = snap?.ayseBattery !== null && snap?.ayseBattery !== undefined && snap.ayseBattery <= 15;
  const mehmetOff = snap?.mehmetOffline ?? false;

  const rows: ControlRow[] = [
    {
      key: 'f3-still',
      title: 'Masada bekle (hareketsiz)',
      hint: 'Telefon masada, ekran kilitli: GPS kapanır, 15 dk\'da bir nabız.',
      run: () => {
        demoControls.setMotion('still');
        demoControls.setScreenLocked(true);
        return sharing
          ? `Telefon masada, ekran kilitlendi. Hareketsizlik algılandı; GPS kısa bir beklemeden sonra kapanır.${motionNote}`
          : `Telefon masada. ${noShare}`;
      },
    },
    {
      key: 'f3-walk',
      title: 'Yürümeye başla',
      hint: 'GPS hemen yüksek doğruluğa döner, 5 sn\'de bir gönderim.',
      run: () => {
        const fromVehicle = d.adaptive?.state === 'driving' || d.adaptive?.state === 'fast';
        demoControls.setMotion('walk');
        if (!sharing) return `Yürüyorsun. ${noShare}`;
        if (fromVehicle) return 'Araçtan indin: yürüyüşe geçiş ~90 sn sürer (trafikte durup kalkarken titremesin diye).';
        return `Yürüyüş algılandı: uyku modundan hemen çıkılır.${motionNote}`;
      },
    },
    {
      key: 'f3-drive',
      title: 'Araca bin',
      hint: 'Araç hızı (~40 km/s): GPS 2 sn\'de bir, gönderim 3 sn\'de bir.',
      run: () => {
        demoControls.setMotion('drive');
        return sharing ? `Araçta: güncellemeler hızlandı.${motionNote}` : `Araçtasın. ${noShare}`;
      },
    },
    d.tunnelLeftMs !== null || !d.online
      ? {
          key: 'f3-tunnel',
          title: d.tunnelLeftMs !== null ? `Tünelden çık (${mmss(d.tunnelLeftMs)} kaldı)` : 'Bağlantı gelsin',
          hint: 'Kuyruktaki noktalar sırayla sunucuya gider.',
          run: () => {
            demoControls.endTunnel();
            return 'Bağlantı geldi: kuyruktaki noktalar eşitleniyor.';
          },
        }
      : {
          key: 'f3-tunnel',
          title: 'Tünele gir (2 dk çevrimdışı)',
          hint: 'GPS sürer, noktalar telefonda kuyruğa girer; çıkınca eşitlenir.',
          run: () => {
            demoControls.startTunnel(TUNNEL_MS);
            return sharing ? 'Bağlantı yok: konum noktaları telefonda kuyruğa giriyor.' : `Bağlantı yok. ${noShare}`;
          },
        },
    ayseLow
      ? {
          key: 'f3-ayse-battery',
          title: `Ayşe'nin pili normale dönsün (%${AYSE_BATTERY})`,
          hint: 'Rozet kalkar; uyarı yeniden kurulur (%20 üstü).',
          run: () => {
            const r = demoControls.ayseBatteryNormal();
            return r === 'not_sharing' ? 'Ayşe şu anda seninle paylaşmıyor.' : `Ayşe'nin pili %${AYSE_BATTERY}.`;
          },
        }
      : {
          key: 'f3-ayse-battery',
          title: `Ayşe'nin pili %${AYSE_LOW_BATTERY}'e düşsün`,
          hint: 'Sana "pili azaldı" bildirimi gelir, Ayşe\'de amber rozet.',
          run: () => {
            const r = demoControls.ayseLowBattery();
            if (r === 'not_sharing') return 'Ayşe şu anda seninle paylaşmıyor; önce "Ayşe yeniden paylaşsın".';
            if (r === 'suppressed') return 'Uyarı yakın zamanda gönderildi; tekrar gönderilmez (30 dk).';
            return `Ayşe'nin pili %${AYSE_LOW_BATTERY}: telefonuna bildirim geldi.`;
          },
        },
    mehmetOff
      ? {
          key: 'f3-mehmet',
          title: 'Mehmet\'in bağlantısı geri gelsin',
          hint: 'Taze konum gelir, uyarı kalkar.',
          run: () => (demoControls.mehmetReconnect() ? 'Mehmet yeniden çevrimiçi.' : 'Mehmet zaten çevrimiçi.'),
        }
      : {
          key: 'f3-mehmet',
          title: 'Mehmet\'in bağlantısı kopsun',
          hint: '"Bağlantısı kopmuş olabilir" + son doğrulanmış saat ve pil.',
          run: () =>
            demoControls.mehmetDisconnect()
              ? 'Mehmet\'ten 1 saattir paket gelmiyor: son doğrulanmış konumu gösteriliyor.'
              : 'Mehmet şu anda paylaşmıyor.',
        },
    d.locked
      ? {
          key: 'f3-lock',
          title: 'Ekran kilidini aç',
          hint: 'Uygulama ön plana döner (ön plan satırı).',
          run: () => {
            demoControls.setScreenLocked(false);
            return 'Kilit açıldı: uygulama ön planda.';
          },
        }
      : {
          key: 'f3-lock',
          title: 'Ekranı kilitle',
          hint: 'Uygulama arka plana geçer (arka plan satırı).',
          run: () => {
            demoControls.setScreenLocked(true);
            return 'Ekran kilitlendi: uygulama arka planda.';
          },
        },
  ];

  return (
    <View style={{ gap: 6 }}>
      <Text variant="caption" color="textSecondary" style={styles.section}>
        FAZ 3 SENARYOLARI
      </Text>
      <Readout d={d} sharing={sharing} />
      {rows.map(renderRow)}
      {snap?.batteryNotice ? (
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {`Son düşük pil uyarın: ${clock(snap.batteryNotice.at)} · %${snap.batteryNotice.pct} → ${snap.batteryNotice.receivers} alıcı`}
        </Text>
      ) : null}
      <ReceiverPreview snap={snap} />
      <View style={[styles.note, { borderRadius: radius.md, backgroundColor: colors.surfaceAlt }]}>
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          Demo kısaltması: hareket olayları 4 dk geriye tarihlenir (hareketsizliğe giriş beklemesi atlanır); Mehmet'in son
          paketi 63 dk önceye alınır.
        </Text>
      </View>
    </View>
  );
}

function Readout({ d, sharing }: { d: DeviceView; sharing: boolean }) {
  const { colors, radius } = useTheme();
  const now = Date.now();
  const state: MotionState = d.adaptive?.state ?? 'unknown';
  const phase = d.locked ? 'background' : 'foreground';
  const plan = selectTrackingPlan({
    hasActiveOutgoingShare: sharing,
    appPhase: phase,
    motion: state,
    batteryPct: d.battery,
    isCharging: false,
    prevBattery: d.adaptive?.prevBattery ?? undefined,
    canUseGeofence: d.perms.foreground === 'granted' && d.perms.background === 'granted',
  });
  const row = plan.row;
  const motionSince = d.adaptive ? (now - d.adaptive.since < MINUTE ? 'az önce' : `${Math.floor((now - d.adaptive.since) / MINUTE)} dk'dır`) : null;

  let gps: string;
  if (!sharing) gps = 'Kapalı (paylaşım yok)';
  else if (row.gps === 'off') gps = `Kapalı · uyku çiti ${d.adaptive?.fenceRadiusM ?? d.engine.fence?.radiusM ?? 100} m`;
  else gps = `${GPS_TEXT[row.gps]} · ${every(row.osIntervalMs)}`;
  if (sharing && row.significantChanges) gps += ' + önemli konum değişikliği';

  const send = sharing ? `${every(row.sendMinIntervalMs)} · nabız ${dur(row.heartbeatMs)}` : '—';
  const queue = `${d.queue.points} nokta${d.queue.calls ? ` · ${d.queue.calls} bekleyen çağrı` : ''}${
    d.queue.points > 0 && !d.online ? ' (bağlantı bekleniyor)' : ''
  }${d.queue.points === 0 && d.queue.synced > 0 ? ` · toplam ${d.queue.synced} eşitlendi` : ''}`;
  const net = d.tunnelLeftMs !== null ? `Tünelde · ${mmss(d.tunnelLeftMs)} kaldı` : d.online ? 'Çevrimiçi' : 'Çevrimdışı';
  const applying = sharing && d.locked && d.engine.row !== null && !sameRow(d.engine.row, row);

  const items: [string, string, string?][] = [
    ['Hareket durumu', `${MOTION_TEXT[state]}${motionSince ? ` · ${motionSince}` : ''}`, `telefon: ${PHONE_MODE_TEXT[d.motionMode]}`],
    ['Uygulama', d.locked ? 'Ekran kilitli (arka plan)' : 'Ön planda'],
    ['GPS modu', gps],
    ['Gönderim aralığı', send],
    ['Kuyruktaki nokta', queue],
    ['Bağlantı', net],
    ['Pil', `%${d.battery} · ${BAND_TEXT[plan.battery]}`],
  ];

  return (
    <View
      testID="faz3-readout"
      style={[styles.readout, { borderRadius: radius.md, borderColor: colors.border, backgroundColor: colors.bg }]}
      accessibilityLabel="Faz 3 canlı gösterge"
    >
      {items.map(([k, v, sub]) => (
        <View key={k} style={styles.readRow}>
          <Text variant="caption" color="textSecondary" style={styles.readKey}>
            {k}
          </Text>
          <View style={{ flex: 1 }}>
            <Text variant="caption" style={{ fontWeight: '600' }}>
              {v}
            </Text>
            {sub ? (
              <Text variant="caption" color="textSecondary" style={{ fontWeight: '400', fontSize: 11, lineHeight: 14 }}>
                {sub}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
      <View style={[styles.matrix, { borderColor: colors.border }]}>
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400', fontSize: 11, lineHeight: 14 }}>
          {sharing ? `Matris satırı: ${plan.reason}` : 'Matris satırı: off (paylaşım yok)'}
          {applying ? ' · OS isteği güncelleniyor (titremeyi önlemek için ~20 sn bekler)' : ''}
        </Text>
      </View>
    </View>
  );
}

// ── Panel: alıcı tarafı ───────────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toFix(v: Record<string, unknown>): ReceivedFix | null {
  const lat = num(v.lat);
  const lng = num(v.lng);
  const ts = num(v.timestamp);
  const sts = num(v.server_ts);
  if (lat === null || lng === null || ts === null || sts === null) return null;
  return { lat, lng, accuracy: num(v.accuracy) ?? 50, timestamp: ts, server_ts: sts, battery_pct: num(v.battery_pct), hb: num(v.hb), q: v.q === 1 ? 1 : null };
}

const PREVIEW_W = 296;
const PREVIEW_H = 96;
const GRID = [
  ...[18, 50, 80].map((y) => `M0 ${y} L${PREVIEW_W} ${y - 8}`),
  ...[40, 104, 170, 236].map((x) => `M${x} 0 L${x + 10} ${PREVIEW_H}`),
].join(' ');

function ReceiverPreview({ snap }: { snap: DemoSnapshot | null }) {
  const { colors, radius, scheme } = useTheme();
  const view = snap?.receiverView ?? null;
  if (!view) {
    return (
      <View style={[styles.preview, { borderRadius: radius.md, borderColor: colors.border }]}>
        <Text variant="caption" color="textSecondary" style={styles.section}>
          ALICI TARAFI
        </Text>
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          Ayşe ile konum paylaşınca, Ayşe'nin ekranında ne göründüğü burada çıkar (son doğrulanmış konum, çevrimdışı iz).
        </Text>
      </View>
    );
  }
  const live = toFix(view.live);
  const trail = view.trail.map(toFix).filter((f): f is ReceivedFix => f !== null);
  const fixes = live ? [...trail, live] : trail;
  const lv = lastVerifiedLocation(fixes, Date.now());
  const synced = syncedPointsText(trail.length);
  const first = view.name.split(' ')[0] ?? view.name;

  // Mini harita: iz (kesikli) + canlı nokta.
  const pts = [...trail].sort((a, b) => a.timestamp - b.timestamp);
  const all = live ? [...pts, live] : pts;
  let path = '';
  const dots: { x: number; y: number }[] = [];
  let livePt: { x: number; y: number } | null = null;
  if (all.length > 0) {
    const lats = all.map((p) => p.lat);
    const lngs = all.map((p) => p.lng);
    const pad = 14;
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const kLat = 1 / Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    // En az ~70 m × 35 m: tek nokta ya da kısa iz dev ölçekte çizilmesin.
    const spanX = Math.max((maxLng - minLng) / kLat, 0.0008);
    const spanY = Math.max(maxLat - minLat, 0.0003);
    const scale = Math.min((PREVIEW_W - pad * 2) / spanX, (PREVIEW_H - pad * 2) / spanY);
    const ox = (PREVIEW_W - spanX * scale) / 2;
    const oy = (PREVIEW_H - spanY * scale) / 2;
    const xy = (p: ReceivedFix) => ({ x: ox + ((p.lng - minLng) / kLat) * scale, y: PREVIEW_H - (oy + (p.lat - minLat) * scale) });
    const seq = all.map(xy);
    path = seq.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    for (const p of pts) dots.push(xy(p));
    livePt = live ? xy(live) : null;
  }
  const statusColor = !lv
    ? colors.textSecondary
    : lv.status === 'live' || lv.status === 'recent'
      ? colors.live
      : lv.status === 'delayed'
        ? colors.warning
        : colors.danger;

  return (
    <View testID="receiver-preview" style={[styles.preview, { borderRadius: radius.md, borderColor: colors.border }]}>
      <Text variant="caption" color="textSecondary" style={styles.section}>
        {`ALICI TARAFI · ${first.toLocaleUpperCase('tr-TR')}'NİN EKRANI`}
      </Text>
      <View style={{ borderRadius: 10, overflow: 'hidden', backgroundColor: colors.mapLand }}>
        <Svg width={PREVIEW_W} height={PREVIEW_H} viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}>
          <Rect x={0} y={0} width={PREVIEW_W} height={PREVIEW_H} fill={colors.mapLand} />
          {/* Harita hissi için soluk sokak ızgarası (yalnızca süs). */}
          <Path d={GRID} stroke={colors.mapRoad} strokeWidth={5} fill="none" opacity={0.9} />
          {path && pts.length > 0 ? (
            <>
              <Path d={path} stroke={scheme === 'dark' ? '#0B1220' : '#FFFFFF'} strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <Path d={path} stroke={colors.stale} strokeWidth={3} strokeDasharray="7 5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : null}
          {dots.map((p, i) => (
            <Circle key={i} cx={p.x} cy={p.y} r={2.6} fill={colors.surface} stroke={colors.stale} strokeWidth={1.5} />
          ))}
          {livePt ? (
            <>
              <Circle cx={livePt.x} cy={livePt.y} r={9} fill={colors.primary} opacity={0.18} />
              <Circle cx={livePt.x} cy={livePt.y} r={5.5} fill={colors.primary} stroke="#FFFFFF" strokeWidth={2} />
            </>
          ) : null}
        </Svg>
      </View>
      {lv ? (
        <View style={{ gap: 1 }}>
          {lv.status !== 'live' ? (
            <Text variant="caption" style={{ color: statusColor, fontWeight: '600' }}>
              {lv.statusText}
            </Text>
          ) : null}
          <Text variant="caption" style={{ fontWeight: '500', color: lv.status === 'live' ? colors.live : colors.text }}>
            {lv.label}
          </Text>
          {synced ? (
            <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
              {`${synced} (kesikli çizgi)`}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {`${first} henüz konumunu almadı.`}
        </Text>
      )}
    </View>
  );
}

// ── Panel: izinler ────────────────────────────────────────────────────────────────────────────

const PERM_TEXT = { granted: 'verildi', denied: 'reddedildi', undetermined: 'sorulmadı' } as const;

/** "İzin akışını baştan göster": simüle izinler + uygulamanın izin akışı hafızası ilk kurulum haline döner. */
async function resetPermissionFlow(): Promise<void> {
  demoControls.resetPermissions();
  permissionFlowStore.setState({ hasSeenRationale: {}, lastDeniedAt: {} });
  safeStorage.remove(PERMISSION_FLOW_KEY);
  await permissionsStore.getState().refresh().catch(() => undefined);
}

export function PermissionsSection({ renderRow }: { renderRow: (r: ControlRow) => ReactNode }) {
  const { colors, radius } = useTheme();
  const d = useDemoDevice(2000);
  const p = d.perms;
  const location = p.foreground !== 'granted' ? PERM_TEXT[p.foreground] : p.background === 'granted' ? 'Her Zaman' : 'Kullanırken';
  const chips: [string, string, boolean][] = [
    ['Konum', location, p.foreground === 'granted'],
    ['Bildirim', PERM_TEXT[p.notifications], p.notifications === 'granted'],
    ['Hareket', PERM_TEXT[p.motion], p.motion === 'granted'],
    ['Tam konum', p.precise ? 'açık' : 'kapalı', p.precise],
  ];
  const rows: ControlRow[] = [
    {
      key: 'perm-reset',
      title: 'İzin akışını baştan göster',
      hint: 'Hepsi "sorulmadı" olur; sonraki paylaşımda adımlar sırayla gelir.',
      run: async () => {
        await resetPermissionFlow();
        return 'İzinler sıfırlandı. "Konumumu paylaş" → kişi seç → "Süresiz" → Başlat: önce "Kullanırken", sonra bildirim, "Her Zaman" ve hareket.';
      },
    },
    {
      key: 'perm-grant',
      title: 'Tüm izinleri ver',
      hint: 'Kullanırken + Her Zaman, bildirim, hareket, tam konum.',
      run: async () => {
        demoControls.grantAllPermissions();
        await permissionsStore.getState().refresh().catch(() => undefined);
        return 'Tüm izinler verildi.';
      },
    },
  ];
  return (
    <View style={{ gap: 6 }}>
      <Text variant="caption" color="textSecondary" style={styles.section}>
        İZİNLER (SİMÜLASYON · iOS)
      </Text>
      <View style={styles.chips}>
        {chips.map(([k, v, ok]) => (
          <View key={k} style={[styles.chip, { borderRadius: radius.sm, backgroundColor: ok ? colors.liveSoft : colors.warningSoft }]}>
            <Text variant="caption" style={{ color: ok ? colors.live : colors.warning, fontWeight: '600' }}>
              {`${k}: ${v}`}
            </Text>
          </View>
        ))}
      </View>
      {rows.map(renderRow)}
    </View>
  );
}

// ── Telefon katmanları ────────────────────────────────────────────────────────────────────────

function AppGlyph({ size = 22 }: { size?: number }) {
  return (
    <View style={[styles.appIcon, { width: size, height: size, borderRadius: size * 0.27 }]}>
      <Svg width={size * 0.64} height={size * 0.64} viewBox="0 0 24 24">
        <Path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 14.8 12 21 12 21Z" fill="#FFFFFF" />
        <Circle cx={12} cy={9.8} r={2.4} fill="#2563EB" />
      </Svg>
    </View>
  );
}

/** PermissionFlow.web.tsx gibi kaplamaların portal hedefi (uygulama alanı). */
export function ScreenHostLayer() {
  // react-native-web: View ref'i DOM öğesidir.
  const ref = useRef<unknown>(null);
  useEffect(() => {
    setScreenHost((ref.current as HTMLElement | null) ?? null);
    return () => setScreenHost(null);
  }, []);
  return <View ref={ref as never} pointerEvents="box-none" style={[StyleSheet.absoluteFill, { zIndex: 20 }]} />;
}

/** Faz 4: ping / SOS / güvende / gördü push'ları da telefon bildirimi olarak çizilir. */
const isF4Push = (n: DemoNotification) => isF4PushType(n.data?.type);
const isSosPush = (n: DemoNotification) => n.data?.type === 'sos';
/** Faz 5: bölge olayı, buluşma önerisi / yanıtı ve "bölge kuralı paylaşımı başlattı" yerel bildirimi. */
const isF5Push = (n: DemoNotification) => isF5PushType(n.data?.type) || n.data?.type === 'zone_share_started';
/** Faz 6: widget'tan başlatılan paylaşımın gönderen onayı (uygulama bunu yerel bildirimle gösterirse). */
const isF6Push = (n: DemoNotification) => n.data?.type === 'quick_share_started';
/** Dokunulunca uygulamadaki gerçek yanıt yoluna giren push'lar (Faz 4 + Faz 5 + Faz 6). */
/** Konum İste: gelen istek (Onayla / Reddet eylemli) ve yanıt bildirimi. */
const isLocationRequestPush = (n: DemoNotification) => n.data?.type === 'location_request' || n.data?.type === 'location_request_answered';
/** Faz 7: etkinlik daveti / aşama / yanıt / hatırlatma / iptal ve "yola çıktı" (heads-up). */
const isF7Push = (n: DemoNotification) => isF7PushType(n.data?.type);
const isRoutedPush = (n: DemoNotification) => isF4Push(n) || isF5Push(n) || isF6Push(n) || isF7Push(n) || isLocationRequestPush(n);
const isBatteryPush = (n: DemoNotification) => n.data?.type === 'battery_low' || isRoutedPush(n);

/** Bildirime dokunma: Faz 4/5 push'u uygulamadaki gerçek yanıt yoluna girer (SOS kartı / ping vurgusu / buluşma kartı). */
function openPush(n: DemoNotification): void {
  if (isRoutedPush(n)) respondToDemoNotification(n.identifier);
}

/** Düşük pil (ve Faz 4) push'ları (uygulama ön plandayken yerel bildirimle gösterilir; demo burada çizer). */
function useBatteryPushes(): DemoNotification[] {
  const [list, setList] = useState<DemoNotification[]>(() => presentedDemoNotifications().filter(isBatteryPush).slice(0, 3));
  useEffect(
    () =>
      subscribeDemoEvents((e) => {
        if (e.type === 'notification' && isBatteryPush(e.notification)) setList((l) => [e.notification, ...l.filter((x) => x.identifier !== e.notification.identifier)].slice(0, 3));
        if (e.type === 'notification_dismissed') setList((l) => l.filter((x) => x.identifier !== e.id));
      }),
    [],
  );
  return list;
}

/** Bildirim eylem düğmeleri (iOS / Android eylemli bildirim: ör. Konum İste "Onayla / Reddet"). */
function NoticeActions({ n, dark, onDone }: { n: DemoNotification; dark: boolean; onDone?: () => void }) {
  if (!n.actions || n.actions.length === 0) return null;
  return (
    <View style={styles.noticeActions}>
      {n.actions.map((a) => (
        <Pressable
          key={a.identifier}
          accessibilityRole="button"
          accessibilityLabel={a.buttonTitle}
          testID={`notice-action-${a.identifier}`}
          onPress={() => {
            demoControls.setScreenLocked(false);
            respondToDemoNotification(n.identifier, a.identifier);
            onDone?.();
          }}
          style={[styles.noticeAction, { backgroundColor: dark ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.06)' }]}
        >
          <Text variant="label" style={{ color: dark ? '#FFFFFF' : '#0F172A', fontWeight: '600', textAlign: 'center' }} maxFontSizeMultiplier={1.2}>
            {a.buttonTitle}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function NoticeCard({ title, body, at, dark, testID, sos, actions }: { title: string; body: string; at: number | null; dark: boolean; testID?: string; sos?: boolean; actions?: ReactNode }) {
  return (
    <View
      testID={testID}
      style={[
        styles.notice,
        FROSTED,
        { backgroundColor: dark ? 'rgba(30, 41, 59, 0.72)' : 'rgba(255, 255, 255, 0.92)', borderColor: dark ? 'rgba(148,163,184,0.25)' : 'rgba(15,23,42,0.06)' },
        // Faz 4: SOS kritik bildirim görünümü (kırmızı kenar + zemin).
        sos ? { backgroundColor: dark ? 'rgba(127, 29, 29, 0.85)' : 'rgba(254, 226, 226, 0.97)', borderColor: '#DC2626', borderWidth: 2 } : null,
      ]}
    >
      <View style={styles.noticeHead}>
        <AppGlyph />
        <Text variant="caption" style={{ flex: 1, color: sos ? (dark ? '#FECACA' : '#B91C1C') : dark ? 'rgba(255,255,255,0.75)' : '#475569', letterSpacing: 0.4 }} maxFontSizeMultiplier={1}>
          {sos ? 'KONUM · ACİL DURUM' : 'KONUM'}
        </Text>
        <Text variant="caption" style={{ color: dark ? 'rgba(255,255,255,0.6)' : '#64748B', fontWeight: '400' }} maxFontSizeMultiplier={1}>
          {at === null || Date.now() - at < MINUTE ? 'şimdi' : `${Math.floor((Date.now() - at) / MINUTE)} dk önce`}
        </Text>
      </View>
      <Text variant="label" style={{ color: dark ? '#FFFFFF' : '#0F172A', fontWeight: '600' }} maxFontSizeMultiplier={1.2}>
        {title}
      </Text>
      <Text variant="label" style={{ color: dark ? 'rgba(255,255,255,0.86)' : '#334155', fontWeight: '400' }} maxFontSizeMultiplier={1.2}>
        {body}
      </Text>
      {actions}
    </View>
  );
}

/** Uygulama ön plandayken gelen push (iOS afişi): 7 sn görünür, dokununca kapanır. */
export function PushBanner() {
  const { scheme } = useTheme();
  const pushes = useBatteryPushes();
  const d = useDemoDevice(5000);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(pushes.map((p) => p.identifier)));
  const latest = pushes[0] ?? null;
  useEffect(() => {
    if (!latest || hidden.has(latest.identifier)) return;
    // SOS afişi daha uzun kalır (kritik).
    const t = setTimeout(() => setHidden((h) => new Set(h).add(latest.identifier)), isSosPush(latest) ? 15000 : 7000);
    return () => clearTimeout(t);
  }, [latest, hidden]);
  if (!latest || hidden.has(latest.identifier) || d.locked) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Bildirim: ${latest.title}`}
      onPress={() => {
        openPush(latest);
        setHidden((h) => new Set(h).add(latest.identifier));
      }}
      style={styles.pushBanner}
      testID="push-banner"
    >
      <NoticeCard
        title={latest.title}
        body={latest.body}
        at={latest.date}
        dark={scheme === 'dark'}
        sos={isSosPush(latest)}
        actions={<NoticeActions n={latest} dark={scheme === 'dark'} onDone={() => setHidden((h) => new Set(h).add(latest.identifier))} />}
      />
    </Pressable>
  );
}

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

/** Simüle kilit ekranı: saat, konum paylaşımı bildirimi, kilitliyken gelen push'lar. */
export function LockScreen() {
  const d = useDemoDevice(5000);
  const pushes = useBatteryPushes();
  if (!d.locked) return null;
  const now = new Date();
  const n = d.engine.notification;
  return (
    <View testID="lock-screen" style={[StyleSheet.absoluteFill, styles.lock]}>
      <View style={styles.lockTop}>
        <Svg width={16} height={20} viewBox="0 0 16 20">
          <Rect x={1} y={8} width={14} height={11} rx={2.5} fill="rgba(255,255,255,0.9)" />
          <Path d="M4 8V5.5a4 4 0 0 1 8 0V8" stroke="rgba(255,255,255,0.9)" strokeWidth={2} fill="none" />
        </Svg>
        <Text variant="heading" style={styles.lockDate} maxFontSizeMultiplier={1}>
          {`${now.getDate()} ${MONTHS[now.getMonth()]} ${DAYS[now.getDay()]}`}
        </Text>
        <Text style={styles.lockClock} maxFontSizeMultiplier={1}>
          {`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`}
        </Text>
      </View>
      <View style={styles.lockList}>
        {d.engine.running && n ? <NoticeCard testID="lock-service-notice" title={n.title} body={n.body} at={null} dark /> : null}
        {pushes.map((p) =>
          isRoutedPush(p) ? (
            // Faz 4/5: kilit ekranında dokunma → kilit açılır, uygulama ilgili ekranı açar (SOS kartı / ping vurgusu).
            <Pressable
              key={p.identifier}
              accessibilityRole="button"
              accessibilityLabel={`Bildirim: ${p.title}`}
              testID={isSosPush(p) ? 'lock-sos-notice' : undefined}
              onPress={() => {
                demoControls.setScreenLocked(false);
                openPush(p);
              }}
            >
              <NoticeCard title={p.title} body={p.body} at={p.date} dark sos={isSosPush(p)} actions={<NoticeActions n={p} dark />} />
            </Pressable>
          ) : (
            <NoticeCard key={p.identifier} title={p.title} body={p.body} at={p.date} dark />
          ),
        )}
      </View>
      <View style={styles.lockBottom}>
        <Text variant="caption" style={{ color: 'rgba(255,255,255,0.7)', fontWeight: '400', textAlign: 'center' }}>
          Ekran kilitli · uygulama arka planda
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Kilidi aç" onPress={() => demoControls.setScreenLocked(false)} style={styles.unlock}>
          <Text variant="label" style={{ color: '#FFFFFF', fontWeight: '600' }}>
            Kilidi aç
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function useSystemPrompt(): SystemPromptRequest | null {
  const [p, setP] = useState<SystemPromptRequest | null>(currentSystemPrompt);
  useEffect(() => {
    setP(currentSystemPrompt());
    return onSystemPromptChange(() => setP(currentSystemPrompt()));
  }, []);
  return p;
}

const IOS_BLUE = '#007AFF';

/** iOS sistem izin penceresi / Ayarlar sayfası (simüle; telefon ekranının içinde). */
export function SystemPromptHost() {
  const { scheme } = useTheme();
  const dark = scheme === 'dark';
  const p = useSystemPrompt();
  if (!p) return null;
  const sep = dark ? 'rgba(84,84,88,0.65)' : 'rgba(60,60,67,0.29)';
  const fg = dark ? '#FFFFFF' : '#000000';

  if (p.kind === 'settings') {
    const back = p.buttons.find((b) => b.id === 'back');
    const access = p.buttons.filter((b) => b.id === 'never' || b.id === 'while' || b.id === 'always');
    const precise = p.buttons.find((b) => b.id === 'precise');
    const cell = dark ? '#1C1C1E' : '#FFFFFF';
    return (
      <View testID="system-settings" style={[StyleSheet.absoluteFill, styles.promptRoot, { backgroundColor: dark ? '#000000' : '#F2F2F7', paddingTop: 54 }]}>
        <View style={styles.settingsNav}>
          {back ? (
            <Pressable accessibilityRole="button" onPress={() => p.resolve(back.id)} hitSlop={8}>
              <Text variant="body" style={{ color: IOS_BLUE }}>
                {back.label}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={{ fontSize: 30, lineHeight: 36, fontWeight: '700', color: fg, paddingHorizontal: 18, marginTop: 6 }}>Konum</Text>
        <Text variant="caption" style={{ color: '#8E8E93', paddingHorizontal: 18, marginBottom: 18, fontWeight: '400' }}>
          {p.title}
        </Text>
        <Text variant="caption" style={styles.settingsHeader}>
          {p.message.toLocaleUpperCase('tr-TR')}
        </Text>
        <View style={[styles.settingsGroup, { backgroundColor: cell }]}>
          {access.map((b, i) => {
            const checked = b.label.includes('✓');
            const label = b.label.replace('✓', '').trim();
            return (
              <Pressable
                key={b.id}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => p.resolve(b.id)}
                style={[styles.settingsRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: sep } : null]}
              >
                <Text variant="body" style={{ color: fg, flex: 1 }}>
                  {label}
                </Text>
                {checked ? (
                  <Text variant="body" style={{ color: IOS_BLUE, fontWeight: '600' }}>
                    ✓
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
        <Text variant="caption" style={styles.settingsFoot}>
          Haftalık ve süresiz paylaşımın ekran kilitliyken de sürmesi için “Her Zaman” gerekir.
        </Text>
        {precise ? (
          <View style={[styles.settingsGroup, { backgroundColor: cell, marginTop: 18 }]}>
            <Pressable accessibilityRole="button" onPress={() => p.resolve(precise.id)} style={styles.settingsRow}>
              <Text variant="body" style={{ color: fg, flex: 1 }}>
                {precise.label}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  const sideBySide = p.buttons.length === 2 && p.buttons.every((b) => b.label.length <= 12);
  return (
    <View testID="system-prompt" style={[StyleSheet.absoluteFill, styles.promptRoot, styles.promptBackdrop]}>
      <View style={[styles.alert, FROSTED, { backgroundColor: dark ? 'rgba(44,44,46,0.94)' : 'rgba(242,242,247,0.96)' }]}>
        <View style={styles.alertText}>
          <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', color: fg, textAlign: 'center' }}>{p.title}</Text>
          <Text style={{ fontSize: 13, lineHeight: 17, color: fg, textAlign: 'center' }}>{p.message}</Text>
        </View>
        <View style={sideBySide ? { flexDirection: 'row' } : null}>
          {p.buttons.map((b, i) => (
            <Pressable
              key={b.id}
              accessibilityRole="button"
              accessibilityLabel={b.label}
              onPress={() => p.resolve(b.id)}
              style={({ pressed }: { pressed: boolean }) => [
                styles.alertBtn,
                sideBySide ? { flex: 1 } : null,
                { borderTopWidth: StyleSheet.hairlineWidth, borderColor: sep },
                sideBySide && i > 0 ? { borderLeftWidth: StyleSheet.hairlineWidth } : null,
                pressed ? { backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' } : null,
              ]}
            >
              <Text style={{ fontSize: 17, lineHeight: 22, color: IOS_BLUE, fontWeight: b.bold ? '600' : '400', textAlign: 'center' }}>{b.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { letterSpacing: 1 },
  note: { paddingHorizontal: 12, paddingVertical: 8 },
  readout: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 5 },
  readRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  readKey: { width: 112, fontWeight: '400' },
  matrix: { borderTopWidth: 1, paddingTop: 6, marginTop: 2 },
  preview: { borderWidth: 1, padding: 10, gap: 6, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 8, paddingVertical: 4 },
  appIcon: { backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
  notice: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, gap: 2 },
  noticeHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  noticeActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  noticeAction: { flex: 1, minHeight: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  pushBanner: { position: 'absolute', top: 6, left: 8, right: 8, zIndex: 30, boxShadow: '0px 10px 30px rgba(15, 23, 42, 0.25)', borderRadius: 20 },
  lock: { zIndex: 35, backgroundColor: '#0E1B33', paddingHorizontal: 14 },
  lockTop: { alignItems: 'center', paddingTop: 58, gap: 4 },
  lockDate: { color: 'rgba(255,255,255,0.92)', marginTop: 8 },
  lockClock: { color: '#FFFFFF', fontSize: 84, lineHeight: 92, fontWeight: '600', letterSpacing: -2 },
  lockList: { marginTop: 26, gap: 8 },
  lockBottom: { position: 'absolute', left: 0, right: 0, bottom: 36, alignItems: 'center', gap: 10 },
  unlock: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)', cursor: 'pointer' },
  promptRoot: { zIndex: 50 },
  promptBackdrop: { backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', justifyContent: 'center' },
  alert: { width: 270, borderRadius: 14, overflow: 'hidden' },
  alertText: { paddingHorizontal: 16, paddingTop: 19, paddingBottom: 17, gap: 4 },
  alertBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, cursor: 'pointer' },
  settingsNav: { height: 32, paddingHorizontal: 14, justifyContent: 'center' },
  settingsHeader: { color: '#8E8E93', paddingHorizontal: 32, marginBottom: 6, fontWeight: '400' },
  settingsGroup: { marginHorizontal: 16, borderRadius: 10, overflow: 'hidden' },
  settingsRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, cursor: 'pointer' },
  settingsFoot: { color: '#8E8E93', paddingHorizontal: 32, marginTop: 6, fontWeight: '400' },
});
