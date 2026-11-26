/**
 * Faz 9: tek kullanımlık anlık fotoğraf ispatı — core `proof.ts`, docs/PHASE9.md §1.
 *
 * Benim fotoğrafım (`mine`):
 *  - `addPhoto(photo, {caption})`: YALNIZCA kameradan gelen kare (bkz. services/proof/types `CameraCaptureProps`;
 *    galeri yolu yoktur) → cihazda yeniden kodlama (1280 px, JPEG 0,7, ≤ 600 KB, EXIF düşer) → tazelik denetimi
 *    (`isFreshCapture`, sunucu saati) → `proof_create` → önbellek + `konum.bg.proof.v1` (konum hattı `photo_id` +
 *    `photo_exp` ekler) → `onProofChange` (f9Services hemen yayınlar). Yenisi eskisinin yerine geçer.
 *  - `removePhoto()`: önce yerelde kaldırılır (paket alanı düşer), sonra `proof_delete` (onaydan muaf).
 *  - Süre dolunca (`tick`) yerel kopya ve kayıt silinir.
 * Arkadaşların fotoğrafları (`friends[owner_id]`):
 *  - Paketteki `photo_id` + `photo_exp` (core `visibleProofRef`) → `loadFriendProof` → önbellek ya da `proof_get`
 *    (erişim her istekte sunucuda yeniden denetlenir) → `ready` + `uri`. `proof_expired` → `expired`,
 *    `proof_not_found` (paylaşım bitti / izin yok) → `not_found`; ikisinde de görsel erişilemez.
 *  - `syncFriendRefs`: paketten kalkan ya da süresi dolan fotoğrafın kaydı ve dosyası silinir.
 * Çıkış / hesap silme: `reset()` önbelleği (dosyalar dahil) ve kaydı siler.
 */
import {
  isFreshCapture,
  PROOF_TEXT,
  sanitizeProofCaption,
  uuidV4,
  type EpochMs,
  type PhotoProofView,
  type ProofPosition,
  type SharingError,
  type UserId,
} from '@konum/core';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { getServerOffsetMs, now as serverClockNow } from '../lib/clock';
import { KonumError, toKonumError } from '../lib/errors';
import { proofApi, type ProofApi } from '../services/firebase/callables';
import { getLastFix } from '../services/location/lastFix';
import { createProofCache, type ProofCache } from '../services/proof/cache';
import { encodeProofPhoto, ProofEncodeError, type EncodedProof } from '../services/proof/encode';
import { fileProofBlobStore } from '../services/proof/fileStore';
import type { CapturedPhoto } from '../services/proof/types';
import { authStore } from './authStore';
import { loadProof, saveProof, type PersistedProof } from './persist';
import type { Result } from './pingStore';

/** Benim etkin fotoğrafım. */
export interface MyProof {
  proof_id: string;
  /** Sunucu saati. */
  expires_at: EpochMs;
  captured_at: EpochMs;
  caption: string | null;
  width: number;
  height: number;
  /** Yerel kopya (önbellek); yoksa null (ör. başka cihazda çekildi / önbellek silindi). */
  uri: string | null;
}

export type FriendProofStatus = 'loading' | 'ready' | 'expired' | 'not_found' | 'error';

export interface FriendProof {
  owner_id: UserId;
  proof_id: string;
  /** Sunucu saati (paketten; yanıt gelince sunucunun değeri). */
  expires_at: EpochMs;
  status: FriendProofStatus;
  /** Yalnızca `ready`: gösterilecek adres (expo-image `cachePolicy="none"` ile). */
  uri: string | null;
  proof: PhotoProofView | null;
  error: string | null;
}

export type ProofPhase = 'idle' | 'encoding' | 'uploading' | 'deleting';

export interface ProofState {
  hydrated: boolean;
  mine: MyProof | null;
  phase: ProofPhase;
  error: SharingError | null;
  friends: Record<UserId, FriendProof>;
  hydrate(): Promise<void>;
  addPhoto(photo: CapturedPhoto, opts?: { caption?: string | null }): Promise<Result<{ proof_id: string }>>;
  removePhoto(): Promise<Result>;
  /** Alıcı: paketteki referansla fotoğrafı yükler (önbellek → `proof_get`). İdempotent. */
  loadFriendProof(ownerId: UserId, ref: { photo_id: string; photo_exp: EpochMs }): Promise<void>;
  /** Alıcı: görünür paketlerdeki fotoğraf referansları (yoksa null); kalkanlar silinir. */
  syncFriendRefs(refs: Record<UserId, { photo_id: string; photo_exp: EpochMs } | null>): void;
  /** Süresi dolanları kaldırır (f9Services her `PROOF_LIMITS.cacheSweepMs`'de ve öne gelince). */
  tick(): Promise<void>;
  clearError(): void;
  reset(): Promise<void>;
}

