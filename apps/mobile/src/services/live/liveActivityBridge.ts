/**
 * Faz 12: kilit ekranı canlı sayacının yerel köprüsü (modules/konum-widgets).
 *
 *  - iOS 16.2+: ActivityKit `Activity<KonumShareAttributes>` (LiveShareBridge.swift); arayüz WidgetKit uzantısında
 *    (targets/widgets/LiveShareActivity.swift): kilit ekranı kartı + Dynamic Island (kompakt / genişletilmiş / minimal).
 *  - Android: ongoing bildirim (LiveShareNotification.kt): Chronometer geri sayımı, ilerleme çubuğu, pembe/mavi
 *    çerçeveli avatar, "Mola 15 dk" / "Devam et" ve "Durdur" eylemleri; Android 16'da canlı güncelleme (promoted ongoing).
 *
 * Girdi core `LiveShareAttributes` / `LiveShareContent` JSON'udur (snake_case, `v: 1`). Yerel modül yoksa (Expo Go,
 * jest, eski derleme) tüm çağrılar no-op. Web önizlemesi `setLiveActivitySink` ile simülatöre bağlanır.
 * [Varsayım] Yerel kod bu ortamda derlenmedi (Xcode / Android SDK yok).
 */
import type { LiveShareAttributes, LiveShareContent } from '@konum/core';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface LiveActivitySink {
  start(attributes: LiveShareAttributes, content: LiveShareContent): Promise<boolean>;
  update(content: LiveShareContent): Promise<void>;
  /** content null → hemen kaldır; değilse "sona erdi" hâlini göster, `dismissAt`'te kaldır. */
  end(content: LiveShareContent | null, dismissAt: number | null): Promise<void>;
  /** Kullanıcı / sistem canlı etkinliklere izin veriyor mu (iOS ayarı, Android bildirim izni). */
  enabled(): boolean;
}

interface Native {
  liveStart(attributesJson: string, contentJson: string): Promise<boolean>;
  liveUpdate(contentJson: string): Promise<void>;
  liveEnd(contentJson: string | null, dismissAtMs: number | null): Promise<void>;
  liveEnabled(): boolean;
}

let native: Native | null | undefined;
let override: LiveActivitySink | null = null;

function mod(): Native | null {
  if (native === undefined) {
    try {
      const m = requireOptionalNativeModule<Native & Record<string, unknown>>('KonumWidgets');
      native = m && typeof m.liveStart === 'function' ? m : null;
    } catch {
      native = null;
    }
  }
  return native;
}

const nativeSink: LiveActivitySink = {
  start: async (a, c) => {
    const m = mod();
    if (!m) return false;
    try {
      return (await m.liveStart(JSON.stringify(a), JSON.stringify(c))) === true;
    } catch {
      return false;
    }
  },
  update: async (c) => {
    await mod()?.liveUpdate(JSON.stringify(c)).catch(() => undefined);
  },
  end: async (c, at) => {
    await mod()?.liveEnd(c ? JSON.stringify(c) : null, at).catch(() => undefined);
  },
  enabled: () => {
    try {
      return mod()?.liveEnabled() === true;
    } catch {
      return false;
    }
  },
};

/** Web önizlemesi / testler: yerel modül yerine kullanılacak hedef (null = yerel). */
export function setLiveActivitySink(s: LiveActivitySink | null): void {
  override = s;
}

export function liveSink(): LiveActivitySink {
  if (override) return override;
  if (Platform.OS === 'web') return { start: async () => false, update: async () => undefined, end: async () => undefined, enabled: () => false };
  return nativeSink;
}

export function __setNativeLiveModuleForTests(m: Native | null | undefined): void {
  native = m;
}
