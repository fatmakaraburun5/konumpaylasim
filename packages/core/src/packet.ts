/**
 * Standart canlı konum paketi: iOS ve Android aynı JSON'u üretir.
 *
 *  - `LocationPacket`  : mantıksal paket (kullanıcının tanımladığı alanlar). `receiver_ids[]` bu
 *                        paketi alacak alıcılardır ve aynı süre/mod'u paylaşırlar.
 *  - `DeliveredLocation`: RTDB `live_locations/{receiver_id}/{share_id}` altına yazılan alıcı kopyası.
 *                        `receiver_ids` YOKTUR: bir alıcı, aynı kişinin konumunu başka kimin gördüğünü öğrenemez.
 *
 * RTDB null saklamaz: null alanlar yazılırken atlanır, okunurken null'a çevrilir.
 */
import { z } from 'zod';
import { SHARE_MODES, type ShareMode } from './duration';
import { roundCoord } from './geo';
import { shareId as makeShareId } from './ids';
import type { ShareId, UserId } from './model';
import { MINUTE, SECOND, type EpochMs } from './time';
import { PROOF_ID_RE } from './proof';

export const LIVE_PACKET_VERSION = 1 as const;

/** Faz 9: paylaşım hedefinin durumu (bkz. `approach.ts`). Döngüsel içe aktarma olmasın diye burada tanımlı. */
export const DEST_STATES = ['en_route', 'near', 'arrived'] as const;
export type DestState = (typeof DEST_STATES)[number];

export type ActivityState = 'still' | 'walking' | 'running' | 'cycling' | 'automotive' | 'unknown';
export const ACTIVITY_STATES: readonly ActivityState[] = ['still', 'walking', 'running', 'cycling', 'automotive', 'unknown'];

export interface LocationPacket {
  v: typeof LIVE_PACKET_VERSION;
  sender_id: UserId;
  receiver_ids: UserId[];
  lat: number;
  lng: number;
  /** Yatay doğruluk yarıçapı, metre (%68 güven). */
  accuracy: number;
  speed_mps: number | null;
  /** Gerçek kuzeye göre 0 ≤ heading < 360 derece. */
  heading: number | null;
  battery_pct: number | null;
  is_charging: boolean | null;
  activity_state: ActivityState;
  /** Örneğin alındığı an, SUNUCU saatine çevrilmiş epoch ms. */
  timestamp: EpochMs;
  expires_at: EpochMs | null;
  share_mode: ShareMode;
  // --- Faz 3: isteğe bağlı alanlar (eski istemciler yok sayar; yoksa davranış Faz 1/2 ile aynı) ---
  /**
   * Gönderenin O ANKİ takip modunda iki paket arasındaki beklenen EN UZUN aralık (ms), yani kalp atışı.
   * Alıcı "gecikti / bağlantı kopmuş olabilir" kararını sabit eşikle değil buna göre verir (`receiverStatus`).
   */
  hb?: number;
  /** 1 = nokta çevrimdışı kuyruktan (outbox) gönderildi; `timestamp` 2 dakikadan eski olabilir (en çok 24 sa). */
  q?: 1;
  /**
   * Ölçümün CİHAZ saatine göre ham anı (epoch ms). `timestamp` anlamını korur (ölçüm anı, sunucu saatine
   * çevrilmiş). Kuyruktan gelen noktalarda bulunur; uzun kesintide saat farkı tahmininin kaymasını izlemeye yarar.
   */
  recorded_at?: EpochMs;
  // --- Faz 4: isteğe bağlı durum notu (konumu görenler görür; paylaşım bitince paketle birlikte silinir) ---
  /** Kısa durum notu, en çok `NOTE_LIMITS.maxChars` karakter (örn. "☕ Kahve molasındayım"). */
  note?: string;
  /** Notun bitiş anı (sunucu saati, epoch ms). Alıcı bu andan sonra notu göstermez. */
  note_exp?: EpochMs;
  // --- Faz 9: isteğe bağlı (eski istemciler yok sayar) ---
  /** Anlık fotoğraf kimliği (`PROOF_ID_RE`); bayt `proof_get` ile, yalnızca sunucu izin verirse gelir. */
  photo_id?: string;
  /** Fotoğrafın bitişi (sunucu saati). `photo_id` ile birlikte; en çok 1 saat ileride. */
  photo_exp?: EpochMs;
  /** Paylaşımın hedef ADI ("Ev"); koordinat YOK. ≤ 30 karakter. */
  dest_name?: string;
  /** Hedef durumu: `en_route` | `near` (≤ 200 m, "Neredeyse vardım") | `arrived`. `dest_name` ile birlikte. */
  dest_state?: DestState;
  /** Tahmini varış (dk), yalnızca `near`. */
  dest_eta?: number;
}

