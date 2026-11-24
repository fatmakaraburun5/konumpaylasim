/**
 * Türkçe zaman ve durum metinleri. Saat gösterimi cihazın yerel saatindedir.
 */
import type { ShareMode } from './duration';
import type { ShareEndReason } from './model';
import type { Freshness } from './packet';
import { DAY, HOUR, MINUTE, type EpochMs, type OffsetFn, deviceOffset } from './time';

/** 14 dk · 1 sa 5 dk · 2 gün 3 sa · 45 sn */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'süre doldu';
  if (ms < MINUTE) return `${Math.ceil(ms / 1000)} sn`;
  const totalMin = Math.ceil(ms / MINUTE);
  if (ms < HOUR) return `${totalMin} dk`;
  if (ms < DAY) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h} sa ${m} dk` : `${h} sa`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d} gün ${h} sa` : `${d} gün`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Yerel saat "17:45". */
export function formatClock(at: EpochMs, offsetAt: OffsetFn = deviceOffset): string {
  const local = new Date(at + offsetAt(at) * MINUTE);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

const UNIT_SUFFIX: Record<number, string> = { 1: 'e', 2: 'ye', 3: 'e', 4: 'e', 5: 'e', 6: 'ya', 7: 'ye', 8: 'e', 9: 'a' };
const TENS_SUFFIX: Record<number, string> = { 1: 'a', 2: 'ye', 3: 'a', 4: 'a', 5: 'ye' };

/**
 * "HH:MM" için yönelme hâli eki (kesme işareti hariç): 'e / 'a / 'ye / 'ya.
 * Ek, okunan son sayıya göre seçilir: dakika 00 ise saat, değilse dakika okunur.
 * 14:45'e (kırk beşe) · 17:30'a (otuza) · 22:00'ye (yirmi ikiye) · 16:00'ya (on altıya) · 00:00'a (sıfıra)
 */
export function dativeSuffixForClock(clock: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!m) return 'e';
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const n = mm === 0 ? hh : mm;
  if (n === 0) return 'a';
  if (n % 10 === 0) return TENS_SUFFIX[n / 10] ?? 'e';
  return UNIT_SUFFIX[n % 10] ?? 'e';
}

/** "17:30'a kadar" */
export function untilClock(at: EpochMs, offsetAt: OffsetFn = deviceOffset): string {
  const clock = formatClock(at, offsetAt);
  return `${clock}'${dativeSuffixForClock(clock)} kadar`;
}

/** Paylaşım kartındaki bitiş etiketi. */
export function formatExpiryLabel(
  share: { share_mode: ShareMode; expires_at: EpochMs | null },
  now: EpochMs,
  offsetAt: OffsetFn = deviceOffset,
): string {
  if (share.expires_at === null) return 'Süresiz · siz durdurana kadar';
  const left = share.expires_at - now;
  if (left <= 0) return 'Süre doldu';
  const until = untilClock(share.expires_at, offsetAt);
  if (share.share_mode === 'until_end_of_day') return `Gün sonuna kadar · ${formatRemaining(left)} kaldı`;
  if (left >= DAY) {
    const d = new Date(share.expires_at + offsetAt(share.expires_at) * MINUTE);
    return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${until} · ${formatRemaining(left)} kaldı`;
  }
  return `${until} · ${formatRemaining(left)} kaldı`;
}

export const END_REASON_TEXT: Record<ShareEndReason, string> = {
  stopped_by_sender: 'Paylaşımı durdurdun',
  revoked_by_receiver: 'Karşı taraf paylaşımı kapattı',
  expired: 'Süre doldu',
  friendship_removed: 'Arkadaşlık kaldırıldı',
  blocked: 'Paylaşım sona erdi',
  account_deleted: 'Hesap silindi',
};

/** Alıcı tarafı: "şimdi", "3 dk önce", "2 sa önce". */
export function formatAgo(at: EpochMs, now: EpochMs): string {
  const d = Math.max(0, now - at);
  if (d < MINUTE) return 'şimdi';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} dk önce`;
  if (d < DAY) return `${Math.floor(d / HOUR)} sa önce`;
  return `${Math.floor(d / DAY)} gün önce`;
}

export const FRESHNESS_TEXT: Record<Freshness, string> = {
  live: 'Canlı',
  recent: 'Az önce',
  stale: 'Son bilinen konum',
};

// --- Faz 3: Türkçe tamlayan eki ------------------------------------------------

const TR_VOWELS = 'aeıioöuüAEIİOÖUÜ';
const GENITIVE_SUFFIX: Record<string, string> = { a: 'ın', ı: 'ın', e: 'in', i: 'in', o: 'un', u: 'un', ö: 'ün', ü: 'ün' };

/**
 * Türkçe tamlayan eki (özel ad + kesme işareti): Ayşe → Ayşe'nin, Can → Can'ın, Bora → Bora'nın, Ümit → Ümit'in,
 * "Ayşe Y." → "Ayşe Y.'nin" (harfin okunuşu: ünsüzler "e" ile okunur). Son ünlüye göre büyük ünlü uyumu; ad ünlüyle
 * bitiyorsa kaynaştırma "n". Ünlü yoksa (ör. "JR") null → çağıran genel metne düşer.
 * [Varsayım] Yabancı adlarda okunuşa göre istisnalar olabilir (ör. "George").
 */
export function turkishGenitive(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  const lower = n.toLocaleLowerCase('tr-TR');
  const initial = /(?:^|\s)(\p{L})\.?$/u.exec(lower)?.[1];
  if (initial) {
    const v = TR_VOWELS.includes(initial) ? initial : 'e';
    return `${n}'n${GENITIVE_SUFFIX[v] ?? 'in'}`;
  }
  let vowel: string | undefined;
  for (let i = lower.length - 1; i >= 0; i--) {
    const ch = lower[i] as string;
    if (TR_VOWELS.includes(ch)) {
      vowel = ch;
      break;
    }
  }
  if (!vowel) return null;
  const suffix = GENITIVE_SUFFIX[vowel] ?? 'in';
  const last = lower[lower.length - 1] as string;
  return `${n}'${TR_VOWELS.includes(last) ? 'n' : ''}${suffix}`;
}
