/**
 * Bağlantı (QR) paylaşımı durdurma niyetleri: kullanıcının "Paylaşımı durdur" kararı sunucu onaylayana
 * kadar KALICIDIR. Faz 1 `stopIntents.ts` ile aynı ilke, ayrı anahtar ve ayrı callable (`link_share_stop`):
 *
 *  1. Bellekte kesme anahtarı: `addLinkStop` SENKRON olarak bağlantıyı engeller; konum hattı ve
 *     bağlantı yayıncısı her yazmadan hemen önce `isLinkBlocked` ile bakar.
 *  2. AsyncStorage kopyası: başsız (arka plan) bağlam ve yeniden açılış aynı niyetleri görür;
 *     `link_share_stop` AYNI op_id ile yeniden denenir (sunucu tekilleştirir).
 *
 * Niyet şu durumlarda kalkar: `link_share_stop` başarılı olur ya da sunucu anlık görüntüsü
 * (`link_shares`, sender_id == ben) bağlantının bittiğini / süresinin dolduğunu gösterir
 * (niyetteki sürümden eski olmayan belgeyle). Niyet konum ya da token içermez.
 */
import { isExpired, type EpochMs, type LinkId, type LinkShareView, type UserId } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

const LINK_STOPS_KEY = 'konum.bg.linkstops.v1';

export interface LinkStopIntent {
  link_id: LinkId;
  op_id: string;
  /** Durdurma anındaki belge sürümü (eski anlık görüntü niyeti kaldıramasın). */
  version: number;
  /** Sunucu saati. */
  requested_at: EpochMs;
}

const IntentSchema = z.object({
  link_id: z.string().min(1),
  op_id: z.string().min(1),
  version: z.number(),
  requested_at: z.number(),
});
const StoredSchema = z.object({ uid: z.string().nullable(), intents: z.array(IntentSchema) });

let owner: UserId | null = null;
let intents = new Map<LinkId, LinkStopIntent>();
let hydration: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function persist(): Promise<void> {
  const snapshot = JSON.stringify({ uid: owner, intents: [...intents.values()] });
  const run = writes.then(() => AsyncStorage.setItem(LINK_STOPS_KEY, snapshot));
  writes = run.catch(() => undefined);
  return run;
}

/** Diskteki niyetleri belleğe katar (bir kez). Bellekteki bilgi kazanır. */
export function hydrateLinkStops(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      try {
        const raw = await AsyncStorage.getItem(LINK_STOPS_KEY);
        const parsed = raw ? StoredSchema.safeParse(JSON.parse(raw)) : null;
        if (parsed?.success) {
          if (owner === null) owner = parsed.data.uid;
          if (parsed.data.uid === owner || parsed.data.uid === null) {
            for (const i of parsed.data.intents) if (!intents.has(i.link_id)) intents.set(i.link_id, i);
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

/** Oturum açılınca niyetleri bu hesaba bağlar; başka hesabın niyetleri atılır. */
export async function bindLinkStopsOwner(uid: UserId): Promise<LinkStopIntent[]> {
  await hydrateLinkStops();
  if (owner !== null && owner !== uid) intents = new Map();
  if (owner !== uid) {
    owner = uid;
    await persist().catch(() => undefined);
    notify();
  }
  return listLinkStops();
}

export function listLinkStops(): LinkStopIntent[] {
  return [...intents.values()];
}

export function getLinkStop(linkId: LinkId): LinkStopIntent | undefined {
  return intents.get(linkId);
}

/** Kesme anahtarı: bu bağlantıya şu an konum yazılabilir mi? (bellekte, senkron) */
export function isLinkBlocked(linkId: LinkId): boolean {
  return intents.has(linkId);
}

/** Bellek ANINDA güncellenir (yayın bu satırda kesilir); dönen söz diske yazmadır. Var olan op_id korunur. */
export function addLinkStop(intent: LinkStopIntent): Promise<void> {
  const prev = intents.get(intent.link_id);
  intents.set(intent.link_id, prev ? { ...prev, version: Math.max(prev.version, intent.version) } : intent);
  notify();
  return persist();
}

export function removeLinkStop(linkId: LinkId): Promise<void> {
  if (!intents.delete(linkId)) return Promise.resolve();
  notify();
  return persist();
}

/**
 * Sunucu anlık görüntüsüyle uzlaştırır; kapanan niyetlerin bağlantı kimliklerini döndürür.
 * Belge yok / niyetten eski sürüm / hâlâ aktif → çözülmedi (durdurma yeniden denenir).
 */
export function reconcileLinkStops(views: readonly Pick<LinkShareView, 'link_id' | 'status' | 'expires_at' | 'version'>[], now: EpochMs): LinkId[] {
  if (intents.size === 0) return [];
  const byId = new Map(views.map((v) => [v.link_id, v] as const));
  const closed: LinkId[] = [];
  for (const [id, i] of intents) {
    const v = byId.get(id);
    if (!v || v.version < i.version) continue;
    if (v.status === 'ended' || isExpired(v, now)) {
      intents.delete(id);
      closed.push(id);
    }
  }
  if (closed.length) {
    notify();
    void persist().catch(() => undefined);
  }
  return closed;
}

export function onLinkStopsChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Testler: süreç yeniden başlamış gibi belleği boşaltır (disk korunur). */
export function __resetLinkStopsMemoryForTests(): void {
  owner = null;
  intents = new Map();
  hydration = null;
  writes = Promise.resolve();
}
