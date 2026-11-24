/**
 * Callable taşıma katmanı (Cloud Functions, bölge: europe-west1).
 *
 * `callables.ts` istek/yanıt doğrulamasını, op_id'yi ve yeniden denemeyi yapar; ağ çağrısının kendisi
 * buradadır. Web demo derlemesi aynı adla `callTransport.web.ts` sağlar (bellek içi demo sunucusu).
 */
import type { CallableName } from '@konum/core';
import { getApp } from '@react-native-firebase/app';
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';
import { ensureFirebase, FUNCTIONS_REGION } from './init';

export type CallTransport = (name: CallableName, payload: unknown) => Promise<unknown>;

/** [Varsayım] İstemci zaman aşımı; soğuk başlangıç (cold start) payı dahil. */
const CALL_TIMEOUT_MS = 15_000;

export const defaultCallTransport: CallTransport = async (name, payload) => {
  await ensureFirebase();
  const fn = httpsCallable(getFunctions(getApp(), FUNCTIONS_REGION), name, { timeout: CALL_TIMEOUT_MS });
  const res = await fn(payload);
  return res.data;
};
