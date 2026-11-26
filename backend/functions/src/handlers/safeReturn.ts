/**
 * Faz 9: Güvenli Dönüş / gece takip modu (docs/PHASE9.md §3, core `safeReturn.ts`). Tüm geçişler core
 * `reduceSafeReturn` ile (demo sunucusu da aynı fonksiyonu kullanır).
 *
 * Callable'lar:
 *  - `safe_return_start`: 15 / 30 / 45 / 60 dk + hedef adı + acil kişi(ler) + başlangıç konumu (ZORUNLU). Aynı anda tek
 *    etkin kayıt (`safe_return_active`), günde `startsPerDay` (`rate_limited`). Kişiler: arkadaş VE `sos_alert` izni
 *    (core `canSendSos`); Faz 8 öncesi acil kişi listesindekiler için göç izni (`sos_send` gibi). Hiç kalmazsa
 *    `no_emergency_contacts`. Kişilere `safe_return_started` push'u (koordinat yok). Sunucu zamanlayıcısı: Cloud Tasks
 *    `due_at` ve `grace_until` + dakikalık süpürücü.
 *  - `safe_return_update`: son konum + pil (en sık ~60 sn; daha sık `rate_limited`). Push yok.
 *  - `safe_return_check_in` (onaydan muaf): `safe` → `checked_in`, `arrived` → `arrived`; kişilere `safe_return_ended`.
 *  - `safe_return_extend`: +15 dk (toplam ≤ 3 sa, `safe_return_extend_limit`); son uyarı sıfırlanır, yeni görevler.
 *  - `safe_return_cancel` (onaydan muaf): `cancelled` + kişilere `safe_return_ended`.
 *  Kaydı göremeyen (yok / başkasının) ya da biten kayıt: `safe_return_not_active` (varlık sızmaz).
 *
 * Sunucu zamanlayıcısı (`tickSafeReturn`, görev ya da süpürücü; belge kendi transaction'ında yeniden okunur):
 *  - `due_at` geçti, henüz bildirilmedi → sahibin cihazlarına `safe_return_due` ("Güvende misin?").
 *  - `grace_until` geçti → durum `alarm` ve AYNI transaction'da Faz 4 SOS açılır (`openOrRefreshSos`,
 *    `origin:'safe_return'`, son doğrulanmış konum + pil + adres + harita bağlantısı, `safeReturnAlarmMessage`);
 *    alıcılar = seçilen kişiler ∩ arkadaş ∩ `sos_alert`. Görünmezlik SOS kuralıyla kapanır. Alarmı SOS'taki
 *    "Güvendeyim" kapatır (`sos_resolve`); Güvenli Dönüş kaydı `alarm` olarak kalır.
 *
 * Görünmez mod Güvenli Dönüş'ü DURDURMAZ (güvenlik özelliği; kayıt yalnızca sahibine açık). Açık rızayı geri çekmek
 * etkin kaydı `cancelled` yapar (access.ts). Hesap silme kayıtları siler (user.ts).
 */
import {
  CALLABLES,
  DAY,
  SAFE_RETURN_LIMITS,
  SOS_LIMITS,
  type EpochMs,
  type SafeReturnCheckInRequestSchema,
  type SafeReturnDoc,
  type SafeReturnFix,
  type SafeReturnIdRequestSchema,
  type SafeReturnResponse,
  type SafeReturnResult,
  type SafeReturnStartRequestSchema,
  type SafeReturnUpdateRequestSchema,
  type UserId,
  createSafeReturnDoc,
  geocodeCell,
  reduceSafeReturn,
  safeReturnAlarmMessage,
} from '@konum/core';
import { HttpsError } from 'firebase-functions/https';
import { type Transaction, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS } from '../config';
import { COL, type SafeReturnDocStored, type UserDoc, refs, toSosAlert } from '../docs';
import { fail } from '../errors';
import { isFriend, readCaller, readPairStates } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import {
  type PushSender,
  buildSafeReturnDuePush,
  buildSafeReturnEndedPush,
  buildSafeReturnStartedPush,
  buildSosPush,
  sendPushToUser,
} from '../push';
import { scheduleSafeReturnTasks } from '../tasks';
import { unique } from '../util';
import { sosAddressLookup } from './maps';
import { type SosOpenResult, openOrRefreshSos, pushAll, sosAudience, writeSosMigration } from './sos';

export interface SafeReturnDeps {
  send?: PushSender;
  /** Alarm adresi (testler sahte verir); varsayılan `sosAddressLookup` (önbellek → Google, ≤ 2 sn). */
  address?: (p: { lat: number; lng: number }, now: EpochMs) => Promise<string | null>;
}

