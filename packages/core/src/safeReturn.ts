/**
 * Faz 9: Güvenli Dönüş / gece takip modu (check-in zamanlayıcısı). Ayrıntı: docs/PHASE9.md §3.
 *
 * Akış:
 *   başlat (15 / 30 / 45 / 60 dk + hedef + acil kişi) → süre dolmadan varış (cihaz algılar) ya da "Güvendeyim" →
 *   kişilere "güvenle vardı". Süre dolarsa (`due_at`) cihazda ve push ile "Güvende misin?" son uyarısı +
 *   `graceMs` geri sayım; o da biterse (`grace_until`) SUNUCU acil kişilere otomatik ALARM gönderir: Faz 4
 *   `sos_alerts` kaydı (`origin: 'safe_return'`), son doğrulanmış koordinat + doğruluk + pil + harita bağlantısı,
 *   yüksek öncelikli SOS kanalı. Cihaz açıksa alarmdan sonra SOS'un 15 sn'lik canlı konum tazelemesi çalışır.
 *
 * Neden sunucu: telefon kapanabilir, uygulama öldürülebilir, ağ gidebilir. Alarm cihaza bağlı kalmasın diye
 * zamanlayıcı sunucuda tutulur (Cloud Tasks `due_at` ve `grace_until` + dakikalık süpürücü yedeği); cihaz yalnızca
 * son konumu (`safe_return_update`, en sık 60 sn) ve check-in'i bildirir. Başlatırken konum ZORUNLUDUR, böylece
 * alarmda her zaman bir son doğrulanmış koordinat vardır.
 *
 * Gizlilik: kayıt (son konum dahil) YALNIZCA sahibine açıktır; acil kişiler başlangıç / bitiş bildirimini alır,
 * koordinatı yalnızca alarm anında (SOS kaydıyla) görür. Hedef koordinatı cihazdan çıkmaz (yalnızca ad).
 */
import { z } from 'zod';
import type { UserId } from './model';
import { HOUR, MINUTE, SECOND, type EpochMs } from './time';

export const SAFE_RETURN_DURATIONS_MIN = [15, 30, 45, 60] as const;
export type SafeReturnDurationMin = (typeof SAFE_RETURN_DURATIONS_MIN)[number];

export const SAFE_RETURN_LIMITS = {
  /** Süre dolunca son uyarı / geri sayım penceresi. [Varsayım] */
  graceMs: 2 * MINUTE,
  /** Süre dolmadan önce cihazda yerel hatırlatma. */
  reminderBeforeMs: 5 * MINUTE,
  /** "+15 dk" uzatma. */
  extendMs: 15 * MINUTE,
  /** Başlangıçtan en uzun toplam süre. */
  maxTotalMs: 3 * HOUR,
  /** Konum tazeleme aralığı (istemci ve sunucu kısıtı). */
  updateMinIntervalMs: 60 * SECOND,
  maxContacts: 5,
  /** Kullanıcı başına günlük en çok başlatma. [Varsayım] */
  startsPerDay: 12,
  /** Bundan eski son konum alarmda "x dk önce" uyarısıyla gösterilir. */
  staleFixMs: 10 * MINUTE,
  /** Biten kaydın TTL payı. */
  purgeAfterMs: 7 * 24 * HOUR,
  destNameMaxChars: 30,
  /** "Gece geç saat" öneri penceresi (yerel dakika). */
  lateNightFromMin: 22 * 60,
  lateNightToMin: 6 * 60,
} as const;

export const SAFE_RETURN_STATUSES = ['active', 'arrived', 'checked_in', 'alarm', 'cancelled'] as const;
export type SafeReturnStatus = (typeof SAFE_RETURN_STATUSES)[number];

export const SAFE_RETURN_DEST_KINDS = ['zone', 'point'] as const;
export type SafeReturnDestKind = (typeof SAFE_RETURN_DEST_KINDS)[number];

/** Sunucudaki hedef: yalnızca ad ve tür (koordinat cihazda). */
export interface SafeReturnDestination {
  kind: SafeReturnDestKind;
  name: string;
  zone_id: string | null;
}

export interface SafeReturnFix {
  lat: number;
  lng: number;
  accuracy: number;
  /** Ölçüm anı (sunucu saati). */
  timestamp: EpochMs;
  battery_pct: number | null;
  is_charging: boolean | null;
}

