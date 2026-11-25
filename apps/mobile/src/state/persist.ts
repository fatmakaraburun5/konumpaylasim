/**
 * AsyncStorage'a YALNIZCA arka plan görevinin ihtiyaç duyduğu şeyler yazılır:
 *   - uid, yayın hedefleri (share_id, receiver_id, mod, bitiş + oturum özeti), sunucu saat farkı
 *   - Faz 2: bağlantı (QR) hedefleri (link_id, token_hash, mod, bitiş, görünen ad + oturum özeti).
 *     Düz token ve QR URL'si BURAYA YAZILMAZ (güvenli kasada, bkz. linkTokenVault); yayın yolu
 *     `link_live/{token_hash}` olduğu için arka plan görevinin token'a ihtiyacı yoktur.
 *   - son yayın imleci (son gönderilen konum + zaman; "taşındı mı / nabız zamanı mı" kararı için)
 *   - arka plan görevinin takip profili (ayrı anahtar)
 * Arkadaşların konumu, telefon numarası, profil ASLA yazılmaz.
 *
 * Anahtarlar ve yazanlar:
 *   TARGETS  ön plan (sharingCoordinator, tam liste) + arka plan hattı (yalnızca ÇIKARIR / bitiş günceller)
 *   CURSOR   yalnızca konum hattı (lastPublished, lastTargetsKey, authMissingSince, Faz 3 lastLiveTs)
 *   PROFILE  ön plan + konum hattı (yalnızca profileId; ayrı anahtar ki imleci ezmesin)
 *
 * Hedef listesine tüm yazmalar tek bir kilitten (`withTargetsLock`) geçer: aynı JS bağlamındaki
 * ön plan ve arka plan yazmaları okuma-değiştirme-yazma sırasında birbirini ezemez.
 * Konum hattı hiçbir zaman hedef EKLEMEZ (yalnızca çıkarır ya da var olanın bitişini günceller):
 * kullanıcının durdurduğu bir paylaşım eski bir anlık görüntüden geri gelemez.
 *
 * iOS notu: AsyncStorage klasörü cihaz yedeğine dahildir. Bu yüzden imleç (kendi son konumun)
 * paylaşım bitince silinir (`clearCursor`). Android'de `allowBackup: false`. [Varsayım: doğrulanmalı]
 */
import type { EpochMs, LastPublished, LinkId, LinkPublishTarget, PublishTarget, SessionId, ShareId, StatusNote, TrackingProfileId, UserId } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

const TARGETS_KEY = 'konum.bg.targets.v1';
const CURSOR_KEY = 'konum.bg.cursor.v1';
const PROFILE_KEY = 'konum.bg.profile.v1';
const PERMISSION_FLOW_KEY = 'konum.ui.permissionFlowDone.v1';
/** Faz 4: kendi durum notum (arka plan hattı da okur ve paketlere ekler). Konum İÇERMEZ. */
const STATUS_NOTE_KEY = 'konum.bg.statusNote.v1';
/**
 * Faz 5: bölge izleme (başsız OS bölge olayı da okur). Bölge merkezleri (ev/iş) YALNIZCA bu cihazda; sunucuya giden
 * olayda koordinat yoktur. Çıkışta silinir.
 */
const ZONES_KEY = 'konum.bg.zones.v1';
const ZONE_FILTER_KEY = 'konum.bg.zoneFilter.v1';
const ZONE_REPORTS_KEY = 'konum.bg.zoneReports.v1';
/**
 * Faz 8: "hiçbir şey yayınlama" kesme anahtarı (görünmez mod niyeti + onay kapısı). Başsız konum hattı, bölge görevi,
 * widget benimseme ve takip yeniden başlatma bunu okur; bellek kopyası `state/publishHold.ts`. Konum İÇERMEZ.
 */
const PUBLISH_HOLD_KEY = 'konum.bg.invisible.v1';
/**
 * Faz 8: sunucuya ulaştığı doğrulanmamış görünmez olma niyeti, hesaba göre. Çıkışta SİLİNMEZ (stopIntents gibi):
 * aynı hesapla yeniden girişte niyet geri gelir ve aynı op_id ile yeniden gönderilir.
 */
const PENDING_INVISIBLE_KEY = 'konum.f8.pendingInvisible.v1';

