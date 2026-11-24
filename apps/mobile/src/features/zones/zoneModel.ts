/**
 * Faz 5 bölge arayüzünün saf mantığı (test edilebilir; React / depo bağımlılığı yok).
 *
 *  - Kural taslağı: şablondan kural (`ZONE_RULE_TEMPLATES`), gün maskesi, saat aralığı, paylaşım süresi etiketi.
 *  - Liste satırı: kural özeti (core `describeZoneRule` + süre / gün / saat), "Şu an buradasın" rozeti.
 *  - Son olaylar: "Ev · vardın · 18:42 · Ayşe'ye bildirildi" ya da bastırma nedeni.
 *  - İzleme bandı: izin gerekiyor / desteklenmiyor / açık.
 */
import {
  ALL_DAYS_MASK,
  describeZoneRule,
  DURATION_OPTIONS,
  formatClock,
  WEEKDAY_SHORT_TR,
  ZONE_KIND_EMOJI,
  ZONE_KIND_TEXT,
  ZONE_LIMITS,
  ZONE_RULE_TEMPLATES,
  ZONE_SHARE_DURATIONS,
  type DurationChoice,
  type LatLng,
  type OffsetFn,
  type UserId,
  type Zone,
  type ZoneKind,
  type ZoneRule,
  type ZoneTimeWindow,
  type ZoneTrigger,
} from '@konum/core';
import type { ZoneMonitoring } from '../../state/zonesStore';

// --- yarıçap --------------------------------------------------------------------------------

/** Yarıçap çipleri (m). [Varsayım] Ara değerler ± düğmeleriyle 50 m adımla. */
export const ZONE_RADIUS_CHIPS: readonly number[] = [100, 150, 250, 500, 1_000, 2_000];
export const ZONE_RADIUS_STEP_M = 50;

export function clampZoneRadius(m: number): number {
  if (!Number.isFinite(m)) return ZONE_LIMITS.defaultRadiusM;
  return Math.min(ZONE_LIMITS.maxRadiusM, Math.max(ZONE_LIMITS.minRadiusM, Math.round(m / 10) * 10));
}

export const stepZoneRadius = (m: number, dir: 1 | -1): number => clampZoneRadius(m + dir * ZONE_RADIUS_STEP_M);

/** Dairenin kuzey / güney / doğu / batı uçları (haritayı daireye sığdırmak için). */
export function circleBounds(center: LatLng, radiusM: number): LatLng[] {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return [
    { lat: center.lat + dLat, lng: center.lng },
    { lat: center.lat - dLat, lng: center.lng },
    { lat: center.lat, lng: center.lng + dLng },
    { lat: center.lat, lng: center.lng - dLng },
  ];
}

/** [Varsayım] Konum bilinmiyorsa düzenleyici Kadıköy'de açılır (web önizleme haritasıyla aynı bölge). */
export const DEFAULT_ZONE_CENTER: LatLng = { lat: 40.9862, lng: 29.0275 };

// --- tür ve ad ------------------------------------------------------------------------------

export const zoneEmoji = (z: Pick<Zone, 'emoji' | 'kind'>): string => z.emoji || ZONE_KIND_EMOJI[z.kind];

/** Tür değişince ad: boşsa ya da önceki türün varsayılan adıysa yeni türün adı; kullanıcı yazdıysa korunur. */
export function nameOnKindChange(prevKind: ZoneKind, nextKind: ZoneKind, name: string): string {
  const t = name.trim();
  return t === '' || t === ZONE_KIND_TEXT[prevKind] ? ZONE_KIND_TEXT[nextKind] : name;
}

// --- günler ve saat aralığı ---------------------------------------------------------------------

export const WEEKDAYS_MASK = 0b0011111; // Pzt–Cum
export const WEEKEND_MASK = 0b1100000; // Cmt–Paz

export const DAY_PRESETS: readonly { id: string; label: string; mask: number }[] = [
  { id: 'all', label: 'Her gün', mask: ALL_DAYS_MASK },
  { id: 'weekdays', label: 'Hafta içi', mask: WEEKDAYS_MASK },
  { id: 'weekend', label: 'Hafta sonu', mask: WEEKEND_MASK },
];

/** Günü aç / kapa; son gün kapatılamaz (şema en az bir gün ister). */
export function toggleDay(mask: number, day: number): number {
  const next = mask ^ (1 << day);
  return next === 0 ? mask : next;
}

export const isDayOn = (mask: number, day: number): boolean => (mask & (1 << day)) !== 0;

