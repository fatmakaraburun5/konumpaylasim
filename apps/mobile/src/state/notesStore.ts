/**
 * Faz 4: konum yanına kısa not / etiket (core `notes.ts`).
 *
 *  - Durum notu (`myStatus`, "☕ Kahve molasındayım"): sunucuda belge YOK. Cihazda kalıcıdır (persist.ts,
 *    `konum.bg.statusNote.v1`; arka plan konum görevi de okur) ve arkadaş paketlerine `note` + `note_exp` olarak
 *    eklenir (pipeline → core `statusNoteExtras`). Not değişince koordinatör canlı hedef varsa HEMEN bir paket
 *    yayınlar (`onStatusChange`). Bağlantı (QR) izleyicilerine not gitmez.
 *  - Yer notları (`placeNotes`): Firestore `place_notes` (benim + bana görünür, canlı dinleyici). Yazma yalnızca
 *    `place_note_upsert` / `place_note_delete` callable'larıyla; yanıt gelince liste hemen güncellenir, dinleyici
 *    sonra doğrular. Süresi geçen not okuma tarafında gizlenir (`tick`).
 */
import {
  isNoteActive,
  NOTE_DURATION_MS_VALUES,
  NOTE_LIMITS,
  sanitizeNoteText,
  uuidV4,
  type EpochMs,
  type NotePosition,
  type PlaceNote,
  type StatusNote,
  type UserId,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { notesApi, type NotesApi } from '../services/firebase/callables';
import { authStore } from './authStore';
import { loadStatusNote, saveStatusNote, type PersistedStatusNote } from './persist';
import type { Result } from './pingStore';

export interface NotesState {
  /** Yerelde kalıcı durum notum. */
  myStatus: StatusNote | null;
  /** Canlı hedef varsa hemen bir paket yayınlanır (koordinatör). */
  setMyStatus(input: { emoji: string | null; text: string; duration_ms: number }): void;
  clearMyStatus(): void;
  /** Benim + bana görünür yer notları (canlı dinleyici). */
  placeNotes: Record<string, PlaceNote>;
  pending: Record<string, 'saving' | 'deleting'>;
  upsertPlace(input: {
    note_id?: string | null;
    emoji: string | null;
    text: string;
    position: NotePosition;
    visible_to: UserId[];
    duration_ms: number;
  }): Promise<Result<{ note: PlaceNote }>>;
  deletePlace(noteId: string): Promise<boolean>;
  // --- veri katmanı (koordinatör) ---
  /** Kalıcı durum notunu diskten yükler (bu hesaba aitse). */
  hydrate(): Promise<void>;
  setPlaceNotes(list: readonly PlaceNote[]): void;
  /** Süresi geçen durum / yer notlarını temizler. */
  tick(): void;
  reset(): void;
}

export interface NotesStoreDeps {
  api: NotesApi;
  now: () => EpochMs;
  myUid: () => UserId | null;
  loadStatus: () => Promise<PersistedStatusNote | null>;
  saveStatus: (v: PersistedStatusNote | null) => Promise<void>;
  newOpId: () => string;
}

/** Yeni (henüz kimliği olmayan) yer notunun `pending` anahtarı. */
export const NEW_NOTE_KEY = 'new';

type StatusListener = (note: StatusNote | null) => void;
const statusListeners = new Set<StatusListener>();

/** Koordinatör: durum notu değişince (eklendi / düzenlendi / silindi) çağrılır. */
export function onStatusChange(l: StatusListener): () => void {
  statusListeners.add(l);
  return () => statusListeners.delete(l);
}

const emptyText = { code: 'invalid_argument' as const, message: 'Not boş olamaz' };

export function createNotesStore(overrides: Partial<NotesStoreDeps> = {}): StoreApi<NotesState> {
  const deps: NotesStoreDeps = {
    api: notesApi,
    now: serverClockNow,
    myUid: () => authStore.getState().uid,
    loadStatus: loadStatusNote,
    saveStatus: saveStatusNote,
    newOpId: uuidV4,
    ...overrides,
  };

  const writeStatus = (note: StatusNote | null) => {
    const uid = deps.myUid();
    void deps.saveStatus(note && uid ? { uid, note } : null).finally(() => {
      for (const l of [...statusListeners]) {
        try {
          l(note);
        } catch {
          // dinleyici hatası depoyu etkilemez
        }
      }
    });
  };

  return createStore<NotesState>()((set, get) => ({
    myStatus: null,
    placeNotes: {},
    pending: {},

    setMyStatus: (input) => {
      const text = sanitizeNoteText(input.text);
      if (!text) {
        get().clearMyStatus();
        return;
      }
      const emoji = input.emoji ? sanitizeNoteText(input.emoji, NOTE_LIMITS.maxEmojiChars) : null;
      const duration = Math.min(NOTE_LIMITS.statusMaxMs, Math.max(60_000, Math.round(input.duration_ms)));
      const note: StatusNote = { emoji, text, expires_at: deps.now() + duration };
      set({ myStatus: note });
      writeStatus(note);
    },

    clearMyStatus: () => {
      if (get().myStatus === null) {
        void deps.saveStatus(null);
        return;
      }
      set({ myStatus: null });
      writeStatus(null);
    },

    upsertPlace: async (input) => {
      const text = sanitizeNoteText(input.text);
      if (!text) return { ok: false, error: emptyText };
      if (!NOTE_DURATION_MS_VALUES.includes(input.duration_ms)) return { ok: false, error: { code: 'invalid_duration', message: 'Süre geçersiz' } };
      const key = input.note_id ?? NEW_NOTE_KEY;
      if (get().pending[key]) return { ok: false, error: { code: 'rate_limited', message: 'Not kaydediliyor…' } };
      const me = deps.myUid();
      const visible = [...new Set(input.visible_to)].filter((u) => u !== me).slice(0, NOTE_LIMITS.maxAudience);
      set((s) => ({ pending: { ...s.pending, [key]: 'saving' } }));
      try {
        const res = await deps.api.placeNoteUpsert({
          op_id: deps.newOpId(),
          note_id: input.note_id ?? null,
          emoji: input.emoji ? sanitizeNoteText(input.emoji, NOTE_LIMITS.maxEmojiChars) : null,
          text,
          position: { lat: input.position.lat, lng: input.position.lng, accuracy: input.position.accuracy === null ? null : Math.min(5_000, Math.max(0, input.position.accuracy)) },
          visible_to: visible,
          duration_ms: input.duration_ms,
        });
        set((s) => ({ placeNotes: { ...s.placeNotes, [res.note.note_id]: res.note } }));
        return { ok: true, note: res.note };
      } catch (e) {
        return { ok: false, error: toKonumError(e).toSharingError() };
      } finally {
        set((s) => {
          const { [key]: _gone, ...rest } = s.pending;
          return { pending: rest };
        });
      }
    },

    deletePlace: async (noteId) => {
      if (get().pending[noteId] === 'deleting') return false;
      set((s) => ({ pending: { ...s.pending, [noteId]: 'deleting' } }));
      try {
        await deps.api.placeNoteDelete({ op_id: deps.newOpId(), note_id: noteId });
        set((s) => {
          const { [noteId]: _gone, ...rest } = s.placeNotes;
          return { placeNotes: rest };
        });
        return true;
      } catch (e) {
        // Not zaten yoksa (başka cihazdan silindi) amaç gerçekleşmiştir.
        if (toKonumError(e).code === 'note_not_found') {
          set((s) => {
            const { [noteId]: _gone, ...rest } = s.placeNotes;
            return { placeNotes: rest };
          });
          return true;
        }
        return false;
      } finally {
        set((s) => {
          const { [noteId]: _gone, ...rest } = s.pending;
          return { pending: rest };
        });
      }
    },

    hydrate: async () => {
      const uid = deps.myUid();
      const p = await deps.loadStatus().catch(() => null);
      if (!p || !uid || p.uid !== uid || p.note.expires_at <= deps.now()) {
        if (p && (!uid || p.uid !== uid)) await deps.saveStatus(null);
        return;
      }
      // Bu arada kullanıcı yeni not yazdıysa disktekini üstüne yazma.
      if (get().myStatus === null) set({ myStatus: p.note });
    },

    setPlaceNotes: (list) => {
      const t = deps.now();
      const placeNotes: Record<string, PlaceNote> = {};
      for (const n of list) if (isNoteActive(n, t)) placeNotes[n.note_id] = n;
      set({ placeNotes });
    },

    tick: () => {
      const t = deps.now();
      const s = get();
      if (s.myStatus && s.myStatus.expires_at <= t) {
        set({ myStatus: null });
        writeStatus(null);
      }
      const gone = Object.values(s.placeNotes).filter((n) => !isNoteActive(n, t));
      if (gone.length === 0) return;
      const placeNotes = { ...get().placeNotes };
      for (const n of gone) delete placeNotes[n.note_id];
      set({ placeNotes });
    },

    reset: () => set({ myStatus: null, placeNotes: {}, pending: {} }),
  }));
}

export const notesStore = createNotesStore();

export function useNotesStore<T>(selector: (s: NotesState) => T): T {
  return useStore(notesStore, selector);
}

/** Haritada gösterilecek yer notları (aktif), en yeni önce. */
export function selectPlaceNotes(s: Pick<NotesState, 'placeNotes'>, now: EpochMs): PlaceNote[] {
  return Object.values(s.placeNotes)
    .filter((n) => isNoteActive(n, now))
    .sort((a, b) => b.updated_at - a.updated_at);
}
