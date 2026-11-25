/**
 * Alan modelleri (Firestore belge şekilleri). Firestore = durumun tek doğru kaynağı.
 * İstemci bu koleksiyonlara YAZMAZ; tüm geçişler Cloud Functions callable'ları ile yapılır.
 *
 *   users/{user_id}                       kendi profili (yalnızca sahibi okur)
 *   users_private/{user_id}               telefon numarası (yalnızca sunucu)
 *   phone_index/{phone_e164}              telefon → user_id (yalnızca sunucu)
 *   invite_codes/{code}                   davet kodu → user_id (yalnızca sunucu)
 *   friendships/{min_uid}_{max_uid}       arkadaşlık (iki üye okur)
 *   blocks/{blocker_id}_{blocked_id}      engelleme (yalnızca engelleyen okur)
 *   location_shares/{sender_id}_{receiver_id}   yönlü paylaşım (iki taraf okur)
 *   location_requests/{requester_id}_{target_id} konum isteği (iki taraf okur)
 *   devices/{user_id}/tokens/{token_id}   FCM token'ları (sahibi yazar)
 *   link_shares/{link_id}                 Faz 2: bağlantı (QR) paylaşımı (yalnızca gönderen okur)
 *   widget_tokens/{sha256(token)}         Faz 6: widget hızlı paylaşım token'ı (yalnızca sunucu)
 *
 * Canlı konum Realtime Database'dedir, bkz. `packet.ts`, `link.ts` ve `contracts.ts`.
 */
import type { EpochMs } from './time';
import type { ShareMode } from './duration';
import type { Gender } from './profile';

export type UserId = string;
export type ShareId = string;
export type SessionId = string;
export type RequestId = string;
export type FriendshipId = string;

export interface UserProfile {
  user_id: UserId;
  display_name: string;
  avatar_url: string | null;
  invite_code: string;
  created_at: EpochMs;
  /** Faz 1'de 0; büyüdükçe RTDB parçalama (sharding) için. */
  rtdb_instance: number;
  // --- Faz 6 ---
  /** Kayıtta zorunlu; `null` YALNIZCA Faz 6 öncesi (eski) hesaplarda. Çerçeve rengi: `genderRingColor`. */
  gender: Gender | null;
  /** 160 px küçük boy (`avatars/{uid}/{version}_160.jpg`); pin / liste / widget bunu kullanır. */
  avatar_thumb_url: string | null;
  /** Son yüklenen fotoğrafın sürümü (yükleme anı epoch ms); önbellek anahtarı (`recyclingKey`). */
  avatar_version: number | null;
  /** Sıralı favoriler (en çok `FAVORITES_LIMIT`); ilk = tek tuşla paylaşım hedefi. Yalnızca sahibi okur. */
  favorite_ids: UserId[];
}

/**
 * Arkadaşlara gösterilen profil kopyası (friendships.member_profiles içinde). Faz 6 alanları profil yayılımıyla
 * (backend `user.ts`) kabul edilmiş arkadaşlıklara yazılır; bekleyen istek profili yalnızca ad taşır (`gender: null`,
 * fotoğraf yok).
 */
export interface PublicProfile {
  display_name: string;
  avatar_url: string | null;
  // --- Faz 6 ---
  gender: Gender | null;
  avatar_thumb_url: string | null;
}

export type FriendshipStatus = 'pending' | 'accepted';

export interface Friendship {
  id: FriendshipId;
  /** Sıralı: [küçük uid, büyük uid]. Firestore `array-contains` sorgusu için. */
  member_ids: [UserId, UserId];
  status: FriendshipStatus;
  requested_by: UserId;
  /** İstek davet koduyla mı telefonla mı geldi (analitik değil, kötüye kullanım takibi için). */
  via: 'invite_code' | 'phone' | 'qr';
  member_profiles: Record<UserId, PublicProfile>;
  created_at: EpochMs;
  updated_at: EpochMs;
}

export type ShareStatus = 'active' | 'ended';

