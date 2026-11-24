/**
 * Faz 5: kayıtlı bölgeler (Ev, İş, özel nokta) ve varış / ayrılış tetikleyicileri.
 *
 * Mimari:
 *  - Bölge + kurallar Firestore `users/{uid}/zones/{zone_id}`; YALNIZCA sahibi okur, callable yazar (`zone_upsert`,
 *    `zone_delete`). Ev/iş koordinatı hassas veridir: alıcılara asla gitmez, push yalnızca bölge ADINI taşır.
 *  - Algılama cihazda: iOS `CLCircularRegion` (expo-location `startGeofencingAsync`, en çok 20 bölge/uygulama, Faz 3
 *    uyku çiti 1 tanesini kullanır), Android `GeofencingClient` (aynı API; 100 sınır). OS olayı yalnızca ADAYDIR:
 *    cihaz uyanır, taze konum alır ve `zoneFilterReduce` sapma filtresinden geçen geçiş "onaylanır".
 *  - Onaylanan geçiş `zone_event_report` ile sunucuya bildirilir: sunucu eşleşen `notify` kurallarının alıcılarına
 *    push gönderir ("Erim eve vardı"), eşleşen `start_share` kurallarını yanıtta döndürür; cihaz paylaşımı mevcut
 *    `share_start` ile başlatır (paket yayını zaten cihazda).
 *
 * GPS sapması filtresi (bkz. `ZONE_FILTER`, `zoneFilterReduce`):
 *  1. Doğruluk kapısı: `accuracy > max(maxAccuracyM, radius × 0.5)` olan örnek yok sayılır.
 *  2. Histerezis: İÇERİ = `d + acc×k ≤ R` (güvenle içeride); DIŞARI = `d − acc×k ≥ R + exitBuffer`
 *     (exitBuffer = max(minExitBufferM, R × 0.25)). İki eşik arasındaki "gri bant" durumu değiştirmez.
 *  3. Bekleme (dwell): içeri geçiş `enterDwellMs`, dışarı geçiş `exitDwellMs` boyunca tutarlı kalmalı ya da arka arkaya
 *     `confirmSamples` güvenli örnek gelmeli (aralarında en az `minConfirmSpanMs`).
 *  4. Işınlanma reddi: önceki kabul edilen örneğe göre hız > `maxSpeedMps` ise örnek atılır.
 *  5. Ters geçiş soğuması: onaylı geçişten sonra `minStayMs` dolmadan ters geçiş onaylanmaz (çok uzaklaşma hariç).
 *     Aynı yön tekrarı `sameTransitionCooldownMs` içinde bastırılır.
 *  6. İlk durum: ilk güvenli örnek durumu tetik ÜRETMEDEN kurar (uygulama evde açılınca "eve vardı" gitmez).
 *  7. OS olayı + taze konum çelişirse (OS "girdi" der, taze konum dışarıda) taze konum kazanır.
 */
import { z } from 'zod';
import { DurationChoiceSchema } from './contracts';
import type { DurationChoice } from './duration';
import { haversineM, type LatLng } from './geo';
import type { UserId } from './model';
import { DAY, MINUTE, SECOND, type EpochMs } from './time';

