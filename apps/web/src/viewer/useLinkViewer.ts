/**
 * Veri kaynağı → durum makinesi. Saat sunucu saatine göre ilerler (`.info/serverTimeOffset`):
 * tazelik ve kalan süre gönderenin `timestamp` / `expires_at` değerleriyle aynı saatte hesaplanır.
 */
import { useEffect, useReducer, useState } from 'react';
import type { EpochMs } from '@konum/core';
import type { LinkLiveSource } from '../data/source';
import { initialViewerModel, viewerPhase, viewerReducer, type ViewerModel, type ViewerPhase } from './model';

/** Bu sürede sunucuya bağlanılamazsa "çevrimdışı" gösterilir. [Varsayım] */
export const CONNECT_TIMEOUT_MS = 8_000;

export interface LinkViewer {
  model: ViewerModel;
  phase: ViewerPhase;
  /** Sunucu saatine göre şimdi. */
  now: EpochMs;
}

const browserOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export function useLinkViewer(hash: string | null, source: LinkLiveSource | null, sourceFailed: boolean): LinkViewer {
  const [model, dispatch] = useReducer(viewerReducer, hash !== null, (valid) => initialViewerModel(valid, browserOnline()));
  const [offset, setOffset] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (sourceFailed) dispatch({ type: 'failed' });
  }, [sourceFailed]);

  useEffect(() => {
    if (!hash || !source) return;
    const unsubs = [
      source.onConnection((connected) => dispatch({ type: 'connection', connected })),
      source.onServerTimeOffset(setOffset),
      source.subscribe(hash, {
        value: (raw) => dispatch({ type: 'snapshot', raw }),
        denied: () => dispatch({ type: 'denied' }),
        failed: () => dispatch({ type: 'failed' }),
      }),
    ];
    const timer = setTimeout(() => dispatch({ type: 'connect_timeout' }), CONNECT_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      unsubs.forEach((u) => u());
    };
  }, [hash, source]);

  useEffect(() => {
    const on = () => dispatch({ type: 'browser_online', online: true });
    const off = () => dispatch({ type: 'browser_online', online: false });
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Saniyelik yeniden çizim: tazelik etiketi ve bitiş anı (paketteki expires_at geçince "sona erdi").
  // Saat her çizimde yeniden okunur (yeni paket geldiğinde de güncel). Sekme arka plandayken tarayıcı
  // zamanlayıcıyı yavaşlatır; görünür olunca hemen güncellenir.
  useEffect(() => {
    const tick = () => setTick((n) => n + 1);
    const id = setInterval(tick, 1000);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const now = Date.now() + offset;
  return { model, phase: viewerPhase(model, now), now };
}
