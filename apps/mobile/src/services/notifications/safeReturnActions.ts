/**
 * Faz 9: Güvenli Dönüş bildirim eylemleri — "Güvendeyim" (`SAFE_RETURN_OK` → `safe_return_check_in {reason:'safe'}`)
 * ve "+15 dk" (`SAFE_RETURN_EXTEND` → `safe_return_extend`).
 *
 *  - Kaynak: yerel hatırlatıcılar (`type: 'safe_return_local'`, op_id'ler bildirim verisinde: ön plan dinleyicisi ve
 *    Android arka plan görevi aynı dokunuşu aynı op_id ile gönderir, sunucu bir kez uygular) ve sahibin
 *    `safe_return_due` push'u (op_id yok: bu çalıştırmada dokunuş başına bir kez üretilir).
 *  - Callable DOĞRUDAN çağrılır (depo başsız bağlamda yok olabilir); yanıt `f9Hooks.applySafeReturn` ile kalıcı kayda
 *    ve (uygulama açıksa) safeReturnStore'a gider; uzatmada yerel bildirimler yeni süreyle yeniden planlanır.
 *  - `safe_return_not_active`: kayıt sunucudan okunur. Alarm açılmışsa (son uyarıdan hemen sonra dokunuldu)
 *    "Güvendeyim" aynı dokunuşla alarm SOS'unu kapatır (`sos_resolve`) ve kullanıcıya yerel bildirimle söylenir;
 *    kapatılamazsa / kayıt okunamazsa "Alarm gönderildi, uygulamadan Güvendeyim de" denir (sessizce geçilmez).
 *    Başka yoldan zaten bitmişse (varış / check-in / iptal) sessizce kaldırılır.
 *  - Başarısızlıkta kullanıcıya yerel bildirimle söylenir; dokunuş yalnızca başarıdan sonra "işlendi" sayılır.
 *  - Bildirime (eylemsiz) dokunma burada işlenmez: f9Services Güvenli Dönüş ekranını açar.
 */
import { NOTIFICATION_CATEGORIES_F9, NOTIFICATION_CHANNELS_F9, SAFE_RETURN_ID_RE, uuidV4, type SafeReturnDoc } from '@konum/core';
import { toKonumError } from '../../lib/errors';
import { safeReturnCheckIn, safeReturnExtend, sosResolve } from '../firebase/callables';
import { fetchSafeReturn } from '../firebase/safeReturnRepo';
import { f9Hooks } from '../location/f9Hooks';
import type { NotificationResponse } from './expoNotifications';
import * as Notifications from './expoNotifications';

export type SafeReturnAction = 'safe' | 'extend';

export interface ParsedSafeReturnAction {
  action: SafeReturnAction;
  safe_return_id: string;
  op_id: string;
  identifier: string;
}

export type SafeReturnActionOutcome =
  | { kind: 'ok'; doc: SafeReturnDoc }
  /** Zaten bitmiş (varış / check-in / iptal): yapılacak bir şey yok. */
  | { kind: 'ended' }
  /** Alarm açılmıştı: "Güvendeyim" alarm SOS'unu kapattı. */
  | { kind: 'sos_resolved'; doc: SafeReturnDoc }
  /** Alarm açılmıştı ve kapatılamadı: kullanıcıya söylendi. */
  | { kind: 'alarm_open' }
  /** Durum okunamadı (çevrimdışı / hata): kullanıcıya alarmın gitmiş olabileceği söylendi. */
  | { kind: 'unknown' }
  | { kind: 'failed'; message: string };

export interface SafeReturnActionDeps {
  checkIn: typeof safeReturnCheckIn;
  extend: typeof safeReturnExtend;
  /** Güncel kayıt (sunucudan); okunamazsa null. */
  fetchDoc: (safeReturnId: string) => Promise<SafeReturnDoc | null>;
  resolveSos: (input: { op_id: string; sos_id: string }) => Promise<unknown>;
  /** Bilgi bildirimi (dokununca uygulama açılır). */
  notify: (body: string) => Promise<void>;
  /** Yanıt → kalıcı kayıt + depo (+ yerel bildirimlerin yeniden planlanması). */
  apply: (doc: SafeReturnDoc) => Promise<void>;
  dismiss: (identifier: string) => Promise<void>;
  notifyFailure: (message: string) => Promise<void>;
  clearLastResponse: () => void;
  newOpId: () => string;
}

