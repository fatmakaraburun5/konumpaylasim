/**
 * Faz 10: doğrulama kodu gönderimi (`AuthVerificationProvider`, core `accountSecurity.ts`). Harici SMS / e-posta
 * servisleri canlı kurulumun EN SON adımında bağlanır; o zamana kadar yalnızca yerel / sahte adaptör vardır.
 *
 * Seçim ortam değişkeniyle: `SMS_PROVIDER` = `mock` | `twilio_verify` | `netgsm`, `EMAIL_PROVIDER` = `mock` |
 * `sendgrid` | `gmail_api`. Henüz yazılmamış adaptörler `provider_unavailable` döner (istemci `verification_unavailable`
 * görür). `mock` YALNIZCA emülatörde / yerel testte (ya da açıkça `VERIFICATION_MOCK_OK=true`) çalışır: üretimde
 * kodlar sessizce günlüğe düşmesin.
 *
 * Sahte adaptör kodu göndermez; geliştirme yanıtına (`dev_code`) konur ve günlüğe MASKELİ alıcıyla yazılır. Kod
 * hiçbir zaman Firestore'a düz yazılmaz (yalnızca HMAC özeti).
 */
import {
  type AuthVerificationProvider,
  type VerificationChannel,
  type VerificationMessage,
  type VerificationSendResult,
  maskEmail,
  maskPhone,
} from '@konum/core';
import * as logger from 'firebase-functions/logger';
import { IS_EMULATOR, IS_LOCAL_TEST } from '../config';

/** Emülatör / yerel testte geliştirme yanıtına kod konur (demo ve testler kodu buradan okur). */
export const DEV_ECHO_CODES = IS_EMULATOR || IS_LOCAL_TEST;
const MOCK_ALLOWED = DEV_ECHO_CODES || process.env.VERIFICATION_MOCK_OK === 'true';

/** Testlerin incelediği son sahte gönderimler (yalnızca bellek, süreç başına). */
export const mockOutbox: { channel: VerificationChannel; to_masked: string; purpose: string; text: string; at: number }[] = [];

export function mockProvider(channel: VerificationChannel): AuthVerificationProvider {
  return {
    channel,
    id: channel === 'sms' ? 'mock_sms' : 'mock_email',
    async send(msg: VerificationMessage): Promise<VerificationSendResult> {
      if (!MOCK_ALLOWED) return { ok: false, reason: 'provider_unavailable' };
      const to_masked = channel === 'sms' ? maskPhone(msg.to) : maskEmail(msg.to);
      mockOutbox.push({ channel, to_masked, purpose: msg.purpose, text: msg.text.replace(msg.code, '••••••'), at: Date.now() });
      if (mockOutbox.length > 50) mockOutbox.shift();
      logger.info('[sahte doğrulama] kod gönderildi', { channel, to: to_masked, purpose: msg.purpose });
      return { ok: true, provider_ref: null };
    },
  };
}

/** Canlı kurulumda doldurulacak adaptörler (anahtarlar Secret Manager'dan). */
function notConfigured(channel: VerificationChannel, id: string): AuthVerificationProvider {
  return {
    channel,
    id,
    async send(): Promise<VerificationSendResult> {
      logger.error('doğrulama sağlayıcısı henüz bağlanmadı', { channel, id });
      return { ok: false, reason: 'provider_unavailable' };
    },
  };
}

export function verificationProvider(channel: VerificationChannel): AuthVerificationProvider {
  const id = (channel === 'sms' ? process.env.SMS_PROVIDER : process.env.EMAIL_PROVIDER) ?? 'mock';
  if (id === 'mock') return mockProvider(channel);
  return notConfigured(channel, id);
}
