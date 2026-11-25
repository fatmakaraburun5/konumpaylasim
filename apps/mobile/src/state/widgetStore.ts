/**
 * Faz 6: widget eşitleme durumu ve cihaz ayarları.
 *
 * Kalıcı (AsyncStorage `konum.widget.meta.v1`, token'ın KENDİSİ değil):
 *  - `lockScreenDetails`: "Kilit ekranında ayrıntı göster" (varsayılan KAPALI → kilit ekranı yalnızca ad + durum +
 *    zaman; yer ve pil gizli). Çıkışta varsayılana döner.
 *  - `token`: widget token'ının sahibi ve bitişi (yenileme kararı için). Token yerel güvenli depodadır
 *    (iOS paylaşılan anahtarlık / Android şifreli tercih, `setQuickShareCredential`).
 *  - `avatarFiles`: favori → paylaşılan alana yazılan avatar dosyası (sürüm anahtarıyla; açılışta yeniden
 *    indirilmesin, widget baş harflere düşüp geri gelmesin).
 * Bellekte: son yazılan snapshot (profil ekranı "Widget durumu" ve web demo önizlemesi okur), son eşitleme anı.
 */
import type { EpochMs, UserId, WidgetSnapshot } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

const KEY = 'konum.widget.meta.v1';

export interface WidgetAvatarFile {
  /** Fotoğraf sürüm anahtarı (`avatarRecyclingKey`). */
  key: string;
  /** Paylaşılan alandaki dosya adı (`saveAvatar` dönüşü). */
  file: string;
}

export interface WidgetTokenMeta {
  owner: UserId;
  expires_at: EpochMs;
}

interface Persisted {
  lock_screen_details: boolean;
  token: WidgetTokenMeta | null;
  avatar_files: Record<UserId, WidgetAvatarFile>;
}

export interface WidgetState {
  hydrated: boolean;
  lockScreenDetails: boolean;
  token: WidgetTokenMeta | null;
  avatarFiles: Record<UserId, WidgetAvatarFile>;
  lastSnapshot: WidgetSnapshot | null;
  lastWriteAt: EpochMs | null;
  /** Son token hatası (profil ekranında kısa metin). */
  tokenError: string | null;
  hydrate: () => Promise<void>;
  setLockScreenDetails: (v: boolean) => void;
  setToken: (t: WidgetTokenMeta | null) => void;
  setTokenError: (e: string | null) => void;
  setAvatarFile: (uid: UserId, f: WidgetAvatarFile | null) => void;
  setWritten: (snap: WidgetSnapshot, at: EpochMs) => void;
  reset: () => Promise<void>;
}

const EMPTY: Persisted = { lock_screen_details: false, token: null, avatar_files: {} };

function sanitize(raw: unknown): Persisted {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const o = raw as Record<string, unknown>;
  const t = o.token as Record<string, unknown> | null | undefined;
  const token =
    t && typeof t.owner === 'string' && typeof t.expires_at === 'number' && Number.isFinite(t.expires_at) ? { owner: t.owner, expires_at: t.expires_at } : null;
  const files: Record<UserId, WidgetAvatarFile> = {};
  if (o.avatar_files && typeof o.avatar_files === 'object') {
    for (const [uid, v] of Object.entries(o.avatar_files as Record<string, unknown>)) {
      const f = v as Record<string, unknown> | null;
      if (f && typeof f.key === 'string' && typeof f.file === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(f.file)) files[uid] = { key: f.key, file: f.file };
    }
  }
  return { lock_screen_details: o.lock_screen_details === true, token, avatar_files: files };
}

export const widgetStore = createStore<WidgetState>()((set, get) => {
  const persist = () => {
    const s = get();
    const v: Persisted = { lock_screen_details: s.lockScreenDetails, token: s.token, avatar_files: s.avatarFiles };
    void AsyncStorage.setItem(KEY, JSON.stringify(v)).catch(() => undefined);
  };
  let hydrating: Promise<void> | null = null;
  return {
    hydrated: false,
    lockScreenDetails: false,
    token: null,
    avatarFiles: {},
    lastSnapshot: null,
    lastWriteAt: null,
    tokenError: null,

    hydrate: () => {
      if (get().hydrated) return Promise.resolve();
      if (!hydrating) {
        hydrating = (async () => {
          let p = EMPTY;
          try {
            const raw = await AsyncStorage.getItem(KEY);
            p = sanitize(raw ? JSON.parse(raw) : null);
          } catch {
            p = EMPTY;
          }
          set({ hydrated: true, lockScreenDetails: p.lock_screen_details, token: p.token, avatarFiles: p.avatar_files });
        })().finally(() => (hydrating = null));
      }
      return hydrating;
    },

    setLockScreenDetails: (v) => {
      set({ lockScreenDetails: v });
      persist();
    },

    setToken: (t) => {
      set({ token: t, tokenError: null });
      persist();
    },

    setTokenError: (e) => set({ tokenError: e }),

    setAvatarFile: (uid, f) => {
      const next = { ...get().avatarFiles };
      if (f) next[uid] = f;
      else delete next[uid];
      set({ avatarFiles: next });
      persist();
    },

    setWritten: (snap, at) => set({ lastSnapshot: snap, lastWriteAt: at }),

    reset: async () => {
      set({ lockScreenDetails: false, token: null, avatarFiles: {}, lastSnapshot: null, lastWriteAt: null, tokenError: null });
      await AsyncStorage.removeItem(KEY).catch(() => undefined);
    },
  };
});

export function useWidgetStore<T>(selector: (s: WidgetState) => T): T {
  return useStore(widgetStore, selector);
}
