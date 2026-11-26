/**
 * Faz 9: Güvenli Dönüş (gece takip modu) — core `safeReturn.ts`, docs/PHASE9.md §3.
 *
 *  - Zamanlayıcının asıl sahibi SUNUCUDUR (Cloud Tasks + süpürücü): uygulama öldürülse / telefon kapansa da süre
 *    dolup yanıt yoksa acil kişilere son bildirilen konumla otomatik alarm (SOS `origin: 'safe_return'`) gider.
 *  - `start`: süre (15/30/45/60) + hedef (kayıtlı bölge ya da nokta; KOORDİNAT cihazda kalır, sunucuya yalnızca ad /
 *    tür / bölge kimliği) + acil kişi(ler) + ZORUNLU başlangıç konumu. "Yolculuk boyunca canlı konumumu da paylaş"
 *    (varsayılan açık) seçilen kişilerle canlı paylaşım başlatır (arka plan hattı da canlı kalır).
 *  - Sürerken konum tazeleme (en sık 60 sn) ve hedefe varışta otomatik "Vardım" konum hattındadır (`f9Hooks`).
 *  - Ekran hâli core `safeReturnPhase`: running → ending_soon (son 5 dk) → final_warning ("Güvende misin?", 2 dk geri
 *    sayım) → alarm; `tick()` (f9Services saniyede bir, öndeyken) günceller. Yerel bildirimler
 *    (`safeReturnLocalSchedule`) uygulama kapalıyken de çalar; eylemler "Güvendeyim" / "+15 dk".
 *  - Alarmdan sonra "Güvendeyim" SOS'u kapatır (`sosStore.resolve(sos_id)`). Dinleyici alarmı henüz getirmediyse
 *    check-in `safe_return_not_active` döner: güncel kayıt okunur, alarmdaysa aynı dokunuşla SOS kapatılır.
 *  - Otomatik canlı paylaşım `grace_until + ALARM_SHARE_MS`'e kadar sürer (alarm anında kesilmez; "+15 dk"
 *    sonrası uzatılır). Güvenli Dönüş'ün açtığı oturum kaydedilir; varış / check-in / iptal / SOS kapanınca durdurulur.
 *  - Kayıt `konum.bg.safeReturn.v1` (başsız hat okur); sunucu belgesi `safe_returns` dinleyicisiyle (`applyDocs`).
 */
