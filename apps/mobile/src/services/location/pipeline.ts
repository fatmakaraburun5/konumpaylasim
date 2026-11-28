/**
 * Konum örneği → yayın hattı. Hem arka plan görevi (TaskManager) hem ön plan izleyicisi bunu çağırır;
 * yayın kararını core `shouldPublish` verdiği için iki kaynaktan gelen örnekler çift yazma üretmez.
 *
 * Adımlar: kalıcı hedefleri yükle → süresi dolan ve kullanıcının durdurduğu (kesme anahtarı) hedefleri ele →
 * oturumu doğrula → core normalizeSample → selectTrackingProfile → shouldPublish → bağlantı var mı →
 * buildPackets/toFanoutUpdate (publisher) → imleci kaydet. Hedef kalmadıysa takip kapatılır.
 *
 * Yarış kuralları:
 *  - Kalıcı hedef listesine yazmalar kilitli ve "yalnızca daraltan"dır (`removeTargetIds`,
 *    `refreshTargetExpiries`): baştaki eski okumayla liste EZİLMEZ, durdurulan paylaşım geri gelmez,
 *    bu arada başlayan yeni paylaşım silinmez.
 *  - Takibi kapatma kararı kilidin İÇİNDE, en güncel listeye göre verilir (ön planın yeni başlattığı
 *    takip yanlışlıkla durdurulmaz).
 *  - Kesme anahtarı (`state/stopIntents`) her yazmadan hemen önce sorulur (yayıncı, yeniden deneme dahil).
 *  - Oturum belirsizse (zaman aşımı) örnek atlanır, kalıcı duruma DOKUNULMAZ.
 *
 * Faz 2: bağlantı (QR) hedefleri aynı örnekten, arkadaş fan-out'undan AYRI bir RTDB yazmasıyla
 * `link_live/{token_hash}` yoluna gider (linkPublisher). Konum toplama, yayın kararı (`shouldPublish`) ve
 * takip profili değişmez; yalnızca hedef listesi genişler. Takip ancak iki liste de boşalınca kapanır.
 *
 * Faz 3:
 *  - Hareket: örnekler (+ OS etkinliği, uyku çiti çıkışı, zamanlayıcı) uyarlamalı denetleyiciye (core `motionReducer`)
 *    gider; gönderim kapısı `selectTrackingPlan(...).profile`, pakette `hb` = satırın kalp atışı. Kalp atışı uzadıysa
 *    (`needsHeartbeatAnnounce`) hemen gönderilir. OS isteği satır değişince (debounce) yeniden yapılandırılır.
 *  - Çevrimdışı: "gönder" kararı bağlantısızken ya da yazma başarısızken örnek KALICI kuyruğa girer
 *    (`outboxRepo`); bağlantı varken taze yayından ÖNCE kuyruk boşaltılır (q: 1 + recorded_at + iz).
 *  - Düşük pil: core `lowBatteryTrigger` %15 geçişinde (oturum başına bir kez) yayını zorlar ve
 *    `battery_low_notify` çağırır; çevrimdışıysa çağrı kuyruğa alınır (aynı op_id).
 *
 * Faz 7:
 *  - Pil paylaşımı onayı (`state/persist` gizlilik kopyası, varsayılan KAPALI): kapalıyken pakete, bağlantı paketine ve
 *    kuyruktan boşaltılan yazmalara `battery_pct` / `is_charging` GİRMEZ (RTDB kuralı da `privacy/{uid}` aynasına
 *    bakarak reddeder) ve düşük pil bildirimi çağrılmaz. Uyarlamalı takip gerçek pil düzeyini kullanmaya devam eder.
 *  - "Yola çıktı": arkadaş paylaşımı sürerken hareket makinesi ≥ 10 dk sabitten harekete geçerse
 *    (core `shouldReportDeparture`) `movement_report` çağrılır (koordinatsız; 30 dk soğuma cihazda da tutulur).
 *
 * Faz 8: yayın kesme anahtarı (`state/publishHold`: görünmez mod niyeti ya da onay kapısı) açıkken HİÇBİR hedef
 * kullanılabilir sayılmaz: hedefler kilit içinde boşaltılır, takip kapanır, imleç ve kuyruk silinir; yazmadan hemen
 * önce ve yayıncının her denemesinde de sorulur (sunucu ayrıca paylaşımları bitirir ve RTDB yazılarını reddeder).
 *
 * Faz 9 (`f9Hooks`):
 *  - Her güvenilir örnek (≤ 100 m) hedef denetiminden ÖNCE son doğrulanmış konum olarak kaydedilir (`lastFix`,
 *    çevrimdışı SOS SMS'i; paylaşım olmasa da).
 *  - Arkadaş paketlerine anlık fotoğraf (`photo_id` + `photo_exp`) ve hedef durumu (`dest_name`, `dest_state`,
 *    `dest_eta`) eklenir; değişince yayın zorlanır (not anahtarına katılır). Bağlantı (QR) paketlerine GİTMEZ.
 *  - 200 m yaklaşma tetiklenince `approach_report` (oturum başına tek bildirim), Güvenli Dönüş sürerken en sık 60 sn'de
 *    bir `safe_return_update` ve hedefe varışta otomatik `safe_return_check_in`.
 */
