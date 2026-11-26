/**
 * Faz 7: Etkinlik Alanı arayüz yardımcıları (saf; kurallar core `events.ts`te, burada yalnızca görünüm).
 */
import {
  addDaysToDate,
  EVENT_LIMITS,
  eventStep,
  formatEventDate,
  isValidTimeZone,
  localDateOf,
  offsetFnForTimeZone,
  TR_MONTHS,
  TR_WEEKDAYS,
  type EpochMs,
  type EventDoc,
  type EventNoticeType,
  type EventTodo,
  type UserId,
} from '@konum/core';
import type { IconName } from '../../ui';

export const FALLBACK_TIME_ZONE = 'Europe/Istanbul';

/** Cihazın IANA saat dilimi (geçersizse İstanbul). */
export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

export interface DateChoice {
  date: string;
  /** "Bugün" · "Yarın" · "Cmt 29 Kas". */
  label: string;
  /** Ekran okuyucu: "29 Kasım Cumartesi". */
  a11y: string;
}

const WEEKDAY_SHORT = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'] as const;

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Tarih çipleri: bugünden başlayarak `count` gün (en çok `maxDaysAhead`). */
export function dateChoices(now: EpochMs, timeZone: string, count = 21): DateChoice[] {
  const today = localDateOf(now, offsetFnForTimeZone(timeZone));
  const out: DateChoice[] = [];
  for (let i = 0; i < Math.min(count, EVENT_LIMITS.maxDaysAhead + 1); i++) {
    const date = addDaysToDate(today, i);
    const [, m, d] = date.split('-').map(Number) as [number, number, number];
    const wd = weekdayOf(date);
    const label = i === 0 ? 'Bugün' : i === 1 ? 'Yarın' : `${WEEKDAY_SHORT[wd]} ${d} ${TR_MONTHS[m - 1]?.slice(0, 3) ?? ''}`;
    out.push({ date, label, a11y: `${d} ${TR_MONTHS[m - 1]} ${TR_WEEKDAYS[wd]}` });
  }
  return out;
}

/** Hızlı saat seçenekleri (yerel dakika). Elle "SS:DD" de girilebilir. */
export const TIME_PRESETS: readonly number[] = [9 * 60, 10 * 60, 12 * 60, 13 * 60, 15 * 60, 18 * 60, 19 * 60, 19 * 60 + 30, 20 * 60, 21 * 60];

export function voteWindowLabel(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h >= 24 && h % 24 === 0 ? `${h / 24} gün` : `${h} saat`;
}

/** "Yanıt süresi 5 sa 12 dk sonra doluyor" · "Yanıt süresi 1 dk içinde doluyor" · "Yanıt süresi doldu". */
export function deadlineLabel(deadline: EpochMs | null, now: EpochMs): string | null {
  if (deadline === null) return null;
  const left = deadline - now;
  if (left <= 0) return 'Yanıt süresi doldu';
  if (left <= 60_000) return 'Yanıt süresi 1 dk içinde doluyor';
  const totalMin = Math.ceil(left / 60_000);
  const d = Math.floor(totalMin / (24 * 60));
  const h = Math.floor((totalMin % (24 * 60)) / 60);
  const m = totalMin % 60;
  const parts = d > 0 ? [`${d} gün`, h ? `${h} sa` : ''] : h > 0 ? [`${h} sa`, m ? `${m} dk` : ''] : [`${m} dk`];
  return `Yanıt süresi ${parts.filter(Boolean).join(' ')} sonra doluyor`;
}

export const TODO_TEXT: Record<Exclude<EventTodo, null>, string> = {
  respond: 'Yanıtını bekliyor',
  complete_answer: 'Yanıtını tamamla',
  finalize: 'Sonuçları onayla',
};

export type StepState = 'done' | 'current' | 'todo';

/** Üç adımlı ilerleme: 1 Yanıtlar · 2 Sonuçlar · 3 Kesinleşti (core `eventStep`). */
export function stageSteps(doc: Pick<EventDoc, 'stage' | 'results_at'>): { label: string; state: StepState }[] {
  const step = eventStep(doc);
  const labels = ['Yanıtlar', 'Sonuçlar', 'Kesinleşti'];
  return labels.map((label, i) => {
    const n = i + 1;
    if (step === 0) return { label, state: 'todo' as StepState };
    if (n < step || step >= 3) return { label, state: 'done' as StepState };
    if (n === step) return { label, state: 'current' as StepState };
    return { label, state: 'todo' as StepState };
  });
}

export const NOTICE_ICON: Record<EventNoticeType, IconName> = {
  event_invite: 'calendar',
  event_stage: 'check',
  event_rsvp: 'users',
  event_reminder: 'bell',
  event_cancelled: 'close',
};

/** "az önce" · "5 dk önce" · "3 sa önce" · "dün" · "29 Kasım". */
export function relativeTime(at: EpochMs, now: EpochMs, timeZone: string = deviceTimeZone()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return 'az önce';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} dk önce`;
  const off = offsetFnForTimeZone(timeZone);
  const today = localDateOf(now, off);
  const day = localDateOf(at, off);
  if (day === today) return `${Math.floor(diff / 3_600_000)} sa önce`;
  if (addDaysToDate(day, 1) === today) return 'dün';
  return formatEventDate(day).split(' ').slice(0, 2).join(' ');
}

/** Üyenin adı (etkinlik belgesindeki anlık görüntü; arkadaş listesinde varsa güncel ad önce). */
export function memberName(doc: Pick<EventDoc, 'names'>, uid: UserId, friendNames: Record<UserId, string>, me: UserId | null): string {
  if (uid === me) return 'Sen';
  return friendNames[uid] || doc.names[uid] || 'Davetli';
}

/** Saat seçeneği listesi düzenleme: ekle (sıralı, tekil, en çok 4) / çıkar. */
export function toggleMinute(list: readonly number[], minute: number): number[] {
  if (list.includes(minute)) return list.filter((m) => m !== minute);
  if (list.length >= EVENT_LIMITS.maxTimeOptions) return [...list];
  return [...list, minute].sort((a, b) => a - b);
}
