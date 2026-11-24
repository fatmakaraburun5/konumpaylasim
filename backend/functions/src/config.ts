/**
 * Sunucu yapılandırması ve ürün sınırları. Süre/limit değerleri [Varsayım] etiketlidir:
 * sahada ölçüm ve ürün onayıyla değişebilir.
 */
import { DAY, HOUR, LINK_DOMAIN_DEFAULT, MINUTE, SECOND, normalizeLinkDomain } from '@konum/core';
import { defineSecret } from 'firebase-functions/params';

/** Functions emülatörü `FUNCTIONS_EMULATOR=true` ortam değişkenini kendisi koyar (keşif aşamasında da). */
export const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';

/**
 * Emülatöre bağlı bir test süreci (vitest işleyicileri doğrudan çağırır): Functions emülatörü değil ama
 * Firestore emülatörü kullanılıyor. Üretimde asla doğru değildir.
 */
export const IS_LOCAL_TEST = !IS_EMULATOR && Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** Avrupa veri yerleşimi (KVKK). [Varsayım: doğrulanmalı] Firestore eur3, RTDB europe-west1. */
export const REGION = 'europe-west1';

/**
 * App Check üretimde zorunlu. Emülatörde otomatik kapalı; staging'de hata ayıklamak için
 * `APP_CHECK_ENFORCE=false` ortam değişkeniyle de kapatılabilir.
 */
export const ENFORCE_APP_CHECK = !IS_EMULATOR && process.env.APP_CHECK_ENFORCE !== 'false';

/** Callable başına en çok örnek sayısı (maliyet tavanı). [Varsayım] */
export const MAX_INSTANCES = 20;

/**
 * Telefon HMAC'i için gizli biber (pepper): Secret Manager `PHONE_HMAC_PEPPER`
 * (`firebase functions:secrets:set PHONE_HMAC_PEPPER`). Emülatörde gizli değer istenmez
 * (Secret Manager'a gidilmesin diye bildirilmez); yerine yalnızca geliştirmeye özel sabit kullanılır.
 */
export const PHONE_PEPPER_SECRET = 'PHONE_HMAC_PEPPER';
export const CALLABLE_SECRETS: string[] = IS_EMULATOR ? [] : [PHONE_PEPPER_SECRET];

export function phonePepper(): string {
  const v = process.env[PHONE_PEPPER_SECRET];
  if (v && v.length >= 16) return v;
  if (IS_EMULATOR || IS_LOCAL_TEST) return 'konum-emulator-only-pepper-not-a-secret';
  throw new Error(`${PHONE_PEPPER_SECRET} tanımlı değil (en az 16 karakter)`);
}

/**
 * Süre dolumu görevi (Cloud Tasks) kuyruğunun fonksiyon adı. Kuyruk kimliği fonksiyon kimliğidir ve Cloud Tasks
 * kuyruk kimliği yalnızca harf, rakam ve tire kabul eder: alt çizgi YOK (callable adlarından farklı olarak).
 */
export const EXPIRY_TASK_FUNCTION = 'shareexpirytask';

