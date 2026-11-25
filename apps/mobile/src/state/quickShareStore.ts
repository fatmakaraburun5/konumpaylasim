/**
 * Faz 6: tek tuşla 1 saatlik paylaşım durumu.
 *
 *  - `pending`: widget / kilit ekranı derin bağlantısından (`konum://quick-share?to=…&src=…`) gelen istek. Kök
 *    rota (app/quick-share.tsx) bunu yazar ve ana ekrana yönlendirir; (main) yerleşimindeki onay kartı
 *    (QuickShareSheet) oturum + arkadaş listesi hazır olunca işler. Giriş gerekiyorsa istek girişten sonra da
 *    beklemede kalır (ömrü `PENDING_TTL_MS`).
 *  - `run(uid)`: uygulama içi "1 sa" ve onay kartı aynı yolu kullanır (`runQuickShare` → sharingStore).
 *  - `last`: son sonuç (widget olayı ya da uygulama içi), profil ekranındaki "Son hızlı paylaşım" satırı için.
 */
import { MINUTE, type EpochMs, type UserId } from '@konum/core';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { runQuickShare, type QuickShareRunResult } from '../features/quickShare/quickShareModel';
import { sharingStore } from './sharingStore';

/** [Varsayım] Derin bağlantı isteği bu süreden eskiyse (ör. giriş çok uzun sürdü) kendiliğinden başlatılmaz. */
export const PENDING_TTL_MS = 10 * MINUTE;

export interface QuickShareIntent {
  to: UserId;
  src: string;
  at: EpochMs;
}

export interface QuickShareLast {
  /** Alıcı; `quick_share_started` push'u yalnızca adı taşır (paylaşım henüz dinleyiciden gelmemişse null). */
  to: UserId | null;
  to_name?: string;
  /** 'started' | 'extended' | 'already_active' | 'error' */
  status: string;
  at: EpochMs;
  expires_at: EpochMs | null;
  source: 'app' | 'link' | 'widget';
  error?: string;
}

interface QuickShareState {
  pending: QuickShareIntent | null;
  running: Record<UserId, true>;
  last: QuickShareLast | null;
  setPending: (p: QuickShareIntent | null) => void;
  /** Bekleyen isteği alır (süresi geçmişse atar). */
  takePending: (now: EpochMs) => QuickShareIntent | null;
  run: (to: UserId, source: 'app' | 'link') => Promise<QuickShareRunResult>;
  recordWidgetEvent: (e: QuickShareLast) => void;
  reset: () => void;
}

export const quickShareStore = createStore<QuickShareState>()((set, get) => ({
  pending: null,
  running: {},
  last: null,

  setPending: (p) => set({ pending: p }),

  takePending: (now) => {
    const p = get().pending;
    if (!p) return null;
    set({ pending: null });
    return now - p.at <= PENDING_TTL_MS ? p : null;
  },

  run: async (to, source) => {
    set((s) => ({ running: { ...s.running, [to]: true } }));
    try {
      const r = await runQuickShare(to, {
        state: () => sharingStore.getState().state,
        startShare: (ids, choice) => sharingStore.getState().startShare(ids, choice),
        sessionExpiry: (id) => sharingStore.getState().findSession(id)?.expires_at,
        now: serverClockNow,
      });
      set({
        last: r.ok
          ? { to, status: r.status, at: serverClockNow(), expires_at: r.expires_at, source }
          : { to, status: 'error', at: serverClockNow(), expires_at: null, source, error: r.error.code },
      });
      return r;
    } finally {
      set((s) => {
        const { [to]: _done, ...rest } = s.running;
        return { running: rest };
      });
    }
  },

  // Daha eski bir olay (ör. kuyruktaki widget kaydı) son sonucu ezmez.
  recordWidgetEvent: (e) => set((s) => (s.last && s.last.at > e.at ? {} : { last: e })),

  reset: () => set({ pending: null, running: {}, last: null }),
}));

export function useQuickShareStore<T>(selector: (s: QuickShareState) => T): T {
  return useStore(quickShareStore, selector);
}
