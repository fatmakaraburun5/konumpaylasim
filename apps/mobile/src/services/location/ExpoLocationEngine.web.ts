/**
 * Web demo konum motoru: tarayıcı konumu İSTENMEZ. Simüle GPS (demo/web/device.ts: yürüyüş / masada / araç) örnekleri
 * GERÇEK konum hattına girer:
 *  - ön plan izleme → sharingCoordinator → `handleSamples(..., 'watch')` (5 sn'de bir)
 *  - "arka plan görevi" (ekran kilitli / sekme gizli) → backgroundTask.web.ts → `handleSamples(..., 'task')`
 * Yani shouldPublish / publisher / kural denetimli fan-out yazma birebir çalışır.
 *
 * Faz 3 (native `ExpoLocationEngine.ts` ile aynı isteğe bağlı yüzey):
 *  - `applyPlan(row, motion, notification)`: core matris satırı "OS isteğine" uygulanır: arka plan örnekleme aralığı
 *    = `osIntervalMs`, mesafe filtresi = `distanceFilterM`; `gps: 'off'` → GPS örneklemesi DURUR (uyku). Kalp atışı
 *    tek seferlik ölçümle gelir (`getCurrentSample`, adaptive/runtime zamanlayıcısı).
 *  - `setSleepGeofence(fence)`: simüle bölge izleme; telefon çitin dışına çıkınca uyku çiti görevi çalışır
 *    (`backgroundTask.web.ts` → `handleMotionEvent({type:'geofence_exit'})`).
 * Durum demo paneline `setDemoEngineState` ile yansır. Native `ExpoLocationEngine.ts` ile aynı dışa aktarımlar.
 */
import { haversineM, type MotionState, type RawLocationSample, type SleepGeofence, type TrackingPlanRow, type TrackingProfile } from '@konum/core';
import { AppState } from 'react-native';
import { demoLocationSample, demoPosition, runDemoGeofenceTask, runDemoLocationTask, setDemoEngineState } from '../../demo/web/device';
import type { ServiceNotification } from './adaptive/planOptions';
import type { LocationEngine } from './LocationEngine';

/** Simüle GPS örnek aralığı (ön plan izleme ve Faz 1 arka plan yolu). */
export const DEMO_SAMPLE_INTERVAL_MS = 5_000;
/** Simüle bölge izleme yoklaması. */
const FENCE_POLL_MS = 2_000;
/** Arka plan örnekleme aralığının demo sınırları (OS 1 sn'ye kadar inebilir; demo hattı 2 sn altını gereksiz yorar). */
const MIN_BG_INTERVAL_MS = 2_000;
const MAX_BG_INTERVAL_MS = 60_000;

export class ExpoLocationEngine implements LocationEngine {
  private background: TrackingProfile | null = null;
  private plan: { row: TrackingPlanRow; motion: MotionState; notification: ServiceNotification } | null = null;
  private fence: SleepGeofence | null = null;
  private fenceFired = false;
  private watchers = new Set<(raw: RawLocationSample) => void>();
  private fgTimer: ReturnType<typeof setInterval> | null = null;
  private bgTimer: ReturnType<typeof setInterval> | null = null;
  private bgTimerMs: number | null = null;
  private fenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastBgSample: RawLocationSample | null = null;
  private fixes = 0;

  private noteFix(sample: RawLocationSample): void {
    this.fixes += 1;
    setDemoEngineState({ lastFixAt: sample.timestamp, gpsFixes: this.fixes });
  }

  private fgTick = () => {
    if (this.watchers.size === 0) return;
    const sample = demoLocationSample();
    this.noteFix(sample);
    for (const w of [...this.watchers]) {
      try {
        w(sample);
      } catch {
        // dinleyici hatası motoru durdurmaz
      }
    }
  };

  private bgTick = () => {
    // Native'de arka plan görevi ön planda da çalışır; web'de ön plan izleme zaten yayınlıyor.
    // Ekran kilitliyken / sekme gizliyken görev yolunu çalıştır.
    if (AppState.currentState === 'active') return;
    const sample = demoLocationSample();
    const filterM = this.plan?.row.distanceFilterM ?? 0;
    const last = this.lastBgSample;
    if (last && filterM > 0) {
      const moved = haversineM({ lat: last.latitude, lng: last.longitude }, { lat: sample.latitude, lng: sample.longitude });
      if (moved < filterM) return; // OS mesafe filtresi: yeterince yer değiştirmeden örnek gelmez
    }
    this.lastBgSample = sample;
    this.noteFix(sample);
    runDemoLocationTask([sample]);
  };

