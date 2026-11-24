/**
 * Veri kaynağını seçer. İki kaynak da dinamik içe aktarılır: üretim derlemesinde sahte kaynak
 * (`import.meta.env.MODE === 'mock'` sabiti derlemede `false` olur) pakete hiç girmez, mock
 * derlemesinde de Firebase SDK yüklenmez.
 *
 * Sonuç sayfa başına bir kez üretilir (React StrictMode geliştirmede efekti iki kez çalıştırır;
 * aynı adlı Firebase uygulamasını ikinci kez kurmak hata verir).
 */
import type { WebConfig } from '../env';
import type { LinkLiveSource } from './source';

let pending: Promise<LinkLiveSource | null> | null = null;

export function loadSource(cfg: WebConfig, search: string): Promise<LinkLiveSource | null> {
  pending ??= create(cfg, search);
  return pending;
}

async function create(cfg: WebConfig, search: string): Promise<LinkLiveSource | null> {
  if (import.meta.env.MODE === 'mock') {
    const m = await import('./mockSource');
    return m.createMockSource(m.scenarioFromSearch(search));
  }
  if (!cfg.firebase) return null;
  const f = await import('./firebaseSource');
  return f.createFirebaseSource(cfg.firebase);
}
