/**
 * Faz 7: Etkinlik Alanı durumu (core `events.ts` durum makinesi sunucuda çalışır; istemci yalnızca okur ve komut gönderir).
 *
 *  - `events`: Firestore `events` dinleyicisi (`member_ids array-contains ben`) + callable yanıtları. Aynı etkinliğin
 *    iki kaynağından YÜKSEK `version` kazanır (yanıt dinleyiciden önce gelirse ekran beklemeden güncellenir).
 *  - `notices`: uygulama içi bildirim kutusu (`users/{ben}/notices`); okunmamış = son görülme anından yeni olanlar.
 *    Son görülme anı cihazda, hesaba göre saklanır.
 *  - Komutlar (`create`, `rsvp`, `vote` …): `Result` döner; hata core Türkçe mesajıyla gelir. `event_vote_tie`
 *    yanıtındaki `leaders` (eşit oy alan seçenekler) sahibin kazananı seçmesi için `extra` ile döner.
 *  - `focus`: bildirime dokunma / derin bağlantı ile açılacak etkinlik (f7Services → `/events/{id}`).
 */
import {
  type AttendanceStatus,
  type EpochMs,
  type EventAdvanceAction,
  type EventCreateRequest,
  type EventDoc,
  type EventNotice,
  type EventVenueInputSchema,
  type RsvpRound,
  type SharingError,
  type UserId,
  type VoteKind,
  unreadNoticeCount,
} from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { z } from 'zod';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { toKonumError } from '../lib/errors';
import { eventsApi, type EventsApi } from '../services/firebase/callables';

export const NOTICES_SEEN_KEY = 'konum.f7.noticesSeen.v1';
/** Yanıtla eklenen ama dinleyicide henüz görünmeyen etkinlik bu kadar süre korunur. */
const LOCAL_GRACE_MS = 15_000;

export type EventResult<T = {}> = ({ ok: true } & T) | { ok: false; error: SharingError; extra: Readonly<Record<string, unknown>> };

export type EventVenueInput = z.input<typeof EventVenueInputSchema>;

export interface EventsState {
  uid: UserId | null;
  events: Record<string, EventDoc>;
  loaded: boolean;
  notices: EventNotice[];
  noticesLoaded: boolean;
  lastSeenNoticeAt: EpochMs | null;
  focusId: string | null;
  /** Çalışan komut (aynı etkinlikte çift dokunma engellenir). */
  busy: Record<string, boolean>;

  setEvents(uid: UserId, list: readonly EventDoc[]): void;
  setNotices(uid: UserId, list: readonly EventNotice[]): void;
  applyDoc(doc: EventDoc): void;
  hydrateSeen(uid: UserId): Promise<void>;
  markNoticesSeen(at?: EpochMs): void;
  focus(eventId: string | null): void;
  reset(): void;

  create(input: Omit<EventCreateRequest, 'op_id'>): Promise<EventResult<{ event: EventDoc; skipped: number }>>;
  rsvp(eventId: string, round: RsvpRound, status: AttendanceStatus, note?: string | null): Promise<EventResult>;
  proposeVenue(eventId: string, venue: EventVenueInput): Promise<EventResult>;
  removeVenue(eventId: string, optionId: string): Promise<EventResult>;
  vote(eventId: string, kind: VoteKind, optionId: string): Promise<EventResult>;
  advance(eventId: string, action: EventAdvanceAction, opts?: { tieBreak?: string | null; voteWindowMs?: number | null }): Promise<EventResult>;
  setTimes(eventId: string, minutes: number[]): Promise<EventResult>;
  update(eventId: string, patch: { title?: string; description?: string | null; date?: string }): Promise<EventResult>;
  inviteAdd(eventId: string, inviteeIds: UserId[]): Promise<EventResult<{ skipped: number }>>;
  cancel(eventId: string): Promise<EventResult>;
}

export interface EventsStoreDeps {
  api: EventsApi;
  /** Cihaz saati (yalnızca yerel koruma süresi için). */
  now: () => EpochMs;
}

const fail = (e: unknown): { ok: false; error: SharingError; extra: Readonly<Record<string, unknown>> } => {
  const err = toKonumError(e);
  return { ok: false, error: err.toSharingError(), extra: err.extra };
};

