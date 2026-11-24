/* global jest */
// Birim testleri yerel modüllere dokunmaz: Firebase ve AsyncStorage sahte uygulamalarla değiştirilir.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
for (const m of ['app', 'auth', 'firestore', 'database', 'functions', 'messaging', 'app-check']) {
  jest.mock(`@react-native-firebase/${m}`, () => ({}), { virtual: false });
}
if (!globalThis.crypto?.getRandomValues) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
}
