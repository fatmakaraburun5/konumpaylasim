/**
 * Google Maps anahtarı yokken (ya da anahtar reddedilince) gösterilen sade vektör görünüm.
 * Gerçek harita değildir: sokak deseni kişiyle birlikte kayar, pin ortada kalır, böylece hareket
 * görülür. Koordinat yazılmaz; gerçek konum sayfadaki "Haritada göster" bağlantısının arkasındadır.
 * Hiçbir ağ isteği yapmaz.
 */
import { useRef } from 'react';
import type { Freshness, LatLng } from '@konum/core';
import { PersonPin } from './PersonPin';
import { offsetMeters, posMod, scaleBar } from './projection';

/** 1 metre ≈ 1,1 piksel (yaklaşık sokak ölçeği, Google zoom 17 civarı). [Varsayım] */
export const FALLBACK_PX_PER_M = 1.1;
const TILE = 576; // büyük desen periyodu (72 · 8)

export interface FallbackMapProps {
  position: LatLng | null;
  accuracyM: number | null;
  freshness: Freshness;
  heading: number | null;
  initial: string;
  dim: boolean;
  animating: boolean;
}

export function FallbackMap({ position, accuracyM, freshness, heading, initial, dim, animating }: FallbackMapProps) {
  const anchor = useRef<LatLng | null>(null);
  if (position && !anchor.current) anchor.current = position;

  const o = position && anchor.current ? offsetMeters(anchor.current, position) : { x: 0, y: 0 };
  const tx = posMod(-o.x * FALLBACK_PX_PER_M, TILE);
  const ty = posMod(o.y * FALLBACK_PX_PER_M, TILE);
  const shift = `translate(${tx.toFixed(2)} ${ty.toFixed(2)})`;
  const scale = scaleBar(FALLBACK_PX_PER_M);
  const accPx = accuracyM === null ? 0 : Math.min(accuracyM * FALLBACK_PX_PER_M, 140);

  return (
    <div
      className={`fallback-map${position ? '' : ' fallback-empty'}`}
      data-testid="fallback-map"
      data-anim={animating ? 'moving' : 'idle'}
      data-shift={`${tx.toFixed(1)},${ty.toFixed(1)}`}
      role="img"
      aria-label={position ? 'Basit harita görünümü, kişinin konumu ortada' : 'Basit harita görünümü'}
    >
      <svg className="fallback-svg" width="100%" height="100%" aria-hidden="true">
        <defs>
          <pattern id="fb-minor" width="72" height="72" patternUnits="userSpaceOnUse" patternTransform={shift}>
            <rect width="72" height="72" className="fb-land" />
            <rect x="0" y="0" width="72" height="5" className="fb-road" />
            <rect x="0" y="0" width="5" height="72" className="fb-road" />
          </pattern>
          <pattern id="fb-major" width={TILE} height={TILE} patternUnits="userSpaceOnUse" patternTransform={shift}>
            <rect x="300" y="84" width="136" height="124" rx="14" className="fb-park" />
            <rect x="80" y="380" width="64" height="120" rx="12" className="fb-park" />
            <rect x="0" y="282" width={TILE} height="12" className="fb-avenue" />
            <rect x="282" y="0" width="12" height={TILE} className="fb-avenue" />
            <path d={`M0 ${TILE * 0.92} L${TILE} ${TILE * 0.62}`} className="fb-diagonal" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#fb-minor)" />
        <rect width="100%" height="100%" fill="url(#fb-major)" />
      </svg>

      {position ? (
        <div className="fallback-center">
          {accPx > 8 ? <span className="accuracy" style={{ width: accPx * 2, height: accPx * 2 }} /> : null}
          <PersonPin initial={initial} freshness={freshness} heading={heading} dim={dim} />
        </div>
      ) : null}

      <div className="fallback-legend">
        <span className="scale" style={{ width: Math.round(scale.px) }}>
          {scale.label}
        </span>
        <span className="legend-chip">Basit görünüm</span>
      </div>
    </div>
  );
}
