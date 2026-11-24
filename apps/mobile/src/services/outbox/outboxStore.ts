/**
 * Faz 3: çevrimdışı kuyruğun kalıcı deposu.
 *
 *  - Native: expo-sqlite (`sqliteOutboxStore.ts`), backgroundTask.ts uygulama yüklenirken `registerOutboxStore`
 *    ile kaydeder. Kuyruk 2000 noktaya kadar büyüyebilir; her eklemede tüm listeyi yeniden yazmamak için
 *    depo FARK uygular (silinen/eklenen satırlar).
 *  - Yedek: AsyncStorage (tek JSON). Web demo ve jest bunu kullanır; native'de SQLite açılamazsa da.
 *
 * Kuyrukta yalnızca gönderenin KENDİ konum noktaları ve hedef kimlikleri vardır (arkadaş konumu, telefon yok).
 * Paylaşım bitince / "Durdur"da / çıkışta silinir (outboxRepo). iOS yedeğine dahil olabilir [Varsayım: SQLite
 * dosyası Application Support altında; `NSURLIsExcludedFromBackupKey` Faz 3.1'de].
 */
import { emptyOutbox, type EpochMs, type OutboxPoint, type OutboxState, type UserId } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Bağlantı gelince yapılacak bekleyen callable (ör. `battery_low_notify`); aynı op_id ile yeniden denenir. */
export interface PendingCall {
  op_id: string;
  name: string;
  payload: Record<string, unknown>;
  created_at: EpochMs;
  attempts: number;
}

export interface OutboxMeta {
  /** Kuyruğun sahibi: başka hesap girerse kuyruk silinir. */
  uid: UserId | null;
  /** Ardışık başarısız boşaltma sayısı (geri çekilme). */
  attempt: number;
  nextAttemptAt: EpochMs | null;
  /** Toplam eşitlenen nokta (teşhis). */
  synced: number;
  calls: PendingCall[];
}

export interface PersistedOutbox {
  state: OutboxState;
  meta: OutboxMeta;
}

export const emptyMeta = (): OutboxMeta => ({ uid: null, attempt: 0, nextAttemptAt: null, synced: 0, calls: [] });
export const emptyPersisted = (): PersistedOutbox => ({ state: emptyOutbox(), meta: emptyMeta() });

export interface OutboxStore {
  load: () => Promise<PersistedOutbox>;
  /** `prev` = depodaki hal (load sonucu), `next` = yazılacak hal. */
  save: (prev: PersistedOutbox, next: PersistedOutbox) => Promise<void>;
  /** Kuyruktaki nokta sayısı (her örnekte tüm kuyruğu okumamak için). */
  count: () => Promise<number>;
  clear: () => Promise<void>;
}

/** Nokta farkı: silinecek kimlikler ve eklenecek/değişen noktalar. */
export function diffPoints(prev: readonly OutboxPoint[], next: readonly OutboxPoint[]): { removed: string[]; upserted: OutboxPoint[] } {
  const prevById = new Map(prev.map((p) => [p.id, p] as const));
  const nextIds = new Set(next.map((p) => p.id));
  const removed = prev.filter((p) => !nextIds.has(p.id)).map((p) => p.id);
  const upserted = next.filter((p) => prevById.get(p.id) !== p);
  return { removed, upserted };
}

// --- AsyncStorage yedeği -------------------------------------------------------------------------

const KEY = 'konum.bg.outbox.v1';

function isPersisted(v: unknown): v is PersistedOutbox {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<PersistedOutbox>;
  return !!o.state && Array.isArray(o.state.points) && !!o.meta && Array.isArray(o.meta.calls);
}

export const asyncStorageOutboxStore: OutboxStore = {
  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const v: unknown = raw ? JSON.parse(raw) : null;
      return isPersisted(v) ? { state: { ...emptyOutbox(), ...v.state }, meta: { ...emptyMeta(), ...v.meta } } : emptyPersisted();
    } catch {
      return emptyPersisted();
    }
  },
  save: async (_prev, next) => {
    if (next.state.points.length === 0 && next.meta.calls.length === 0 && next.meta.uid === null) {
      await AsyncStorage.removeItem(KEY);
      return;
    }
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  },
  count: async () => (await asyncStorageOutboxStore.load()).state.points.length,
  clear: () => AsyncStorage.removeItem(KEY),
};

// --- kayıt ---------------------------------------------------------------------------------------

let registered: OutboxStore | null = null;

/** Native giriş (backgroundTask.ts) SQLite deposunu kaydeder; kayıt yoksa AsyncStorage yedeği. */
export function registerOutboxStore(store: OutboxStore | null): void {
  registered = store;
}

export function getOutboxStore(): OutboxStore {
  return registered ?? asyncStorageOutboxStore;
}