/** Faz 3 isteğe bağlı paket alanları (kuyruk / kalp atışı). */
export interface PacketExtras {
  hb?: number;
  q?: 1;
  recorded_at?: EpochMs;
  /** Faz 4: durum notu ve bitişi (ikisi birlikte; süresi geçmiş not pakete girmez). */
  note?: string;
  note_exp?: EpochMs;
  /** Faz 9: anlık fotoğraf (ikisi birlikte). */
  photo_id?: string;
  photo_exp?: EpochMs;
  /** Faz 9: hedef adı + durumu (+ yalnızca near iken varış dakikası). */
  dest_name?: string;
  dest_state?: DestState;
  dest_eta?: number;
}

export interface DeliveredLocation extends Omit<LocationPacket, 'receiver_ids'> {
  share_id: ShareId;
  /** Sunucunun yazmayı kabul ettiği an (ServerValue.TIMESTAMP). */
  server_ts: EpochMs;
}

/** RTDB ServerValue.TIMESTAMP yer tutucusu (RNFB `firebase.database.ServerValue.TIMESTAMP` ile aynı). */
export const SERVER_TIMESTAMP = { '.sv': 'timestamp' } as const;
export type ServerTimestamp = typeof SERVER_TIMESTAMP;

/** RTDB'ye giden alıcı kopyası: null alanlar yok, server_ts yer tutucu. */
export type DeliveredLocationWrite = {
  [K in keyof DeliveredLocation]?: K extends 'server_ts' ? ServerTimestamp : Exclude<DeliveredLocation[K], null>;
};

/** RTDB kuralları bu listeyle birebir aynı alanlara izin verir (backend testleri karşılaştırır). */
export const DELIVERED_FIELDS = [
  'v',
  'share_id',
  'sender_id',
  'lat',
  'lng',
  'accuracy',
  'speed_mps',
  'heading',
  'battery_pct',
  'is_charging',
  'activity_state',
  'timestamp',
  'expires_at',
  'share_mode',
  'server_ts',
  // Faz 3 (isteğe bağlı)
  'hb',
  'q',
  'recorded_at',
  // Faz 4 (isteğe bağlı)
  'note',
  'note_exp',
  // Faz 9 (isteğe bağlı)
  'photo_id',
  'photo_exp',
  'dest_name',
  'dest_state',
  'dest_eta',
] as const satisfies readonly (keyof DeliveredLocation)[];

/** Faz 3'te eklenen, isteğe bağlı canlı paket alanları. */
export const DELIVERED_OPTIONAL_F3_FIELDS = ['hb', 'q', 'recorded_at'] as const satisfies readonly (keyof DeliveredLocation)[];

/** Faz 4'te eklenen, isteğe bağlı canlı paket alanları (durum notu). */
export const DELIVERED_OPTIONAL_F4_FIELDS = ['note', 'note_exp'] as const satisfies readonly (keyof DeliveredLocation)[];

/** Faz 9'da eklenen, isteğe bağlı canlı paket alanları (anlık fotoğraf, hedef durumu). QR bağlantısına GİTMEZ. */
export const DELIVERED_OPTIONAL_F9_FIELDS = ['photo_id', 'photo_exp', 'dest_name', 'dest_state', 'dest_eta'] as const satisfies readonly (keyof DeliveredLocation)[];

/** Faz 9: paket kuralı sınırları (RTDB kuralı aynısını uygular). */
export const PACKET_F9_LIMITS = {
  destNameMaxChars: 30,
  /** `photo_exp` en çok `now + bu` (1 sa ömür + saat payı). */
  photoExpMaxAheadMs: 61 * MINUTE,
  destEtaMax: 120,
} as const;

/** Faz 4: paketteki durum notu sınırı (RTDB kuralı da `note.length <= 60` uygular). */
export const PACKET_NOTE_MAX_CHARS = 60;