export function createEventsStore(deps: EventsStoreDeps = { api: eventsApi, now: () => Date.now() }): StoreApi<EventsState> {
  /** Yanıtla eklenen etkinliklerin yerel ekleme anı (dinleyici yetişene kadar silinmesin). */
  const localAt = new Map<string, EpochMs>();

  return createStore<EventsState>()((set, get) => {
    const run = async <T extends object>(eventId: string, fn: () => Promise<{ event: EventDoc } & T>): Promise<EventResult<T>> => {
      if (get().busy[eventId]) return { ok: false, error: { code: 'rate_limited', message: 'İşlem sürüyor' }, extra: {} };
      set((s) => ({ busy: { ...s.busy, [eventId]: true } }));
      try {
        const res = await fn();
        get().applyDoc(res.event);
        const { event: _e, ...rest } = res;
        return { ok: true, ...(rest as unknown as T) };
      } catch (e) {
        return fail(e);
      } finally {
        set((s) => {
          const busy = { ...s.busy };
          delete busy[eventId];
          return { busy };
        });
      }
    };

    return {
      uid: null,
      events: {},
      loaded: false,
      notices: [],
      noticesLoaded: false,
      lastSeenNoticeAt: null,
      focusId: null,
      busy: {},

      setEvents: (uid, list) =>
        set((s) => {
          if (s.uid !== null && s.uid !== uid) return {};
          const next: Record<string, EventDoc> = {};
          const t = deps.now();
          for (const d of list) {
            const cur = s.events[d.event_id];
            next[d.event_id] = cur && cur.version > d.version ? cur : d;
            localAt.delete(d.event_id);
          }
          // Yanıtla gelmiş, dinleyiciye henüz düşmemiş etkinlikler kısa süre korunur.
          for (const [id, at] of localAt) {
            const cur = s.events[id];
            if (cur && !next[id] && t - at < LOCAL_GRACE_MS) next[id] = cur;
            else if (t - at >= LOCAL_GRACE_MS) localAt.delete(id);
          }
          return { uid, events: next, loaded: true };
        }),

      setNotices: (uid, list) =>
        set((s) => (s.uid !== null && s.uid !== uid ? {} : { uid, notices: [...list].sort((a, b) => b.created_at - a.created_at), noticesLoaded: true })),

      applyDoc: (doc) =>
        set((s) => {
          const cur = s.events[doc.event_id];
          if (cur && cur.version >= doc.version) return {};
          if (!cur) localAt.set(doc.event_id, deps.now());
          return { events: { ...s.events, [doc.event_id]: doc } };
        }),

      hydrateSeen: async (uid) => {
        try {
          const raw = await AsyncStorage.getItem(NOTICES_SEEN_KEY);
          const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          const v = map[uid];
          set({ uid, lastSeenNoticeAt: typeof v === 'number' ? v : null });
        } catch {
          set({ uid });
        }
      },

      markNoticesSeen: (at) => {
        const s = get();
        const latest = at ?? s.notices[0]?.created_at ?? null;
        if (latest === null || (s.lastSeenNoticeAt !== null && latest <= s.lastSeenNoticeAt)) return;
        set({ lastSeenNoticeAt: latest });
        const uid = s.uid;
        if (!uid) return;
        void (async () => {
          try {
            const raw = await AsyncStorage.getItem(NOTICES_SEEN_KEY);
            const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
            map[uid] = latest;
            await AsyncStorage.setItem(NOTICES_SEEN_KEY, JSON.stringify(map));
          } catch {
            // bellek değeri bu çalıştırma için yeterli
          }
        })();
      },

      focus: (eventId) => set({ focusId: eventId }),

      reset: () => {
        localAt.clear();
        set({ uid: null, events: {}, loaded: false, notices: [], noticesLoaded: false, lastSeenNoticeAt: null, focusId: null, busy: {} });
      },

      create: async (input) => {
        try {
          const res = await deps.api.eventCreate(input);
          get().applyDoc(res.event);
          return { ok: true, event: res.event, skipped: res.skipped_count };
        } catch (e) {
          return fail(e);
        }
      },
      rsvp: (eventId, round, status, note = null) => run(eventId, () => deps.api.eventRsvp({ event_id: eventId, round, status, note: status === 'not_going' ? note : null })),
      proposeVenue: (eventId, venue) => run(eventId, () => deps.api.eventVenuePropose({ event_id: eventId, venue })),
      removeVenue: (eventId, optionId) => run(eventId, () => deps.api.eventVenueRemove({ event_id: eventId, option_id: optionId })),
      vote: (eventId, kind, optionId) => run(eventId, () => deps.api.eventVote({ event_id: eventId, kind, option_id: optionId })),
      advance: (eventId, action, opts = {}) =>
        run(eventId, () =>
          deps.api.eventAdvance({ event_id: eventId, action, tie_break_option_id: opts.tieBreak ?? null, vote_window_ms: opts.voteWindowMs ?? null }),
        ),
      setTimes: (eventId, minutes) => run(eventId, () => deps.api.eventTimeOptionsSet({ event_id: eventId, minutes })),
      update: (eventId, patch) => run(eventId, () => deps.api.eventUpdate({ event_id: eventId, ...patch })),
      inviteAdd: (eventId, inviteeIds) =>
        run(eventId, async () => {
          const r = await deps.api.eventInviteAdd({ event_id: eventId, invitee_ids: inviteeIds });
          return { event: r.event, skipped: r.skipped_count };
        }),
      cancel: (eventId) => run(eventId, () => deps.api.eventCancel({ event_id: eventId })),
    };
  });
}

export const eventsStore = createEventsStore();

export function useEventsStore<T>(selector: (s: EventsState) => T): T {
  return useStore(eventsStore, selector);
}

export const selectUnreadNotices = (s: Pick<EventsState, 'notices' | 'lastSeenNoticeAt'>): number => unreadNoticeCount(s.notices, s.lastSeenNoticeAt);
