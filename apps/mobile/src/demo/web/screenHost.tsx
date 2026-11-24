/**
 * Web demo: telefon ekranının "kaplama" katmanı. RN `Modal` web'de `document.body`'ye açılır ve geniş ekranda telefon
 * çerçevesinin dışına taşar; web kardeşleri (ör. PermissionFlow.web.tsx) tam ekran kaplamalarını bunun yerine bu
 * katmana portal ile çizer. Katmanı demo kabuğu (DemoShell.web.tsx) kaydeder; kayıt yoksa `document.body`.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
// @ts-expect-error react-dom tür paketi kurulu değil (yalnızca web demo kullanır; react-native-web'in kendi bağımlılığı)
import { createPortal as reactDomCreatePortal } from 'react-dom';

const createPortal = reactDomCreatePortal as (children: ReactNode, container: Element) => ReactElement;

let host: HTMLElement | null = null;
const listeners = new Set<(el: HTMLElement | null) => void>();

export function setScreenHost(el: HTMLElement | null): void {
  if (host === el) return;
  host = el;
  for (const l of [...listeners]) l(el);
}

export function useScreenHost(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(host);
  useEffect(() => {
    setEl(host);
    listeners.add(setEl);
    return () => {
      listeners.delete(setEl);
    };
  }, []);
  return el ?? (typeof document !== 'undefined' ? document.body : null);
}

/** Çocukları telefon ekranı katmanına çizer (Modal yerine). Katman yoksa hiçbir şey çizmez. */
export function ScreenPortal({ children }: { children: ReactNode }): ReactElement | null {
  const el = useScreenHost();
  return el ? createPortal(children, el) : null;
}
