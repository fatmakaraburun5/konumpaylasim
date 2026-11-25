/**
 * Faz 5: harita üzerinde "Buluşma noktası" — `meetup_suggest`, `meetup_share`, `meetup_respond`, `meetup_cancel`.
 *
 * `meetup_suggest` (durum yazmaz; Google Places API (New) + Routes `computeRouteMatrix` sunucu vekili):
 *  1. Katılımcı anahtarları benzersiz ve biri 'me' olmalı (yoksa `invalid_argument`, `field: participants`).
 *     Konumlar istemciden gelir (kendi konumu, görünen arkadaş konumu ya da seçilen hedef); sunucu arkadaşlığı
 *     doğrulamaz [Varsayım]: anahtarlar yalnızca etikettir, yanıt yeni bilgi sızdırmaz.
 *  2. `center = meetupCenter`, `spread = meetupSpreadM`. spread × 2 < `tooCloseM` → `too_close` + orta nokta;
 *     spread > `maxSpreadM` → `too_far`, öneri yok. Bu iki durumda Google'a gidilmez, kota işlemez.
 *  3. Önbellek `meetup_cache/{özet}`: core `meetupCacheKey` + uid + katılımcı anahtar↔hücre↔mod eşlemesi
 *     (kullanıcıya özel: başkasının katılımcı kimlikleri / ETA'ları dönmez). `cacheTtlMs`; isabet kota yemez.
 *  4. Anahtar yok ya da Maps kesme anahtarı kapalı (`config/maps.disabled` / route bütçesi 0) →
 *     `places_unavailable` + orta nokta. Places ağ / HTTP hatası da aynı yedeğe düşer.
 *  5. Kullanıcı başına günlük `perUserDailyLimit` (`maps_quota/{uid}_{gün}.meetup`, Google'dan ÖNCE transaction ile
 *     ayrılır) aşılırsa `quota_exceeded` + orta nokta (kuş uçuşu `fallbackEta`).
 *  6. Places Nearby (`placesNearbyRequestBody`, `X-Goog-FieldMask: PLACES_FIELD_MASK`) → 0 sonuç `no_results` +
 *     orta nokta; aksi hâlde `nearestCandidates` K aday → ulaşım modu başına tek `computeRouteMatrix`
 *     (`ROUTE_MATRIX_FIELD_MASK`). Matris hücresi yoksa / matris çağrısı başarısızsa o katılımcı için `fallbackEta`
 *     (`estimated: true`). `rankMeetupCandidates` ilk `resultCount` öneriyi döner.
 *  Loglarda koordinat / yer adı / URL YOK: yalnızca tür, HTTP durum kodu ve sonuç sınıfı.
 *
 * `meetup_share`: alıcılar kabul edilmiş + engelsiz arkadaşlar (diğerleri sessizce düşer; hiç kalmazsa
 *  `not_friends`); `etas` içindeki 'me' anahtarı çağıranın uid'ine çevrilir; yer adı / adres / not temizlenir;
 *  `expires_at = now + shareTtlMs`. Belge `meetups/{id}` (gönderen + alıcılar okur). Her alıcıya `meetup` push.
 *  Faz 8 (core `canInvite` / `meetupEtaAllowed`): alıcı yalnızca bana `meetup_invite` izni vermiş arkadaş olabilir
 *  (arkadaş var ama izinli yoksa `not_permitted`). ETA'lar konumdan türetilir: benim ETA'm yalnızca TÜM alıcılara
 *  `location_view` iznim varsa ve görünür isem kalır; başka bir katılımcının (Z) ETA'sı yalnızca Z alıcıysa, görünürse
 *  ve Z bana ve diğer TÜM alıcılara `location_view` vermişse kalır; diğerleri sessizce çıkarılır.
 * `meetup_respond`: yalnızca `to` içindeki ve önerenle hâlâ arkadaş olan kullanıcı; belge yok / aktif değil / üye
 *  değil → hepsi AYNI `meetup_not_found`. `responses.{uid}`; değiştiyse önerene `meetup_response` push.
 * `meetup_cancel`: yalnızca öneren; `status: cancelled` (idempotent). Alıcılara push YOK [Varsayım]: kart dinleyiciyle
 *  kapanır.
 * Süpürücü: süresi geçen `meetups` ve `meetup_cache` belgeleri silinir. Hesap silme: gönderdiği öneriler ve önbelleği
 *  silinir, aldığı önerilerin `to` listesinden çıkarılır.
 */
