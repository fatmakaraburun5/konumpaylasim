/**
 * Faz 10: Ortak Takvim — kesinleşen etkinliği tek dokunuşla telefon takvimine ekleme (core `calendar.ts`).
 *
 *  - İlk eklemede uygulama içi resmi onay sayfası (ne yazılacak, takvimin okunmayacağı) → onaylanınca sistem izni
 *    (iOS: yalnızca ekleme; Android: okuma + yazma). İzin zaten varsa doğrudan yazılır.
 *  - İzin reddedildiyse: sistemin "Etkinlik ekle" formu (izinsiz) + "Ayarları aç".
 *  - Eşleme (etkinlik → takvim kaydı kimliği + parmak izi) yalnızca BU cihazda (`konum.f10.calendar.v1:{uid}`);
 *    sunucuya gitmez. Etkinlik değişirse / iptal edilirse tam erişimde kayıt güncellenir / silinir, yalnızca ekleme
 *    izninde kullanıcıya "güncelle" önerilir.
 */
import {
  CALENDAR_STORAGE_KEY,
  calendarAddStep,
  calendarCanUpdate,
  calendarEntryFromEvent,
  calendarSyncAction,
  googleCalendarUrl,
  type CalendarLink,
  type CalendarPermState,
  type CalendarSyncAction,
  type EventDoc,
  type UserId,
} from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { now as serverNow } from '../lib/clock';
import {
  CALENDAR_PLATFORM,
  deleteCalendarEvent,
  getCalendarPermission,
  openCalendarForm,
  requestCalendarPermission,
  writeCalendarEvent,
} from '../services/calendar/calendarProvider';

export type CalendarSheet = { kind: 'consent'; event_id: string } | { kind: 'denied'; event_id: string; canAskAgain: boolean } | null;

export interface CalendarState {
  uid: UserId | null;
  links: Record<string, CalendarLink>;
  perm: CalendarPermState;
  sheet: CalendarSheet;
  busy: string | null;
  message: string | null;
  hydrate: (uid: UserId) => Promise<void>;
  refreshPerm: () => Promise<CalendarPermState>;
  /** "Takvime Ekle" dokunuşu. */
  add: (doc: EventDoc, me: UserId) => Promise<void>;
  /** Onay sayfası: "Onaylıyorum, takvime ekle". */
  acceptConsent: (doc: EventDoc, me: UserId) => Promise<void>;
  /** İzinsiz yol: sistem formu. */
  openForm: (doc: EventDoc, me: UserId) => Promise<void>;
  openGoogle: (doc: EventDoc, me: UserId) => Promise<void>;
  /** Etkinlik değişti / iptal: tam erişimde güncelle / sil; değilse öneri. */
  sync: (doc: EventDoc, me: UserId) => Promise<CalendarSyncAction>;
  closeSheet: () => void;
  clearMessage: () => void;
  reset: () => Promise<void>;
}

const keyOf = (uid: UserId) => `${CALENDAR_STORAGE_KEY}:${uid}`;