/** Firestore `safe_returns/{id}` (YALNIZCA sahibi okur, callable / sunucu yazar). */
export interface SafeReturnDoc {
  safe_return_id: string;
  owner_id: UserId;
  owner_name: string;
  contact_ids: UserId[];
  destination: SafeReturnDestination;
  duration_min: number;
  started_at: EpochMs;
  due_at: EpochMs;
  grace_until: EpochMs;
  extend_count: number;
  status: SafeReturnStatus;
  /** "Güven misin?" (due) bildirimi gönderildi mi (uzatınca sıfırlanır). */
  due_notified_at: EpochMs | null;
  last_fix: SafeReturnFix;
  /** Alarmda açılan SOS kaydı. */
  sos_id: string | null;
  time_zone: string;
  ended_at: EpochMs | null;
  created_at: EpochMs;
  updated_at: EpochMs;
  version: number;
}

export type SafeReturnAction =
  | { type: 'update'; fix: SafeReturnFix }
  | { type: 'check_in'; reason: 'safe' | 'arrived' }
  | { type: 'extend' }
  | { type: 'cancel' }
  /** Süpürücü / görev: zaman ilerledi. */
  | { type: 'tick' }
  /** Sunucu alarmı açtı (SOS kaydı yazıldı). */
  | { type: 'alarm_opened'; sos_id: string };

export type SafeReturnEffect =
  /** Sahibin cihazlarına "Güvende misin?" (son uyarı başladı). */
  | { kind: 'due' }
  /** Acil kişilere otomatik alarm açılmalı (SOS). */
  | { kind: 'alarm' }
  /** Acil kişilere bitiş bildirimi. */
  | { kind: 'ended'; reason: 'arrived' | 'checked_in' | 'cancelled' }
  /** Görevler yeniden planlanmalı (uzatma). */
  | { kind: 'reschedule' };

export type SafeReturnErrorCode = 'safe_return_not_active' | 'safe_return_extend_limit' | 'rate_limited';

export interface SafeReturnResult {
  doc: SafeReturnDoc;
  effects: SafeReturnEffect[];
  changed: boolean;
  error: SafeReturnErrorCode | null;
}

const isEnded = (s: SafeReturnStatus) => s !== 'active';

/** Yeni kayıt (sunucu `safe_return_start`). */
export function createSafeReturnDoc(i: {
  safe_return_id: string;
  owner_id: UserId;
  owner_name: string;
  contact_ids: readonly UserId[];
  destination: SafeReturnDestination;
  duration_min: SafeReturnDurationMin;
  fix: SafeReturnFix;
  time_zone: string;
  now: EpochMs;
}): SafeReturnDoc {
  const due = i.now + i.duration_min * MINUTE;
  return {
    safe_return_id: i.safe_return_id,
    owner_id: i.owner_id,
    owner_name: i.owner_name,
    contact_ids: [...new Set(i.contact_ids)].slice(0, SAFE_RETURN_LIMITS.maxContacts),
    destination: { ...i.destination, name: sanitizeSafeReturnName(i.destination.name) },
    duration_min: i.duration_min,
    started_at: i.now,
    due_at: due,
    grace_until: due + SAFE_RETURN_LIMITS.graceMs,
    extend_count: 0,
    status: 'active',
    due_notified_at: null,
    last_fix: i.fix,
    sos_id: null,
    time_zone: i.time_zone,
    ended_at: null,
    created_at: i.now,
    updated_at: i.now,
    version: 1,
  };
}

/**
 * Saf geçiş (sunucu ve demo aynı fonksiyonu çağırır). Kimlik / sahiplik çağıranda denetlenir.
 *  - update: etkin kayıtta son konum (daha yeni ölçümse) ve pil; `updateMinIntervalMs`'den sık ise `rate_limited`.
 *  - check_in: etkin kayıt (son uyarı penceresi dahil) → arrived / checked_in + `ended`. Alarmdan sonra
 *    `safe_return_not_active` (alarmı SOS'taki "Güvendeyim" kapatır).
 *  - extend: `grace_until` geçmemişse bitiş +15 dk (toplam ≤ 3 sa); son uyarı sıfırlanır.
 *  - cancel: etkin → cancelled + `ended`.
 *  - tick: `now ≥ due_at` ve henüz bildirilmediyse `due`; `now ≥ grace_until` → alarm (durum `alarm`, etki `alarm`).
 *  - alarm_opened: alarm kaydına SOS kimliğini yazar.
 */
