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
import {
  APPROACH_LIMITS,
  DESTINATION_KINDS,
  SAFE_RETURN_DEST_KINDS,
  SAFE_RETURN_STATUSES,
  type ApproachState,
  type EpochMs,
  type LastPublished,
  type LatLng,
  type LinkId,
  type LinkPublishTarget,
  type PublishTarget,
  type SafeReturnDestKind,
  type SafeReturnStatus,
  type SessionId,
  type ShareDestination,
  type ShareId,
  type StatusNote,
  type TrackingProfileId,
  type UserId,
} from '@konum/core';
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
 * Faz 7: gizlilik tercihlerinin başsız kopyası (yalnızca `battery_share` + `movement_alerts`, hesaba bağlı) ve son
 * "yola çıktı" bildiriminin anı. Konum İÇERMEZ. Çıkışta silinir.
 */
const PRIVACY_KEY = 'konum.bg.privacy.v1';
const MOVEMENT_KEY = 'konum.bg.movement.v1';
/**
 * Faz 9 (hepsi çıkışta silinir):
 *  - PROOF: etkin anlık fotoğrafımın kimliği ve bitişi (konum hattı `photo_id` + `photo_exp` ekler). Görsel YOK.
 *  - DESTINATION: tek etkin hedefim (koordinat YALNIZCA bu cihazda) + oturum başına yaklaşma durumu + bekleyen rapor.
 *  - SAFE_RETURN: süren Güvenli Dönüş (hedef koordinatı ve yarıçapı varış algılaması için; kimlik, bitişler).
 *  - LAST_FIX: son doğrulanmış konum (≤ 100 m) + pil; çevrimdışı SOS SMS'i için (paylaşım olmasa da yazılır).
 */
const PROOF_KEY = 'konum.bg.proof.v1';
const DESTINATION_KEY = 'konum.bg.destination.v1';
const SAFE_RETURN_KEY = 'konum.bg.safeReturn.v1';
const LAST_FIX_KEY = 'konum.bg.lastFix.v1';
/** Güvenli Dönüş'ün kendi başlattığı canlı paylaşım oturumu (check-in / iptalde durdurulur; kayıt silinse de kalır). */
const SAFE_RETURN_SHARE_KEY = 'konum.safeReturn.liveShare.v1';

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
  await withTargetsLock(() =>
    AsyncStorage.multiRemove([
      TARGETS_KEY,
      CURSOR_KEY,
      PROFILE_KEY,
      STATUS_NOTE_KEY,
      ZONES_KEY,
      ZONE_FILTER_KEY,
      ZONE_REPORTS_KEY,
      PUBLISH_HOLD_KEY,
      PRIVACY_KEY,
      MOVEMENT_KEY,
      PROOF_KEY,
      DESTINATION_KEY,
      SAFE_RETURN_KEY,
      LAST_FIX_KEY,
      SAFE_RETURN_SHARE_KEY,
    ]),
  );
  statusNoteCache = null;
  privacyCache = null;
  for (const r of F9_RECORDS) r.forget(null);
}

// --- Faz 7: gizlilik tercihi (pil paylaşımı) ve "yola çıktı" -----------------------------------------

export interface PersistedPrivacy {
  uid: UserId;
  battery_share: boolean;
  movement_alerts: boolean;
}

const PersistedPrivacySchema = z.object({ uid: z.string().min(1), battery_share: z.boolean(), movement_alerts: z.boolean().default(true) });
let privacyCache: PersistedPrivacy | null | undefined;

export async function loadPrivacy(): Promise<PersistedPrivacy | null> {
  if (privacyCache !== undefined) return privacyCache;
  const v = await read(PRIVACY_KEY, PersistedPrivacySchema.nullable(), null);
  privacyCache = v;
  return v;
}

export async function savePrivacy(v: PersistedPrivacy | null): Promise<void> {
  privacyCache = v;
  try {
    if (v) await AsyncStorage.setItem(PRIVACY_KEY, JSON.stringify(v));
    else await AsyncStorage.removeItem(PRIVACY_KEY);
  } catch {
    // disk yazılamadı: bellek önbelleği bu çalıştırma için yeterli
  }
}

/** Pil bilgisi yayınlanabilir mi? Kayıt yoksa / başka hesabınsa HAYIR (varsayılan kapalı; sunucu kuralı da reddeder). */
export async function batteryShareAllowed(uid: UserId): Promise<boolean> {
  const p = await loadPrivacy().catch(() => null);
  return p !== null && p.uid === uid && p.battery_share;
}

export interface PersistedMovement {
  uid: UserId;
  /** Son "yola çıktı" bildiriminin anı (sunucu saati). */
  last_report_at: EpochMs | null;
}

const PersistedMovementSchema = z.object({ uid: z.string().min(1), last_report_at: z.number().nullable() });

export const loadMovement = (): Promise<PersistedMovement | null> => read(MOVEMENT_KEY, PersistedMovementSchema.nullable(), null);

export async function saveMovement(v: PersistedMovement): Promise<void> {
  await AsyncStorage.setItem(MOVEMENT_KEY, JSON.stringify(v)).catch(() => undefined);
}

