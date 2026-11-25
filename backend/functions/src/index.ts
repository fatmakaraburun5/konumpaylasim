/**
 * Konum Cloud Functions giriş noktası (Faz 1 + Faz 2 + Faz 3 + Faz 4 + Faz 5 + Faz 6 + Faz 8). Dışa aktarılan adlar core `CALLABLES` ile birebir aynıdır
 * (istemci `httpsCallable(functions, 'share_start')` çağırır, bölge europe-west1).
 *
 * Burada YALNIZCA fonksiyon tanımları dışa aktarılır; saf mantık `handlers/*` içindedir.
 */
import {
  FriendRequestRespondSchema,
  FriendRequestSendSchema,
  GeocodeReverseRequestSchema,
  LinkShareCreateRequestSchema,
  LinkShareExtendRequestSchema,
  LinkShareStopRequestSchema,
  LocationRequestRespondSchema,
  LocationRequestSendSchema,
  RouteComputeRequestSchema,
  ShareExtendRequestSchema,
  ShareRevokeRequestSchema,
  ShareStartRequestSchema,
  ShareStopRequestSchema,
  // Faz 4
  EmergencyContactsSetRequestSchema,
  PingSendRequestSchema,
  PlaceNoteDeleteRequestSchema,
  PlaceNoteUpsertRequestSchema,
  SosAckRequestSchema,
  SosResolveRequestSchema,
  SosSendRequestSchema,
  SosUpdateRequestSchema,
  // Faz 5
  MeetupCancelRequestSchema,
  MeetupRespondRequestSchema,
  MeetupShareRequestSchema,
  MeetupSuggestRequestSchema,
  ZoneDeleteRequestSchema,
  ZoneEventReportRequestSchema,
  ZoneUpsertRequestSchema,
  // Faz 6
  FavoritesSetRequestSchema,
  WidgetQuickShareRequestSchema,
  WidgetTokenIssueRequestSchema,
  WidgetTokenRevokeRequestSchema,
  // Faz 8
  ConsentAcceptRequestSchema,
  ConsentWithdrawSchema,
  InvisibleSetRequestSchema,
  PermissionRequestRespondSchema,
  PermissionRequestSendSchema,
  PermissionSetSchema,
} from '@konum/core';
import { setGlobalOptions } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/firestore';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/scheduler';
import { onTaskDispatched } from 'firebase-functions/tasks';
import { reconcileShare } from './acl';
import { callable, tokenCallable } from './callable';
import { MAPS_CALLABLE_SECRETS, MAX_INSTANCES, REGION } from './config';
import type { LinkShareDoc, ShareDoc } from './docs';
import {
  friendRequestCancel,
  friendRequestRespond,
  friendRequestSend,
  friendshipRemove,
  userBlock,
  userUnblock,
} from './handlers/friends';
import { handleLinkExpiryTask, linkShareCreate, linkShareExtend, linkShareStop } from './handlers/links';
import { batteryLowNotify } from './handlers/battery';
import { geocodeReverseHandler, routeComputeHandler } from './handlers/maps';
import { locationRequestRespond, locationRequestSend } from './handlers/requests';
import { shareExtend, shareRevoke, shareStart, shareStop } from './handlers/shares';
import { handleExpiryTask, isAuditSlot, sweepExpired } from './handlers/sweeper';
import { accountDelete, inviteCodeRegenerate, sweepInactive, userBootstrap } from './handlers/user';
import { sweepStalls } from './handlers/watchdog';
import { placeNoteDelete, placeNoteUpsert } from './handlers/notes';
import { pingSend } from './handlers/ping';
import { emergencyContactsSet, sosAck, sosResolve, sosSend, sosUpdate } from './handlers/sos';
import { meetupCancel, meetupRespond, meetupShare, meetupSuggest } from './handlers/meetup';
import { zoneDelete, zoneEventReport, zoneUpsert } from './handlers/zones';
import { favoritesSet } from './handlers/favorites';
import { notifyWidgetRefresh, widgetQuickShare, widgetTokenIssue, widgetTokenRevoke } from './handlers/widget';
import {
  consentAccept,
  consentWithdraw,
  invisibleSet,
  permissionRequestRespond,
  permissionRequestSend,
  permissionSet,
} from './handlers/access';
import {
  AccountDeleteSchema,
  BatteryLowNotifySchema,
  FriendRequestCancelSchema,
  FriendshipRemoveSchema,
  InviteCodeRegenerateSchema,
  UserBlockSchema,
  UserBootstrapSchema,
  UserUnblockSchema,
} from './schemas';
import { reconcileLink } from './linkAcl';
import type { ExpiryTaskPayload } from './tasks';