export type ShareEndReason =
  | 'stopped_by_sender'
  | 'revoked_by_receiver'
  | 'expired'
  | 'friendship_removed'
  | 'blocked'
  | 'account_deleted';

/** Kime paylaşıldığı. Faz 1: yalnızca 'friend'. Faz 2: 'link' (QR/token), ayrı koleksiyonda. */
export type ShareAudience = 'friend' | 'link';

/**
 * Yönlü konum paylaşımı: sender → receiver. Arkadaşlık paylaşım DEMEK DEĞİLDİR;
 * paylaşım ise kabul edilmiş, engelsiz bir arkadaşlık GEREKTİRİR.
 */
export interface LocationShare {
  share_id: ShareId;
  /** Aynı anda başlatılan alıcıları gruplar ("hepsini uzat / durdur"). */
  session_id: SessionId;
  audience: 'friend';
  sender_id: UserId;
  receiver_id: UserId;
  status: ShareStatus;
  share_mode: ShareMode;
  started_at: EpochMs;
  /** null = süresiz. */
  expires_at: EpochMs | null;
  ended_at: EpochMs | null;
  end_reason: ShareEndReason | null;
  /** Her değişiklikte +1; RTDB `share_acl` aynası eski yazmaları bununla reddeder. */
  version: number;
  extended_count: number;
  in_response_to: RequestId | null;
}

export type LocationRequestStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';

export interface LocationRequest {
  request_id: RequestId;
  requester_id: UserId;
  target_id: UserId;
  status: LocationRequestStatus;
  created_at: EpochMs;
  expires_at: EpochMs;
  responded_at: EpochMs | null;
  /** Kabulde oluşan paylaşım (target → requester). */
  share_id: ShareId | null;
}

/** Realtime Database'deki yetki aynası: `share_acl/{share_id}`. İstemciye kapalı. */
export interface ShareAcl {
  sender_id: UserId;
  receiver_id: UserId;
  status: ShareStatus;
  expires_at: EpochMs | null;
  version: number;
  /**
   * Faz 3 (isteğe bağlı; Faz 3 öncesi aynalarda yok): paylaşım başlangıcı. RTDB kuralları kuyruktan gelen
   * (`q: 1`) ve `live_trail` noktalarının bundan eski olmasını reddeder.
   */
  started_at?: EpochMs;
}

// ---------------------------------------------------------------------------
// Faz 2: bağlantı (QR) ile paylaşım. Token üretimi ve URL: `link.ts`.
// ---------------------------------------------------------------------------

export type LinkId = string;

/** Bağlantı paylaşımı bitiş nedenleri: `ShareEndReason`'ın alt kümesi, anlamları aynı. */
export type LinkEndReason = Extract<ShareEndReason, 'stopped_by_sender' | 'expired' | 'account_deleted'>;

/**
 * `link_shares/{link_id}`: QR / bağlantı ile paylaşım. Alıcı kimliği YOKTUR (token'ı bilen görür).
 * Düz token sunucuda SAKLANMAZ; yalnızca `token_hash` = sha256Hex(token). Token yalnızca
 * `link_share_create` yanıtında bir kez döner, gönderenin cihazında güvenli depoda tutulur.
 * Okuma: yalnızca gönderen. Yazma: yalnızca callable.
 */
export interface LinkShare {
  link_id: LinkId;
  /** Paylaşımı gruplayan oturum. [Varsayım] Faz 2'de her bağlantı kendi oturumudur. */
  session_id: SessionId;
  audience: 'link';
  sender_id: UserId;
  /** SHA-256 hex (64 karakter). RTDB `link_acl/{token_hash}` ve `link_live/{token_hash}` anahtarı. */
  token_hash: string;
  status: ShareStatus;
  share_mode: ShareMode;
  started_at: EpochMs;
  /** null = süresiz. */
  expires_at: EpochMs | null;
  ended_at: EpochMs | null;
  end_reason: LinkEndReason | null;
  /** Her değişiklikte +1; `link_acl` aynası eski yazmaları bununla reddeder. */
  version: number;
  extended_count: number;
}

