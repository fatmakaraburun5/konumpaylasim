/**
 * Web demo · Faz 6: widget uzantısının (iOS WidgetKit / Android AppWidget + hızlı ayar kutucuğu) tarayıcı benzetimi.
 * Yerel köprü web'de no-op olduğu için (`services/widgets/widgetBridge.web.ts`) "yerel taraf" burada yaşar.
 *
 *  - Token yaşam döngüsü (gerçekte `widgetSync` + `setQuickShareCredential`): oturum açık ve favori varken bu demo
 *    cihazı (`demo-web-widget`) için `widget_token_issue`; core `widgetTokenNeedsRefresh` ile yenileme; çıkışta
 *    kimlik bilgisi silinir. Token "anahtar zinciri" benzeri ayrı anahtarda durur, snapshot'a GİRMEZ.
 *  - Snapshot: demo sunucusunun durumu → `demoWidgetInput` → core `buildWidgetSnapshot`; `widgetSnapshotChanged` +
 *    `widgetSyncDecision` yazma / yenileme kısıtlamasını uygular (sayaçlar panelde). `widget_refresh` push'u
 *    kısıtlamayı atlayıp hemen yeniler.
 *  - Düğme: core `quickShareRoute` → arka planda OTURUMSUZ `widget_quick_share` (yalnızca token) ya da derin
 *    bağlantıyla uygulamayı açma (`quickShareDeepLink`). Hata → core `toQuickShareError` + `quickShareErrorAction`:
 *    token / yetki sorunu uygulamayı açar, hız sınırı ve bağlantı yokluğu widget'ta kısa metin gösterir. Başarıda
 *    snapshot core `applyQuickShareToSnapshot` ile yamalanır (yerel kod da aynısını yapar) ve olay kaydedilir.
 */
import {
  applyQuickShareToSnapshot,
  buildWidgetSnapshot,
  geocodeCell,
  quickShareDeepLink,
  quickShareErrorAction,
  quickShareErrorText,
  quickShareRoute,
  snapshotBytes,
  toQuickShareError,
  uuidV4,
  WidgetQuickShareResponseSchema,
  widgetSnapshotChanged,
  widgetSyncDecision,
  widgetTokenNeedsRefresh,
  WidgetTokenIssueResponseSchema,
  type EpochMs,
  type LatLng,
  type QuickShareError,
  type QuickShareOpenReason,
  type QuickShareSource,
  type UserId,
  type WidgetQuickShareResponse,
  type WidgetSnapshot,
} from '@konum/core';
import { DEMO_ME, DemoHttpsError, demoServer, type DemoPushMessage } from '../server';
import { safeStorage } from '../server/storage';
import { demoOnline } from './network';
import { demoPerms } from './permissions';
import { demoCurrentUid } from './session';
import { widgetStore } from '../../state/widgetStore';
import { demoWidgetInput, OPEN_REASON_TEXT, zoneLabelAt } from './widgetModel';

export const DEMO_WIDGET_DEVICE_ID = 'demo-web-widget';
const CRED_KEY = 'konum.demo.widget.cred.v1';
/** Başarısız token üretiminden sonra yeniden deneme aralığı. */
const ISSUE_RETRY_MS = 15_000;
/** Native URLSession zaman aşımı 8 sn; demo bağlantı yokken daha çabuk düşer. */
const OFFLINE_FAIL_MS = 1_500;
const FLASH_MS = 4_500;
const MAX_EVENTS = 8;

export interface WidgetCredential {
  token: string;
  endpoint: string;
  expires_at: EpochMs;
}

export type WidgetFlash =
  | { kind: 'pending'; until: EpochMs }
  | { kind: 'ok'; text: string; until: EpochMs }
  | { kind: 'error'; text: string; until: EpochMs }
  | { kind: 'open'; text: string; until: EpochMs };

export interface WidgetSimEvent {
  at: EpochMs;
  text: string;
  tone: 'ok' | 'error' | 'open' | 'info';
}

export interface WidgetPushNotice {
  at: EpochMs;
  title: string;
  body: string;
}

export interface WidgetSimOptions {
  /** iOS 17+ etkileşimli widget (false = iOS 16: düğme yok, dokunuş uygulamayı açar). */
  interactive: boolean;
  /** "Kilit ekranında ayrıntı göster" (varsayılan kapalı). */
  lock_screen_details: boolean;
}

