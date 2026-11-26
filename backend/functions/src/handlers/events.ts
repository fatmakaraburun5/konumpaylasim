/**
 * Faz 7: Etkinlik Alanı — 3 aşamalı oylama (bkz. docs/PHASE7.md §1–§3, durum makinesi core `events.ts`).
 *
 * Callable'lar: `event_create`, `event_rsvp`, `event_venue_propose`, `event_venue_remove`, `event_vote`,
 * `event_advance` (sahip: mekan oylamasını aç / mekan ya da saat oylamasını kapat), `event_time_options_set`,
 * `event_update`, `event_invite_add`, `event_cancel`. Hepsi `runOp` (op_id tekilleştirme) içinde, aynı transaction'da:
 *  1. `events/{id}` + çağıranın profili okunur; üye değilse / belge yoksa hepsi AYNI `event_not_found`.
 *  2. Onay kapısı (`readCaller`): "Katılamayacağım" yanıtı ve iptal onaysız da çalışır (core `consentExemptCall`).
 *  3. Kullanıcı başına saatlik `EVENT_LIMITS.actionsPerHour` (oluşturma günlük `createsPerDay`).
 *  4. core `reduceEvent` → yeni belge + etkiler. `changed: false` ise yazma / bildirim yok.
 *  5. Etkiler: hatırlatıcı belgeleri (`event_reminders`) ve bildirim kutusu kayıtları (`users/{uid}/notices`) aynı
 *     transaction'da; push commit SONRASI en iyi çabayla (`runOp.after`).
 *
 * Davet (Faz 8 "arkadaşlık izin değildir"): yalnızca bana `meetup_invite` izni vermiş, engelsiz arkadaşlar
 * (`canInvite`). Diğerleri SESSİZCE düşer ve yalnızca SAYISI döner (`skipped_count`); hiç kalmazsa `not_permitted`
 * (arkadaş var ama izin yok) ya da `not_friends`. Görünmez mod daveti engellemez (konum içermez).
 *
 * Süpürücü (`sweepEvents`, dakikada bir): `open == true && next_action_at <= now` etkinliklere `tick` (oylama süresi
 * doldu → kapanış, gün bitti → `expired`, başlangıç + 3 sa → `completed`); `sent == false && due_at <= now`
 * hatırlatıcılar gönderilir (etkinlik hâlâ `final` ve başlangıç aynıysa; 2 saatten geç kalan `stale` sayılır).
 * Arkadaşlık bitince / engellenince (`removePairFromEvents`) ve hesap silinince (`deleteEventsOf`) üyelik temizlenir.
 */
import {
  CALLABLES,
  DAY,
  EVENT_LIMITS,
  EVENT_REMINDER_KINDS,
  EVENT_REMINDER_MAX_LATENESS_MS,
  HOUR,
  NOTICE_RETENTION_MS,
  type CallableName,
  type EpochMs,
  type EventAction,
  type EventAdvanceRequestSchema,
  type EventCancelRequestSchema,
  type EventCreateRequestSchema,
  type EventCtx,
  type EventDoc,
  type EventEffect,
  type EventInviteAddRequestSchema,
  type EventNoticeType,
  type EventReminderKind,
  type EventResponse,
  type EventResult,
  type EventRsvpRequestSchema,
  type EventTimeOptionsSetRequestSchema,
  type EventUpdateRequestSchema,
  type EventVenueProposeRequestSchema,
  type EventVenueRemoveRequestSchema,
  type EventVoteRequestSchema,
  type UserId,
  canInvite,
  consentExemptCall,
  createEventDoc,
  eventCancelledPushText,
  eventInvitePushText,
  eventNextActionAt,
  eventReminderId,
  eventReminderPushText,
  eventReminderRecipients,
  eventRsvpPushText,
  eventStagePushText,
  isActiveEventStage,
  offsetFnForTimeZone,
  parseEventDoc,
  reduceEvent,
} from '@konum/core';
import { type DocumentReference, Timestamp, type Transaction } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { COL, type UserDoc, refs } from '../docs';
import { fail } from '../errors';
import { callerAccess, isFriend, pairInput, readCaller, readPairStates } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type EventPushData, type PushSender, buildEventPush, sendPushToUser } from '../push';
import { assertDocId, isServerUid, unique } from '../util';