/**
 * Yayın hedefi + sunucunun onayladığı oturum özeti. Özet, açılışta sunucu dinleyicisi henüz
 * (ya da hiç) yanıt vermezken süren paylaşımı "Durdur" düğmesiyle göstermek için kullanılır.
 */
export interface PersistedTarget extends PublishTarget {
  session_id?: SessionId;
  started_at?: EpochMs;
  version?: number;
}

/** Bağlantı yayın hedefi + açılışta geçici kart için oturum özeti. */
export interface PersistedLinkTarget extends LinkPublishTarget {
  session_id?: string;
  started_at?: EpochMs;
  version?: number;
  extended_count?: number;
}

export interface PersistedTargets {
  uid: UserId | null;
  targets: PersistedTarget[];
  /** Faz 2: bağlantı hedefleri (eski kayıtlarda yok → boş liste). */
  linkTargets: PersistedLinkTarget[];
  serverOffsetMs: number;
  /** Ön plan servisi bildirimi metni ("2 kişiyle · 17:45'e kadar"). */
  notificationBody: string;
  /**
   * Faz 8: liste onay kapısını bilen bir sürümün ön planı tarafından (`saveTargets`) yazıldı mı. Eski (Faz 8 öncesi)
   * kayıtta yok: yayın anahtarı kaydı da yoksa başsız bağlam onay durumunu bilemez ve yayın yapmaz (`publishHold`).
   */
  consent_aware?: boolean;
}

export interface PersistedCursor {
  lastPublished: LastPublished | null;
  lastTargetsKey: string | null;
  /** Arka planda oturumun yok göründüğü ilk an (sunucu saati); bkz. pipeline. */
  authMissingSince: EpochMs | null;
  /**
   * Faz 3: canlı düğümlere başarıyla yazılan EN YENİ noktanın ölçüm anı (taze ya da kuyruktan). Kuyruktaki daha
   * eski nokta canlıya yazılmaz (RTDB kuralı da reddeder: `q: 1` düğümdeki noktadan yeni olmalı).
   */
  lastLiveTs: EpochMs | null;
  /** Faz 4: son yayınlanan paketlerdeki durum notu etiketi ('' = notsuz). Değişince hemen yayın zorlanır. */
  lastNoteKey?: string | null;
}

const TargetSchema = z.object({
  share_id: z.string(),
  receiver_id: z.string(),
  share_mode: z.enum(['timed', 'until_end_of_day', 'weekly', 'indefinite']),
  expires_at: z.number().nullable(),
  session_id: z.string().optional(),
  started_at: z.number().optional(),
  version: z.number().optional(),
});

const LinkTargetSchema = z.object({
  link_id: z.string().min(1),
  token_hash: z.string().regex(/^[0-9a-f]{64}$/),
  share_mode: z.enum(['timed', 'until_end_of_day', 'weekly', 'indefinite']),
  expires_at: z.number().nullable(),
  sender_name: z.string(),
  session_id: z.string().optional(),
  started_at: z.number().optional(),
  version: z.number().optional(),
  extended_count: z.number().optional(),
});

const TargetsSchema = z.object({
  uid: z.string().nullable(),
  targets: z.array(TargetSchema),
  linkTargets: z.array(LinkTargetSchema).default([]),
  serverOffsetMs: z.number(),
  notificationBody: z.string().default(''),
  consent_aware: z.boolean().optional(),
});

const CursorSchema = z.object({
  lastPublished: z
    .object({
      lat: z.number(),
      lng: z.number(),
      sent_at: z.number(),
      battery_pct: z.number().nullable(),
      activity: z.enum(['still', 'walking', 'running', 'cycling', 'automotive', 'unknown']),
    })
    .nullable()
    .default(null),
  lastTargetsKey: z.string().nullable().default(null),
  authMissingSince: z.number().nullable().default(null),
  lastLiveTs: z.number().nullable().default(null),
  lastNoteKey: z.string().nullable().default(null),
});

const ProfileSchema = z.object({
  profileId: z.enum(['off', 'live_foreground', 'live_background', 'still_background', 'low_battery']).nullable(),
});