export interface WidgetSimState {
  snapshot: WidgetSnapshot | null;
  /** `avatar_file` → yerel gösterilebilir adres. */
  files: Record<string, string>;
  credential: WidgetCredential | null;
  bytes: number;
  writes: number;
  reloads: number;
  lastChange: 'none' | 'minor' | 'major' | null;
  lastWriteAt: EpochMs | null;
  events: WidgetSimEvent[];
  flashes: Record<string, WidgetFlash>;
  push: WidgetPushNotice | null;
  options: WidgetSimOptions;
}

export type QuickShareOutcome =
  | { kind: 'ok'; response: WidgetQuickShareResponse }
  | { kind: 'error'; error: QuickShareError; text: string }
  | { kind: 'open_app'; reason: QuickShareOpenReason; href: string; text: string };

// ── durum ────────────────────────────────────────────────────────────────────────────────────

function loadCred(): WidgetCredential | null {
  try {
    const raw = safeStorage.get(CRED_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<WidgetCredential>) : null;
    return v && typeof v.token === 'string' && typeof v.endpoint === 'string' && typeof v.expires_at === 'number'
      ? { token: v.token, endpoint: v.endpoint, expires_at: v.expires_at }
      : null;
  } catch {
    return null;
  }
}

let credential: WidgetCredential | null = loadCred();
let stored: WidgetSnapshot | null = null;
let files: Record<string, string> = {};
let lastWriteAt: EpochMs | null = null;
let lastReloadAt: EpochMs | null = null;
let writes = 0;
let reloads = 0;
let lastChange: WidgetSimState['lastChange'] = null;
let forceReload = false;
let events: WidgetSimEvent[] = [];
let flashes: Record<string, WidgetFlash> = {};
let push: WidgetPushNotice | null = null;
let options: WidgetSimOptions = { interactive: true, lock_screen_details: false };
let issuing = false;
let lastIssueAttempt = 0;
let pushUnsub: (() => void) | null = null;
const placeCache = new Map<string, string | null>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // panel hatası benzetimi etkilemez
    }
  }
}

function setCredential(c: WidgetCredential | null): void {
  credential = c;
  if (c) safeStorage.set(CRED_KEY, JSON.stringify(c));
  else safeStorage.remove(CRED_KEY);
}

function addEvent(text: string, tone: WidgetSimEvent['tone']): void {
  events = [{ at: Date.now(), text, tone }, ...events].slice(0, MAX_EVENTS);
}

function setFlash(key: string, f: WidgetFlash | null): void {
  const next = { ...flashes };
  if (f) next[key] = f;
  else delete next[key];
  flashes = next;
}

export function widgetSimState(): WidgetSimState {
  return {
    snapshot: stored,
    files,
    credential,
    bytes: stored ? snapshotBytes(stored) : 0,
    writes,
    reloads,
    lastChange,
    lastWriteAt,
    events,
    flashes,
    push,
    options: { ...options, lock_screen_details: lockScreenDetails() },
  };
}

/**
 * "Kilit ekranında ayrıntı göster" TEK kaynaktan gelir: uygulamanın `widgetStore.lockScreenDetails` ayarı (Profil
 * ekranı). Galeri anahtarı da aynı ayarı değiştirir; böylece demo ile uygulama ayarı ayrışmaz.
 */
function lockScreenDetails(): boolean {
  try {
    return widgetStore.getState().lockScreenDetails;
  } catch {
    return options.lock_screen_details;
  }
}

export function onWidgetSimChange(l: () => void): () => void {
  listeners.add(l);
  ensurePushListener();
  return () => listeners.delete(l);
}

export function setWidgetSimOptions(patch: Partial<WidgetSimOptions>): void {
  options = { ...options, ...patch };
  if (patch.lock_screen_details !== undefined) widgetStore.getState().setLockScreenDetails(patch.lock_screen_details);
  widgetSimTick(Date.now());
}

// ── push (gönderenin görünür onayı + widget yenileme uyandırması) ───────────────────────────────

