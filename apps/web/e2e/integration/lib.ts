/**
 * Entegrasyon e2e kütüphanesi: GERÇEK üretim kodunu (core + mobil yayıncı + backend tarayıcı) tek CJS paketine
 * toplar; e2e.cjs bunu emülatörlere karşı çalıştırır. Firebase SDK'ları dışarıda (NODE_PATH ile çözülür).
 */
export {
  LINK_LIVE_FIELDS,
  LINK_VIEW_TEXT,
  LinkShareCreateResponseSchema,
  LinkShareUpdateResponseSchema,
  buildLinkUrl,
  linkSenderName,
  linkTokenHash,
  normalizeSample,
  parseLinkLive,
  parseLinkToken,
  selectLinkPublishTargets,
} from '../../../../packages/core/src/index';
export { publishLinkSample } from '../../../mobile/src/services/firebase/linkPublisher';
export { LinkDocSchema, toLinkView } from '../../../mobile/src/services/firebase/linkDoc';
export { resolveLinkParam, linkViewerModel } from '../../../mobile/src/features/link/linkViewerModel';
export { sweepExpired } from '../../../../backend/functions/src/handlers/sweeper';
export { closeAdmin, db as adminDb, rtdb as adminRtdb, adminAuth } from '../../../../backend/functions/src/admin';
