/**
 * Salt okunur canlı konum sayfası: https://<alan>/s/<token>.
 * Harita (Google ya da yedek) + üst çubuk + alt kart. Durum `useLinkViewer`'dan, pin hareketi
 * `useAnimatedPosition`'dan gelir.
 */
import { Suspense, lazy, useCallback, useState } from 'react';
import type { WebConfig } from './env';
import type { LinkLiveSource } from './data/source';
import { FallbackMap } from './map/FallbackMap';
import { appLinkUrl, type ResolvedToken } from './token';
import { useColorScheme } from './theme/tokens';
import { BrandMark, WifiOffIcon } from './ui/icons';
import { Sheet } from './ui/Sheet';
import { PHASE_TEXT, isOffline, livePresentation, showsMarker } from './viewer/model';
import { useAnimatedPosition } from './viewer/useAnimatedPosition';
import { useLinkViewer } from './viewer/useLinkViewer';

// Anahtar yoksa bu parça hiç indirilmez.
const GoogleMapView = lazy(() => import('./map/GoogleMapView'));

export interface AppProps {
  config: WebConfig;
  resolved: ResolvedToken;
  source: LinkLiveSource | null;
  sourceFailed: boolean;
}

export function App({ config, resolved, source, sourceFailed }: AppProps) {
  const { model, phase, now } = useLinkViewer(resolved.hash, source, sourceFailed);
  const scheme = useColorScheme();
  const [googleFailed, setGoogleFailed] = useState(false);
  const onGoogleFailed = useCallback(() => setGoogleFailed(true), []);

  const live = showsMarker(phase) ? model.live : null;
  const presentation = live ? livePresentation(live, now, undefined, { fixes: model.fixes, queued: model.queued }) : null;
  // Faz 3: pin doğrulanmış son ölçümde (≤ 100 m), en son paket kötü doğruluklu olsa bile.
  const shown = presentation?.position ?? null;
  const fix = shown ? { lat: shown.lat, lng: shown.lng, timestamp: shown.timestamp } : null;
  const { position, animating } = useAnimatedPosition(fix);
  const offline = isOffline(model);

  // Maliyet: Google haritası yalnızca ilk canlı konumdan sonra (bir kez) yüklenir.
  const useGoogle = Boolean(config.mapsKey) && !googleFailed && model.seenLive;
  const mapProps = {
    position: live ? position : null,
    accuracyM: shown ? shown.accuracy : null,
    freshness: presentation?.freshness ?? ('live' as const),
    heading: live && live.heading !== null && (live.speed_mps ?? 0) >= 0.5 ? live.heading : null,
    initial: presentation?.initial ?? '',
    dim: offline,
  };

  const fallback = <FallbackMap {...mapProps} animating={animating} />;
  // Yalnızca durum değişince duyurulur (saniyelik metinler değil).
  const announcement = phase === 'live' && presentation ? presentation.announcement : PHASE_TEXT[phase].title;

  return (
    <div
      className={`app phase-${phase}`}
      data-testid="app"
      data-phase={phase}
      data-offline={offline ? '1' : '0'}
      data-status={presentation?.status ?? ''}
    >
      <div className={`map-wrap${phase === 'live' ? '' : ' map-muted'}`}>
        {useGoogle && config.mapsKey ? (
          <Suspense fallback={fallback}>
            <GoogleMapView
              {...mapProps}
              apiKey={config.mapsKey}
              scheme={scheme}
              target={shown ? { lat: shown.lat, lng: shown.lng } : null}
              onFailed={onGoogleFailed}
            />
          </Suspense>
        ) : (
          fallback
        )}
        <div className="topbar">
          <span className="brand">
            <BrandMark />
            Konum
          </span>
          {offline && phase !== 'offline' ? (
            <span className="chip chip-warning" role="status">
              <WifiOffIcon size={16} />
              Çevrimdışı
            </span>
          ) : null}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
        {offline && phase === 'live' ? ' · Bağlantı yok, son bilinen konum gösteriliyor' : ''}
      </p>
      <Sheet
        phase={phase}
        live={presentation}
        offline={offline}
        appUrl={resolved.token ? appLinkUrl(resolved.token) : null}
        appStoreUrl={config.appStoreUrl}
        playStoreUrl={config.playStoreUrl}
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}