function ensurePushListener(): void {
  if (pushUnsub) return;
  pushUnsub = demoServer().subscribePush(DEMO_ME, (m: DemoPushMessage) => {
    const type = m.data?.type;
    if (type === 'quick_share_started' && m.notification) {
      // Widget'tan başlatılınca uygulama arka plandadır: bildirimi işletim sistemi gösterir (demo: galeri afişi).
      push = { at: Date.now(), title: m.notification.title, body: m.notification.body };
      addEvent(`Bildirim: ${m.notification.body}`, 'info');
      emit();
    } else if (type === 'widget_refresh') {
      forceReload = true;
      const who = m.data.from ? (demoServer().widgetSource(DEMO_ME).friends.find((f) => f.uid === m.data.from)?.display_name ?? m.data.from) : '';
      addEvent(`widget_refresh (${who}) → widget yenilendi`, 'info');
      widgetSimTick(Date.now());
    }
  });
}

// ── snapshot + token yaşam döngüsü ────────────────────────────────────────────────────────────

function signedIn(): boolean {
  if (demoCurrentUid() !== DEMO_ME) return false;
  return !!demoServer().profileOf(DEMO_ME)?.display_name.trim();
}

const bgLocationOk = (): boolean => {
  const p = demoPerms();
  return p.foreground === 'granted' && p.background === 'granted';
};

function placeOf(p: LatLng): string | null {
  const zone = zoneLabelAt(p, demoServer().zonesOf(DEMO_ME));
  if (zone) return zone;
  const cell = geocodeCell(p);
  if (!placeCache.has(cell)) placeCache.set(cell, demoServer().placeLabelAt(p));
  return placeCache.get(cell) ?? null;
}

/** Uygulama tarafı: token yoksa / yenilenmeliyse alır; oturum kapalıysa siler. */
function ensureCredential(now: EpochMs, hasFavorites: boolean): void {
  if (!signedIn()) {
    if (credential) {
      setCredential(null);
      addEvent('Çıkış: widget kimlik bilgisi silindi', 'info');
    }
    return;
  }
  if (!hasFavorites || issuing || !demoOnline()) return;
  if (credential && !widgetTokenNeedsRefresh(credential.expires_at, now)) return;
  if (now - lastIssueAttempt < ISSUE_RETRY_MS) return;
  issuing = true;
  lastIssueAttempt = now;
  const renewing = credential !== null;
  demoServer()
    .call('widget_token_issue', { op_id: uuidV4(), device_id: DEMO_WIDGET_DEVICE_ID }, DEMO_ME)
    .then((raw) => {
      const r = WidgetTokenIssueResponseSchema.parse(raw);
      setCredential({ token: r.token, endpoint: r.endpoint_path, expires_at: r.expires_at });
      addEvent(renewing ? 'Widget oturumu yenilendi (30 gün)' : 'Widget oturumu alındı (30 gün)', 'info');
    })
    .catch(() => addEvent('Widget oturumu alınamadı', 'error'))
    .finally(() => {
      issuing = false;
      widgetSimTick(Date.now());
    });
}

/** Saniyede bir (panel açıkken): snapshot kur, değişim sınıfı + yazma / yenileme kararı. */
export function widgetSimTick(now: EpochMs = Date.now()): void {
  const server = demoServer();
  const src = server.widgetSource(DEMO_ME);
  ensureCredential(now, src.favorite_ids.length > 0);
  const { input, files: nextFiles } = demoWidgetInput(src, {
    now,
    signed_in: signedIn(),
    token_expires_at: credential?.expires_at ?? null,
    bg_location_ok: bgLocationOk(),
    lock_screen_details: lockScreenDetails(),
    placeOf,
  });
  const next = buildWidgetSnapshot(input);
  const change = widgetSnapshotChanged(stored, next);
  const d = forceReload
    ? { write: true, reload: true, next_check_at: null }
    : widgetSyncDecision({ change, now, last_write_at: lastWriteAt, last_reload_at: lastReloadAt });
  forceReload = false;
  for (const [k, f] of Object.entries(flashes)) if (f.until <= now) setFlash(k, null);
  if (push && now - push.at > 7_000) push = null;
  if (d.write) {
    stored = next;
    files = nextFiles;
    lastWriteAt = now;
    writes++;
    lastChange = change === 'none' ? 'major' : change;
  }
  if (d.reload) {
    lastReloadAt = now;
    reloads++;
  }
  emit();
}

// ── düğme ────────────────────────────────────────────────────────────────────────────────────