export function reduceSafeReturn(doc: SafeReturnDoc, action: SafeReturnAction, now: EpochMs): SafeReturnResult {
  const same = (error: SafeReturnErrorCode | null = null): SafeReturnResult => ({ doc, effects: [], changed: false, error });
  const bump = (patch: Partial<SafeReturnDoc>, effects: SafeReturnEffect[] = []): SafeReturnResult => ({
    doc: { ...doc, ...patch, updated_at: now, version: doc.version + 1 },
    effects,
    changed: true,
    error: null,
  });

  switch (action.type) {
    case 'update': {
      if (isEnded(doc.status)) return same('safe_return_not_active');
      if (action.fix.timestamp <= doc.last_fix.timestamp) return same();
      if (action.fix.timestamp - doc.last_fix.timestamp < SAFE_RETURN_LIMITS.updateMinIntervalMs - 5 * SECOND) return same('rate_limited');
      return bump({ last_fix: action.fix });
    }
    case 'check_in': {
      if (isEnded(doc.status)) return same('safe_return_not_active');
      const status: SafeReturnStatus = action.reason === 'arrived' ? 'arrived' : 'checked_in';
      return bump({ status, ended_at: now }, [{ kind: 'ended', reason: status }]);
    }
    case 'extend': {
      if (isEnded(doc.status) || now >= doc.grace_until) return same('safe_return_not_active');
      const base = Math.max(doc.due_at, now);
      const due = base + SAFE_RETURN_LIMITS.extendMs;
      if (due - doc.started_at > SAFE_RETURN_LIMITS.maxTotalMs) return same('safe_return_extend_limit');
      return bump({ due_at: due, grace_until: due + SAFE_RETURN_LIMITS.graceMs, extend_count: doc.extend_count + 1, due_notified_at: null }, [{ kind: 'reschedule' }]);
    }
    case 'cancel': {
      if (isEnded(doc.status)) return same('safe_return_not_active');
      return bump({ status: 'cancelled', ended_at: now }, [{ kind: 'ended', reason: 'cancelled' }]);
    }
    case 'tick': {
      if (isEnded(doc.status)) return same();
      if (now >= doc.grace_until) return bump({ status: 'alarm', ended_at: now, due_notified_at: doc.due_notified_at ?? now }, [{ kind: 'alarm' }]);
      if (now >= doc.due_at && doc.due_notified_at === null) return bump({ due_notified_at: now }, [{ kind: 'due' }]);
      return same();
    }
    case 'alarm_opened': {
      if (doc.status !== 'alarm' || doc.sos_id === action.sos_id) return same();
      return bump({ sos_id: action.sos_id });
    }
  }
}

// --- istemci görünümü ------------------------------------------------------------------------

export type SafeReturnPhase = 'running' | 'ending_soon' | 'final_warning' | 'alarm' | 'ended';

/** Ekranın hangi hâlde olacağı (bant, son uyarı tam ekranı, alarm kartı). */
export function safeReturnPhase(doc: Pick<SafeReturnDoc, 'status' | 'due_at' | 'grace_until'>, now: EpochMs): SafeReturnPhase {
  if (doc.status === 'alarm') return 'alarm';
  if (doc.status !== 'active') return 'ended';
  if (now >= doc.grace_until) return 'alarm';
  if (now >= doc.due_at) return 'final_warning';
  if (now >= doc.due_at - SAFE_RETURN_LIMITS.reminderBeforeMs) return 'ending_soon';
  return 'running';
}

/** Geri sayım: çalışırken `due_at`'e, son uyarıda `grace_until`'e kalan ms. */
export function safeReturnLeftMs(doc: Pick<SafeReturnDoc, 'status' | 'due_at' | 'grace_until'>, now: EpochMs): number {
  const phase = safeReturnPhase(doc, now);
  if (phase === 'final_warning') return Math.max(0, doc.grace_until - now);
  if (phase === 'running' || phase === 'ending_soon') return Math.max(0, doc.due_at - now);
  return 0;
}

/** "Gece geç saat" (22:00–06:00 yerel) mi? Haritada Güvenli Dönüş önerisi için. `localMinute` 0..1439. */
export function isLateNight(localMinute: number): boolean {
  return localMinute >= SAFE_RETURN_LIMITS.lateNightFromMin || localMinute < SAFE_RETURN_LIMITS.lateNightToMin;
}