  private fenceTick = () => {
    const f = this.fence;
    if (!f || this.fenceFired) return;
    if (haversineM(f, demoPosition()) <= f.radiusM) return;
    this.fenceFired = true;
    runDemoGeofenceTask();
  };

  /** Arka plan GPS örnekleme aralığı; null = GPS kapalı / görev yok. */
  private bgIntervalMs(): number | null {
    if (this.plan) {
      if (this.plan.row.gps === 'off') return null;
      return Math.min(MAX_BG_INTERVAL_MS, Math.max(MIN_BG_INTERVAL_MS, this.plan.row.osIntervalMs));
    }
    return this.background ? DEMO_SAMPLE_INTERVAL_MS : null;
  }

  private sync(): void {
    const fgWanted = this.watchers.size > 0;
    if (fgWanted && !this.fgTimer) this.fgTimer = setInterval(this.fgTick, DEMO_SAMPLE_INTERVAL_MS);
    else if (!fgWanted && this.fgTimer) {
      clearInterval(this.fgTimer);
      this.fgTimer = null;
    }
    const bgMs = this.bgIntervalMs();
    if (bgMs !== this.bgTimerMs) {
      if (this.bgTimer) clearInterval(this.bgTimer);
      this.bgTimer = bgMs === null ? null : setInterval(this.bgTick, bgMs);
      this.bgTimerMs = bgMs;
      this.lastBgSample = null;
    }
    const fenceWanted = this.fence !== null;
    if (fenceWanted && !this.fenceTimer) this.fenceTimer = setInterval(this.fenceTick, FENCE_POLL_MS);
    else if (!fenceWanted && this.fenceTimer) {
      clearInterval(this.fenceTimer);
      this.fenceTimer = null;
    }
    setDemoEngineState({
      running: this.background !== null || this.plan !== null,
      row: this.plan?.row ?? null,
      motion: this.plan?.motion ?? null,
      notification: this.plan ? { title: this.plan.notification.title, body: this.plan.notification.body } : null,
      fence: this.fence,
      gpsIntervalMs: bgMs,
    });
  }

  async startBackground(profile: TrackingProfile, notificationBody: string): Promise<void> {
    this.background = profile;
    if (!this.plan) setDemoEngineState({ notification: { title: 'Konumun paylaşılıyor', body: notificationBody } });
    this.sync();
  }

  async stopBackground(): Promise<void> {
    this.background = null;
    this.plan = null;
    this.sync();
    setDemoEngineState({ notification: null });
  }

  async isBackgroundRunning(): Promise<boolean> {
    return this.background !== null || this.plan !== null;
  }

  canReconfigureNow(): boolean {
    return true;
  }

  /** Faz 3: core matris satırını simüle OS isteğine uygular. */
  async applyPlan(row: TrackingPlanRow, motion: MotionState, notification: ServiceNotification): Promise<void> {
    this.plan = { row, motion, notification };
    this.sync();
  }

  /** Faz 3: simüle uyku çiti (yalnızca çıkış). */
  async setSleepGeofence(fence: SleepGeofence | null): Promise<void> {
    this.fence = fence;
    this.fenceFired = false;
    this.sync();
  }

  /** Şu an etkin arka plan profili (demo paneli için; native'de yok). */
  currentBackgroundProfile(): TrackingProfile | null {
    return this.background;
  }

  async watchForeground(_profile: TrackingProfile, onSample: (raw: RawLocationSample) => void): Promise<() => void> {
    this.watchers.add(onSample);
    this.sync();
    // expo-location gibi: ilk konum hemen gelir.
    const first = setTimeout(() => {
      if (!this.watchers.has(onSample)) return;
      const s = demoLocationSample();
      this.noteFix(s);
      onSample(s);
    }, 50);
    return () => {
      clearTimeout(first);
      this.watchers.delete(onSample);
      this.sync();
    };
  }

  /** Tek seferlik ölçüm (uyku modunda kalp atışı, çit çıkışı): GPS kapalıyken de çalışır. */
  async getCurrentSample(): Promise<RawLocationSample | null> {
    const s = demoLocationSample();
    this.noteFix(s);
    return s;
  }

  /** Faz 4 (SOS): simüle yüksek doğruluk (kısa bir "GPS kilitlenme" beklemesi). */
  async getPreciseSample(_timeoutMs: number): Promise<RawLocationSample | null> {
    await new Promise((r) => setTimeout(r, 400));
    const s = demoLocationSample();
    this.noteFix(s);
    return { ...s, accuracy: Math.min(s.accuracy ?? 8, 8) };
  }
}

export const locationEngine: LocationEngine = new ExpoLocationEngine();
