/**
 * Faz 5: harita üzerinde "Buluşma noktası" önerisi (core `meetup.ts`).
 *
 *  - `suggest`: katılımcılar = ben ('me', kendi konumum) + konumu bana GÖRÜNEN arkadaşlar (canlı paylaşım) +
 *    `positionOverrides` ("seçili hedef": katılımcının konumu yerine bu nokta). Konumu görünmeyen arkadaşlar
 *    `missingFriendIds`'e girer (arayüz uyarır) ve isteğe katılmaz. Hesap sunucuda (`meetup_suggest`: Places +
 *    Route Matrix, önbellek, kota, yedek orta nokta); Google anahtarı cihazda YOK.
 *  - Mod varsayılanı: katılımcıların yayılımı (merkeze en uzak) ≤ 2 km ise Yürüyüş, değilse Araç. [Varsayım]
 *  - `share`: seçili öneri → `meetup_share` (alıcılar kabul edilmiş arkadaş; sunucu süzer), `meetups`'a eklenir.
 *  - `meetups`: Firestore `meetups` (gönderdiğim + bana gelen) dinleyicisi; iptal edilen / süresi geçen gizlenir.
 *    Yeni gelen öneri (≤ 2 dk) ya da `meetup` push'una dokunma → `focus` (alıcı kartı).
 */
