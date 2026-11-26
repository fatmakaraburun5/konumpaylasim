/**
 * Web demo callable taşıması: istek bellek içi demo sunucusuna gider (150–400 ms gecikme, op_id
 * tekilleştirme, core şemalarıyla doğrulama ve `HttpsError` biçimli hatalar sunucuda).
 * Faz 3: simüle bağlantı yokken ("Tünele gir") istek sunucuya ULAŞMAZ ve `unavailable` (yeniden denenebilir) döner;
 * düşük pil çağrısı uygulamanın kuyruğunda bekler, bağlantı gelince aynı op_id ile gider.
 */
import type { CallableName } from '@konum/core';
import { demoServer, DemoHttpsError } from '../../demo/server';
import { demoOnline } from '../../demo/web/network';
import { demoCurrentDsid, demoCurrentUid } from '../../demo/web/session';
import { ensureFirebase } from './init';

export type CallTransport = (name: CallableName, payload: unknown) => Promise<unknown>;

/** Çevrimdışı çağrının başarısız olma gecikmesi (gerçek SDK zaman aşımından kısa; demo beklemesin). */
const OFFLINE_FAIL_MS = 1_200;

export const defaultCallTransport: CallTransport = async (name, payload) => {
  await ensureFirebase();
  if (!demoOnline()) {
    await new Promise((r) => setTimeout(r, OFFLINE_FAIL_MS));
    throw new DemoHttpsError('unavailable', 'Bağlantı yok');
  }
  return demoServer().call(name, payload, demoCurrentUid(), demoCurrentDsid());
};
