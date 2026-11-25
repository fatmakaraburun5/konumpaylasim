/**
 * Faz 5: kayıtlı bölgeler (Ev / İş / Okul / özel nokta) ve varış / ayrılış tetikleyicileri —
 * `zone_upsert`, `zone_delete`, `zone_event_report`.
 *
 * Veri: Firestore `users/{uid}/zones/{zone_id}` (core `Zone`; YALNIZCA sahibi okur, yalnızca bu callable'lar yazar).
 * Bölge merkezi hassas veridir (ev / iş adresi): alıcılara, push'a ve olay kaydına ASLA girmez.
 *
 *  - `zone_upsert`: ad core `sanitizeNoteText(name, nameMaxChars)` ile temizlenir (boş → `invalid_argument`,
 *    `field: name`); emoji en çok 8 karakter. Yeni bölgede toplam ≥ `ZONE_LIMITS.maxZones` → `zone_limit_reached`.
 *    Düzenlenen bölge yoksa `zone_not_found`; `created_at` korunur. Kural alıcıları: kabul edilmiş + engelsiz
 *    arkadaşlar; diğerleri (kendisi, yabancı, engelli, geçersiz kimlik) SESSİZCE düşer ve `dropped_recipient_ids`
 *    yanıtında döner; alıcısı kalmayan kural silinir. `rule_id` istemciden gelir (uuid); aynı bölgede tekrarlanan
 *    `rule_id` → `invalid_argument` (`field: rules`). notify kuralının `share_duration` değeri null'a çekilir.
 *    Saat dilimi `offsetFnForTimeZone` ile doğrulanır (geçersiz → `invalid_argument`, `field: time_zone`).
 *  - `zone_delete`: bölge yoksa `{deleted: false}` (idempotent). Yol uid'e bağlı: başkasının bölgesine erişilemez.
 *    Soğuma belgeleri de silinir; olay kaydı kendi TTL'iyle (30 gün) kalır.
 *  - `zone_event_report` (cihaz sapma filtresinden GEÇMİŞ geçişi bildirir; koordinat gelmez):
 *      1. bölge yok → `zone_not_found`;
 *      2. `occurred_at` > now + 60 sn → now'a kırpılır; now − occurred_at > `maxEventAgeMs` → `stale`;
 *      3. bölge kapalı → `disabled`; `matchZoneRules` (bölgenin `time_zone` yerel saatiyle, olay anında) boş →
 *         `outside_window`;
 *      4. aynı bölge + yön için son tetikten `serverCooldownMs` geçmedi → `cooldown` (ikinci savunma hattı);
 *      5. kullanıcı başına 24 saatte `maxEventsPerDay` tetik → `daily_limit`;
 *      6. notify kurallarının alıcı birleşimi (HÂLÂ arkadaş olanlar) → görünür push (`zone_event`, Faz 4 `ping`
 *         kanalı); start_share kuralları yanıtta `start_share` olarak döner (alıcılar yine süzülür). Cihaz
 *         paylaşımı mevcut `share_start` ile başlatır.
 *    Bastırılan olaylarda push yok ve `start_share` boş [Varsayım: cooldown/daily_limit için de]. Her olay (bastırılan
 *    dahil) `users/{uid}/zone_events/{op_id}` altına koordinatsız kaydedilir (`purge_at` = +30 gün TTL). Soğuma ve
 *    günlük sayaç yalnızca gerçekten bildirim / paylaşım tetiklenen olayda işler.
 *  - Arkadaşlık bitince (kaldırma / engel) iki tarafın bölge kurallarından karşı taraf çıkarılır
 *    (`readPairZoneCleanup` / `writePairZoneCleanup`, friends.ts). Hesap silmede bölgeler, olay kaydı ve soğuma
 *    belgeleri silinir (`deleteZonesOf`). [Varsayım] Silinen kullanıcı başkalarının kurallarında kalabilir; olay
 *    anında arkadaşlık yeniden doğrulandığı için ona bildirim gitmez.
 *  - Faz 8 (core `canZoneNotify` / `canShareLocation`): notify kuralının alıcısı yalnızca bana `zone_notify` izni
 *    vermiş arkadaş olabilir; start_share kuralının alıcısı yalnızca benim `location_view` izni verdiğim arkadaş.
 *    İkisi de hem kayıtta (`zone_upsert`, düşenler `dropped_recipient_ids`) hem olay anında yeniden denetlenir.
 *    Görünmezken her olay `suppressed: 'invisible'` (bildirim yok, `start_share` boş). İzin geri alınınca kişi
 *    kurallardan çıkar (`permission_set`: `stripZoneRecipients`).
 */
