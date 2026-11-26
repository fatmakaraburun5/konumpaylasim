/**
 * Web demo: Rehber izni (simüle iOS sistem penceresi, `demo/web/permissions.ts`) ve kişi seçici (telefon çerçevesinde
 * demo rehberi: Annem, Babam, Ablam…). Native `contactsPermissions.ts` (expo-contacts) ile aynı API. iOS'taki gibi
 * seçici izin istemez; seçilen numara yalnızca uygulamaya döner (rehber sunucuya gitmez).
 */
import type { ContactsPermState } from '@konum/core';
import { openDemoContactPicker } from '../../demo/web/f9Sim';
import { demoCanAsk, demoPerms, requestDemoPermission } from '../../demo/web/permissions';

export interface ContactsPermission {
  contacts: ContactsPermState;
  contactsCanAskAgain: boolean;
}

export interface PickedPhone {
  label: string | null;
  number: string;
}

export interface PickedContact {
  name: string;
  phones: PickedPhone[];
}

export type ContactPickResult =
  | { kind: 'picked'; contact: PickedContact }
  | { kind: 'cancelled' }
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'unavailable' };

export async function readContactsPermission(): Promise<ContactsPermission> {
  return { contacts: demoPerms().contacts, contactsCanAskAgain: demoCanAsk('contacts') };
}

export async function requestContactsPermission(): Promise<ContactsPermState> {
  return requestDemoPermission('contacts');
}

export async function pickContactPhone(): Promise<ContactPickResult> {
  const c = await openDemoContactPicker();
  if (!c) return { kind: 'cancelled' };
  return { kind: 'picked', contact: { name: c.name, phones: c.phones.map((p) => ({ label: p.label, number: p.number })) } };
}