export interface EventDeps {
  send?: PushSender;
}

/** Firestore'daki biçim: core `EventDoc` + yalnızca sunucunun kullandığı alanlar. */
export interface EventStoredDoc extends EventDoc {
  /** Etkin aşamada mı (süpürücü sorgusu). */
  open: boolean;
  /** Süpürücünün bir sonraki bakacağı an (core `eventNextActionAt`). */
  next_action_at: EpochMs | null;
  /** Bittikten 30 gün sonra TTL. */
  purge_at: Timestamp | null;
}

/** `event_reminders/{event_id}_{kind}` (istemciye kapalı). */
export interface EventReminderDoc {
  event_id: string;
  kind: EventReminderKind;
  due_at: EpochMs;
  /** Planlandığı andaki başlangıç: değiştiyse hatırlatma geçersiz. */
  starts_at: EpochMs;
  sent: boolean;
  sent_at: EpochMs | null;
  outcome: 'sent' | 'stale' | 'cancelled' | null;
  created_at: EpochMs;
  purge_at: Timestamp;
}

export interface NoticeDoc {
  notice_id: string;
  type: EventNoticeType;
  event_id: string;
  title: string;
  body: string;
  created_at: EpochMs;
  purge_at: Timestamp;
}

const notFound = () => fail('event_not_found');

const ctxFor = (doc: Pick<EventDoc, 'time_zone'>, now: EpochMs): EventCtx => ({ now, offsetAt: offsetFnForTimeZone(doc.time_zone) });

export function toStored(doc: EventDoc): EventStoredDoc {
  const open = isActiveEventStage(doc.stage);
  return {
    ...doc,
    open,
    next_action_at: eventNextActionAt(doc),
    purge_at: open ? Timestamp.fromMillis(doc.expires_at + EVENT_LIMITS.retentionMs) : Timestamp.fromMillis((doc.ended_at ?? doc.updated_at) + EVENT_LIMITS.retentionMs),
  };
}

/** Belgeyi okur ve doğrular (bozuksa null; sunucu alanları atılır). */
export const readEventDoc = (raw: unknown): EventDoc | null => parseEventDoc(raw);

function failFrom(r: Extract<EventResult, { ok: false }>): never {
  throw fail(r.error, r.extra ? { extra: r.extra } : {});
}

/** Push + bildirim kutusu için hazırlanan tek gönderim. */
interface Outgoing {
  to: UserId[];
  type: EventNoticeType;
  text: { title: string; body: string };
  data: EventPushData;
}

/** Etkileri bildirimlere çevirir (alıcılar üyelerle sınırlı, tekil). */
export function eventOutgoing(doc: EventDoc, effects: readonly EventEffect[]): Outgoing[] {
  const members = new Set(doc.member_ids);
  const ownerName = doc.names[doc.owner_id] ?? '';
  const out: Outgoing[] = [];
  for (const e of effects) {
    if (e.type === 'reminders') continue;
    // Üye olmayana asla gitmez (iptalde üyelik listesi değişmez; davet edilenler zaten üye).
    const to = unique(e.to).filter((u) => members.has(u));
    if (to.length === 0) continue;
    switch (e.type) {
      case 'invite':
        out.push({ to, type: 'event_invite', text: eventInvitePushText(ownerName, doc), data: { type: 'event_invite', event_id: doc.event_id, from: doc.owner_id } });
        break;
      case 'stage':
        out.push({ to, type: 'event_stage', text: eventStagePushText(e.notice, doc), data: { type: 'event_stage', event_id: doc.event_id, notice: e.notice } });
        break;
      case 'rsvp':
        out.push({
          to,
          type: 'event_rsvp',
          text: eventRsvpPushText(doc.names[e.by] ?? '', doc, e.status, e.note),
          data: { type: 'event_rsvp', event_id: doc.event_id, by: e.by, round: e.round, status: e.status },
        });
        break;
      case 'cancelled':
        out.push({ to, type: 'event_cancelled', text: eventCancelledPushText(ownerName, doc), data: { type: 'event_cancelled', event_id: doc.event_id } });
        break;
    }
  }
  return out;
}

