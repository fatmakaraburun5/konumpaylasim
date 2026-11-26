/**
 * Faz 4: tam konumlu acil durum (SOS) — core `sos.ts`.
 *
 * Gönderen (`send`):
 *  1. Acil kişi yoksa AĞA ÇIKMADAN `no_emergency_contacts` (arayüz kişi seçimini açar).
 *  2. Tam konum ZORUNLU: yeterince taze ve doğru son konum varsa hemen o; yoksa yüksek doğrulukta tek ölçüm
 *     (en çok `SOS_LIMITS.freshFixTimeoutMs`, geri sayım sırasında `prepare()` ile önceden başlatılabilir); olmazsa
 *     son bilinen konum (eski olsa bile; alıcı "eski konum" uyarısı görür). Hiç konum yoksa ön plan izni istenir;
 *     yine yoksa `invalid_argument` + "Konumun alınamadı".
 *  3. Pil (deviceStatus) ve adres (geocodeRepo önbelleği / en çok `addressTimeoutMs`, hata yutulur) paralel.
 *  4. `sos_send` ağ hatasında (`unavailable`) AYNI op_id ile 3 sn arayla 5 kez daha denenir (sunucu bir kez uygular).
 *  5. Başarıdan sonra best-effort: sunucu görünmezliği kapattığı için yerel görünmez niyeti HEMEN silinir (profil
 *     anlık görüntüsü beklenmez); sonra acil kişilere zaten canlı paylaşım yoksa 1 saatlik paylaşım başlatılır
 *     [Varsayım]. Konum izni (`location_view`) kendiliğinden VERİLMEZ: izni olmayan kişilerle canlı paylaşım başlamaz
 *     ve bu SOS ekranında söylenir (`liveShareSkipped`; SOS konumunu yine görürler). Aktifken uygulama öndeyken
 *     koordinatör her `updateMinIntervalMs`'de `updateTick()` ile konumu tazeler.
 * Alıcı: `sos_alerts` (recipient_ids array-contains ben) → `applyReceived`; yeni aktif SOS (benim "Gördüm" demediğim)
 * `focusedSosId`'yi en yeniye ayarlar → tam ekran acil durum kartı.
 *
 * Faz 9 (çevrimdışı SOS SMS yedeği, docs/PHASE9.md §4.4): gönderim başlarken RTDB `.info/connected` en çok
 * `SOS_CONNECT_WAIT_MS` beklenir (`online`). Bağlantı yoksa, `sos_send` ağ hatasıyla düşerse ya da
 * `SMS_FALLBACK_LIMITS.onlineTimeoutMs` içinde yanıt gelmezse core `offlineSosDecision` → `offline` ('offer_sms' →
 * "SMS ile gönder (N kişi)"). O an `send()` `unavailable` + `SMS_FALLBACK_TEXT.offlineBody` ile ERKEN döner, ama
 * gönderim AYNI op_id ile arka planda (bağlantı gelince) `OFFLINE_RETRY_WINDOW_MS` boyunca denenmeye devam eder
 * (`phase` 'sending' kalır; yeniden `send()` denemeyi hemen uyandırır, `cancelPending()` bırakır). SMS gövdesi
 * `smsBody()` (core `sosSmsBody`: bu denemenin konumu ya da `konum.bg.lastFix.v1`, pil, profil adı, aktif Güvenli
 * Dönüş hedefi), `sendSms()` cihazın SMS uygulamasını hazır dolu açar.
 */