export const LIMITS = {
  /** `ops/{uid}_{op_id}` kaydı bu kadar saklanır, sonra TTL ile silinir. [Varsayım] */
  opRecordTtlMs: DAY,
  /** Biten paylaşım (mezar taşı) ve biten istek belgeleri bu süre sonra TTL ile silinir. [Varsayım] */
  endedDocTtlMs: 7 * DAY,
  /** RTDB `share_acl` mezar taşları bu süre sonra silinir (belge TTL'iyle aynı). [Varsayım] */
  aclTombstoneTtlMs: 7 * DAY,
  /** Arkadaşlık isteği / davet kodu araması: kullanıcı başına saatte 20. [Varsayım] */
  friendRequestPerHour: 20,
  /** Giden istek kaydı (`users/{uid}/outgoing_requests`) yaşam süresi. [Varsayım] */
  outgoingRequestTtlMs: 30 * DAY,
  /** Davet kodu yenileme: kullanıcı başına günde 5. [Varsayım] */
  inviteRegeneratePerDay: 5,
  /** Konum isteği: kullanıcı başına günde 30. [Varsayım] */
  locationRequestPerDay: 30,
  /** Aynı çift için iki konum isteği arasında en az 10 dk. [Varsayım] */
  locationRequestCooldownMs: 10 * MINUTE,
  /** Yanıtlanmayan konum isteği 15 dk sonra `expired`. [Varsayım] */
  locationRequestTtlMs: 15 * MINUTE,
  /** Davet kodu çakışmasında yeniden deneme sayısı (31^6 alanda pratikte 1 yeter). */
  inviteCodeAttempts: 5,
  /** Süre dolumu taramasında tek transaction'daki belge sayısı. */
  sweepBatchSize: 100,
  /** Bir tarama çağrısında en çok parti sayısı (1 dk'lık zamanlayıcıya sığsın). [Varsayım] */
  sweepMaxBatches: 20,
  /** `acl_pending` işareti bu kadar eskiyse ayna kaybolmuş sayılır ve yeniden uygulanır. [Varsayım] */
  aclPendingGraceMs: 60 * SECOND,
  /** Tam ACL denetimi (RTDB aktif ACL ↔ Firestore) kaç dakikada bir. [Varsayım] (BACKEND_SPEC §4: 5 dk) */
  aclAuditEveryMinutes: 5,
  /** Tam ACL denetiminde sayfa boyutu ve en çok sayfa (zamanlayıcı süresine sığsın). [Varsayım] */
  aclAuditPageSize: 500,
  aclAuditMaxPages: 40,
  /** Görev erken gelirse en çok bu kadar beklenir; daha erkense tarama yedeği devralır. */
  expiryTaskMaxEarlyWaitMs: 30 * SECOND,
  /** Silinen hesabın `deleted_users` kaydı (hayalet profil engeli) saklama süresi. [Varsayım] ID token ≤ 1 sa. */
  deletedUserTtlMs: 30 * DAY,
  /** Kullanıcı başına en çok FCM token'ı (en yeni N). [Varsayım] */
  maxDeviceTokensPerUser: 10,
  /** FCM `sendEachForMulticast` üst sınırı. */
  fcmMulticastMax: 500,
  /** `last_active_at` yazımı en çok bu sıklıkta (gereksiz yazma olmasın). [Varsayım] */
  lastActiveWriteEveryMs: HOUR,
  /**
   * Geri dönüştürülmüş numara savunması (BACKEND_SPEC risk #3). [Varsayım: ürün onayı gerekli]
   *  - 30 gün uygulamayı açmayan alıcıya gelen paylaşımlar biter.
   *  - 180 gün pasif hesapta sosyal grafik sıfırlanır.
   *  - Sıfırlamadan önce: hesabın cihazı 30 gün içinde konum yayınladıysa (aktif giden paylaşım) hesap pasif sayılmaz.
   */
  inactiveIncomingCutMs: 30 * DAY,
  inactiveGraphResetMs: 180 * DAY,
  recentPublishMs: 30 * DAY,
  inactiveSweepBatch: 200,
  /** Faz 2: bağlantı (QR) oluşturma, kullanıcı başına saatte 20. [Varsayım] Aynı anda aktif sınırı core `LINK_LIMITS`. */
  linkCreatePerHour: 20,

  // --- Faz 3 ---
  /** `battery_low_notify` çağrısı: kullanıcı başına saatte 30 (bildirim + yeniden kurma raporları). [Varsayım] */
  batteryCallsPerHour: 30,
  /** Aynı oturumda 24 saatte en çok bu kadar düşük pil bildirimi (tak-çıkar / kötü niyetli istemci tavanı). [Varsayım] */
  batteryAlertsPerSessionPerDay: 6,
  /** `battery_alerts` durum belgesi son yazmadan bu kadar sonra TTL ile silinir. [Varsayım] */
  batteryAlertTtlMs: 30 * DAY,
  /**
   * Duraksama bekçisi (stall watchdog). Uzun paylaşım = haftalık, süresiz ya da 8 saatten uzun süren (core
   * `LONG_SHARE_MIN_MS`). Son paketin `server_ts` değeri `max(stallHbFactor · hb, stallMinMs)` kadar eskiyse
   * paylaşım duraksamış sayılır. hb yoksa core `DEFAULT_RECEIVER_HB_MS` (10 dk). [Varsayım]
   */
  stallHbFactor: 4,
  stallMinMs: 45 * MINUTE,
  /** Sessiz uyandırmadan sonra görünür bildirim için en az bekleme (ikinci kaçırma). [Varsayım] */
  stallVisibleAfterMs: 30 * MINUTE,
  /** Görünür bildirimden sonra aynı duraksama döneminde tekrar en erken. [Varsayım] */
  stallRepeatMs: 6 * HOUR,
  /** Bir duraksama döneminde en çok dürtme (sessiz + görünür toplamı). [Varsayım] */
  stallMaxNudgesPerEpisode: 4,
  /** Bekçi sayfa boyutu ve en çok sayfa (zamanlayıcı süresine sığsın). [Varsayım] */
  stallPageSize: 300,
  stallMaxPages: 20,
  /** live_trail noktaları bu kadar eskiyince bekçi tarafından budanır (core OUTBOX_LIMITS.maxAgeMs ile aynı). */
  trailMaxAgeMs: DAY,

  // --- Faz 4 ---
  /** Süresi geçen ping / yer notu / SOS taramasında tek çağrıdaki en çok kayıt. [Varsayım] */
  f4SweepMax: 500,
  /**
   * Biten (çözülen) SOS belgesi bu kadar sonra TTL ile silinir (paylaşım belgeleriyle aynı). Aktif SOS'un `purge_at`
   * değeri `activeMaxMs + endedDocTtlMs` sonrasıdır: süpürücü önce `timeout` ile kapatır, TTL aktif belgeyi silmez.
   */
  sosEndedTtlMs: 7 * DAY,
  /** Süresi geçen yer notu belgesinin TTL payı (süpürücü zaten siler; TTL yedek). [Varsayım] */
  placeNoteTtlGraceMs: 7 * DAY,
} as const;

