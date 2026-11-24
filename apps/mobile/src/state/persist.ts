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
import type { EpochMs, LastPublished, LinkId, LinkPublishTarget, PublishTarget, SessionId, ShareId, TrackingProfileId, UserId } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

const TARGETS_KEY = 'konum.bg.targets.v1';
const CURSOR_KEY = 'konum.bg.cursor.v1';
const PROFILE_KEY = 'konum.bg.profile.v1';
const PERMISSION_FLOW_KEY = 'konum.ui.permissionFlowDone.v1';

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

const readTargets = () => read(TARGETS_KEY, TargetsSchema, EMPTY_TARGETS);
const writeTargets = (v: PersistedTargets) => AsyncStorage.setItem(TARGETS_KEY, JSON.stringify(v));

/** Kilit dışında anlık okuma (karar vermek için değil, yalnızca bilgi için). */
export const loadTargets = (): Promise<PersistedTargets> => readTargets();

/** Ön planın yetkili tam listesi (sharingCoordinator). `linkTargets` verilmezse boş liste yazılır. */
export const saveTargets = (v: Omit<PersistedTargets, 'linkTargets'> & { linkTargets?: PersistedLinkTarget[] }): Promise<void> =>
  withTargetsLock(() => writeTargets({ ...v, linkTargets: v.linkTargets ?? [] }));

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

/**
 * Çıkışta: arka plan görevi bir sonraki örnekte hedef bulamaz ve takibi kapatır.
 * Durdurma niyetleri (stopIntents) SİLİNMEZ: aynı hesapla tekrar girişte sunucuya yeniden gönderilir.
 */
export async function clearBackgroundState(): Promise<void> {
  await withTargetsLock(() => AsyncStorage.multiRemove([TARGETS_KEY, CURSOR_KEY, PROFILE_KEY]));
}
