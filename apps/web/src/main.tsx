/**
 * Giriş. Sıra bilerek böyle:
 *   1. Token adresten okunur ve SİLİNİR (Firebase ve Maps JS adresi görmeden önce).
 *   2. Token geçerliyse veri kaynağı (Firebase RTDB ya da mock) tembel yüklenir.
 *   3. Sayfa çizilir. Token hiçbir yerde günlüğe yazılmaz.
 */
import './zodSetup'; // önce: core şemaları yüklenmeden zod JIT kapanır
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { config } from './env';
import { loadSource } from './data/loadSource';
import type { LinkLiveSource } from './data/source';
import { consumeToken, type StorageLike } from './token';
import './styles.css';

function sessionStore(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const search = window.location.search; // yalnızca mock senaryosu için; adres aşağıda temizlenir
const resolved = consumeToken(window.location, sessionStore(), window.history);

function Root() {
  const [source, setSource] = useState<LinkLiveSource | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!resolved.hash) return;
    let cancelled = false;
    loadSource(config, search)
      .then((s) => {
        if (cancelled) return;
        if (s) setSource(s);
        else setFailed(true); // Firebase yapılandırması eksik
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  return <App config={config} resolved={resolved} source={source} sourceFailed={failed} />;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