import {
  CALLABLES,
  DAY,
  NOTE_LIMITS,
  ZONE_EVENT_LOG_TTL_MS,
  ZONE_LIMITS,
  ZONE_TRIGGERS,
  type DurationChoice,
  type EpochMs,
  type UserId,
  type ZoneDeleteRequestSchema,
  type ZoneDeleteResponse,
  type ZoneEventReportRequestSchema,
  type ZoneEventReportResponse,
  type ZoneRule,
  type ZoneUpsertRequestSchema,
  type ZoneUpsertResponse,
  type ZoneAction,
  canShareLocation,
  canZoneNotify,
  isInvisible,
  localClock,
  matchZoneRules,
  offsetFnForTimeZone,
  sanitizeNoteText,
} from '@konum/core';
import { type DocumentReference, Timestamp, type Transaction } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { DEFAULT_TIME_ZONE, LIMITS } from '../config';
import { COL, type ZoneCooldownDoc, type ZoneDoc, type ZoneEventDoc, refs, toZone } from '../docs';
import { fail } from '../errors';
import { type CallerAccess, callerAccess, pairInput, readCaller, readPairStates } from '../graph';
import { runOp } from '../ops';
import { type PushMessage, type PushSender, buildZoneEventPush, sendPushToUser } from '../push';
import { assertDocId, chunk, isServerUid, unique } from '../util';

export interface ZoneDeps {
  /** Testler sahte gönderici verir; varsayılan FCM. */
  send?: PushSender;
}

type Suppressed = ZoneEventReportResponse['suppressed'];

/** Günlük tetik sayacı: `rate_limits/{uid}_zone_event` (mevcut sabit pencere biçimi). */
const DAILY_KEY = 'zone_event';

function checkTimeZone(tz: string, now: EpochMs): string {
  try {
    offsetFnForTimeZone(tz)(now);
    return tz;
  } catch {
    throw fail('invalid_argument', { message: 'Saat dilimi geçersiz', extra: { field: 'time_zone' } });
  }
}

/** Bölgenin yerel saati (geçersiz saklı dilimde varsayılan dilim). */
function clockFor(timeZone: string, at: EpochMs) {
  let offset: number;
  try {
    offset = offsetFnForTimeZone(timeZone)(at);
  } catch {
    offset = offsetFnForTimeZone(DEFAULT_TIME_ZONE)(at);
  }
  return localClock(at, offset);
}

/** Kural eylemine göre izinli alıcılar (Faz 8 matrisi): notify → `canZoneNotify`, start_share → `canShareLocation`. */
interface RecipientSets {
  notify: Set<UserId>;
  start_share: Set<UserId>;
}

/** Aday alıcılar için iki yönlü izin denetimi (tek `getAll`). */
async function recipientSets(tx: Transaction, me: UserId, access: CallerAccess, ids: readonly UserId[]): Promise<RecipientSets> {
  const candidates = unique(ids).filter((u) => u !== me && isServerUid(u));
  const pairs = await readPairStates(tx, me, candidates);
  const out: RecipientSets = { notify: new Set(), start_share: new Set() };
  candidates.forEach((u, i) => {
    const input = pairInput(pairs[i], access);
    if (canZoneNotify(input)) out.notify.add(u);
    if (canShareLocation(input)) out.start_share.add(u);
  });
  return out;
}

const allowedFor = (sets: RecipientSets, action: ZoneAction): Set<UserId> => (action === 'notify' ? sets.notify : sets.start_share);

async function pushAll(uids: readonly UserId[], msg: PushMessage, send: PushSender, what: string): Promise<void> {
  const res = await Promise.allSettled(uids.map((u) => send(u, msg)));
  const failed = res.filter((r) => r.status === 'rejected').length;
  if (failed) logger.warn(`${what}: bazı alıcılara gönderilemedi`, { failed, total: res.length });
}

