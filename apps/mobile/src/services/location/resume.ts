/**
 * Faz 3: takibi yeniden ayağa kaldırma (sunucu bekçisinin `resume_tracking` sessiz push'u, ön plana dönüş).
 *
 * Bekçi (backend watchdog) gönderenin canlı paketleri beklenen `hb`'den uzun süre gelmeyince gönderenin KENDİ
 * cihazına yalnızca veri içeren yüksek öncelikli push gönderir. Burada:
 *  1. Kalıcı hedef yoksa hiçbir şey yapılmaz (paylaşım bitmiş: push geç kalmış).
 *  2. Uyarlamalı zamanlayıcı ayağa kalkar; arka plan görevi çalışmıyorsa (OS öldürdü) plan yeniden uygulanır.
 *     iOS: arka planda yeniden başlatma serbest (Always izniyle). Android: expo-location arka planda ön plan
 *     servisi BAŞLATAMAZ (`ForegroundServiceStartNotAllowedException`) → hata yutulur; görünür "duraksadı"
 *     bildirimi (tracking_stalled) kullanıcıyı uygulamaya getirir. [Varsayım: cihazda doğrulanmalı]
 *  3. Tek seferlik ölçüm hattan geçer (kalp atışı) ve çevrimdışı kuyruk boşaltılır.
 * Faz 8: yayın kesme anahtarı (görünmez mod / onay kapısı) açıksa takip AYAĞA KALDIRILMAZ; hat hedefleri boşaltır.
 */
import { loadTargets } from '../../state/persist';
import { hydratePublishHold, isPublishHeld } from '../../state/publishHold';
import { ensureAdaptiveRuntime } from './adaptive/runtime';
import { locationEngine } from './ExpoLocationEngine';
import { applyPublishHold, applyTrackingNow, flushOutbox, handleSamples } from './pipeline';

export async function resumeTracking(reason: 'push' | 'foreground'): Promise<void> {
  await hydratePublishHold();
  if (isPublishHeld()) {
    await applyPublishHold().catch(() => undefined);
    return;
  }
  const persisted = await loadTargets();
  if (!persisted.uid || (persisted.targets.length === 0 && persisted.linkTargets.length === 0)) return;
  ensureAdaptiveRuntime();
  const running = await locationEngine.isBackgroundRunning().catch(() => false);
  if (!running && locationEngine.canReconfigureNow()) await applyTrackingNow().catch(() => undefined);
  const raw = await locationEngine.getCurrentSample();
  if (raw) await handleSamples([raw], 'heartbeat');
  await flushOutbox(reason === 'push');
}