/** Bildirim kutusu kayıtları (aynı transaction'da). */
function writeNotices(tx: Transaction, outgoing: readonly Outgoing[], now: EpochMs): void {
  for (const o of outgoing) {
    for (const u of o.to) {
      const ref = refs.notices(u).doc();
      tx.set(ref, {
        notice_id: ref.id,
        type: o.type,
        event_id: o.data.event_id,
        title: o.text.title,
        body: o.text.body,
        created_at: now,
        purge_at: Timestamp.fromMillis(now + NOTICE_RETENTION_MS),
      } satisfies NoticeDoc);
    }
  }
}

/** Hatırlatıcı etkisi: listede olmayan türler iptal edilir, olanlar (yeniden) planlanır. */
function writeReminders(tx: Transaction, doc: EventDoc, effects: readonly EventEffect[], now: EpochMs): void {
  const eff = [...effects].reverse().find((e): e is Extract<EventEffect, { type: 'reminders' }> => e.type === 'reminders');
  if (!eff) return;
  for (const kind of EVENT_REMINDER_KINDS) {
    const ref = refs.eventReminder(eventReminderId(doc.event_id, kind));
    const item = eff.items.find((i) => i.kind === kind);
    if (!item || doc.starts_at === null) {
      tx.delete(ref);
      continue;
    }
    tx.set(ref, {
      event_id: doc.event_id,
      kind,
      due_at: item.due_at,
      starts_at: doc.starts_at,
      sent: false,
      sent_at: null,
      outcome: null,
      created_at: now,
      purge_at: Timestamp.fromMillis(doc.starts_at + DAY),
    } satisfies EventReminderDoc);
  }
}

async function pushOutgoing(outgoing: readonly Outgoing[], send: PushSender): Promise<void> {
  const jobs = outgoing.flatMap((o) => o.to.map((u) => send(u, buildEventPush(o.text, o.data))));
  const res = await Promise.allSettled(jobs);
  const failed = res.filter((r) => r.status === 'rejected').length;
  if (failed) logger.warn('etkinlik bildirimi: bazı alıcılara gönderilemedi', { failed, total: res.length });
}

/** Değişen belgeyi + etkileri yazar; push'u döner (commit sonrası). */
function commitResult(tx: Transaction, ref: DocumentReference, doc: EventDoc, effects: readonly EventEffect[], now: EpochMs, send: PushSender) {
  tx.set(ref, toStored(doc));
  writeReminders(tx, doc, effects, now);
  const outgoing = eventOutgoing(doc, effects);
  writeNotices(tx, outgoing, now);
  return outgoing.length ? () => pushOutgoing(outgoing, send) : undefined;
}

const response = (event: EventDoc, now: EpochMs, skipped = 0): EventResponse => ({ event, skipped_count: skipped, server_now: now });

/** Davet edilebilir kişileri süzer (Faz 8 `canInvite`) ve görünen adlarını okur. */
async function filterInvitees(tx: Transaction, me: UserDoc, uid: UserId, candidates: readonly UserId[]): Promise<{ allowed: UserId[]; names: Record<UserId, string>; anyFriend: boolean }> {
  const list = unique(candidates).filter((u) => u !== uid && isServerUid(u));
  if (list.length === 0) return { allowed: [], names: {}, anyFriend: false };
  const pairs = await readPairStates(tx, uid, list);
  const access = callerAccess(me);
  const allowed = list.filter((_, i) => canInvite(pairInput(pairs[i], access)));
  const anyFriend = list.some((_, i) => isFriend(pairs[i]));
  const names: Record<UserId, string> = {};
  if (allowed.length) {
    const snaps = await tx.getAll(...allowed.map((u) => refs.user(u)));
    allowed.forEach((u, i) => {
      const d = snaps[i]?.data() as UserDoc | undefined;
      names[u] = d?.display_name ?? '';
    });
  }
  return { allowed, names, anyFriend };
}

// ---------------------------------------------------------------------------
// event_create
// ---------------------------------------------------------------------------

