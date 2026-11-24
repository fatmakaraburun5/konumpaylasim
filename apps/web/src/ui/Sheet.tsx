/**
 * Alt kart: canlıyken kişi bilgisi, değilse durum açıklaması. Ekran okuyucu duyurusu App'teki tek
 * `aria-live` satırındadır (kart her saniye yenilendiği için kartın kendisi canlı bölge değildir).
 */
import type { ReactNode } from 'react';
import { PHASE_TEXT, type LivePresentation, type ViewerPhase } from '../viewer/model';
import { StoreBadges } from './StoreBadges';
import {
  AlertIcon,
  BatteryIcon,
  BatteryLowIcon,
  CloudCheckIcon,
  ClockIcon,
  EndedIcon,
  HourglassIcon,
  LinkOffIcon,
  MapIcon,
  PhoneIcon,
  TargetIcon,
  WifiOffIcon,
} from './icons';

export interface SheetProps {
  phase: ViewerPhase;
  live: LivePresentation | null;
  offline: boolean;
  /** `konum://s/<token>`; token geçersizse null. */
  appUrl: string | null;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
  onRetry: () => void;
}

const STATUS_ICON: Partial<Record<ViewerPhase, { icon: ReactNode; tone: string }>> = {
  invalid: { icon: <LinkOffIcon />, tone: 'danger' },
  unavailable: { icon: <LinkOffIcon />, tone: 'danger' },
  ended: { icon: <EndedIcon />, tone: 'neutral' },
  waiting: { icon: <HourglassIcon />, tone: 'primary' },
  offline: { icon: <WifiOffIcon />, tone: 'warning' },
  error: { icon: <AlertIcon />, tone: 'warning' },
};

/** Bağlantı hâlâ işe yarar mı (uygulamada açmanın anlamı var mı). */
const linkUsable = (p: ViewerPhase) => p === 'live' || p === 'waiting' || p === 'loading' || p === 'offline' || p === 'error';

function OpenInApp({ appUrl, primary }: { appUrl: string; primary: boolean }) {
  return (
    <a className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`} href={appUrl}>
      <PhoneIcon />
      Uygulamada aç
    </a>
  );
}

export function Sheet({ phase, live, offline, appUrl, appStoreUrl, playStoreUrl, onRetry }: SheetProps) {
  const badges = <StoreBadges appStoreUrl={appStoreUrl} playStoreUrl={playStoreUrl} />;

  if (phase === 'live' && live) {
    return (
      <section className="sheet" aria-label="Paylaşılan konum" data-testid="sheet" data-phase={phase}>
        <div className="grabber" aria-hidden="true" />
        <header className="person">
          <div className={`avatar avatar-${live.freshness}`} aria-hidden="true">
            {live.initial}
          </div>
          <div className="person-text">
            <h1 className="person-name" data-testid="sender-name">
              {live.senderName}
            </h1>
            <p className={`fresh fresh-${offline ? 'offline' : live.status}`} data-testid="freshness">
              <span className="dot" aria-hidden="true" />
              {offline ? `Bağlantı yok · ${live.ago}` : live.freshnessLine}
            </p>
          </div>
        </header>

        {live.verifiedLabel ? (
          <div className={`verified verified-${offline ? 'offline' : live.status}`} data-testid="verified">
            <ClockIcon />
            <span>
              <strong>{live.verifiedLabel}</strong>
              {!offline && live.statusDetail ? <span className="verified-detail">{live.statusDetail}</span> : null}
            </span>
          </div>
        ) : null}

        {live.lowBattery ? (
          <div className="notice notice-warning" role="note" data-testid="low-battery">
            <BatteryLowIcon />
            <span>
              <strong>{live.lowBattery.title}</strong>
              <span className="notice-body">{live.lowBattery.body}</span>
            </span>
          </div>
        ) : null}

        {live.syncNote && !offline ? (
          <div className="notice notice-calm" role="note" data-testid="sync-note">
            <CloudCheckIcon />
            <span>{live.syncNote}</span>
          </div>
        ) : null}

        <div className="facts">
          <div className="fact fact-wide" data-testid="until">
            <ClockIcon />
            <span>
              <strong>{live.until}</strong>
              {live.remaining ? <span className="muted"> · {live.remaining}</span> : null}
            </span>
          </div>
          <div className={`fact${live.battery ? '' : ' fact-wide'}`}>
            <TargetIcon />
            <span>
              {live.accuracy} <span className="muted">doğruluk</span>
            </span>
          </div>
          {live.battery ? (
            <div className={`fact${live.lowBattery ? ' fact-warning' : ''}`} data-testid="battery">
              {live.lowBattery ? <BatteryLowIcon /> : <BatteryIcon />}
              <span>
                {live.battery} <span className="muted">pil</span>
              </span>
            </div>
          ) : null}
        </div>

        <div className="actions">
          {appUrl ? <OpenInApp appUrl={appUrl} primary /> : null}
          <a className="btn btn-secondary" href={live.mapsUrl} target="_blank" rel="noopener noreferrer" data-testid="maps-link">
            <MapIcon />
            Haritada göster
          </a>
        </div>
        {badges}
        <p className="foot">Salt okunur görünüm. Paylaşım bitince konum bu sayfadan kendiliğinden kalkar.</p>
      </section>
    );
  }

  const text = PHASE_TEXT[phase];
  const status = STATUS_ICON[phase];
  return (
    <section className="sheet sheet-status" aria-label="Bağlantı durumu" data-testid="sheet" data-phase={phase}>
      <div className="grabber" aria-hidden="true" />
      {phase === 'loading' ? (
        <div className="skeleton" aria-hidden="true">
          <span className="sk-avatar" />
          <span className="sk-lines">
            <span className="sk-line" />
            <span className="sk-line sk-short" />
          </span>
        </div>
      ) : status ? (
        <div className={`status-icon tone-${status.tone}`} aria-hidden="true">
          {status.icon}
        </div>
      ) : null}
      <h1 className="status-title" data-testid="status-title">
        {text.title}
      </h1>
      {text.detail ? <p className="status-detail">{text.detail}</p> : null}
      <div className="actions">
        {phase === 'error' ? (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Yeniden dene
          </button>
        ) : null}
        {appUrl && linkUsable(phase) ? <OpenInApp appUrl={appUrl} primary={phase !== 'error'} /> : null}
      </div>
      {badges}
    </section>
  );
}