export interface ProofStoreDeps {
  api: ProofApi;
  /** Sunucu saati. */
  now: () => EpochMs;
  /** Sunucu − cihaz saat farkı (çekim anını sunucu saatine çevirir). */
  offsetMs: () => number;
  myUid: () => UserId | null;
  encode: (photo: CapturedPhoto) => Promise<EncodedProof>;
  cache: () => ProofCache;
  loadPersisted: () => Promise<PersistedProof | null>;
  savePersisted: (v: PersistedProof | null) => Promise<void>;
  /** Çekim yeri (son doğrulanmış konum, taze ise); yoksa null. */
  position: () => Promise<ProofPosition | null>;
  newOpId: () => string;
}

/** Çekim yeri için son doğrulanmış konum en çok bu kadar eski olabilir. [Varsayım] */
const POSITION_MAX_AGE_MS = 2 * 60_000;

let sharedCache: ProofCache | null = null;
/** Uygulama genelindeki önbellek (native: önbellek dizini; web demosu `fileStore.web.ts`). */
export function proofCache(): ProofCache {
  return (sharedCache ??= createProofCache(fileProofBlobStore(), serverClockNow));
}

const listeners = new Set<() => void>();
/** Benim fotoğrafım eklendi / kaldırıldı / süresi doldu: paket alanları değişti (f9Services → hemen yayın). */
export function onProofChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const notifyChange = () => {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // önemsiz
    }
  }
};

const defaultPosition = async (): Promise<ProofPosition | null> => {
  const f = await getLastFix(authStore.getState().uid).catch(() => null);
  if (!f || serverClockNow() - f.timestamp > POSITION_MAX_AGE_MS) return null;
  return { lat: f.lat, lng: f.lng, accuracy: f.accuracy };
};

const errorOf = (e: unknown): SharingError => {
  if (e instanceof ProofEncodeError) return new KonumError('proof_invalid').toSharingError();
  return toKonumError(e).toSharingError();
};

