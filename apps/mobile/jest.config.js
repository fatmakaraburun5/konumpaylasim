/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
  // core kaynakları uygulamanın node_modules'u dışında: babel yardımcıları (@babel/runtime) buradan çözülsün.
  modulePaths: ['<rootDir>/node_modules'],
  // @konum/core bağlantısı node_modules dışında gerçek yola çözülür ve babel ile dönüştürülür.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-firebase|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|zustand))',
  ],
};