setGlobalOptions({ region: REGION, maxInstances: MAX_INSTANCES });

// --- hesap ---
export const user_bootstrap = callable('user_bootstrap', UserBootstrapSchema, userBootstrap);
export const invite_code_regenerate = callable('invite_code_regenerate', InviteCodeRegenerateSchema, inviteCodeRegenerate);
export const account_delete = callable('account_delete', AccountDeleteSchema, accountDelete);

// --- arkadaşlık ---
export const friend_request_send = callable('friend_request_send', FriendRequestSendSchema, friendRequestSend);
export const friend_request_respond = callable('friend_request_respond', FriendRequestRespondSchema, friendRequestRespond);
export const friend_request_cancel = callable('friend_request_cancel', FriendRequestCancelSchema, friendRequestCancel);
export const friendship_remove = callable('friendship_remove', FriendshipRemoveSchema, friendshipRemove);
export const user_block = callable('user_block', UserBlockSchema, userBlock);
export const user_unblock = callable('user_unblock', UserUnblockSchema, userUnblock);

// --- paylaşım ---
export const share_start = callable('share_start', ShareStartRequestSchema, shareStart);
export const share_extend = callable('share_extend', ShareExtendRequestSchema, shareExtend);
export const share_stop = callable('share_stop', ShareStopRequestSchema, shareStop);
export const share_revoke = callable('share_revoke', ShareRevokeRequestSchema, shareRevoke);

// --- konum isteği ---
export const location_request_send = callable('location_request_send', LocationRequestSendSchema, locationRequestSend);
export const location_request_respond = callable('location_request_respond', LocationRequestRespondSchema, locationRequestRespond);

// --- Faz 2: bağlantı (QR) paylaşımı ---
export const link_share_create = callable('link_share_create', LinkShareCreateRequestSchema, linkShareCreate);
export const link_share_extend = callable('link_share_extend', LinkShareExtendRequestSchema, linkShareExtend);
export const link_share_stop = callable('link_share_stop', LinkShareStopRequestSchema, linkShareStop);

// --- Faz 2: Google Maps sunucu vekili (anahtar Secret Manager'da) ---
export const route_compute = callable('route_compute', RouteComputeRequestSchema, routeComputeHandler, {
  secrets: MAPS_CALLABLE_SECRETS,
});
export const geocode_reverse = callable('geocode_reverse', GeocodeReverseRequestSchema, geocodeReverseHandler, {
  secrets: MAPS_CALLABLE_SECRETS,
});

// --- Faz 3: düşük pil bildirimi ---
export const battery_low_notify = callable('battery_low_notify', BatteryLowNotifySchema, (ctx, data) => batteryLowNotify(ctx, data));

// --- Faz 4: ping, yer notu, acil durum ---
export const ping_send = callable('ping_send', PingSendRequestSchema, (ctx, data) => pingSend(ctx, data));
export const place_note_upsert = callable('place_note_upsert', PlaceNoteUpsertRequestSchema, placeNoteUpsert);
export const place_note_delete = callable('place_note_delete', PlaceNoteDeleteRequestSchema, placeNoteDelete);
export const emergency_contacts_set = callable('emergency_contacts_set', EmergencyContactsSetRequestSchema, emergencyContactsSet);
/** Adres sunucuda aranabilir (önbellek → Google, ≤ 2 sn, kota dışı): Maps secret'ı gerekir. */
export const sos_send = callable('sos_send', SosSendRequestSchema, (ctx, data) => sosSend(ctx, data), { secrets: MAPS_CALLABLE_SECRETS });
export const sos_update = callable('sos_update', SosUpdateRequestSchema, (ctx, data) => sosUpdate(ctx, data), { secrets: MAPS_CALLABLE_SECRETS });
export const sos_resolve = callable('sos_resolve', SosResolveRequestSchema, (ctx, data) => sosResolve(ctx, data));
export const sos_ack = callable('sos_ack', SosAckRequestSchema, (ctx, data) => sosAck(ctx, data));

