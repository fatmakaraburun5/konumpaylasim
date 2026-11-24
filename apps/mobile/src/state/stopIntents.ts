/**
 * Durdurma niyetleri: kullanıcının "Durdur" kararı sunucu onaylayana kadar KALICIDIR.
 *
 * Neden: core reducer'daki `paused` bayrağı yalnızca bellektedir. `share_stop` başarısız olur (çevrimdışı,
 * zaman aşımı) ve süreç yeniden başlarsa Firestore paylaşımı hâlâ aktif gösterir; niyet kalıcı olmasaydı
 * yayın sessizce geri gelirdi. Bu modül iki şey sağlar:
 *
 *  1. Bellekte "kesme anahtarı" (kill switch): `addStopIntent` SENKRON olarak paylaşım kimliklerini engeller;
 *     konum hattı ve yayıncı her yazmadan hemen önce `isShareBlocked` ile bakar.
 *  2. AsyncStorage kopyası: başsız (headless) bağlam ve uygulamanın yeniden açılışı aynı niyetleri görür;
 *     sharingCoordinator açılışta niyetleri geri yükler ve `share_stop`'u AYNI op_id ile yeniden dener
 *     (sunucu `ops/{uid}_{op_id}` ile tekilleştirir).
 *
 * Bir niyet şu durumlarda kalkar: `share_stop` başarılı olur; ya da sunucu anlık görüntüsü niyetteki her
 * paylaşımın bittiğini / süresinin dolduğunu / yeni bir oturuma geçtiğini (daha yüksek sürümle) gösterir;
 * ya da kullanıcı aynı kişiyle yeni bir paylaşım başlatır (sunucu belgeyi yeni oturumla değiştirir).
 * Niyet konum içermez (yalnızca oturum/paylaşım kimlikleri), bu yüzden çıkışta silinmez.
 */
import { isExpired, type EpochMs, type SessionId, type ShareId, type ShareStatus, type UserId } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

const STOPS_KEY = 'konum.bg.stops.v1';

export interface StopIntent {
  session_id: SessionId;
  /** share_stop yeniden denemelerinde aynı op_id kullanılır. */
  op_id: string;
  /** Yayını kesilen paylaşımlar ve durdurma anındaki sürümleri. */
  shares: { share_id: ShareId; version: number }[];
  /** Sunucu saati. */
  requested_at: EpochMs;
}

/** Niyetle karşılaştırılan sunucu belgesi alanları (ShareDoc / OutgoingShareView ikisi de uyar). */
export interface ShareSnapshotLike {
  share_id: ShareId;
  session_id: SessionId;
  status: ShareStatus;
  expires_at: EpochMs | null;
  version: number;
}

const IntentSchema = z.object({
  session_id: z.string().min(1),
  op_id: z.string().min(1),
  shares: z.array(z.object({ share_id: z.string().min(1), version: z.number() })),
  requested_at: z.number(),
});
const StoredSchema = z.object({ uid: z.string().nullable(), intents: z.array(IntentSchema) });

let owner: UserId | null = null;
let intents = new Map<SessionId, StopIntent>();
let hydration: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function persist(): Promise<void> {
  const snapshot = JSON.stringify({ uid: owner, intents: [...intents.values()] });
  const run = writes.then(() => AsyncStorage.setItem(STOPS_KEY, snapshot));
  writes = run.catch(() => undefined);
  return run;
}

/** Diskteki niyetleri belleğe katar (bir kez). Bellekte daha yeni bilgi varsa o kazanır. */
export function hydrateStopIntents(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      try {
        const raw = await AsyncStorage.getItem(STOPS_KEY);
        const parsed = raw ? StoredSchema.safeParse(JSON.parse(raw)) : null;
        if (parsed?.success) {
          if (owner === null) owner = parsed.data.uid;
          if (parsed.data.uid === owner || parsed.data.uid === null) {
            for (const i of parsed.data.intents) if (!intents.has(i.session_id)) intents.set(i.session_id, i);
          }
        }
      } catch {
        // okunamadı: bellekteki niyetler geçerli
      }
      notify();
    })();
  }
  return hydration;
}

/**
 * Oturum açılınca: niyetleri bu hesaba bağlar. Başka hesaba ait niyetler bu hesapla gönderilemez → atılır
 * (o hesabın paylaşım kimlikleri bu hesabınkilerle çakışmaz).
 */