/** Alarm açıldıktan sonra bildirimden "Güvendeyim". */
export const SAFE_RETURN_ACTION_TEXT = {
  alarmResolved: 'Alarm kapatıldı. Kişilerine güvende olduğun bildirildi.',
  alarmOpen: 'Süre dolduğu için alarm gönderildi. Uygulamayı açıp SOS ekranından "Güvendeyim" de.',
  unknown: 'Güvenli Dönüş artık aktif değil; alarm gönderilmiş olabilir. Uygulamayı açıp kontrol et.',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultDeps: SafeReturnActionDeps = {
  checkIn: safeReturnCheckIn,
  extend: safeReturnExtend,
  fetchDoc: fetchSafeReturn,
  resolveSos: (input) => sosResolve(input),
  notify: async (body) => {
    await Notifications.scheduleNotificationAsync({
      identifier: 'safe-return-action-info',
      content: { title: 'Güvenli Dönüş', body, sound: 'default' },
      trigger: { channelId: NOTIFICATION_CHANNELS_F9.safeReturn },
    }).catch(() => undefined);
  },
  apply: (doc) => f9Hooks.applySafeReturn(doc),
  dismiss: (id) => Notifications.dismissNotificationAsync(id).catch(() => undefined),
  notifyFailure: async (message) => {
    await Notifications.scheduleNotificationAsync({
      identifier: 'safe-return-action-failed',
      content: { title: 'Güvenli Dönüş', body: `${message}. Uygulamayı açıp yeniden dene.`, sound: 'default' },
      trigger: { channelId: NOTIFICATION_CHANNELS_F9.safeReturn },
    }).catch(() => undefined);
  },
  clearLastResponse: () => {
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // eski yerel modülde yok: önemsiz
    }
  },
  newOpId: uuidV4,
};

/** Uzak push yükü (iOS'ta `trigger.payload`), yoksa içerik verisi. */
function dataOf(response: NotificationResponse): Record<string, unknown> {
  const req = response.notification.request;
  const content = (req.content.data ?? {}) as Record<string, unknown>;
  if (content.type) return content;
  const payload = (req.trigger as { payload?: unknown } | null | undefined)?.payload;
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : content;
}

/** Remote dokunuşlar için op_id (aynı bildirim + eylem → aynı op_id, bu çalıştırmada). */
const remoteOpIds = new Map<string, string>();
const inflight = new Set<string>();
const handled = new Set<string>();

/** Yanıt bir Güvenli Dönüş EYLEMİ mi? (eylemsiz dokunma → null). Saf (uzak op_id hariç). */
export function parseSafeReturnAction(response: NotificationResponse, newOpId: () => string = uuidV4): ParsedSafeReturnAction | null {
  const action: SafeReturnAction | null =
    response.actionIdentifier === NOTIFICATION_CATEGORIES_F9.actionSafe ? 'safe' : response.actionIdentifier === NOTIFICATION_CATEGORIES_F9.actionExtend ? 'extend' : null;
  if (!action) return null;
  const data = dataOf(response);
  const id = typeof data.safe_return_id === 'string' && SAFE_RETURN_ID_RE.test(data.safe_return_id) ? data.safe_return_id : null;
  if (!id) return null;
  const identifier = response.notification.request.identifier;
  if (data.type === 'safe_return_local') {
    const ops = data.op_ids as { safe?: unknown; extend?: unknown } | undefined;
    const op = action === 'safe' ? ops?.safe : ops?.extend;
    if (typeof op !== 'string' || !UUID_RE.test(op)) return null;
    return { action, safe_return_id: id, op_id: op, identifier };
  }
  if (data.type !== 'safe_return_due' && response.notification.request.content.categoryIdentifier !== NOTIFICATION_CATEGORIES_F9.safeReturn) return null;
  const key = `${identifier}:${action}`;
  let op = remoteOpIds.get(key);
  if (!op) {
    op = newOpId();
    remoteOpIds.set(key, op);
  }
  return { action, safe_return_id: id, op_id: op, identifier };
}