// --- Faz 5: bölgeler (varış / ayrılış tetikleyicileri) ve buluşma noktası ---
export const zone_upsert = callable('zone_upsert', ZoneUpsertRequestSchema, zoneUpsert);
export const zone_delete = callable('zone_delete', ZoneDeleteRequestSchema, zoneDelete);
export const zone_event_report = callable('zone_event_report', ZoneEventReportRequestSchema, (ctx, data) => zoneEventReport(ctx, data));
/** Places API (New) + Routes computeRouteMatrix sunucu vekili: Maps secret'ı gerekir. */
export const meetup_suggest = callable('meetup_suggest', MeetupSuggestRequestSchema, (ctx, data) => meetupSuggest(ctx, data), {
  secrets: MAPS_CALLABLE_SECRETS,
});
export const meetup_share = callable('meetup_share', MeetupShareRequestSchema, (ctx, data) => meetupShare(ctx, data));
export const meetup_respond = callable('meetup_respond', MeetupRespondRequestSchema, (ctx, data) => meetupRespond(ctx, data));
export const meetup_cancel = callable('meetup_cancel', MeetupCancelRequestSchema, meetupCancel);

// --- Faz 6: favoriler ve widget'tan tek tuşla 1 saatlik paylaşım ---
export const favorites_set = callable('favorites_set', FavoritesSetRequestSchema, favoritesSet);
export const widget_token_issue = callable('widget_token_issue', WidgetTokenIssueRequestSchema, widgetTokenIssue);
export const widget_token_revoke = callable('widget_token_revoke', WidgetTokenRevokeRequestSchema, widgetTokenRevoke);
/** Oturumsuz + App Check'siz: widget uzantısı / AppWidget alıcısı token ile çağırır (bkz. handlers/widget.ts). */
export const widget_quick_share = tokenCallable('widget_quick_share', WidgetQuickShareRequestSchema, (data) => widgetQuickShare(data));

// --- Faz 8: yönlü izinler, görünmez mod, Güvenlik Sözleşmesi / KVKK onayı ---
// Onay ön kapısı `callable` içindedir (core `consentExemptCall`): permission_set yalnızca geri alırken, invisible_set
// yalnızca görünmez olurken, consent_accept / consent_withdraw her zaman onaysız çalışır.
export const permission_request_send = callable('permission_request_send', PermissionRequestSendSchema, (ctx, data) => permissionRequestSend(ctx, data));
export const permission_request_respond = callable('permission_request_respond', PermissionRequestRespondSchema, (ctx, data) =>
  permissionRequestRespond(ctx, data),
);
export const permission_set = callable('permission_set', PermissionSetSchema, permissionSet);
export const invisible_set = callable('invisible_set', InvisibleSetRequestSchema, invisibleSet);
export const consent_accept = callable('consent_accept', ConsentAcceptRequestSchema, consentAccept);
export const consent_withdraw = callable('consent_withdraw', ConsentWithdrawSchema, consentWithdraw);

// --- arka plan ---

/**
 * Dakikalık bakım [Varsayım 1 dk]: süre dolumu yedeği, bekleyen ACL işaretleri; her 5. dakikada tam ACL denetimi
 * ve eski mezar taşı temizliği. RTDB kuralı yazmayı zaten tam süresinde keser.
 */
export const share_expiry_sweeper = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Etc/UTC', retryCount: 0, timeoutSeconds: 55, maxInstances: 1 },
  async (event) => {
    const at = Date.parse(event.scheduleTime);
    const r = await sweepExpired({ audit: isAuditSlot(Number.isFinite(at) ? at : Date.now()) });
    const links = r.ended_link_ids.length + r.reconciled_link_ids.length + r.purged_link_tombstones;
    const f4 = r.purged_pings + r.purged_place_notes + r.timed_out_sos_ids.length;
    const f5 = r.purged_meetups + r.purged_meetup_cache;
    if (r.ended_share_ids.length || r.expired_request_ids.length || r.reconciled_share_ids.length || r.purged_tombstones || links || f4 || f5) {
      logger.info('bakım taraması', {
        shares: r.ended_share_ids.length,
        requests: r.expired_request_ids.length,
        reconciled: r.reconciled_share_ids.length,
        tombstones: r.purged_tombstones,
        links: r.ended_link_ids.length,
        reconciled_links: r.reconciled_link_ids.length,
        link_tombstones: r.purged_link_tombstones,
        pings: r.purged_pings,
        place_notes: r.purged_place_notes,
        sos_timeouts: r.timed_out_sos_ids.length,
        meetups: r.purged_meetups,
        meetup_cache: r.purged_meetup_cache,
      });
    }
  },
);

/**
 * Süre dolumu görevi: `share_start` / `share_extend` / kabul, her süreli sürüm için `expires_at` anına kuyruğa alır.
 * Faz 2: `link_share_create` / `link_share_extend` de aynı kuyruğa `{link_id, version}` verisiyle alır.
 * Yalnızca Cloud Tasks çağırabilir (callable değil). Dışa aktarılan ad config `EXPIRY_TASK_FUNCTION` ile aynı
 * olmalı (tasks.ts kuyruğa bu adla alır; contract testi karşılaştırır) ve alt çizgi içermemeli: kuyruk kimliği =
 * fonksiyon kimliği, Cloud Tasks yalnızca [A-Za-z0-9-] kabul eder. [Varsayım] eşzamanlılık/oran sınırları.
 */