/** Cihazda planlanan yerel bildirimler (uygulama kapalıyken de çalsın diye). Geçmişte kalanlar atlanır. */
export function safeReturnLocalSchedule(doc: Pick<SafeReturnDoc, 'status' | 'due_at' | 'grace_until'>, now: EpochMs): { kind: 'reminder' | 'due' | 'last_call'; at: EpochMs }[] {
  if (doc.status !== 'active') return [];
  const out: { kind: 'reminder' | 'due' | 'last_call'; at: EpochMs }[] = [
    { kind: 'reminder', at: doc.due_at - SAFE_RETURN_LIMITS.reminderBeforeMs },
    { kind: 'due', at: doc.due_at },
    { kind: 'last_call', at: doc.grace_until - 30 * SECOND },
  ];
  return out.filter((x) => x.at > now);
}

export function sanitizeSafeReturnName(raw: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  let s = (raw ?? '').replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > SAFE_RETURN_LIMITS.destNameMaxChars) {
    const cps = Array.from(s);
    while (cps.length > 0 && cps.join('').length > SAFE_RETURN_LIMITS.destNameMaxChars) cps.pop();
    s = cps.join('').trim();
  }
  return s || 'Hedef';
}

// --- şemalar -------------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const SAFE_RETURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const SafeReturnFixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10_000),
  timestamp: z.number().int().positive(),
  battery_pct: z.number().int().min(0).max(100).nullable().default(null),
  is_charging: z.boolean().nullable().default(null),
});

export const SafeReturnDestinationSchema = z.object({
  kind: z.enum(SAFE_RETURN_DEST_KINDS),
  name: z.string().min(1).max(SAFE_RETURN_LIMITS.destNameMaxChars * 2),
  zone_id: z.string().min(1).max(64).nullable().default(null),
});

export const SafeReturnStartRequestSchema = z.object({
  op_id: z.uuid(),
  duration_min: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
  destination: SafeReturnDestinationSchema,
  contact_ids: z.array(uid).min(1).max(SAFE_RETURN_LIMITS.maxContacts),
  /** Başlangıç konumu ZORUNLU (alarmda her zaman bir son konum olsun). */
  fix: SafeReturnFixSchema,
  time_zone: z.string().min(1).max(64),
});
export type SafeReturnStartRequest = z.input<typeof SafeReturnStartRequestSchema>;

export const SafeReturnUpdateRequestSchema = z.object({
  op_id: z.uuid(),
  safe_return_id: z.string().regex(SAFE_RETURN_ID_RE),
  fix: SafeReturnFixSchema,
});
export type SafeReturnUpdateRequest = z.input<typeof SafeReturnUpdateRequestSchema>;

export const SafeReturnCheckInRequestSchema = z.object({
  op_id: z.uuid(),
  safe_return_id: z.string().regex(SAFE_RETURN_ID_RE),
  reason: z.enum(['safe', 'arrived']),
  /** Varışta son konum (isteğe bağlı). */
  fix: SafeReturnFixSchema.nullable().default(null),
});
export type SafeReturnCheckInRequest = z.input<typeof SafeReturnCheckInRequestSchema>;

export const SafeReturnIdRequestSchema = z.object({ op_id: z.uuid(), safe_return_id: z.string().regex(SAFE_RETURN_ID_RE) });
export type SafeReturnExtendRequest = z.input<typeof SafeReturnIdRequestSchema>;
export type SafeReturnCancelRequest = z.input<typeof SafeReturnIdRequestSchema>;

export const SafeReturnDocSchema: z.ZodType<SafeReturnDoc> = z.object({
  safe_return_id: z.string(),
  owner_id: uid,
  owner_name: z.string(),
  contact_ids: z.array(uid),
  destination: z.object({ kind: z.enum(SAFE_RETURN_DEST_KINDS), name: z.string(), zone_id: z.string().nullable() }),
  duration_min: z.number(),
  started_at: z.number(),
  due_at: z.number(),
  grace_until: z.number(),
  extend_count: z.number(),
  status: z.enum(SAFE_RETURN_STATUSES),
  due_notified_at: z.number().nullable(),
  last_fix: z.object({
    lat: z.number(),
    lng: z.number(),
    accuracy: z.number(),
    timestamp: z.number(),
    battery_pct: z.number().nullable(),
    is_charging: z.boolean().nullable(),
  }),
  sos_id: z.string().nullable(),
  time_zone: z.string(),
  ended_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  version: z.number(),
});

