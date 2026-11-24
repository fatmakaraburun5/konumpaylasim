// @ts-check
/**
 * Metro yapılandırması.
 *
 * @konum/core derlenmiş çıktı değil, TypeScript KAYNAK paketidir ve `file:../../packages/core` ile
 * node_modules/@konum/core altına sembolik bağ olarak gelir. Metro'nun bu dosyaları izleyip
 * dönüştürebilmesi için core klasörü watchFolders'a eklenir.
 */
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, '../../packages/core');
const appNodeModules = path.resolve(projectRoot, 'node_modules');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), coreRoot];
config.resolver.nodeModulesPaths = [appNodeModules, path.resolve(coreRoot, 'node_modules')];

/**
 * core içinden gelen çıplak importlar (`zod`, `libphonenumber-js/min`) önce UYGULAMANIN
 * node_modules'undan çözülür. Böylece pakette tek bir zod kopyası olur; core'un kendi
 * node_modules'u (test araçları için kurulu) yalnızca yedek olarak kalır.
 */
const isInsideCore = (p) =>
  p.startsWith(coreRoot + path.sep) && !p.slice(coreRoot.length).includes(`${path.sep}node_modules${path.sep}`);
/**
 * YALNIZCA web demo: AsyncStorage'ın web uygulaması `localStorage` erişilemezken (korumalı iframe, gizli
 * pencere, engellenmiş site verisi) her çağrıda hata verir. Web paketinde aynı API'yi güvenli depo
 * üzerinden sağlayan src/demo/web/asyncStorage.ts kullanılır. Native (android/ios) çözümleme değişmez.
 */
const webAsyncStorage = path.resolve(projectRoot, 'src/demo/web/asyncStorage.ts');
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolve ?? context.resolveRequest;
  if (platform === 'web' && moduleName === '@react-native-async-storage/async-storage') {
    return { type: 'sourceFile', filePath: webAsyncStorage };
  }
  const isBare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
  if (isBare && isInsideCore(context.originModulePath)) {
    return resolve({ ...context, originModulePath: path.join(projectRoot, 'package.json') }, moduleName, platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
