/**
 * "+30 dk" / "+1 saat" bildirim eylemleri → `share_extend`.
 *
 * İki yol:
 *  - Uygulama çalışıyorsa (ön plan dinleyicisi): sharingStore.extend → arayüz anında güncellenir.
 *    iOS'ta eylem uygulamayı soğuk başlatırsa depo ilk sunucu anlık görüntüsünü henüz almamış olabilir;
 *    bu durumda (oturum bilinmiyor) callable DOĞRUDAN çağrılır: sunucu yetkilidir ve op_id ile tekilleştirir.
 *  - Uygulama kapalı/başsız (Android arka plan görevi): callable doğrudan çağrılır.
 * Doğrudan yolda arka plan görevinin kalıcı hedeflerindeki `expires_at` güncellenir; aksi halde görev
 * eski bitişte yayını keserdi. Kullanıcının durdurduğu (durdurma niyeti olan) oturum uzatılmaz.
 *
 * Faz 2: bağlantı (QR) bildirimleri (`kind: 'link_expiring'`) aynı yoldan geçer; uzatma `link_share_extend`
 * ile yapılır, durdurulan bağlantı (kalıcı bağlantı durdurma niyeti) uzatılmaz, doğrudan yolda kalıcı
 * bağlantı hedefinin bitişi güncellenir.
 *
 * Dokunuş yalnızca BAŞARIDAN sonra "işlendi" sayılır ve bildirim kaldırılır. Başarısızlıkta kullanıcıya
 * yerel bildirimle söylenir (sessizce kaybolmaz). Her durumda son yanıt temizlenir
 * (`clearLastNotificationResponse`): bir sonraki açılışta aynı dokunuş yeniden işlenmez.
 */
import type { ExtensionMinutes } from '@konum/core';
import type { NotificationResponse } from './expoNotifications';
import * as Notifications from './expoNotifications';
import { z } from 'zod';
import { toKonumError } from '../../lib/errors';
import { linkShareExtend, shareExtend } from '../firebase/callables';
import { getLinkStop, hydrateLinkStops } from '../../state/linkStops';
import { updateTargets } from '../../state/persist';
import { getStopIntent, hydrateStopIntents } from '../../state/stopIntents';
import { ACTION_EXTEND, CHANNELS, SHARE_EXPIRING_CATEGORY } from './constants';

const OpIds = z.object({ '30': z.uuid(), '60': z.uuid() });
const DataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('share_expiring'), session_id: z.string().min(1), op_ids: OpIds }),
  z.object({ kind: z.literal('link_expiring'), link_id: z.string().min(1).max(64), op_ids: OpIds }),
]);

export type ExtendOutcome =
  | { kind: 'ok' }
  /** Oturum durduruldu / bitti: uzatma yapılmaz, bildirim sessizce kaldırılır. */
  | { kind: 'rejected' }
  /** Depo bu oturumu (henüz) tanımıyor: doğrudan callable yolu. */
  | { kind: 'unknown_session' }
  | { kind: 'failed'; message: string };

export type ExtendViaStore = (sessionId: string, minutes: ExtensionMinutes, opId: string) => Promise<ExtendOutcome>;

/** Uygulama açıkken uzatmanın depo üzerinden yapılacağı yollar (arkadaş oturumu / bağlantı). */
export interface ExtendRoutes {
  session?: ExtendViaStore | null;
  link?: ExtendViaStore | null;
}

export interface ExpiryActionDeps {
  extend: typeof shareExtend;
  isStopRequested: (sessionId: string) => Promise<boolean>;
  dismiss: (identifier: string) => Promise<void>;
  notifyFailure: (sessionId: string, message: string) => Promise<void>;
  clearLastResponse: () => void;
  /** Faz 2 (verilmezse gerçek uygulama): `link_share_extend` ve bağlantı durdurma niyeti. */
  extendLink?: typeof linkShareExtend;
  isLinkStopRequested?: (linkId: string) => Promise<boolean>;
}

const isLinkStopRequestedDefault = async (linkId: string) => {
  await hydrateLinkStops();
  return getLinkStop(linkId) !== undefined;
};

const defaultDeps: ExpiryActionDeps = {
  extend: shareExtend,
  extendLink: linkShareExtend,
  isLinkStopRequested: isLinkStopRequestedDefault,
  isStopRequested: async (sid) => {
    await hydrateStopIntents();
    return getStopIntent(sid) !== undefined;
  },
  dismiss: (id) => Notifications.dismissNotificationAsync(id).catch(() => undefined),
  notifyFailure: async (sid, message) => {
    await Notifications.scheduleNotificationAsync({
      identifier: `share-extend-failed-${sid}`,
      content: { title: 'Süre uzatılamadı', body: `${message}. Uygulamayı açıp yeniden deneyebilirsin.`, sound: false },
      trigger: { channelId: CHANNELS.shareExpiring },
    }).catch(() => undefined);
  },
  clearLastResponse: () => {
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // eski yerel modülde yok: önemsiz
    }
  },
};

