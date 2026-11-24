/**
 * Web demo: simüle ekran kilidi. Kilitliyken uygulama native'deki gibi ARKA PLANDA sayılır:
 * `document.visibilityState` "hidden" görünür ve `visibilitychange` olayı tetiklenir → react-native-web
 * `AppState` "background" der → ön plan izleme durur, konum yalnızca arka plan görevinden (ExpoLocationEngine.web)
 * gelir ve core matrisinin ARKA PLAN satırı (ör. hareketsiz: GPS kapalı, nabız 15 dk) uygulanır.
 * Sekme gerçekten gizliyse (başka sekme) tarayıcının değeri geçerlidir.
 */
/** Kilit sayfa yenilenince kalkar (açılışta uygulama her zaman ön planda). */
let locked = false;
let installed = false;
const listeners = new Set<(locked: boolean) => void>();

function realVisibility(): DocumentVisibilityState {
  try {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    const v = d?.get?.call(document) as DocumentVisibilityState | undefined;
    return v ?? 'visible';
  } catch {
    return 'visible';
  }
}

/** `document.visibilityState` / `document.hidden` üzerine kilit durumunu bindirir (bir kez). */
function install(): void {
  if (installed || typeof document === 'undefined' || typeof Document === 'undefined') return;
  installed = true;
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (locked ? 'hidden' : realVisibility()),
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => (locked ? true : realVisibility() === 'hidden'),
    });
  } catch {
    // tarayıcı izin vermiyorsa kilit yalnızca görsel kalır
  }
}

install();

export function demoScreenLocked(): boolean {
  return locked;
}

export function onDemoScreenChange(l: (locked: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setDemoScreenLocked(v: boolean): void {
  install();
  if (locked === v) return;
  locked = v;
  try {
    document.dispatchEvent(new Event('visibilitychange'));
  } catch {
    // olay gönderilemezse AppState bir sonraki gerçek değişiklikte güncellenir
  }
  for (const l of [...listeners]) {
    try {
      l(v);
    } catch {
      // dinleyici hatası kilidi etkilemez
    }
  }
}
