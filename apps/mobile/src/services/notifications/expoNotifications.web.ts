/**
 * Web demo: expo-notifications yerine bellek içi bildirim merkezi. Hiçbir çağrı HATA FIRLATMAZ;
 * tarayıcı bildirimi / push İSTENMEZ; izin simüle edilir (demo/web/permissions.ts, varsayılan "verildi").
 *
 * Planlanan bildirimler bellekte tutulur; DATE tetikleyicisi geldiğinde (ya da tetikleyicisiz ise hemen)
 * `onDemoNotification` dinleyicilerine iletilir (demo kabuğu "telefon bildirimi" kartı gösterebilir).
 * Kart üzerindeki eylem `respondToDemoNotification` ile gerçek yanıt yoluna (`handleExpiryResponse`) girer.
 * Native'de bu dosya kullanılmaz (`expoNotifications.ts` → expo-notifications).
 */
import type {
  Notification,
  NotificationChannel,
  NotificationContentInput,
  NotificationRequest,
  NotificationRequestInput,
  NotificationResponse,
  NotificationTaskPayload,
  NotificationPermissionsStatus,
  NotificationHandler,
  NotificationCategory,
  NotificationAction,
  Subscription,
} from 'expo-notifications';
import { demoCanAsk, demoPerms, requestDemoPermission } from '../../demo/web/permissions';

export type {
  Notification,
  NotificationChannel,
  NotificationContentInput,
  NotificationRequest,
  NotificationRequestInput,
  NotificationResponse,
  NotificationTaskPayload,
  NotificationPermissionsStatus,
  NotificationHandler,
  NotificationCategory,
  NotificationAction,
  Subscription,
};

// --- sabitler (expo-notifications enum değerleriyle aynı) -------------------------------------

export enum AndroidImportance {
  UNKNOWN = 0,
  UNSPECIFIED = 1,
  NONE = 2,
  MIN = 3,
  LOW = 4,
  DEFAULT = 5,
  HIGH = 6,
  MAX = 7,
}

export enum BackgroundNotificationTaskResult {
  NoData = 1,
  NewData = 2,
  Failed = 3,
}

export enum SchedulableTriggerInputTypes {
  CALENDAR = 'calendar',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
  DATE = 'date',
  TIME_INTERVAL = 'timeInterval',
}

export const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';

// --- bellek içi merkez -------------------------------------------------------------------------

export interface DemoNotification {
  identifier: string;
  title: string;
  body: string;
  categoryIdentifier: string | null;
  data: Record<string, unknown>;
  /** Kategori eylemleri (ör. "+30 dk", "+1 saat"). */
  actions: { identifier: string; buttonTitle: string }[];
  date: number;
}

interface Scheduled {
  request: NotificationRequest;
  timer: ReturnType<typeof setTimeout> | null;
}

const scheduled = new Map<string, Scheduled>();
const presented = new Map<string, Notification>();
const categories = new Map<string, { identifier: string; buttonTitle: string }[]>();
const responseListeners = new Set<(r: NotificationResponse) => void>();
const receivedListeners = new Set<(n: Notification) => void>();
const demoListeners = new Set<(n: DemoNotification | null, dismissedId?: string) => void>();
let lastResponse: NotificationResponse | null = null;
let seq = 0;

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

function triggerDate(trigger: unknown): number | null {
  const t = (trigger ?? null) as { type?: unknown; date?: unknown; seconds?: unknown } | null;
  if (!t || Object.keys(t).every((k) => k === 'channelId')) return Date.now(); // tetikleyicisiz: hemen
  if (t.type === SchedulableTriggerInputTypes.DATE || t.date !== undefined) {
    const d = t.date instanceof Date ? t.date.getTime() : Number(t.date);
    return Number.isFinite(d) ? d : null;
  }
  if (t.type === SchedulableTriggerInputTypes.TIME_INTERVAL && typeof t.seconds === 'number') return Date.now() + t.seconds * 1000;
  return null; // takvim tetikleyicileri demoda yok
}

function toDemo(n: Notification): DemoNotification {
  const c = n.request.content;
  const cat = (c as { categoryIdentifier?: string | null }).categoryIdentifier ?? null;
  return {
    identifier: n.request.identifier,
    title: c.title ?? '',
    body: c.body ?? '',
    categoryIdentifier: cat,
    data: (c.data ?? {}) as Record<string, unknown>,
    actions: cat ? (categories.get(cat) ?? []) : [],
    date: n.date,
  };
}

function present(id: string): void {
  const s = scheduled.get(id);
  if (!s) return;
  scheduled.delete(id);
  const n = { date: Date.now(), request: s.request } as Notification;
  presented.set(id, n);
  for (const l of [...receivedListeners]) safe(() => l(n), undefined);
  const demo = toDemo(n);
  for (const l of [...demoListeners]) safe(() => l(demo), undefined);
}

/** Demo kabuğu: bildirim gösterildiğinde (n) ya da kaldırıldığında (null, id) çağrılır. */
export function onDemoNotification(cb: (n: DemoNotification | null, dismissedId?: string) => void): () => void {
  demoListeners.add(cb);
  return () => demoListeners.delete(cb);
}

/** Şu an "bildirim merkezinde" duran bildirimler (en yenisi önce). */
export function presentedDemoNotifications(): DemoNotification[] {
  return [...presented.values()].map(toDemo).sort((a, b) => b.date - a.date);
}

