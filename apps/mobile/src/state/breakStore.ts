/**
 * Faz 12: Mola deposu (core `breakMode.ts`). Yalnızca cihazda; sunucu belgesi yok.
 *
 *  start(dk): kayıt anında belleğe + diske (`konum.bg.break.v1`); durum notu "☕ Moladayım" (bitişe kadar) yazılır →
 *             Faz 4 kancası tek paket yayınlar (not alıcıya gider), BREAK_GRACE_MS sonra konum hattı susar.
 *  end():     kayıt silinir; mola notu hâlâ duruyorsa kaldırılır; `onResume` (f12Services: hemen bir paket).
 *  Kendiliğinden biter: süre dolunca (tick), Görünmez Ol, tüm paylaşımlar bitince, yeni paylaşım başlayınca (f12Services).
 */
import { BREAK_NOTE, isOnBreak, MINUTE, startBreak, type BreakMinutes, type BreakState, type EpochMs, type UserId } from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { authStore } from './authStore';
import { notesStore } from './notesStore';
import { loadBreak, saveBreak, type PersistedBreak } from './persist';

export interface BreakStoreState {
  brk: BreakState | null;
  start: (minutes: BreakMinutes) => void;
  end: () => void;
  /** Açılışta diskteki kaydı alır (bu hesabınsa ve sürüyorsa). */
  hydrate: (uid: UserId) => Promise<void>;
  /** Süresi dolduysa bitirir (f12Services her saniye değil, sayaç değişiminde çağırır). */
  tick: () => void;
  reset: () => void;
}

export interface BreakStoreDeps {
  now: () => EpochMs;
  myUid: () => UserId | null;
  save: (v: PersistedBreak | null) => Promise<void>;
  load: () => Promise<PersistedBreak | null>;
  setNote: (minutes: number) => void;
  clearNoteIfOurs: () => void;
  onResume: () => void;
}

let resumeHook: () => void = () => undefined;
/** f12Services: mola bitince hemen bir paket yayınla. */
export function setBreakResumeHook(fn: () => void): void {
  resumeHook = fn;
}

export function createBreakStore(overrides: Partial<BreakStoreDeps> = {}): StoreApi<BreakStoreState> {
  const deps: BreakStoreDeps = {
    now: serverClockNow,
    myUid: () => authStore.getState().uid,
    save: saveBreak,
    load: loadBreak,
    setNote: (minutes) => notesStore.getState().setMyStatus({ emoji: BREAK_NOTE.emoji, text: BREAK_NOTE.text, duration_ms: minutes * MINUTE }),
    clearNoteIfOurs: () => {
      const n = notesStore.getState().myStatus;
      if (n && n.text === BREAK_NOTE.text) notesStore.getState().clearMyStatus();
    },
    onResume: () => resumeHook(),
    ...overrides,
  };
  return createStore<BreakStoreState>()((set, get) => ({
    brk: null,
    start: (minutes) => {
      const uid = deps.myUid();
      if (!uid) return;
      const b = startBreak(deps.now(), minutes);
      set({ brk: b });
      deps.setNote(minutes);
      void deps.save({ uid, ...b }).catch(() => undefined);
    },
    end: () => {
      if (!get().brk) return;
      set({ brk: null });
      void deps.save(null).catch(() => undefined);
      deps.clearNoteIfOurs();
      deps.onResume();
    },
    hydrate: async (uid) => {
      const v = await deps.load().catch(() => null);
      if (v && v.uid === uid && isOnBreak(v, deps.now())) set({ brk: { started_at: v.started_at, until: v.until } });
      else if (v) void deps.save(null).catch(() => undefined);
    },
    tick: () => {
      const b = get().brk;
      if (b && !isOnBreak(b, deps.now())) get().end();
    },
    reset: () => {
      set({ brk: null });
      void deps.save(null).catch(() => undefined);
    },
  }));
}

export const breakStore = createBreakStore();

export function useBreakStore<T>(selector: (s: BreakStoreState) => T): T {
  return useStore(breakStore, selector);
}