import {
  batteryPct,
  ERROR_CODES,
  SAFE_RETURN_LIMITS,
  SAFE_RETURN_TEXT,
  safeReturnLeftMs,
  safeReturnPhase,
  sanitizeSafeReturnName,
  selectPublishTargets,
  uuidV4,
  type EpochMs,
  type LatLng,
  type SafeReturnDestKind,
  type SafeReturnDoc,
  type SafeReturnDurationMin,
  type SafeReturnFix,
  type SafeReturnPhase,
  type SafeReturnStatus,
  type SharingError,
  type UserId,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { getServerOffsetMs, now as serverClockNow } from '../lib/clock';
import { KonumError, toKonumError } from '../lib/errors';
import { deviceTimeZone } from '../lib/timeZone';
import { safeReturnApi, type SafeReturnApi } from '../services/firebase/callables';
import { locationEngine } from '../services/location/ExpoLocationEngine';
import { readDeviceStatus } from '../services/location/deviceStatus';
import { onF9HookChange } from '../services/location/f9Hooks';
import { getLastFix } from '../services/location/lastFix';
import { cancelSafeReturnLocal, formatContactNames, scheduleSafeReturnLocal } from '../services/notifications/safeReturnNotifications';
import { authStore } from './authStore';
import { friendsStore, selectFriends } from './friendsStore';
import { locationStore } from './locationStore';
import { fetchSafeReturn } from '../services/firebase/safeReturnRepo';
import { loadSafeReturn, loadSafeReturnShare, saveSafeReturn, saveSafeReturnShare, type PersistedSafeReturn, type PersistedSafeReturnShare } from './persist';
import type { Result } from './pingStore';
import { sharingStore } from './sharingStore';
import { sosStore } from './sosStore';
import { zonesStore } from './zonesStore';

/** Arayüzün ihtiyaç duyduğu özet (sunucu belgesinden ya da açılışta kalıcı kayıttan). */
export interface SafeReturnView {
  safe_return_id: string;
  status: SafeReturnStatus;
  destination: { kind: SafeReturnDestKind; name: string; zone_id: string | null };
  duration_min: number;
  started_at: EpochMs;
  due_at: EpochMs;
  grace_until: EpochMs;
  extend_count: number;
  contact_ids: UserId[];
  /** Alarmda açılan SOS. */
  sos_id: string | null;
  /** Sunucunun bildiği son konumun anı (yoksa null). */
  last_fix_at: EpochMs | null;
  /** Belge sürümü (kalıcı kayıttan gelirse 0). */
  version: number;
}

export type SafeReturnDestinationInput =
  | { kind: 'zone'; zone_id: string; name: string; center: LatLng; radius_m: number }
  | { kind: 'point'; name: string; center: LatLng; radius_m?: number | null };

export interface SafeReturnStartInput {
  duration_min: SafeReturnDurationMin;
  destination: SafeReturnDestinationInput;
  contact_ids: readonly UserId[];
  /** "Yolculuk boyunca canlı konumumu da paylaş" (varsayılan açık). */
  shareLive?: boolean;
}

export type SafeReturnBusy = 'start' | 'check_in' | 'extend' | 'cancel' | null;
export type SafeReturnEndReason = 'arrived' | 'checked_in' | 'cancelled' | 'alarm';

export interface SafeReturnState {
  hydrated: boolean;
  current: SafeReturnView | null;
  /** `idle` = kayıt yok. */
  phase: SafeReturnPhase | 'idle';
  /** running / ending_soon: `due_at`'e; final_warning: `grace_until`'e kalan ms. */
  leftMs: number;
  busy: SafeReturnBusy;
  error: SharingError | null;
  /** Son biten Güvenli Dönüş (toast / kart; `SAFE_RETURN_TEXT.ended[reason]`, alarmda `alarmSent`). */
  ended: { safe_return_id: string; reason: SafeReturnEndReason; at: EpochMs; destination_name: string } | null;
  /** Canlı paylaşım konum izni olmadığı için başlamayan kişiler. */
  liveShareSkipped: UserId[];
  hydrate(): Promise<void>;
  start(input: SafeReturnStartInput): Promise<Result<{ safe_return_id: string }>>;
  /** "Güvendeyim" (varsayılan) / "Vardım". Alarmdan sonra SOS'u kapatır. */
  checkIn(reason?: 'safe' | 'arrived'): Promise<Result>;
  extend(): Promise<Result>;
  cancel(): Promise<Result>;
  /** Firestore dinleyicisi. */
  applyDocs(docs: readonly SafeReturnDoc[]): void;
  /** Callable yanıtı / push / kanca. */
  applyDoc(doc: SafeReturnDoc): void;
  tick(): void;
  dismissEnded(): void;
  clearError(): void;
  reset(): Promise<void>;
}

export interface SafeReturnStoreDeps {
  api: SafeReturnApi;
  now: () => EpochMs;
  offsetMs: () => number;
  myUid: () => UserId | null;
  /** Başlangıç konumu (zorunlu): taze son doğrulanmış konum ya da yüksek doğrulukta tek ölçüm; yoksa null. */
  getFix: () => Promise<SafeReturnFix | null>;
  /** Check-in için beklemesiz konum (taze son konum); yoksa null. */
  quickFix: () => Promise<SafeReturnFix | null>;
  timeZone: () => string;
  newOpId: () => string;
  load: () => Promise<PersistedSafeReturn | null>;
  save: (v: PersistedSafeReturn | null) => Promise<void>;
  schedule: (doc: Pick<SafeReturnDoc, 'safe_return_id' | 'status' | 'due_at' | 'grace_until' | 'destination'>, names: string) => Promise<void>;
  cancelLocal: (safeReturnId: string | null) => Promise<void>;
  contactNames: (ids: readonly UserId[]) => string;
  /** Kayıtlı bölgenin geometrisi (başka cihazda başlatılan bölge hedefi için). */
  zoneGeometry: (zoneId: string) => { center: LatLng; radius_m: number } | null;
  /** Kişilere `until`'e (sunucu saati) kadar canlı paylaşım (zaten yoksa). İzni olmayanlar ve açılan YENİ oturum döner. */
  autoShare: (contacts: readonly UserId[], until: EpochMs) => Promise<{ needsGrant: readonly UserId[]; sessionId?: string | null }>;
  /** Güvenli Dönüş'ün açtığı oturum `until`'den önce bitecekse uzatır. */
  extendShare: (sessionId: string, until: EpochMs) => Promise<void>;
  /** Güvenli Dönüş'ün açtığı oturumu durdurur. */
  stopShare: (sessionId: string) => Promise<void>;
  loadShare: () => Promise<PersistedSafeReturnShare | null>;
  saveShare: (v: PersistedSafeReturnShare | null) => Promise<void>;
  /** Sunucudaki güncel kayıt (dinleyiciyi beklemeden); okunamazsa null. */
  fetchDoc: (safeReturnId: string) => Promise<SafeReturnDoc | null>;
  /** Alarm (SOS) sonrası "Güvendeyim": verilen SOS'u (yoksa kendi etkin SOS'unu) kapatır. */
  resolveSos: (sosId: string | null) => Promise<boolean>;
}

/** Callable yanıtıyla gelen kayıt, dinleyici yetişene kadar tutulur. */
const HOLD_MS = 2 * 60_000;
/** Başlangıç için taze sayılan son konum. [Varsayım] */
const START_FIX_MAX_AGE_MS = 2 * 60_000;
const PRECISE_TIMEOUT_MS = 8_000;
/** Alarm penceresi: otomatik paylaşım `grace_until`'den sonra da bu kadar sürer (Faz 4 SOS paylaşımı gibi 1 sa). */
export const SAFE_RETURN_ALARM_SHARE_MS = 60 * 60_000;
/** Güvenli Dönüş'ün otomatik canlı paylaşımının bitişi (sunucu saati). */
export const safeReturnShareUntil = (d: Pick<SafeReturnDoc, 'grace_until'>): EpochMs => d.grace_until + SAFE_RETURN_ALARM_SHARE_MS;

export function toSafeReturnView(d: SafeReturnDoc): SafeReturnView {
  return {
    safe_return_id: d.safe_return_id,
    status: d.status,
    destination: { kind: d.destination.kind, name: d.destination.name, zone_id: d.destination.zone_id },
    duration_min: d.duration_min,
    started_at: d.started_at,
    due_at: d.due_at,
    grace_until: d.grace_until,
    extend_count: d.extend_count,
    contact_ids: [...d.contact_ids],
    sos_id: d.sos_id,
    last_fix_at: d.last_fix?.timestamp ?? null,
    version: d.version,
  };
}

const viewFromRecord = (r: PersistedSafeReturn): SafeReturnView => ({
  safe_return_id: r.safe_return_id,
  status: r.status,
  destination: { kind: r.destination.kind, name: r.destination.name, zone_id: r.destination.zone_id },
  duration_min: r.duration_min,
  started_at: r.started_at,
  due_at: r.due_at,
  grace_until: r.grace_until,
  extend_count: r.extend_count,
  contact_ids: [...r.contact_ids],
  sos_id: null,
  last_fix_at: null,
  version: 0,
});

/** "+15 dk" yapılabilir mi (3 saat sınırı, son uyarı penceresi dahil). Saf. */
export function canExtendSafeReturn(v: Pick<SafeReturnView, 'status' | 'started_at' | 'due_at' | 'grace_until'>, now: EpochMs): boolean {
  if (v.status !== 'active' || now >= v.grace_until) return false;
  const due = Math.max(v.due_at, now) + SAFE_RETURN_LIMITS.extendMs;
  return due - v.started_at <= SAFE_RETURN_LIMITS.maxTotalMs;
}

const fixOf = (f: { lat: number; lng: number; accuracy: number; timestamp: EpochMs; battery_pct: number | null; is_charging: boolean | null }): SafeReturnFix => ({
  lat: f.lat,
  lng: f.lng,
  accuracy: Math.min(10_000, Math.max(0, f.accuracy)),
  timestamp: Math.round(f.timestamp),
  battery_pct: f.battery_pct === null ? null : Math.round(f.battery_pct),
  is_charging: f.is_charging,
});

async function defaultQuickFix(): Promise<SafeReturnFix | null> {
  const last = await getLastFix(authStore.getState().uid).catch(() => null);
  return last && serverClockNow() - last.timestamp <= START_FIX_MAX_AGE_MS ? fixOf(last) : null;
}

async function defaultGetFix(): Promise<SafeReturnFix | null> {
  const quick = await defaultQuickFix();
  if (quick) return quick;
  const battery = await readDeviceStatus().catch(() => ({ batteryLevel: null, isCharging: null }));
  const raw0 = batteryPct(battery.batteryLevel);
  const pct = raw0 === null ? null : Math.round(raw0);
  const raw = await (locationEngine.getPreciseSample ? locationEngine.getPreciseSample(PRECISE_TIMEOUT_MS) : locationEngine.getCurrentSample()).catch(() => null);
  if (raw) return fixOf({ lat: raw.latitude, lng: raw.longitude, accuracy: raw.accuracy ?? 100, timestamp: raw.timestamp + getServerOffsetMs(), battery_pct: pct, is_charging: pct === null ? null : battery.isCharging });
  const last = await getLastFix(authStore.getState().uid).catch(() => null);
  if (last) return fixOf(last);
  const p = locationStore.getState().myPosition;
  return p ? fixOf({ lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? 100, timestamp: p.timestamp + getServerOffsetMs(), battery_pct: pct, is_charging: pct === null ? null : battery.isCharging }) : null;
}

const defaultContactNames = (ids: readonly UserId[]): string => {
  const byId = new Map(selectFriends(friendsStore.getState()).map((f) => [f.uid, f.displayName] as const));
  return formatContactNames(ids.map((id) => byId.get(id) ?? null));
};

/** Kişilere `until`'e kadar canlı paylaşım (zaten paylaşım alanlar atlanır). */
const defaultAutoShare = async (contacts: readonly UserId[], until: EpochMs): Promise<{ needsGrant: readonly UserId[]; sessionId: string | null }> => {
  const st = sharingStore.getState();
  const live = new Set(selectPublishTargets(st.state).map((t) => t.receiver_id));
  const missing = contacts.filter((c) => !live.has(c));
  if (missing.length === 0) return { needsGrant: [], sessionId: null };
  const r = await st.startShare(missing, { kind: 'custom_until', until }).catch(() => null);
  return { needsGrant: r?.needsGrantReceiverIds ?? [], sessionId: r?.ok ? r.sessionId : null };
};

/** Oturum `until`'den önce bitecekse +30 / +60 dk (uzatma adımları); bitmiş / onaysız oturuma dokunmaz. */
const defaultExtendShare = async (sessionId: string, until: EpochMs): Promise<void> => {
  const st = sharingStore.getState();
  const s = st.findSession(sessionId);
  if (!s || s.expires_at === null || s.expires_at >= until) return;
  await st.extend(sessionId, until - s.expires_at <= 30 * 60_000 ? 30 : 60);
};

export function createSafeReturnStore(overrides: Partial<SafeReturnStoreDeps> = {}): StoreApi<SafeReturnState> {
  const deps: SafeReturnStoreDeps = {
    api: safeReturnApi,
    now: serverClockNow,
    offsetMs: getServerOffsetMs,
    myUid: () => authStore.getState().uid,
    getFix: defaultGetFix,
    quickFix: defaultQuickFix,
    timeZone: deviceTimeZone,
    newOpId: uuidV4,
    load: loadSafeReturn,
    save: saveSafeReturn,
    schedule: (doc, names) => scheduleSafeReturnLocal(doc, serverClockNow(), getServerOffsetMs(), names),
    cancelLocal: (id) => cancelSafeReturnLocal(id),
    contactNames: defaultContactNames,
    zoneGeometry: (zoneId) => {
      const z = zonesStore.getState().zones[zoneId];
      return z ? { center: z.center, radius_m: z.radius_m } : null;
    },
    autoShare: defaultAutoShare,
    extendShare: defaultExtendShare,
    stopShare: async (id) => void (await sharingStore.getState().stop(id)),
    loadShare: loadSafeReturnShare,
    saveShare: saveSafeReturnShare,
    fetchDoc: fetchSafeReturn,
    resolveSos: (sosId) => sosStore.getState().resolve(sosId),
    ...overrides,
  };

  /** Başlatılırken bilinen hedef geometrisi (yanıt gelince kalıcı kayda yazılır). */
  let startGeometry: { center: LatLng; radius_m: number } | null = null;
  let confirmedAt = 0;

  return createStore<SafeReturnState>()((set, get) => {
    const computed = (v: SafeReturnView | null) => {
      if (!v) return { phase: 'idle' as const, leftMs: 0 };
      const t = deps.now();
      return { phase: safeReturnPhase(v, t), leftMs: safeReturnLeftMs(v, t) };
    };
    const fail = (e: unknown, busy: SafeReturnBusy = null): { ok: false; error: SharingError } => {
      const error = e instanceof KonumError || typeof e !== 'object' || e === null || !('code' in e && 'message' in e) ? toKonumError(e).toSharingError() : (e as SharingError);
      set({ busy, error });
      return { ok: false, error };
    };

    const persistActive = async (doc: SafeReturnDoc) => {
      const me = deps.myUid();
      if (!me) return;
      const rec = await deps.load().catch(() => null);
      const same = rec && rec.safe_return_id === doc.safe_return_id ? rec : null;
      const geometry =
        same?.destination.center && same.destination.radius_m
          ? { center: same.destination.center, radius_m: same.destination.radius_m }
          : (startGeometry ?? (doc.destination.zone_id ? deps.zoneGeometry(doc.destination.zone_id) : null));
      const label = deps.contactNames(doc.contact_ids);
      await deps.save({
        uid: me,
        safe_return_id: doc.safe_return_id,
        status: doc.status,
        destination: { kind: doc.destination.kind, name: doc.destination.name, zone_id: doc.destination.zone_id, center: geometry?.center ?? null, radius_m: geometry?.radius_m ?? null },
        contact_ids: [...doc.contact_ids],
        contact_label: label,
        duration_min: doc.duration_min,
        started_at: doc.started_at,
        due_at: doc.due_at,
        grace_until: doc.grace_until,
        extend_count: doc.extend_count,
        last_update_at: same?.last_update_at ?? (doc.last_fix ? doc.last_fix.timestamp : null),
        approach: same?.approach ?? null,
        arrived_pending: same?.arrived_pending ?? null,
      });
      await deps.schedule(doc, label).catch(() => undefined);
    };

    /** Güvenli Dönüş'ün açtığı canlı paylaşım: süre uzadıysa uzatılır, bittiyse (alarm hariç) durdurulur. */
    const syncShare = async (doc: Pick<SafeReturnDoc, 'safe_return_id' | 'status' | 'grace_until'>, stop = false) => {
      const sh = await deps.loadShare().catch(() => null);
      if (!sh || sh.safe_return_id !== doc.safe_return_id) return;
      if (doc.status === 'active' && !stop) {
        await deps.extendShare(sh.session_id, safeReturnShareUntil(doc)).catch(() => undefined);
        return;
      }
      // Alarmda paylaşım sürer (kişiler canlı konumu görsün); SOS kapanınca `stop` ile durdurulur.
      if (doc.status === 'alarm' && !stop) return;
      await deps.saveShare(null).catch(() => undefined);
      await deps.stopShare(sh.session_id).catch(() => undefined);
    };

    const endLocal = async (id: string) => {
      const rec = await deps.load().catch(() => null);
      if (rec && rec.safe_return_id === id) await deps.save(null).catch(() => undefined);
      await deps.cancelLocal(id).catch(() => undefined);
    };

    const applyDoc = (doc: SafeReturnDoc) => {
      const cur = get().current;
      if (cur && cur.safe_return_id === doc.safe_return_id && doc.version < cur.version) return;
      const view = toSafeReturnView(doc);
      const wasActive = !cur || cur.safe_return_id !== doc.safe_return_id || cur.status === 'active';
      const patch: Partial<SafeReturnState> = { current: view, ...computed(view) };
      void syncShare(doc);
      if (doc.status === 'active') {
        void persistActive(doc);
      } else {
        void endLocal(doc.safe_return_id);
        if (wasActive && get().ended?.safe_return_id !== doc.safe_return_id) {
          const reason: SafeReturnEndReason = doc.status === 'alarm' ? 'alarm' : doc.status === 'arrived' ? 'arrived' : doc.status === 'checked_in' ? 'checked_in' : 'cancelled';
          patch.ended = { safe_return_id: doc.safe_return_id, reason, at: doc.ended_at ?? deps.now(), destination_name: doc.destination.name };
        }
        startGeometry = null;
      }
      set(patch);
    };

    const call = async (
      busy: Exclude<SafeReturnBusy, null>,
      fn: (id: string) => Promise<{ safe_return: SafeReturnDoc }>,
    ): Promise<Result> => {
      const cur = get().current;
      if (!cur || cur.status !== 'active') return { ok: true };
      if (get().busy) return fail({ code: 'rate_limited', message: ERROR_CODES.rate_limited.message }, get().busy);
      set({ busy, error: null });
      try {
        const res = await fn(cur.safe_return_id);
        confirmedAt = Date.now();
        applyDoc(res.safe_return);
        set({ busy: null });
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    };

    /** Alarm açıldı: "Güvendeyim" SOS'u kapatır (kişilere "güvende" bildirimi SOS yolundan), paylaşım durur. */
    const resolveAlarm = async (v: SafeReturnView): Promise<Result> => {
      const ok = await deps.resolveSos(v.sos_id).catch(() => false);
      if (!ok) return fail(new KonumError('unavailable'));
      set({ error: null, ended: { safe_return_id: v.safe_return_id, reason: 'checked_in', at: deps.now(), destination_name: v.destination.name } });
      void syncShare({ safe_return_id: v.safe_return_id, status: 'alarm', grace_until: v.grace_until }, true);
      return { ok: true };
    };

    return {
      hydrated: false,
      current: null,
      phase: 'idle',
      leftMs: 0,
      busy: null,
      error: null,
      ended: null,
      liveShareSkipped: [],

      hydrate: async () => {
        const me = deps.myUid();
        const rec = await deps.load().catch(() => null);
        if (rec && me && rec.uid === me && rec.status === 'active' && !get().current) {
          const view = viewFromRecord(rec);
          set({ current: view, ...computed(view), hydrated: true });
          return;
        }
        set({ hydrated: true });
      },

      start: async (input) => {
        if (get().busy) return fail({ code: 'rate_limited', message: ERROR_CODES.rate_limited.message }, get().busy);
        const cur = get().current;
        if (cur && cur.status === 'active') return fail(new KonumError('safe_return_active'));
        const me = deps.myUid();
        if (!me) return fail(new KonumError('unauthenticated'));
        const contacts = [...new Set(input.contact_ids)].filter((u) => u !== me).slice(0, SAFE_RETURN_LIMITS.maxContacts);
        if (contacts.length === 0) return fail({ code: 'no_emergency_contacts', message: SAFE_RETURN_TEXT.contactsEmpty });
        set({ busy: 'start', error: null, liveShareSkipped: [] });
        try {
          const fix = await deps.getFix().catch(() => null);
          if (!fix) return fail({ code: 'invalid_argument', message: SAFE_RETURN_TEXT.needsLocation });
          const d = input.destination;
          startGeometry = { center: d.center, radius_m: d.kind === 'zone' ? d.radius_m : Math.max(30, Math.round(d.radius_m ?? 75)) };
          const res = await deps.api.safeReturnStart({
            op_id: deps.newOpId(),
            duration_min: input.duration_min,
            destination: { kind: d.kind, name: sanitizeSafeReturnName(d.name), zone_id: d.kind === 'zone' ? d.zone_id : null },
            contact_ids: contacts,
            fix,
            time_zone: deps.timeZone(),
          });
          confirmedAt = Date.now();
          applyDoc(res.safe_return);
          await persistActive(res.safe_return).catch(() => undefined);
          set({ busy: null, ended: null });
          if (input.shareLive !== false) {
            const sr = res.safe_return;
            void deps
              .autoShare(sr.contact_ids, safeReturnShareUntil(sr))
              .then(async (r) => {
                if (r.needsGrant.length) set({ liveShareSkipped: [...r.needsGrant] });
                if (!r.sessionId) return;
                await deps.saveShare({ uid: me, safe_return_id: sr.safe_return_id, session_id: r.sessionId });
                // Paylaşım açılırken kayıt bitti / uzadı: hemen eşitle.
                const now = get().current;
                if (now && now.safe_return_id === sr.safe_return_id) await syncShare(now);
              })
              .catch(() => undefined);
          }
          return { ok: true, safe_return_id: res.safe_return.safe_return_id };
        } catch (e) {
          startGeometry = null;
          return fail(e);
        }
      },

      checkIn: async (reason = 'safe') => {
        const cur = get().current;
        if (cur && cur.status === 'alarm') return resolveAlarm(cur);
        const fix = await deps.quickFix().catch(() => null);
        const r = await call('check_in', (id) => deps.api.safeReturnCheckIn({ op_id: deps.newOpId(), safe_return_id: id, reason, fix }));
        if (r.ok || r.error.code !== 'safe_return_not_active' || !cur) return r;
        // Sunucu alarmı açmış olabilir (dinleyici henüz getirmedi): güncel kaydı oku, alarmdaysa SOS'u kapat.
        const fresh = await deps.fetchDoc(cur.safe_return_id).catch(() => null);
        if (!fresh || fresh.status === 'active') return r;
        applyDoc(fresh);
        if (fresh.status !== 'alarm') {
          set({ error: null });
          return { ok: true }; // başka yoldan zaten bitti (varış / check-in / iptal)
        }
        return resolveAlarm(toSafeReturnView(fresh));
      },

      extend: () => call('extend', (id) => deps.api.safeReturnExtend({ op_id: deps.newOpId(), safe_return_id: id })),

      cancel: () => call('cancel', (id) => deps.api.safeReturnCancel({ op_id: deps.newOpId(), safe_return_id: id })),

      applyDocs: (docs) => {
        // Kayıt arka planda (başsız varış / bildirim eylemi) bittiyse Güvenli Dönüş'ün açtığı paylaşım burada durur.
        void deps
          .loadShare()
          .then((sh) => {
            const d = sh ? docs.find((x) => x.safe_return_id === sh.safe_return_id) : undefined;
            if (d && d.status !== 'active' && d.status !== 'alarm') return syncShare(d);
            return undefined;
          })
          .catch(() => undefined);
        const active = [...docs].filter((d) => d.status === 'active').sort((a, b) => b.created_at - a.created_at)[0];
        if (active) {
          applyDoc(active);
          return;
        }
        const cur = get().current;
        if (!cur) return; // eski bitmiş kayıtlar gösterilmez
        const same = docs.find((d) => d.safe_return_id === cur.safe_return_id);
        if (same) {
          applyDoc(same);
          return;
        }
        // Callable yanıtı dinleyiciden önce geldi: eski anlık görüntü yeni kaydı silmesin.
        if (cur.status === 'active' && Date.now() - confirmedAt < HOLD_MS) return;
        if (cur.status === 'active') void endLocal(cur.safe_return_id);
        set({ current: null, ...computed(null) });
      },

      applyDoc,

      tick: () => {
        const cur = get().current;
        if (!cur) return;
        const c = computed(cur);
        if (c.phase !== get().phase || c.leftMs !== get().leftMs) set(c);
      },

      dismissEnded: () => {
        const cur = get().current;
        set({ ended: null, ...(cur && cur.status !== 'active' ? { current: null, ...computed(null) } : {}) });
      },

      clearError: () => set({ error: null }),

      reset: async () => {
        startGeometry = null;
        confirmedAt = 0;
        set({ hydrated: false, current: null, phase: 'idle', leftMs: 0, busy: null, error: null, ended: null, liveShareSkipped: [] });
        await deps.save(null).catch(() => undefined);
        await deps.saveShare(null).catch(() => undefined);
        await deps.cancelLocal(null).catch(() => undefined);
      },
    };
  });
}

export const safeReturnStore = createSafeReturnStore();

// Konum hattı / bölge izleyicisi / bildirim eylemi sunucu yanıtı aldı (aynı JS bağlamı).
onF9HookChange((e) => {
  if (e.kind !== 'safe_return') return;
  if (e.doc) safeReturnStore.getState().applyDoc(e.doc);
});

export function useSafeReturnStore<T>(selector: (s: SafeReturnState) => T): T {
  return useStore(safeReturnStore, selector);
}

/** Süren (etkin ya da alarmda) Güvenli Dönüş'ün hedef adı — SMS gövdesi "Güvenli Dönüş: Ev hedefine varamadım". */
export function selectSafeReturnDestName(s: Pick<SafeReturnState, 'current'>): string | null {
  const c = s.current;
  return c && (c.status === 'active' || c.status === 'alarm') ? c.destination.name : null;
}
