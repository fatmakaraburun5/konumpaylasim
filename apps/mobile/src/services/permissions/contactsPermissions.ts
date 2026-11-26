/**
 * Faz 9: Rehber izni ve kişi seçici (expo-contacts, yeni sınıf API'si). Yalnızca SMS acil durum numarası seçmek
 * için; rehber sunucuya yüklenmez / taranmaz, seçilen numara yalnızca cihazda saklanır (smsFallbackStore).
 *
 *  - iOS 18 "seçili kişiler" → `limited` (yeterli). Modül yoksa → `unavailable`.
 *  - Seçici (`Contact.presentPicker`): iOS'ta CNContactPicker izin istemez; Android'de seçilen kişinin numarası
 *    okunurken izin gerekebilir (yoksa önce istenir). İzin hiç verilmezse kullanıcı numarayı elle yazar.
 */
import type { ContactsPermState } from '@konum/core';

type ExpoContacts = typeof import('expo-contacts');

function contacts(): ExpoContacts | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-contacts') as ExpoContacts;
  } catch {
    return null;
  }
}

export interface ContactsPermission {
  contacts: ContactsPermState;
  contactsCanAskAgain: boolean;
}

const toState = (r: { granted?: boolean; status?: string; accessPrivileges?: string }): ContactsPermState =>
  r.accessPrivileges === 'limited'
    ? 'limited'
    : r.granted || r.status === 'granted'
      ? 'granted'
      : r.status === 'denied'
        ? 'denied'
        : 'undetermined';

/** Yalnızca okur (sistem penceresi açmaz). */
export async function readContactsPermission(): Promise<ContactsPermission> {
  const m = contacts();
  if (!m) return { contacts: 'unavailable', contactsCanAskAgain: false };
  try {
    const r = await m.getPermissionsAsync();
    return { contacts: toState(r), contactsCanAskAgain: r.canAskAgain !== false };
  } catch {
    return { contacts: 'unavailable', contactsCanAskAgain: false };
  }
}

/** Sistem istemi (ilk açılış / Gizlilik Merkezi / "Rehberden seç"). */
export async function requestContactsPermission(): Promise<ContactsPermState> {
  const m = contacts();
  if (!m) return 'unavailable';
  try {
    return toState(await m.requestPermissionsAsync());
  } catch {
    return 'denied';
  }
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
  /** Numara okunamadı: izin reddedildi (Ayarlar) — numarayı elle yazdır. */
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'unavailable' };

/** Sistem kişi seçicisini açar; seçilen kişinin adı ve telefonları (yalnızca bellekte döner). */
export async function pickContactPhone(): Promise<ContactPickResult> {
  const m = contacts();
  if (!m) return { kind: 'unavailable' };
  try {
    const c = await m.Contact.presentPicker();
    if (!c) return { kind: 'cancelled' };
    const read = async (): Promise<PickedContact> => {
      const [name, phones] = await Promise.all([c.getFullName().catch(() => ''), c.getPhones()]);
      return {
        name: name.trim(),
        phones: phones.filter((p) => typeof p.number === 'string' && p.number.trim()).map((p) => ({ label: p.label ?? null, number: p.number!.trim() })),
      };
    };
    try {
      return { kind: 'picked', contact: await read() };
    } catch {
      // Android: numarayı okumak için izin gerekebilir.
      const st = await requestContactsPermission();
      if (st !== 'granted' && st !== 'limited') {
        const r = await readContactsPermission();
        return { kind: 'denied', canAskAgain: r.contactsCanAskAgain };
      }
      return { kind: 'picked', contact: await read() };
    }
  } catch {
    return { kind: 'unavailable' };
  }
}
