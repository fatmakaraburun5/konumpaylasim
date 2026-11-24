/**
 * Bana konumunu paylaşan arkadaşlar: RTDB gelen kutusu (`live_locations/{ben}`, core `parseDelivered`)
 * + Firestore `location_shares` (receiver_id == ben) meta verisi.
 *
 * Gizlilik:
 *  - Konumlar yalnızca bellekte tutulur; `child_removed` / paylaşımın bitmesi / sürenin dolması
 *    (sunucu saatine göre) anında gizlenir. Sunucunun silmesini beklemeyiz.
 *  - Bir paketin içinde başka alıcıların listesi yoktur (core `DeliveredLocation`).
 */
import {
  freshness,
  isExpired,
  lastVerifiedLocation,
  type DeliveredLocation,
  type EpochMs,
  type Freshness,
  type LastVerifiedLocation,
  type ReceivedFix,
  type ShareId,
  type UserId,
} from '@konum/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import type { ShareDoc } from '../lib/schemas';
import { shareRevoke } from '../services/firebase/callables';
import type { TrailFix } from '../services/firebase/liveRepo';

export interface IncomingFriendLocation {
  shareId: ShareId;
  senderId: UserId;
  location: DeliveredLocation;
  freshness: Freshness;
  expiresAt: EpochMs | null;
  /**
   * Faz 3: core `lastVerifiedLocation` (canlı paket + eşitlenen iz): son doğrulanmış koordinat, zaman, pil ve
   * bağlantı durumu ("Bağlantısı kopmuş olabilir"). Gönderenin `hb`'sine göre hesaplanır.
   */
  verified?: LastVerifiedLocation | null;
  /** Faz 3: çevrimdışıyken kaydedilip sonradan eşitlenen noktalar (eskiden yeniye; kesikli çizgi). */
  trail?: readonly TrailFix[];
}

/** Paket / iz noktası → core alıcı ölçümü. */
export function toReceivedFix(l: Pick<DeliveredLocation, 'lat' | 'lng' | 'accuracy' | 'timestamp' | 'server_ts' | 'battery_pct' | 'hb' | 'q'>): ReceivedFix {
  return { lat: l.lat, lng: l.lng, accuracy: l.accuracy, timestamp: l.timestamp, server_ts: l.server_ts, battery_pct: l.battery_pct, hb: l.hb ?? null, q: l.q ?? null };
}

interface IncomingState {
  shares: Record<ShareId, ShareDoc>;
  locations: Record<ShareId, DeliveredLocation>;
  /**
   * "Görmeyi bırak" sonrası sunucu silene kadar iyimser gizleme: gönderen → iptal anı (sunucu saati).
   * Aynı kişi SONRADAN yeni bir paylaşım başlatırsa (started_at > iptal anı) tekrar görünür.
   */
  hiddenSenders: Record<UserId, EpochMs>;
  /** Faz 3: eşitlenen iz noktaları (yalnızca bellekte; paylaşım bitince silinir). */
  trails: Record<ShareId, TrailFix[]>;
  setShares: (list: ShareDoc[]) => void;
  setTrail: (shareId: ShareId, points: TrailFix[]) => void;
  removeTrail: (shareId: ShareId) => void;
  upsertLocation: (loc: DeliveredLocation) => void;
  removeLocation: (shareId: ShareId) => void;
  revoke: (senderId: UserId) => Promise<{ ok: true } | { ok: false; message: string }>;
  reset: () => void;
}

