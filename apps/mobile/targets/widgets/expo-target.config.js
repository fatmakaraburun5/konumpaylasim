// @ts-check
/**
 * Faz 6: iOS WidgetKit uzantısı (@bacons/apple-targets). `npx expo prebuild` bu klasörü Xcode'a "widgets" hedefi
 * olarak bağlar; kaynaklar burada kalır (ios/ depoya girmez).
 *
 *  - Paket kimliği `${BUNDLE_ID}.widgets` (başında nokta: ana uygulama kimliğine eklenir; BUNDLE_ID app.config.ts).
 *  - App Group `group.${BUNDLE_ID}`: ana uygulamayla aynı (modules/konum-widgets/app.plugin.js yazar). Anahtarlık
 *    paylaşımı da bu App Group kimliğiyle yapılır (ayrı keychain-access-groups yetkisi yok).
 *  - Dağıtım hedefi iOS 17.0 YALNIZCA bu hedefte: etkileşimli widget (Button(intent:)) + AppIntentConfiguration.
 *    Uygulamanın kendi hedefi (Expo varsayılanı 16.4) değişmez; iOS 16'da widget listelenmez, uygulama çalışır.
 *  - Takım kimliği app.config.ts → '@bacons/apple-targets' eklentisine `APPLE_TEAM_ID` ile verilir.
 */
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) throw new Error('[targets/widgets] ios.bundleIdentifier tanımlı değil.');
  return {
    type: 'widget',
    name: 'widgets',
    displayName: 'Konum',
    bundleIdentifier: '.widgets',
    deploymentTarget: '17.0',
    frameworks: ['SwiftUI', 'WidgetKit', 'AppIntents', 'Security', 'ActivityKit'],
    colors: {
      $accent: '#2563EB',
      $widgetBackground: { light: '#FFFFFF', dark: '#111827' },
    },
    entitlements: {
      'com.apple.security.application-groups': [`group.${bundleId}`],
    },
  };
};
