/**
 * Google Maps JavaScript API haritası (yalnızca `VITE_GOOGLE_MAPS_WEB_KEY` varsa, tembel yüklenir).
 *
 * Maliyet kuralları:
 *   - Harita yalnızca İLK canlı konum geldiğinde yüklenir (geçersiz / bitmiş bağlantı harita yüklemez).
 *   - Sayfa başına tek `Map` örneği; konum güncellemesi yeni yükleme saymaz.
 *   - Routes / Geocoding / Places ÇAĞRILMAZ; kütüphane olarak yalnızca `maps` yüklenir.
 * Anahtar HTTP referrer ile kısıtlıdır (yalnızca bağlantı alan adı); sayfa adresi token içermez
 * (bkz. `token.ts`), referrer yalnızca kaynak (origin) olarak gider.
 *
 * Pin özel `OverlayView` ile çizilir (JSON `styles` ile uyumlu; AdvancedMarker `mapId` ister ve
 * `mapId` verilince JSON stil yok sayılır).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import type { Freshness, LatLng } from '@konum/core';
import { darkMap, lightMap, mapStyleFor, type ColorScheme } from '../theme/tokens';
import { PersonPin } from './PersonPin';

export interface GoogleMapViewProps {
  apiKey: string;
  scheme: ColorScheme;
  /** Animasyonlu (görünen) konum; null = pin yok (paylaşım bitti). */
  position: LatLng | null;
  /** Son gelen gerçek konum (takip / ortalama için). */
  target: LatLng | null;
  accuracyM: number | null;
  freshness: Freshness;
  heading: number | null;
  initial: string;
  dim: boolean;
  /** Anahtar reddedildi / betik yüklenemedi: yedek haritaya geç. */
  onFailed: () => void;
}

const INITIAL_ZOOM = 16;
let optionsSet = false;

type PinOverlay = google.maps.OverlayView & { setPosition(p: LatLng | null): void; element: HTMLDivElement };

function createPinOverlay(maps: google.maps.MapsLibrary): PinOverlay {
  class Overlay extends maps.OverlayView {
    element = document.createElement('div');
    private pos: LatLng | null = null;
    constructor() {
      super();
      this.element.className = 'gm-pin-host';
    }
    override onAdd() {
      this.getPanes()?.overlayMouseTarget.appendChild(this.element);
    }
    override draw() {
      const proj = this.getProjection();
      if (!proj || !this.pos) {
        this.element.style.display = 'none';
        return;
      }
      const pt = proj.fromLatLngToDivPixel(this.pos);
      if (!pt) return;
      this.element.style.display = '';
      this.element.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    }
    override onRemove() {
      this.element.remove();
    }
    setPosition(p: LatLng | null) {
      this.pos = p;
      this.draw();
    }
  }
  return new Overlay();
}

export default function GoogleMapView(props: GoogleMapViewProps) {
  const { apiKey, scheme, position, target, accuracyM, freshness, heading, initial, dim, onFailed } = props;
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlayRef = useRef<PinOverlay | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);
  const [ready, setReady] = useState(false);
  const [follow, setFollow] = useState(true);
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;

  // Haritayı bir kez kur.
  useEffect(() => {
    let cancelled = false;
    const w = window as unknown as { gm_authFailure?: () => void };
    w.gm_authFailure = () => failedRef.current(); // geçersiz / kısıtlı anahtar
    if (!optionsSet) {
      setOptions({ key: apiKey, v: 'weekly', language: 'tr', region: 'TR' });
      optionsSet = true;
    }
    importLibrary('maps')
      .then((maps) => {
        if (cancelled || !el.current) return;
        const c = scheme === 'dark' ? darkMap : lightMap;
        const map = new maps.Map(el.current, {
          center: target ?? { lat: 39.0, lng: 35.0 },
          zoom: target ? INITIAL_ZOOM : 5,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          keyboardShortcuts: false,
          gestureHandling: 'greedy',
          backgroundColor: c.mapLand,
          styles: mapStyleFor(c),
        });
        map.addListener('dragstart', () => setFollow(false));
        const overlay = createPinOverlay(maps);
        overlay.setMap(map);
        circleRef.current = new maps.Circle({
          map,
          clickable: false,
          strokeColor: '#2563EB',
          strokeOpacity: 0.35,
          strokeWeight: 1,
          fillColor: '#2563EB',
          fillOpacity: 0.12,
          radius: 0,
        });
        mapRef.current = map;
        overlayRef.current = overlay;
        setReady(true);
      })
      .catch(() => !cancelled && failedRef.current());
    return () => {
      cancelled = true;
      overlayRef.current?.setMap(null);
      circleRef.current?.setMap(null);
      w.gm_authFailure = undefined;
    };
    // Bilerek bir kez: anahtar ve başlangıç merkezi değişmez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Açık / koyu stil canlı değişir.
  useEffect(() => {
    const c = scheme === 'dark' ? darkMap : lightMap;
    mapRef.current?.setOptions({ styles: mapStyleFor(c), backgroundColor: c.mapLand });
  }, [scheme, ready]);

  // Her karede pin ve doğruluk dairesi.
  useEffect(() => {
    if (!ready) return;
    overlayRef.current?.setPosition(position);
    const circle = circleRef.current;
    if (!circle) return;
    if (position && accuracyM !== null && accuracyM > 0) {
      circle.setCenter(position);
      circle.setRadius(accuracyM);
      circle.setVisible(true);
    } else {
      circle.setVisible(false);
    }
  }, [ready, position, accuracyM]);

  // Yeni gerçek konumda takip: ilk konumda yakınlaş, sonra yumuşak kaydır.
  const firstTarget = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !target) return;
    if (firstTarget.current) {
      firstTarget.current = false;
      map.setCenter(target);
      map.setZoom(INITIAL_ZOOM);
      return;
    }
    if (follow) map.panTo(target);
  }, [ready, target?.lat, target?.lng, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const recenter = () => {
    setFollow(true);
    if (target) mapRef.current?.panTo(target);
  };

  return (
    <>
      <div ref={el} className="gmap" data-testid="google-map" />
      {ready && overlayRef.current && position
        ? createPortal(<PersonPin initial={initial} freshness={freshness} heading={heading} dim={dim} />, overlayRef.current.element)
        : null}
      {ready && !follow && target ? (
        <button type="button" className="recenter" onClick={recenter} aria-label="Kişiye odaklan">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="3.5" fill="currentColor" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      ) : null}
    </>
  );
}