export async function bindStopIntentsOwner(uid: UserId): Promise<StopIntent[]> {
  await hydrateStopIntents();
  if (owner !== null && owner !== uid) intents = new Map();
  if (owner !== uid) {
    owner = uid;
    await persist().catch(() => undefined);
    notify();
  }
  return listStopIntents();
}

export function listStopIntents(): StopIntent[] {
  return [...intents.values()];
}

export function getStopIntent(sessionId: SessionId): StopIntent | undefined {
  return intents.get(sessionId);
}

/** Kesme anahtarı: bu paylaşıma şu an yazılabilir mi? (bellekte, senkron) */
export function isShareBlocked(shareId: ShareId): boolean {
  for (const i of intents.values()) if (i.shares.some((s) => s.share_id === shareId)) return true;
  return false;
}

export function blockedShareIds(): Set<ShareId> {
  const out = new Set<ShareId>();
  for (const i of intents.values()) for (const s of i.shares) out.add(s.share_id);
  return out;
}

/**
 * Niyeti ekler/birleştirir. Bellek ANINDA güncellenir (yayın bu satırda kesilir); dönen söz diske yazmadır.
 */
export function addStopIntent(intent: StopIntent): Promise<void> {
  const prev = intents.get(intent.session_id);
  const shares = new Map((prev?.shares ?? []).map((s) => [s.share_id, s] as const));
  for (const s of intent.shares) shares.set(s.share_id, s);
  intents.set(intent.session_id, {
    session_id: intent.session_id,
    op_id: prev?.op_id ?? intent.op_id,
    shares: [...shares.values()],
    requested_at: prev?.requested_at ?? intent.requested_at,
  });
  notify();
  return persist();
}

export function removeStopIntent(sessionId: SessionId): Promise<void> {
  if (!intents.delete(sessionId)) return Promise.resolve();
  notify();
  return persist();
}

/** Yeni başlatılan paylaşımlar eski niyetlerden çıkar (sunucu belgeyi yeni oturumla değiştirdi). */
export function unblockShares(shareIds: readonly ShareId[]): Promise<void> {
  const ids = new Set(shareIds);
  let changed = false;
  for (const [sid, i] of intents) {
    const left = i.shares.filter((s) => !ids.has(s.share_id));
    if (left.length === i.shares.length) continue;
    changed = true;
    if (left.length === 0) intents.delete(sid);
    else intents.set(sid, { ...i, shares: left });
  }
  if (!changed) return Promise.resolve();
  notify();
  return persist();
}

/**
 * Sunucu anlık görüntüsüyle uzlaştırır; kapanan niyetlerin oturum kimliklerini döndürür.
 * Bir paylaşım ancak belge niyetteki sürümden ESKİ değilse çözülmüş sayılır (eski önbellek
 * anlık görüntüsü durdurmayı yanlışlıkla kaldıramaz):
 *   - aynı oturum + (bitti ya da süresi doldu)  → çözüldü
 *   - başka oturum + daha yüksek sürüm          → yeni paylaşım başladı, bu niyetle ilgisi kalmadı
 *   - belge yok / eski sürüm / hâlâ aktif         → çözülmedi (share_stop yeniden denenir)
 */
export function reconcileStopIntents(docs: readonly ShareSnapshotLike[], now: EpochMs): SessionId[] {
  if (intents.size === 0) return [];
  const byId = new Map(docs.map((d) => [d.share_id, d] as const));
  const closed: SessionId[] = [];
  let changed = false;
  for (const [sid, i] of intents) {
    const left = i.shares.filter((s) => {
      const d = byId.get(s.share_id);
      if (!d || d.version < s.version) return true;
      if (d.session_id !== sid) return !(d.version > s.version);
      return !(d.status === 'ended' || isExpired(d, now));
    });
    if (left.length === i.shares.length) continue;
    changed = true;
    if (left.length === 0) {
      intents.delete(sid);
      closed.push(sid);
    } else intents.set(sid, { ...i, shares: left });
  }
  if (changed) {
    notify();
    void persist().catch(() => undefined);
  }
  return closed;
}

export function onStopIntentsChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Testler: süreç yeniden başlamış gibi belleği boşaltır (disk korunur). */
export function __resetStopIntentsMemoryForTests(): void {
  owner = null;
  intents = new Map();
  hydration = null;
  writes = Promise.resolve();
}