// ---------------------------------------------------------------------------
// zone_upsert
// ---------------------------------------------------------------------------

export async function zoneUpsert(ctx: CallCtx, data: z.output<typeof ZoneUpsertRequestSchema>): Promise<ZoneUpsertResponse> {
  const name = sanitizeNoteText(data.name, ZONE_LIMITS.nameMaxChars);
  if (!name) throw fail('invalid_argument', { extra: { field: 'name' } });
  const emoji = data.emoji ? sanitizeNoteText(data.emoji, NOTE_LIMITS.maxEmojiChars) : null;
  if (data.zone_id !== null) assertDocId(data.zone_id, 'zone_id');
  const timeZone = checkTimeZone(data.time_zone, ctx.now);
  const ruleIds = data.rules.map((r) => r.rule_id);
  if (new Set(ruleIds).size !== ruleIds.length) throw fail('invalid_argument', { extra: { field: 'rules' } });
  // Yeni belge kimliği transaction dışında (tekrar denemede aynı kalsın).
  const zoneId = data.zone_id ?? refs.zones(ctx.uid).doc().id;
  const allRecipients = data.rules.flatMap((r) => r.recipient_ids);

  return runOp(ctx, data.op_id, CALLABLES.zoneUpsert, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const ref = refs.zone(ctx.uid, zoneId);
    let existing: ZoneDoc | null = null;
    if (data.zone_id !== null) {
      const snap = await tx.get(ref);
      if (!snap.exists) throw fail('zone_not_found');
      existing = snap.data() as ZoneDoc;
    } else {
      const mine = await tx.get(refs.zones(ctx.uid));
      if (mine.size >= ZONE_LIMITS.maxZones) throw fail('zone_limit_reached');
    }
    // Kayıtta görünmezlik denetlenmez (kural ileride çalışır); olay anında `invisible` bastırılır.
    const sets = await recipientSets(tx, ctx.uid, { ...callerAccess(me), invisible: false }, allRecipients);

    const dropped = new Set<UserId>();
    const rules: ZoneRule[] = [];
    for (const r of data.rules) {
      const allowed = allowedFor(sets, r.action);
      const kept = unique(r.recipient_ids).filter((u) => {
        if (allowed.has(u)) return true;
        dropped.add(u);
        return false;
      });
      if (kept.length === 0) continue;
      rules.push({
        rule_id: r.rule_id,
        trigger: r.trigger,
        action: r.action,
        recipient_ids: kept,
        share_duration: r.action === 'start_share' ? (r.share_duration as DurationChoice | null) : null,
        days_mask: r.days_mask,
        window: r.window ? { from_min: r.window.from_min, to_min: r.window.to_min } : null,
        enabled: r.enabled,
      });
    }

    const doc: ZoneDoc = {
      zone_id: zoneId,
      owner_id: ctx.uid,
      kind: data.kind,
      name,
      emoji,
      center: { lat: data.center.lat, lng: data.center.lng },
      radius_m: data.radius_m,
      rules,
      enabled: data.enabled,
      time_zone: timeZone,
      created_at: existing?.created_at ?? ctx.now,
      updated_at: ctx.now,
    };
    tx.set(ref, doc);
    const response: ZoneUpsertResponse = { zone: toZone(doc), dropped_recipient_ids: [...dropped], server_now: ctx.now };
    return { response };
  });
}

// ---------------------------------------------------------------------------
// zone_delete
// ---------------------------------------------------------------------------

export async function zoneDelete(ctx: CallCtx, data: z.output<typeof ZoneDeleteRequestSchema>): Promise<ZoneDeleteResponse> {
  assertDocId(data.zone_id, 'zone_id');
  return runOp<ZoneDeleteResponse>(ctx, data.op_id, CALLABLES.zoneDelete, data, async (tx) => {
    const ref = refs.zone(ctx.uid, data.zone_id);
    const snap = await tx.get(ref);
    if (!snap.exists) return { response: { zone_id: data.zone_id, deleted: false, server_now: ctx.now } };
    tx.delete(ref);
    for (const t of ZONE_TRIGGERS) tx.delete(refs.zoneCooldown(ctx.uid, data.zone_id, t));
    return { response: { zone_id: data.zone_id, deleted: true, server_now: ctx.now } };
  });
}