export const shareexpirytask = onTaskDispatched<ExpiryTaskPayload>(
  {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 5, maxBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 50, maxDispatchesPerSecond: 100 },
    timeoutSeconds: 60,
  },
  async (req) => {
    const d = req.data as Partial<{ share_id: unknown; link_id: unknown; version: unknown }> | undefined;
    if (!d || typeof d.version !== 'number') return;
    if (typeof d.link_id === 'string') {
      const outcome = await handleLinkExpiryTask({ link_id: d.link_id, version: d.version });
      logger.debug('bağlantı süre dolumu görevi', { link_id: d.link_id, outcome });
      return;
    }
    if (typeof d.share_id !== 'string') return;
    const outcome = await handleExpiryTask({ share_id: d.share_id, version: d.version });
    logger.debug('süre dolumu görevi', { share_id: d.share_id, outcome });
  },
);

/**
 * Faz 3 duraksama bekçisi [Varsayım 15 dk]: uzun paylaşımlarda (haftalık, süresiz, > 8 sa) son paketi
 * `max(4·hb, 45 dk)`'dan eski olan göndericiye sessiz `resume_tracking`, ikinci kaçırmada görünür bildirim;
 * aynı turda 24 saatten eski `live_trail` noktalarını budar. Ayrıntı: handlers/watchdog.ts.
 */
export const share_stall_watchdog = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'Etc/UTC', retryCount: 0, timeoutSeconds: 300, maxInstances: 1 },
  async () => {
    const r = await sweepStalls();
    if (r.stalled.length || r.nudged.length || r.recovered.length || r.pruned_trail_points) {
      logger.info('duraksama bekçisi', {
        checked: r.checked,
        stalled: r.stalled.length,
        nudged: r.nudged.length,
        silent: r.silent_senders.length,
        visible: r.visible_senders.length,
        recovered: r.recovered.length,
        pruned_trail_points: r.pruned_trail_points,
      });
    }
  },
);

/** Günlük pasif hesap süreci (geri dönüştürülmüş numara savunması). [Varsayım: ürün onayı] */
export const inactive_account_sweeper = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Etc/UTC', retryCount: 1, timeoutSeconds: 540, maxInstances: 1 },
  async () => {
    const r = await sweepInactive();
    if (r.cut.length || r.reset.length) logger.info('pasif hesap taraması', { cut: r.cut.length, reset: r.reset.length });
  },
);

/**
 * Uzlaştırıcı: her paylaşım yazımında ACL aynasını belgenin GÜNCEL hâlinden idempotent olarak yeniden
 * uygular (commit ile ayna arasında çökme olursa açığı kapatır). Hata olursa yeniden denenir (retry: true);
 * işlem idempotent ve sürüm korumalıdır. [Varsayım: doğrulanmalı] eur3 Firestore tetikleyicisi ile
 * europe-west1 fonksiyon bölgesinin uyumu dağıtımda doğrulanmalı.
 */
export const share_acl_reconciler = onDocumentWritten({ document: 'location_shares/{shareId}', retry: true }, async (event) => {
  const before = (event.data?.before?.data() as ShareDoc | undefined) ?? null;
  await reconcileShare(event.params.shareId, before);
  // Faz 6: paylaşım başladı / bitti ve alıcı paylaşanı favorilerinde tutuyor → yalnızca veri `widget_refresh`.
  // En iyi çaba; hata fırlatmaz (yeniden deneme yalnızca ACL içindir). Aynı karar her yazma yolunu kapsar.
  const after = (event.data?.after?.data() as ShareDoc | undefined) ?? null;
  await notifyWidgetRefresh(before, after);
});

/**
 * Faz 2 uzlaştırıcı: her bağlantı yazımında `link_acl` aynasını belgenin GÜNCEL hâlinden yeniden uygular.
 * Token yenilendiyse ya da belge silindiyse önceki `token_hash` kapatılır. retry: true, idempotent.
 */
export const link_acl_reconciler = onDocumentWritten({ document: 'link_shares/{linkId}', retry: true }, async (event) => {
  const before = (event.data?.before?.data() as LinkShareDoc | undefined) ?? null;
  await reconcileLink(event.params.linkId, before);
});
