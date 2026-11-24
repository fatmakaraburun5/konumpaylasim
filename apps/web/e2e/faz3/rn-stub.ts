/** e2e: React Native modüllerinin Node taklidi (yalnızca içe aktarma çözülsün diye; e2e bunları çağırmaz). */
const mem = new Map<string, string>();
const AsyncStorage = {
  getItem: async (k: string) => mem.get(k) ?? null,
  setItem: async (k: string, v: string) => void mem.set(k, v),
  removeItem: async (k: string) => void mem.delete(k),
};
export default AsyncStorage;
const unavailable = () => {
  throw new Error('e2e: @react-native-firebase kullanılmaz (istemci SDK = firebase/database)');
};
export const getDatabase = unavailable;
export const onChildAdded = unavailable;
export const onChildChanged = unavailable;
export const onChildRemoved = unavailable;
export const onValue = unavailable;
export const ref = unavailable;
export const update = unavailable;
