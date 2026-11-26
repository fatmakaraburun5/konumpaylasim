/**
 * Faz 9: varışa göre akıllı durum — hedefe 200 metre kala "Neredeyse vardım (1 dk)". Ayrıntı: docs/PHASE9.md §2.
 *
 *  - Hedef (`ShareDestination`) paylaşan cihazda tutulur: kayıtlı bölge (Faz 5 Ev / İş …), haritadan seçilen nokta,
 *    etkinlik mekanı ya da buluşma noktası. Hedefin KOORDİNATI cihazdan çıkmaz; alıcılara yalnızca hedefin ADI ve
 *    durumu (`dest_name`, `dest_state`, `dest_eta` paket alanları) gider. Sunucu yalnızca koordinatsız bir anahtar
 *    (`destinationKey`, SHA-256 özetinin ilk 16 hanesi) görür.
 *  - Algılama cihazda, her GPS örneğinde: `approachReduce` saf durum makinesi. Doğruluk kapısı, "uzaktan geldi" şartı
 *    (paylaşım hedefin dibinde başlarsa bildirim gitmez), iki örnekli doğrulama (ya da açıkça içeride tek örnek).
 *  - Kullanıcının aynı anda TEK etkin hedefi vardır (cihazda `konum.bg.destination.v1`); tüm arkadaş paylaşım
 *    oturumlarının paketlerine uygulanır.
 *  - TEK SEFER: aynı paylaşım oturumu + aynı hedef için bildirim bir kez gider. Cihaz durum makinesinde `fired`
 *    kalıcıdır; sunucu her oturum için `approach_marks/{uid}_{session}_{dest_key}` belgesini transaction'da `create`
 *    ile yazar (hepsi zaten varsa `already_sent`, push yok). Hedef değişirse yeni anahtar = yeni tek hak.
 *  - Alıcılar: o oturumun ETKİN paylaşım alıcıları (canlı konumu zaten görüyorlar; yeni bilgi sızmaz) ve
 *    "yola çıktı / neredeyse vardım" tercihini (`movement_alerts`) kapatmamış olanlar. Görünmezken gitmez.
 */
import { z } from 'zod';
import { haversineM, roundCoord, type LatLng } from './geo';
import { sha256Hex } from './link';
import { DEST_STATES, type ActivityState, type DestState } from './packet';
import { HOUR, MINUTE, SECOND, type EpochMs } from './time';

export const APPROACH_LIMITS = {
  /** Bildirim eşiği (metre). */
  radiusM: 200,
  /** Kurulma şartı: en az bir güvenilir örnek bu mesafenin dışında görülmeli. */
  armRadiusM: 260,
  /** Bundan kötü doğruluklu örnek yok sayılır. */
  maxAccuracyM: 100,
  /** Halka içinde arka arkaya en az örnek … */
  confirmSamples: 2,
  /** … ve aralarında en az süre. */
  minConfirmSpanMs: 5 * SECOND,
  /** Açıkça içeride (d + acc ≤ radius × bu oran) tek örnek yeter (hızlı araç). */
  clearInsideRatio: 0.6,
  /** Doğruluk payı katsayısı (d + acc × k ≤ radius). */
  accuracyFactor: 0.5,
  /** Rapor en çok bu kadar eski olabilir (sunucu `stale`). */
  maxReportAgeMs: 2 * MINUTE,
  /** Bildirim TTL (geç gelen "neredeyse vardım" yanıltıcıdır). */
  pushTtlMs: 5 * MINUTE,
  /** Kullanıcı başına saatlik en çok rapor (hedef değiştirip durmaya karşı). [Varsayım] */
  perHour: 12,
  /** Hedef adı üst sınırı (paket kuralı da `dest_name.length <= 30`). */
  destNameMaxChars: 30,
  /** Haritadan seçilen nokta için varış yarıçapı. [Varsayım] */
  pointArrivalRadiusM: 75,
  /** Tekrar önleme kaydı TTL. */
  markTtlMs: 48 * HOUR,
  /** Gösterilen varış süresi üst sınırı (dakika). */
  maxEtaMin: 10,
} as const;