import {
  batteryPct,
  inferActivityFromSpeed,
  isExpired,
  motionToActivity,
  needsHeartbeatAnnounce,
  normalizeSample,
  publishTargetsKey,
  serverNow,
  safeRecordedAt,
  shouldPublish,
  shouldReportDeparture,
  statusNoteExtras,
  uuidV4,
  type AppPhase,
  type DeviceStatus,
  type EpochMs,
  type LinkId,
  type MotionEvent,
  type NormalizedSample,
  type OutboxSample,
  type OutboxTarget,
  type RawLocationSample,
  type ShareId,
  type StatusNote,
  type TrackingProfileId,
  type UserId,
} from '@konum/core';
import { AppState } from 'react-native';
import { toKonumError } from '../../lib/errors';
import { currentAuthUser, listenAuthUser } from '../firebase/authClient';
import { batteryLowNotify, BATTERY_LOW_NOTIFY, movementReport } from '../firebase/callables';
import { ensureFirebase } from '../firebase/init';
import { isConnected, waitForConnection, writeFanout } from '../firebase/liveRepo';
import { publishLinkSample, type LinkPublisherDeps, type LinkPublishResult } from '../firebase/linkPublisher';
import { publishSample, type PublisherDeps, type PublishResult } from '../firebase/publisher';
import { firebaseLinkPublisherDeps, firebasePublisherDeps } from '../firebase/publisherDeps';
import { outboxRepo, type OutboxRepo } from '../outbox/outboxRepo';
import type { PendingCall } from '../outbox/outboxStore';
import {
  batteryShareAllowed,
  clearCursor,
  inTargetsLock,
  loadMovement,
  saveMovement,
  loadCursor,
  loadStatusNote,
  loadTargets,
  refreshLinkTargetExpiries,
  refreshTargetExpiries,
  removeLinkTargetIds,
  removeTargetIds,
  saveCursor,
  saveProfileId,
  wipeTargetsIfUid,
  type PersistedLinkTarget,
  type PersistedTarget,
} from '../../state/persist';
import { hydrateLinkStops, isLinkBlocked } from '../../state/linkStops';
import { hydratePublishHold, isPublishHeld } from '../../state/publishHold';
import { breakHoldsPublishing } from '../../state/breakHold';
import { hydrateStopIntents, isShareBlocked } from '../../state/stopIntents';
import { lastActivityEvent } from './adaptive/activitySource';
import { createAdaptiveController, type AdaptiveController, type ObserveResult } from './adaptive/adaptiveController';
import { audienceText, serviceTitleFor, type ServiceNotification } from './adaptive/planOptions';
import { readDeviceStatus } from './deviceStatus';
import { locationEngine } from './ExpoLocationEngine';
import type { LocationEngine } from './LocationEngine';
import { getBackgroundPermissionsAsync } from './locationPermissions';
import { tapZoneSamples } from './zoneSampleTap';
import { f9ExtrasKey, f9Hooks, type F9Extras, type F9Hooks } from './f9Hooks';
import { recordLastFix } from './lastFix';

export type SampleSource = 'task' | 'watch' | 'heartbeat';

/** Başsız bağlamda oturum durumu: kesin giriş, kesin çıkış ya da (zaman aşımı) bilinmiyor. */
export type AuthProbe = { kind: 'signed_in'; uid: UserId } | { kind: 'signed_out' } | { kind: 'unknown' };

/** [Varsayım] Başsız soğuk açılışta oturumun yerelden geri yüklenmesi için 5 sn yeterli. */
const AUTH_PROBE_TIMEOUT_MS = 5_000;
/**
 * [Varsayım: doğrulanmalı] Oturum "yok" görünse de hemen silmeyiz: iOS'ta ilk kilit açılışından önce
 * anahtar zinciri okunamayabilir. Bu süre boyunca yok görünmeye devam ederse hedefler silinir, takip kapanır.
 * (Kullanıcının kendi çıkışı ön planda zaten her şeyi hemen temizler.)
 */
const AUTH_MISSING_GRACE_MS = 10 * 60_000;
/**
 * [Varsayım] Yazmadan önce RTDB bağlantısını en çok bu kadar bekle; yoksa örnek Faz 3 kalıcı kuyruğuna girer
 * (RTDB SDK'nın kendi çevrimdışı kuyruğuna DEĞİL: o kuyruk zinciri bekletir ve "Durdur" sonrasını bilemez).
 */
const CONNECT_WAIT_MS = 4_000;
/** [Varsayım] Uyku modunda (GPS kapalı) kalp atışı zamanı gelince tek seferlik ölçüm; zamanlayıcı payı. */
const HEARTBEAT_SLACK_MS = 30_000;
/** Always / arka plan izni yoklamasının önbelleği (her örnekte izin API'si çağrılmasın). */
const GEOFENCE_PERMISSION_TTL_MS = 5 * 60_000;

/** Düşük pil bildirimi sonucu: 'retry' = kuyrukta kalır. */
export type CallOutcome = 'ok' | 'retry' | 'drop';

export interface PipelineDeps {
  probeAuth: () => Promise<AuthProbe>;
  publisherDeps: (uid: UserId, now: () => EpochMs) => PublisherDeps;
  waitOnline: (timeoutMs: number) => Promise<boolean>;
  readDevice: () => Promise<DeviceStatus>;
  engine: Pick<LocationEngine, 'stopBackground' | 'startBackground' | 'canReconfigureNow'> &
    Partial<Pick<LocationEngine, 'applyPlan' | 'setSleepGeofence' | 'getCurrentSample'>>;
  appPhase: () => AppPhase;
  /** Cihaz saati (ms); sunucu saati kalıcı farkla hesaplanır. */
  deviceNow: () => EpochMs;
  isBlocked: (shareId: ShareId) => boolean;
  hydrateBlocks: () => Promise<void>;
  /** Faz 2: bağlantı yayıncısı ve bağlantı kesme anahtarı. */
  linkPublisherDeps: (uid: UserId, now: () => EpochMs) => LinkPublisherDeps;
  isLinkBlocked: (linkId: LinkId) => boolean;
  hydrateLinkBlocks: () => Promise<void>;
  /** Faz 3: uyarlamalı takip denetleyicisi (hareket makinesi + matris satırı + uyku çiti + düşük pil). */
  adaptive: AdaptiveController;
  /** Faz 3: kalıcı çevrimdışı kuyruk. */
  outbox: OutboxRepo;
  /** RTDB şu an bağlı mı (beklemeden). */
  isOnline: () => boolean;
  /** Kuyruk boşaltma yazması (çok yollu, zaman aşımlı). */
  writeRaw: (map: Record<string, unknown>) => Promise<void>;
  /** Son OS etkinliği (yerel modül yoksa / bayrak kapalıysa null). `offsetMs` sunucu saati farkı. */
  lastActivity: (offsetMs: number) => Extract<MotionEvent, { type: 'activity' }> | null;
  /** Uyku çiti kullanılabilir mi (Always / ACCESS_BACKGROUND_LOCATION). */
  canUseGeofence: () => Promise<boolean>;
  /** Bekleyen callable (düşük pil) çağrısı. */
  callPending: (c: PendingCall) => Promise<CallOutcome>;
  newOpId: () => string;
  /**
   * Faz 4: kendi durum notum (kalıcı; arka plan görevi de okur). Arkadaş paketlerine `note` + `note_exp` olarak
   * eklenir; bağlantı (QR) paketlerine EKLENMEZ. Not değişince (etiket farklı) yayın zorlanır.
   */
  statusNote: (uid: UserId) => Promise<StatusNote | null>;
  /** Faz 8: yayın kesme anahtarı (görünmez mod / onay kapısı): açıkken hiçbir şey yayınlanmaz. */
  isHeld: () => boolean;
  hydrateHold: () => Promise<void>;
  /** Faz 7: pil bilgisi paylaşılabilir mi (gizlilik tercihi; varsayılan hayır). */
  batteryShare: (uid: UserId) => Promise<boolean>;
  /** Faz 7: son "yola çıktı" bildiriminin anı (cihazda; sunucu ayrıca soğuma uygular). */
  lastDepartureAt: (uid: UserId) => Promise<EpochMs | null>;
  /** Faz 7: "yola çıktı" bildir (hata yutulur). */
  reportDeparture: (uid: UserId, at: EpochMs) => Promise<void>;
  /** Faz 9: güvenilir örneği son doğrulanmış konum olarak kaydet (hedef olmasa da; hata yutulur). */
  recordFix: (raw: RawLocationSample, offsetMs: number, uid: UserId | null) => Promise<unknown>;
  /** Faz 9: fotoğraf / hedef paket alanları, yaklaşma raporu, Güvenli Dönüş tazeleme ve varış. */
  f9: Pick<F9Hooks, 'onSample'>;
  /**
   * Faz 12: mola sürüyor mu (cihazdaki kayıt, bu hesap). Sürüyorsa örnek YAYINLANMAZ ve kuyruğa da girmez (mola
   * boyunca konum izi oluşmaz); takip ve hedefler olduğu gibi kalır, mola bitince ilk örnek yayınlanır.
   */
  onBreak: (uid: UserId, now: EpochMs) => Promise<boolean>;
}

