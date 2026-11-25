/**
 * Web demo · Faz 6: demo sunucusu durumundan core `buildWidgetSnapshot` girdisine SAF eşleme (test edilebilir; RN /
 * expo bağımlılığı yok). Gerçek uygulamada bu girdiyi `services/widgets/widgetSync.ts` store'lardan kurar; demo
 * paneli aynı core fonksiyonunu sunucunun gördüğü durumla besler.
 *
 *  - `avatar_file`: yerel kod `saveAvatar(uid, dosya)` ile paylaşılan kapsayıcıya `{uid}_{sürüm}.jpg` yazar; demo
 *    aynı adı üretir ve önizleme dosya adını küçük avatarın yerel adresine çevirir (`files`).
 *  - `place`: arkadaş BENİM bölgelerimden birinin içindeyse bölge adı (Faz 5), değilse kısa adres; ham koordinat
 *    snapshot'a girmez (core `safePlaceLabel` ayrıca süzer).
 */
import {
  haversineM,
  type EpochMs,
  type LatLng,
  type QuickShareOpenReason,
  type QuickShareSource,
  type WidgetBuildInput,
} from '@konum/core';
import type { DemoWidgetSource } from '../server/server';

export interface DemoWidgetOptions {
  now: EpochMs;
  signed_in: boolean;
  token_expires_at: EpochMs | null;
  bg_location_ok: boolean;
  lock_screen_details: boolean;
  /** Konum → kısa etiket (bölge adı ya da adres). */
  placeOf: (p: LatLng) => string | null;
}

export function demoWidgetInput(src: DemoWidgetSource, o: DemoWidgetOptions): { input: WidgetBuildInput; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const friends: WidgetBuildInput['friends'][number][] = src.friends.map((f) => {
    const file = f.avatar_thumb_url ? `${f.uid}_${f.avatar_version ?? 0}.jpg` : null;
    if (file && f.avatar_thumb_url) files[file] = f.avatar_thumb_url;
    return {
      uid: f.uid,
      display_name: f.display_name,
      gender: f.gender,
      avatar_file: file,
      incoming: f.incoming
        ? {
            active: f.incoming.active,
            paused: false,
            last_seen_at: f.incoming.last_seen_at,
            battery_pct: f.incoming.battery_pct,
            place: f.incoming.position ? o.placeOf(f.incoming.position) : null,
          }
        : null,
    };
  });
  return {
    input: {
      now: o.now,
      signed_in: o.signed_in,
      me: src.profile && src.profile.display_name.trim() ? { display_name: src.profile.display_name } : null,
      favorite_ids: src.favorite_ids,
      friends,
      outgoing: src.outgoing,
      quick: { token_expires_at: o.token_expires_at, bg_location_ok: o.bg_location_ok },
      privacy: { lock_screen_details: o.lock_screen_details },
    },
    files,
  };
}

/** Bölge içindeyse bölge adı (en küçük yarıçaplı), değilse null. */
export function zoneLabelAt(p: LatLng, zones: readonly { name: string; center: LatLng; radius_m: number; enabled: boolean }[]): string | null {
  let best: { name: string; r: number } | null = null;
  for (const z of zones) {
    if (!z.enabled) continue;
    if (haversineM(p, z.center) <= z.radius_m && (!best || z.radius_m < best.r)) best = { name: z.name, r: z.radius_m };
  }
  return best?.name ?? null;
}

/** Uygulamayı açma gerekçesinin kısa Türkçe metni (widget geri bildirimi / panel). */
export const OPEN_REASON_TEXT: Record<QuickShareOpenReason, string> = {
  signed_out: 'Giriş yapılmamış: uygulama açılıyor',
  no_favorite: 'Favori seçilmemiş: uygulamada favori seç',
  no_token: 'Widget oturumu yok: uygulama açılıyor',
  token_expiring: 'Widget oturumu dolmak üzere: uygulama açılıyor',
  no_bg_location: "'Her Zaman' konum izni yok: uygulama açılıyor",
  ios_too_old: 'Etkileşimli widget yok (iOS 16): uygulama açılıyor',
  error_fallback: 'Arka planda başlatılamadı: uygulama açılıyor',
};

export const SOURCE_TEXT: Record<QuickShareSource, string> = {
  ios_widget: 'iOS widget',
  ios_lock: 'iOS kilit ekranı',
  android_widget: 'Android widget',
  android_tile: 'Android hızlı ayar',
};

/** Ad → ilk ad (dar widget sütunları). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;
