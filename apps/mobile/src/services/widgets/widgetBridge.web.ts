/**
 * Web (demo / tarayıcı): yerel widget yok — tüm işlevler no-op (widgetBridge.ts ile aynı dışa aktarımlar).
 * Widget önizlemeleri demo panelinde (src/demo, Faz6.web.tsx) core `buildWidgetSnapshot` çıktısıyla çizilir.
 */
import type { QuickShareCredential, WidgetCapabilities, WidgetQuickShareEvent } from './widgetBridge';

export type { QuickShareCredential, WidgetCapabilities, WidgetPlatform, WidgetQuickShareEvent } from './widgetBridge';

const WEB_CAPABILITIES: WidgetCapabilities = {
  platform: 'android',
  interactive: false,
  lockScreen: false,
  quickTile: false,
  available: false,
};

export function __setNativeWidgetsModuleForTests(_m: unknown): void {
  // web: yerel modül yok
}

export function isWidgetModuleAvailable(): boolean {
  return false;
}

export function parseWidgetEvents(_raw: unknown): WidgetQuickShareEvent[] {
  return [];
}

export function parseCapabilities(_raw: unknown): WidgetCapabilities {
  return { ...WEB_CAPABILITIES };
}

export async function setSnapshot(_json: string): Promise<void> {}

export function reload(_kind: 'all' = 'all'): void {}

export async function saveAvatar(_uid: string, _localFileUri: string): Promise<string | null> {
  return null;
}

export async function removeAvatar(_uid: string): Promise<void> {}

export async function setQuickShareCredential(_c: QuickShareCredential | null): Promise<void> {}

export async function consumeEvents(): Promise<WidgetQuickShareEvent[]> {
  return [];
}

export function capabilities(): WidgetCapabilities {
  return { ...WEB_CAPABILITIES };
}

export const widgetBridge = {
  setSnapshot,
  reload,
  saveAvatar,
  removeAvatar,
  setQuickShareCredential,
  consumeEvents,
  capabilities,
  isAvailable: isWidgetModuleAvailable,
} as const;