/** "Yola çıktı" çağrısı konum hattını en çok bu kadar bekletir. */
const DEPARTURE_CALL_TIMEOUT_MS = 4_000;

/** Pil paylaşımı kapalıyken yayınlanan cihaz durumu: pil bilinmiyor gibi (paket alanları hiç yazılmaz). */
export const withoutBattery = (device: DeviceStatus): DeviceStatus => ({ ...device, batteryLevel: null, isCharging: null });

const BATTERY_KEYS = new Set(['battery_pct', 'is_charging']);

/** Kuyruk boşaltma yazmasından pil alanlarını ayıklar (yol sonu ya da nesne alanı; iç içe nesneler dahil). */
export function stripBatteryFields(map: Record<string, unknown>): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!BATTERY_KEYS.has(k)) out[k] = clean(x);
    return out;
  };
  const out: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(map)) {
    const last = path.slice(path.lastIndexOf('/') + 1);
    if (BATTERY_KEYS.has(last)) continue;
    out[path] = clean(v);
  }
  return out;
}

async function defaultReportDeparture(uid: UserId, at: EpochMs): Promise<void> {
  // Önce kaydet: çağrı sürerken gelen örnekler ikinci kez bildirmesin (sunucu da 30 dk soğuma uygular).
  await saveMovement({ uid, last_report_at: at });
  await movementReport({ kind: 'departed', at }).catch(() => undefined);
}

/** Firebase Auth: oturum yerelden geri yüklenene kadar bekle; zaman aşımında "bilinmiyor". */
export async function probeFirebaseAuth(timeoutMs = AUTH_PROBE_TIMEOUT_MS): Promise<AuthProbe> {
  await ensureFirebase();
  const current = currentAuthUser();
  if (current) return { kind: 'signed_in', uid: current.uid };
  return new Promise<AuthProbe>((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    const finish = (r: AuthProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Dinleyici kayıt sırasında senkron tetiklenebilir: aboneliği bir sonraki turda kaldır.
      setTimeout(() => unsub?.(), 0);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ kind: 'unknown' }), timeoutMs);
    unsub = listenAuthUser((u) => finish(u ? { kind: 'signed_in', uid: u.uid } : { kind: 'signed_out' }));
    if (settled) setTimeout(() => unsub?.(), 0);
  });
}

export const appPhaseNow = (): AppPhase => (AppState.currentState === 'active' ? 'foreground' : 'background');

/** Düşük pil callable'ı: geçici hata → kuyrukta kalır, kalıcı hata (şema/yetki) → atılır. */
export async function callPendingFirebase(c: PendingCall): Promise<CallOutcome> {
  if (c.name !== BATTERY_LOW_NOTIFY) return 'drop';
  try {
    await batteryLowNotify(c.payload as Parameters<typeof batteryLowNotify>[0]);
    return 'ok';
  } catch (e) {
    return toKonumError(e).retryable ? 'retry' : 'drop';
  }
}

function cachedGeofencePermission(): () => Promise<boolean> {
  let cache: { at: number; v: boolean } | null = null;
  return async () => {
    const t = Date.now();
    if (cache && t - cache.at < GEOFENCE_PERMISSION_TTL_MS) return cache.v;
    let v = false;
    try {
      const r = await getBackgroundPermissionsAsync();
      v = r.granted || r.status === 'granted';
    } catch {
      v = false;
    }
    cache = { at: t, v };
    return v;
  };
}

const defaultDeps = (getDeps: () => PipelineDeps): PipelineDeps => ({
  probeAuth: () => probeFirebaseAuth(),
  publisherDeps: firebasePublisherDeps,
  waitOnline: waitForConnection,
  readDevice: readDeviceStatus,
  engine: locationEngine,
  appPhase: appPhaseNow,
  deviceNow: () => Date.now(),
  isBlocked: isShareBlocked,
  hydrateBlocks: hydrateStopIntents,
  linkPublisherDeps: firebaseLinkPublisherDeps,
  isLinkBlocked,
  hydrateLinkBlocks: hydrateLinkStops,
  adaptive: createAdaptiveController({ io: () => getDeps().engine }),
  outbox: outboxRepo,
  isOnline: isConnected,
  writeRaw: (map) => writeFanout(map),
  lastActivity: lastActivityEvent,
  canUseGeofence: cachedGeofencePermission(),
  callPending: callPendingFirebase,
  newOpId: uuidV4,
  statusNote: async (uid) => {
    const p = await loadStatusNote();
    return p && p.uid === uid ? p.note : null;
  },
  isHeld: isPublishHeld,
  hydrateHold: hydratePublishHold,
  onBreak: breakHoldsPublishing,
  batteryShare: batteryShareAllowed,
  lastDepartureAt: async (uid) => {
    const m = await loadMovement();
    return m && m.uid === uid ? m.last_report_at : null;
  },
  reportDeparture: defaultReportDeparture,
  recordFix: recordLastFix,
  f9: f9Hooks,
});