const lookupAddress = (deps: SafeReturnDeps) => deps.address ?? ((p, now) => sosAddressLookup(p, now, undefined, SOS_LIMITS.addressTimeoutMs));

/** Etkin kayıt TTL ile silinmesin: en uzun toplam süre + son uyarı + biten kayıt payı. */
const activePurgeAt = (d: Pick<SafeReturnDoc, 'started_at'>): Timestamp =>
  Timestamp.fromMillis(d.started_at + SAFE_RETURN_LIMITS.maxTotalMs + SAFE_RETURN_LIMITS.graceMs + SAFE_RETURN_LIMITS.purgeAfterMs);
const endedPurgeAt = (at: EpochMs): Timestamp => Timestamp.fromMillis(at + SAFE_RETURN_LIMITS.purgeAfterMs);

/** Firestore belgesi → core kaydı (`purge_at` istemciye / yanıta gitmez). */
export function toSafeReturn(d: SafeReturnDocStored | SafeReturnDoc): SafeReturnDoc {
  const { purge_at: _purge, ...rest } = d as SafeReturnDocStored;
  return { ...rest, contact_ids: [...rest.contact_ids], destination: { ...rest.destination }, last_fix: { ...rest.last_fix } };
}

function writeSafeReturn(tx: Transaction, d: SafeReturnDoc, now: EpochMs): void {
  tx.set(refs.safeReturn(d.safe_return_id), { ...d, purge_at: d.status === 'active' ? activePurgeAt(d) : endedPurgeAt(d.ended_at ?? now) } satisfies SafeReturnDocStored);
}

/** Saatin ilerisindeki ölçüm anı sunucu saatine kırpılır. */
const clampFix = (f: SafeReturnFix, now: EpochMs): SafeReturnFix => ({ ...f, timestamp: Math.min(f.timestamp, now) });

const notActive = () => fail('safe_return_not_active');

function failFor(r: SafeReturnResult, prev: SafeReturnDoc, fix?: SafeReturnFix): HttpsError {
  if (r.error === 'rate_limited') {
    const since = (fix?.timestamp ?? prev.last_fix.timestamp) - prev.last_fix.timestamp;
    return fail('rate_limited', { extra: { retry_after_ms: Math.max(0, SAFE_RETURN_LIMITS.updateMinIntervalMs - since) } });
  }
  return fail(r.error ?? 'safe_return_not_active');
}

/** Okuma aşaması: kendi kaydı (yoksa / başkasınınsa `safe_return_not_active`). */
async function readOwn(tx: Transaction, uid: UserId, id: string): Promise<SafeReturnDoc> {
  const d = (await tx.get(refs.safeReturn(id))).data() as SafeReturnDocStored | undefined;
  if (!d || d.owner_id !== uid) throw notActive();
  return toSafeReturn(d);
}

/** Okuma aşaması: kişilerden hâlâ arkadaş olanlar (bitiş bildirimi arkadaşlığı biten kişiye gitmez). */
async function friendContacts(tx: Transaction, uid: UserId, ids: readonly UserId[]): Promise<UserId[]> {
  const list = unique(ids).filter((u) => u !== uid);
  const pairs = await readPairStates(tx, uid, list);
  return list.filter((_, i) => isFriend(pairs[i]));
}

/** Okuma aşaması: kullanıcının etkin kayıtları (`(owner_id, status)` dizini). */
export async function readActiveSafeReturnsOf(tx: Transaction, uid: UserId): Promise<SafeReturnDoc[]> {
  const snap = await tx.get(db().collection(COL.safeReturns).where('owner_id', '==', uid).where('status', '==', 'active'));
  return snap.docs.map((d) => toSafeReturn(d.data() as SafeReturnDocStored)).filter((d) => d.owner_id === uid && d.status === 'active');
}

// ---------------------------------------------------------------------------
// safe_return_start
// ---------------------------------------------------------------------------

