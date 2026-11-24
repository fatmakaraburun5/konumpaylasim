/**
 * Konum izni adaptörü (expo-location). permissionsStore izinleri bu modül üzerinden okur/ister; web demo
 * derlemesi aynı adla `locationPermissions.web.ts` sağlar (tarayıcı konumu İSTENMEZ, izinler simüle edilir).
 */
export {
  getBackgroundPermissionsAsync,
  getForegroundPermissionsAsync,
  requestBackgroundPermissionsAsync,
  requestForegroundPermissionsAsync,
} from 'expo-location';