import {
  CALLABLES,
  HOUR,
  MEETUP_LIMITS,
  PLACES_FIELD_MASK,
  PLACES_NEARBY_URL,
  ROUTE_MATRIX_FIELD_MASK,
  ROUTE_MATRIX_URL,
  type EpochMs,
  type LatLng,
  type Meetup,
  type MeetupCancelRequestSchema,
  type MeetupEta,
  type MeetupParticipant,
  type MeetupPlace,
  type MeetupRespondRequestSchema,
  type MeetupResponse,
  type MeetupShareRequestSchema,
  type MeetupSuggestRequestSchema,
  type MeetupSuggestResponse,
  type MeetupSuggestion,
  type TravelMode,
  type UserId,
  canInvite,
  fallbackEta,
  geohashEncode,
  meetupEtaAllowed,
  isMeetupActive,
  meetupCacheKey,
  meetupCenter,
  meetupScore,
  meetupSpreadM,
  nearestCandidates,
  parsePlacesNearbyResponse,
  parseRouteMatrixResponse,
  placesNearbyRequestBody,
  quotaDay,
  rankMeetupCandidates,
  routeMatrixRequestBody,
  sanitizeNoteText,
  searchRadiusM,
} from '@konum/core';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS, MAPS } from '../config';
import { COL, type MeetupCacheDoc, type MeetupDoc, type UserDoc, refs, toMeetup } from '../docs';
import { fail } from '../errors';
import { assertConsent, callerAccess, isFriend, pairInput, readCaller, readPairStates } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushMessage, type PushSender, buildMeetupPush, buildMeetupResponsePush, sendPushToUser } from '../push';
import { assertDocId, chunk, isServerUid, sha256Hex, unique } from '../util';
import { type MapsDeps, callGoogle, defaultMapsDeps } from './maps';

/** "Orta nokta" önerisinin adı. [Varsayım] */
export const MIDPOINT_NAME = 'Orta nokta';

export interface MeetupShareDeps {
  send?: PushSender;
}

type SuggestInput = z.output<typeof MeetupSuggestRequestSchema>;
type Fallback = MeetupSuggestResponse['fallback'];

async function pushAll(uids: readonly UserId[], msg: PushMessage, send: PushSender, what: string): Promise<void> {
  const res = await Promise.allSettled(uids.map((u) => send(u, msg)));
  const failed = res.filter((r) => r.status === 'rejected').length;
  if (failed) logger.warn(`${what}: bazı alıcılara gönderilemedi`, { failed, total: res.length });
}

// ---------------------------------------------------------------------------
// meetup_suggest
// ---------------------------------------------------------------------------

/** Yalnızca orta nokta önerisi (kuş uçuşu ETA, `estimated: true`). */
export function midpointSuggestion(center: LatLng, participants: readonly MeetupParticipant[]): MeetupSuggestion {
  const place: MeetupPlace = { place_id: null, name: MIDPOINT_NAME, address: null, location: center, primary_type: null, category: 'midpoint' };
  const etas: MeetupEta[] = participants.map((p) => ({ key: p.key, ...fallbackEta(p.position, center, p.mode), estimated: true }));
  return { place, etas, ...meetupScore(etas) };
}

/** Kullanıcıya özel önbellek belge kimliği (core anahtarı + uid + katılımcı anahtar↔hücre↔mod). */
export function meetupCacheDocId(uid: UserId, data: Pick<SuggestInput, 'participants' | 'category'>, center: LatLng): string {
  const keyed = data.participants.map((p) => `${p.key}@${geohashEncode(p.position.lat, p.position.lng, 6)}:${p.mode}`).sort();
  return sha256Hex(`${meetupCacheKey(center, data.category, data.participants)}|${uid}|${keyed.join(',')}`).slice(0, 40);
}

/** Günlük öneri sayacından bir birim ayırır; sınır doluysa false. */
async function reserveMeetupQuota(uid: UserId, now: EpochMs): Promise<boolean> {
  const day = quotaDay(now);
  const ref = refs.mapsQuota(uid, day);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = Number((snap.data() as Record<string, unknown> | undefined)?.meetup ?? 0) || 0;
    if (used >= MEETUP_LIMITS.perUserDailyLimit) return false;
    tx.set(ref, { uid, day, meetup: used + 1, updated_at: now, purge_at: Timestamp.fromMillis(now + MAPS.quotaDocTtlMs) }, { merge: true });
    return true;
  });
}