export function createProofStore(overrides: Partial<ProofStoreDeps> = {}): StoreApi<ProofState> {
  const deps: ProofStoreDeps = {
    api: proofApi,
    now: serverClockNow,
    offsetMs: getServerOffsetMs,
    myUid: () => authStore.getState().uid,
    encode: encodeProofPhoto,
    cache: proofCache,
    loadPersisted: loadProof,
    savePersisted: saveProof,
    position: defaultPosition,
    newOpId: uuidV4,
    ...overrides,
  };
  let adding: Promise<Result<{ proof_id: string }>> | null = null;
  const loading = new Map<string, Promise<void>>();

  return createStore<ProofState>()((set, get) => {
    const clearMine = async (notify = true) => {
      const cur = get().mine;
      const me = deps.myUid();
      set({ mine: null });
      await deps.savePersisted(null).catch(() => undefined);
      if (cur && me) await deps.cache().remove(me, cur.proof_id).catch(() => undefined);
      if (notify) notifyChange();
    };

    const setFriend = (ownerId: UserId, patch: Partial<FriendProof> & Pick<FriendProof, 'proof_id'>) =>
      set((s) => {
        const prev = s.friends[ownerId];
        const base: FriendProof =
          prev && prev.proof_id === patch.proof_id
            ? prev
            : { owner_id: ownerId, proof_id: patch.proof_id, expires_at: 0, status: 'loading', uri: null, proof: null, error: null };
        return { friends: { ...s.friends, [ownerId]: { ...base, ...patch } } };
      });

    return {
      hydrated: false,
      mine: null,
      phase: 'idle',
      error: null,
      friends: {},

      hydrate: async () => {
        await deps.cache().hydrate().catch(() => undefined);
        const me = deps.myUid();
        const p = await deps.loadPersisted().catch(() => null);
        if (p && me && p.uid === me && p.expires_at > deps.now()) {
          const e = deps.cache().get(me, p.proof_id);
          set({ mine: { proof_id: p.proof_id, expires_at: p.expires_at, captured_at: p.captured_at, caption: p.caption, width: p.width, height: p.height, uri: e?.uri ?? null }, hydrated: true });
        } else {
          if (p) await deps.savePersisted(null).catch(() => undefined);
          set({ mine: null, hydrated: true });
        }
      },

      addPhoto: (photo, opts) => {
        if (adding) return adding;
        const run = (async (): Promise<Result<{ proof_id: string }>> => {
          const me = deps.myUid();
          if (!me) return { ok: false, error: new KonumError('unauthenticated').toSharingError() };
          set({ phase: 'encoding', error: null });
          try {
            const capturedAt = Math.round(photo.captured_at + deps.offsetMs());
            if (!isFreshCapture(capturedAt, deps.now())) {
              const error: SharingError = { code: 'proof_stale_capture', message: PROOF_TEXT.stale };
              set({ phase: 'idle', error });
              return { ok: false, error };
            }
            const enc = await deps.encode(photo);
            set({ phase: 'uploading' });
            const position = await deps.position().catch(() => null);
            const caption = sanitizeProofCaption(opts?.caption ?? null);
            const res = await deps.api.proofCreate({
              op_id: deps.newOpId(),
              source: 'camera',
              jpeg_b64: enc.base64,
              width: enc.width,
              height: enc.height,
              captured_at: capturedAt,
              caption,
              position,
            });
            const v = res.proof;
            const prev = get().mine;
            if (prev && prev.proof_id !== v.proof_id) await deps.cache().remove(me, prev.proof_id).catch(() => undefined);
            const entry = await deps.cache().put({ owner_id: me, proof_id: v.proof_id, expires_at: v.expires_at }, enc.base64).catch(() => null);
            const mine: MyProof = { proof_id: v.proof_id, expires_at: v.expires_at, captured_at: v.captured_at, caption: v.caption, width: v.width, height: v.height, uri: entry?.uri ?? null };
            await deps.savePersisted({ uid: me, proof_id: mine.proof_id, expires_at: mine.expires_at, captured_at: mine.captured_at, caption: mine.caption, width: mine.width, height: mine.height });
            set({ mine, phase: 'idle', error: null });
            notifyChange();
            return { ok: true, proof_id: v.proof_id };
          } catch (e) {
            const error = errorOf(e);
            set({ phase: 'idle', error });
            return { ok: false, error };
          }
        })().finally(() => {
          adding = null;
        });
        adding = run;
        return run;
      },

      removePhoto: async () => {
        const cur = get().mine;
        if (!cur) return { ok: true };
        set({ phase: 'deleting', error: null });
        // Önce yerelde: paket alanı hemen düşer (alıcı rozeti kalkar).
        await clearMine();
        try {
          await deps.api.proofDelete({ op_id: deps.newOpId(), proof_id: cur.proof_id });
          set({ phase: 'idle' });
          return { ok: true };
        } catch (e) {
          const err = toKonumError(e);
          set({ phase: 'idle' });
          if (err.code === 'proof_not_found' || err.code === 'proof_expired') return { ok: true };
          // Sunucu yine de 1 saatte siler; paket alanı zaten kalktı.
          set({ error: err.toSharingError() });
          return { ok: false, error: err.toSharingError() };
        }
      },

      loadFriendProof: async (ownerId, ref) => {
        const t = deps.now();
        if (ref.photo_exp <= t) {
          setFriend(ownerId, { proof_id: ref.photo_id, expires_at: ref.photo_exp, status: 'expired', uri: null });
          await deps.cache().remove(ownerId, ref.photo_id).catch(() => undefined);
          return;
        }
        const cur = get().friends[ownerId];
        if (cur && cur.proof_id === ref.photo_id && (cur.status === 'ready' || cur.status === 'expired' || cur.status === 'not_found')) return;
        const key = `${ownerId}/${ref.photo_id}`;
        const inflight = loading.get(key);
        if (inflight) return inflight;
        const cached = deps.cache().get(ownerId, ref.photo_id);
        if (cached) {
          setFriend(ownerId, { proof_id: ref.photo_id, expires_at: cached.expires_at, status: 'ready', uri: cached.uri, error: null });
          return;
        }
        setFriend(ownerId, { proof_id: ref.photo_id, expires_at: ref.photo_exp, status: 'loading', uri: null, error: null });
        const run = (async () => {
          try {
            const res = await deps.api.proofGet({ owner_id: ownerId, proof_id: ref.photo_id });
            const entry = await deps.cache().put({ owner_id: ownerId, proof_id: res.proof.proof_id, expires_at: res.proof.expires_at }, res.jpeg_b64);
            if (get().friends[ownerId]?.proof_id !== ref.photo_id) {
              // Bu arada paket değişti / kalktı: indirilen kopya tutulmaz.
              if (entry) await deps.cache().remove(ownerId, ref.photo_id).catch(() => undefined);
              return;
            }
            setFriend(ownerId, {
              proof_id: ref.photo_id,
              expires_at: res.proof.expires_at,
              status: entry ? 'ready' : 'expired',
              uri: entry?.uri ?? null,
              proof: res.proof,
              error: null,
            });
          } catch (e) {
            const err = toKonumError(e);
            if (get().friends[ownerId]?.proof_id !== ref.photo_id) return;
            const status: FriendProofStatus = err.code === 'proof_expired' ? 'expired' : err.code === 'proof_not_found' ? 'not_found' : 'error';
            setFriend(ownerId, { proof_id: ref.photo_id, status, uri: null, error: status === 'error' ? err.message : null });
          }
        })().finally(() => loading.delete(key));
        loading.set(key, run);
        return run;
      },

      syncFriendRefs: (refs) => {
        const t = deps.now();
        const friends = { ...get().friends };
        let changed = false;
        for (const [owner, fp] of Object.entries(friends)) {
          const ref = refs[owner];
          if (!ref || ref.photo_id !== fp.proof_id) {
            delete friends[owner];
            changed = true;
            void deps.cache().remove(owner, fp.proof_id).catch(() => undefined);
          } else if (fp.status !== 'expired' && Math.min(ref.photo_exp, fp.expires_at || ref.photo_exp) <= t) {
            friends[owner] = { ...fp, status: 'expired', uri: null };
            changed = true;
            void deps.cache().remove(owner, fp.proof_id).catch(() => undefined);
          }
        }
        // Önbellekte olup artık paketlerde olmayan (paylaşım bitti) kopyalar da silinir.
        const me = deps.myUid();
        for (const e of deps.cache().entries()) {
          if (e.owner_id === me) continue;
          if (refs[e.owner_id]?.photo_id !== e.proof_id) void deps.cache().remove(e.owner_id, e.proof_id).catch(() => undefined);
        }
        if (changed) set({ friends });
      },

      tick: async () => {
        const t = deps.now();
        const mine = get().mine;
        if (mine && mine.expires_at <= t) await clearMine();
        const friends = { ...get().friends };
        let changed = false;
        for (const [owner, fp] of Object.entries(friends)) {
          if (fp.status !== 'expired' && fp.expires_at > 0 && fp.expires_at <= t) {
            friends[owner] = { ...fp, status: 'expired', uri: null };
            changed = true;
          }
        }
        if (changed) set({ friends });
        await deps.cache().sweep().catch(() => undefined);
      },

      clearError: () => set({ error: null }),

      reset: async () => {
        adding = null;
        loading.clear();
        set({ mine: null, phase: 'idle', error: null, friends: {}, hydrated: false });
        await deps.savePersisted(null).catch(() => undefined);
        await deps.cache().clear().catch(() => undefined);
      },
    };
  });
}