// ---------------------------------------------------------------------------
// zone_event_report
// ---------------------------------------------------------------------------

export async function zoneEventReport(
  ctx: CallCtx,
  data: z.output<typeof ZoneEventReportRequestSchema>,
  deps: ZoneDeps = {},
): Promise<ZoneEventReportResponse> {
  const send = deps.send ?? sendPushToUser;
  assertDocId(data.zone_id, 'zone_id');
  const now = ctx.now;
  const occurredAt = data.occurred_at > now + LIMITS.zoneEventFutureSkewMs ? now : data.occurred_at;

  return runOp(ctx, data.op_id, CALLABLES.zoneEventReport, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const zoneSnap = await tx.get(refs.zone(ctx.uid, data.zone_id));
    if (!zoneSnap.exists) throw fail('zone_not_found');
    const zone = zoneSnap.data() as ZoneDoc;
    const cooldownRef = refs.zoneCooldown(ctx.uid, data.zone_id, data.transition);
    const dailyRef = refs.rateLimit(ctx.uid, DAILY_KEY);
    const [cdSnap, dailySnap] = await tx.getAll(cooldownRef, dailyRef);
    const cd = cdSnap?.data() as ZoneCooldownDoc | undefined;
    const daily = dailySnap?.data() as { window_start?: number; count?: number } | undefined;
    const dailyInWindow = daily?.window_start !== undefined && now - daily.window_start < DAY;
    const dailyStart = dailyInWindow ? (daily.window_start as number) : now;
    const dailyCount = dailyInWindow ? (daily.count ?? 0) : 0;

    let suppressed: Suppressed = null;
    let matched: ZoneRule[] = [];
    // Faz 8: görünmezken hiçbir bölge olayı bildirilmez / paylaşım açmaz (alıcıya neden söylenmez: push yok). Olay
    // görünmezken OLDUYSA (ör. çevrimdışı ikinci cihaz görünür olunca bildirir) da düşer: `visible_since` görünür
    // olma anıdır (yalnızca sunucu yazar).
    if (isInvisible(me) || (typeof me.visible_since === 'number' && occurredAt < me.visible_since)) suppressed = 'invisible';
    else if (now - occurredAt > ZONE_LIMITS.maxEventAgeMs) suppressed = 'stale';
    else if (!zone.enabled) suppressed = 'disabled';
    else {
      matched = matchZoneRules(zone, data.transition, clockFor(zone.time_zone, occurredAt));
      if (matched.length === 0) suppressed = 'outside_window';
      else if (cd && now - cd.last_at < ZONE_LIMITS.serverCooldownMs) suppressed = 'cooldown';
      else if (dailyCount >= ZONE_LIMITS.maxEventsPerDay) suppressed = 'daily_limit';
    }

    let notifyIds: UserId[] = [];
    let startShare: ZoneEventReportResponse['start_share'] = [];
    if (suppressed === null) {
      const sets = await recipientSets(
        tx,
        ctx.uid,
        callerAccess(me),
        matched.flatMap((r) => r.recipient_ids),
      );
      notifyIds = unique(matched.filter((r) => r.action === 'notify').flatMap((r) => r.recipient_ids)).filter((u) => sets.notify.has(u));
      startShare = matched
        .filter((r) => r.action === 'start_share' && r.share_duration)
        .map((r) => ({ rule_id: r.rule_id, recipient_ids: unique(r.recipient_ids).filter((u) => sets.start_share.has(u)), duration: r.share_duration as DurationChoice }))
        .filter((s) => s.recipient_ids.length > 0);
    }
    const acted = notifyIds.length > 0 || startShare.length > 0;

    // --- yazmalar ---
    if (acted) {
      tx.set(cooldownRef, {
        uid: ctx.uid,
        zone_id: data.zone_id,
        transition: data.transition,
        last_at: now,
        purge_at: Timestamp.fromMillis(now + LIMITS.zoneCooldownTtlMs),
      } satisfies ZoneCooldownDoc);
      tx.set(dailyRef, {
        window_start: dailyStart,
        count: dailyCount + 1,
        purge_at: Timestamp.fromMillis(dailyStart + DAY + LIMITS.opRecordTtlMs),
      });
    }
    const log: ZoneEventDoc = {
      zone_id: data.zone_id,
      transition: data.transition,
      occurred_at: occurredAt,
      notified: notifyIds.length,
      suppressed,
      reported_at: now,
      purge_at: Timestamp.fromMillis(now + ZONE_EVENT_LOG_TTL_MS),
    };
    tx.set(refs.zoneEvent(ctx.uid, data.op_id), log);

    const response: ZoneEventReportResponse = { notified: notifyIds.length, start_share: startShare, suppressed, server_now: now };
    const msg = notifyIds.length > 0 ? buildZoneEventPush(me.display_name ?? '', ctx.uid, zone.name, data.transition) : null;
    return { response, after: msg ? () => pushAll(notifyIds, msg, send, 'zone_event_report') : undefined };
  });
}