/**
 * Faz 7: "yola çıktı" — yalnızca ARKADAŞ paylaşımı sürerken, çevrimiçiyken ve kesme anahtarı kapalıyken. Bağlantı (QR)
 * izleyicilerine bildirim gitmez. Bildirim anı geçişin anıdır (sunucu 5 dk'dan eskisini atar).
 */
async function maybeReportDeparture(d: PipelineDeps, uid: UserId, obs: Pick<ObserveResult, 'motion' | 'previous'>, now: EpochMs, hasFriendTargets: boolean): Promise<void> {
  if (!hasFriendTargets || !obs.previous || d.isHeld() || !d.isOnline()) return;
  const stillSince = obs.previous.state === 'stationary' ? obs.previous.since : null;
  const last = await d.lastDepartureAt(uid).catch(() => null);
  if (!shouldReportDeparture(obs.previous.state, obs.motion, stillSince, now, last)) return;
  await Promise.race([d.reportDeparture(uid, now).catch(() => undefined), new Promise<void>((r) => setTimeout(r, DEPARTURE_CALL_TIMEOUT_MS))]);
}

export interface SamplePipeline {
  handleSamples: (raws: readonly RawLocationSample[], source: SampleSource) => Promise<void>;
  /**
   * Faz 3: örneksiz hareket olayı (zamanlayıcı, OS etkinliği, uyku çiti çıkışı). Çit çıkışında ve uyku
   * modunda kalp atışı zamanı geldiğinde tek seferlik ölçüm alınıp hat çalıştırılır.
   */
  handleMotionEvent: (event: MotionEvent | { type: 'geofence_exit' | 'tick' }) => Promise<void>;
  /** Faz 3: kuyruğu boşalt (bağlantı geldi / ön plana dönüş). `force` geri çekilmeyi atlar. */
  flushOutbox: (force?: boolean) => Promise<void>;
  /**
   * Faz 3: ön plan (sharingCoordinator) güncel hedeflerle arka plan planını ŞİMDİ uygular (debounce yok).
   * `applied: false` = platform şu an izin vermiyor (Android arka planı) ya da hedef yok.
   */
  applyTrackingNow: () => Promise<{ applied: boolean; failed: boolean; profileId: TrackingProfileId | null }>;
  /** Faz 3: çıkış / paylaşım bitti: hareket durumu ve uyku çiti sıfırlanır. */
  resetAdaptive: () => Promise<void>;
  /** Faz 8: kesme anahtarı açıldıysa ŞİMDİ uygula (hedefler boşalır, takip kapanır, kuyruk silinir). */
  applyHold: () => Promise<void>;
}

export function createSamplePipeline(overrides: Partial<PipelineDeps> = {}): SamplePipeline {
  let resolved: PipelineDeps | null = null;
  const deps = (): PipelineDeps => (resolved ??= { ...defaultDeps(deps), ...overrides });

  // İşletim sistemi örnekleri yığın halinde ve üst üste gönderebilir: işlemleri sıraya diz.
  // Ağ adımları zaman aşımlıdır; zincir çevrimdışıyken sonsuza dek beklemez.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    const next = chain.then(fn).catch((e: unknown) => {
      if (__DEV__) console.warn('[konum] konum hattı hatası', e);
      return fallback;
    });
    chain = next;
    return next;
  };

  return {
    handleSamples: (raws, source) => enqueue(() => processSamples(deps(), raws, source), undefined),
    handleMotionEvent: (event) => enqueue(() => processMotion(deps(), event), undefined),
    flushOutbox: (force = false) => enqueue(() => flushStandalone(deps(), force), undefined),
    applyTrackingNow: () => enqueue(() => applyStandalone(deps()), { applied: false, failed: true, profileId: null }),
    resetAdaptive: () => enqueue(() => deps().adaptive.reset(), undefined),
    applyHold: () =>
      enqueue(async () => {
        const d = deps();
        await d.hydrateHold();
        if (d.isHeld()) await pruneAndMaybeStop(d);
      }, undefined),
  };
}

/** Ön planın "şimdi uygula" isteği (yeni hedef, yeni bildirim metni, ön plana dönüş). */
async function applyStandalone(d: PipelineDeps): Promise<{ applied: boolean; failed: boolean; profileId: TrackingProfileId | null }> {
  await d.hydrateHold();
  const persisted = await loadTargets();
  const now = serverNow(persisted.serverOffsetMs, d.deviceNow());
  const targets = persisted.targets.filter(usableAt(d, now));
  const linkTargets = persisted.linkTargets.filter(usableLinkAt(d, now));
  if (!persisted.uid || (targets.length === 0 && linkTargets.length === 0)) return { applied: false, failed: false, profileId: null };
  const device = await d.readDevice();
  const obs = await d.adaptive.observe({
    events: [],
    ctx: { now, appPhase: d.appPhase(), batteryPct: batteryPct(device.batteryLevel), isCharging: device.isCharging, canUseGeofence: await d.canUseGeofence() },
    sessionKeys: sessionKeysOf(targets, linkTargets),
    notification: serviceNotificationFor(targets, linkTargets),
    force: true,
  });
  const failed = !obs.apply.apply && obs.apply.reason === 'failed';
  if (obs.apply.apply) await saveProfileId(obs.bgPlan.profile.id).catch(() => undefined);
  return { applied: obs.apply.apply, failed, profileId: obs.bgPlan.profile.id };
}

/** Faz 8: kesme anahtarı açıkken hiçbir hedef kullanılabilir değildir (yayın yok, takip kapanır). */
const usableAt = (d: PipelineDeps, now: EpochMs) => (t: PersistedTarget) => !d.isHeld() && !isExpired(t, now) && !d.isBlocked(t.share_id);
const usableLinkAt = (d: PipelineDeps, now: EpochMs) => (t: PersistedLinkTarget) => !d.isHeld() && !isExpired(t, now) && !d.isLinkBlocked(t.link_id);

/** Yayın kararındaki "hedef listesi değişti mi" anahtarı: arkadaş anahtarı + bağlantı kimlikleri. */
export function combinedTargetsKey(targets: readonly PersistedTarget[], links: readonly PersistedLinkTarget[]): string {
  const base = publishTargetsKey(targets);
  if (links.length === 0) return base; // Faz 1 imleç anahtarıyla aynı (yükseltmede gereksiz yayın olmaz)
  const l = links.map((t) => `${t.link_id}:${t.expires_at ?? '-'}`).sort().join(',');
  return `${base}|L:${l}`;
}