export const EMPTY_TARGETS: PersistedTargets = { uid: null, targets: [], linkTargets: [], serverOffsetMs: 0, notificationBody: '' };
export const EMPTY_CURSOR: PersistedCursor = { lastPublished: null, lastTargetsKey: null, authMissingSince: null, lastLiveTs: null };

async function read<T>(key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

// --- hedefler (kilitli) ----------------------------------------------------------------------

let targetsLock: Promise<unknown> = Promise.resolve();

/** Hedef listesi üzerinde kilitli işlem: `fn` bitene kadar başka hedef yazması başlamaz. */
export function withTargetsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = targetsLock.then(fn, fn);
  targetsLock = run.catch(() => undefined);
  return run;
}

/** Son okunan / yazılan hedef listesi onay kapısını bilen sürümden mi (yayın anahtarı kaydı yokken bakılır). */
let lastTargetsLegacy = false;
const noteTargets = (v: PersistedTargets): PersistedTargets => {
  lastTargetsLegacy = !!v.uid && (v.targets.length > 0 || v.linkTargets.length > 0) && v.consent_aware !== true;
  return v;
};
const readTargets = () => read(TARGETS_KEY, TargetsSchema, EMPTY_TARGETS).then(noteTargets);
const writeTargets = (v: PersistedTargets) => AsyncStorage.setItem(TARGETS_KEY, JSON.stringify(noteTargets(v)));

/**
 * Faz 8: son okunan hedef listesi Faz 8 öncesi bir sürümün yazdığı, boş olmayan bir liste mi? (`publishHold`: anahtar
 * kaydı yoksa onay durumu bilinmiyor demektir → başsız bağlam yayın yapmaz.)
 */
export function lastTargetsAreLegacy(): boolean {
  return lastTargetsLegacy;
}

/** Kilit dışında anlık okuma (karar vermek için değil, yalnızca bilgi için). */
export const loadTargets = (): Promise<PersistedTargets> => readTargets();

/** Ön planın yetkili tam listesi (sharingCoordinator). `linkTargets` verilmezse boş liste yazılır. */
export const saveTargets = (v: Omit<PersistedTargets, 'linkTargets'> & { linkTargets?: PersistedLinkTarget[] }): Promise<void> =>
  withTargetsLock(() => writeTargets({ ...v, linkTargets: v.linkTargets ?? [], consent_aware: true }));

/**
 * Kilitli okuma-değiştirme-yazma. `fn` null dönerse hiçbir şey yazılmaz. Dönen değer: işlem sonrası liste.
 * `fn` içinde ağ çağrısı YAPILMAZ (kilit kısa tutulur).
 */
export function updateTargets(fn: (latest: PersistedTargets) => PersistedTargets | null): Promise<PersistedTargets> {
  return withTargetsLock(async () => {
    const latest = await readTargets();
    const next = fn(latest);
    if (!next) return latest;
    await writeTargets(next);
    return next;
  });
}

/**
 * Kilitli okuma + kilit içinde yan etki (ör. takibi kapatma) için. `write` kilidi yeniden almadan yazar;
 * `fn` içinde saveTargets/updateTargets ÇAĞRILMAZ (kilitlenme).
 */
export function inTargetsLock<T>(fn: (latest: PersistedTargets, write: (v: PersistedTargets) => Promise<void>) => Promise<T>): Promise<T> {
  return withTargetsLock(async () => fn(await readTargets(), writeTargets));
}

/** Konum hattı: verilen kimlikleri EN GÜNCEL listeden çıkarır (hiçbir zaman ekleme yapmaz). */
export function removeTargetIds(ids: Iterable<ShareId>, expectUid: UserId | null): Promise<PersistedTargets> {
  const drop = new Set(ids);
  return updateTargets((latest) => {
    if (drop.size === 0 || latest.uid !== expectUid) return null;
    const targets = latest.targets.filter((t) => !drop.has(t.share_id));
    return targets.length === latest.targets.length ? null : { ...latest, targets };
  });
}