export async function eventCreate(ctx: CallCtx, data: z.output<typeof EventCreateRequestSchema>, deps: EventDeps = {}): Promise<EventResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const eventId = refs.newEvent().id;
  return runOp(ctx, data.op_id, CALLABLES.eventCreate, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const rate = await readRateLimit(tx, ctx.uid, 'event_create', EVENT_LIMITS.createsPerDay, DAY, now);
    const active = await tx.get(db().collection(COL.events).where('owner_id', '==', ctx.uid).where('open', '==', true).limit(EVENT_LIMITS.maxActivePerOwner));
    if (active.size >= EVENT_LIMITS.maxActivePerOwner) throw fail('event_limit_reached');
    const { allowed, names, anyFriend } = await filterInvitees(tx, me, ctx.uid, data.invitee_ids);
    if (allowed.length === 0) throw fail(anyFriend ? 'not_permitted' : 'not_friends');
    const ectx: EventCtx = { now, offsetAt: offsetFnForTimeZone(data.time_zone) };
    const r = createEventDoc(
      eventId,
      ctx.uid,
      {
        title: data.title,
        description: data.description,
        date: data.date,
        time_zone: data.time_zone,
        invitee_ids: allowed,
        names: { ...names, [ctx.uid]: me.display_name ?? '' },
        venue_options: data.venue_options,
        time_minutes: data.time_minutes,
        vote_window_ms: data.vote_window_ms,
      },
      ectx,
    );
    if (!r.ok) failFrom(r);
    writeRateLimit(tx, rate, DAY);
    const after = commitResult(tx, refs.event(eventId), r.doc, r.effects, now, send);
    return { response: response(r.doc, now, unique(data.invitee_ids).filter((u) => u !== ctx.uid).length - allowed.length), after };
  });
}

// ---------------------------------------------------------------------------
// Ortak: mevcut etkinlikte tek eylem
// ---------------------------------------------------------------------------

interface MutateOptions {
  /** Eylemi okunan belgeden kurar (ör. davet süzgeci). */
  build: (tx: Transaction, doc: EventDoc, me: UserDoc) => Promise<{ action: EventAction; skipped?: number }>;
}

async function mutateEvent(
  ctx: CallCtx,
  op: CallableName,
  data: { op_id: string; event_id: string },
  deps: EventDeps,
  opts: MutateOptions,
): Promise<EventResponse> {
  assertDocId(data.event_id, 'event_id');
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const ref = refs.event(data.event_id);
  return runOp(ctx, data.op_id, op, data, async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists ? readEventDoc(snap.data()) : null;
    if (!doc || !doc.member_ids.includes(ctx.uid)) throw notFound();
    const me = await readCaller(tx, ctx.uid, { consent: !consentExemptCall(op, data) });
    const rate = await readRateLimit(tx, ctx.uid, 'event_action', EVENT_LIMITS.actionsPerHour, HOUR, now);
    const { action, skipped = 0 } = await opts.build(tx, doc, me);
    const r = reduceEvent(doc, ctx.uid, action, ctxFor(doc, now));
    if (!r.ok) failFrom(r);
    writeRateLimit(tx, rate, HOUR);
    if (!r.changed) return { response: response(r.doc, now, skipped) };
    const after = commitResult(tx, ref, r.doc, r.effects, now, send);
    return { response: response(r.doc, now, skipped), after };
  });
}

const fixed = (action: EventAction): MutateOptions => ({ build: async () => ({ action }) });

export const eventRsvp = (ctx: CallCtx, data: z.output<typeof EventRsvpRequestSchema>, deps: EventDeps = {}) =>
  mutateEvent(ctx, CALLABLES.eventRsvp, data, deps, fixed({ type: 'rsvp', round: data.round, status: data.status, note: data.note }));

export const eventVenuePropose = (ctx: CallCtx, data: z.output<typeof EventVenueProposeRequestSchema>, deps: EventDeps = {}) =>
  mutateEvent(ctx, CALLABLES.eventVenuePropose, data, deps, fixed({ type: 'venue_propose', venue: data.venue }));

export const eventVenueRemove = (ctx: CallCtx, data: z.output<typeof EventVenueRemoveRequestSchema>, deps: EventDeps = {}) =>
  mutateEvent(ctx, CALLABLES.eventVenueRemove, data, deps, fixed({ type: 'venue_remove', option_id: data.option_id }));

export const eventVote = (ctx: CallCtx, data: z.output<typeof EventVoteRequestSchema>, deps: EventDeps = {}) =>
  mutateEvent(ctx, CALLABLES.eventVote, data, deps, fixed({ type: 'vote', kind: data.kind, option_id: data.option_id }));