/**
 * Kilit içinde: süresi dolan / durdurulan hedefleri (arkadaş + bağlantı) EN GÜNCEL listeden çıkar;
 * kullanılabilir hedef kalmadıysa takibi kapat ve kendi son konumunu (imleç) sil.
 */
async function pruneAndMaybeStop(d: PipelineDeps): Promise<void> {
  const stopNeeded = await inTargetsLock(async (latest, write) => {
    const now = serverNow(latest.serverOffsetMs, d.deviceNow());
    const keep = latest.targets.filter(usableAt(d, now));
    const keepLinks = latest.linkTargets.filter(usableLinkAt(d, now));
    if (keep.length !== latest.targets.length || keepLinks.length !== latest.linkTargets.length) {
      await write({ ...latest, targets: keep, linkTargets: keepLinks });
    }
    if (latest.uid && (keep.length > 0 || keepLinks.length > 0)) return false;
    await d.engine.stopBackground().catch(() => undefined);
    return true;
  });
  if (stopNeeded) {
    await clearCursor().catch(() => undefined);
    // Paylaşım kalmadı: hareket durumu ve kuyruk (kendi konum noktaların) silinir.
    await d.adaptive.reset().catch(() => undefined);
    await d.outbox.purge().catch(() => undefined);
  }
}

// --- Faz 3 yardımcıları ------------------------------------------------------------------------

/** Faz 9: etkin arkadaş paylaşım oturumları (yaklaşma raporu oturum başına; eski kayıtta oturum kimliği yok). */
export function friendSessionIds(targets: readonly PersistedTarget[]): string[] {
  return [...new Set(targets.map((t) => t.session_id).filter((s): s is string => typeof s === 'string' && s.length > 0))];
}

/** Düşük pil durumu oturum başına: arkadaş oturumu `s:<session_id>` (eski kayıtta `s:share:<share_id>`), bağlantı `l:<link_id>`. */
export function sessionKeysOf(targets: readonly PersistedTarget[], links: readonly PersistedLinkTarget[]): string[] {
  return [...new Set([...targets.map((t) => (t.session_id ? `s:${t.session_id}` : `s:share:${t.share_id}`)), ...links.map((t) => `l:${t.link_id}`)])];
}

/** Ön plan servisi bildirimi: "Konumun paylaşılıyor · 14:45'e kadar" / "· Süresiz" + "2 kişiyle". */
export function serviceNotificationFor(targets: readonly PersistedTarget[], links: readonly PersistedLinkTarget[]): ServiceNotification {
  const receivers = new Set(targets.map((t) => t.receiver_id)).size;
  return {
    title: serviceTitleFor([...targets.map((t) => t.expires_at), ...links.map((t) => t.expires_at)]),
    body: audienceText(receivers, links.length),
  };
}

export const toShareOutboxTarget = (t: PersistedTarget): OutboxTarget => ({
  kind: 'share',
  share_id: t.share_id,
  receiver_id: t.receiver_id,
  share_mode: t.share_mode,
  expires_at: t.expires_at,
  started_at: t.started_at ?? null,
});

export const toLinkOutboxTarget = (t: PersistedLinkTarget): OutboxTarget => ({
  kind: 'link',
  token_hash: t.token_hash,
  share_mode: t.share_mode,
  expires_at: t.expires_at,
  sender_name: t.sender_name,
  started_at: t.started_at ?? null,
});

function toOutboxSample(s: NormalizedSample, device: DeviceStatus, raw: RawLocationSample, activity: ReturnType<typeof motionToActivity>, hb: number): OutboxSample {
  const pct = batteryPct(device.batteryLevel);
  return {
    lat: s.lat,
    lng: s.lng,
    accuracy: s.accuracy,
    speed_mps: s.speed_mps,
    heading: s.heading,
    activity_state: activity,
    battery_pct: pct,
    is_charging: pct === null ? null : device.isCharging,
    timestamp: s.timestamp,
    // Cihaz saati sunucudan ≥ 55 dk ileri / bozuksa sunucu ölçüm anı (RTDB kuralı `recorded_at ≤ now + 1 sa`).
    recorded_at: safeRecordedAt(raw.timestamp, s.timestamp),
    hb,
  };
}

/** Kuyruğu boşalt (çağıran çevrimiçi olduğunu bilir). En güncel kalıcı hedeflerle ve kesme anahtarıyla. */
async function flushQueue(d: PipelineDeps, uid: UserId, now: EpochMs, lastLiveTs: EpochMs | null, force: boolean): Promise<EpochMs | null> {
  const fresh = await loadTargets();
  if (fresh.uid !== uid) return null;
  const shares = fresh.targets.filter(usableAt(d, now));
  const links = fresh.linkTargets.filter(usableLinkAt(d, now));
  const linkIdByHash = new Map(fresh.linkTargets.map((t) => [t.token_hash, t.link_id] as const));
  // Faz 7: pil paylaşımı (sonradan) kapandıysa kuyruktaki eski örneklerin pil alanları da gitmez (kural reddederdi).
  const shareBattery = await d.batteryShare(uid).catch(() => false);
  const r = await d.outbox.flush({
    uid,
    now,
    targets: [...shares.map(toShareOutboxTarget), ...links.map(toLinkOutboxTarget)],
    isAllowed: (t) => !d.isHeld() && (t.kind === 'share' ? !d.isBlocked(t.share_id) : !d.isLinkBlocked(linkIdByHash.get(t.token_hash) ?? '')),
    write: shareBattery ? d.writeRaw : (map) => d.writeRaw(stripBatteryFields(map)),
    call: d.callPending,
    lastLiveTs,
    force,
  });
  if (r.status === 'ok' || r.status === 'partial') {
    if (__DEV__ && r.status === 'partial') console.warn('[konum] kuyruk kısmen boşaltıldı', r.error);
    if (r.liveTs !== null) {
      const next = Math.max(lastLiveTs ?? -Infinity, r.liveTs);
      await saveCursor({ lastLiveTs: next });
      return next;
    }
  }
  return lastLiveTs;
}