/** Sunucudan gelen bitiş/mod bilgisini yalnızca listede HÂLÂ bulunan hedeflere uygular. */
export function refreshTargetExpiries(fresh: readonly PublishTarget[], expectUid: UserId | null): Promise<PersistedTargets> {
  const byId = new Map(fresh.map((t) => [t.share_id, t] as const));
  return updateTargets((latest) => {
    if (byId.size === 0 || latest.uid !== expectUid) return null;
    let changed = false;
    const targets = latest.targets.map((t) => {
      const f = byId.get(t.share_id);
      if (!f || (f.expires_at === t.expires_at && f.share_mode === t.share_mode)) return t;
      changed = true;
      return { ...t, expires_at: f.expires_at, share_mode: f.share_mode };
    });
    return changed ? { ...latest, targets } : null;
  });
}

/** Konum hattı: verilen bağlantıları EN GÜNCEL listeden çıkarır (hiçbir zaman ekleme yapmaz). */
export function removeLinkTargetIds(ids: Iterable<LinkId>, expectUid: UserId | null): Promise<PersistedTargets> {
  const drop = new Set(ids);
  return updateTargets((latest) => {
    if (drop.size === 0 || latest.uid !== expectUid) return null;
    const linkTargets = latest.linkTargets.filter((t) => !drop.has(t.link_id));
    return linkTargets.length === latest.linkTargets.length ? null : { ...latest, linkTargets };
  });
}

/** Sunucudan gelen bağlantı bitiş/mod bilgisini yalnızca listede HÂLÂ bulunan hedeflere uygular. */
export function refreshLinkTargetExpiries(
  fresh: readonly Pick<LinkPublishTarget, 'link_id' | 'expires_at' | 'share_mode'>[],
  expectUid: UserId | null,
): Promise<PersistedTargets> {
  const byId = new Map(fresh.map((t) => [t.link_id, t] as const));
  return updateTargets((latest) => {
    if (byId.size === 0 || latest.uid !== expectUid) return null;
    let changed = false;
    const linkTargets = latest.linkTargets.map((t) => {
      const f = byId.get(t.link_id);
      if (!f || (f.expires_at === t.expires_at && f.share_mode === t.share_mode)) return t;
      changed = true;
      return { ...t, expires_at: f.expires_at, share_mode: f.share_mode };
    });
    return changed ? { ...latest, linkTargets } : null;
  });
}

/** Oturum kapanmış / başka hesap: yalnızca liste hâlâ o uid'e aitse siler (arada yeni hesap yazdıysa dokunmaz). */
export function wipeTargetsIfUid(uid: UserId | null): Promise<PersistedTargets> {
  return updateTargets((latest) => (latest.uid === uid ? { ...latest, uid: null, targets: [], linkTargets: [] } : null));
}

// --- imleç ve profil -------------------------------------------------------------------------

let cursorLock: Promise<unknown> = Promise.resolve();

export const loadCursor = () => read(CURSOR_KEY, CursorSchema, EMPTY_CURSOR);
export function saveCursor(patch: Partial<PersistedCursor>): Promise<void> {
  const run = cursorLock.then(async () => {
    const cur = await loadCursor();
    await AsyncStorage.setItem(CURSOR_KEY, JSON.stringify({ ...cur, ...patch }));
  });
  cursorLock = run.catch(() => undefined);
  return run;
}

/** Paylaşım bitince kendi son konumunu diskte tutma. */
export function clearCursor(): Promise<void> {
  const run = cursorLock.then(() => AsyncStorage.removeItem(CURSOR_KEY));
  cursorLock = run.catch(() => undefined);
  return run;
}

export async function loadProfileId(): Promise<TrackingProfileId | null> {
  return (await read(PROFILE_KEY, ProfileSchema, { profileId: null })).profileId;
}
export const saveProfileId = (profileId: TrackingProfileId | null): Promise<void> =>
  AsyncStorage.setItem(PROFILE_KEY, JSON.stringify({ profileId }));

// --- arayüz bayrakları -----------------------------------------------------------------------

/** İzin akışı bir kez tamamlandı mı (her paylaşımda yeniden açılmasın). Cihaz düzeyinde. */
export async function loadPermissionFlowDone(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PERMISSION_FLOW_KEY)) === '1';
  } catch {
    return false;
  }
}
export const savePermissionFlowDone = (): Promise<void> => AsyncStorage.setItem(PERMISSION_FLOW_KEY, '1').catch(() => undefined);

// --- Faz 4: durum notu -----------------------------------------------------------------------

/** Kalıcı durum notu: sahibi (başka hesap girerse yok sayılır) + core `StatusNote`. */
export interface PersistedStatusNote {
  uid: UserId;
  note: StatusNote;
}