export function eventAdvance(ctx: CallCtx, data: z.output<typeof EventAdvanceRequestSchema>, deps: EventDeps = {}) {
  const action: EventAction =
    data.action === 'open_venue_vote'
      ? { type: 'open_venue_vote', vote_window_ms: data.vote_window_ms }
      : { type: 'close_vote', kind: data.action === 'close_venue_vote' ? 'venue' : 'time', tie_break_option_id: data.tie_break_option_id };
  return mutateEvent(ctx, CALLABLES.eventAdvance, data, deps, fixed(action));
}

export const eventTimeOptionsSet = (ctx: CallCtx, data: z.output<typeof EventTimeOptionsSetRequestSchema>, deps: EventDeps = {}) =>
  mutateEvent(ctx, CALLABLES.eventTimeOptionsSet, data, deps, fixed({ type: 'time_options_set', minutes: data.minutes }));

export const eventUpdate = (ctx: CallCtx, data: z.output<typeof EventUpdateRequestSchema>, deps: EventDeps = {}) =>
  mutateEvent(
    ctx,
    CALLABLES.eventUpdate,
    data,
    deps,
    fixed({
      type: 'update',
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.date !== undefined ? { date: data.date } : {}),
    }),
  );

export const eventCancel = (ctx: CallCtx, data: z.output<typeof EventCancelRequestSchema>, deps: EventDeps = {}) =>
  mutateEvent(ctx, CALLABLES.eventCancel, data, deps, fixed({ type: 'cancel' }));

export function eventInviteAdd(ctx: CallCtx, data: z.output<typeof EventInviteAddRequestSchema>, deps: EventDeps = {}) {
  return mutateEvent(ctx, CALLABLES.eventInviteAdd, data, deps, {
    build: async (tx, doc, me) => {
      if (doc.owner_id !== ctx.uid) throw fail('event_not_owner');
      const fresh = unique(data.invitee_ids).filter((u) => u !== doc.owner_id && !doc.invitee_ids.includes(u));
      const { allowed, names, anyFriend } = await filterInvitees(tx, me, ctx.uid, fresh);
      if (fresh.length > 0 && allowed.length === 0) throw fail(anyFriend ? 'not_permitted' : 'not_friends');
      return { action: { type: 'invite_add', invitee_ids: allowed, names }, skipped: fresh.length - allowed.length };
    },
  });
}

// ---------------------------------------------------------------------------
// Süpürücü: aşama süreleri ve hatırlatıcılar
// ---------------------------------------------------------------------------

export interface EventSweepResult {
  ticked: string[];
  reminders_sent: string[];
  reminders_stale: string[];
  reminders_dropped: string[];
}

/** Tek etkinliğe sistem eylemi (tick / üye çıkarma) uygular; değiştiyse yazar ve push'u döner. */
async function applySystemAction(eventId: string, action: EventAction, now: EpochMs, send: PushSender): Promise<boolean> {
  const ref = refs.event(eventId);
  const after = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists ? readEventDoc(snap.data()) : null;
    if (!doc) return { changed: false as const };
    const r = reduceEvent(doc, 'system', action, ctxFor(doc, now));
    if (!r.ok || !r.changed) return { changed: false as const };
    return { changed: true as const, push: commitResult(tx, ref, r.doc, r.effects, now, send) };
  });
  if (after.changed && after.push) {
    try {
      await after.push();
    } catch (err) {
      logger.warn('etkinlik süpürücü: push başarısız', { err: String(err) });
    }
  }
  return after.changed;
}