export const DESTINATION_KINDS = ['zone', 'point', 'event', 'meetup'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

/** Paylaşan cihazda (koordinatlı) hedef. Sunucuya ve alıcılara gitmez; yalnızca `name` + `key` gider. */
export interface ShareDestination {
  /** `destinationKey` (16 hex). */
  key: string;
  kind: DestinationKind;
  /** Bölge / etkinlik / buluşma kimliği; nokta için null. */
  ref_id: string | null;
  name: string;
  center: LatLng;
  /** Varış yarıçapı: bölgenin kendi yarıçapı ya da `pointArrivalRadiusM`. */
  radius_m: number;
  set_at: EpochMs;
}


export const DEST_KEY_RE = /^[0-9a-f]{16}$/;

/** Koordinatsız, kararlı hedef anahtarı (aynı bölge = aynı anahtar; nokta için 6 ondalık yuvarlanmış konum). */
export function destinationKey(kind: DestinationKind, refId: string | null, center: LatLng): string {
  const basis = refId ? `${kind}|${refId}` : `${kind}|${roundCoord(center.lat)}|${roundCoord(center.lng)}`;
  return sha256Hex(`konum.dest.v1|${basis}`).slice(0, 16);
}

/** Hedef adını temizler (kontrol karakteri yok, ≤ 30). Boşsa "Hedef". */
export function sanitizeDestName(raw: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  let s = (raw ?? '').replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > APPROACH_LIMITS.destNameMaxChars) {
    const cps = Array.from(s);
    while (cps.length > 0 && cps.join('').length > APPROACH_LIMITS.destNameMaxChars) cps.pop();
    s = cps.join('').trim();
  }
  return s || 'Hedef';
}

export function makeDestination(i: { kind: DestinationKind; ref_id?: string | null; name: string; center: LatLng; radius_m?: number | null; now: EpochMs }): ShareDestination {
  const center = { lat: roundCoord(i.center.lat), lng: roundCoord(i.center.lng) };
  return {
    key: destinationKey(i.kind, i.ref_id ?? null, center),
    kind: i.kind,
    ref_id: i.ref_id ?? null,
    name: sanitizeDestName(i.name),
    center,
    radius_m: Math.max(30, Math.round(i.radius_m ?? APPROACH_LIMITS.pointArrivalRadiusM)),
    set_at: i.now,
  };
}

// --- durum makinesi ------------------------------------------------------------------------

export type ApproachPhase = 'unarmed' | 'armed' | 'confirming' | 'fired';

export interface ApproachState {
  dest_key: string;
  phase: ApproachPhase;
  /** Halka içindeki ardışık güvenilir örnek sayısı ve ilkinin anı. */
  confirm_count: number;
  confirm_since: EpochMs | null;
  /** Tek seferlik tetik anı (oturum boyunca kalıcı). */
  fired_at: EpochMs | null;
  /** Varış yarıçapına girildi mi (Güvenli Dönüş ve `dest_state: 'arrived'`). */
  arrived_at: EpochMs | null;
  last_distance_m: number | null;
}

export function initialApproachState(destKey: string): ApproachState {
  return { dest_key: destKey, phase: 'unarmed', confirm_count: 0, confirm_since: null, fired_at: null, arrived_at: null, last_distance_m: null };
}

export interface ApproachSample {
  lat: number;
  lng: number;
  accuracy: number;
  speed_mps: number | null;
  activity: ActivityState;
  at: EpochMs;
}

export interface ApproachFire {
  distance_m: number;
  eta_min: number;
  at: EpochMs;
}

export interface ApproachStep {
  state: ApproachState;
  /** Bu örnekte tek seferlik bildirim tetiklendi. */
  fire: ApproachFire | null;
  /** Bu örnekte varış yarıçapına ilk kez girildi. */
  arrived: boolean;
  /** Pakete yazılacak hedef durumu. */
  dest_state: DestState;
  /** Pakete yazılacak varış süresi (dk; yalnızca near). */
  dest_eta: number | null;
}