/** @deprecated Faz 1'deki kanca adı. `LinkShare` kullanın (aynı tip, alanlar yalnızca eklendi). */
export type LinkSharePhase2 = LinkShare;

/**
 * RTDB `link_acl/{token_hash}`: bağlantı yetki aynası. İstemciye TAMAMEN kapalı.
 * `link_live` okuma/yazma kuralları buna bakar. Bitişte silinmez, mezar taşı olur (`status: 'ended'`).
 * RTDB null saklamaz: süresiz paylaşımda `expires_at` alanı YOKTUR (null değil).
 * Sunucunun yazdığı biçim (backend `linkAclValue`):
 *  - aktif: `{status:'active', sender_id, link_id, share_mode, expires_at?, version, started_at?}` (Faz 3: started_at)
 *  - mezar taşı: `{status:'ended', version, ended_at, end_reason?}` (gönderen ve bağlantı kimliği kalmaz)
 */
export interface LinkAclActive {
  status: 'active';
  /** Yazma kuralı: yalnızca bu kullanıcı `link_live/{hash}` yazar. */
  sender_id: UserId;
  /** Denetim için özet → belge eşlemesi (bakım işi). */
  link_id: LinkId;
  /** Paket bağlama: `link_live.share_mode` bununla aynı olmalı. */
  share_mode: ShareMode;
  /** Yoksa süresiz. Okuma kuralı `expires_at > now` ister. */
  expires_at?: EpochMs;
  version: number;
  /** Faz 3 (isteğe bağlı): paylaşım başlangıcı; `q: 1` noktası bundan eski olamaz. */
  started_at?: EpochMs;
}

export interface LinkAclTombstone {
  status: 'ended';
  version: number;
  ended_at: EpochMs;
  end_reason?: LinkEndReason;
}

export type LinkAcl = LinkAclActive | LinkAclTombstone;

/**
 * RTDB `link_live/{token_hash}`: token sahibinin görebileceği TEK veri. Gönderen yazar.
 *
 * Gizlilik (bilerek DIŞARIDA bırakılanlar, `DeliveredLocation` ile farkı):
 *  - `sender_id`: kalıcı kullanıcı kimliği; farklı bağlantıları aynı kişiye bağlamaya ve
 *    hesabı hedeflemeye yarar. Anonim izleyici yalnızca görünen adı görür.
 *  - `share_id`, `link_id`, `session_id`, `receiver_ids`: paylaşımın kime/kaç kişiye açık olduğu.
 *  - telefon numarası ve `avatar_url` (URL kalıcı tanımlayıcı ve izleme pikseli olabilir). [Varsayım]
 *  - `is_charging`, `activity_state`, `mocked`: haritada konum için gereksiz kişisel ayrıntı.
 *  - `battery_pct` bilinmiyorsa yoktur. [Varsayım] Ürün kararıyla gönderen ayarına bağlanabilir.
 * RTDB kuralları yalnızca `LINK_LIVE_FIELDS` alanlarına izin verir.
 */
export interface LinkLiveLocation {
  v: number;
  lat: number;
  lng: number;
  /** Yatay doğruluk yarıçapı, metre. */
  accuracy: number;
  heading: number | null;
  speed_mps: number | null;
  /** 0..100; null = bilinmiyor. */
  battery_pct: number | null;
  /** Örneğin alındığı an (sunucu saatine çevrilmiş). */
  timestamp: EpochMs;
  /** Sunucunun yazmayı kabul ettiği an. */
  server_ts: EpochMs;
  /** Yalnızca görünen ad, en çok 40 karakter. Telefon numarası ASLA. */
  sender_name: string;
  expires_at: EpochMs | null;
  share_mode: ShareMode;
  /** Faz 3: beklenen en uzun paket aralığı (ms); bkz. `DeliveredLocation.hb`. */
  hb?: number;
  /**
   * Faz 3: 1 = son nokta çevrimdışı kuyruktan geldi (`timestamp` eski olabilir). Gizlilik: bağlantılara iz
   * (trail) YAZILMAZ; QR sahibi yalnızca en son noktayı görür.
   */
  q?: 1;
}