/** Bağlantı geldi: oturumu doğrula, sonra boşalt. */
async function flushStandalone(d: PipelineDeps, force: boolean): Promise<void> {
  if ((await d.outbox.pendingCount()) === 0) return;
  await d.hydrateBlocks();
  await d.hydrateLinkBlocks();
  await d.hydrateHold();
  if (d.isHeld()) {
    await pruneAndMaybeStop(d);
    return;
  }
  const persisted = await loadTargets();
  if (!persisted.uid) return;
  const auth = await d.probeAuth();
  if (auth.kind !== 'signed_in' || auth.uid !== persisted.uid) return;
  if (!(await d.waitOnline(CONNECT_WAIT_MS))) return;
  const now = serverNow(persisted.serverOffsetMs, d.deviceNow());
  const cursor = await loadCursor();
  await flushQueue(d, auth.uid, now, cursor.lastLiveTs, force);
}

/**
 * Düşük pil: tetiklenen (ya da bildirimden sonra yeniden kurulan) her ARKADAŞ oturumu için `battery_low_notify`.
 * Çevrimdışı / geçici hatada çağrı kalıcı kuyruğa girer ve aynı op_id ile yeniden denenir. Bağlantılara (QR) push
 * yoktur: anonim izleyici `link_live.battery_pct` rozetini görür.
 */
async function notifyLowBattery(
  d: PipelineDeps,
  uid: UserId,
  keys: readonly string[],
  device: DeviceStatus,
  online: boolean,
  now: EpochMs,
): Promise<void> {
  const pct = batteryPct(device.batteryLevel);
  if (pct === null) return;
  for (const k of keys) {
    if (!k.startsWith('s:') || k.startsWith('s:share:')) continue; // oturum kimliği bilinmiyor / bağlantı
    const op_id = d.newOpId();
    const payload: Record<string, unknown> = { op_id, session_id: k.slice(2), battery_pct: Math.round(pct) };
    if (device.isCharging !== null) payload.is_charging = device.isCharging;
    const call: Omit<PendingCall, 'attempts'> = { op_id, name: BATTERY_LOW_NOTIFY, payload, created_at: now };
    if (online && (await d.callPending({ ...call, attempts: 0 })) !== 'retry') continue;
    await d.outbox.queueCall(uid, call);
  }
}

async function processMotion(d: PipelineDeps, event: MotionEvent | { type: 'geofence_exit' | 'tick' }): Promise<void> {
  await d.hydrateBlocks();
  await d.hydrateLinkBlocks();
  await d.hydrateHold();
  const persisted = await loadTargets();
  const now = serverNow(persisted.serverOffsetMs, d.deviceNow());
  const targets = persisted.targets.filter(usableAt(d, now));
  const linkTargets = persisted.linkTargets.filter(usableLinkAt(d, now));
  if (!persisted.uid || (targets.length === 0 && linkTargets.length === 0)) {
    await pruneAndMaybeStop(d);
    return;
  }
  const e: MotionEvent = 'at' in event ? event : { type: event.type, at: now };
  const device = await d.readDevice();
  const obs = await d.adaptive.observe({
    events: [e],
    ctx: { now, appPhase: d.appPhase(), batteryPct: batteryPct(device.batteryLevel), isCharging: device.isCharging, canUseGeofence: await d.canUseGeofence() },
    sessionKeys: sessionKeysOf(targets, linkTargets),
    notification: serviceNotificationFor(targets, linkTargets),
  });
  await maybeReportDeparture(d, persisted.uid, obs, now, targets.length > 0);
  const cursor = await loadCursor();
  const hb = obs.sendPlan.row.heartbeatMs;
  const heartbeatDue = !cursor.lastPublished || now - cursor.lastPublished.sent_at >= hb - HEARTBEAT_SLACK_MS;
  const needFix = e.type === 'geofence_exit' || obs.lowBatteryFired.length > 0 || (e.type === 'tick' && heartbeatDue);
  const carry = { lowBatteryFired: obs.lowBatteryFired, lowBatteryRearmed: obs.lowBatteryRearmed };
  const raw = needFix && d.engine.getCurrentSample ? await d.engine.getCurrentSample() : null;
  if (raw) {
    await processSamples(d, [raw], 'heartbeat', carry);
    return;
  }
  // Ölçüm yok ama durum değişti: bildirim / yeniden kurma çağrısı yine gitsin (çevrimdışıysa kuyruğa).
  const keys = [...obs.lowBatteryFired, ...obs.lowBatteryRearmed];
  if (keys.length && persisted.uid && (await d.batteryShare(persisted.uid).catch(() => false))) {
    await notifyLowBattery(d, persisted.uid, keys, device, d.isOnline(), now);
  }
}

