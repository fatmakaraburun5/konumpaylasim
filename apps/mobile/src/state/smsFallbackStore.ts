/**
 * Faz 9: çevrimdışı SOS SMS yedeği tercihi — core `smsFallback.ts`, docs/PHASE9.md §4.
 *
 *  - YALNIZCA cihazda (`SMS_FALLBACK_STORAGE_KEY`); sunucuya gitmez. Numaralar rehberden seçilir ya da elle yazılır,
 *    E.164'e çevrilir (en çok 5). Rehberin kendisi okunmaz / saklanmaz: yalnızca seçilen numara.
 *  - Açmak AÇIK ONAY ister: `enable(true)` (onay kutusu işaretli) — onay anı `decided_at`'e yazılır. "Kapalı kalsın"
 *    `decline()` (karar verildi, kapalı). İlk açılış adımı `sms` bu kararla geçilir (`selectSmsFallbackDecided`).
 *  - `available`: cihaz SMS oluşturabiliyor mu (expo-sms `isAvailableAsync`; SIM'siz / tablet / web → false).
 *  - Çıkışta silinir (aynı cihazda başka hesap önceki kişinin numaralarını görmesin).
 */
import {
  addSmsNumber,
  DEFAULT_SMS_FALLBACK,
  parseSmsFallback,
  removeSmsNumber,
  SMS_FALLBACK_STORAGE_KEY,
  SMS_FALLBACK_TEXT,
  type EpochMs,
  type SmsFallbackNumber,
  type SmsFallbackSettings,
  type SmsFallbackSummary,
} from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { pickContactPhone, type ContactPickResult, type PickedPhone } from '../services/permissions/contactsPermissions';
import { isSmsAvailable } from '../services/sms/smsComposer';

export type AddNumberResult = { ok: true; number: SmsFallbackNumber } | { ok: false; reason: 'invalid' | 'duplicate' | 'limit'; message: string };

export type PickFromContactsResult =
  | AddNumberResult
  /** Kişinin birden çok numarası var: arayüz birini seçtirir ve `addNumber({source:'contacts'})` çağırır. */
  | { ok: false; reason: 'choose'; name: string; phones: PickedPhone[]; message: string }
  | { ok: false; reason: 'cancelled' | 'no_phone' | 'denied' | 'unavailable'; message: string; canAskAgain?: boolean };

export interface SmsFallbackState {
  hydrated: boolean;
  settings: SmsFallbackSettings;
  /** null = bilinmiyor (henüz okunmadı). */
  available: boolean | null;
  hydrate(): Promise<void>;
  refreshAvailability(): Promise<boolean>;
  /** AÇIK ONAY: yalnızca `consent === true` ile açılır (onay kutusu). */
  enable(consent: boolean): Promise<boolean>;
  /** Kapat (karar verildi sayılır; numaralar korunur, tekrar açınca yeniden onay istenir). */
  disable(): Promise<void>;
  /** İlk açılışta "Kapalı kalsın". */
  decline(): Promise<void>;
  addNumber(input: { label: string; phone: string; source: SmsFallbackNumber['source'] }): Promise<AddNumberResult>;
  removeNumber(e164: string): Promise<void>;
  /** Sistem kişi seçicisi → tek numara varsa eklenir; birden çoksa `choose`. */
  pickFromContacts(): Promise<PickFromContactsResult>;
  reset(): Promise<void>;
}

export interface SmsFallbackStoreDeps {
  now: () => EpochMs;
  read: () => Promise<unknown>;
  write: (v: SmsFallbackSettings | null) => Promise<void>;
  isAvailable: () => Promise<boolean>;
  pickContact: () => Promise<ContactPickResult>;
}