export const ZONE_KINDS = ['home', 'work', 'school', 'custom'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export const ZONE_KIND_TEXT: Record<ZoneKind, string> = { home: 'Ev', work: 'İş', school: 'Okul', custom: 'Özel nokta' };
export const ZONE_KIND_EMOJI: Record<ZoneKind, string> = { home: '🏠', work: '💼', school: '🎓', custom: '📍' };

export const ZONE_TRIGGERS = ['arrive', 'leave'] as const;
export type ZoneTrigger = (typeof ZONE_TRIGGERS)[number];
export const ZONE_ACTIONS = ['notify', 'start_share'] as const;
export type ZoneAction = (typeof ZONE_ACTIONS)[number];

export const ZONE_LIMITS = {
  /** iOS 20 bölge sınırı − Faz 3 uyku çiti − pay. [Varsayım] */
  maxZones: 15,
  maxRulesPerZone: 6,
  maxRecipientsPerRule: 10,
  minRadiusM: 100,
  maxRadiusM: 2_000,
  defaultRadiusM: 150,
  nameMaxChars: 30,
  /** Sunucu: aynı bölge + yön için iki bildirim arasında en az (ikinci savunma hattı). */
  serverCooldownMs: 5 * MINUTE,
  /** Sunucu: kullanıcı başına günlük en fazla tetik bildirimi. */
  maxEventsPerDay: 60,
  /** `occurred_at` bundan eskiyse (ör. uzun çevrimdışı) bildirim gönderilmez, yalnızca kaydedilir. */
  maxEventAgeMs: 30 * MINUTE,
} as const;

/** Haftanın günleri: 0 = Pazartesi … 6 = Pazar (bit maskesi `1 << gün`). 127 = her gün. */
export const ALL_DAYS_MASK = 127;
export const WEEKDAY_SHORT_TR = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'] as const;

/** Kuralın geçerli olduğu saat aralığı (yerel dakika, 0..1439). `from > to` gece yarısını aşar (22:00–06:00). */
export interface ZoneTimeWindow {
  from_min: number;
  to_min: number;
}

export interface ZoneRule {
  rule_id: string;
  trigger: ZoneTrigger;
  action: ZoneAction;
  /** notify: bildirim gidecek arkadaşlar; start_share: paylaşım başlatılacak arkadaşlar. */
  recipient_ids: UserId[];
  /** start_share için süre (preset / gün sonu); notify için null. */
  share_duration: DurationChoice | null;
  days_mask: number;
  /** null = gün boyu. */
  window: ZoneTimeWindow | null;
  enabled: boolean;
}

export interface Zone {
  zone_id: string;
  owner_id: UserId;
  kind: ZoneKind;
  name: string;
  emoji: string | null;
  center: LatLng;
  radius_m: number;
  rules: ZoneRule[];
  enabled: boolean;
  /** IANA saat dilimi (kural pencereleri için, örn. "Europe/Istanbul"). */
  time_zone: string;
  created_at: EpochMs;
  updated_at: EpochMs;
}

/** Hazır kural şablonları (arayüz tek dokunuşla ekler). */
export const ZONE_RULE_TEMPLATES: readonly { id: string; label: string; trigger: ZoneTrigger; action: ZoneAction }[] = [
  { id: 'arrive_notify', label: 'Vardığımda bildir', trigger: 'arrive', action: 'notify' },
  { id: 'leave_notify', label: 'Çıktığımda bildir', trigger: 'leave', action: 'notify' },
  { id: 'leave_share', label: 'Çıkınca paylaşımı başlat', trigger: 'leave', action: 'start_share' },
  { id: 'arrive_share', label: 'Varınca paylaşımı başlat', trigger: 'arrive', action: 'start_share' },
];

// --- şemalar ----------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const minuteOfDay = z.number().int().min(0).max(1439);

export const ZoneTimeWindowSchema = z.object({ from_min: minuteOfDay, to_min: minuteOfDay });

/** start_share için izin verilen süreler: kısa hazır süreler ve gün sonu (uzun süreler kuralla başlatılmaz). [Varsayım] */
export const ZONE_SHARE_DURATIONS: readonly DurationChoice[] = [
  { kind: 'preset', preset: 'm15' },
  { kind: 'preset', preset: 'h1' },
  { kind: 'preset', preset: 'h8' },
  { kind: 'end_of_day' },
];

export const ZoneRuleSchema = z
  .object({
    rule_id: z.string().min(1).max(64),
    trigger: z.enum(ZONE_TRIGGERS),
    action: z.enum(ZONE_ACTIONS),
    recipient_ids: z.array(uid).min(1).max(ZONE_LIMITS.maxRecipientsPerRule),
    share_duration: DurationChoiceSchema.nullable().default(null),
    days_mask: z.number().int().min(1).max(ALL_DAYS_MASK).default(ALL_DAYS_MASK),
    window: ZoneTimeWindowSchema.nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .refine((r) => (r.action === 'start_share' ? r.share_duration !== null && (r.share_duration.kind === 'preset' || r.share_duration.kind === 'end_of_day') : true), {
    message: 'start_share kuralı kısa bir süre ister',
    path: ['share_duration'],
  });

export const ZoneUpsertRequestSchema = z.object({
  op_id: z.uuid(),
  /** null = yeni bölge. */
  zone_id: z.string().min(1).max(64).nullable().default(null),
  kind: z.enum(ZONE_KINDS),
  name: z.string().min(1).max(ZONE_LIMITS.nameMaxChars * 2),
  emoji: z.string().max(8).nullable().default(null),
  center: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  radius_m: z.number().min(ZONE_LIMITS.minRadiusM).max(ZONE_LIMITS.maxRadiusM),
  rules: z.array(ZoneRuleSchema).max(ZONE_LIMITS.maxRulesPerZone).default([]),
  enabled: z.boolean().default(true),
  time_zone: z.string().min(1).max(64),
});
export type ZoneUpsertRequest = z.input<typeof ZoneUpsertRequestSchema>;

export const ZoneSchema: z.ZodType<Zone> = z.object({
  zone_id: z.string().min(1),
  owner_id: uid,
  kind: z.enum(ZONE_KINDS),
  name: z.string(),
  emoji: z.string().nullable(),
  center: z.object({ lat: z.number(), lng: z.number() }),
  radius_m: z.number(),
  rules: z.array(
    z.object({
      rule_id: z.string(),
      trigger: z.enum(ZONE_TRIGGERS),
      action: z.enum(ZONE_ACTIONS),
      recipient_ids: z.array(uid),
      share_duration: DurationChoiceSchema.nullable(),
      days_mask: z.number(),
      window: ZoneTimeWindowSchema.nullable(),
      enabled: z.boolean(),
    }),
  ),
  enabled: z.boolean(),
  time_zone: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export interface ZoneUpsertResponse {
  zone: Zone;
  /** Arkadaş olmadığı için kurallardan çıkarılan alıcılar (sessizce). */
  dropped_recipient_ids: UserId[];
  server_now: EpochMs;
}
export const ZoneUpsertResponseSchema: z.ZodType<ZoneUpsertResponse> = z.object({
  zone: ZoneSchema,
  dropped_recipient_ids: z.array(uid),
  server_now: z.number(),
});

export const ZoneDeleteRequestSchema = z.object({ op_id: z.uuid(), zone_id: z.string().min(1).max(64) });
export type ZoneDeleteRequest = z.input<typeof ZoneDeleteRequestSchema>;
export interface ZoneDeleteResponse {
  zone_id: string;
  deleted: boolean;
  server_now: EpochMs;
}
export const ZoneDeleteResponseSchema: z.ZodType<ZoneDeleteResponse> = z.object({ zone_id: z.string(), deleted: z.boolean(), server_now: z.number() });

export const ZoneEventReportRequestSchema = z.object({
  op_id: z.uuid(),
  zone_id: z.string().min(1).max(64),
  transition: z.enum(ZONE_TRIGGERS),
  /** Geçişin onaylandığı an (sunucu saatine çevrilmiş). */
  occurred_at: z.number().int().positive(),
  /** Onaylayan örneğin doğruluğu (teşhis). Koordinat GÖNDERİLMEZ. */
  accuracy_m: z.number().min(0).max(5_000).nullable().default(null),
});
export type ZoneEventReportRequest = z.input<typeof ZoneEventReportRequestSchema>;

export interface ZoneEventReportResponse {
  /** Bildirim giden alıcı sayısı. */
  notified: number;
  /** Cihazın `share_start` ile başlatması gereken paylaşımlar (sunucu arkadaşlığı doğruladı). */
  start_share: { rule_id: string; recipient_ids: UserId[]; duration: DurationChoice }[];
  /** `cooldown` / `stale` / `outside_window` / `disabled` ise bildirim gitmedi. */
  suppressed: 'cooldown' | 'stale' | 'outside_window' | 'disabled' | 'daily_limit' | null;
  server_now: EpochMs;
}
export const ZoneEventReportResponseSchema: z.ZodType<ZoneEventReportResponse> = z.object({
  notified: z.number(),
  start_share: z.array(z.object({ rule_id: z.string(), recipient_ids: z.array(uid), duration: DurationChoiceSchema })),
  suppressed: z.enum(['cooldown', 'stale', 'outside_window', 'disabled', 'daily_limit']).nullable(),
  server_now: z.number(),
});

export function parseZone(raw: unknown): Zone | null {
  const r = ZoneSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// --- kural eşleme (sunucu ve cihaz aynı fonksiyonu kullanır) ------------------------------------

/** Yerel saat bilgisi: hafta günü (0 = Pazartesi) ve gün içi dakika. */
export interface LocalClock {
  weekday: number;
  minute: number;
}

/** `offsetMin` = UTC'ye göre yerel fark (dakika; time.ts `OffsetFn` ile hesaplanır). */
export function localClock(now: EpochMs, offsetMin: number): LocalClock {
  const local = new Date(now + offsetMin * MINUTE);
  const jsDay = local.getUTCDay(); // 0 = Pazar
  return { weekday: (jsDay + 6) % 7, minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function inTimeWindow(w: ZoneTimeWindow | null, minute: number): boolean {
  if (!w) return true;
  if (w.from_min === w.to_min) return true;
  return w.from_min < w.to_min ? minute >= w.from_min && minute < w.to_min : minute >= w.from_min || minute < w.to_min;
}

/** Bu geçişte çalışacak kurallar (etkin bölge + etkin kural + yön + gün + saat aralığı). */
export function matchZoneRules(zone: Pick<Zone, 'enabled' | 'rules'>, transition: ZoneTrigger, clock: LocalClock): ZoneRule[] {
  if (!zone.enabled) return [];
  return zone.rules.filter(
    (r) => r.enabled && r.trigger === transition && (r.days_mask & (1 << clock.weekday)) !== 0 && inTimeWindow(r.window, clock.minute),
  );
}

/** Push metni: koordinat YOK, yalnızca bölge adı. */
export function zoneEventPushText(senderName: string, zoneName: string, transition: ZoneTrigger): { title: string; body: string } {
  return transition === 'arrive'
    ? { title: senderName, body: `${zoneName} konumuna vardı` }
    : { title: senderName, body: `${zoneName} konumundan ayrıldı` };
}

/** "Eve vardığımda Ayşe'ye bildir" gibi kural özeti (liste satırı). */
export function describeZoneRule(r: Pick<ZoneRule, 'trigger' | 'action'>, zoneName: string, recipientNames: readonly string[]): string {
  const who = recipientNames.length === 0 ? 'kimseye' : recipientNames.length <= 2 ? recipientNames.join(' ve ') : `${recipientNames[0]} ve ${recipientNames.length - 1} kişi`;
  const when = r.trigger === 'arrive' ? `${zoneName} konumuna vardığımda` : `${zoneName} konumundan çıktığımda`;
  return r.action === 'notify' ? `${when} ${who} bildir` : `${when} ${who} ile paylaşımı başlat`;
}

// --- GPS sapması filtresi --------------------------------------------------------------------

export const ZONE_FILTER = {
  /** Bundan kötü doğruluklu örnek karar vermez (büyük bölgede R × 0,5'e kadar gevşer). */
  maxAccuracyM: 100,
  /** Doğruluk yarıçapı ağırlığı (k): d ± acc×k. */
  accuracyWeight: 1,
  minExitBufferM: 50,
  exitBufferRatio: 0.25,
  enterDwellMs: 60 * SECOND,
  exitDwellMs: 3 * MINUTE,
  confirmSamples: 2,
  minConfirmSpanMs: 20 * SECOND,
  maxSpeedMps: 70,
  /** Onaylı geçişten sonra ters geçiş için en az kalış. */
  minStayMs: 3 * MINUTE,
  /** Çok uzaklaşma (R + bu) soğumayı aşar: gerçekten ayrıldı. */
  farEscapeM: 1_000,
  sameTransitionCooldownMs: 10 * MINUTE,
  /** OS olayından sonra taze konum için en çok bekleme. */
  osEventFixTimeoutMs: 20 * SECOND,
  /** Bekleyen aday bu süre içinde onaylanmazsa düşer. */
  candidateMaxAgeMs: 15 * MINUTE,
} as const;

export type ZonePresence = 'unknown' | 'inside' | 'outside';

export interface ZoneFilterState {
  presence: ZonePresence;
  /** Onay bekleyen yön ve ilk güvenli örnek. */
  candidate: { to: 'inside' | 'outside'; since: EpochMs; samples: number; last_at: EpochMs } | null;
  last_transition: { to: 'inside' | 'outside'; at: EpochMs } | null;
  last_sample: { lat: number; lng: number; at: EpochMs } | null;
}

export const initialZoneFilterState = (): ZoneFilterState => ({ presence: 'unknown', candidate: null, last_transition: null, last_sample: null });

export interface ZoneSample {
  lat: number;
  lng: number;
  accuracy: number;
  at: EpochMs;
}

export type ZoneFilterInput =
  | { type: 'sample'; sample: ZoneSample }
  /** OS bölge olayı (aday). Taze konum ayrıca `sample` olarak verilmelidir; bu olay yalnızca adayı başlatır. */
  | { type: 'os_event'; event: 'enter' | 'exit'; at: EpochMs };

export type ZoneFilterReason =
  | 'initial'
  | 'confirmed_dwell'
  | 'confirmed_samples'
  | 'far_escape'
  | 'low_accuracy'
  | 'teleport'
  | 'grey_band'
  | 'no_change'
  | 'pending'
  | 'min_stay'
  | 'same_cooldown'
  | 'os_candidate';

export interface ZoneFilterResult {
  state: ZoneFilterState;
  /** Onaylanan tetik (yalnızca durum değişiminde; ilk durumda null). */
  emit: ZoneTrigger | null;
  reason: ZoneFilterReason;
}

/** Örneğin bölgeye göre sınıfı: güvenle içeride / güvenle dışarıda / gri bant. */
export function classifyZoneSample(zone: Pick<Zone, 'center' | 'radius_m'>, s: Pick<ZoneSample, 'lat' | 'lng' | 'accuracy'>): 'inside' | 'outside' | 'grey' {
  const d = haversineM(zone.center, s);
  const a = s.accuracy * ZONE_FILTER.accuracyWeight;
  const exitBuffer = Math.max(ZONE_FILTER.minExitBufferM, zone.radius_m * ZONE_FILTER.exitBufferRatio);
  if (d + a <= zone.radius_m) return 'inside';
  if (d - a >= zone.radius_m + exitBuffer) return 'outside';
  return 'grey';
}

export const zoneAccuracyLimit = (radiusM: number): number => Math.max(ZONE_FILTER.maxAccuracyM, radiusM * 0.5);

/**
 * Saf geçiş fonksiyonu (cihaz arka plan görevi ve testler). Kalıcı saklanır (bölge başına), böylece süreç
 * öldürülüp OS olayıyla yeniden başlasa da bekleme / soğuma bilgisi kaybolmaz.
 */
export function zoneFilterReduce(zone: Pick<Zone, 'center' | 'radius_m'>, state: ZoneFilterState, input: ZoneFilterInput): ZoneFilterResult {
  if (input.type === 'os_event') {
    // OS olayı yalnızca adaydır: taze örnek gelene kadar durum değişmez.
    const to: 'inside' | 'outside' = input.event === 'enter' ? 'inside' : 'outside';
    if (state.presence === to) return { state, emit: null, reason: 'no_change' };
    const candidate = state.candidate && state.candidate.to === to ? state.candidate : { to, since: input.at, samples: 0, last_at: input.at };
    return { state: { ...state, candidate }, emit: null, reason: 'os_candidate' };
  }

  const s = input.sample;
  if (s.accuracy > zoneAccuracyLimit(zone.radius_m)) return { state, emit: null, reason: 'low_accuracy' };
  if (state.last_sample && s.at > state.last_sample.at) {
    const v = haversineM(state.last_sample, s) / ((s.at - state.last_sample.at) / SECOND);
    if (v > ZONE_FILTER.maxSpeedMps) return { state, emit: null, reason: 'teleport' };
  }
  const base: ZoneFilterState = { ...state, last_sample: { lat: s.lat, lng: s.lng, at: s.at } };
  const cls = classifyZoneSample(zone, s);

  if (cls === 'grey') {
    // Gri bant: bekleyen aday iptal edilmez ama ilerlemez de (bekleme süresi sayılmaz). Eski aday düşer.
    const candidate = base.candidate && s.at - base.candidate.since > ZONE_FILTER.candidateMaxAgeMs ? null : base.candidate;
    return { state: { ...base, candidate }, emit: null, reason: 'grey_band' };
  }
  if (base.presence === 'unknown') {
    return { state: { ...base, presence: cls, candidate: null }, emit: null, reason: 'initial' };
  }
  if (base.presence === cls) return { state: { ...base, candidate: null }, emit: null, reason: 'no_change' };

  // Yön değişimi adayı.
  const prevCand = base.candidate && base.candidate.to === cls && s.at - base.candidate.since <= ZONE_FILTER.candidateMaxAgeMs ? base.candidate : null;
  const candidate = prevCand
    ? { ...prevCand, samples: prevCand.samples + 1, last_at: s.at }
    : { to: cls, since: s.at, samples: 1, last_at: s.at };

  const far = cls === 'outside' && haversineM(zone.center, s) - s.accuracy >= zone.radius_m + ZONE_FILTER.farEscapeM;
  const lt = base.last_transition;
  if (!far && lt && lt.to !== cls && s.at - lt.at < ZONE_FILTER.minStayMs) {
    return { state: { ...base, candidate }, emit: null, reason: 'min_stay' };
  }

  const dwell = cls === 'inside' ? ZONE_FILTER.enterDwellMs : ZONE_FILTER.exitDwellMs;
  const bySamples = candidate.samples >= ZONE_FILTER.confirmSamples && candidate.last_at - candidate.since >= ZONE_FILTER.minConfirmSpanMs;
  const byDwell = s.at - candidate.since >= dwell && candidate.samples >= 1;
  if (!far && !bySamples && !byDwell) return { state: { ...base, candidate }, emit: null, reason: 'pending' };

  const emit: ZoneTrigger = cls === 'inside' ? 'arrive' : 'leave';
  const next: ZoneFilterState = { ...base, presence: cls, candidate: null, last_transition: { to: cls, at: s.at } };
  // Aynı yön tekrarı (ör. çıktı → gri bantta dolaştı → yeniden "çıktı") bastırılır; durum yine güncellenir.
  if (lt && lt.to === cls && s.at - lt.at < ZONE_FILTER.sameTransitionCooldownMs) {
    return { state: { ...next, last_transition: lt }, emit: null, reason: 'same_cooldown' };
  }
  return { state: next, emit, reason: far ? 'far_escape' : bySamples ? 'confirmed_samples' : 'confirmed_dwell' };
}

/** OS'a kaydedilecek bölge yarıçapı: dışarı tamponu dahil (çıkış olayı filtre eşiğinden önce gelmesin). */
export function osRegionRadius(radiusM: number): number {
  return Math.round(radiusM + Math.max(ZONE_FILTER.minExitBufferM, radiusM * ZONE_FILTER.exitBufferRatio) / 2);
}

/** "Ev · 150 m" */
export function formatZoneRadius(m: number): string {
  return m >= 1_000 ? `${(m / 1_000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`;
}

/** Bölge olay kaydı (sunucu, yalnızca sahibi okur): `users/{uid}/zone_events/{id}`, 30 gün sonra silinir. */
export interface ZoneEventLog {
  zone_id: string;
  transition: ZoneTrigger;
  occurred_at: EpochMs;
  notified: number;
  suppressed: ZoneEventReportResponse['suppressed'];
}

export const ZONE_EVENT_LOG_TTL_MS = 30 * DAY;