async function processSamples(
  d: PipelineDeps,
  raws: readonly RawLocationSample[],
  source: SampleSource,
  carry: { lowBatteryFired?: readonly string[]; lowBatteryRearmed?: readonly string[] } = {},
): Promise<void> {
  await d.hydrateBlocks();
  await d.hydrateLinkBlocks();
  await d.hydrateHold();
  const persisted = await loadTargets();
  const offset = persisted.serverOffsetMs;
  const nowFn = () => serverNow(offset, d.deviceNow());
  const now = nowFn();
  const targets = persisted.targets.filter(usableAt(d, now));
  const linkTargets = persisted.linkTargets.filter(usableLinkAt(d, now));

  // Faz 9: son doğrulanmış konum (paylaşım olmasa da; çevrimdışı SOS SMS'i).
  const newest = raws.reduce<RawLocationSample | null>((a, r) => (!a || r.timestamp > a.timestamp ? r : a), null);
  if (newest) await d.recordFix(newest, offset, persisted.uid).catch(() => undefined);

  if (!persisted.uid || (targets.length === 0 && linkTargets.length === 0)) {
    await pruneAndMaybeStop(d);
    return;
  }

  const auth = await d.probeAuth();
  if (auth.kind === 'unknown') return; // zaman aşımı: bu örneği atla, kalıcı duruma dokunma
  if (auth.kind === 'signed_out') {
    const cursor = await loadCursor();
    if (cursor.authMissingSince === null) {
      await saveCursor({ authMissingSince: now });
      return;
    }
    if (now - cursor.authMissingSince < AUTH_MISSING_GRACE_MS) return;
    await wipeTargetsIfUid(persisted.uid);
    await pruneAndMaybeStop(d);
    return;
  }
  if (auth.uid !== persisted.uid) {
    // Başka hesap: eski hesabın hedefleriyle hiçbir şey yazma (yalnızca liste hâlâ eski hesabınsa sil).
    await wipeTargetsIfUid(persisted.uid);
    await pruneAndMaybeStop(d);
    return;
  }
  const uid = auth.uid;
  // Faz 12: molada yeni konum gitmez (kuyruğa da girmez); takip sürer, mola bitince ilk örnek yayınlanır.
  if (await d.onBreak(uid, now).catch(() => false)) return;

  const sorted = [...raws].sort((a, b) => a.timestamp - b.timestamp);
  const latest = sorted[sorted.length - 1];
  if (!latest) return;
  const norm = normalizeSample(latest, { serverOffsetMs: offset, now });
  if (!norm.ok) return;

  const device = await d.readDevice();
  const pct = batteryPct(device.batteryLevel);
  const appPhase = d.appPhase();
  // Faz 7: yayına giden cihaz durumu (pil paylaşımı kapalıysa pil yok); takip kararları gerçek pil düzeyiyle.
  const shareBattery = await d.batteryShare(uid).catch(() => false);
  const pubDevice = shareBattery ? device : withoutBattery(device);
  const pubPct = shareBattery ? pct : null;

  // Faz 3: hareket makinesi ← toplu örneklerin hepsi (+ son OS etkinliği); plan ← matris.
  const events: MotionEvent[] = [];
  for (const r of sorted) {
    const n = r === latest ? norm : normalizeSample(r, { serverOffsetMs: offset, now });
    if (n.ok) events.push({ type: 'fix', lat: n.sample.lat, lng: n.sample.lng, accuracy: n.sample.accuracy, speed_mps: n.sample.speed_mps, at: n.sample.timestamp });
  }
  const osActivity = d.lastActivity(offset);
  if (osActivity) events.push(osActivity);
  const obs: ObserveResult = await d.adaptive.observe({
    events,
    ctx: { now, appPhase, batteryPct: pct, isCharging: device.isCharging, canUseGeofence: await d.canUseGeofence() },
    sessionKeys: sessionKeysOf(targets, linkTargets),
    notification: serviceNotificationFor(targets, linkTargets),
  });
  const plan = obs.sendPlan;
  const activity = obs.motion === 'unknown' ? inferActivityFromSpeed(norm.sample.speed_mps) : motionToActivity(obs.motion);
  const hb = plan.row.heartbeatMs;
  // Pil paylaşımı kapalıyken düşük pil ne yayını zorlar ne bildirim çağrısı yapar (sunucu da bastırır).
  const lowFired = shareBattery ? [...new Set([...(carry.lowBatteryFired ?? []), ...obs.lowBatteryFired])] : [];
  const lowNotify = shareBattery ? [...new Set([...lowFired, ...(carry.lowBatteryRearmed ?? []), ...obs.lowBatteryRearmed])] : [];
  await maybeReportDeparture(d, uid, obs, now, targets.length > 0);
  // Faz 9: yaklaşma / Güvenli Dönüş (oturum yoksa yalnızca Güvenli Dönüş) ve paket alanları.
  const f9Extras: F9Extras = await d.f9
    .onSample({
      uid,
      sample: norm.sample,
      activity,
      now,
      sessionIds: friendSessionIds(targets),
      battery_pct: pct,
      is_charging: pct === null ? null : device.isCharging,
    })
    .catch(() => ({}));

  const cursor = await loadCursor();
  if (cursor.authMissingSince !== null) await saveCursor({ authMissingSince: null });
  const key = combinedTargetsKey(targets, linkTargets);
  // Faz 4: durum notu (süresi geçmişse boş). Not eklendi / değişti / kalktı → hemen yayın (alıcı hemen görsün).
  const noteExtras = targets.length ? statusNoteExtras(await d.statusNote(uid).catch(() => null), now) : {};
  // Faz 9: fotoğraf / hedef değişince de yayın zorlanır (Faz 9 alanı yoksa anahtar Faz 4'teki gibi kalır).
  const f9Key = targets.length ? f9ExtrasKey(f9Extras) : '';
  const noteKey = (noteExtras.note ?? '') + (f9Key ? `#${f9Key}` : '');
  const noteChanged = targets.length > 0 && (cursor.lastNoteKey ?? '') !== noteKey;
  const force = cursor.lastTargetsKey !== key || needsHeartbeatAnnounce(obs.lastSentHb, plan) || lowFired.length > 0 || noteChanged;
  const decision = shouldPublish(cursor.lastPublished, { sample: norm.sample, battery_pct: pubPct, activity }, plan.profile, now, force);
  let lastLiveTs = cursor.lastLiveTs;

  if (decision.publish) {
    // Durdurma yarışı: pil okuma vb. sürerken kullanıcı "Durdur"a bastıysa hedefler değişmiştir.
    // Yazmadan hemen önce kalıcı listeyi yeniden oku ve kesişimi kullan (yalnızca daralabilir).
    const fresh = await loadTargets();
    const tNow = nowFn();
    const latestIds = new Set(fresh.targets.filter(usableAt(d, tNow)).map((t) => t.share_id));
    const latestLinkIds = new Set(fresh.linkTargets.filter(usableLinkAt(d, tNow)).map((t) => t.link_id));
    const finalTargets = targets.filter((t) => latestIds.has(t.share_id));
    const finalLinks = linkTargets.filter((t) => latestLinkIds.has(t.link_id));
    if (finalTargets.length === 0 && finalLinks.length === 0) return;
    const lastPublished = { lat: norm.sample.lat, lng: norm.sample.lng, sent_at: now, battery_pct: pubPct, activity };
    const queueSample = toOutboxSample(norm.sample, pubDevice, latest, activity, hb);

    // Çevrimdışı: RTDB SDK kuyruğuna DEĞİL, Faz 3 kalıcı kuyruğuna (zincir beklemez; "Durdur" kuyruğu da temizler).
    if (!(await d.waitOnline(CONNECT_WAIT_MS))) {
      await d.outbox.enqueue(uid, queueSample, [...finalTargets.map(toShareOutboxTarget), ...finalLinks.map(toLinkOutboxTarget)], now);
      // Gönderim kadansı kuyruğa da uygulanır (her ölçüm kuyruğa girmesin).
      await saveCursor({ lastPublished, lastTargetsKey: key });
      await d.adaptive.noteSent(hb);
      if (lowNotify.length) await notifyLowBattery(d, uid, lowNotify, device, false, now);
      return;
    }
    // Çevrimiçi: önce kuyruk (eski noktalar canlı düğümdeki taze noktayı ezmesin diye taze yayından ÖNCE).
    if ((await d.outbox.pendingCount()) > 0) lastLiveTs = await flushQueue(d, uid, now, lastLiveTs, false);

    // Arkadaşlar ve bağlantılar AYRI yazmalarla: birinin kural reddi diğerini düşürmez.
    const extras = { hb };
    // Faz 4: not yalnızca arkadaş paketlerine (bağlantı izleyicilerine gitmez). Faz 9: fotoğraf ve hedef de.
    const friendExtras = { hb, ...noteExtras, ...f9Extras };
    const friendResult: PublishResult | null = finalTargets.length
      ? await publishSample(
          { sample: norm.sample, device: pubDevice, senderId: uid, targets: finalTargets, now, activity, extras: friendExtras },
          { ...d.publisherDeps(uid, nowFn), isAllowed: (id) => !d.isHeld() && !d.isBlocked(id) },
        )
      : null;
    const linkResult: LinkPublishResult | null = finalLinks.length
      ? await publishLinkSample(
          { sample: norm.sample, device: pubDevice, targets: finalLinks, now, extras },
          { ...d.linkPublisherDeps(uid, nowFn), isAllowed: (id) => !d.isHeld() && !d.isLinkBlocked(id) },
        )
      : null;
    /** Yazılamayan (ağ / zaman aşımı) hedefler kuyruğa. */
    const failedTargets: OutboxTarget[] = [];

    let prune = false;
    if (friendResult) {
      switch (friendResult.status) {
        case 'published':
          if (friendResult.dropped.length) await removeTargetIds(friendResult.dropped, uid);
          if (friendResult.retried) await refreshTargetExpiries(friendResult.targets, uid);
          break;
        case 'no_active_targets':
          await removeTargetIds(friendResult.dropped, uid);
          prune = true;
          break;
        case 'failed':
          if (friendResult.dropped.length) await removeTargetIds(friendResult.dropped, uid);
          failedTargets.push(...finalTargets.filter((t) => friendResult.targets.some((f) => f.share_id === t.share_id)).map(toShareOutboxTarget));
          if (__DEV__) console.warn('[konum] yayın başarısız, kuyruğa alındı', friendResult.error);
          break;
        case 'skipped':
          if (friendResult.dropped.length) await removeTargetIds(friendResult.dropped, uid);
          if (friendResult.reason === 'blocked') prune = true;
          break;
      }
    }
    if (linkResult) {
      switch (linkResult.status) {
        case 'published':
          if (linkResult.dropped.length) await removeLinkTargetIds(linkResult.dropped, uid);
          if (linkResult.retried) await refreshLinkTargetExpiries(linkResult.targets, uid);
          break;
        case 'no_active_targets':
          await removeLinkTargetIds(linkResult.dropped, uid);
          prune = true;
          break;
        case 'failed':
          if (linkResult.dropped.length) await removeLinkTargetIds(linkResult.dropped, uid);
          failedTargets.push(...finalLinks.filter((t) => linkResult.targets.some((f) => f.link_id === t.link_id)).map(toLinkOutboxTarget));
          if (__DEV__) console.warn('[konum] bağlantı yayını başarısız, kuyruğa alındı', linkResult.error);
          break;
        case 'skipped':
          if (linkResult.dropped.length) await removeLinkTargetIds(linkResult.dropped, uid);
          if (linkResult.reason === 'blocked') prune = true;
          break;
      }
    }

    const sentFriends = friendResult?.status === 'published' ? friendResult.targets : [];
    const sentLinks = linkResult?.status === 'published' ? linkResult.targets : [];
    if (failedTargets.length) await d.outbox.enqueue(uid, queueSample, failedTargets, now);
    if (sentFriends.length || sentLinks.length) {
      lastLiveTs = Math.max(lastLiveTs ?? -Infinity, norm.sample.timestamp);
      await saveCursor({
        lastPublished,
        lastTargetsKey: combinedTargetsKey(sentFriends, sentLinks),
        lastLiveTs,
        ...(sentFriends.length ? { lastNoteKey: noteKey } : {}),
      });
    } else if (failedTargets.length) {
      await saveCursor({ lastPublished, lastTargetsKey: key });
    }
    if (sentFriends.length || sentLinks.length || failedTargets.length) await d.adaptive.noteSent(hb);
    if (lowNotify.length) await notifyLowBattery(d, uid, lowNotify, device, sentFriends.length > 0 || sentLinks.length > 0, now);
    if (prune) {
      await pruneAndMaybeStop(d);
      return;
    }
  } else if (d.isOnline() && (await d.outbox.pendingCount()) > 0) {
    // Yayın gerekmedi ama bağlantı var: her uyanışta kuyruğu boşaltmayı dene (geri çekilmeye uyar).
    await flushQueue(d, uid, now, lastLiveTs, false);
  }

  // Faz 3: OS konum isteği uyarlamalı denetleyicide (observe) satır değişince yeniden yapılandırılır.
  if (obs.apply.apply) await saveProfileId(obs.bgPlan.profile.id).catch(() => undefined);
  void source;
}