export const PACKET_LIMITS = {
  /** Bundan eski örnek canlı olarak yayınlanmaz (RTDB kuralı da reddeder). */
  maxSampleAgeMs: 2 * MINUTE,
  /** Cihaz saati ileri olsa bile kabul edilen pay. */
  maxFutureSkewMs: 60 * SECOND,
  /** Bundan kötü doğruluklu örnek atılır. [Varsayım] */
  maxAccuracyM: 1_000,
  maxSpeedMps: 120,
  maxReceiversPerPacket: 50,
  /** Faz 3: kuyruktan (`q: 1`) gelen noktanın en fazla yaşı. RTDB kuralı da bu pencereyi uygular. */
  maxQueuedSampleAgeMs: 24 * 60 * MINUTE,
  /** Faz 3: `hb` alanı aralığı (ms). */
  minHeartbeatMs: 10 * SECOND,
  maxHeartbeatMs: 6 * 60 * MINUTE,
  /**
   * Faz 3: `recorded_at` (cihaz saati) sunucu saatinden en fazla bu kadar ileride olabilir (RTDB kuralı `now + 1 sa`).
   * İstemci `safeRecordedAt` ile 5 dk pay bırakır. [Varsayım] 1 sa sapma payı.
   */
  maxRecordedAheadMs: 60 * MINUTE,
  /** Faz 3: `recorded_at` alt sınırı (2017-07-14; RTDB kuralıyla aynı). Bozuk cihaz saati (1970) reddedilir. */
  minRecordedAtMs: 1_500_000_000_000,
} as const;

/**
 * Faz 3: kuyruğa yazılacak `recorded_at`. Cihaz saati kural penceresinin dışındaysa (sunucudan ≥ 55 dk ileri ya da
 * 2017'den önce) sunucu saatine göre ölçüm anı (`fixServerTs` = paketin `timestamp`'i) kullanılır; aksi hâlde tüm
 * çok yollu kuyruk yazması reddedilirdi. `recorded_at` yalnızca teşhis/gösterim içindir, sıralama `timestamp` ile yapılır.
 */
export function safeRecordedAt(deviceTs: EpochMs, fixServerTs: EpochMs): EpochMs {
  if (!Number.isFinite(deviceTs)) return Math.round(fixServerTs);
  const maxAhead = PACKET_LIMITS.maxRecordedAheadMs - 5 * MINUTE;
  if (deviceTs < PACKET_LIMITS.minRecordedAtMs || deviceTs > fixServerTs + maxAhead) return Math.round(fixServerTs);
  return Math.round(deviceTs);
}

// ---------------------------------------------------------------------------
// Ham örnek → normalize örnek
// ---------------------------------------------------------------------------

/** expo-location / CoreLocation / FusedLocation çıktısının ortak alt kümesi. */
export interface RawLocationSample {
  latitude: number;
  longitude: number;
  /** iOS horizontalAccuracy, Android getAccuracy(). Negatif = geçersiz. */
  accuracy: number | null | undefined;
  /** iOS: geçersizse -1. Android: hasSpeed() yoksa 0 gelebilir. */
  speed: number | null | undefined;
  /** iOS course: geçersizse -1. */
  heading: number | null | undefined;
  /** Cihaz saatiyle epoch ms. */
  timestamp: number;
  /** Android isMock / iOS sourceInformation.isSimulatedBySoftware. */
  mocked?: boolean | null;
}

export interface DeviceStatus {
  /** expo-battery getBatteryLevelAsync(): 0..1, bilinmiyorsa -1. */
  batteryLevel: number | null;
  isCharging: boolean | null;
}