export function describeDays(mask: number): string {
  const preset = DAY_PRESETS.find((p) => p.mask === mask);
  if (preset) return preset.label;
  return WEEKDAY_SHORT_TR.filter((_d, i) => isDayOn(mask, i)).join(', ');
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatMinuteOfDay = (min: number): string => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

/** Saat adımı (30 dk), gün içinde döner. */
export const WINDOW_STEP_MIN = 30;
export const stepMinuteOfDay = (min: number, dir: 1 | -1): number => (((min + dir * WINDOW_STEP_MIN) % 1440) + 1440) % 1440;

/** [Varsayım] "Belirli saatlerde" açılınca ilk aralık: 08:00–20:00. */
export const DEFAULT_WINDOW: ZoneTimeWindow = { from_min: 8 * 60, to_min: 20 * 60 };

export const describeWindow = (w: ZoneTimeWindow | null): string | null =>
  !w || w.from_min === w.to_min ? null : `${formatMinuteOfDay(w.from_min)}–${formatMinuteOfDay(w.to_min)}`;

// --- paylaşım süresi ---------------------------------------------------------------------------

export function sameDuration(a: DurationChoice | null, b: DurationChoice | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === 'preset' && b.kind === 'preset' ? a.preset === b.preset : true;
}

export function shareDurationLabel(d: DurationChoice | null): string {
  if (!d) return '';
  return DURATION_OPTIONS.find((o) => o.choice && sameDuration(o.choice, d))?.label ?? 'Özel süre';
}

/** [Varsayım] start_share varsayılan süresi 1 saat. */
export const DEFAULT_SHARE_DURATION: DurationChoice = ZONE_SHARE_DURATIONS[1] ?? { kind: 'preset', preset: 'h1' };

// --- kural taslağı ------------------------------------------------------------------------------

export function ruleFromTemplate(templateId: string, ruleId: string, recipients: readonly UserId[] = []): ZoneRule {
  const t = ZONE_RULE_TEMPLATES.find((x) => x.id === templateId) ?? ZONE_RULE_TEMPLATES[0]!;
  return {
    rule_id: ruleId,
    trigger: t.trigger,
    action: t.action,
    recipient_ids: [...recipients],
    share_duration: t.action === 'start_share' ? DEFAULT_SHARE_DURATION : null,
    days_mask: ALL_DAYS_MASK,
    window: null,
    enabled: true,
  };
}

/** Kuralın şablonu (yön + eylem); yoksa null. */
export const ruleTemplateId = (r: Pick<ZoneRule, 'trigger' | 'action'>): string | null =>
  ZONE_RULE_TEMPLATES.find((t) => t.trigger === r.trigger && t.action === r.action)?.id ?? null;

/** Şablon değişince yön / eylem güncellenir; süre eylem için gerekirse eklenir, gerekmezse düşer. */
export function applyTemplate(r: ZoneRule, templateId: string): ZoneRule {
  const t = ZONE_RULE_TEMPLATES.find((x) => x.id === templateId);
  if (!t) return r;
  return {
    ...r,
    trigger: t.trigger,
    action: t.action,
    share_duration: t.action === 'start_share' ? (r.share_duration ?? DEFAULT_SHARE_DURATION) : null,
  };
}

export function toggleRecipient(list: readonly UserId[], uid: UserId): { next: UserId[]; error: string | null } {
  if (list.includes(uid)) return { next: list.filter((u) => u !== uid), error: null };
  if (list.length >= ZONE_LIMITS.maxRecipientsPerRule) return { next: [...list], error: `Bir kurala en çok ${ZONE_LIMITS.maxRecipientsPerRule} kişi ekleyebilirsin.` };
  return { next: [...list, uid], error: null };
}

/** Kayıttan önce kural denetimi; geçerliyse null. */
export function validateRule(r: ZoneRule): string | null {
  if (r.recipient_ids.length === 0) return 'En az bir kişi seç.';
  if (r.recipient_ids.length > ZONE_LIMITS.maxRecipientsPerRule) return `En çok ${ZONE_LIMITS.maxRecipientsPerRule} kişi seçebilirsin.`;
  if (r.action === 'start_share' && !ZONE_SHARE_DURATIONS.some((d) => sameDuration(d, r.share_duration))) return 'Paylaşım süresini seç.';
  if (r.days_mask <= 0) return 'En az bir gün seç.';
  return null;
}

// --- Türkçe ekler ---------------------------------------------------------------------------------

const TR_VOWELS = 'aeıioöuü';
const BACK_VOWELS = 'aıou';

/** Yönelme hâli (özel ad + kesme): Ayşe → Ayşe'ye, Can → Can'a, Mehmet → Mehmet'e. Ünlü yoksa null. */
export function turkishDative(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  const lower = n.toLocaleLowerCase('tr-TR');
  let vowel: string | undefined;
  for (let i = lower.length - 1; i >= 0; i--) {
    if (TR_VOWELS.includes(lower[i] as string)) {
      vowel = lower[i];
      break;
    }
  }
  if (!vowel) return null;
  const endsWithVowel = TR_VOWELS.includes(lower[lower.length - 1] as string);
  return `${n}'${endsWithVowel ? 'y' : ''}${BACK_VOWELS.includes(vowel) ? 'a' : 'e'}`;
}

const nameOf = (names: Record<string, string>, uid: UserId) => names[uid] ?? 'Arkadaşın';

/**
 * Liste satırı kural özeti: "Ev konumuna vardığımda Ayşe'ye bildir", "Ev konumundan çıktığımda Ayşe ile paylaşımı
 * başlat · 1 saat · Hafta içi 08:00–20:00".
 */
export function ruleSummary(r: ZoneRule, zoneName: string, names: Record<string, string>): string {
  const plain = r.recipient_ids.map((u) => nameOf(names, u));
  const shown = r.action === 'notify' && plain.length <= 2 ? plain.map((n) => turkishDative(n) ?? n) : plain;
  let text = describeZoneRule(r, zoneName, shown);
  if (r.action === 'notify') text = text.replace(/ kişi bildir$/, ' kişiye bildir');
  const extra: string[] = [];
  if (r.action === 'start_share' && r.share_duration) extra.push(shareDurationLabel(r.share_duration));
  const days = r.days_mask === ALL_DAYS_MASK ? null : describeDays(r.days_mask);
  const win = describeWindow(r.window);
  if (days || win) extra.push([days, win].filter(Boolean).join(' '));
  if (!r.enabled) extra.push('kapalı');
  return extra.length > 0 ? `${text} · ${extra.join(' · ')}` : text;
}

// --- son olaylar ----------------------------------------------------------------------------------

export const TRANSITION_PAST_TEXT: Record<ZoneTrigger, string> = { arrive: 'vardın', leave: 'ayrıldın' };

/** Bastırma nedenleri (sunucu `suppressed` + cihaz 'queued' / 'dropped'). */
export const ZONE_SUPPRESSED_TEXT: Record<string, string> = {
  cooldown: 'az önce bildirilmişti',
  stale: 'geç iletildi, bildirim gitmedi',
  outside_window: 'kural saati dışında',
  disabled: 'bölge kapalıydı',
  daily_limit: 'günlük bildirim sınırı doldu',
  queued: 'çevrimdışı, sırada',
  dropped: 'gönderilemedi',
};

export interface ZoneEventLike {
  zone_id: string;
  transition: ZoneTrigger;
  at: number;
  notified: number;
  suppressed: string | null;
}

function notifiedText(e: ZoneEventLike, zone: Zone | undefined, names: Record<string, string>): string {
  if (zone) {
    const ids = [...new Set(zone.rules.filter((r) => r.action === 'notify' && r.trigger === e.transition).flatMap((r) => r.recipient_ids))];
    if (ids.length === e.notified && ids.length > 0 && ids.length <= 2) {
      const ds = ids.map((u) => turkishDative(nameOf(names, u)));
      if (ds.every((d): d is string => d !== null)) return `${ds.join(' ve ')} bildirildi`;
    }
  }
  return `${e.notified} kişiye bildirildi`;
}

/** "Ev · vardın · 18:42 · Ayşe'ye bildirildi" */
export function recentEventText(e: ZoneEventLike, zone: Zone | undefined, names: Record<string, string>, offsetAt?: OffsetFn): string {
  const zoneName = zone?.name ?? 'Silinmiş bölge';
  const outcome = e.suppressed
    ? (ZONE_SUPPRESSED_TEXT[e.suppressed] ?? 'bildirim gitmedi')
    : e.notified > 0
      ? notifiedText(e, zone, names)
      : 'kimseye bildirilmedi';
  return [zoneName, TRANSITION_PAST_TEXT[e.transition], formatClock(e.at, offsetAt), outcome].join(' · ');
}

// --- izleme bandı -----------------------------------------------------------------------------------

export interface MonitoringBanner {
  tone: 'warning' | 'info' | 'live';
  text: string;
  /** Düğme metni (izin iste); yoksa düğme yok. */
  action: string | null;
}

export function monitoringBanner(m: ZoneMonitoring, enabledZones: number): MonitoringBanner | null {
  if (enabledZones === 0) return null;
  switch (m) {
    case 'needs_permission':
      return { tone: 'warning', text: "Bölge bildirimleri için konum iznini 'Her zaman' yap. Şimdilik yalnızca uygulama açıkken çalışır.", action: 'İzni ver' };
    case 'unsupported':
      return { tone: 'info', text: 'Bu cihaz arka planda bölge izlemeyi desteklemiyor; bölgeler uygulama açıkken çalışır.', action: null };
    case 'active':
      return { tone: 'live', text: 'Bölge izleme açık. Varış ve ayrılışlar GPS sapmasına karşı birkaç dakika doğrulanır.', action: null };
    default:
      return null;
  }
}

/** Kayıtta kurallardan düşen alıcılar uyarısı (arkadaş olmayanlar sessizce çıkarılır). */
export function droppedRecipientsText(dropped: readonly UserId[], names: Record<string, string>): string | null {
  if (dropped.length === 0) return null;
  const who = dropped.map((u) => names[u] ?? 'Bir kişi');
  return `${who.join(', ')} artık arkadaşın olmadığı için kurallardan çıkarıldı. Kişisi kalmayan kurallar silindi.`;
}