const defaultPipeline = createSamplePipeline();

export function handleSamples(raws: readonly RawLocationSample[], source: SampleSource): Promise<void> {
  // Faz 5: arka plan görevi / nabız örnekleri bölge filtresine de gider (ön plan izleme ayrıca beslenir, f5Services).
  if (source !== 'watch') tapZoneSamples(raws, source);
  return defaultPipeline.handleSamples(raws, source);
}

/** Faz 3: zamanlayıcı / OS etkinliği / uyku çiti çıkışı (backgroundTask.ts, adaptive/runtime.ts). */
export function handleMotionEvent(event: MotionEvent | { type: 'geofence_exit' | 'tick' }): Promise<void> {
  return defaultPipeline.handleMotionEvent(event);
}

/** Faz 3: kuyruğu boşalt (sharingCoordinator: `.info/connected` true, ön plana dönüş). */
export function flushOutbox(force = false): Promise<void> {
  return defaultPipeline.flushOutbox(force);
}

export function applyTrackingNow(): ReturnType<SamplePipeline['applyTrackingNow']> {
  return defaultPipeline.applyTrackingNow();
}

export function resetAdaptive(): Promise<void> {
  return defaultPipeline.resetAdaptive();
}

/** Faz 8: görünmez oldu / onay kapısı açıldı → hedefleri ŞİMDİ boşalt, takibi kapat (sonraki örneği beklemeden). */
export function applyPublishHold(): Promise<void> {
  return defaultPipeline.applyHold();
}