/** Hareket türüne göre varsayılan hız (m/s) — hız ölçümü yoksa. [Varsayım] */
const DEFAULT_SPEED: Record<ActivityState, number> = { still: 1.3, walking: 1.3, running: 2.8, cycling: 4.5, automotive: 7, unknown: 1.3 };

/** "1 dk": mesafe / hız, en az 1 en çok 10 dakika. */
export function approachEtaMinutes(distanceM: number, speedMps: number | null, activity: ActivityState): number {
  const v = speedMps !== null && Number.isFinite(speedMps) && speedMps >= 0.5 ? speedMps : DEFAULT_SPEED[activity];
  const min = Math.round(Math.max(0, distanceM) / v / 60);
  return Math.min(APPROACH_LIMITS.maxEtaMin, Math.max(1, min));
}

/**
 * Saf geçiş. Hedef değiştiyse (`state.dest_key !== dest.key`) durum sıfırdan kurulur (yeni tek hak).
 *  - `accuracy > maxAccuracyM` örnek yalnızca durumu korur.
 *  - unarmed → armed: `d − acc × k ≥ armRadiusM` (uzaktan geliyor).
 *  - armed → confirming → fired: `d + acc × k ≤ radiusM`; `confirmSamples` örnek ve `minConfirmSpanMs` ya da açıkça
 *    içeride tek örnek. Halkadan çıkan örnek sayacı sıfırlar.
 *  - fired kalıcıdır (oturum başına tek bildirim). Varış (`d + acc × k ≤ dest.radius_m`) her fazda bir kez işaretlenir.
 */
export function approachReduce(prev: ApproachState | null, s: ApproachSample, dest: Pick<ShareDestination, 'key' | 'center' | 'radius_m'>): ApproachStep {
  let st: ApproachState = prev && prev.dest_key === dest.key ? { ...prev } : initialApproachState(dest.key);
  const destState = (): DestState => (st.arrived_at !== null ? 'arrived' : st.phase === 'fired' ? 'near' : 'en_route');
  const etaNow = (d: number) => approachEtaMinutes(d, s.speed_mps, s.activity);

  if (!Number.isFinite(s.accuracy) || s.accuracy > APPROACH_LIMITS.maxAccuracyM) {
    return { state: st, fire: null, arrived: false, dest_state: destState(), dest_eta: st.phase === 'fired' && st.last_distance_m !== null ? etaNow(st.last_distance_m) : null };
  }
  const d = haversineM(s, dest.center);
  const pad = s.accuracy * APPROACH_LIMITS.accuracyFactor;
  st.last_distance_m = Math.round(d);

  let arrived = false;
  if (st.arrived_at === null && d + pad <= dest.radius_m) {
    st.arrived_at = s.at;
    arrived = true;
  }

  let fire: ApproachFire | null = null;
  if (st.phase === 'unarmed') {
    if (d - pad >= APPROACH_LIMITS.armRadiusM) st.phase = 'armed';
  } else if (st.phase === 'armed' || st.phase === 'confirming') {
    const inRing = d + pad <= APPROACH_LIMITS.radiusM;
    if (!inRing) {
      st.phase = 'armed';
      st.confirm_count = 0;
      st.confirm_since = null;
    } else {
      const clearlyInside = d + s.accuracy <= APPROACH_LIMITS.radiusM * APPROACH_LIMITS.clearInsideRatio;
      st.confirm_count += 1;
      st.confirm_since = st.confirm_since ?? s.at;
      const confirmed = clearlyInside || arrived || (st.confirm_count >= APPROACH_LIMITS.confirmSamples && s.at - st.confirm_since >= APPROACH_LIMITS.minConfirmSpanMs);
      if (confirmed) {
        st.phase = 'fired';
        st.fired_at = s.at;
        fire = { distance_m: Math.round(d), eta_min: etaNow(d), at: s.at };
      } else {
        st.phase = 'confirming';
      }
    }
  }
  const ds = destState();
  return { state: st, fire, arrived, dest_state: ds, dest_eta: ds === 'near' ? etaNow(d) : null };
}

// --- sözleşme ------------------------------------------------------------------------------

