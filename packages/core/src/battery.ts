/**
 * Faz 3: düşük pil tetikleyicisi (saf).
 *
 * Paylaşan cihazın pili %15'e (dahil) indiğinde alıcılara BİR KEZ "düşük pil" bildirimi gider.
 * Yeniden kurulma: pil ≥ %20 olunca ya da şarja takılınca. Tak-çıkar ile bildirim yağmuru olmasın diye
 * iki bildirim arasında en az `minRefireMs` beklenir. Durum paylaşım OTURUMU başına tutulur (yeni oturum =
 * `null` durum). Bildirim sunucudan FCM ile gider, koordinat İÇERMEZ (bkz. `lowBatteryPushText`).
 *
 * Ek olarak canlı paketteki `battery_pct` zaten %15 sınırı geçilince hemen yayınlanır (`shouldPublish`
 * → `battery_changed`); alıcı haritada rozeti bildirimden bağımsız görür.
 */
import { LOW_BATTERY_PCT } from './cadence';
import { turkishGenitive } from './format';
import { MINUTE, type EpochMs } from './time';

export const LOW_BATTERY_REARM_PCT = 20;
export const LOW_BATTERY_MIN_REFIRE_MS = 30 * MINUTE;

export interface LowBatteryState {
  /** true = bir sonraki %15 altı okumada bildirim gider. */
  armed: boolean;
  firedAt: EpochMs | null;
  /** Bu oturumda gönderilen bildirim sayısı (teşhis). */
  fired: number;
  lastPct: number | null;
}

export const initialLowBatteryState = (): LowBatteryState => ({ armed: true, firedAt: null, fired: 0, lastPct: null });

export interface LowBatteryDecision {
  fire: boolean;
  state: LowBatteryState;
}

/**
 * Her pil okumasında çağrılır. `pct` null (bilinmiyor) ise durum değişmez.
 * Paylaşım zaten %15 altında başlarsa ilk okumada bildirim gider (alıcı bunu bilmeli).
 */
export function lowBatteryTrigger(
  prev: LowBatteryState | null,
  pct: number | null,
  charging: boolean | null,
  now: EpochMs,
  opts: { minRefireMs?: number } = {},
): LowBatteryDecision {
  const state: LowBatteryState = { ...(prev ?? initialLowBatteryState()) };
  if (pct === null || !Number.isFinite(pct)) return { fire: false, state };
  state.lastPct = pct;
  if (charging === true || pct >= LOW_BATTERY_REARM_PCT) {
    state.armed = true;
    return { fire: false, state };
  }
  if (pct > LOW_BATTERY_PCT || !state.armed) return { fire: false, state };
  const minRefire = opts.minRefireMs ?? LOW_BATTERY_MIN_REFIRE_MS;
  if (state.firedAt !== null && now - state.firedAt < minRefire) {
    // Kısa süre önce bildirildi (tak-çıkar): sessizce tüket.
    state.armed = false;
    return { fire: false, state };
  }
  state.armed = false;
  state.firedAt = now;
  state.fired += 1;
  return { fire: true, state };
}

/**
 * Alıcıya giden bildirim metni (koordinat yok). Sunucu (FCM), mobil ön plan bildirimi ve web görüntüleyici aynı metni
 * kullanır: başlık "Ayşe'nin pili azaldı", gövde "Pil %14. Konum daha seyrek güncellenecek."
 * Ad boşsa ya da tamlayan eki kurulamıyorsa "Arkadaşının pili azaldı".
 */
export function lowBatteryPushText(senderName: string, pct: number): { title: string; body: string } {
  const owner = turkishGenitive(senderName ?? '');
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return {
    title: owner ? `${owner} pili azaldı` : 'Arkadaşının pili azaldı',
    body: `Pil %${p}. Konum daha seyrek güncellenecek.`,
  };
}

/** Gönderen tarafta, kendi ekranında gösterilen bilgi. */
export const LOW_BATTERY_SELF_TEXT = 'Pilin %15’in altında: takip pil tasarrufu moduna geçti, paylaştığın kişilere bilgi verildi.';
