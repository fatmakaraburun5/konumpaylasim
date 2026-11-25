/**
 * Faz 6: widget / kilit ekranı / Android hızlı ayar kutucuğunun uygulamayı açtığı derin bağlantı:
 * `konum://quick-share?to=<uid>&src=<kaynak>` (core `quickShareDeepLink`).
 *
 * Kök düzeydedir (kimlik kapısının dışında): istek `quickShareStore.pending`'e yazılır ve ana ekrana dönülür;
 * (main) yerleşimindeki onay kartı (QuickShareSheet) oturum + arkadaş listesi hazır olunca paylaşımı başlatır.
 * Oturum yoksa (main) giriş ekranına yönlendirir; istek girişten sonra da (kısa süre) bekler.
 * Uygulama açıkken bağlantı bu ekranı yığının üstüne iter: geri dönülür (ikinci bir ana ekran açılmaz).
 */
import { parseQuickShareDeepLink } from '@konum/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { now } from '../src/lib/clock';
import { quickShareStore } from '../src/state/quickShareStore';

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

export default function QuickShareRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ to?: string | string[]; src?: string | string[] }>();
  // İlk çizimde (çocuk yönlendirmelerinden önce) bekleyen istek yazılır.
  useState(() => {
    const parsed = parseQuickShareDeepLink(`konum://quick-share?to=${encodeURIComponent(one(params.to))}&src=${encodeURIComponent(one(params.src))}`);
    if (parsed) quickShareStore.getState().setPending({ ...parsed, at: now() });
    return true;
  });
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);
  return null;
}
