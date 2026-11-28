/**
 * Faz 12: kilit ekranı canlı sayacının / Android canlı bildiriminin eylem bağlantısı:
 * `konum://live?action=stop|break15|resume|open&session=<oturum>`.
 *
 * Kök düzeydedir: eylem uygulanır ve ana ekrana dönülür. Oturum yoksa (çıkış yapılmış) yalnızca ana ekran açılır.
 * "Durdur" yalnızca öndeki oturumu durdurur; tümünü durdurmak kitapçıktaki iki adımlı "Tümünü durdur"dadır.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { handleLiveAction } from '../src/services/f12Services';
import { authStore } from '../src/state/authStore';

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const ACTIONS = new Set(['stop', 'break15', 'resume', 'open']);
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export default function LiveActionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string | string[]; session?: string | string[] }>();
  useState(() => {
    const action = one(params.action);
    const session = one(params.session);
    if (ACTIONS.has(action) && action !== 'open' && authStore.getState().status === 'ready') {
      void handleLiveAction(action, SESSION_RE.test(session) ? session : null);
    }
    return true;
  });
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);
  return null;
}
