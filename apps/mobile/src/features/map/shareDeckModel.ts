/**
 * Alt kitapçık (ShareDeck) için saf model: giden paylaşım oturumları + QR bağlantıları → sıralı kart listesi,
 * kart metinleri, küçültülmüş çubuk özeti. Arayüz kodu yok; testler doğrudan bunu sınar.
 *
 * Sıra (öndeki kart = ilk eleman):
 *   0. süresi dolmak üzere olanlar (en az kalan önde)  → kullanıcı ilk bunu görmeli
 *   1. başlatılamayan / hata verenler                   → "Kapat" ya da "Tekrar dene" bekler
 *   2. sürenler, en kısa süresi kalan önde (süresiz en sonda)
 *   3. bitenler (sona erdi kartı, "Kapat" bekler)
 */
import {
  END_REASON_TEXT,
  formatClock,
  formatExpiryLabel,
  formatRemaining,
  type EpochMs,
  type ShareSession,
  type UserId,
  untilClock,
} from '@konum/core';
import { fixUntilSuffix } from '../../lib/turkish';
import type { LinkSession } from '../../state/linkStore';
import { LINK_TITLE, linkSubtitle } from '../link/linkText';

export type DeckTone = 'live' | 'warning' | 'muted' | 'danger';

interface DeckBase {
  key: string;
  expiresAt: EpochMs | null;
  startedAt: EpochMs;
  /** Süre sayacı çalışıyor mu (başlıyor / sürüyor / uzatılıyor / durduruluyor). */
  running: boolean;
  /** Bitti ya da başlatılamadı: kartta yalnızca "Kapat". */
  finished: boolean;
  expiring: boolean;
}
export type DeckItem = (DeckBase & { kind: 'share'; session: ShareSession }) | (DeckBase & { kind: 'link'; link: LinkSession });

const SHARE_RUNNING = new Set<ShareSession['phase']>(['starting', 'active', 'expiring_soon', 'extending', 'stopping']);
const LINK_RUNNING = new Set<LinkSession['phase']>(['active', 'expiring_soon', 'extending', 'stopping']);

function rank(it: DeckItem): number {
  if (it.expiring) return 0;
  if (it.kind === 'share' && it.session.phase === 'failed') return 1;
  if (it.running) return 2;
  return 3;
}

export function buildDeckItems(sessions: readonly ShareSession[], links: readonly LinkSession[]): DeckItem[] {
  const items: DeckItem[] = [
    ...sessions.map(
      (s): DeckItem => ({
        kind: 'share',
        key: `s:${s.session_id}`,
        session: s,
        expiresAt: s.expires_at,
        startedAt: s.started_at,
        running: SHARE_RUNNING.has(s.phase),
        finished: s.phase === 'ended' || s.phase === 'failed',
        expiring: s.phase === 'expiring_soon',
      }),
    ),
    ...links.map(
      (l): DeckItem => ({
        kind: 'link',
        key: `l:${l.link_id}`,
        link: l,
        expiresAt: l.expires_at,
        startedAt: l.started_at,
        running: LINK_RUNNING.has(l.phase),
        finished: l.phase === 'ended',
        expiring: l.phase === 'expiring_soon',
      }),
    ),
  ];
  const exp = (it: DeckItem) => it.expiresAt ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => rank(a) - rank(b) || exp(a) - exp(b) || a.startedAt - b.startedAt || a.key.localeCompare(b.key));
}

/** Odaktaki kartın sırası: anahtar hâlâ varsa onun yeri, yoksa ilk kart. */
export function focusIndex(items: readonly DeckItem[], focusKey: string | null): number {
  if (!focusKey) return 0;
  const i = items.findIndex((it) => it.key === focusKey);
  return i < 0 ? 0 : i;
}

/** Halka gibi döner: son karttan sonra ilk kart gelir. */
export function cycle(index: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((index + delta) % n) + n) % n;
}

/** Öndeki kartın arkasında görünen katman sayısı (kitapçık sırtı): en çok 2. */
export function peekCount(n: number): number {
  return Math.min(Math.max(n - 1, 0), 2);
}

/** Kart başlığı: alıcı adları ("Ayşe Yılmaz", "Ayşe, Mehmet +1") ya da "QR bağlantısı". */
export function itemTitle(it: DeckItem, names: Record<UserId, string>): string {
  if (it.kind === 'link') return 'QR bağlantısı';
  const ids = receiversOf(it.session);
  if (ids.length === 0) return 'Paylaşım';
  const full = (id: UserId) => names[id] ?? 'Arkadaş';
  if (ids.length === 1) return full(ids[0]!);
  const first = (id: UserId) => full(id).split(' ')[0] ?? full(id);
  return ids.length === 2 ? `${first(ids[0]!)}, ${first(ids[1]!)}` : `${first(ids[0]!)}, ${first(ids[1]!)} +${ids.length - 2}`;
}

