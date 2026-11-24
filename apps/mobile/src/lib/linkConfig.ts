/**
 * Bağlantı (QR) alan adı: `app.config.ts` → `extra.linkDomain` (ortam değişkeni `LINK_DOMAIN`,
 * yoksa core `LINK_DOMAIN_DEFAULT`). Aynı değer iOS Associated Domains ve Android App Links
 * (`autoVerify`) için kullanılır; QR'daki URL'yi sunucu üretir (`buildLinkUrl`).
 *
 * Gelen bağlantı ayrıştırılırken (core `parseLinkToken`) YALNIZCA bu alan(lar) kabul edilir.
 */
import { LINK_DOMAIN_DEFAULT, normalizeLinkDomain } from '@konum/core';
import Constants from 'expo-constants';

/** Uygulamanın kabul ettiği bağlantı alan adları (normalize, tekrarsız). */
export function linkDomains(): string[] {
  let configured: unknown;
  try {
    configured = (Constants.expoConfig?.extra as { linkDomain?: unknown } | undefined)?.linkDomain;
  } catch {
    configured = undefined;
  }
  const out = new Set<string>();
  const add = (d: unknown) => {
    const n = typeof d === 'string' ? normalizeLinkDomain(d) : null;
    if (n) out.add(n);
  };
  add(configured);
  if (out.size === 0) add(LINK_DOMAIN_DEFAULT);
  return [...out];
}