export async function safeReturnStart(ctx: CallCtx, data: z.output<typeof SafeReturnStartRequestSchema>, deps: SafeReturnDeps = {}): Promise<SafeReturnResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const id = refs.newSafeReturn().id;
  return runOp(ctx, data.op_id, CALLABLES.safeReturnStart, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const rate = await readRateLimit(tx, ctx.uid, 'safe_return_start', SAFE_RETURN_LIMITS.startsPerDay, DAY, now);
    const active = await tx.get(db().collection(COL.safeReturns).where('owner_id', '==', ctx.uid).where('status', '==', 'active').limit(1));
    if (!active.empty) throw fail('safe_return_active');
    const listed = new Set(me.emergency_contacts ?? []);
    const audience = await sosAudience(tx, ctx.uid, data.contact_ids, (u) => listed.has(u));
    if (audience.recipients.length === 0) throw fail('no_emergency_contacts');
    // --- yazmalar ---
    const doc = createSafeReturnDoc({
      safe_return_id: id,
      owner_id: ctx.uid,
      owner_name: me.display_name ?? '',
      contact_ids: audience.recipients,
      destination: { kind: data.destination.kind, name: data.destination.name, zone_id: data.destination.zone_id ?? null },
      duration_min: data.duration_min,
      fix: clampFix(data.fix, now),
      time_zone: data.time_zone,
      now,
    });
    writeSafeReturn(tx, doc, now);
    writeRateLimit(tx, rate, DAY);
    writeSosMigration(tx, ctx.uid, audience, now);
    const response: SafeReturnResponse = { safe_return: doc, notified_count: doc.contact_ids.length, server_now: now };
    return {
      response,
      after: async () => {
        await Promise.all([scheduleSafeReturnTasks(doc), pushAll(doc.contact_ids, buildSafeReturnStartedPush(doc.owner_name, doc), send, 'safe_return_start')]);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// safe_return_update
// ---------------------------------------------------------------------------

export async function safeReturnUpdate(ctx: CallCtx, data: z.output<typeof SafeReturnUpdateRequestSchema>): Promise<SafeReturnResponse> {
  const now = ctx.now;
  const fix = clampFix(data.fix, now);
  return runOp(ctx, data.op_id, CALLABLES.safeReturnUpdate, data, async (tx) => {
    const d = await readOwn(tx, ctx.uid, data.safe_return_id);
    await readCaller(tx, ctx.uid);
    const r = reduceSafeReturn(d, { type: 'update', fix }, now);
    if (r.error) throw failFor(r, d, fix);
    if (r.changed) writeSafeReturn(tx, r.doc, now);
    return { response: { safe_return: r.doc, server_now: now } };
  });
}

// ---------------------------------------------------------------------------
// safe_return_check_in / safe_return_cancel (onaydan muaf) ve safe_return_extend
// ---------------------------------------------------------------------------

async function endWith(
  ctx: CallCtx,
  opName: typeof CALLABLES.safeReturnCheckIn | typeof CALLABLES.safeReturnCancel,
  data: { op_id: string; safe_return_id: string },
  plan: (d: SafeReturnDoc) => SafeReturnResult,
  send: PushSender,
): Promise<SafeReturnResponse> {
  const now = ctx.now;
  return runOp(ctx, data.op_id, opName, data, async (tx) => {
    const d = await readOwn(tx, ctx.uid, data.safe_return_id);
    await readCaller(tx, ctx.uid, { consent: false });
    const r = plan(d);
    if (r.error) throw failFor(r, d);
    const to = await friendContacts(tx, ctx.uid, r.doc.contact_ids);
    writeSafeReturn(tx, r.doc, now);
    const ended = r.effects.find((e) => e.kind === 'ended');
    return {
      response: { safe_return: r.doc, server_now: now },
      after: ended && ended.kind === 'ended' ? () => pushAll(to, buildSafeReturnEndedPush(r.doc.owner_name, r.doc, ended.reason), send, opName) : undefined,
    };
  });
}

export async function safeReturnCheckIn(ctx: CallCtx, data: z.output<typeof SafeReturnCheckInRequestSchema>, deps: SafeReturnDeps = {}): Promise<SafeReturnResponse> {
  const now = ctx.now;
  return endWith(
    ctx,
    CALLABLES.safeReturnCheckIn,
    data,
    (d) => {
      // Varışta gelen son konum (daha yeniyse) önce yazılır; tazeleme aralığı burada uygulanmaz.
      const fix = data.fix ? clampFix(data.fix, now) : null;
      const base = fix && d.status === 'active' && fix.timestamp > d.last_fix.timestamp ? { ...d, last_fix: fix } : d;
      return reduceSafeReturn(base, { type: 'check_in', reason: data.reason }, now);
    },
    deps.send ?? sendPushToUser,
  );
}

export async function safeReturnCancel(ctx: CallCtx, data: z.output<typeof SafeReturnIdRequestSchema>, deps: SafeReturnDeps = {}): Promise<SafeReturnResponse> {
  return endWith(ctx, CALLABLES.safeReturnCancel, data, (d) => reduceSafeReturn(d, { type: 'cancel' }, ctx.now), deps.send ?? sendPushToUser);
}

export async function safeReturnExtend(ctx: CallCtx, data: z.output<typeof SafeReturnIdRequestSchema>): Promise<SafeReturnResponse> {
  const now = ctx.now;
  return runOp(ctx, data.op_id, CALLABLES.safeReturnExtend, data, async (tx) => {
    const d = await readOwn(tx, ctx.uid, data.safe_return_id);
    await readCaller(tx, ctx.uid);
    const r = reduceSafeReturn(d, { type: 'extend' }, now);
    if (r.error) throw failFor(r, d);
    writeSafeReturn(tx, r.doc, now);
    return { response: { safe_return: r.doc, server_now: now }, after: () => scheduleSafeReturnTasks(r.doc) };
  });
}

// ---------------------------------------------------------------------------
// Sunucu zamanlayıcısı: görev / süpürücü → "Güvende misin?" ve alarm
// ---------------------------------------------------------------------------

export type SafeReturnTickOutcome = 'due' | 'alarm' | 'alarm_no_contacts' | 'noop' | 'not_active' | 'missing' | 'early';

/** "Annem", "Annem ve Babam", "Annem, Babam ve Ablam"; yoksa "acil durum kişilerin". */
export function contactNamesText(names: readonly string[]): string {
  const n = names.map((s) => s.trim()).filter(Boolean);
  if (n.length === 0) return 'acil durum kişilerin';
  if (n.length === 1) return n[0] as string;
  return `${n.slice(0, -1).join(', ')} ve ${n[n.length - 1]}`;
}

const isCode = (err: unknown, code: string) => err instanceof HttpsError && (err.details as { code?: string } | undefined)?.code === code;

/**
 * Tek kaydın zaman adımı (core `tick`): belge kendi transaction'ında yeniden okunur; görev ve süpürücü aynı anda
 * çalışsa da etki bir kez olur (ikincisi `noop` / `not_active`). Push'lar commit sonrası, en iyi çaba.
 */
export async function tickSafeReturn(id: string, now: EpochMs = Date.now(), deps: SafeReturnDeps = {}): Promise<SafeReturnTickOutcome> {
  const send = deps.send ?? sendPushToUser;
  const ref = refs.safeReturn(id);
  const pre = (await ref.get()).data() as SafeReturnDocStored | undefined;
  if (!pre) return 'missing';
  if (pre.status !== 'active') return 'not_active';
  // Adres transaction DIŞINDA (yalnızca alarm anında; ≤ 2 sn, hata → null).
  const address = now >= pre.grace_until ? await lookupAddress(deps)(pre.last_fix, now).catch(() => null) : null;
  const newSosId = refs.newSosAlert().id;
  const post: { run?: () => Promise<void> } = {};

  const outcome = await db().runTransaction(async (tx): Promise<SafeReturnTickOutcome> => {
    post.run = undefined;
    const raw = (await tx.get(ref)).data() as SafeReturnDocStored | undefined;
    if (!raw) return 'missing';
    if (raw.status !== 'active') return 'not_active';
    const cur = toSafeReturn(raw);
    const r = reduceSafeReturn(cur, { type: 'tick' }, now);
    if (!r.changed) return 'noop';

    if (r.effects.some((e) => e.kind === 'alarm')) {
      const owner = (await tx.get(refs.user(cur.owner_id))).data() as UserDoc | undefined;
      let opened: SosOpenResult | null = null;
      if (owner && !owner.deleting) {
        const fix = cur.last_fix;
        const listed = new Set(owner.emergency_contacts ?? []);
        try {
          opened = await openOrRefreshSos(tx, cur.owner_id, owner, cur.contact_ids, {
            newId: newSosId,
            now,
            location: { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, timestamp: Math.min(fix.timestamp, now) },
            // Ön okumadan sonra konum başka hücreye geçtiyse eski adres yazılmaz.
            address: geocodeCell(fix) === geocodeCell(pre.last_fix) ? address : null,
            battery_pct: fix.battery_pct,
            is_charging: fix.is_charging,
            route: null,
            origin: 'safe_return',
            safe_return: { safe_return_id: cur.safe_return_id, destination_name: cur.destination.name, duration_min: cur.duration_min, due_at: cur.due_at },
            message: safeReturnAlarmMessage(cur.destination.name, cur.duration_min),
            canMigrate: (u) => listed.has(u),
          });
        } catch (err) {
          if (!isCode(err, 'no_emergency_contacts')) throw err;
        }
      }
      const next = opened ? reduceSafeReturn(r.doc, { type: 'alarm_opened', sos_id: opened.doc.sos_id }, now).doc : r.doc;
      writeSafeReturn(tx, next, now);
      if (!opened) return 'alarm_no_contacts';
      const sos = toSosAlert(opened.doc);
      const recipients = opened.recipients;
      post.run = () => pushAll(recipients, buildSosPush(sos), send, 'safe_return_alarm');
      return 'alarm';
    }

    // due: sahibin cihazlarına "Güvende misin?" (kişi adlarıyla).
    const contacts = cur.contact_ids.length ? await tx.getAll(...cur.contact_ids.map((u) => refs.user(u))) : [];
    const names = contactNamesText(contacts.map((s) => (s.data() as UserDoc | undefined)?.display_name ?? ''));
    writeSafeReturn(tx, r.doc, now);
    const msg = buildSafeReturnDuePush(r.doc, names, now);
    post.run = async () => void (await send(cur.owner_id, msg));
    return 'due';
  });

  if (post.run) {
    try {
      await post.run();
    } catch (err) {
      logger.warn('Güvenli Dönüş bildirimi gönderilemedi', { outcome, err: String(err) });
    }
  }
  return outcome;
}

/** `{safe_return_id, at}` görevi: en çok 30 sn erken gelirse bekler, daha erkense süpürücü yedeği devralır. */
export async function handleSafeReturnTask(data: { safe_return_id: string; at: number }, now: EpochMs = Date.now(), deps: SafeReturnDeps = {}): Promise<SafeReturnTickOutcome> {
  let at = now;
  if (data.at > at) {
    const wait = data.at - at;
    if (wait > LIMITS.expiryTaskMaxEarlyWaitMs) return 'early';
    await new Promise((r) => setTimeout(r, wait + 5));
    at = Math.max(Date.now(), data.at);
  }
  return tickSafeReturn(data.safe_return_id, at, deps);
}

export interface SafeReturnSweepResult {
  due: string[];
  alarms: string[];
}

/**
 * Dakikalık yedek: `status == 'active' && due_at <= now` (bileşik dizin). Bildirilmemiş son uyarılar ve
 * `grace_until`'i geçenler için tick. Uygulama kapalı / telefon çevrimdışı olsa da alarm buradan gider.
 */
export async function sweepSafeReturns(now: EpochMs, deps: SafeReturnDeps = {}, max: number = LIMITS.f4SweepMax): Promise<SafeReturnSweepResult> {
  const snap = await db().collection(COL.safeReturns).where('status', '==', 'active').where('due_at', '<=', now).orderBy('due_at').limit(max).get();
  const out: SafeReturnSweepResult = { due: [], alarms: [] };
  for (const s of snap.docs) {
    const d = s.data() as SafeReturnDocStored;
    if (d.due_notified_at !== null && now < d.grace_until) continue;
    const o = await tickSafeReturn(s.id, now, deps).catch((err) => {
      logger.error('Güvenli Dönüş zamanlayıcısı uygulanamadı', { err: String(err) });
      return 'noop' as const;
    });
    if (o === 'due') out.due.push(s.id);
    if (o === 'alarm' || o === 'alarm_no_contacts') out.alarms.push(s.id);
  }
  return out;
}

/** Yazma aşaması (onayı geri çekme): etkin kayıtları `cancelled` yapar; bitiş bildirimi gidecek kayıtları döndürür. */
export function writeCancelSafeReturns(tx: Transaction, docs: readonly SafeReturnDoc[], now: EpochMs): SafeReturnDoc[] {
  const out: SafeReturnDoc[] = [];
  for (const d of docs) {
    const r = reduceSafeReturn(d, { type: 'cancel' }, now);
    if (!r.changed) continue;
    writeSafeReturn(tx, r.doc, now);
    out.push(r.doc);
  }
  return out;
}

/** Commit sonrası: kişilere "iptal etti" (en iyi çaba). */
export const pushSafeReturnCancelled = (d: SafeReturnDoc, send: PushSender, what: string): Promise<void> =>
  pushAll(d.contact_ids, buildSafeReturnEndedPush(d.owner_name, d, 'cancelled'), send, what);

/** Hesap silme: kullanıcının tüm Güvenli Dönüş kayıtları (son konum dahil) silinir; push yok. */
export async function deleteSafeReturnsOf(uid: UserId): Promise<number> {
  const snap = await db().collection(COL.safeReturns).where('owner_id', '==', uid).get();
  if (snap.empty) return 0;
  const writer = db().bulkWriter();
  for (const d of snap.docs) void writer.delete(d.ref);
  await writer.close();
  return snap.size;
}
