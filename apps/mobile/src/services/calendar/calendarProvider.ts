/**
 * Faz 10: yerel takvim adaptörü (expo-calendar: iOS EventKit / Android CalendarContract, Google Takvim hesabı
 * dahil). Web demosu aynı adla `calendarProvider.web.ts` sağlar (simüle takvim).
 *
 *  - iOS 17+: yalnızca EKLEME izni (`requestCalendarPermissions(true)`, write-only) → EventKit'in sanal varsayılan
 *    takvimi; mevcut etkinlikler okunamaz. Tam erişim (eski iOS / kullanıcı verdiyse) güncelleme / silmeyi açar.
 *  - Android: okuma + yazma (yazılabilir birincil takvimi bulmak için okuma gerekir); `isPrimary` + değişiklik izni
 *    olan ilk takvim, yoksa değiştirilebilir ilk takvim.
 *  - İzin yoksa: sistemin "Etkinlik ekle" formu (`createEventInCalendarAsync`, izin gerektirmez).
 */
import type { CalendarEntry, CalendarPermState, CalendarPlatform } from '@konum/core';
import { nativeCalendarFields } from '@konum/core';
import { Platform } from 'react-native';

export interface CalendarPermission {
  state: CalendarPermState;
  canAskAgain: boolean;
}

export interface CalendarWriteResult {
  native_id: string | null;
  calendar_id: string | null;
  method: 'native' | 'system_form';
  saved: boolean;
}

type CalendarModule = typeof import('expo-calendar');
type LegacyModule = typeof import('expo-calendar/legacy');

let mod: CalendarModule | null | undefined;
let legacy: LegacyModule | null | undefined;
function cal(): CalendarModule | null {
  if (mod === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('expo-calendar') as CalendarModule;
    } catch {
      mod = null;
    }
  }
  return mod;
}
function cal0(): LegacyModule | null {
  if (legacy === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      legacy = require('expo-calendar/legacy') as LegacyModule;
    } catch {
      legacy = null;
    }
  }
  return legacy;
}

const WRITE_ONLY = Platform.OS === 'ios';

/** core `calendarAddStep` platformu. */
export const CALENDAR_PLATFORM: CalendarPlatform = Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web';

function mapPerm(full: { status: string; granted: boolean; canAskAgain: boolean } | null, wo: { status: string; granted: boolean; canAskAgain: boolean } | null): CalendarPermission {
  if (full?.granted) return { state: Platform.OS === 'ios' ? 'full' : 'granted', canAskAgain: true };
  if (wo?.granted) return { state: 'write_only', canAskAgain: true };
  const p = wo ?? full;
  if (!p) return { state: 'unavailable', canAskAgain: false };
  if (p.status === 'undetermined') return { state: 'undetermined', canAskAgain: true };
  return { state: p.canAskAgain ? 'denied' : 'denied', canAskAgain: p.canAskAgain };
}

export async function getCalendarPermission(): Promise<CalendarPermission> {
  const c = cal();
  if (!c) return { state: 'unavailable', canAskAgain: false };
  try {
    const full = await c.getCalendarPermissions(false);
    const wo = WRITE_ONLY && !full.granted ? await c.getCalendarPermissions(true) : null;
    return mapPerm(full, wo);
  } catch {
    return { state: 'unavailable', canAskAgain: false };
  }
}

/** Sistem izin istemi (iOS: yalnızca ekleme). Uygulama içi onay sayfasından SONRA çağrılır. */
export async function requestCalendarPermission(): Promise<CalendarPermission> {
  const c = cal();
  if (!c) return { state: 'unavailable', canAskAgain: false };
  try {
    const r = await c.requestCalendarPermissions(WRITE_ONLY);
    return WRITE_ONLY ? mapPerm(null, r) : mapPerm(r, null);
  } catch {
    return { state: 'unavailable', canAskAgain: false };
  }
}

async function targetCalendar(c: CalendarModule) {
  if (Platform.OS === 'ios') return c.getDefaultCalendarSync();
  const list = await c.getCalendars();
  const writable = list.filter((k) => k.allowsModifications);
  return writable.find((k) => k.isPrimary) ?? writable[0] ?? null;
}

/** İzinle doğrudan yazar; `existingId` (tam erişim) varsa günceller. */
export async function writeCalendarEvent(entry: CalendarEntry, existingId: string | null): Promise<CalendarWriteResult> {
  const c = cal();
  if (!c) throw new Error('calendar_unavailable');
  const f = nativeCalendarFields(entry);
  const details = {
    title: f.title,
    startDate: new Date(f.startDate),
    endDate: new Date(f.endDate),
    timeZone: f.timeZone,
    location: f.location,
    notes: f.notes,
    url: f.url,
    alarms: f.alarms,
  };
  if (existingId) {
    try {
      const ev = await c.ExpoCalendarEvent.get(existingId);
      await ev.update(details);
      return { native_id: existingId, calendar_id: null, method: 'native', saved: true };
    } catch {
      // silinmiş ya da erişilemiyor: yeniden oluştur
    }
  }
  const target = await targetCalendar(c);
  if (!target) throw new Error('calendar_no_writable');
  const ev = await target.createEvent(details);
  return { native_id: ev.id ?? null, calendar_id: target.id ?? null, method: 'native', saved: true };
}

/** İzinsiz yol: sistemin "Etkinlik ekle" formu (kullanıcı kaydet'e basar). */
export async function openCalendarForm(entry: CalendarEntry): Promise<CalendarWriteResult> {
  const l = cal0();
  if (!l) throw new Error('calendar_unavailable');
  const f = nativeCalendarFields(entry);
  const r = await l.createEventInCalendarAsync({
    title: f.title,
    startDate: new Date(f.startDate),
    endDate: new Date(f.endDate),
    timeZone: f.timeZone,
    location: f.location,
    notes: f.notes,
    url: f.url,
  });
  const saved = r.action === 'saved' || r.action === 'done';
  return { native_id: r.id ?? null, calendar_id: null, method: 'system_form', saved };
}

/** Tam erişimle kaydı siler (iptal edilen etkinlik). */
export async function deleteCalendarEvent(nativeId: string): Promise<boolean> {
  const c = cal();
  if (!c) return false;
  try {
    await (await c.ExpoCalendarEvent.get(nativeId)).delete();
    return true;
  } catch {
    return false;
  }
}