/** Hatırlatma gönderimi (transaction: yalnızca bir kez). */
async function fireReminder(id: string, now: EpochMs, send: PushSender): Promise<'sent' | 'stale' | 'dropped' | 'noop'> {
  const remRef = refs.eventReminder(id);
  const out = await db().runTransaction(async (tx) => {
    const rs = await tx.get(remRef);
    const rem = rs.data() as EventReminderDoc | undefined;
    if (!rem || rem.sent) return { kind: 'noop' as const };
    const es = await tx.get(refs.event(rem.event_id));
    const doc = es.exists ? readEventDoc(es.data()) : null;
    if (!doc || doc.stage !== 'final' || doc.starts_at !== rem.starts_at) {
      tx.delete(remRef);
      return { kind: 'dropped' as const };
    }
    if (now - rem.due_at > EVENT_REMINDER_MAX_LATENESS_MS || now >= doc.starts_at) {
      tx.update(remRef, { sent: true, sent_at: now, outcome: 'stale' });
      return { kind: 'stale' as const };
    }
    const to = eventReminderRecipients(doc);
    const text = eventReminderPushText(rem.kind, doc);
    const outgoing: Outgoing = { to, type: 'event_reminder', text, data: { type: 'event_reminder', event_id: doc.event_id, kind: rem.kind } };
    writeNotices(tx, [outgoing], now);
    tx.update(remRef, { sent: true, sent_at: now, outcome: 'sent' });
    return { kind: 'sent' as const, outgoing };
  });
  if (out.kind === 'sent') await pushOutgoing([out.outgoing], send);
  return out.kind;
}

export async function sweepEvents(now: EpochMs = Date.now(), deps: EventDeps = {}, max = 200): Promise<EventSweepResult> {
  const send = deps.send ?? sendPushToUser;
  const result: EventSweepResult = { ticked: [], reminders_sent: [], reminders_stale: [], reminders_dropped: [] };
  const due = await db().collection(COL.events).where('open', '==', true).where('next_action_at', '<=', now).orderBy('next_action_at').limit(max).get();
  for (const d of due.docs) {
    try {
      if (await applySystemAction(d.id, { type: 'tick' }, now, send)) result.ticked.push(d.id);
    } catch (err) {
      logger.warn('etkinlik süpürücü: tick başarısız', { event_id: d.id, err: String(err) });
    }
  }
  const rems = await db().collection(COL.eventReminders).where('sent', '==', false).where('due_at', '<=', now).orderBy('due_at').limit(max).get();
  for (const r of rems.docs) {
    try {
      const k = await fireReminder(r.id, now, send);
      if (k === 'sent') result.reminders_sent.push(r.id);
      else if (k === 'stale') result.reminders_stale.push(r.id);
      else if (k === 'dropped') result.reminders_dropped.push(r.id);
    } catch (err) {
      logger.warn('etkinlik süpürücü: hatırlatma başarısız', { reminder_id: r.id, err: String(err) });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Grafik temizliği
// ---------------------------------------------------------------------------

/**
 * Arkadaşlık bitti / engellendi: sahibi biri, davetlisi diğeri olan etkin etkinliklerden davetli çıkarılır (oyları ve
 * yanıtı silinir; kalanlar oy verdiyse oylama kendiliğinden kapanabilir). Commit sonrası en iyi çaba.
 */
export async function removePairFromEvents(a: UserId, b: UserId, now: EpochMs, deps: EventDeps = {}): Promise<number> {
  const send = deps.send ?? sendPushToUser;
  const snap = await db().collection(COL.events).where('member_ids', 'array-contains', a).get();
  let n = 0;
  for (const d of snap.docs) {
    const owner = d.get('owner_id') as string;
    const members = (d.get('member_ids') as string[] | undefined) ?? [];
    if (!d.get('open') || !members.includes(b)) continue;
    const target = owner === a ? b : owner === b ? a : null;
    if (!target) continue;
    if (await applySystemAction(d.id, { type: 'remove_member', uid: target }, now, send)) n += 1;
  }
  return n;
}

/** Hesap silme: sahibi olduğu etkinlikler iptal + silinir, davetli olduklarından çıkarılır; bildirim kutusu silinir. */
export async function deleteEventsOf(uid: UserId, now: EpochMs = Date.now()): Promise<void> {
  const noop: PushSender = async () => ({ sent: 0, removed: 0 });
  const snap = await db().collection(COL.events).where('member_ids', 'array-contains', uid).get();
  for (const d of snap.docs) {
    if (d.get('owner_id') === uid) {
      for (const kind of EVENT_REMINDER_KINDS) await refs.eventReminder(eventReminderId(d.id, kind)).delete();
      await d.ref.delete();
    } else {
      await applySystemAction(d.id, { type: 'remove_member', uid }, now, noop);
    }
  }
  await db().recursiveDelete(refs.notices(uid));
}
