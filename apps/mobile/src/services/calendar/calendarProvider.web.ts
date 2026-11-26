/**
 * Web demo: takvim adaptörü → simüle telefon takvimi (`demo/web/calendarSim.ts`) + simüle iOS izin penceresi
 * ("Etkinlik Eklemeye İzin Ver", yalnızca ekleme). Native `calendarProvider.ts` ile aynı API.
 */
import { nativeCalendarFields, type CalendarEntry } from '@konum/core';
import { demoCalendarDelete, demoCalendarForm, demoCalendarWrite } from '../../demo/web/calendarSim';
import { demoCanAsk, demoPerms, requestDemoPermission } from '../../demo/web/permissions';
import type { CalendarPermission, CalendarWriteResult } from './calendarProvider';

export type { CalendarPermission, CalendarWriteResult } from './calendarProvider';

/** Demo telefonu iPhone gibi davranır (yalnızca ekleme izni). */
export const CALENDAR_PLATFORM = 'ios' as const;

const map = (s: 'undetermined' | 'granted' | 'denied'): CalendarPermission => ({
  state: s === 'granted' ? 'write_only' : s,
  canAskAgain: demoCanAsk('calendar'),
});

export async function getCalendarPermission(): Promise<CalendarPermission> {
  return map(demoPerms().calendar);
}

export async function requestCalendarPermission(): Promise<CalendarPermission> {
  return map(await requestDemoPermission('calendar'));
}

const input = (e: CalendarEntry) => {
  const f = nativeCalendarFields(e);
  return { title: f.title, startDate: f.startDate, endDate: f.endDate, timeZone: f.timeZone, location: f.location, notes: f.notes, url: f.url, alarms: f.alarms.map((a) => -a.relativeOffset) };
};

export async function writeCalendarEvent(entry: CalendarEntry, existingId: string | null): Promise<CalendarWriteResult> {
  const ev = demoCalendarWrite(input(entry), existingId);
  return { native_id: ev.id, calendar_id: ev.calendar, method: 'native', saved: true };
}

export async function openCalendarForm(entry: CalendarEntry): Promise<CalendarWriteResult> {
  const ev = await demoCalendarForm(input(entry));
  return { native_id: ev?.id ?? null, calendar_id: ev?.calendar ?? null, method: 'system_form', saved: !!ev };
}

export async function deleteCalendarEvent(nativeId: string): Promise<boolean> {
  return demoCalendarDelete(nativeId);
}