export function parseSafeReturn(raw: unknown): SafeReturnDoc | null {
  const r = SafeReturnDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export interface SafeReturnResponse {
  safe_return: SafeReturnDoc;
  /** Başlangıçta bildirim giden kişi sayısı (yalnızca start). */
  notified_count?: number;
  server_now: EpochMs;
}
export const SafeReturnResponseSchema: z.ZodType<SafeReturnResponse> = z.object({
  safe_return: SafeReturnDocSchema,
  notified_count: z.number().int().nonnegative().optional(),
  server_now: z.number(),
});

// --- metinler ------------------------------------------------------------------------------

export const SAFE_RETURN_TEXT = {
  title: 'Güvenli Dönüş',
  subtitle: 'Belirlediğin sürede hedefine varmazsan ve "Güvendeyim" demezsen, seçtiğin acil kişine son konumun ve pil durumunla otomatik alarm gider.',
  lateNightHint: 'Gece geç saatte ya da yalnız yola çıkıyorsan Güvenli Dönüş zamanlayıcısını aç.',
  durationLabel: 'Süre',
  durationOption: (m: number): string => `${m} dk`,
  destinationLabel: 'Nereye?',
  contactsLabel: 'Kime haber verilsin?',
  contactsEmpty: 'Önce acil durum kişisi seç (Profil > Acil durum kişileri).',
  start: 'Zamanlayıcıyı başlat',
  needsLocation: 'Zamanlayıcıyı başlatmak için konum gerekiyor.',
  checkIn: 'Güvendeyim',
  arrived: 'Vardım',
  extend: '+15 dk',
  cancel: 'Zamanlayıcıyı iptal et',
  cancelConfirm: 'Güvenli Dönüş iptal edilsin mi? Kişilerine iptal edildiği bildirilir.',
  banner: (destName: string, left: string): string => `Güvenli Dönüş · ${destName} · ${left}`,
  endingSoon: (left: string): string => `Güvenli Dönüş'ün bitmesine ${left} kaldı`,
  finalWarningTitle: 'Güvende misin?',
  finalWarningBody: (seconds: number, names: string): string =>
    `${seconds} sn içinde "Güvendeyim" demezsen ${names} son konumunla ve pil durumunla uyarılacak.`,
  alarmSent: 'Alarm gönderildi. Kişilerin son konumunu görüyor.',
  ended: { arrived: 'Hedefine vardın, kişilerine bildirildi.', checked_in: 'Güvende olduğun kişilerine bildirildi.', cancelled: 'Güvenli Dönüş iptal edildi.' },
  offlineHint: 'İnternet yok. Süre dolarsa alarm yine de son bildirdiğin konumla gider; istersen SMS ile de haber ver.',
} as const;

/** Acil kişilere başlangıç bildirimi. Koordinat YOK. */
export function safeReturnStartedPushText(ownerName: string, destName: string, durationMin: number): { title: string; body: string } {
  return { title: `${ownerName} Güvenli Dönüş başlattı`, body: `${sanitizeSafeReturnName(destName)} hedefine ${durationMin} dk içinde varmazsa ve yanıt vermezse sana haber vereceğiz.` };
}

/** Acil kişilere bitiş bildirimi. */
export function safeReturnEndedPushText(ownerName: string, destName: string, reason: 'arrived' | 'checked_in' | 'cancelled'): { title: string; body: string } {
  const d = sanitizeSafeReturnName(destName);
  switch (reason) {
    case 'arrived':
      return { title: `${ownerName} güvenle vardı`, body: `Güvenli Dönüş tamamlandı · ${d}` };
    case 'checked_in':
      return { title: `${ownerName} güvende`, body: `Güvende olduğunu bildirdi · ${d}` };
    case 'cancelled':
      return { title: `${ownerName} Güvenli Dönüş'ü iptal etti`, body: d };
  }
}

/** Sahibin cihazlarına "Güvende misin?" (push ve yerel bildirim). */
export function safeReturnDuePushText(names: string): { title: string; body: string } {
  return { title: 'Güvende misin?', body: `Güvenli Dönüş süren doldu. 2 dk içinde "Güvendeyim" demezsen ${names} uyarılacak.` };
}

/** Alarm SOS kaydının mesajı (`SosAlert.message`). */
export function safeReturnAlarmMessage(destName: string, durationMin: number): string {
  return `Güvenli Dönüş süresi doldu: ${sanitizeSafeReturnName(destName)} hedefine ${durationMin} dk içinde varmadım ve yanıt vermedim`;
}
