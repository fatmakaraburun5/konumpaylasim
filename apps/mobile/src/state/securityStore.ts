/**
 * Faz 10: "Aktif Cihazlar ve Oturumlar" + hesap kurtarma kanalları (core `accountSecurity.ts`, docs/PHASE10.md §3).
 *
 *  - `devices`: kendi cihaz oturumlarım (dinleyici). `myDsid`: bu cihaz (token iddiası).
 *  - `revoke(dsid, stopShares)`: "Eski Cihazdaki Oturumu ve Konum Yayınını Kapat" (`device_revoke`). Sunucu kara
 *    listeyi ANINDA yazar: o cihazın RTDB/Firestore yazımı ve callable'ları reddedilir, sessiz `session_revoked` push'u
 *    arka plan konum görevini durdurur ve oturumu kapatır.
 *  - Kurtarma: SMS (giriş numarası) + e-posta/Gmail, ikisi de 6 haneli kodla doğrulanır. E-posta doğrulanınca yeni
 *    telefonda SMS'ten sonra e-posta kodu istenir (iki adımlı).
 */
import {
  EMPTY_RECOVERY,
  type ChallengeView,
  type DeviceSessionDoc,
  type MigrationManifest,
  type RecoverySummary,
  type VerificationPurpose,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { toKonumError } from '../lib/errors';
import { securityApi, type SecurityApi } from '../services/firebase/callables';

export interface PendingCode {
  purpose: Extract<VerificationPurpose, 'link_email' | 'verify_phone'>;
  challenge: ChallengeView;
}

export interface SecurityState {
  devices: DeviceSessionDoc[];
  loaded: boolean;
  recovery: RecoverySummary;
  myDsid: string | null;
  pending: PendingCode | null;
  manifest: MigrationManifest | null;
  busy: string | null;
  error: string | null;
  /** Son başarılı işlem (kısa bildirim). */
  toast: string | null;
  /** Bu cihazın oturumu başka cihazdan kapatıldı (çıkıştan sonra telefon ekranında gösterilir). */
  revokedHere: boolean;
  setDevices: (d: DeviceSessionDoc[]) => void;
  setRecovery: (r: RecoverySummary) => void;
  setMyDsid: (d: string | null) => void;
  revoke: (dsid: string, stopShares: boolean) => Promise<boolean>;
  revokeAllOthers: (stopShares: boolean) => Promise<boolean>;
  startEmail: (email: string) => Promise<boolean>;
  startSms: () => Promise<boolean>;
  verifyCode: (code: string) => Promise<boolean>;
  resend: () => Promise<boolean>;
  cancelCode: () => void;
  removeEmail: () => Promise<boolean>;
  loadManifest: () => Promise<void>;
  clearToast: () => void;
  markRevokedHere: (v: boolean) => void;
  reset: () => void;
}

export function createSecurityStore(api: SecurityApi = securityApi) {
  return createStore<SecurityState>()((set, get) => {
    async function run<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      if (get().busy) return null;
      set({ busy: key, error: null });
      try {
        const r = await fn();
        set({ busy: null });
        return r;
      } catch (e) {
        set({ busy: null, error: toKonumError(e).message });
        return null;
      }
    }
    const modelOf = (dsid: string) => get().devices.find((d) => d.dsid === dsid)?.model ?? 'Cihaz';
    const markLocalRevoked = (ids: readonly string[], now: number) =>
      set({
        devices: get().devices.map((d) => (ids.includes(d.dsid) ? { ...d, status: 'revoked' as const, publishing: false, revoked_at: now, revoke_reason: 'remote' as const } : d)),
      });
    return {
      devices: [],
      loaded: false,
      recovery: EMPTY_RECOVERY,
      myDsid: null,
      pending: null,
      manifest: null,
      busy: null,
      error: null,
      toast: null,
      revokedHere: false,
      setDevices: (devices) => set({ devices, loaded: true }),
      setRecovery: (recovery) => set({ recovery }),
      setMyDsid: (myDsid) => set({ myDsid }),
      revoke: async (dsid, stopShares) => {
        const model = modelOf(dsid);
        const r = await run('revoke', () => api.deviceRevoke({ dsid, all_others: false, stop_shares: stopShares }));
        if (!r) return false;
        markLocalRevoked(r.revoked, r.server_now);
        set({ toast: `${model}: oturum kapatıldı, konum yayını durdu${r.stopped_shares ? ` · ${r.stopped_shares} paylaşım bitti` : ''}` });
        return true;
      },
      revokeAllOthers: async (stopShares) => {
        const r = await run('revoke_all', () => api.deviceRevoke({ dsid: null, all_others: true, stop_shares: stopShares }));
        if (!r) return false;
        markLocalRevoked(r.revoked, r.server_now);
        set({ toast: r.revoked.length ? `${r.revoked.length} cihazın oturumu kapatıldı` : 'Başka etkin cihaz yok' });
        return true;
      },
      startEmail: async (email) => {
        const r = await run('email', () => api.recoveryChannelStart({ channel: 'email', email }));
        if (!r) return false;
        set({ pending: { purpose: 'link_email', challenge: r.challenge } });
        return true;
      },
      startSms: async () => {
        const r = await run('sms', () => api.recoveryChannelStart({ channel: 'sms', email: null }));
        if (!r) return false;
        set({ pending: { purpose: 'verify_phone', challenge: r.challenge } });
        return true;
      },
      verifyCode: async (code) => {
        const p = get().pending;
        if (!p) return false;
        const r = await run('verify', () => api.recoveryChannelVerify({ challenge_id: p.challenge.challenge_id, code: code.trim() }));
        if (!r) return false;
        set({ pending: null, recovery: r.recovery, toast: p.purpose === 'link_email' ? 'E-posta doğrulandı' : 'Telefon numarası doğrulandı' });
        return true;
      },
      resend: async () => {
        const p = get().pending;
        if (!p) return false;
        return p.purpose === 'verify_phone' ? get().startSms() : false;
      },
      cancelCode: () => set({ pending: null, error: null }),
      removeEmail: async () => {
        const r = await run('remove_email', () => api.recoveryChannelRemove({ channel: 'email' }));
        if (!r) return false;
        set({ recovery: r.recovery, toast: 'Kurtarma e-postası kaldırıldı' });
        return true;
      },
      loadManifest: async () => {
        try {
          const r = await api.accountMigrationManifest();
          set({ manifest: r.manifest });
        } catch {
          // en iyi çaba: liste "Yükleniyor…" kalır
        }
      },
      clearToast: () => set({ toast: null }),
      markRevokedHere: (revokedHere) => set({ revokedHere }),
      reset: () =>
        set({ devices: [], loaded: false, recovery: EMPTY_RECOVERY, myDsid: null, pending: null, manifest: null, busy: null, error: null, toast: null }),
    };
  });
}

export const securityStore = createSecurityStore();

export function useSecurityStore<T>(selector: (s: SecurityState) => T): T {
  return useStore(securityStore, selector);
}