import {
  batteryPct,
  ERROR_CODES,
  isSosActive,
  isSosVisible,
  offlineSosDecision,
  selectPublishTargets,
  SMS_FALLBACK_LIMITS,
  SMS_FALLBACK_TEXT,
  SOS_LIMITS,
  sosSmsBody,
  uuidV4,
  VERIFIED_ACCURACY_M,
  type DeviceStatus,
  type EpochMs,
  type OfflineSosDecision,
  type RawLocationSample,
  type SmsFallbackSettings,
  type SosSendOutcome,
  type SosAlert,
  type SosLocation,
  type SosRoute,
  type UserId,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { getServerOffsetMs, now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { sosApi, type SosApi } from '../services/firebase/callables';
import { isConnected, waitForConnection } from '../services/firebase/liveRepo';
import { locationEngine } from '../services/location/ExpoLocationEngine';
import { readDeviceStatus } from '../services/location/deviceStatus';
import { getLastFix } from '../services/location/lastFix';
import { geocodeRepo } from '../services/maps/geocodeRepo';
import { composeSms, type SmsComposeResult } from '../services/sms/smsComposer';
import { authStore } from './authStore';
import { invisibleStore } from './invisibleStore';
import { locationStore } from './locationStore';
import { permissionsStore } from './permissionsStore';
import type { PersistedLastFix } from './persist';
import type { Result } from './pingStore';
import { sharingStore } from './sharingStore';
import { smsFallbackStore } from './smsFallbackStore';

/** Faz 9: SOS denemesinin girdileri (SMS gövdesi bunlardan kurulur). */
export interface SosAttempt {
  location: SosLocation | null;
  battery_pct: number | null;
  is_charging: boolean | null;
  route: SosRoute | null;
  at: EpochMs;
}

export type SosSmsResult = SmsComposeResult | 'unavailable' | 'not_configured';

export interface SosState {
  /** `users/{ben}.emergency_contacts` (profil dinleyicisi). */
  emergencyContacts: UserId[];
  /**
   * Profil dinleyicisinden (ya da `setEmergencyContacts` yanıtından) ilk liste geldi mi. Gelmeden önce boş liste
   * "kişi yok" demek DEĞİLDİR: `send()` kararı sunucuya bırakır (açılışta hemen SOS'ta seçim ekranı çıkmasın).
   */
  contactsLoaded: boolean;
  contactsSaving: boolean;
  setEmergencyContacts(ids: UserId[]): Promise<Result>;
  /** Benim aktif (ya da az önce çözülmüş) SOS'um. */
  outgoing: SosAlert | null;
  phase: 'idle' | 'sending' | 'active' | 'resolving';
  error: string | null;
  /** SOS'la başlatılan canlı paylaşımın konum izni olmadığı için başlamadığı acil kişiler (SOS'u yine görürler). */
  liveShareSkipped: UserId[];
  send(opts?: { route?: SosRoute | null }): Promise<Result<{ sos_id: string }>>;
  /**
   * "Güvendeyim". `sosId` verilirse (Güvenli Dönüş alarmı: SOS'u sunucu açtı, dinleyici henüz getirmemiş olabilir)
   * o SOS sunucuda kapatılır; verilmezse bilinen etkin giden SOS. Hiçbir SOS bilinmiyorsa true (kapatılacak yok).
   */
  resolve(sosId?: string | null): Promise<boolean>;
  /** Alıcısı olduğum, `isSosVisible` olanlar. */
  incoming: Record<string, SosAlert>;
  // --- Faz 9: çevrimdışı SOS ---
  /** Son hatanın kodu (`error` ile birlikte; ör. 'unavailable', 'no_emergency_contacts'). */
  errorCode: string | null;
  /** Bu gönderimde RTDB bağlantısı (null = bilinmiyor / gönderim yok). */
  online: boolean | null;
  /** 'online' dışındaysa arayüz SMS yedeğini (ya da nasıl açılacağını) gösterir. */
  offline: OfflineSosDecision;
  /** Son gönderim denemesinin konum / pil bilgisi (SMS gövdesi için). */
  lastAttempt: SosAttempt | null;
  /** Hazır SOS SMS gövdesi (core `sosSmsBody`). `safeReturnDest` verilmezse aktif Güvenli Dönüş hedefi kullanılır. */
  smsBody(opts?: { safeReturnDest?: string | null }): Promise<string>;
  /** SMS uygulamasını hazır dolu açar (SMS yedeği açık ve numara varsa). */
  sendSms(opts?: { safeReturnDest?: string | null }): Promise<SosSmsResult>;
  /** Şu anki çevrimdışı kararı (gönderim yokken de: ör. Güvenli Dönüş son uyarısı). */
  offlineDecisionNow(): OfflineSosDecision;
  /** Arka planda süren (çevrimdışı) SOS denemesini bırakır. */
  cancelPending(): void;
  /** Push'a dokununca / yeni aktif SOS gelince set edilir → tam ekran kart. */
  focusedSosId: string | null;
  focus(sosId: string | null): void;
  ack(sosId: string): Promise<void>;
  // --- ek (veri katmanı / arayüz için isteğe bağlı) ---
  /** Geri sayım başlarken çağrılabilir: yüksek doğruluklu ölçüm şimdiden başlar (gönderim beklemez). */
  prepare(): void;
  setContactsFromProfile(ids: UserId[]): void;
  applySent(list: readonly SosAlert[]): void;
  applyReceived(list: readonly SosAlert[]): void;
  /** Koordinatör: aktif SOS'un konumunu tazeler (en sık `updateMinIntervalMs`). */
  updateTick(): Promise<void>;
  /** Görünürlüğü biten uyarıları temizler. */
  tick(): void;
  reset(): void;
}

export interface SosStoreDeps {
  api: SosApi;
  now: () => EpochMs;
  myUid: () => UserId | null;
  /** Yüksek doğrulukta tek ölçüm (sunucu saatinde), zaman aşımında null. */
  getFix: (timeoutMs: number) => Promise<SosLocation | null>;
  /** Son bilinen konum (eski olabilir). */
  lastKnown: () => SosLocation | null;
  /** Ön plan konum izni yoksa ister; verildi mi. */
  ensurePermission: () => Promise<boolean>;
  device: () => Promise<DeviceStatus>;
  /** Okunabilir adres; bulunamazsa / zaman aşımında null. */
  address: (loc: SosLocation, timeoutMs: number) => Promise<string | null>;
  /** Acil kişilere canlı paylaşım (zaten yoksa). Hata yutulur. Konum izni olmadığı için atlananlar döner. */
  autoShare: (contacts: readonly UserId[]) => Promise<void | { needsGrant: readonly UserId[] }>;
  /** `sos_send` görünmezliği sunucuda kapattı: yerel niyet + profil hemen temizlenir. */
  onServerVisible: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** `unavailable` sonrası yeniden deneme aralıkları (aynı op_id). */
  retryDelaysMs: readonly number[];
  newOpId: () => string;
  // --- Faz 9 ---
  /** RTDB `.info/connected` (null = bilinmiyor). */
  isOnline: () => boolean | null;
  /** Bağlantıyı en çok `ms` bekler (null = bilinmiyor). */
  waitOnline: (ms: number) => Promise<boolean | null>;
  smsSettings: () => Pick<SmsFallbackSettings, 'enabled' | 'numbers'>;
  smsAvailable: () => boolean | null;
  lastFix: () => Promise<PersistedLastFix | null>;
  senderName: () => string;
  /** Aktif Güvenli Dönüş hedefinin adı (yoksa null). */
  safeReturnDest: () => string | null;
  composeSms: (numbers: readonly string[], body: string) => Promise<SmsComposeResult>;
  /** Hızlı yeniden denemeler bitince arka planda (bağlantı gelince) bu kadar süre daha denenir. */
  offlineRetryWindowMs: number;
}

/** Bu kadar taze ve doğru son konum varsa yeni ölçüm beklenmez (acil anda hız). [Varsayım] */
const QUICK_FIX_MAX_AGE_MS = 15_000;
const QUICK_FIX_MAX_ACCURACY_M = 35;
/** Hazırlanan (geri sayımda başlatılan) ölçüm bu kadar süre geçerli. */
const PREPARED_TTL_MS = 30_000;
/** Callable yanıtıyla gelen SOS, dinleyici yetişene kadar tutulur. */
const OUTGOING_HOLD_MS = 2 * 60_000;
const RETRY_DELAYS_MS = [3_000, 3_000, 3_000, 3_000, 3_000] as const;
/** Faz 9: gönderim başında RTDB bağlantısı bu kadar beklenir (PHASE9 §4.4). */
export const SOS_CONNECT_WAIT_MS = 3_000;
/** [Varsayım] Çevrimdışı SOS arka planda en çok bu kadar süre (bağlantı gelince) yeniden denenir. */
export const OFFLINE_RETRY_WINDOW_MS = 15 * 60_000;
/** Arka plan denemeleri arasında bağlantı en çok bu kadar beklenir. */
const OFFLINE_WAIT_STEP_MS = 30_000;
/** Arka plan denemesi sayısı üst sınırı (sonsuz döngüye karşı). */
const OFFLINE_MAX_ATTEMPTS = 60;

const NO_LOCATION_MESSAGE = 'Konumun alınamadı. Konum iznini ve GPS’i kontrol et.';

/** expo-location örneği → SOS konumu (sunucu saati). */
export function toSosLocation(raw: Pick<RawLocationSample, 'latitude' | 'longitude' | 'accuracy' | 'timestamp'>, offsetMs: number): SosLocation {
  const acc = typeof raw.accuracy === 'number' && Number.isFinite(raw.accuracy) && raw.accuracy >= 0 ? raw.accuracy : 100; // [Varsayım]
  return {
    lat: raw.latitude,
    lng: raw.longitude,
    accuracy: Math.min(10_000, Math.round(acc * 10) / 10),
    timestamp: Math.round(raw.timestamp + offsetMs),
  };
}

const defaultGetFix = async (timeoutMs: number): Promise<SosLocation | null> => {
  const raw = locationEngine.getPreciseSample ? await locationEngine.getPreciseSample(timeoutMs) : await locationEngine.getCurrentSample();
  return raw ? toSosLocation(raw, getServerOffsetMs()) : null;
};

const defaultLastKnown = (): SosLocation | null => {
  const p = locationStore.getState().myPosition;
  return p ? toSosLocation({ latitude: p.lat, longitude: p.lng, accuracy: p.accuracy, timestamp: p.timestamp }, getServerOffsetMs()) : null;
};

const defaultEnsurePermission = async (): Promise<boolean> => {
  const perms = permissionsStore.getState();
  if (perms.foreground === 'granted') return true;
  try {
    return await perms.requestForeground();
  } catch {
    return false;
  }
};

const defaultAddress = async (loc: SosLocation, timeoutMs: number): Promise<string | null> => {
  const pos = { lat: loc.lat, lng: loc.lng };
  const cached = geocodeRepo.peek(pos);
  if (cached !== undefined) return cached;
  const lookup = geocodeRepo
    .lookup({ subjectKey: 'sos:self', position: pos, visible: true })
    .then((r) => r.label)
    .catch(() => null);
  return Promise.race([lookup, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
};

/** [Varsayım] SOS ile birlikte acil kişilere, zaten paylaşım yoksa, 1 saatlik canlı paylaşım başlatılır. */
const defaultAutoShare = async (contacts: readonly UserId[]): Promise<{ needsGrant: readonly UserId[] }> => {
  const st = sharingStore.getState();
  const live = new Set(selectPublishTargets(st.state).map((t) => t.receiver_id));
  const missing = contacts.filter((c) => !live.has(c));
  if (missing.length === 0) return { needsGrant: [] };
  const r = await st.startShare(missing, { kind: 'preset', preset: 'h1' }).catch(() => null);
  return { needsGrant: r?.needsGrantReceiverIds ?? [] };
};

const safeIsOnline = (): boolean | null => {
  try {
    return isConnected();
  } catch {
    return null;
  }
};
const safeWaitOnline = async (ms: number): Promise<boolean | null> => {
  try {
    return await waitForConnection(ms);
  } catch {
    return null;
  }
};

/** Döngüsel içe aktarmayı önlemek için geç yüklenir (safeReturnStore → sosStore). */
const defaultSafeReturnDest = (): string | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('./safeReturnStore') as typeof import('./safeReturnStore');
    return m.selectSafeReturnDestName(m.safeReturnStore.getState());
  } catch {
    return null;
  }
};

const noContacts = () => ({ code: 'no_emergency_contacts' as const, message: ERROR_CODES.no_emergency_contacts.message });

export function createSosStore(overrides: Partial<SosStoreDeps> = {}): StoreApi<SosState> {
  const deps: SosStoreDeps = {
    api: sosApi,
    now: serverClockNow,
    myUid: () => authStore.getState().uid,
    getFix: defaultGetFix,
    lastKnown: defaultLastKnown,
    ensurePermission: defaultEnsurePermission,
    device: readDeviceStatus,
    address: defaultAddress,
    autoShare: defaultAutoShare,
    onServerVisible: () => invisibleStore.getState().clearAfterServerVisible(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    retryDelaysMs: RETRY_DELAYS_MS,
    newOpId: uuidV4,
    isOnline: safeIsOnline,
    waitOnline: safeWaitOnline,
    smsSettings: () => smsFallbackStore.getState().settings,
    smsAvailable: () => smsFallbackStore.getState().available,
    lastFix: () => getLastFix(authStore.getState().uid),
    senderName: () => authStore.getState().profile?.display_name ?? '',
    safeReturnDest: defaultSafeReturnDest,
    composeSms,
    offlineRetryWindowMs: OFFLINE_RETRY_WINDOW_MS,
    ...overrides,
  };

  let sending: Promise<Result<{ sos_id: string }>> | null = null;
  /** Faz 9: süren gönderimin çevrimdışı durumu. */
  let attempt: {
    startedAt: number;
    outcome: SosSendOutcome;
    /** Çevrimdışı kararıyla erken dönüş (bir kez çözülür). */
    early: Promise<Result<{ sos_id: string }>>;
    resolveEarly: (r: Result<{ sos_id: string }>) => void;
    wake: (() => void) | null;
    aborted: boolean;
  } | null = null;
  let prepared: { at: EpochMs; fix: Promise<SosLocation | null> } | null = null;
  /** Callable yanıtıyla gelen giden SOS'un anı (dinleyici gecikmesine karşı tutma). */
  let outgoingConfirmedAt = 0;
  let lastUpdateAt = 0;
  let updating = false;
  /** Bu çalıştırmada görülen gelen SOS kimlikleri (yalnızca YENİ olanlar odaklanır). */
  const seenIncoming = new Set<string>();

  const takePrepared = (): Promise<SosLocation | null> | null => {
    const p = prepared;
    prepared = null;
    return p && Date.now() - p.at <= PREPARED_TTL_MS ? p.fix : null;
  };

  async function acquireLocation(): Promise<SosLocation | null> {
    const t = deps.now();
    const quick = deps.lastKnown();
    if (quick && t - quick.timestamp <= QUICK_FIX_MAX_AGE_MS && quick.accuracy <= QUICK_FIX_MAX_ACCURACY_M) {
      prepared = null;
      return quick;
    }
    const fix = (await (takePrepared() ?? deps.getFix(SOS_LIMITS.freshFixTimeoutMs)).catch(() => null)) ?? deps.lastKnown();
    if (fix) return fix;
    // Hiç konum yok: izin yoksa iste ve bir kez daha dene.
    if (!(await deps.ensurePermission())) return null;
    return (await deps.getFix(SOS_LIMITS.freshFixTimeoutMs).catch(() => null)) ?? deps.lastKnown();
  }

  async function batteryInfo(): Promise<{ battery_pct: number | null; is_charging: boolean | null }> {
    try {
      const d = await deps.device();
      return { battery_pct: batteryPct(d.batteryLevel), is_charging: d.isCharging };
    } catch {
      return { battery_pct: null, is_charging: null };
    }
  }

  return createStore<SosState>()((set, get) => ({
    emergencyContacts: [],
    contactsLoaded: false,
    contactsSaving: false,
    outgoing: null,
    phase: 'idle',
    liveShareSkipped: [],
    error: null,
    errorCode: null,
    online: null,
    offline: 'online',
    lastAttempt: null,
    incoming: {},
    focusedSosId: null,

    setEmergencyContacts: async (ids) => {
      const me = deps.myUid();
      const contact_ids = [...new Set(ids)].filter((u) => u !== me).slice(0, SOS_LIMITS.maxContacts);
      set({ contactsSaving: true });
      try {
        const res = await deps.api.emergencyContactsSet({ op_id: deps.newOpId(), contact_ids });
        set({ emergencyContacts: res.contact_ids, contactsLoaded: true, contactsSaving: false });
        return { ok: true };
      } catch (e) {
        set({ contactsSaving: false });
        return { ok: false, error: toKonumError(e).toSharingError() };
      }
    },

    prepare: () => {
      if (prepared && Date.now() - prepared.at <= PREPARED_TTL_MS) return;
      const fix = deps.getFix(SOS_LIMITS.freshFixTimeoutMs).catch(() => null);
      prepared = { at: Date.now(), fix };
    },

    send: (opts) => {
      if (sending && attempt) {
        // Çevrimdışı arka plan denemesi sürüyor: hemen uyandır, kararı döndür.
        attempt.wake?.();
        return Promise.race([sending, attempt.early]);
      }
      if (sending) return sending;
      const contacts = get().emergencyContacts;
      // Liste yüklendiyse ve boşsa ağa çıkmadan; yüklenmediyse sunucu doğrular (yoksa no_emergency_contacts döner).
      if (contacts.length === 0 && get().contactsLoaded) return Promise.resolve({ ok: false, error: noContacts() });
      set({ phase: 'sending', error: null, errorCode: null, online: null, offline: 'online', lastAttempt: null });
      let resolveEarly: (r: Result<{ sos_id: string }>) => void = () => undefined;
      const early = new Promise<Result<{ sos_id: string }>>((r) => {
        resolveEarly = r;
      });
      const at = { startedAt: Date.now(), outcome: 'pending' as SosSendOutcome, early, resolveEarly, wake: null as (() => void) | null, aborted: false };
      attempt = at;
      const offlineError = { code: 'unavailable' as const, message: SMS_FALLBACK_TEXT.offlineBody };
      /** Çevrimdışı kararını yeniden hesaplar; `final` ve 'online' dışındaysa send() erken döner. */
      const decide = (final: boolean) => {
        if (attempt !== at) return;
        const decision = offlineSosDecision({
          online: get().online,
          outcome: at.outcome,
          waitedMs: Date.now() - at.startedAt,
          settings: deps.smsSettings(),
          smsAvailable: deps.smsAvailable(),
        });
        if (decision !== get().offline) set({ offline: decision });
        if (decision !== 'online' && final) {
          if (get().phase === 'sending') set({ error: offlineError.message, errorCode: offlineError.code });
          at.resolveEarly({ ok: false, error: offlineError });
        }
      };
      void deps
        .waitOnline(SOS_CONNECT_WAIT_MS)
        .then((ok) => {
          if (attempt !== at || ok === null) return;
          set({ online: ok });
          decide(true);
        })
        .catch(() => undefined);
      /** "10 sn'de yanıt gelmezse": ilk istek çıkınca kurulur. */
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        if (attempt === at) attempt = null;
      };
      const run = (async (): Promise<Result<{ sos_id: string }>> => {
        const fail = (error: { code?: string; message: string }) => {
          if (at.aborted && attempt !== at) return; // reset() sonrası: yeni duruma yazma
          const cur = get().outgoing;
          set({ phase: cur && isSosActive(cur) ? 'active' : 'idle', error: error.message, errorCode: error.code ?? null });
        };
        const location = await acquireLocation();
        const [battery, address] = await Promise.all([
          batteryInfo(),
          location ? deps.address(location, SOS_LIMITS.addressTimeoutMs).catch(() => null) : Promise.resolve(null),
        ]);
        if (attempt === at) set({ lastAttempt: { location, ...battery, route: opts?.route ?? null, at: deps.now() } });
        if (!location) {
          const error = { code: 'invalid_argument' as const, message: NO_LOCATION_MESSAGE };
          fail(error);
          return { ok: false, error };
        }
        const opId = deps.newOpId();
        const req = { op_id: opId, location, ...battery, route: opts?.route ?? null, address: address ? address.slice(0, 200) : null };
        let background = 0;
        timer = setTimeout(() => decide(true), SMS_FALLBACK_LIMITS.onlineTimeoutMs);
        for (let attemptNo = 0; ; attemptNo++) {
          try {
            const res = await deps.api.sosSend(req);
            outgoingConfirmedAt = Date.now();
            lastUpdateAt = Date.now();
            at.outcome = 'sent';
            set({ outgoing: res.sos, phase: 'active', error: null, errorCode: null, liveShareSkipped: [], online: true, offline: 'online' });
            const recipients = res.sos.recipient_ids.length ? res.sos.recipient_ids : contacts;
            // Sunucu görünmezliği kapattı: yerel niyet önce silinir (yoksa paylaşım yerelde invisible_mode ile düşer).
            void deps
              .onServerVisible()
              .catch(() => undefined)
              .then(() => deps.autoShare(recipients))
              .then((r) => {
                if (r && r.needsGrant.length) set({ liveShareSkipped: [...r.needsGrant] });
              })
              .catch(() => undefined);
            return { ok: true, sos_id: res.sos.sos_id };
          } catch (e) {
            const err = toKonumError(e);
            if (err.code === 'unavailable') {
              at.outcome = 'failed_network';
              const delay = deps.retryDelaysMs[attemptNo];
              decide(delay === undefined);
              if (delay !== undefined) {
                await deps.sleep(delay);
                continue;
              }
              // Hızlı denemeler bitti: bağlantı gelince (ya da yeniden send() ile) arka planda denemeye devam.
              if (!at.aborted && background < OFFLINE_MAX_ATTEMPTS && Date.now() - at.startedAt < deps.offlineRetryWindowMs) {
                background++;
                const woke = new Promise<void>((r) => {
                  at.wake = r;
                });
                const r = await Promise.race([deps.waitOnline(OFFLINE_WAIT_STEP_MS).then(() => 'waited' as const), woke.then(() => 'woke' as const)]);
                // Bağlantı var ama callable yine düşüyorsa sıkı döngü olmasın (yeniden send() hemen dener).
                if (r === 'waited' && !at.aborted) await Promise.race([deps.sleep(RETRY_DELAYS_MS[0]), woke]);
                at.wake = null;
                if (at.aborted) {
                  fail(offlineError);
                  return { ok: false, error: offlineError };
                }
                continue;
              }
            }
            // Sunucu kişileri doğruladı ve hiçbiri geçerli değil: yerel listeyi de boşalt (seçim ekranı açılsın).
            if (err.code === 'no_emergency_contacts') set({ emergencyContacts: [], contactsLoaded: true });
            at.outcome = err.code === 'unavailable' ? 'failed_network' : 'failed_other';
            const error = err.code === 'unavailable' && get().offline !== 'online' ? offlineError : err.toSharingError();
            fail(error);
            return { ok: false, error };
          }
        }
      })().finally(() => {
        finish();
        sending = null;
      });
      sending = run;
      return Promise.race([run, early]);
    },

    smsBody: async (opts) => {
      const t = deps.now();
      const a = get().lastAttempt;
      const own = a?.location && a.location.accuracy <= VERIFIED_ACCURACY_M ? a.location : null;
      const cached = own ? null : await deps.lastFix().catch(() => null);
      const fix = own ?? (cached ? { lat: cached.lat, lng: cached.lng, accuracy: cached.accuracy, timestamp: cached.timestamp } : a?.location ?? null);
      let battery = a?.battery_pct ?? cached?.battery_pct ?? null;
      if (battery === null) battery = (await batteryInfo()).battery_pct;
      const dest = opts && 'safeReturnDest' in opts ? (opts.safeReturnDest ?? null) : deps.safeReturnDest();
      return sosSmsBody({ senderName: deps.senderName(), fix, battery_pct: battery, now: t, safeReturnDest: dest });
    },

    sendSms: async (opts) => {
      const settings = deps.smsSettings();
      if (!settings.enabled || settings.numbers.length === 0) return 'not_configured';
      if (deps.smsAvailable() === false) return 'unavailable';
      const body = await get().smsBody(opts);
      try {
        return await deps.composeSms(
          settings.numbers.map((n) => n.e164),
          body,
        );
      } catch {
        // SmsUnavailableError ya da yerel modül hatası: mesaj uygulaması açılamadı.
        return 'unavailable';
      }
    },

    offlineDecisionNow: () => {
      const s = get();
      if (attempt && s.phase === 'sending') return s.offline;
      return offlineSosDecision({
        online: deps.isOnline(),
        outcome: 'pending',
        waitedMs: 0,
        settings: deps.smsSettings(),
        smsAvailable: deps.smsAvailable(),
      });
    },

    cancelPending: () => {
      if (!attempt) return;
      attempt.aborted = true;
      attempt.wake?.();
    },

    resolve: async (sosId) => {
      const cur = get().outgoing;
      // Yerelde bilinmeyen (ya da başka) SOS kimliği verildi: sunucuda o kapatılır, "başarılı" ancak yanıtla.
      const known = cur && (!sosId || cur.sos_id === sosId) ? cur : null;
      if (!sosId && (!known || !isSosActive(known))) {
        set({ phase: 'idle' });
        return true;
      }
      if (known && !isSosActive(known)) return true;
      if (get().phase === 'resolving') return false;
      const prevPhase = get().phase;
      const target = known?.sos_id ?? (sosId as string);
      set({ phase: 'resolving', error: null });
      try {
        const res = await deps.api.sosResolve({ op_id: deps.newOpId(), sos_id: target });
        outgoingConfirmedAt = Date.now();
        set({ outgoing: res.sos, phase: isSosActive(res.sos) ? 'active' : 'idle' });
        return true;
      } catch (e) {
        const err = toKonumError(e);
        if (err.code === 'sos_not_active') {
          if (known) set({ outgoing: { ...known, status: 'resolved', resolve_reason: known.resolve_reason ?? 'safe', resolved_at: known.resolved_at ?? deps.now() }, phase: 'idle' });
          else set({ phase: prevPhase === 'resolving' ? 'idle' : prevPhase });
          return true;
        }
        set({ phase: known || (cur && isSosActive(cur)) ? 'active' : prevPhase === 'resolving' ? 'idle' : prevPhase, error: err.message, errorCode: err.code });
        return false;
      }
    },

    focus: (sosId) => set({ focusedSosId: sosId }),

    ack: async (sosId) => {
      const me = deps.myUid();
      const cur = get().incoming[sosId];
      if (!cur || !me) return;
      if (cur.acks[me] === undefined) set((s) => ({ incoming: { ...s.incoming, [sosId]: { ...cur, acks: { ...cur.acks, [me]: deps.now() } } } }));
      try {
        const res = await deps.api.sosAck({ op_id: deps.newOpId(), sos_id: sosId });
        set((s) => (s.incoming[sosId] ? { incoming: { ...s.incoming, [sosId]: res.sos } } : s));
      } catch {
        // Gönderilemedi: "Gördüm" yeniden basılabilsin.
        set((s) => {
          const a = s.incoming[sosId];
          if (!a || a.acks[me] === undefined || cur.acks[me] !== undefined) return s;
          const { [me]: _gone, ...acks } = a.acks;
          return { incoming: { ...s.incoming, [sosId]: { ...a, acks } } };
        });
      }
    },

    setContactsFromProfile: (ids) => {
      const prev = get().emergencyContacts;
      if (get().contactsLoaded && prev.length === ids.length && prev.every((v, i) => v === ids[i])) return;
      set({ emergencyContacts: [...ids], contactsLoaded: true });
    },

    applySent: (list) => {
      const t = deps.now();
      const sorted = [...list].sort((a, b) => b.created_at - a.created_at);
      const active = sorted.find(isSosActive) ?? null;
      const recent = active ?? sorted.find((a) => isSosVisible(a, t)) ?? null;
      const cur = get().outgoing;
      let next = recent;
      if (cur && (!next || next.sos_id !== cur.sos_id)) {
        // Callable yanıtı dinleyiciden önce geldi: eski anlık görüntü yeni SOS'u silmesin.
        const inList = list.some((a) => a.sos_id === cur.sos_id);
        if (!inList && Date.now() - outgoingConfirmedAt < OUTGOING_HOLD_MS && isSosActive(cur)) next = cur;
      }
      if (next && cur && next.sos_id === cur.sos_id && next.updated_at < cur.updated_at) next = cur;
      const phase = get().phase;
      const nextPhase =
        phase === 'sending' || phase === 'resolving' ? phase : next && isSosActive(next) ? 'active' : 'idle';
      set({ outgoing: next, phase: nextPhase });
    },

    applyReceived: (list) => {
      const t = deps.now();
      const me = deps.myUid();
      const incoming: Record<string, SosAlert> = {};
      let newest: SosAlert | null = null;
      for (const a of list) {
        if (!isSosVisible(a, t)) continue;
        incoming[a.sos_id] = a;
        const fresh = !seenIncoming.has(a.sos_id);
        seenIncoming.add(a.sos_id);
        if (fresh && isSosActive(a) && !(me && a.acks[me] !== undefined) && (!newest || a.created_at > newest.created_at)) newest = a;
      }
      const focused = get().focusedSosId;
      const focusedSosId = newest ? newest.sos_id : focused && incoming[focused] ? focused : focused && get().outgoing?.sos_id === focused ? focused : null;
      set({ incoming, focusedSosId });
    },

    updateTick: async () => {
      const cur = get().outgoing;
      if (!cur || !isSosActive(cur) || get().phase !== 'active' || updating) return;
      if (Date.now() - lastUpdateAt < SOS_LIMITS.updateMinIntervalMs) return;
      updating = true;
      lastUpdateAt = Date.now();
      try {
        const fix = (await deps.getFix(5_000).catch(() => null)) ?? deps.lastKnown();
        if (!fix || fix.timestamp <= cur.location.timestamp) return;
        const battery = await batteryInfo();
        const res = await deps.api.sosUpdate({ op_id: deps.newOpId(), sos_id: cur.sos_id, location: fix, ...battery, route: cur.route });
        const now = get().outgoing;
        if (now && now.sos_id === res.sos.sos_id && res.sos.updated_at >= now.updated_at) set({ outgoing: res.sos });
      } catch (e) {
        if (toKonumError(e).code === 'sos_not_active') {
          const c = get().outgoing;
          if (c && c.sos_id === cur.sos_id) set({ outgoing: { ...c, status: 'resolved', resolved_at: c.resolved_at ?? deps.now() }, phase: 'idle' });
        }
      } finally {
        updating = false;
      }
    },

    tick: () => {
      const t = deps.now();
      const s = get();
      const gone = Object.values(s.incoming).filter((a) => !isSosVisible(a, t));
      const outgoingGone = s.outgoing !== null && !isSosVisible(s.outgoing, t);
      if (gone.length === 0 && !outgoingGone) return;
      const incoming = { ...s.incoming };
      for (const a of gone) delete incoming[a.sos_id];
      const focusedSosId = s.focusedSosId && (incoming[s.focusedSosId] || (!outgoingGone && s.outgoing?.sos_id === s.focusedSosId)) ? s.focusedSosId : null;
      set({ incoming, focusedSosId, ...(outgoingGone ? { outgoing: null } : {}) });
    },

    reset: () => {
      if (attempt) {
        attempt.aborted = true;
        attempt.wake?.();
      }
      attempt = null;
      sending = null;
      prepared = null;
      outgoingConfirmedAt = 0;
      lastUpdateAt = 0;
      seenIncoming.clear();
      set({ emergencyContacts: [], contactsLoaded: false, contactsSaving: false, outgoing: null, phase: 'idle', error: null, errorCode: null, online: null, offline: 'online', lastAttempt: null, liveShareSkipped: [], incoming: {}, focusedSosId: null });
    },
  }));
}

export const sosStore = createSosStore();

/** Benim süren (aktif) SOS'um var mı? (Görünmez mod metinleri: SOS görünmezlikten etkilenmez.) */
export function selectOutgoingSosActive(s: Pick<SosState, 'outgoing'>): boolean {
  return s.outgoing !== null && isSosActive(s.outgoing);
}

export function useOutgoingSosActive(): boolean {
  return useStore(sosStore, selectOutgoingSosActive);
}

export function useSosStore<T>(selector: (s: SosState) => T): T {
  return useStore(sosStore, selector);
}

/** Alıcı ekranı: görünür gelen SOS'lar, en yeni önce (aktifler önce). */
export function selectIncomingSos(s: Pick<SosState, 'incoming'>): SosAlert[] {
  return Object.values(s.incoming).sort((a, b) => Number(isSosActive(b)) - Number(isSosActive(a)) || b.created_at - a.created_at);
}