export const proofStore = createProofStore();

export function useProofStore<T>(selector: (s: ProofState) => T): T {
  return useStore(proofStore, selector);
}

/** Benim etkin fotoğrafım (süresi dolmuşsa da `tick` gelene kadar döner: arayüz `formatProofLeft` ile gösterir). */
export const useMyProof = (): MyProof | null => useStore(proofStore, (s) => s.mine);

/**
 * Alıcı: kişinin paketindeki fotoğraf referansı (core `visibleProofRef`) → yüklenir ve durumu döner.
 * `ref` null ise (fotoğraf yok / süresi doldu) null.
 */
export function useFriendProof(ownerId: UserId | null | undefined, ref: { photo_id: string; photo_exp: EpochMs } | null): FriendProof | null {
  const entry = useStore(proofStore, (s) => (ownerId ? (s.friends[ownerId] ?? null) : null));
  const photoId = ref?.photo_id ?? null;
  const photoExp = ref?.photo_exp ?? 0;
  useEffect(() => {
    if (!ownerId || !photoId) return;
    void proofStore.getState().loadFriendProof(ownerId, { photo_id: photoId, photo_exp: photoExp });
  }, [ownerId, photoId, photoExp]);
  if (!ownerId || !photoId) return null;
  return entry && entry.proof_id === photoId ? entry : null;
}