const StatusNoteSchema = z.object({
  uid: z.string().min(1),
  note: z.object({ emoji: z.string().nullable(), text: z.string().min(1), expires_at: z.number() }),
});

/** Bellek önbelleği: konum hattı her örnekte diske gitmesin (ön plan yazınca güncellenir). undefined = okunmadı. */
let statusNoteCache: PersistedStatusNote | null | undefined;

export async function loadStatusNote(): Promise<PersistedStatusNote | null> {
  if (statusNoteCache !== undefined) return statusNoteCache;
  const v = await read(STATUS_NOTE_KEY, StatusNoteSchema.nullable(), null);
  statusNoteCache = v;
  return v;
}

export async function saveStatusNote(v: PersistedStatusNote | null): Promise<void> {
  statusNoteCache = v;
  try {
    if (v) await AsyncStorage.setItem(STATUS_NOTE_KEY, JSON.stringify(v));
    else await AsyncStorage.removeItem(STATUS_NOTE_KEY);
  } catch {
    // disk yazılamadı: bellek önbelleği bu çalıştırma için yeterli
  }
}

// --- Faz 8: yayın kesme anahtarı (görünmez mod / onay kapısı) ---------------------------------------

/** Görünmez olma niyeti: sunucu onaylayana kadar AYNI op_id ile yeniden denenir. */
export interface PersistedInvisibleIntent {
  op_id: string;
  /** Cihaz saati (yalnızca bilgi). */
  at: EpochMs;
  /** Sunucu profili `invisible.on === true` gösterdi mi (onaylanmış niyet, sunucu kapatınca silinir). */
  confirmed: boolean;
}

export interface PersistedPublishHold {
  uid: UserId;
  invisible: PersistedInvisibleIntent | null;
  /** Güncel sözleşme onayı yok: onaylanana kadar hiçbir şey yayınlanmaz. */
  consent_hold: boolean;
  /**
   * Profilde görülen onaylı sözleşme sürümü (yoksa null). Başsız bağlam profili okuyamaz: bu sürüm uygulamanın
   * `CONSENT_VERSION`'ından eskiyse (sürüm yükseltildi, kapı henüz gösterilmedi) yayın yapılmaz.
   */
  consent_version: string | null;
}

const IntentSchema = z.object({ op_id: z.string(), at: z.number(), confirmed: z.boolean() });

const PublishHoldSchema = z.object({
  uid: z.string().min(1),
  invisible: IntentSchema.nullable().default(null),
  consent_hold: z.boolean().default(false),
  consent_version: z.string().nullable().default(null),
});

export const loadPublishHold = (): Promise<PersistedPublishHold | null> => read(PUBLISH_HOLD_KEY, PublishHoldSchema.nullable(), null);

export async function savePublishHold(v: PersistedPublishHold | null): Promise<void> {
  if (v && (v.invisible || v.consent_hold || v.consent_version)) await AsyncStorage.setItem(PUBLISH_HOLD_KEY, JSON.stringify(v));
  else await AsyncStorage.removeItem(PUBLISH_HOLD_KEY);
}

/** Çıkışta saklanan, onaylanmamış görünmez niyetleri (hesap → niyet). */
export type PendingInvisibleIntents = Record<UserId, PersistedInvisibleIntent>;

export const loadPendingInvisible = (): Promise<PendingInvisibleIntents> =>
  read(PENDING_INVISIBLE_KEY, z.record(z.string(), IntentSchema), {} as PendingInvisibleIntents);

export async function savePendingInvisible(v: PendingInvisibleIntents): Promise<void> {
  if (Object.keys(v).length) await AsyncStorage.setItem(PENDING_INVISIBLE_KEY, JSON.stringify(v));
  else await AsyncStorage.removeItem(PENDING_INVISIBLE_KEY);
}

/**
 * Çıkışta: arka plan görevi bir sonraki örnekte hedef bulamaz ve takibi kapatır.
 * Durdurma niyetleri (stopIntents) SİLİNMEZ: aynı hesapla tekrar girişte sunucuya yeniden gönderilir.
 */