/** Testler: bellek önbelleğini sıfırla. */
export function __resetPrivacyCacheForTests(): void {
  privacyCache = undefined;
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

// --- Faz 9: anlık fotoğraf, hedef / yaklaşma, Güvenli Dönüş, son doğrulanmış konum -------------------------

/** Bellek önbellekli tek kayıt (konum hattı her örnekte diske gitmesin). `undefined` = henüz okunmadı. */
interface CachedRecord<T> {
  load(): Promise<T | null>;
  save(v: T | null): Promise<void>;
  /** Önbelleği verilen değere ayarlar (`undefined` = bir sonraki okumada diskten). */
  forget(v?: T | null): void;
}

function cachedRecord<T>(key: string, schema: z.ZodType<T>): CachedRecord<T> {
  let cache: T | null | undefined;
  return {
    load: async () => {
      if (cache !== undefined) return cache;
      const v = await read(key, schema.nullable(), null);
      cache = v;
      return v;
    },
    save: async (v) => {
      cache = v;
      try {
        if (v) await AsyncStorage.setItem(key, JSON.stringify(v));
        else await AsyncStorage.removeItem(key);
      } catch {
        // disk yazılamadı: bellek önbelleği bu çalıştırma için yeterli
      }
    },
    forget: (v) => {
      cache = v;
    },
  };
}

/** Etkin anlık fotoğrafım (görsel değil; görsel önbellek dizininde, bkz. services/proof/cache). */
export interface PersistedProof {
  uid: UserId;
  proof_id: string;
  /** Sunucu saati. */
  expires_at: EpochMs;
  captured_at: EpochMs;
  caption: string | null;
  width: number;
  height: number;
}

const PersistedProofSchema: z.ZodType<PersistedProof> = z.object({
  uid: z.string().min(1),
  proof_id: z.string().min(1),
  expires_at: z.number(),
  captured_at: z.number(),
  caption: z.string().nullable(),
  width: z.number(),
  height: z.number(),
});

const ApproachStateSchema: z.ZodType<ApproachState> = z.object({
  dest_key: z.string(),
  phase: z.enum(['unarmed', 'armed', 'confirming', 'fired']),
  confirm_count: z.number(),
  confirm_since: z.number().nullable(),
  fired_at: z.number().nullable(),
  arrived_at: z.number().nullable(),
  last_distance_m: z.number().nullable(),
});

const LatLngSchema: z.ZodType<LatLng> = z.object({ lat: z.number(), lng: z.number() });

const ShareDestinationSchema: z.ZodType<ShareDestination> = z.object({
  key: z.string(),
  kind: z.enum(DESTINATION_KINDS),
  ref_id: z.string().nullable(),
  name: z.string(),
  center: LatLngSchema,
  radius_m: z.number(),
  set_at: z.number(),
});

/** Çağrılamamış (çevrimdışı) "Neredeyse vardım" raporu: bağlantı gelince `maxReportAgeMs` içinde bir kez denenir. */
export interface PendingApproachReport {
  request: {
    op_id: string;
    session_ids: SessionId[];
    dest_key: string;
    dest_name: string;
    dest_kind: ShareDestination['kind'];
    distance_m: number;
    eta_min: number;
    at: EpochMs;
  };
  created_at: EpochMs;
}

export interface ApproachReportResult {
  at: EpochMs;
  status: 'sent' | 'already_sent' | 'no_recipients' | 'stale' | 'invisible' | 'dropped';
  notified_count: number;
}

export interface PersistedDestination {
  uid: UserId;
  destination: ShareDestination;
  /** Oturum başına yaklaşma durumu (core `approachReduce`); `fired` kalıcıdır. */
  approach: Record<SessionId, ApproachState>;
  pending_report: PendingApproachReport | null;
  last_report: ApproachReportResult | null;
}

const PersistedDestinationSchema: z.ZodType<PersistedDestination> = z.object({
  uid: z.string().min(1),
  destination: ShareDestinationSchema,
  approach: z.record(z.string(), ApproachStateSchema),
  pending_report: z
    .object({
      request: z.object({
        op_id: z.string(),
        session_ids: z.array(z.string()),
        dest_key: z.string(),
        dest_name: z.string(),
        dest_kind: z.enum(DESTINATION_KINDS),
        distance_m: z.number(),
        eta_min: z.number(),
        at: z.number(),
      }),
      created_at: z.number(),
    })
    .nullable()
    .default(null),
  last_report: z
    .object({
      at: z.number(),
      status: z.enum(['sent', 'already_sent', 'no_recipients', 'stale', 'invisible', 'dropped']),
      notified_count: z.number(),
    })
    .nullable()
    .default(null),
});

/** Güvenli Dönüş hedefi: sunucuya yalnızca ad / tür / bölge kimliği gider; koordinat ve yarıçap BURADA kalır. */
export interface PersistedSafeReturnDestination {
  kind: SafeReturnDestKind;
  name: string;
  zone_id: string | null;
  center: LatLng | null;
  radius_m: number | null;
}

export interface PersistedSafeReturn {
  uid: UserId;
  safe_return_id: string;
  status: SafeReturnStatus;
  destination: PersistedSafeReturnDestination;
  contact_ids: UserId[];
  /** Yerel bildirim metni için kişi adları ("Annem ve Babam"); bilinmiyorsa null. */
  contact_label: string | null;
  duration_min: number;
  started_at: EpochMs;
  due_at: EpochMs;
  grace_until: EpochMs;
  extend_count: number;
  /** Son `safe_return_update` anı (sunucu saati; en sık `updateMinIntervalMs`). */
  last_update_at: EpochMs | null;
  /** Nokta / bölge hedefinde varış algılaması (core `approachReduce` varış yarıçapı). */
  approach: ApproachState | null;
  /** Varış algılandı, `check_in {reason:'arrived'}` henüz onaylanmadı (aynı op_id ile yeniden denenir). */
  arrived_pending: { op_id: string; at: EpochMs } | null;
}

const PersistedSafeReturnSchema: z.ZodType<PersistedSafeReturn> = z.object({
  uid: z.string().min(1),
  safe_return_id: z.string().min(1),
  status: z.enum(SAFE_RETURN_STATUSES),
  destination: z.object({
    kind: z.enum(SAFE_RETURN_DEST_KINDS),
    name: z.string(),
    zone_id: z.string().nullable(),
    center: LatLngSchema.nullable(),
    radius_m: z.number().nullable(),
  }),
  contact_ids: z.array(z.string()),
  contact_label: z.string().nullable().default(null),
  duration_min: z.number(),
  started_at: z.number().default(0),
  due_at: z.number(),
  grace_until: z.number(),
  extend_count: z.number().default(0),
  last_update_at: z.number().nullable(),
  approach: ApproachStateSchema.nullable(),
  arrived_pending: z.object({ op_id: z.string(), at: z.number() }).nullable(),
});

/** Son doğrulanmış konum (doğruluk ≤ 100 m) + pil. Zaman damgası sunucu saati. */
export interface PersistedLastFix {
  uid: UserId | null;
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: EpochMs;
  battery_pct: number | null;
  is_charging: boolean | null;
}

const PersistedLastFixSchema: z.ZodType<PersistedLastFix> = z.object({
  uid: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number(),
  timestamp: z.number(),
  battery_pct: z.number().nullable(),
  is_charging: z.boolean().nullable(),
});

const proofRecord = cachedRecord(PROOF_KEY, PersistedProofSchema);
const destinationRecord = cachedRecord(DESTINATION_KEY, PersistedDestinationSchema);
const safeReturnRecord = cachedRecord(SAFE_RETURN_KEY, PersistedSafeReturnSchema);
const lastFixRecord = cachedRecord(LAST_FIX_KEY, PersistedLastFixSchema);

/** Güvenli Dönüş'ün başlattığı canlı paylaşım (yalnızca eksik kişilerle açılan yeni oturum). */
export interface PersistedSafeReturnShare {
  uid: UserId;
  safe_return_id: string;
  session_id: SessionId;
}
const PersistedSafeReturnShareSchema: z.ZodType<PersistedSafeReturnShare> = z.object({
  uid: z.string().min(1),
  safe_return_id: z.string().min(1),
  session_id: z.string().min(1),
});
const safeReturnShareRecord = cachedRecord(SAFE_RETURN_SHARE_KEY, PersistedSafeReturnShareSchema);
export const loadSafeReturnShare = (): Promise<PersistedSafeReturnShare | null> => safeReturnShareRecord.load();
export const saveSafeReturnShare = (v: PersistedSafeReturnShare | null): Promise<void> => safeReturnShareRecord.save(v);

const F9_RECORDS: CachedRecord<unknown>[] = [proofRecord, destinationRecord, safeReturnRecord, lastFixRecord, safeReturnShareRecord] as CachedRecord<unknown>[];

export const loadProof = (): Promise<PersistedProof | null> => proofRecord.load();
export const saveProof = (v: PersistedProof | null): Promise<void> => proofRecord.save(v);
export const loadDestination = (): Promise<PersistedDestination | null> => destinationRecord.load();
export const saveDestination = (v: PersistedDestination | null): Promise<void> => destinationRecord.save(v);
export const loadSafeReturn = (): Promise<PersistedSafeReturn | null> => safeReturnRecord.load();
export const saveSafeReturn = (v: PersistedSafeReturn | null): Promise<void> => safeReturnRecord.save(v);
export const loadLastFix = (): Promise<PersistedLastFix | null> => lastFixRecord.load();
export const saveLastFix = (v: PersistedLastFix | null): Promise<void> => lastFixRecord.save(v);

/** Testler: Faz 9 bellek önbelleklerini sıfırla (bir sonraki okuma diskten). */
export function __resetF9CacheForTests(): void {
  for (const r of F9_RECORDS) r.forget(undefined);
}

/** Yaklaşma raporu en çok bu kadar bekletilir (core `APPROACH_LIMITS.maxReportAgeMs`; sunucu daha eskisini `stale` sayar). */
export const APPROACH_PENDING_MAX_AGE_MS = APPROACH_LIMITS.maxReportAgeMs;
