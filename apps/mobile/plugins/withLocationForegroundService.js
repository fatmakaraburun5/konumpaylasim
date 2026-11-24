// @ts-check
/**
 * Yerel config eklentisi: expo-location'ın arka plan konum servisini uygulama manifestinde
 * AÇIKÇA `foregroundServiceType="location"` ile bildirir.
 *
 * expo-location bu servisi kendi kütüphane manifestinde zaten tanımlıyor ve Gradle manifest
 * birleştirmesi bunu uygulamaya taşıyor. Burada tekrar yazmamızın iki nedeni var:
 *  1. `expo prebuild` çıktısında (android/app/src/main/AndroidManifest.xml) doğrulanabilir olsun.
 *  2. Android 14+ (API 34) ön plan servisi türü zorunlu; kütüphane manifesti değişirse
 *     uygulama sessizce çökmesin (aynı ad + aynı değer birleştirmede çakışma yaratmaz).
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const SERVICE_NAME = 'expo.modules.location.services.LocationTaskService';

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withLocationForegroundService = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    manifest.manifest.$['xmlns:tools'] = manifest.manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    /** @type {any[]} */
    const services = (app.service = app.service ?? []);
    const existing = services.find((s) => s.$?.['android:name'] === SERVICE_NAME);
    const attrs = {
      'android:name': SERVICE_NAME,
      'android:exported': 'false',
      'android:foregroundServiceType': 'location',
      'tools:node': 'merge',
    };
    if (existing) existing.$ = { ...existing.$, ...attrs };
    else services.push({ $: attrs });
    return cfg;
  });

module.exports = withLocationForegroundService;