export async function clearBackgroundState(): Promise<void> {
  await withTargetsLock(() => AsyncStorage.multiRemove([TARGETS_KEY, CURSOR_KEY, PROFILE_KEY, STATUS_NOTE_KEY, ZONES_KEY, ZONE_FILTER_KEY, ZONE_REPORTS_KEY, PUBLISH_HOLD_KEY]));
  statusNoteCache = null;
}

// --- Faz 5: bölge izleme ---------------------------------------------------------------------------

/** OS bölge kaydı ve sapma filtresi için bölgenin asgari kopyası (kurallar ve alıcılar YOK: kararı sunucu verir). */
export interface PersistedZone {
  zone_id: string;
  name: string;
  center: { lat: number; lng: number };
  radius_m: number;
  enabled: boolean;
}

export interface PersistedZones {
  uid: UserId | null;
  zones: PersistedZone[];
}

const PersistedZonesSchema = z.object({
  uid: z.string().nullable(),
  zones: z.array(
    z.object({
      zone_id: z.string().min(1),
      name: z.string(),
      center: z.object({ lat: z.number(), lng: z.number() }),
      radius_m: z.number().positive(),
      enabled: z.boolean(),
    }),
  ),
});

const LatLngAt = z.object({ lat: z.number(), lng: z.number(), at: z.number() });
const ZoneFilterStateSchema = z.object({
  presence: z.enum(['unknown', 'inside', 'outside']),
  candidate: z.object({ to: z.enum(['inside', 'outside']), since: z.number(), samples: z.number(), last_at: z.number() }).nullable(),
  last_transition: z.object({ to: z.enum(['inside', 'outside']), at: z.number() }).nullable(),
  last_sample: LatLngAt.nullable(),
});

/** Bölge başına kalıcı filtre durumu (core `ZoneFilterState`): süreç ölse de bekleme / soğuma korunur. */
export interface PersistedZoneFilters {
  uid: UserId | null;
  states: Record<string, z.infer<typeof ZoneFilterStateSchema>>;
}
const PersistedZoneFiltersSchema = z.object({ uid: z.string().nullable(), states: z.record(z.string(), ZoneFilterStateSchema) });

/** Gönderilemeyen (çevrimdışı) bölge olayı: aynı `op_id` ile yeniden denenir. Koordinat YOK. */
export interface PendingZoneReport {
  op_id: string;
  zone_id: string;
  transition: 'arrive' | 'leave';
  occurred_at: number;
  accuracy_m: number | null;
  created_at: number;
  attempts: number;
}
export interface PersistedZoneReports {
  uid: UserId | null;
  reports: PendingZoneReport[];
}
const PersistedZoneReportsSchema = z.object({
  uid: z.string().nullable(),
  reports: z.array(
    z.object({
      op_id: z.string().min(1),
      zone_id: z.string().min(1),
      transition: z.enum(['arrive', 'leave']),
      occurred_at: z.number(),
      accuracy_m: z.number().nullable(),
      created_at: z.number(),
      attempts: z.number(),
    }),
  ),
});

const write = async (key: string, v: unknown): Promise<void> => {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(v));
  } catch {
    // disk yazılamadı: bellek durumu bu çalıştırma için yeterli
  }
};

export const loadZoneCache = (): Promise<PersistedZones> => read(ZONES_KEY, PersistedZonesSchema, { uid: null, zones: [] });
export const saveZoneCache = (v: PersistedZones): Promise<void> => write(ZONES_KEY, v);
export const loadZoneFilters = (): Promise<PersistedZoneFilters> => read(ZONE_FILTER_KEY, PersistedZoneFiltersSchema, { uid: null, states: {} });
export const saveZoneFilters = (v: PersistedZoneFilters): Promise<void> => write(ZONE_FILTER_KEY, v);
export const loadZoneReports = (): Promise<PersistedZoneReports> => read(ZONE_REPORTS_KEY, PersistedZoneReportsSchema, { uid: null, reports: [] });
export const saveZoneReports = (v: PersistedZoneReports): Promise<void> => write(ZONE_REPORTS_KEY, v);

/** Faz 5: bölge izleme durumunu siler (çıkış). */
export async function clearZoneState(): Promise<void> {
  await AsyncStorage.multiRemove([ZONES_KEY, ZONE_FILTER_KEY, ZONE_REPORTS_KEY]).catch(() => undefined);
}
