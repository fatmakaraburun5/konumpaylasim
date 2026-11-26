/**
 * Faz 10: cihaz oturumu kaydı (girişten hemen sonra, profil/bootstrap'tan ÖNCE).
 *
 *  - Token'da `dsid` varsa: kayıtlı cihaz, işlem yok (heartbeat sonra tazeler).
 *  - Yoksa (`device_register`): `active` → custom token ile oturum el değiştirir (aynı uid, `dsid` iddiası);
 *    `needs_second_factor` → yeni telefon: kurtarma e-postasına kod gitti, authStore ikinci aşama ekranını açar.
 *  - Ağ yok / sunucu eski: girişi engellemez (`offline`); sonraki çağrı `device_registration_required` dönerse
 *    yeniden denenir (`sessionEvents`).
 *
 * Bağımlılıklar parametreyle verilir (authStore ↔ servis döngüsü yok; testler sahte verir).
 */
import type { ChallengeView, DeviceRegisterResponse } from '@konum/core';
import { toKonumError } from '../../lib/errors';
import { currentDsid, signInWithCustomToken } from '../firebase/authClient';
import { deviceRegister } from '../firebase/callables';
import { currentDeviceInfo } from './deviceInfo';

export type DeviceSessionOutcome =
  | { kind: 'ok'; dsid: string | null; migrated: boolean }
  | { kind: 'second_factor'; dsid: string; model: string; challenge: ChallengeView }
  | { kind: 'revoked' }
  | { kind: 'offline' };

export interface DeviceSessionDeps {
  currentDsid: () => Promise<string | null>;
  register: () => Promise<DeviceRegisterResponse>;
  signIn: (token: string) => Promise<void>;
}

const defaultDeps: DeviceSessionDeps = {
  currentDsid,
  register: async () => deviceRegister({ device: await currentDeviceInfo() }),
  signIn: signInWithCustomToken,
};

export async function ensureDeviceSession(deps: DeviceSessionDeps = defaultDeps): Promise<DeviceSessionOutcome> {
  const dsid = await deps.currentDsid();
  if (dsid) return { kind: 'ok', dsid, migrated: false };
  let r: DeviceRegisterResponse;
  try {
    r = await deps.register();
  } catch (e) {
    const err = toKonumError(e);
    if (err.code === 'session_revoked') return { kind: 'revoked' };
    return { kind: 'offline' };
  }
  if (r.status === 'needs_second_factor' && r.challenge) return { kind: 'second_factor', dsid: r.device.dsid, model: r.device.model, challenge: r.challenge };
  if (r.custom_token) {
    try {
      await deps.signIn(r.custom_token);
    } catch {
      return { kind: 'offline' };
    }
  }
  return { kind: 'ok', dsid: r.device.dsid, migrated: r.migrated };
}
