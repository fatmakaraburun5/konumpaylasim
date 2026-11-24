/**
 * Faz 3: izin akışının cihaz düzeyindeki hafızası (AsyncStorage). Konum ya da kişisel veri İÇERMEZ.
 *
 *  - `hasSeenRationale.always`: "Uzun paylaşım için arka plan konumu" açıklaması görüldü ve "Devam" dendi.
 *  - `lastDeniedAt[kind]`: kullanıcının reddettiği / "Şimdi değil" dediği an → core 7 gün bekler
 *    (`PERMISSION_REASK_COOLDOWN_MS`), kullanıcı sıkılmaz.
 *  - `wentBackgroundDuringShare` (yalnızca bellekte): paylaşım sürerken uygulama arka plana gitti → bir sonraki
 *    ön plana gelişte "Her zaman" yükseltmesi engellemeyen şeritte önerilir.
 */
import type { EpochMs, PermissionKind } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

const KEY = 'konum.ui.permissionFlow.v2';

export interface PermissionMemory {
  hasSeenRationale: { always?: boolean };
  lastDeniedAt: Partial<Record<PermissionKind, EpochMs | null>>;
}

interface PermissionFlowState extends PermissionMemory {
  hydrated: boolean;
  wentBackgroundDuringShare: boolean;
  hydrate: () => Promise<void>;
  markRationaleSeen: () => void;
  markDenied: (kind: PermissionKind, at: EpochMs) => void;
  clearDenied: (kind: PermissionKind) => void;
  setWentBackground: (v: boolean) => void;
}

const persist = (m: PermissionMemory) =>
  AsyncStorage.setItem(KEY, JSON.stringify({ hasSeenRationale: m.hasSeenRationale, lastDeniedAt: m.lastDeniedAt })).catch(() => undefined);

export const permissionFlowStore = createStore<PermissionFlowState>()((set, get) => ({
  hydrated: false,
  hasSeenRationale: {},
  lastDeniedAt: {},
  wentBackgroundDuringShare: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const v = raw ? (JSON.parse(raw) as Partial<PermissionMemory>) : {};
      set({
        hydrated: true,
        hasSeenRationale: typeof v.hasSeenRationale === 'object' && v.hasSeenRationale ? v.hasSeenRationale : {},
        lastDeniedAt: typeof v.lastDeniedAt === 'object' && v.lastDeniedAt ? v.lastDeniedAt : {},
      });
    } catch {
      set({ hydrated: true });
    }
  },
  markRationaleSeen: () => {
    set((s) => ({ hasSeenRationale: { ...s.hasSeenRationale, always: true } }));
    void persist(get());
  },
  markDenied: (kind, at) => {
    set((s) => ({ lastDeniedAt: { ...s.lastDeniedAt, [kind]: at } }));
    void persist(get());
  },
  clearDenied: (kind) => {
    if (get().lastDeniedAt[kind] == null) return;
    set((s) => ({ lastDeniedAt: { ...s.lastDeniedAt, [kind]: null } }));
    void persist(get());
  },
  setWentBackground: (v) => (get().wentBackgroundDuringShare === v ? undefined : set({ wentBackgroundDuringShare: v })),
}));

export function usePermissionFlowStore<T>(selector: (s: PermissionFlowState) => T): T {
  return useStore(permissionFlowStore, selector);
}
