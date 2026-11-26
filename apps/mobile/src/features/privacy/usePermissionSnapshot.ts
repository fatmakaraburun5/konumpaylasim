import type { PermissionSnapshot } from '@konum/core';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { readPermissionSnapshot } from '../../services/permissions/permissionCenter';

/** Cihaz izinleri; açılışta ve uygulama öne her geldiğinde (Ayarlar'dan dönüş) yeniden okunur. */
export function usePermissionSnapshot(): { snapshot: PermissionSnapshot | null; refresh: () => Promise<PermissionSnapshot | null> } {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const refresh = useCallback(async () => {
    try {
      const s = await readPermissionSnapshot();
      setSnapshot(s);
      return s;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);
  return { snapshot, refresh };
}