/** Bittiyse bitenler, değilse hâlâ alanlar. */
export function receiversOf(s: ShareSession): UserId[] {
  const finished = s.phase === 'ended' || s.phase === 'failed';
  return finished && s.active_receiver_ids.length === 0 ? s.ended_receivers.map((e) => e.receiver_id) : s.active_receiver_ids;
}

const SHARE_STATUS: Record<ShareSession['phase'], string> = {
  starting: 'Paylaşım başlatılıyor…',
  active: 'Konumun paylaşılıyor',
  expiring_soon: 'Konumun paylaşılıyor',
  extending: 'Süre uzatılıyor…',
  stopping: 'Paylaşım durduruluyor…',
  ended: 'Paylaşım sona erdi',
  failed: 'Paylaşım başlatılamadı',
};

/**
 * Kartın durum satırı (tek satır). Öncelik: hata > konum alınamıyor uyarısı > kısmi bitiş > evre metni.
 */
export function itemStatus(
  it: DeckItem,
  names: Record<UserId, string>,
  trackingError: string | null,
): { text: string; tone: DeckTone } {
  if (it.kind === 'link') {
    const l = it.link;
    if (l.error && l.phase !== 'ended') return { text: l.error.message, tone: 'danger' };
    return { text: LINK_TITLE[l.phase], tone: l.phase === 'ended' ? 'muted' : it.expiring ? 'warning' : 'live' };
  }
  const s = it.session;
  if (s.phase === 'failed') return { text: s.error?.message ?? SHARE_STATUS.failed, tone: 'danger' };
  if (s.error && !it.finished) return { text: s.error.message, tone: 'danger' };
  if (trackingError && it.running) return { text: trackingError, tone: 'warning' };
  const partial = it.finished ? [] : s.ended_receivers.filter((e) => e.reason !== 'expired');
  if (partial.length > 0 && s.phase === 'active') {
    const e = partial[0]!;
    return { text: `${names[e.receiver_id] ?? 'Arkadaş'}: ${END_REASON_TEXT[e.reason]}`, tone: 'muted' };
  }
  return { text: SHARE_STATUS[s.phase], tone: s.phase === 'ended' ? 'muted' : it.expiring ? 'warning' : 'live' };
}

/** Zaman satırı: "18:09'a kadar · 60 dk kaldı", süresizde "Süresiz · siz durdurana kadar", bittiyse neden. */
export function itemTime(it: DeckItem, now: EpochMs): string {
  if (it.kind === 'link') return linkSubtitle(it.link, now);
  const s = it.session;
  if (s.phase === 'ended') return END_REASON_TEXT[s.end_reason ?? 'stopped_by_sender'];
  if (s.phase === 'failed') return 'Tekrar paylaşmayı deneyebilirsin';
  return fixUntilSuffix(formatExpiryLabel(s, now));
}

/** Kalan süre oranı (1 → 0); süresizde 1. */
export function itemProgress(it: DeckItem, now: EpochMs): number {
  if (it.expiresAt === null) return 1;
  const total = it.expiresAt - it.startedAt;
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(1, (it.expiresAt - now) / total));
}

/** Küçültülmüş çubuk metni. */
export function collapsedSummary(items: readonly DeckItem[], names: Record<UserId, string>, now: EpochMs): { text: string; tone: DeckTone } {
  const expiring = items.find((it) => it.expiring && it.expiresAt !== null);
  if (expiring) return { text: `${itemTitle(expiring, names)}: ${formatRemaining(expiring.expiresAt! - now)} içinde bitiyor`, tone: 'warning' };
  const running = items.filter((it) => it.running);
  if (running.length === 0) {
    const failed = items.some((it) => it.kind === 'share' && it.session.phase === 'failed');
    return { text: items.length === 1 ? itemStatus(items[0]!, names, null).text : `${items.length} paylaşım sona erdi`, tone: failed ? 'danger' : 'muted' };
  }
  const soonest = running.find((it) => it.expiresAt !== null);
  const until = soonest?.expiresAt != null ? untilClock(soonest.expiresAt) : null;
  const clock = soonest?.expiresAt != null ? formatClock(soonest.expiresAt) : null;
  if (running.length === 1) {
    const it = running[0]!;
    const who = it.kind === 'link' ? 'QR bağlantısıyla paylaşılıyor' : `${itemTitle(it, names)} ile paylaşılıyor`;
    return { text: until ? `${who} · ${until}` : who, tone: 'live' };
  }
  return { text: clock ? `${running.length} paylaşım · ilk bitiş ${clock}` : `${running.length} paylaşım sürüyor`, tone: 'live' };
}

/** "Tümünü durdur" çalışacak paylaşımlar (bitmiş / zaten durduruluyor olanlar hariç). */
export function stoppable(items: readonly DeckItem[]): DeckItem[] {
  return items.filter((it) => {
    if (!it.running) return false;
    if (it.kind === 'share') return it.session.phase !== 'starting' && (it.session.phase !== 'stopping' || !!it.session.error);
    return it.link.phase !== 'stopping' || !!it.link.error;
  });
}
