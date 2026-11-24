/**
 * Faz 3 entegrasyon e2e kütüphanesi: GERÇEK üretim kodu (core + mobil yayıncılar + mobil çevrimdışı kuyruk +
 * mobil düşük pil adımı + backend bekçi taraması) tek CJS paketinde; `faz3.cjs` bunu emülatörlere karşı çalıştırır.
 * Firebase SDK'ları dışarıda (NODE_PATH ile çözülür). `@react-native-async-storage/async-storage` bellek içi taklide
 * yönlendirilir (build.mjs); kuyruk e2e'de kendi bellek deposunu kullanır.
 */
export {
  BatteryLowNotifyResponseSchema,
  CALLABLES,
  DELIVERED_FIELDS,
  LINK_LIVE_FIELDS,
  OUTBOX_LIMITS,
  PATHS,
  TRAIL_FIELDS,
  DeliveredLocationSchema,
  emptyOutbox,
  lastVerifiedLocation,
  linkSenderName,
  livePath,
  linkLivePath,
  normalizeSample,
  parseLinkLive,
  receiverStatusOf,
  selectTrackingPlan,
  initialMotion,
  toQueuedDeliveredWrite,
  safeRecordedAt,
  lowBatteryPushText,
  outboxTargetId,
} from '../../../../packages/core/src/index';
export { publishSample } from '../../../mobile/src/services/firebase/publisher';
export { publishLinkSample } from '../../../mobile/src/services/firebase/linkPublisher';
export { createOutboxRepo } from '../../../mobile/src/services/outbox/outboxRepo';
export { emptyPersisted } from '../../../mobile/src/services/outbox/outboxStore';
export { stepLowBattery } from '../../../mobile/src/services/location/adaptive/adaptiveCore';
export { parseTrail } from '../../../mobile/src/services/firebase/liveRepo';
export { sweepStalls, decideNudge } from '../../../../backend/functions/src/handlers/watchdog';
export { closeAdmin, db as adminDb, rtdb as adminRtdb, adminAuth } from '../../../../backend/functions/src/admin';