/** Aynı dokunuş iki yoldan (dinleyici + son yanıt, ya da ön plan + arka plan görevi) aynı anda gelebilir. */
const inflight = new Set<string>();
const handled = new Set<string>();

async function extendDirect(sessionId: string, minutes: ExtensionMinutes, opId: string, deps: ExpiryActionDeps): Promise<ExtendOutcome> {
  if (await deps.isStopRequested(sessionId)) return { kind: 'rejected' };
  try {
    const res = await deps.extend({ session_id: sessionId, minutes, op_id: opId });
    const byId = new Map(res.shares.map((s) => [s.share_id, s] as const));
    // Yalnızca listede HÂLÂ bulunan hedeflerin bitişi güncellenir (hedef eklenmez).
    await updateTargets((latest) => {
      let changed = false;
      const targets = latest.targets.map((t) => {
        const s = byId.get(t.share_id);
        if (!s || s.status !== 'active') return t;
        changed = true;
        return { ...t, expires_at: s.expires_at, share_mode: s.share_mode, version: s.version };
      });
      return changed ? { ...latest, targets } : null;
    }).catch(() => undefined);
    return { kind: 'ok' };
  } catch (e) {
    return { kind: 'failed', message: toKonumError(e).message };
  }
}

async function extendLinkDirect(linkId: string, minutes: ExtensionMinutes, opId: string, deps: ExpiryActionDeps): Promise<ExtendOutcome> {
  if (await (deps.isLinkStopRequested ?? isLinkStopRequestedDefault)(linkId)) return { kind: 'rejected' };
  try {
    const res = await (deps.extendLink ?? linkShareExtend)({ link_id: linkId, minutes, op_id: opId });
    if (res.status !== 'active') return { kind: 'rejected' };
    // Yalnızca listede HÂLÂ bulunan bağlantının bitişi güncellenir (hedef eklenmez).
    await updateTargets((latest) => {
      let changed = false;
      const linkTargets = latest.linkTargets.map((t) => {
        if (t.link_id !== linkId) return t;
        changed = true;
        return { ...t, expires_at: res.expires_at, share_mode: res.share_mode, version: res.version, extended_count: res.extended_count };
      });
      return changed ? { ...latest, linkTargets } : null;
    }).catch(() => undefined);
    return { kind: 'ok' };
  } catch (e) {
    const err = toKonumError(e);
    // Bağlantı bitti / bulunamadı: uzatılacak bir şey yok, bildirim sessizce kalkar.
    if (err.code === 'link_not_found' || err.code === 'share_not_active') return { kind: 'rejected' };
    return { kind: 'failed', message: err.message };
  }
}

export async function handleExpiryResponse(
  response: NotificationResponse,
  via: ExtendViaStore | ExtendRoutes | null,
  deps: ExpiryActionDeps = defaultDeps,
): Promise<ExtendOutcome | null> {
  const req = response.notification.request;
  if (req.content.categoryIdentifier !== SHARE_EXPIRING_CATEGORY) return null;
  const minutes: ExtensionMinutes | null =
    response.actionIdentifier === ACTION_EXTEND[30] ? 30 : response.actionIdentifier === ACTION_EXTEND[60] ? 60 : null;
  if (minutes === null) return null; // bildirime dokunuldu: yalnızca uygulama açılır
  const parsed = DataSchema.safeParse(req.content.data);
  if (!parsed.success) return null;
  const key = `${req.identifier}:${response.actionIdentifier}:${parsed.data.op_ids[minutes === 30 ? '30' : '60']}`;
  if (handled.has(key) || inflight.has(key)) return null;
  inflight.add(key);

  const routes: ExtendRoutes = typeof via === 'function' ? { session: via } : (via ?? {});
  const data = parsed.data;
  const subjectId = data.kind === 'share_expiring' ? data.session_id : data.link_id;
  const opId = data.op_ids[minutes === 30 ? '30' : '60'];
  let outcome: ExtendOutcome;
  try {
    if (data.kind === 'share_expiring') {
      outcome = routes.session ? await routes.session(data.session_id, minutes, opId) : { kind: 'unknown_session' };
      if (outcome.kind === 'unknown_session') outcome = await extendDirect(data.session_id, minutes, opId, deps);
    } else {
      outcome = routes.link ? await routes.link(data.link_id, minutes, opId) : { kind: 'unknown_session' };
      if (outcome.kind === 'unknown_session') outcome = await extendLinkDirect(data.link_id, minutes, opId, deps);
    }
  } catch (e) {
    outcome = { kind: 'failed', message: toKonumError(e).message };
  } finally {
    inflight.delete(key);
  }

  if (outcome.kind === 'failed') {
    await deps.notifyFailure(subjectId, outcome.message);
  } else {
    handled.add(key);
    await deps.dismiss(req.identifier);
  }
  deps.clearLastResponse();
  return outcome;
}

/** Testler: işlenmiş dokunuş belleğini sıfırlar. */
export function __resetExpiryActionsForTests(): void {
  inflight.clear();
  handled.clear();
}
