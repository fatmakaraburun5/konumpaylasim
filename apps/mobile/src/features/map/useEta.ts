/**
 * ETA kartının veri kancaları. Kart görünmüyorsa (ya da uygulama arka plandaysa) HİÇBİR çağrı yapılmaz;
 * kararlar routesRepo / geocodeRepo içindeki core politikalarıyla verilir. Kancalar yalnızca
 * değerlendirmeyi tetikler: konum / hedef / mod değişince ve kart açıkken 15 sn'de bir (bayatlık kuralı).
 */
import type { LatLng, TravelMode } from '@konum/core';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { geocodeRepo as defaultGeocodeRepo, type AddressResult, type GeocodeRepo } from '../../services/maps/geocodeRepo';
import { routesRepo as defaultRoutesRepo, type RouteEntry, type RoutesRepo } from '../../services/maps/routesRepo';

/** Rota hedefi: seçili arkadaş ya da bırakılan nokta. */
export interface EtaTarget {
  /** `friend:<share_id>` | `pin:<lat>,<lng>` */
  key: string;
  kind: 'friend' | 'pin';
  title: string;
  position: LatLng;
}

/** [Varsayım] Bayatlık / yeniden deneme kontrol aralığı (çağrı kararını politika verir). */
const EVAL_INTERVAL_MS = 15_000;

export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

function useTick(enabled: boolean, ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [enabled, ms]);
  return n;
}

export type EtaStatus = 'idle' | 'no_origin' | 'loading' | 'ready' | 'error';

export interface EtaState {
  status: EtaStatus;
  entry: RouteEntry | null;
}

export function useRouteEta(
  target: EtaTarget | null,
  origin: LatLng | null,
  mode: TravelMode,
  visible: boolean,
  repo: RoutesRepo = defaultRoutesRepo,
): EtaState {
  const appActive = useAppActive();
  const shown = visible && appActive && target !== null;
  const tick = useTick(shown, EVAL_INTERVAL_MS);
  const [state, setState] = useState<EtaState>({ status: 'idle', entry: null });
  const req = useRef(0);

  const tKey = target?.key ?? null;
  const dLat = target?.position.lat;
  const dLng = target?.position.lng;
  const oLat = origin?.lat;
  const oLng = origin?.lng;

  useEffect(() => {
    const id = ++req.current;
    if (!tKey || dLat === undefined || dLng === undefined) {
      setState({ status: 'idle', entry: null });
      return;
    }
    if (oLat === undefined || oLng === undefined) {
      setState({ status: 'no_origin', entry: null });
      return;
    }
    const q = { targetKey: tKey, origin: { lat: oLat, lng: oLng }, destination: { lat: dLat, lng: dLng }, mode, visible: shown };
    const cached = repo.peek(tKey, mode);
    const willCall = shown && repo.wouldRecompute(q) !== null;
    if (cached) setState({ status: cached.error ? 'error' : cached.result ? 'ready' : 'loading', entry: cached });
    else setState({ status: willCall ? 'loading' : 'idle', entry: null });
    if (!shown) return;
    void repo.refresh(q).then((entry) => {
      if (id !== req.current || !entry) return;
      setState({ status: entry.error ? 'error' : entry.result ? 'ready' : 'loading', entry });
    });
  }, [tKey, dLat, dLng, oLat, oLng, mode, shown, tick, repo]);

  return state;
}

export interface AddressState {
  /** Gösterilecek adres satırı; null = gösterme. */
  text: string | null;
  /** Sorgu sürüyor ("Adres aranıyor…"). */
  pending: boolean;
}

const NO_ADDRESS = 'Adres bilgisi yok';

export function useAddress(target: EtaTarget | null, visible: boolean, repo: GeocodeRepo = defaultGeocodeRepo): AddressState {
  const appActive = useAppActive();
  const shown = visible && appActive && target !== null;
  const tick = useTick(shown, EVAL_INTERVAL_MS * 4);
  const [state, setState] = useState<AddressState>({ text: null, pending: false });
  const req = useRef(0);
  const tKey = target?.key ?? null;
  const lat = target?.position.lat;
  const lng = target?.position.lng;

  // Hedef değişince önceki hedefin adresi görünmesin (aşağıdaki etkiden ÖNCE çalışır).
  useEffect(() => setState({ text: null, pending: false }), [tKey]);

  useEffect(() => {
    const id = ++req.current;
    if (!tKey || lat === undefined || lng === undefined) return;
    const cached = repo.peek({ lat, lng });
    if (cached !== undefined) {
      setState({ text: cached ?? NO_ADDRESS, pending: false });
      return;
    }
    if (!shown) return;
    setState((prev) => ({ text: prev.text, pending: true }));
    void repo.lookup({ subjectKey: tKey, position: { lat, lng }, visible: shown }).then((r: AddressResult) => {
      if (id !== req.current) return;
      const fresh = r.source === 'cache' || r.source === 'network';
      setState({ text: fresh ? (r.label ?? NO_ADDRESS) : r.label, pending: false });
    });
  }, [tKey, lat, lng, shown, tick, repo]);

  return state;
}