export async function meetupSuggest(ctx: CallCtx, data: SuggestInput, deps: MapsDeps = defaultMapsDeps()): Promise<MeetupSuggestResponse> {
  const participants: MeetupParticipant[] = data.participants.map((p) => ({ key: p.key, position: { lat: p.position.lat, lng: p.position.lng }, mode: p.mode }));
  const keys = participants.map((p) => p.key);
  if (new Set(keys).size !== keys.length || !keys.includes('me')) {
    throw fail('invalid_argument', { extra: { field: 'participants' } });
  }
  const points = participants.map((p) => p.position);
  const center = meetupCenter(points);
  const spread = meetupSpreadM(center, points);
  const radius = searchRadiusM(spread);
  const now = ctx.now;
  const respond = (suggestions: MeetupSuggestion[], fallback: Fallback, cached = false): MeetupSuggestResponse => ({
    center,
    search_radius_m: radius,
    suggestions,
    fallback,
    cached,
    server_now: now,
  });
  const midpointOnly = (fallback: Fallback) => respond([midpointSuggestion(center, participants)], fallback);

  // Google'a gitmeden karar verilenler (kota işlemez).
  if (spread * 2 < MEETUP_LIMITS.tooCloseM) return midpointOnly('too_close');
  if (spread > MEETUP_LIMITS.maxSpreadM) return respond([], 'too_far');

  // Önbellek (kota sayılmaz, anahtar gerekmez).
  const cacheRef = refs.meetupCache(meetupCacheDocId(ctx.uid, data, center));
  const hit = (await cacheRef.get()).data() as MeetupCacheDoc | undefined;
  if (hit && hit.uid === ctx.uid && hit.expires_at > now) return { ...hit.response, cached: true, server_now: now };

  // Anahtar ve proje geneli kesme anahtarı.
  const apiKey = deps.apiKey();
  if (!apiKey) return midpointOnly('places_unavailable');
  const budget = await deps.budget();
  if (budget.disabled || budget.route <= 0) return midpointOnly('places_unavailable');

  // Kullanıcı günlük kotası (Google'dan önce).
  if (!(await reserveMeetupQuota(ctx.uid, now))) return midpointOnly('quota_exceeded');

  const save = async (r: MeetupSuggestResponse): Promise<MeetupSuggestResponse> => {
    const { cached: _c, server_now: _s, ...rest } = r;
    const expires_at = now + MEETUP_LIMITS.cacheTtlMs;
    try {
      await cacheRef.set({ uid: ctx.uid, response: rest, created_at: now, expires_at, expire_at: Timestamp.fromMillis(expires_at) } satisfies MeetupCacheDoc);
    } catch (err) {
      logger.warn('meetup: önbelleğe yazılamadı', { err: String(err) });
    }
    return r;
  };

  // 1. Places Nearby.
  let places: MeetupPlace[];
  try {
    const r = await callGoogle('places', deps, PLACES_NEARBY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACES_FIELD_MASK },
      body: JSON.stringify(placesNearbyRequestBody(center, radius, data.category)),
    });
    if (!r.ok) {
      logger.warn('meetup: Places API hata kodu', { status: r.status });
      return midpointOnly('places_unavailable');
    }
    places = parsePlacesNearbyResponse(r.json, data.category);
  } catch {
    return midpointOnly('places_unavailable');
  }
  if (places.length === 0) return save(midpointOnly('no_results'));

  // 2. Mod başına route matrix (kaynaklar = o moddaki katılımcılar, hedefler = en yakın K aday).
  const cands = nearestCandidates(places, center, MEETUP_LIMITS.matrixTopK);
  const grid: ({ duration_s: number; distance_m: number } | null)[][] = participants.map(() => cands.map(() => null));
  const byMode = new Map<TravelMode, number[]>();
  participants.forEach((p, i) => byMode.set(p.mode, [...(byMode.get(p.mode) ?? []), i]));
  await Promise.all(
    [...byMode].map(async ([mode, idxs]) => {
      try {
        const r = await callGoogle('route_matrix', deps, ROUTE_MATRIX_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': ROUTE_MATRIX_FIELD_MASK },
          body: JSON.stringify(
            routeMatrixRequestBody(
              idxs.map((i) => participants[i]!.position),
              cands.map((c) => c.location),
              mode,
            ),
          ),
        });
        if (!r.ok) {
          logger.warn('meetup: Route Matrix hata kodu', { status: r.status, mode });
          return;
        }
        const m = parseRouteMatrixResponse(r.json, idxs.length, cands.length);
        idxs.forEach((pi, oi) => cands.forEach((_, di) => (grid[pi]![di] = m[oi]?.[di] ?? null)));
      } catch {
        // Ağ hatası: bu moddaki katılımcılar için kuş uçuşu tahmini.
      }
    }),
  );

  const candidates = cands.map((place, di) => ({
    place,
    etas: participants.map((p, pi): MeetupEta => {
      const c = grid[pi]![di];
      return c ? { key: p.key, duration_s: c.duration_s, distance_m: c.distance_m, estimated: false } : { key: p.key, ...fallbackEta(p.position, place.location, p.mode), estimated: true };
    }),
  }));
  const suggestions = rankMeetupCandidates(candidates, keys, center, MEETUP_LIMITS.resultCount);
  return save(respond(suggestions, null));
}