/**
 * Faz 4: iOS Critical Alerts (sessiz modu / Odak'ı aşan SOS bildirimi). Apple'ın `com.apple.developer.usernotifications
 * .critical-alerts` yetkisini onaylaması gerekir; onaylanmadan `critical` gönderilirse iOS bildirimi normal bildirim
 * gibi gösterir ama yetkisiz kullanım App Review riski taşır. [Varsayım: Apple onayı bekleniyor] Varsayılan KAPALI:
 * ortam değişkeni `SOS_CRITICAL_ALERTS=1` (ya da `true`) ile açılır; kapalıyken `interruption-level: time-sensitive`.
 * Mobil tarafta da aynı anda `IOS_CRITICAL_ALERTS=1` ile yetki eklenmelidir.
 */
export const SOS_CRITICAL_ALERTS = /^(1|true)$/i.test(process.env.SOS_CRITICAL_ALERTS ?? '');

/** Konum isteği kabulünde süre verilmezse: 1 saat. */
export const DEFAULT_REQUEST_DURATION = { kind: 'preset', preset: 'h1' } as const;

/** İstemci saat dilimi göndermezse "gün sonu" için. [Varsayım] Türkiye UTC+3, yaz saati yok. */
export const DEFAULT_TIME_ZONE = 'Europe/Istanbul';

/** Profil adı verilmezse. [Varsayım] */
export const DEFAULT_DISPLAY_NAME = 'Yeni kullanıcı';

export const RATE_WINDOWS = { hour: HOUR, day: DAY } as const;

/** Proje kimliği (FIREBASE_CONFIG ya da GCLOUD_PROJECT). */
export function projectId(): string {
  try {
    const cfg = JSON.parse(process.env.FIREBASE_CONFIG ?? '{}') as { projectId?: string };
    if (cfg.projectId) return cfg.projectId;
  } catch {
    /* yok say */
  }
  return process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
}

/**
 * Avatarların bulunabileceği Storage kovaları: FIREBASE_CONFIG.storageBucket ve projenin varsayılan kova adları.
 * [Varsayım: doğrulanmalı] Yeni projelerde `<proje>.firebasestorage.app`, eskilerde `<proje>.appspot.com`.
 */
