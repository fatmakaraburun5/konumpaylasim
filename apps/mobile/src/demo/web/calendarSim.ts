/**
 * Web demo · Faz 10: simüle telefon takvimi (iOS Takvim / Google Takvim yerine). Yazılan etkinlikler bu tarayıcıda
 * kalır (`konum.demo.calendar.v1`); telefon çerçevesinde "Takvim" kartı (`shell/Faz10.web.tsx`) görünür:
 *  - `native`: izinle yazıldı → "Etkinlik eklendi" kartı (kapat).
 *  - `form`: izin yok → sistemin "Yeni Etkinlik" formu (Ekle / Vazgeç).
 */
import { safeStorage } from '../server/storage';

export interface DemoCalendarEvent {
  id: string;
  title: string;
  startDate: number;
  endDate: number;
  timeZone: string;
  location: string;
  notes: string;
  url: string;
  alarms: number[];
  calendar: string;
  added_at: number;
}

export interface DemoCalendarSheet {
  id: number;
  kind: 'added' | 'form';
  event: DemoCalendarEvent;
  resolve: (r: 'saved' | 'canceled' | 'closed') => void;
}

const KEY = 'konum.demo.calendar.v1';
type Listener = () => void;
const listeners = new Set<Listener>();
let seq = 0;
let sheets: DemoCalendarSheet[] = [];

function load(): DemoCalendarEvent[] {
  try {
    const raw = safeStorage.get(KEY);
    const v = raw ? (JSON.parse(raw) as DemoCalendarEvent[]) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
let events = load();
const emit = () => listeners.forEach((l) => l());
const save = () => {
  safeStorage.set(KEY, JSON.stringify(events.slice(-30)));
  emit();
};

export const onCalendarSimChange = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const demoCalendarEvents = (): DemoCalendarEvent[] => [...events];
export const currentCalendarSheet = (): DemoCalendarSheet | null => sheets[0] ?? null;
export const DEMO_CALENDAR_NAME = 'iCloud · Takvim';

function newId(): string {
  return `cal-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function openSheet(kind: DemoCalendarSheet['kind'], event: DemoCalendarEvent): Promise<'saved' | 'canceled' | 'closed'> {
  return new Promise((resolve) => {
    const s: DemoCalendarSheet = {
      id: ++seq,
      kind,
      event,
      resolve: (r) => {
        sheets = sheets.filter((x) => x.id !== s.id);
        emit();
        resolve(r);
      },
    };
    sheets = [...sheets, s];
    emit();
  });
}

export type DemoCalendarInput = Omit<DemoCalendarEvent, 'id' | 'calendar' | 'added_at'>;

/** İzinle doğrudan yazım (kart gösterilir ama yazım beklemez). `id` verilirse günceller. */
export function demoCalendarWrite(input: DemoCalendarInput, id: string | null): DemoCalendarEvent {
  const prev = id ? events.find((e) => e.id === id) : undefined;
  const ev: DemoCalendarEvent = { ...input, id: prev?.id ?? newId(), calendar: DEMO_CALENDAR_NAME, added_at: Date.now() };
  events = prev ? events.map((e) => (e.id === prev.id ? ev : e)) : [...events, ev];
  save();
  void openSheet('added', ev);
  return ev;
}

/** Sistem formu (izinsiz): kullanıcı "Ekle" derse kaydedilir. */
export async function demoCalendarForm(input: DemoCalendarInput): Promise<DemoCalendarEvent | null> {
  const ev: DemoCalendarEvent = { ...input, id: newId(), calendar: DEMO_CALENDAR_NAME, added_at: Date.now() };
  const r = await openSheet('form', ev);
  if (r !== 'saved') return null;
  events = [...events, ev];
  save();
  return ev;
}

export function demoCalendarDelete(id: string): boolean {
  const had = events.some((e) => e.id === id);
  events = events.filter((e) => e.id !== id);
  save();
  return had;
}

export function demoCalendarClear(): void {
  events = [];
  save();
}