import {
  isMeetupActive,
  MEETUP_LIMITS,
  meetupCenter,
  meetupSpreadM,
  sanitizeNoteText,
  uuidV4,
  type EpochMs,
  type LatLng,
  type Meetup,
  type MeetupCategory,
  type MeetupParticipant,
  type MeetupSuggestResponse,
  type TravelMode,
  type UserId,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { meetupApi, type MeetupApi } from '../services/firebase/callables';
import { authStore } from './authStore';
import { incomingStore, selectVisibleIncoming } from './incomingStore';
import { locationStore } from './locationStore';
import type { Result } from './pingStore';

export interface MeetupSuggestInput {
  friendIds: UserId[];
  category: MeetupCategory;
  /** Anahtar 'me' ya da uid; varsayılan DRIVE (≤ 2 km yayılımda WALK). [Varsayım] */
  modes?: Partial<Record<string, TravelMode>>;
  /** "Seçili hedef": katılımcının konumu yerine bu nokta. */
  positionOverrides?: Partial<Record<string, LatLng>>;
}

export interface MeetupState {
  input: MeetupSuggestInput | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  result: MeetupSuggestResponse | null;
  selectedIndex: number | null;
  error: string | null;
  /** Konumu görünmeyen (paylaşmayan) arkadaşlar → arayüz uyarır. */
  missingFriendIds: UserId[];
  suggest(input: MeetupSuggestInput): Promise<Result>;
  select(index: number | null): void;
  clear(): void;
  share(input: { suggestionIndex: number; to: UserId[]; meet_at?: EpochMs | null; note?: string | null }): Promise<Result<{ meetup: Meetup }>>;
  /** Gönderdiğim + bana gelen, aktif olanlar (dinleyici). */
  meetups: Record<string, Meetup>;
  /** Push'a dokununca / yeni gelen öneri → kart. */
  focusedMeetupId: string | null;
  focus(id: string | null): void;
  respond(meetupId: string, response: 'accepted' | 'declined'): Promise<boolean>;
  cancel(meetupId: string): Promise<boolean>;
  // --- veri katmanı (f5Services) ---
  applySent(list: readonly Meetup[]): void;
  applyReceived(list: readonly Meetup[]): void;
  /** Süresi geçen / iptal edilen önerileri gizler. */
  tick(): void;
  reset(): void;
}

export interface MeetupStoreDeps {
  api: MeetupApi;
  now: () => EpochMs;
  myUid: () => UserId | null;
  /** Kendi konumum (yoksa null). */
  myPosition: () => LatLng | null;
  /** Şu an bana görünen arkadaş konumları. */
  friendPositions: () => Record<UserId, LatLng>;
  newOpId: () => string;
}

/** Yayılım bu kadar ya da azsa varsayılan mod Yürüyüş. [Varsayım] */
export const WALK_DEFAULT_MAX_SPREAD_M = 2_000;
/** Bundan yeni gelen öneri kendiliğinden kart açar (eskisi yalnızca listede). [Varsayım] */
const AUTO_FOCUS_MAX_AGE_MS = 2 * 60_000;

function visibleFriendPositions(): Record<UserId, LatLng> {
  const out: Record<UserId, LatLng> = {};
  for (const f of selectVisibleIncoming(incomingStore.getState(), serverClockNow())) {
    if (!(f.senderId in out)) out[f.senderId] = { lat: f.location.lat, lng: f.location.lng };
  }
  return out;
}

function myPositionNow(): LatLng | null {
  const p = locationStore.getState().myPosition;
  return p ? { lat: p.lat, lng: p.lng } : null;
}

const fail = (message: string, code: 'invalid_argument' | 'not_friends' = 'invalid_argument') => ({ ok: false as const, error: { code, message } });

export function createMeetupStore(overrides: Partial<MeetupStoreDeps> = {}): StoreApi<MeetupState> {
  const deps: MeetupStoreDeps = {
    api: meetupApi,
    now: serverClockNow,
    myUid: () => authStore.getState().uid,
    myPosition: myPositionNow,
    friendPositions: visibleFriendPositions,
    newOpId: uuidV4,
    ...overrides,
  };
  let seq = 0;
  let sent: Meetup[] = [];
  let received: Meetup[] = [];
  let seenReceived: Set<string> | null = null;

  return createStore<MeetupState>()((set, get) => {
    const rebuild = () => {
      const t = deps.now();
      const meetups: Record<string, Meetup> = {};
      for (const m of [...received, ...sent]) if (isMeetupActive(m, t)) meetups[m.meetup_id] = m;
      // Odak yalnızca öneri BİLİNİP artık aktif değilse kalkar: push dinleyiciden önce gelebilir (kart veri gelince açılır).
      const focused = get().focusedMeetupId;
      const known = focused ? [...received, ...sent].find((m) => m.meetup_id === focused) : undefined;
      set({ meetups, ...(known && !isMeetupActive(known, t) ? { focusedMeetupId: null } : {}) });
    };

    const upsertOne = (m: Meetup) => {
      const me = deps.myUid();
      if (m.from === me) sent = [m, ...sent.filter((x) => x.meetup_id !== m.meetup_id)];
      else received = [m, ...received.filter((x) => x.meetup_id !== m.meetup_id)];
      rebuild();
    };

    return {
      input: null,
      status: 'idle',
      result: null,
      selectedIndex: null,
      error: null,
      missingFriendIds: [],
      meetups: {},
      focusedMeetupId: null,

      suggest: async (input) => {
        const me = deps.myUid();
        const friendIds = [...new Set(input.friendIds)].filter((u) => u !== me);
        const overridesIn = input.positionOverrides ?? {};
        const mine = overridesIn.me ?? deps.myPosition();
        const visible = deps.friendPositions();
        const missing: UserId[] = [];
        const points: { key: 'me' | UserId; position: LatLng }[] = [];
        if (mine) points.push({ key: 'me', position: mine });
        for (const f of friendIds) {
          const p = overridesIn[f] ?? visible[f];
          if (p) points.push({ key: f, position: p });
          else missing.push(f);
        }
        const used = points.slice(0, MEETUP_LIMITS.maxParticipants);
        const mySeq = ++seq;
        set({ input, missingFriendIds: missing, selectedIndex: null });
        if (!mine) {
          const msg = 'Konumun alınamadı. Konum iznini kontrol et.';
          set({ status: 'error', error: msg, result: null });
          return fail(msg);
        }
        if (used.length < MEETUP_LIMITS.minParticipants) {
          const msg = 'Konumu görünen en az bir arkadaş seç.';
          set({ status: 'error', error: msg, result: null });
          return fail(msg);
        }
        const center = meetupCenter(used.map((p) => p.position));
        const spread = meetupSpreadM(center, used.map((p) => p.position));
        const defaultMode: TravelMode = spread <= WALK_DEFAULT_MAX_SPREAD_M ? 'WALK' : 'DRIVE';
        const participants: MeetupParticipant[] = used.map((p) => ({
          key: p.key,
          position: { lat: p.position.lat, lng: p.position.lng },
          mode: input.modes?.[p.key] ?? defaultMode,
        }));
        set({ status: 'loading', error: null });
        try {
          const res = await deps.api.meetupSuggest({ op_id: deps.newOpId(), participants, category: input.category });
          if (mySeq !== seq) return { ok: true }; // daha yeni bir istek var: bu yanıt gösterilmez
          set({ status: 'ready', result: res, selectedIndex: res.suggestions.length > 0 ? 0 : null, error: null });
          return { ok: true };
        } catch (e) {
          const err = toKonumError(e).toSharingError();
          if (mySeq === seq) set({ status: 'error', error: err.message, result: null });
          return { ok: false, error: err };
        }
      },

      select: (index) => {
        const n = get().result?.suggestions.length ?? 0;
        set({ selectedIndex: index === null || index < 0 || index >= n ? null : index });
      },

      clear: () => {
        seq++;
        set({ input: null, status: 'idle', result: null, selectedIndex: null, error: null, missingFriendIds: [] });
      },

      share: async ({ suggestionIndex, to, meet_at = null, note = null }) => {
        const s = get().result?.suggestions[suggestionIndex];
        if (!s) return fail('Önce bir öneri seç.');
        const me = deps.myUid();
        const recipients = [...new Set(to)].filter((u) => u !== me).slice(0, MEETUP_LIMITS.maxShareRecipients);
        if (recipients.length === 0) return fail('En az bir kişi seç.');
        const cleanNote = note ? sanitizeNoteText(note, 120) || null : null;
        try {
          const res = await deps.api.meetupShare({
            op_id: deps.newOpId(),
            to: recipients,
            place: s.place,
            etas: s.etas.slice(0, MEETUP_LIMITS.maxParticipants),
            meet_at: meet_at !== null && Number.isFinite(meet_at) && meet_at > 0 ? Math.round(meet_at) : null,
            note: cleanNote,
          });
          upsertOne(res.meetup);
          return { ok: true, meetup: res.meetup };
        } catch (e) {
          return { ok: false, error: toKonumError(e).toSharingError() };
        }
      },

      focus: (id) => set({ focusedMeetupId: id }),

      respond: async (meetupId, response) => {
        try {
          const res = await deps.api.meetupRespond({ op_id: deps.newOpId(), meetup_id: meetupId, response });
          upsertOne(res.meetup);
          return true;
        } catch (e) {
          if (toKonumError(e).code === 'meetup_not_found') {
            received = received.filter((m) => m.meetup_id !== meetupId);
            rebuild();
          }
          return false;
        }
      },

      cancel: async (meetupId) => {
        try {
          const res = await deps.api.meetupCancel({ op_id: deps.newOpId(), meetup_id: meetupId });
          upsertOne(res.meetup);
          return true;
        } catch (e) {
          if (toKonumError(e).code === 'meetup_not_found') {
            sent = sent.filter((m) => m.meetup_id !== meetupId);
            rebuild();
            return true;
          }
          return false;
        }
      },

      applySent: (list) => {
        sent = [...list];
        rebuild();
      },

      applyReceived: (list) => {
        received = [...list];
        const t = deps.now();
        const seen = (seenReceived ??= new Set<string>());
        // Yeni ve çok yeni (≤ 2 dk) öneri kart açar; ilk anlık görüntüdeki eski öneriler yalnızca listede kalır.
        let fresh: Meetup | null = null;
        for (const m of list) {
          if (seen.has(m.meetup_id)) continue;
          seen.add(m.meetup_id);
          if (isMeetupActive(m, t) && t - m.created_at <= AUTO_FOCUS_MAX_AGE_MS && (!fresh || m.created_at > fresh.created_at)) fresh = m;
        }
        rebuild();
        if (fresh && get().focusedMeetupId === null) set({ focusedMeetupId: fresh.meetup_id });
      },

      tick: () => {
        const t = deps.now();
        const cur = get().meetups;
        if (Object.values(cur).some((m) => !isMeetupActive(m, t))) rebuild();
      },

      reset: () => {
        seq++;
        sent = [];
        received = [];
        seenReceived = null;
        set({ input: null, status: 'idle', result: null, selectedIndex: null, error: null, missingFriendIds: [], meetups: {}, focusedMeetupId: null });
      },
    };
  });
}

export const meetupStore = createMeetupStore();

export function useMeetupStore<T>(selector: (s: MeetupState) => T): T {
  return useStore(meetupStore, selector);
}

/** Aktif öneriler: bana gelenler önce, sonra en yeni. */
export function selectMeetups(s: Pick<MeetupState, 'meetups'>, myUid: UserId | null): Meetup[] {
  return Object.values(s.meetups).sort((a, b) => Number(a.from === myUid) - Number(b.from === myUid) || b.created_at - a.created_at);
}