export function avatarBuckets(): string[] {
  const out = new Set<string>();
  try {
    const cfg = JSON.parse(process.env.FIREBASE_CONFIG ?? '{}') as { storageBucket?: string };
    if (cfg.storageBucket) out.add(cfg.storageBucket);
  } catch {
    /* yok say */
  }
  const p = projectId();
  if (p) {
    out.add(`${p}.firebasestorage.app`);
    out.add(`${p}.appspot.com`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Faz 2: bağlantı (QR) paylaşımı
// ---------------------------------------------------------------------------

/**
 * QR / paylaşım bağlantısının alan adı (`https://<alan>/s/<token>`). Ortam değişkeni `LINK_DOMAIN`
 * (ör. `konum.app`); yoksa core `LINK_DOMAIN_DEFAULT`. [Varsayım] Gerçek alan adı alınınca
 * `functions/.env.<proje>` dosyasına yazılır; AASA / assetlinks aynı alanda yayınlanmalıdır (hosting/).
 */
export function linkDomain(): string {
  const raw = process.env.LINK_DOMAIN;
  const d = raw ? normalizeLinkDomain(raw) : null;
  return d ?? LINK_DOMAIN_DEFAULT;
}

// ---------------------------------------------------------------------------
// Faz 2: Google Maps sunucu vekili (Routes API + Geocoding API)
// ---------------------------------------------------------------------------

/**
 * Sunucu anahtarı: Secret Manager `GOOGLE_MAPS_SERVER_KEY`
 * (`firebase functions:secrets:set GOOGLE_MAPS_SERVER_KEY`). Anahtar GCP'de YALNIZCA Routes API ve
 * Geocoding API'ye kısıtlanmalıdır; istemciye asla inmez. Haritayı kapatmak için değer `disabled`
 * yapılabilir (dağıtım secret'ın var olmasını ister). Emülatörde secret bildirilmez (Secret Manager'a
 * gidilmesin); `GOOGLE_MAPS_SERVER_KEY` ortam değişkeni yoksa callable'lar `maps_unavailable` döner.
 */
export const MAPS_KEY_SECRET_NAME = 'GOOGLE_MAPS_SERVER_KEY';
export const MAPS_KEY_SECRET = defineSecret(MAPS_KEY_SECRET_NAME);
export const MAPS_CALLABLE_SECRETS = IS_EMULATOR ? [] : [MAPS_KEY_SECRET];

/** Anahtar yoksa ya da yer tutucuysa null (→ `maps_unavailable`). */
export function mapsServerKey(): string | null {
  const v = (process.env[MAPS_KEY_SECRET_NAME] ?? '').trim();
  if (v.length < 20 || /^(disabled|none|off|placeholder)$/i.test(v)) return null;
  return v;
}

export const MAPS = {
  /**
   * DRIVE için `routingPreference`. Varsayılan `TRAFFIC_UNAWARE`: Compute Routes **Essentials** SKU'sunda kalır.
   * `TRAFFIC_AWARE` canlı trafik verir ama Pro SKU'dur (yaklaşık iki kat). [Varsayım: Google güncel fiyat listesi]
   * Ortam değişkeni `ROUTES_DRIVE_PREFERENCE=TRAFFIC_AWARE` ile açılır. (core `ROUTE_POLICY.drivePreference`
   * varsayılanı da `TRAFFIC_UNAWARE`; sunucu bu değeri `routesRequestBody` 4. parametresiyle verir.)
   */
  drivePreference: (process.env.ROUTES_DRIVE_PREFERENCE === 'TRAFFIC_AWARE' ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE') as
    | 'TRAFFIC_AWARE'
    | 'TRAFFIC_UNAWARE',
  /** Google isteği zaman aşımı. [Varsayım] */
  fetchTimeoutMs: 5 * SECOND,
  /**
   * Proje geneli günlük bütçe (Google çağrısı; önbellek isabeti sayılmaz). [Varsayım] route 5000 ve geocode 5000
   * çağrı/gün; tutarı Google'ın güncel SKU fiyat listesi ve ücretsiz kullanım payıyla hesaplanmalı (burada fiyat
   * varsayılmaz). Ortam değişkeni `MAPS_DAILY_BUDGET`
   * (`5000` ya da `route=5000,geocode=3000`) ve Firestore `config/maps` belgesi
   * (`{disabled, route_daily_budget, geocode_daily_budget}`, yeniden dağıtım gerektirmez) ile değişir.
   * 0 ya da `disabled: true` = kapalı (kill switch) → `quota_exceeded`.
   */
  defaultDailyBudget: { route: 5_000, geocode: 5_000 },
  /**
   * Proje geneli sayaç parçası sayısı: tek belgeye saniyede ~1 yazma sınırına takılmamak için. Her parçanın
   * sınırı floor(bütçe / parça): toplam bütçeyi asla aşmaz (en çok parça sayısı kadar eksik kalır).
   */
  budgetShards: 10,
  /** `config/maps` belgesinin örnek içi önbelleği. */
  configCacheMs: MINUTE,
  /** Kota sayaç belgeleri bu kadar sonra TTL ile silinir. */
  quotaDocTtlMs: 2 * DAY,
  /** Ters geocode `result_type` süzgeci (yalnızca kısa adres türleri). [Varsayım] */
  geocodeResultTypes: 'street_address|route|neighborhood|sublocality|administrative_area_level_4|locality',
  /** Yanıt sözleşmesi sınırları (core şemaları). */
  maxPolylineLength: 100_000,
  maxLabelLength: 300,
} as const;