// ---------------------------------------------------------------------------
// Arkadaşlık bitince: karşı taraf bölge kurallarından çıkar (friends.ts)
// ---------------------------------------------------------------------------

export interface PairZoneCleanup {
  updates: { ref: DocumentReference; rules: ZoneRule[] }[];
}

/** Kurallardan `remove` çıkarılır; alıcısı kalmayan kural silinir. Değişiklik yoksa null. */
export function rulesWithout(rules: readonly ZoneRule[], remove: UserId): ZoneRule[] | null {
  if (!rules.some((r) => r.recipient_ids.includes(remove))) return null;
  return rules
    .map((r) => ({ ...r, recipient_ids: r.recipient_ids.filter((u) => u !== remove) }))
    .filter((r) => r.recipient_ids.length > 0);
}

/**
 * Okuma aşaması: iki kullanıcının bölgeleri (her biri ≤ 15 belge; iç içe dizi sorgulanamadığı için tümü okunur).
 * Transaction'da diğer okumalardan sonra, yazmalardan önce çağrılır.
 */
export async function readPairZoneCleanup(tx: Transaction, a: UserId, b: UserId): Promise<PairZoneCleanup> {
  const [za, zb] = await Promise.all([tx.get(refs.zones(a)), tx.get(refs.zones(b))]);
  const updates: PairZoneCleanup['updates'] = [];
  for (const [snap, other] of [
    [za, b],
    [zb, a],
  ] as const) {
    for (const d of snap.docs) {
      const next = rulesWithout((d.data() as ZoneDoc).rules ?? [], other);
      if (next) updates.push({ ref: d.ref, rules: next });
    }
  }
  return { updates };
}

export function writePairZoneCleanup(tx: Transaction, c: PairZoneCleanup, now: EpochMs): void {
  for (const u of c.updates) tx.update(u.ref, { rules: u.rules, updated_at: now });
}

/**
 * Faz 8 izin geri alma zinciri: `owner`ın bölgelerinde `action` kurallarının alıcılarından `remove` çıkar (alıcısı
 * kalmayan kural silinir). Okuma aşaması; yazma `writePairZoneCleanup`.
 */
export async function readZoneRecipientStrip(tx: Transaction, owner: UserId, remove: UserId, action: ZoneAction): Promise<PairZoneCleanup> {
  const snap = await tx.get(refs.zones(owner));
  const updates: PairZoneCleanup['updates'] = [];
  for (const d of snap.docs) {
    const rules = (d.data() as ZoneDoc).rules ?? [];
    if (!rules.some((r) => r.action === action && r.recipient_ids.includes(remove))) continue;
    const next = rules
      .map((r) => (r.action === action ? { ...r, recipient_ids: r.recipient_ids.filter((u) => u !== remove) } : r))
      .filter((r) => r.recipient_ids.length > 0);
    updates.push({ ref: d.ref, rules: next });
  }
  return { updates };
}

// ---------------------------------------------------------------------------
// Hesap silme
// ---------------------------------------------------------------------------

/** Kullanıcının bölgeleri, olay kaydı ve sunucu soğuma belgeleri silinir. */
export async function deleteZonesOf(uid: UserId): Promise<void> {
  await Promise.all([db().recursiveDelete(refs.zones(uid)), db().recursiveDelete(refs.zoneEvents(uid))]);
  const cds = await db().collection(COL.zoneCooldowns).where('uid', '==', uid).get();
  for (const part of chunk(cds.docs, 400)) {
    const batch = db().batch();
    for (const d of part) batch.delete(d.ref);
    await batch.commit();
  }
}