const defaultRead = async (): Promise<unknown> => {
  const raw = await AsyncStorage.getItem(SMS_FALLBACK_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
};
const defaultWrite = async (v: SmsFallbackSettings | null): Promise<void> => {
  if (v) await AsyncStorage.setItem(SMS_FALLBACK_STORAGE_KEY, JSON.stringify(v));
  else await AsyncStorage.removeItem(SMS_FALLBACK_STORAGE_KEY);
};

const REASON_TEXT = { invalid: SMS_FALLBACK_TEXT.invalidNumber, duplicate: SMS_FALLBACK_TEXT.duplicateNumber, limit: SMS_FALLBACK_TEXT.limitReached } as const;

export function createSmsFallbackStore(overrides: Partial<SmsFallbackStoreDeps> = {}): StoreApi<SmsFallbackState> {
  const deps: SmsFallbackStoreDeps = {
    now: () => Date.now(),
    read: defaultRead,
    write: defaultWrite,
    isAvailable: isSmsAvailable,
    pickContact: pickContactPhone,
    ...overrides,
  };

  return createStore<SmsFallbackState>()((set, get) => {
    const persist = async (settings: SmsFallbackSettings) => {
      set({ settings });
      await deps.write(settings).catch(() => undefined);
    };

    return {
      hydrated: false,
      settings: { ...DEFAULT_SMS_FALLBACK, numbers: [] },
      available: null,

      hydrate: async () => {
        const raw = await deps.read().catch(() => null);
        set({ settings: parseSmsFallback(raw), hydrated: true });
        void get().refreshAvailability();
      },

      refreshAvailability: async () => {
        const available = await deps.isAvailable().catch(() => false);
        set({ available });
        return available;
      },

      enable: async (consent) => {
        if (consent !== true) return false;
        await persist({ ...get().settings, enabled: true, decided_at: deps.now() });
        return true;
      },

      disable: async () => persist({ ...get().settings, enabled: false, decided_at: deps.now() }),

      decline: async () => persist({ ...get().settings, enabled: false, decided_at: deps.now() }),

      addNumber: async (input) => {
        const r = addSmsNumber(get().settings, input);
        if (!r.ok) return { ok: false, reason: r.reason, message: REASON_TEXT[r.reason] };
        await persist(r.settings);
        return { ok: true, number: r.number };
      },

      removeNumber: async (e164) => persist(removeSmsNumber(get().settings, e164)),

      pickFromContacts: async () => {
        const r = await deps.pickContact().catch((): ContactPickResult => ({ kind: 'unavailable' }));
        switch (r.kind) {
          case 'cancelled':
            return { ok: false, reason: 'cancelled', message: '' };
          case 'denied':
            return { ok: false, reason: 'denied', message: 'Rehber izni kapalı. Numarayı elle yazabilir ya da Ayarlar’dan izin verebilirsin.', canAskAgain: r.canAskAgain };
          case 'unavailable':
            return { ok: false, reason: 'unavailable', message: 'Rehber açılamadı. Numarayı elle yazabilirsin.' };
          case 'picked': {
            const phones = r.contact.phones;
            if (phones.length === 0) return { ok: false, reason: 'no_phone', message: 'Bu kişide telefon numarası yok.' };
            if (phones.length > 1) return { ok: false, reason: 'choose', name: r.contact.name, phones, message: 'Hangi numara?' };
            return get().addNumber({ label: r.contact.name || 'Acil kişi', phone: phones[0]!.number, source: 'contacts' });
          }
        }
      },

      reset: async () => {
        set({ settings: { ...DEFAULT_SMS_FALLBACK, numbers: [] }, hydrated: false });
        await deps.write(null).catch(() => undefined);
      },
    };
  });
}

export const smsFallbackStore = createSmsFallbackStore();

export function useSmsFallbackStore<T>(selector: (s: SmsFallbackState) => T): T {
  return useStore(smsFallbackStore, selector);
}

/** Gizlilik Merkezi satırı (`permissionCenterRows(snapshot, summary)`). */
export function selectSmsSummary(s: Pick<SmsFallbackState, 'settings'>): SmsFallbackSummary {
  return { enabled: s.settings.enabled, numbers: s.settings.numbers.length, decided: s.settings.decided_at !== null };
}

/** Hook: Gizlilik Merkezi özeti (sığ karşılaştırmalı; her render'da yeni nesne üretmez). */
export function useSmsSummary(): SmsFallbackSummary {
  return useStore(smsFallbackStore, useShallow(selectSmsSummary));
}

/** İlk açılış `nextOnboardingStep({ smsFallbackDecided })`. */
export const selectSmsFallbackDecided = (s: Pick<SmsFallbackState, 'settings'>): boolean => s.settings.decided_at !== null;

/** SMS önerilebilir mi (açık + en az bir numara). */
export const selectSmsReady = (s: Pick<SmsFallbackState, 'settings' | 'available'>): boolean =>
  s.settings.enabled && s.settings.numbers.length > 0 && s.available !== false;