export const calendarStore = createStore<CalendarState>()((set, get) => {
  const persist = async () => {
    const uid = get().uid;
    if (uid) await AsyncStorage.setItem(keyOf(uid), JSON.stringify(get().links)).catch(() => undefined);
  };
  const entryOf = (doc: EventDoc, me: UserId) => calendarEntryFromEvent(doc, me, serverNow());

  async function write(doc: EventDoc, me: UserId): Promise<void> {
    const r = entryOf(doc, me);
    if (!r.ok) return;
    const prev = get().links[doc.event_id];
    set({ busy: doc.event_id });
    try {
      const w = await writeCalendarEvent(r.entry, prev && calendarCanUpdate(get().perm) ? prev.native_id : null);
      set({
        links: { ...get().links, [doc.event_id]: { event_id: doc.event_id, native_id: w.native_id, calendar_id: w.calendar_id, fingerprint: r.entry.fingerprint, method: 'native', added_at: serverNow() } },
        message: `“${r.entry.title}” takvime eklendi`,
        sheet: null,
      });
      await persist();
    } catch {
      // Yazılabilir takvim yok / hata: sistem formu yedeği.
      set({ sheet: { kind: 'denied', event_id: doc.event_id, canAskAgain: false } });
    } finally {
      set({ busy: null });
    }
  }

  return {
    uid: null,
    links: {},
    perm: 'undetermined',
    sheet: null,
    busy: null,
    message: null,

    hydrate: async (uid) => {
      if (get().uid === uid) return;
      let links: Record<string, CalendarLink> = {};
      try {
        const raw = await AsyncStorage.getItem(keyOf(uid));
        const v = raw ? (JSON.parse(raw) as Record<string, CalendarLink>) : {};
        if (v && typeof v === 'object') links = v;
      } catch {
        // bozuk kayıt: boş
      }
      set({ uid, links });
      void get().refreshPerm();
    },

    refreshPerm: async () => {
      const p = await getCalendarPermission();
      set({ perm: p.state });
      return p.state;
    },

    add: async (doc, me) => {
      if (get().busy) return;
      const state = await get().refreshPerm();
      const step = calendarAddStep(CALENDAR_PLATFORM, state, false);
      if (step === 'consent') set({ sheet: { kind: 'consent', event_id: doc.event_id } });
      else if (step === 'write') await write(doc, me);
      else if (step === 'system_form') {
        const p = await getCalendarPermission();
        set({ sheet: { kind: 'denied', event_id: doc.event_id, canAskAgain: p.canAskAgain } });
      } else await get().openGoogle(doc, me);
    },

    acceptConsent: async (doc, me) => {
      set({ busy: doc.event_id });
      const p = await requestCalendarPermission();
      set({ perm: p.state, busy: null });
      const step = calendarAddStep(CALENDAR_PLATFORM, p.state, true);
      if (step === 'write' && p.state !== 'undetermined') await write(doc, me);
      else set({ sheet: { kind: 'denied', event_id: doc.event_id, canAskAgain: p.canAskAgain } });
    },

    openForm: async (doc, me) => {
      const r = entryOf(doc, me);
      if (!r.ok) return;
      set({ sheet: null, busy: doc.event_id });
      try {
        const w = await openCalendarForm(r.entry);
        if (w.saved) {
          set({
            links: { ...get().links, [doc.event_id]: { event_id: doc.event_id, native_id: w.native_id, calendar_id: w.calendar_id, fingerprint: r.entry.fingerprint, method: 'system_form', added_at: serverNow() } },
            message: `“${r.entry.title}” takvime eklendi`,
          });
          await persist();
        }
      } catch {
        await get().openGoogle(doc, me);
      } finally {
        set({ busy: null });
      }
    },

    openGoogle: async (doc, me) => {
      const r = entryOf(doc, me);
      if (!r.ok) return;
      set({ sheet: null });
      await Linking.openURL(googleCalendarUrl(r.entry)).catch(() => undefined);
    },

    sync: async (doc, me) => {
      const link = get().links[doc.event_id] ?? null;
      const action = calendarSyncAction(link, entryOf(doc, me), get().perm, doc.stage);
      if (!link) return action;
      if (action === 'update') await write(doc, me);
      else if (action === 'remove') {
        if (link.native_id) await deleteCalendarEvent(link.native_id);
        const { [doc.event_id]: _gone, ...rest } = get().links;
        set({ links: rest });
        await persist();
      }
      return action;
    },

    closeSheet: () => set({ sheet: null }),
    clearMessage: () => set({ message: null }),
    reset: async () => set({ uid: null, links: {}, sheet: null, busy: null, message: null }),
  };
});

export function useCalendarStore<T>(selector: (s: CalendarState) => T): T {
  return useStore(calendarStore, selector);
}
