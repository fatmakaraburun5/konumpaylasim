/**
 * Faz 9: gönderen tarafı hedef durumu metinleri (saf; testte de kullanılır). Alıcı tarafı core `destBadgeText`.
 */
import { formatDistanceTr, sanitizeDestName, venueOf, type DestState, type EpochMs, type EventDoc, type LatLng, type Meetup } from '@konum/core';

/** "Hedef: Ev · Yoldasın · 1,2 km" / "Hedef: Ev · Neredeyse vardın" / "Hedef: Ev · Vardın". */
export function myDestStatusText(name: string, status: { state: DestState; distance_m: number | null } | null): string {
  const base = `Hedef: ${sanitizeDestName(name)}`;
  if (!status) return base;
  if (status.state === 'arrived') return `${base} · Vardın`;
  if (status.state === 'near') return `${base} · Neredeyse vardın`;
  return status.distance_m !== null ? `${base} · ${formatDistanceTr(status.distance_m)}` : `${base} · Yoldasın`;
}

/** Haritadan seçilen noktanın hedef adı: adresin ilk parçası ("Bağdat Cd. No:12") ya da "Seçilen nokta". */
export function pointDestName(address: string | null | undefined): string {
  const first = (address ?? '').split(',')[0]?.trim();
  return sanitizeDestName(first || 'Seçilen nokta');
}

export interface DestOption {
  key: string;
  kind: 'zone' | 'event' | 'meetup';
  ref_id: string;
  name: string;
  label: string;
  center: LatLng;
  radius_m: number | null;
}

/** Seçilebilir etkinlik mekanları (kesinleşmiş, konumu olan, bitmemiş) ve buluşma noktaları (etkin). */
export function eventMeetupOptions(events: readonly EventDoc[], meetups: readonly Meetup[], now: EpochMs): DestOption[] {
  const out: DestOption[] = [];
  for (const e of events) {
    if (e.end_reason !== null || e.expires_at <= now) continue;
    const v = venueOf(e);
    if (!v?.location) continue;
    out.push({ key: `event:${e.event_id}`, kind: 'event', ref_id: e.event_id, name: v.name, label: `📅 ${e.title} · ${v.name}`, center: v.location, radius_m: null });
  }
  for (const m of meetups) {
    if (m.status !== 'active' || m.expires_at <= now) continue;
    out.push({ key: `meetup:${m.meetup_id}`, kind: 'meetup', ref_id: m.meetup_id, name: m.place.name, label: `📍 ${m.place.name}`, center: m.place.location, radius_m: null });
  }
  return out;
}