/** Dokunulan widget için derin bağlantı (hedef yoksa uygulamanın arkadaşlar ekranı: favori seçimi). */
function appHref(to: UserId | null, src: QuickShareSource): string {
  if (!to) return 'konum://friends';
  return quickShareDeepLink(to, src);
}

function openApp(key: string, to: UserId | null, src: QuickShareSource, reason: QuickShareOpenReason, extra?: string): QuickShareOutcome {
  const text = extra ? `${extra}: ${OPEN_REASON_TEXT[reason].split(': ')[1] ?? 'uygulama açılıyor'}` : OPEN_REASON_TEXT[reason];
  setFlash(key, { kind: 'open', text: 'Uygulama açılıyor…', until: Date.now() + 2_000 });
  addEvent(text, 'open');
  // Token sorununda uygulama açılınca token yenilenir (uygulama ön planda: widgetSync).
  if (reason === 'no_token' || reason === 'token_expiring' || reason === 'error_fallback') lastIssueAttempt = 0;
  emit();
  return { kind: 'open_app', reason, href: appHref(to, src), text };
}

/**
 * Widget düğmesi / kutucuk. `key` geri bildirimin hangi widget'ta görüneceği (ör. "ios_small"). Hedef verilmezse
 * snapshot'ın `default_uid`'i (ilk favori).
 */
export async function pressQuickShare(key: string, toUid: UserId | null, source: QuickShareSource): Promise<QuickShareOutcome> {
  const now = Date.now();
  if (!stored) widgetSimTick(now);
  const snap = stored;
  const target = toUid ?? snap?.default_uid ?? null;
  const route = quickShareRoute({
    signed_in: snap?.signed_in ?? false,
    target_uid: target,
    token_expires_at: credential?.expires_at ?? null,
    bg_location_ok: snap?.quick.bg_location_ok ?? false,
    interactive_supported: options.interactive,
    now,
  });
  if (route.kind === 'open_app') return openApp(key, target, source, route.reason);

  const cred = credential as WidgetCredential;
  const to = target as UserId;
  setFlash(key, { kind: 'pending', until: now + 10_000 });
  emit();
  try {
    if (!demoOnline()) {
      await new Promise((r) => setTimeout(r, OFFLINE_FAIL_MS));
      throw new DemoHttpsError('unavailable', 'Bağlantı yok');
    }
    const res = WidgetQuickShareResponseSchema.parse(
      await demoServer().call('widget_quick_share', { token: cred.token, to_uid: to, op_id: uuidV4(), source }, null),
    );
    const at = Date.now();
    if (stored) stored = applyQuickShareToSnapshot(stored, to, res.expires_at, at);
    const verb = res.status === 'started' ? 'başladı' : res.status === 'extended' ? '1 saate uzatıldı' : 'zaten açık';
    setFlash(key, { kind: 'ok', text: res.status === 'already_active' ? '✓ Zaten açık' : `✓ ${res.status === 'started' ? 'Başladı' : 'Uzatıldı'}`, until: at + 2_500 });
    addEvent(`${res.to_name} ile paylaşım ${verb} (${res.status})`, 'ok');
    widgetSimTick(at);
    return { kind: 'ok', response: res };
  } catch (e) {
    const code = (e as { details?: { code?: string } } | null)?.details?.code ?? null;
    const err = toQuickShareError(code);
    if (err === 'token_expired' || err === 'token_invalid') setCredential(null);
    if (quickShareErrorAction(err) === 'open_app') {
      setFlash(key, null);
      return openApp(key, to, source, 'error_fallback', quickShareErrorText(err));
    }
    const text = quickShareErrorText(err);
    setFlash(key, { kind: 'error', text, until: Date.now() + FLASH_MS });
    addEvent(`Hata (${err}): ${text}`, 'error');
    emit();
    return { kind: 'error', error: err, text };
  }
}

/** Test / sıfırlama: benzetim durumunu temizler (kimlik bilgisi dahil). */
export function resetWidgetSim(): void {
  setCredential(null);
  stored = null;
  files = {};
  lastWriteAt = null;
  lastReloadAt = null;
  writes = 0;
  reloads = 0;
  lastChange = null;
  events = [];
  flashes = {};
  push = null;
  lastIssueAttempt = 0;
  emit();
}