export interface NormalizedSample {
  lat: number;
  lng: number;
  accuracy: number;
  speed_mps: number | null;
  heading: number | null;
  /** Sunucu saatine çevrilmiş an. */
  timestamp: EpochMs;
  mocked: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type SampleRejectReason = 'bad_coordinates' | 'bad_accuracy' | 'too_old' | 'in_future';

export function normalizeSample(
  raw: RawLocationSample,
  opts: { serverOffsetMs: number; now: EpochMs },
): { ok: true; sample: NormalizedSample } | { ok: false; reason: SampleRejectReason } {
  const { latitude, longitude } = raw;
  if (!finite(latitude) || !finite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return { ok: false, reason: 'bad_coordinates' };
  }
  if (latitude === 0 && longitude === 0) return { ok: false, reason: 'bad_coordinates' };
  if (!finite(raw.accuracy) || raw.accuracy < 0 || raw.accuracy > PACKET_LIMITS.maxAccuracyM) {
    return { ok: false, reason: 'bad_accuracy' };
  }
  const ts = raw.timestamp + opts.serverOffsetMs;
  if (opts.now - ts > PACKET_LIMITS.maxSampleAgeMs) return { ok: false, reason: 'too_old' };
  if (ts - opts.now > PACKET_LIMITS.maxFutureSkewMs) return { ok: false, reason: 'in_future' };

  const speed =
    finite(raw.speed) && raw.speed >= 0 && raw.speed <= PACKET_LIMITS.maxSpeedMps ? round(raw.speed, 2) : null;
  const heading = finite(raw.heading) && raw.heading >= 0 ? round(raw.heading % 360, 1) : null;

  return {
    ok: true,
    sample: {
      lat: roundCoord(latitude),
      lng: roundCoord(longitude),
      accuracy: round(raw.accuracy, 1),
      speed_mps: speed,
      heading: heading === 360 ? 0 : heading,
      timestamp: Math.round(ts),
      mocked: raw.mocked === true,
    },
  };
}

export function batteryPct(level: number | null): number | null {
  if (!finite(level) || level < 0 || level > 1) return null;
  return Math.round(level * 100);
}

/**
 * Faz 1 sezgisi: aktivite hızdan çıkarılır. Faz 3'te hareket sensörü (CMMotionActivity /
 * Activity Recognition) bu fonksiyonun yerini alır. Eşikler m/s. [Varsayım]
 */
export function inferActivityFromSpeed(speedMps: number | null): ActivityState {
  if (speedMps === null) return 'unknown';
  if (speedMps < 0.6) return 'still';
  if (speedMps < 2.2) return 'walking';
  if (speedMps < 4.5) return 'running';
  if (speedMps < 8.5) return 'cycling';
  return 'automotive';
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

// ---------------------------------------------------------------------------
// Paket üretimi ve RTDB çok yollu yazma (fan-out)
// ---------------------------------------------------------------------------

/** Gönderenin şu an yazmaya yetkili olduğu (sunucunun onayladığı) bir paylaşım. */
export interface PublishTarget {
  share_id: ShareId;
  receiver_id: UserId;
  share_mode: ShareMode;
  expires_at: EpochMs | null;
}

/**
 * Aynı `share_mode` + `expires_at` değerine sahip alıcılar tek pakette toplanır.
 * Süresi dolmuş hedefler ATLANIR (kural da reddederdi; tüm çok yollu yazma düşmesin diye).
 */
export function buildPackets(
  sample: NormalizedSample,
  device: DeviceStatus,
  senderId: UserId,
  targets: readonly PublishTarget[],
  now: EpochMs,
  activity: ActivityState = inferActivityFromSpeed(sample.speed_mps),
  extras: PacketExtras = {},
): LocationPacket[] {
  const groups = new Map<string, PublishTarget[]>();
  for (const t of targets) {
    if (t.receiver_id === senderId) continue;
    if (t.expires_at !== null && t.expires_at <= now) continue;
    const key = `${t.share_mode}|${t.expires_at ?? 'none'}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  const pct = batteryPct(device.batteryLevel);
  const packets: LocationPacket[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    if (!first) continue;
    for (let i = 0; i < g.length; i += PACKET_LIMITS.maxReceiversPerPacket) {
      packets.push({
        v: LIVE_PACKET_VERSION,
        sender_id: senderId,
        receiver_ids: g.slice(i, i + PACKET_LIMITS.maxReceiversPerPacket).map((t) => t.receiver_id),
        lat: sample.lat,
        lng: sample.lng,
        accuracy: sample.accuracy,
        speed_mps: sample.speed_mps,
        heading: sample.heading,
        battery_pct: pct,
        is_charging: pct === null ? null : device.isCharging,
        activity_state: activity,
        timestamp: sample.timestamp,
        expires_at: first.expires_at,
        share_mode: first.share_mode,
        ...cleanExtras(extras),
      });
    }
  }
  return packets;
}

/** Yalnızca geçerli Faz 3 alanlarını taşır (tanımsız alan pakete girmez). */
export function cleanExtras(extras: PacketExtras): PacketExtras {
  const out: PacketExtras = {};
  if (typeof extras.hb === 'number' && Number.isFinite(extras.hb)) {
    out.hb = Math.round(Math.min(PACKET_LIMITS.maxHeartbeatMs, Math.max(PACKET_LIMITS.minHeartbeatMs, extras.hb)));
  }
  if (extras.q === 1) out.q = 1;
  if (typeof extras.recorded_at === 'number' && Number.isFinite(extras.recorded_at)) out.recorded_at = Math.round(extras.recorded_at);
  // Faz 4: not yalnızca bitişiyle birlikte ve boş değilse girer (RTDB kuralı ikisini birlikte ister).
  if (typeof extras.note === 'string' && typeof extras.note_exp === 'number' && Number.isFinite(extras.note_exp)) {
    const text = extras.note.trim();
    // UTF-16 uzunluğu (RTDB `.length` ile aynı) sınırı aşarsa kod noktası sınırında kesilir.
    let cut = text;
    while (cut.length > PACKET_NOTE_MAX_CHARS) cut = Array.from(cut).slice(0, -1).join('');
    if (cut.length > 0) {
      out.note = cut;
      out.note_exp = Math.round(extras.note_exp);
    }
  }
  // Faz 9: fotoğraf yalnızca bitişiyle ve geçerli kimlikle; hedef yalnızca ad + durumla.
  if (typeof extras.photo_id === 'string' && PROOF_ID_RE.test(extras.photo_id) && typeof extras.photo_exp === 'number' && Number.isFinite(extras.photo_exp)) {
    out.photo_id = extras.photo_id;
    out.photo_exp = Math.round(extras.photo_exp);
  }
  if (typeof extras.dest_name === 'string' && extras.dest_state && (DEST_STATES as readonly string[]).includes(extras.dest_state)) {
    let name = extras.dest_name.trim();
    while (name.length > PACKET_F9_LIMITS.destNameMaxChars) name = Array.from(name).slice(0, -1).join('');
    if (name.length > 0) {
      out.dest_name = name;
      out.dest_state = extras.dest_state;
      if (extras.dest_state === 'near' && typeof extras.dest_eta === 'number' && Number.isFinite(extras.dest_eta)) {
        out.dest_eta = Math.min(PACKET_F9_LIMITS.destEtaMax, Math.max(0, Math.round(extras.dest_eta)));
      }
    }
  }
  return out;
}

export const livePath = (receiverId: UserId, id: ShareId): string => `live_locations/${receiverId}/${id}`;

/** Paketi alıcı başına kopyaya çevirir. `receiver_ids` kopyalara GİRMEZ. */
export function toDeliveredWrite(packet: LocationPacket, receiverId: UserId): DeliveredLocationWrite {
  const { receiver_ids: _omit, ...rest } = packet;
  const out: Record<string, unknown> = { share_id: makeShareId(packet.sender_id, receiverId) };
  for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) out[k] = v;
  out.server_ts = SERVER_TIMESTAMP;
  return out as DeliveredLocationWrite;
}

/** `ref().update(map)` ile tek atomik çağrıda yazılacak yol → değer haritası. */
export function toFanoutUpdate(packets: readonly LocationPacket[]): Record<string, DeliveredLocationWrite> {
  const update: Record<string, DeliveredLocationWrite> = {};
  for (const p of packets) {
    for (const r of p.receiver_ids) update[livePath(r, makeShareId(p.sender_id, r))] = toDeliveredWrite(p, r);
  }
  return update;
}

// ---------------------------------------------------------------------------
// Doğrulama şemaları (Functions, testler ve istemci okuma tarafı)
// ---------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const LocationPacketSchema = z.object({
  v: z.literal(LIVE_PACKET_VERSION),
  sender_id: uid,
  receiver_ids: z.array(uid).min(1).max(PACKET_LIMITS.maxReceiversPerPacket),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(PACKET_LIMITS.maxAccuracyM),
  speed_mps: z.number().min(0).max(PACKET_LIMITS.maxSpeedMps).nullable(),
  heading: z.number().min(0).lt(360).nullable(),
  battery_pct: z.number().int().min(0).max(100).nullable(),
  is_charging: z.boolean().nullable(),
  activity_state: z.enum(ACTIVITY_STATES as [ActivityState, ...ActivityState[]]),
  timestamp: z.number().int().positive(),
  expires_at: z.number().int().positive().nullable(),
  share_mode: z.enum(SHARE_MODES as [ShareMode, ...ShareMode[]]),
  hb: z.number().int().min(PACKET_LIMITS.minHeartbeatMs).max(PACKET_LIMITS.maxHeartbeatMs).optional(),
  q: z.literal(1).optional(),
  recorded_at: z.number().int().positive().optional(),
  note: z.string().min(1).max(PACKET_NOTE_MAX_CHARS).optional(),
  note_exp: z.number().int().positive().optional(),
  photo_id: z.string().regex(PROOF_ID_RE).optional(),
  photo_exp: z.number().int().positive().optional(),
  dest_name: z.string().min(1).max(PACKET_F9_LIMITS.destNameMaxChars).optional(),
  dest_state: z.enum(DEST_STATES).optional(),
  dest_eta: z.number().int().min(0).max(PACKET_F9_LIMITS.destEtaMax).optional(),
});

/** RTDB'den okunan kopya: eksik alanlar null olur, bilinmeyen alanlar yok sayılır (ileri uyumluluk). */
export const DeliveredLocationSchema = z.object({
  v: z.number().int(),
  share_id: z.string(),
  sender_id: uid,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0),
  speed_mps: z.number().nullable().default(null),
  heading: z.number().nullable().default(null),
  battery_pct: z.number().nullable().default(null),
  is_charging: z.boolean().nullable().default(null),
  activity_state: z.enum(ACTIVITY_STATES as [ActivityState, ...ActivityState[]]).catch('unknown'),
  timestamp: z.number(),
  expires_at: z.number().nullable().default(null),
  share_mode: z.enum(SHARE_MODES as [ShareMode, ...ShareMode[]]),
  server_ts: z.number(),
  // Faz 3: bozuk değer paketi düşürmez, yalnızca alan yok sayılır.
  hb: z.number().positive().optional().catch(undefined),
  q: z.literal(1).optional().catch(undefined),
  recorded_at: z.number().optional().catch(undefined),
  // Faz 4: bozuk not paketi düşürmez.
  note: z.string().max(PACKET_NOTE_MAX_CHARS * 2).optional().catch(undefined),
  note_exp: z.number().optional().catch(undefined),
  // Faz 9: bozuk değer paketi düşürmez.
  photo_id: z.string().regex(PROOF_ID_RE).optional().catch(undefined),
  photo_exp: z.number().optional().catch(undefined),
  dest_name: z.string().max(PACKET_F9_LIMITS.destNameMaxChars * 2).optional().catch(undefined),
  dest_state: z.enum(DEST_STATES).optional().catch(undefined),
  dest_eta: z.number().optional().catch(undefined),
});

/** Faz 4: alıcı tarafında gösterilecek durum notu (yoksa ya da süresi geçtiyse null). */
export function visibleStatusNote(loc: { note?: string; note_exp?: EpochMs }, now: EpochMs): string | null {
  if (!loc.note || typeof loc.note_exp !== 'number' || loc.note_exp <= now) return null;
  return loc.note;
}

/** Faz 9: alıcıda gösterilecek anlık fotoğraf referansı (yoksa ya da süresi geçtiyse null). */
export function visibleProofRef(loc: { photo_id?: string; photo_exp?: EpochMs }, now: EpochMs): { photo_id: string; photo_exp: EpochMs } | null {
  if (!loc.photo_id || typeof loc.photo_exp !== 'number' || loc.photo_exp <= now) return null;
  return { photo_id: loc.photo_id, photo_exp: loc.photo_exp };
}

/** Faz 9: alıcıda gösterilecek hedef durumu (yoksa null). */
export function visibleDestination(loc: { dest_name?: string; dest_state?: DestState; dest_eta?: number }): { name: string; state: DestState; eta_min: number | null } | null {
  if (!loc.dest_name || !loc.dest_state) return null;
  return { name: loc.dest_name, state: loc.dest_state, eta_min: loc.dest_state === 'near' && typeof loc.dest_eta === 'number' ? loc.dest_eta : null };
}

/** Okuma tarafı: bozuk kaydı sessizce atar (bir arkadaşın hatalı paketi haritayı çökertmesin). */
export function parseDelivered(raw: unknown): DeliveredLocation | null {
  const r = DeliveredLocationSchema.safeParse(raw);
  return r.success ? (r.data as DeliveredLocation) : null;
}

/** Alıcı tarafında konumun tazeliği (rozet ve gri işaretçi için). [Varsayım] eşikler. */
export type Freshness = 'live' | 'recent' | 'stale';
export function freshness(loc: Pick<DeliveredLocation, 'timestamp'>, now: EpochMs): Freshness {
  const age = now - loc.timestamp;
  if (age <= 2 * MINUTE) return 'live';
  if (age <= 15 * MINUTE) return 'recent';
  return 'stale';
}