// ---------------------------------------------------------------------------
// meetup_share
// ---------------------------------------------------------------------------

export async function meetupShare(ctx: CallCtx, data: z.output<typeof MeetupShareRequestSchema>, deps: MeetupShareDeps = {}): Promise<MeetupResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const name = sanitizeNoteText(data.place.name, 80);
  if (!name) throw fail('invalid_argument', { extra: { field: 'place.name' } });
  const address = data.place.address ? sanitizeNoteText(data.place.address, 160) : null;
  const note = data.note ? sanitizeNoteText(data.note, 120) : null;
  const candidates = unique(data.to).filter((u) => u !== ctx.uid && isServerUid(u));
  const newId = refs.newMeetup().id;
  // 'me' → çağıranın uid'i; aynı anahtarın ilk ETA'sı tutulur.
  const seen = new Set<string>();
  const etas: MeetupEta[] = [];
  for (const e of data.etas) {
    const key = e.key === 'me' ? ctx.uid : e.key;
    if (seen.has(key)) continue;
    seen.add(key);
    etas.push({ key, duration_s: Math.max(0, Math.round(e.duration_s)), distance_m: Math.max(0, Math.round(e.distance_m)), estimated: e.estimated });
  }

  return runOp(ctx, data.op_id, CALLABLES.meetupShare, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const rate = await readRateLimit(tx, ctx.uid, 'meetup_share', LIMITS.meetupSharePerHour, HOUR, now);
    const pairs = await readPairStates(tx, ctx.uid, candidates);
    const access = callerAccess(me);
    const pairOf = new Map(candidates.map((u, i) => [u, pairs[i]] as const));
    const to = candidates.filter((u) => canInvite(pairInput(pairOf.get(u), access)));
    if (to.length === 0) throw fail(candidates.some((u) => isFriend(pairOf.get(u))) ? 'not_permitted' : 'not_friends');

    // ETA süzgeci (konumdan türetilen bilgi yalnızca izin verilen kişilere): yalnızca ÖNERENİN ETA'sı, o da yalnızca
    // tüm alıcılara `location_view` izni varsa ve görünürse kalır. Başka katılımcının (Z) ETA'sı HİÇ saklanmaz: Z'nin
    // görünmezliğine / izinlerine bağlı bir süzgecin sonucu önerene "Z görünmez" bilgisini sızdırırdı (§1.7).
    const myEtaOk = to.every((y) => meetupEtaAllowed(pairInput(pairOf.get(y), access)));
    const keptEtas = etas.filter((e) => e.key === ctx.uid && myEtaOk);

    const expires_at = now + MEETUP_LIMITS.shareTtlMs;
    const doc: MeetupDoc = {
      meetup_id: newId,
      from: ctx.uid,
      from_name: me.display_name ?? '',
      to,
      place: {
        place_id: data.place.place_id ?? null,
        name,
        address,
        location: { lat: data.place.location.lat, lng: data.place.location.lng },
        primary_type: data.place.primary_type ?? null,
        category: data.place.category,
      },
      etas: keptEtas,
      meet_at: data.meet_at ?? null,
      note,
      responses: {},
      status: 'active',
      created_at: now,
      expires_at,
      updated_at: now,
      purge_at: Timestamp.fromMillis(expires_at + LIMITS.meetupTtlGraceMs),
    };
    tx.set(refs.meetup(newId), doc);
    writeRateLimit(tx, rate, HOUR);
    const meetup: Meetup = toMeetup(doc);
    return {
      response: { meetup, server_now: now },
      after: () => pushAll(to, buildMeetupPush(meetup.from_name, meetup, now), send, 'meetup_share'),
    };
  });
}

// ---------------------------------------------------------------------------
// meetup_respond / meetup_cancel
// ---------------------------------------------------------------------------

const notFound = () => fail('meetup_not_found');

