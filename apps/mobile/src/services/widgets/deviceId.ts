/**
 * Faz 6: kurulum başına kimlik (widget token'ı cihaza bağlanır: aynı cihazdan yeniden `widget_token_issue` eski
 * token'ı iptal eder; çıkışta yalnızca bu cihazınki iptal edilir). İlk istekte UUID üretilip AsyncStorage'da
 * saklanır; hesaptan bağımsızdır (çıkışta silinmez). Kişisel veri değildir. [Varsayım]
 */
import { uuidV4 } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'konum.device.id.v1';
const RE = /^[A-Za-z0-9_-]{8,128}$/;
let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v && RE.test(v)) return (cached = v);
  } catch {
    // okunamadı: yeni kimlik
  }
  const id = uuidV4();
  cached = id;
  await AsyncStorage.setItem(KEY, id).catch(() => undefined);
  return id;
}
