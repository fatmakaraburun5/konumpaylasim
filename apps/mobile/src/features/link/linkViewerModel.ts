/**
 * QR'ı okutan kişinin ekranı için saf model (uygulama içi görüntüleyici; web görüntüleyici aynı core kuralını
 * kullanır): bağlantı parametresi → token + özet; dinleyici durumu → ekran durumu ve metinler.
 */
import {
  formatAgo,
  freshness,
  FRESHNESS_TEXT,
  LINK_VIEW_DETAIL,
  LINK_VIEW_TEXT,
  linkTokenHash,
  linkViewState,
  parseLinkToken,
  untilClock,
  type EpochMs,
  type Freshness,
  type LinkLiveLocation,
  type LinkViewState,
} from '@konum/core';

export interface ResolvedLink {
  token: string;
  /** `link_live/{hash}` anahtarı (core `linkTokenHash`, cihazda hesaplanır; token ağa çıkmaz). */
  hash: string;
}

/**
 * Rota parametresi (çıplak token) ya da tam bağlantı (https://<alan>/s/<t>, konum://s/<t>) → token + özet.
 * Yalnızca uygulamanın bağlantı alan adları kabul edilir; bozuk token → null ("Bağlantı geçersiz").
 */
export function resolveLinkParam(raw: string | readonly string[] | null | undefined, domains: readonly string[]): ResolvedLink | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string' || first.length === 0 || first.length > 2048) return null;
  let input = first;
  try {
    input = decodeURIComponent(first);
  } catch {
    // bozuk yüzde kodlaması: olduğu gibi dene
  }
  const token = parseLinkToken(input, domains);
  return token ? { token, hash: linkTokenHash(token) } : null;
}

export interface LinkLiveState {
  live: LinkLiveLocation | null;
  loaded: boolean;
  denied: boolean;
  seenLive: boolean;
  /**
   * En az bir anlık görüntü (null bile olsa) okundu: bağlantı o an geçerliydi. İlk okuma reddedilirse
   * (hiç erişim yok) durum `unavailable` ("Bağlantı geçersiz ya da süresi dolmuş"), web ile aynı.
   * Eski çağıranlar için isteğe bağlı: verilmezse core `seenLive || live` sayar.
   */
  hadAccess?: boolean;
}

export const INITIAL_LINK_LIVE: LinkLiveState = { live: null, loaded: false, denied: false, seenLive: false, hadAccess: false };

export interface LinkViewerModel {
  state: LinkViewState;
  /** Başlık: paylaşan kişinin adı ya da durum metni. */
  title: string;
  /** "Canlı · 17:45'e kadar" / "3 dk önce · Süresiz" / durum açıklaması. */
  subtitle: string;
  /** Harita pini gösterilsin mi (bitince / geçersizken pin kalkar). */
  showMarker: boolean;
  freshness: Freshness | null;
}

export function linkViewerModel(tokenValid: boolean, s: LinkLiveState, now: EpochMs): LinkViewerModel {
  const state = linkViewState({
    tokenValid,
    loaded: s.loaded,
    denied: s.denied,
    live: s.live,
    seenLive: s.seenLive,
    hadAccess: s.hadAccess,
    now,
  });
  if (state === 'live' && s.live) {
    const f = freshness(s.live, now);
    const fresh = f === 'stale' ? formatAgo(s.live.timestamp, now) : FRESHNESS_TEXT[f];
    const until = s.live.expires_at === null ? 'Süresiz' : untilClock(s.live.expires_at);
    return { state, title: s.live.sender_name, subtitle: `${fresh} · ${until}`, showMarker: true, freshness: f };
  }
  // Metinler core'dan: web görüntüleyici aynı başlık ve açıklamayı gösterir.
  return { state, title: LINK_VIEW_TEXT[state], subtitle: LINK_VIEW_DETAIL[state], showMarker: false, freshness: null };
}