/** Bildirim eylemini işler. Eylem değilse / Güvenli Dönüş değilse null. */
export async function handleSafeReturnResponse(response: NotificationResponse, deps: SafeReturnActionDeps = defaultDeps): Promise<SafeReturnActionOutcome | null> {
  const p = parseSafeReturnAction(response, deps.newOpId);
  if (!p) return null;
  const key = `${p.action}:${p.op_id}`;
  if (handled.has(key) || inflight.has(key)) return null;
  inflight.add(key);
  let outcome: SafeReturnActionOutcome;
  try {
    const res =
      p.action === 'safe'
        ? await deps.checkIn({ op_id: p.op_id, safe_return_id: p.safe_return_id, reason: 'safe', fix: null })
        : await deps.extend({ op_id: p.op_id, safe_return_id: p.safe_return_id });
    await deps.apply(res.safe_return).catch(() => undefined);
    outcome = { kind: 'ok', doc: res.safe_return };
  } catch (e) {
    const err = toKonumError(e);
    if (err.code !== 'safe_return_not_active') outcome = { kind: 'failed', message: err.message };
    else outcome = await afterNotActive(p, deps);
  } finally {
    inflight.delete(key);
  }
  if (outcome.kind === 'failed') {
    await deps.notifyFailure(outcome.message);
  } else {
    if (outcome.kind === 'sos_resolved') await deps.notify(SAFE_RETURN_ACTION_TEXT.alarmResolved);
    if (outcome.kind === 'alarm_open') await deps.notify(SAFE_RETURN_ACTION_TEXT.alarmOpen);
    if (outcome.kind === 'unknown') await deps.notify(SAFE_RETURN_ACTION_TEXT.unknown);
    handled.add(key);
    await deps.dismiss(p.identifier);
  }
  deps.clearLastResponse();
  return outcome;
}

/**
 * Sunucu "artık aktif değil" dedi: alarm mı açıldı, yoksa başka yoldan mı bitti? "Güvendeyim" alarmı da kapatır;
 * "+15 dk" alarmdan sonra anlamsızdır (kullanıcıya alarmın gittiği söylenir).
 */
async function afterNotActive(p: ParsedSafeReturnAction, deps: SafeReturnActionDeps): Promise<SafeReturnActionOutcome> {
  const doc = await deps.fetchDoc(p.safe_return_id).catch(() => null);
  if (doc && doc.status !== 'alarm' && doc.status !== 'active') {
    await deps.apply(doc).catch(() => undefined);
    return { kind: 'ended' };
  }
  if (doc && doc.status === 'alarm') {
    await deps.apply(doc).catch(() => undefined);
    // Alarm açıldı ama alıcı kalmadı (SOS yok): kapatılacak bir şey yok.
    if (!doc.sos_id) return { kind: 'ended' };
    if (p.action === 'safe') {
      try {
        await deps.resolveSos({ op_id: deps.newOpId(), sos_id: doc.sos_id });
        return { kind: 'sos_resolved', doc };
      } catch {
        // aşağıda: kullanıcıya alarmın açık olduğu söylenir
      }
    }
    return { kind: 'alarm_open' };
  }
  // Durum bilinmiyor (çevrimdışı / okuma hatası; `active` dönmesi de tutarsız): sessizce geçilmez.
  return { kind: 'unknown' };
}

/** Testler: işlenmiş dokunuş belleğini sıfırlar. */
export function __resetSafeReturnActionsForTests(): void {
  inflight.clear();
  handled.clear();
  remoteOpIds.clear();
}