/**
 * Demo kabuğu: kullanıcı bildirime / eyleme dokundu. Eylem kimliği verilmezse varsayılan dokunuş.
 * Yanıt, native'deki gibi `addNotificationResponseReceivedListener` dinleyicilerine iletilir.
 */
export function respondToDemoNotification(identifier: string, actionIdentifier: string = DEFAULT_ACTION_IDENTIFIER): void {
  const n = presented.get(identifier);
  if (!n) return;
  const response = { notification: n, actionIdentifier } as NotificationResponse;
  lastResponse = response;
  for (const l of [...responseListeners]) safe(() => l(response), undefined);
}

function dismiss(id: string): void {
  if (!presented.delete(id)) return;
  for (const l of [...demoListeners]) safe(() => l(null, id), undefined);
}

// --- expo-notifications API -------------------------------------------------------------------

export function setNotificationHandler(_handler: NotificationHandler | null): void {
  // web demo: gösterim kararı kabuğa ait
}

export async function setNotificationChannelAsync(_id: string, _channel: unknown): Promise<NotificationChannel | null> {
  return null;
}

export async function setNotificationCategoryAsync(
  identifier: string,
  actions: NotificationAction[],
  _options?: unknown,
): Promise<NotificationCategory> {
  categories.set(
    identifier,
    actions.map((a) => ({ identifier: a.identifier, buttonTitle: a.buttonTitle })),
  );
  return { identifier, actions, options: {} } as unknown as NotificationCategory;
}

export async function scheduleNotificationAsync(request: NotificationRequestInput): Promise<string> {
  const identifier = request.identifier ?? `demo-notification-${++seq}`;
  const prev = scheduled.get(identifier);
  if (prev?.timer) clearTimeout(prev.timer);
  const at = safe(() => triggerDate(request.trigger), null);
  const req = { identifier, content: request.content, trigger: request.trigger } as unknown as NotificationRequest;
  const entry: Scheduled = { request: req, timer: null };
  scheduled.set(identifier, entry);
  if (at !== null) {
    // setTimeout üst sınırı ~24,8 gün: daha uzak tetikleyici demo süresince gelmez.
    const delay = Math.max(0, at - Date.now());
    if (delay < 2 ** 31 - 1) entry.timer = setTimeout(() => present(identifier), delay);
  }
  return identifier;
}

export async function cancelScheduledNotificationAsync(identifier: string): Promise<void> {
  const s = scheduled.get(identifier);
  if (s?.timer) clearTimeout(s.timer);
  scheduled.delete(identifier);
}

export async function cancelAllScheduledNotificationsAsync(): Promise<void> {
  for (const s of scheduled.values()) if (s.timer) clearTimeout(s.timer);
  scheduled.clear();
}

export async function getAllScheduledNotificationsAsync(): Promise<NotificationRequest[]> {
  return [...scheduled.values()].map((s) => s.request);
}

export async function dismissNotificationAsync(identifier: string): Promise<void> {
  dismiss(identifier);
}

export async function dismissAllNotificationsAsync(): Promise<void> {
  for (const id of [...presented.keys()]) dismiss(id);
}

export async function getPresentedNotificationsAsync(): Promise<Notification[]> {
  return [...presented.values()];
}

export function addNotificationResponseReceivedListener(listener: (r: NotificationResponse) => void): Subscription {
  responseListeners.add(listener);
  return { remove: () => void responseListeners.delete(listener) } as Subscription;
}

export function addNotificationReceivedListener(listener: (n: Notification) => void): Subscription {
  receivedListeners.add(listener);
  return { remove: () => void receivedListeners.delete(listener) } as Subscription;
}

export function getLastNotificationResponse(): NotificationResponse | null {
  return lastResponse;
}

export async function getLastNotificationResponseAsync(): Promise<NotificationResponse | null> {
  return lastResponse;
}

export function clearLastNotificationResponse(): void {
  lastResponse = null;
}

export async function clearLastNotificationResponseAsync(): Promise<void> {
  lastResponse = null;
}

/** Faz 3: bildirim izni de simüle (demo/web/permissions.ts; varsayılan verilmiş). */
function permissionStatus(): NotificationPermissionsStatus {
  const status = demoPerms().notifications;
  const granted = status === 'granted';
  return {
    status,
    granted,
    canAskAgain: demoCanAsk('notifications'),
    expires: 'never',
    ios: { status: granted ? 2 : status === 'denied' ? 1 : 0, allowsAlert: granted, allowsSound: granted, allowsBadge: false },
  } as unknown as NotificationPermissionsStatus;
}

export async function getPermissionsAsync(): Promise<NotificationPermissionsStatus> {
  return permissionStatus();
}

export async function requestPermissionsAsync(_req?: unknown): Promise<NotificationPermissionsStatus> {
  await requestDemoPermission('notifications');
  return permissionStatus();
}

export async function registerTaskAsync(_taskName: string): Promise<null> {
  return null;
}

export async function unregisterTaskAsync(_taskName: string): Promise<null> {
  return null;
}

export async function getExpoPushTokenAsync(): Promise<never> {
  throw new Error('Web demoda push yok');
}

export async function getDevicePushTokenAsync(): Promise<never> {
  throw new Error('Web demoda push yok');
}

export async function setBadgeCountAsync(_n: number): Promise<boolean> {
  return true;
}