export const incomingStore = createStore<IncomingState>()((set, get) => ({
  shares: {},
  locations: {},
  hiddenSenders: {},
  trails: {},

  setShares: (list) => {
    const shares: Record<ShareId, ShareDoc> = {};
    for (const s of list) shares[s.share_id] = s;
    // Biten paylaşımın konumunu (ve izini) bellekten de sil (sunucu silmesi gecikse bile).
    const locations = { ...get().locations };
    for (const id of Object.keys(locations)) if (shares[id]?.status === 'ended') delete locations[id];
    const trails = { ...get().trails };
    for (const id of Object.keys(trails)) if (shares[id]?.status === 'ended') delete trails[id];
    set({ shares, locations, trails });
  },

  setTrail: (shareId, points) => {
    if (get().shares[shareId]?.status === 'ended') return;
    set((s) => ({ trails: { ...s.trails, [shareId]: points } }));
  },

  removeTrail: (shareId) =>
    set((s) => {
      if (!(shareId in s.trails)) return s;
      const { [shareId]: _gone, ...rest } = s.trails;
      return { trails: rest };
    }),

  upsertLocation: (loc) => {
    const prev = get().locations[loc.share_id];
    // Eski paket yeniyi ezmesin (yeniden bağlanmada sıra karışabilir).
    if (prev && prev.timestamp > loc.timestamp) return;
    set((s) => ({ locations: { ...s.locations, [loc.share_id]: loc } }));
  },

  removeLocation: (shareId) =>
    set((s) => {
      if (!(shareId in s.locations) && !(shareId in s.trails)) return s;
      const { [shareId]: _gone, ...rest } = s.locations;
      const { [shareId]: _trail, ...trails } = s.trails;
      return { locations: rest, trails };
    }),

  revoke: async (senderId) => {
    set((s) => ({ hiddenSenders: { ...s.hiddenSenders, [senderId]: serverClockNow() } }));
    try {
      await shareRevoke({ sender_id: senderId });
      return { ok: true };
    } catch (e) {
      set((s) => {
        const { [senderId]: _x, ...rest } = s.hiddenSenders;
        return { hiddenSenders: rest };
      });
      return { ok: false, message: toKonumError(e).message };
    }
  },

  reset: () => set({ shares: {}, locations: {}, hiddenSenders: {}, trails: {} }),
}));

/** Şu an GÖSTERİLEBİLİR konumlar (aktif, süresi dolmamış, gizlenmemiş). En taze önce. */
export function selectVisibleIncoming(
  s: Pick<IncomingState, 'shares' | 'locations' | 'hiddenSenders'> & Partial<Pick<IncomingState, 'trails'>>,
  now: EpochMs,
  offsetAt?: Parameters<typeof lastVerifiedLocation>[2],
): IncomingFriendLocation[] {
  const out: IncomingFriendLocation[] = [];
  for (const loc of Object.values(s.locations)) {
    const share = s.shares[loc.share_id];
    const revokedAt = s.hiddenSenders[loc.sender_id];
    if (revokedAt !== undefined && (share ? share.started_at <= revokedAt : loc.timestamp <= revokedAt)) continue;
    // Paylaşım belgesi varsa karar YALNIZCA ondan: gönderen uzattığında paket eski bitişi taşır
    // (hareketsizken yeni paket gelmeyebilir), arkadaş yine de uzatılan süre boyunca görünür.
    // Belge yoksa (henüz gelmedi) paketin kendi bitişi kullanılır.
    if (share) {
      if (share.status === 'ended' || isExpired(share, now)) continue;
    } else if (isExpired(loc, now)) continue;
    // Paylaşım başlamadan önceki (eski oturum) iz noktaları gösterilmez.
    const trail = (s.trails?.[loc.share_id] ?? []).filter((p) => !share || p.timestamp >= share.started_at);
    out.push({
      shareId: loc.share_id,
      senderId: loc.sender_id,
      location: loc,
      freshness: freshness(loc, now),
      expiresAt: share ? share.expires_at : loc.expires_at,
      // İz noktaları `hb` taşımaz: durum hesabı gönderenin canlı paketteki kalp atışıyla yapılır.
      verified: lastVerifiedLocation([toReceivedFix(loc), ...trail.map((p) => ({ ...toReceivedFix(p), hb: loc.hb ?? null }))], now, offsetAt),
      trail,
    });
  }
  return out.sort((a, b) => b.location.timestamp - a.location.timestamp);
}

export function useIncomingStore<T>(selector: (s: IncomingState) => T): T {
  return useStore(incomingStore, selector);
}

export function useVisibleIncoming(now: EpochMs): IncomingFriendLocation[] {
  const shares = useIncomingStore((s) => s.shares);
  const locations = useIncomingStore((s) => s.locations);
  const hiddenSenders = useIncomingStore((s) => s.hiddenSenders);
  const trails = useIncomingStore((s) => s.trails);
  return useMemo(() => selectVisibleIncoming({ shares, locations, hiddenSenders, trails }, now), [shares, locations, hiddenSenders, trails, now]);
}
