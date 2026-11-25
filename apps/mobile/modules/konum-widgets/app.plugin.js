// @ts-check
/**
 * Faz 6: widget modülünün config eklentisi (app.config.ts `plugins` içinde '@bacons/apple-targets'TAN ÖNCE gelmeli).
 *
 * iOS
 *  - App Group `group.<BUNDLE_ID>` uygulama yetkilerine eklenir (`ios.entitlements` ZAMANUYUMLU yazılır:
 *    @bacons/apple-targets widget hedefini kurarken aynı değeri okur; targets/widgets/expo-target.config.js de aynı
 *    kimliği paket kimliğinden türetir).
 *  - Info.plist `KonumAppGroup`: yerel modül (KonumWidgetsModule.swift) App Group kimliğini buradan okur.
 *  - Anahtarlık: hızlı paylaşım belirteci App Group kimliğiyle (`kSecAttrAccessGroup = group.<BUNDLE_ID>`) yazılır.
 *    Apple, application-groups değerlerini anahtarlık erişim grubu olarak da kabul eder; bu yüzden AYRI bir
 *    `keychain-access-groups` yetkisi EKLENMEZ (eklenseydi listedeki ilk grup tüm anahtarlık öğelerinin varsayılan
 *    grubu olurdu ve Firebase Auth / expo-secure-store öğelerinin yeri değişirdi). [Varsayım: cihazda doğrulanmalı]
 *
 * Android (manifest birleştirmesi yerine uygulama manifestine açıkça yazılır: prebuild çıktısında görünür)
 *  - KonumWidgetSmallProvider (2x2) / KonumWidgetLargeProvider (4x2): APPWIDGET_UPDATE alıcıları + sağlayıcı XML'i.
 *  - QuickShareReceiver: widget düğmesinin PendingIntent'i (dışa kapalı).
 *  - QuickShareTileService: Hızlı Ayarlar "Konum: 1 sa paylaş" kutucuğu (BIND_QUICK_SETTINGS_TILE).
 *  - Yeni çalışma zamanı izni yok. `konum://` derin bağlantı şeması zaten app.config.ts `scheme` ile var.
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const APP_GROUP_KEY = 'com.apple.security.application-groups';
const PKG = 'expo.modules.konumwidgets';

/** @param {string} bundleId */
function appGroupFor(bundleId) {
  return `group.${bundleId}`;
}

/**
 * Aynı `android:name` varsa öznitelikleri günceller, yoksa ekler.
 * @param {any[]} list
 * @param {any} entry
 */
function upsertByName(list, entry) {
  const name = entry.$['android:name'];
  const i = list.findIndex((x) => x?.$?.['android:name'] === name);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
}

/** @param {string} cls @param {string} label @param {string} info */
function widgetReceiver(cls, label, info) {
  return {
    $: { 'android:name': `${PKG}.${cls}`, 'android:exported': 'false', 'android:label': label },
    'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
    'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': info } }],
  };
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withKonumWidgets = (config) => {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) throw new Error('[konum-widgets] ios.bundleIdentifier tanımlı değil: App Group türetilemez.');
  const group = appGroupFor(bundleId);

  // --- iOS: zamanuyumlu yapılandırma (mod değil) — apple-targets eklentisi değerlendirilirken görünür olmalı.
  config.ios = config.ios ?? {};
  const entitlements = { ...(config.ios.entitlements ?? {}) };
  const groups = Array.isArray(entitlements[APP_GROUP_KEY]) ? entitlements[APP_GROUP_KEY] : [];
  entitlements[APP_GROUP_KEY] = [...new Set([...groups, group])];
  config.ios.entitlements = entitlements;
  config.ios.infoPlist = { ...(config.ios.infoPlist ?? {}), KonumAppGroup: group };

  // --- Android: manifest bileşenleri.
  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    /** @type {any[]} */
    const receivers = (app.receiver = app.receiver ?? []);
    /** @type {any[]} */
    const services = (app.service = app.service ?? []);

    upsertByName(receivers, widgetReceiver('KonumWidgetSmallProvider', '@string/konum_w_small_label', '@xml/konum_widget_small_info'));
    upsertByName(receivers, widgetReceiver('KonumWidgetLargeProvider', '@string/konum_w_large_label', '@xml/konum_widget_large_info'));
    upsertByName(receivers, { $: { 'android:name': `${PKG}.QuickShareReceiver`, 'android:exported': 'false' } });
    upsertByName(services, {
      $: {
        'android:name': `${PKG}.QuickShareTileService`,
        'android:exported': 'true',
        'android:label': '@string/konum_w_tile_label',
        'android:icon': '@drawable/konum_w_ic_tile',
        'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
      },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.service.quicksettings.action.QS_TILE' } }] }],
      // Etkin kutucuk değil: sistem dinleme durumunu yalnızca panel açıkken / requestListeningState ile verir.
      'meta-data': [{ $: { 'android:name': 'android.service.quicksettings.ACTIVE_TILE', 'android:value': 'false' } }],
    });
    return cfg;
  });

  return config;
};

module.exports = withKonumWidgets;
module.exports.appGroupFor = appGroupFor;
