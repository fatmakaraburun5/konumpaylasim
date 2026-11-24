// babel-preset-expo; expo-router ve react-native-worklets (Reanimated 4) eklentilerini kendisi ekler.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
