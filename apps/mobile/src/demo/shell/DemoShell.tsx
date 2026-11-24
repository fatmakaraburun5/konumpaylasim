/**
 * Native: demo kabuğu yoktur, uygulama olduğu gibi çizilir. Web karşılığı `DemoShell.web.tsx`
 * (telefon çerçevesi, demo kontrolleri, simüle bildirim kartı) yalnızca tarayıcı paketine girer.
 */
import type { ReactNode } from 'react';

export function DemoShell({ children }: { children: ReactNode }) {
  return children;
}