export const ApproachReportRequestSchema = z.object({
  op_id: z.uuid(),
  /**
   * Hedef kullanıcının tek etkin hedefidir ve tüm arkadaş paylaşım oturumlarına uygulanır; tetik anındaki etkin
   * oturumlar bildirilir. Sunucu HER oturum için ayrı tek sefer kaydı yazar (oturum başına bir bildirim).
   */
  session_ids: z.array(z.string().min(1).max(128)).min(1).max(10),
  dest_key: z.string().regex(DEST_KEY_RE),
  dest_name: z.string().min(1).max(APPROACH_LIMITS.destNameMaxChars * 2),
  dest_kind: z.enum(DESTINATION_KINDS),
  distance_m: z.number().min(0).max(APPROACH_LIMITS.radiusM * 2),
  eta_min: z.number().int().min(1).max(APPROACH_LIMITS.maxEtaMin),
  /** Tetik anı (sunucu saatine çevrilmiş). */
  at: z.number().int().positive(),
});
export type ApproachReportRequest = z.input<typeof ApproachReportRequestSchema>;

export const APPROACH_REPORT_STATUSES = ['sent', 'already_sent', 'no_recipients', 'stale', 'invisible'] as const;
export type ApproachReportStatus = (typeof APPROACH_REPORT_STATUSES)[number];

export interface ApproachReportResponse {
  status: ApproachReportStatus;
  notified_count: number;
  server_now: EpochMs;
}
export const ApproachReportResponseSchema: z.ZodType<ApproachReportResponse> = z.object({
  status: z.enum(APPROACH_REPORT_STATUSES),
  notified_count: z.number().int().nonnegative(),
  server_now: z.number(),
});

/** Tekrar önleme belgesi kimliği. */
export const approachMarkId = (uid: string, sessionId: string, destKey: string): string => `${uid}_${sessionId}_${destKey}`;

// --- metinler ------------------------------------------------------------------------------

/** Paylaşanın ağzından durum: "Neredeyse vardım (1 dk)". */
export const approachStatusText = (etaMin: number): string => `Neredeyse vardım (${Math.max(1, Math.round(etaMin))} dk)`;

/** Alıcıya push: "Ayşe: Neredeyse vardım (1 dk)" · "Ev · yaklaşık 180 m kaldı". Koordinat YOK. */
export function approachPushText(senderName: string | null | undefined, destName: string, etaMin: number, distanceM?: number | null): { title: string; body: string } {
  const n = senderName && senderName.trim() ? senderName.trim() : 'Arkadaşın';
  const dist = typeof distanceM === 'number' && Number.isFinite(distanceM) ? ` · yaklaşık ${Math.max(10, Math.round(distanceM / 10) * 10)} m kaldı` : '';
  return { title: `${n}: ${approachStatusText(etaMin)}`, body: `${sanitizeDestName(destName)}${dist}` };
}

/** Haritada pin altı / kişi kartı rozeti. */
export function destBadgeText(state: DestState, destName: string, etaMin: number | null): string {
  const name = sanitizeDestName(destName);
  switch (state) {
    case 'en_route':
      return `${name} yolunda`;
    case 'near':
      return `Neredeyse vardı · ${name}${etaMin ? ` · ~${etaMin} dk` : ''}`;
    case 'arrived':
      return `${name} konumuna vardı`;
  }
}

export const APPROACH_TEXT = {
  pickTitle: 'Hedef seç',
  pickHint: 'Hedefine 200 metre kala konumunu görenlere "Neredeyse vardım" bildirimi gider. Hedefin konumu telefonundan çıkmaz; yalnızca adı görünür.',
  fromZones: 'Kayıtlı bölgeler',
  fromMap: 'Haritadan seç',
  fromEvent: 'Etkinlik mekanı',
  fromMeetup: 'Buluşma noktası',
  clear: 'Hedefi kaldır',
  set: (name: string): string => `Hedef: ${sanitizeDestName(name)}`,
  sentToast: (n: number): string => (n > 0 ? `"Neredeyse vardım" ${n} kişiye gitti` : '"Neredeyse vardım" durumu haritada güncellendi'),
} as const;