export async function meetupRespond(ctx: CallCtx, data: z.output<typeof MeetupRespondRequestSchema>, deps: MeetupShareDeps = {}): Promise<MeetupResponse> {
  assertDocId(data.meetup_id, 'meetup_id');
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const ref = refs.meetup(data.meetup_id);
  return runOp(ctx, data.op_id, CALLABLES.meetupRespond, data, async (tx) => {
    const [snap, meSnap] = await tx.getAll(ref, refs.user(ctx.uid));
    const d = snap?.data() as MeetupDoc | undefined;
    if (!d || !(d.to ?? []).includes(ctx.uid) || !isMeetupActive(d, now)) throw notFound();
    assertConsent(meSnap?.data() as UserDoc | undefined);
    const [pair] = await readPairStates(tx, ctx.uid, [d.from]);
    if (!isFriend(pair)) throw notFound();
    if (d.responses?.[ctx.uid] === data.response) return { response: { meetup: toMeetup(d), server_now: now } };
    const rate = await readRateLimit(tx, ctx.uid, 'meetup_respond', LIMITS.meetupRespondPerHour, HOUR, now);
    tx.update(ref, { [`responses.${ctx.uid}`]: data.response, updated_at: now });
    writeRateLimit(tx, rate, HOUR);
    const meetup = toMeetup({ ...d, responses: { ...(d.responses ?? {}), [ctx.uid]: data.response } });
    const name = (meSnap?.data() as UserDoc | undefined)?.display_name ?? '';
    return {
      response: { meetup, server_now: now },
      after: async () => {
        await send(d.from, buildMeetupResponsePush(name, meetup, ctx.uid, data.response));
      },
    };
  });
}

export async function meetupCancel(ctx: CallCtx, data: z.output<typeof MeetupCancelRequestSchema>): Promise<MeetupResponse> {
  assertDocId(data.meetup_id, 'meetup_id');
  const now = ctx.now;
  const ref = refs.meetup(data.meetup_id);
  return runOp(ctx, data.op_id, CALLABLES.meetupCancel, data, async (tx) => {
    const d = (await tx.get(ref)).data() as MeetupDoc | undefined;
    if (!d || d.from !== ctx.uid) throw notFound();
    if (d.status === 'cancelled') return { response: { meetup: toMeetup(d), server_now: now } };
    tx.update(ref, { status: 'cancelled', updated_at: now });
    return { response: { meetup: toMeetup({ ...d, status: 'cancelled' }), server_now: now } };
  });
}

// ---------------------------------------------------------------------------
// Bakım ve hesap silme
// ---------------------------------------------------------------------------

async function deleteDocs(docs: readonly FirebaseFirestore.QueryDocumentSnapshot[]): Promise<void> {
  for (const part of chunk(docs, 400)) {
    const batch = db().batch();
    for (const d of part) batch.delete(d.ref);
    await batch.commit();
  }
}

/** Süresi geçen buluşma önerileri (iptal edilenler dahil) ve önbellek belgeleri (tek alanlı `expires_at`; otomatik dizin). */
export async function sweepExpiredMeetups(now: EpochMs, max: number = LIMITS.f5SweepMax): Promise<{ meetups: number; cache: number }> {
  const [m, c] = await Promise.all([
    db().collection(COL.meetups).where('expires_at', '<=', now).orderBy('expires_at').limit(max).get(),
    db().collection(COL.meetupCache).where('expires_at', '<=', now).orderBy('expires_at').limit(max).get(),
  ]);
  await Promise.all([deleteDocs(m.docs), deleteDocs(c.docs)]);
  return { meetups: m.size, cache: c.size };
}

/** Hesap silme: gönderdiği öneriler ve önbelleği silinir; aldığı önerilerin `to` / `responses` alanından çıkar. */
export async function deleteMeetupsOf(uid: UserId): Promise<void> {
  const col = db().collection(COL.meetups);
  const [sent, received, cache] = await Promise.all([
    col.where('from', '==', uid).get(),
    col.where('to', 'array-contains', uid).get(),
    db().collection(COL.meetupCache).where('uid', '==', uid).get(),
  ]);
  await Promise.all([deleteDocs(sent.docs), deleteDocs(cache.docs)]);
  for (const part of chunk(received.docs.filter((d) => d.get('from') !== uid), 400)) {
    const batch = db().batch();
    for (const d of part) batch.update(d.ref, { to: FieldValue.arrayRemove(uid), [`responses.${uid}`]: FieldValue.delete() });
    await batch.commit();
  }
}
