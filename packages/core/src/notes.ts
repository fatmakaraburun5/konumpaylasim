/**
 * Faz 4: konum yanına kısa not / etiket.
 *
 * İki tür:
 *  1. **Durum notu** (canlı konuma bağlı, "☕ Kahve molasındayım"): sunucuda belge YOK. Gönderen cihaz notu canlı
 *     paketlere `note` + `note_exp` alanlarıyla ekler (bkz. packet.ts). Böylece notu tam olarak konumu görenler
 *     görür, paylaşım bitince paketle birlikte silinir. Not değişince cihaz hemen bir paket yayınlar.
 *     Bağlantı (QR) izleyicilerine not gitmez [Varsayım].
 *  2. **Yer notu** (sabitlenen nokta, "🅿️ Park yeri burası", "🔑 Anahtar burada"): Firestore `place_notes/{id}`,
 *     yalnızca callable ile yazılır (`place_note_upsert` / `place_note_delete`). `visible_to` boşsa yalnızca sahibi
 *     görür; doluysa en çok 20 kabul edilmiş arkadaş. Süre dolunca okuma tarafı gizler, süpürücü siler.
 *     [Varsayım] Okuyan arkadaş `visible_to` listesini görebilir (Firestore alan gizlemez); liste yalnızca sahibin
 *     seçtiği arkadaşlardan oluşur.
 */
import { z } from 'zod';
import type { UserId } from './model';
import { DAY, HOUR, MINUTE, type EpochMs } from './time';

export const NOTE_LIMITS = {
  /** Metin üst sınırı (UTF-16 birimi; RTDB `.length` ile aynı ölçü). */
  maxChars: 60,
  maxEmojiChars: 8,
  /** Bir yer notunu görebilecek en fazla arkadaş. */
  maxAudience: 20,
  /** Kullanıcı başına aynı anda en fazla aktif yer notu. [Varsayım] */
  maxActivePlaceNotes: 20,
  /** Yer notu en uzun süre. */
  placeMaxMs: 7 * DAY,
  /** Durum notu en uzun süre. */
  statusMaxMs: DAY,
} as const;

export interface NotePreset {
  id: string;
  emoji: string;
  text: string;
  /** Hangi tür için önerilir. */
  kind: 'status' | 'place';
}

/** Hızlı seçim çipleri (kullanıcı serbest metin de yazabilir). */
export const NOTE_PRESETS: readonly NotePreset[] = [
  { id: 'coffee', emoji: '☕', text: 'Kahve molasındayım', kind: 'status' },
  { id: 'meeting', emoji: '🗓️', text: 'Toplantıdayım', kind: 'status' },
  { id: 'back_soon', emoji: '⏳', text: 'Birazdan dönerim', kind: 'status' },
  { id: 'driving', emoji: '🚗', text: 'Araç kullanıyorum', kind: 'status' },
  { id: 'parking', emoji: '🅿️', text: 'Park yeri burası', kind: 'place' },
  { id: 'key', emoji: '🔑', text: 'Anahtar burada', kind: 'place' },
  { id: 'meet_here', emoji: '👋', text: 'Buluşma noktası', kind: 'place' },
];

export interface NoteDurationOption {
  id: 'm30' | 'h1' | 'h4' | 'd1' | 'w1';
  label: string;
  ms: number;
}

export const NOTE_DURATIONS: readonly NoteDurationOption[] = [
  { id: 'm30', label: '30 dk', ms: 30 * MINUTE },
  { id: 'h1', label: '1 saat', ms: HOUR },
  { id: 'h4', label: '4 saat', ms: 4 * HOUR },
  { id: 'd1', label: '1 gün', ms: DAY },
  { id: 'w1', label: '1 hafta', ms: 7 * DAY },
];

/** Türüne göre seçilebilir süreler (durum notu en çok 1 gün). */
export function noteDurationsFor(kind: 'status' | 'place'): readonly NoteDurationOption[] {
  const max = kind === 'status' ? NOTE_LIMITS.statusMaxMs : NOTE_LIMITS.placeMaxMs;
  return NOTE_DURATIONS.filter((d) => d.ms <= max);
}

export const NOTE_DURATION_MS_VALUES = NOTE_DURATIONS.map((d) => d.ms);

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;

/**
 * Not metnini temizler: kontrol / yön değiştirme karakterleri atılır, boşluklar tekleştirilir, `maxChars` UTF-16
 * birimini aşarsa kod noktası sınırında kesilir. Boş kalırsa null.
 */
export function sanitizeNoteText(raw: string, maxChars: number = NOTE_LIMITS.maxChars): string | null {
  let s = raw.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (s.length > maxChars) {
    const cps = Array.from(s);
    while (cps.length > 0 && cps.join('').length > maxChars) cps.pop();
    s = cps.join('').trim();
  }
  return s.length > 0 ? s : null;
}

/** Emoji + metin tek satır (paketteki `note` alanı ve pin etiketi). */
export function composeNoteLabel(emoji: string | null | undefined, text: string): string {
  const e = emoji ? sanitizeNoteText(emoji, NOTE_LIMITS.maxEmojiChars) : null;
  const t = sanitizeNoteText(text) ?? '';
  return sanitizeNoteText(e ? `${e} ${t}` : t) ?? '';
}

// --- durum notu (yerel, paketlere eklenir) --------------------------------------------------

export interface StatusNote {
  emoji: string | null;
  text: string;
  expires_at: EpochMs;
}

/** Paketlere eklenecek alanlar (`PacketExtras.note` / `note_exp`); not yoksa ya da süresi geçtiyse boş. */
export function statusNoteExtras(note: StatusNote | null | undefined, now: EpochMs): { note?: string; note_exp?: EpochMs } {
  if (!note || note.expires_at <= now) return {};
  const label = composeNoteLabel(note.emoji, note.text);
  return label ? { note: label, note_exp: note.expires_at } : {};
}

// --- yer notu (Firestore `place_notes`) --------------------------------------------------

export interface NotePosition {
  lat: number;
  lng: number;
  accuracy: number | null;
}

export interface PlaceNote {
  note_id: string;
  owner_id: UserId;
  emoji: string | null;
  text: string;
  position: NotePosition;
  /** Boş = yalnızca sahibi görür. */
  visible_to: UserId[];
  created_at: EpochMs;
  updated_at: EpochMs;
  expires_at: EpochMs;
}

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const NotePositionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(5_000).nullable().default(null),
});

export const PlaceNoteUpsertRequestSchema = z.object({
  op_id: z.uuid(),
  /** null = yeni not; dolu = sahibin mevcut notunu düzenle. */
  note_id: z.string().min(1).max(64).nullable().default(null),
  emoji: z.string().max(NOTE_LIMITS.maxEmojiChars).nullable().default(null),
  text: z.string().min(1).max(NOTE_LIMITS.maxChars * 2),
  position: NotePositionSchema,
  visible_to: z.array(uid).max(NOTE_LIMITS.maxAudience).default([]),
  duration_ms: z.number().int().refine((v) => NOTE_DURATION_MS_VALUES.includes(v), { message: 'invalid_duration' }),
});
export type PlaceNoteUpsertRequest = z.input<typeof PlaceNoteUpsertRequestSchema>;

export const PlaceNoteSchema: z.ZodType<PlaceNote> = z.object({
  note_id: z.string().min(1),
  owner_id: uid,
  emoji: z.string().nullable(),
  text: z.string(),
  position: z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().nullable() }),
  visible_to: z.array(uid),
  created_at: z.number(),
  updated_at: z.number(),
  expires_at: z.number(),
});

export interface PlaceNoteUpsertResponse {
  note: PlaceNote;
  server_now: EpochMs;
}
export const PlaceNoteUpsertResponseSchema: z.ZodType<PlaceNoteUpsertResponse> = z.object({ note: PlaceNoteSchema, server_now: z.number() });

export const PlaceNoteDeleteRequestSchema = z.object({ op_id: z.uuid(), note_id: z.string().min(1).max(64) });
export type PlaceNoteDeleteRequest = z.input<typeof PlaceNoteDeleteRequestSchema>;

export interface PlaceNoteDeleteResponse {
  note_id: string;
  deleted: boolean;
  server_now: EpochMs;
}
export const PlaceNoteDeleteResponseSchema: z.ZodType<PlaceNoteDeleteResponse> = z.object({
  note_id: z.string(),
  deleted: z.boolean(),
  server_now: z.number(),
});

/** Okuma tarafı: bozuk belge atılır. Firestore Timestamp'leri okuyucu önceden epoch ms'ye çevirmelidir. */
export function parsePlaceNote(raw: unknown): PlaceNote | null {
  const r = PlaceNoteSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export const isNoteActive = (n: Pick<PlaceNote, 'expires_at'>, now: EpochMs): boolean => n.expires_at > now;

/** "2 sa 15 dk kaldı" gibi kalan süre metni (not kartı). */
export function formatNoteLeft(expiresAt: EpochMs, now: EpochMs): string {
  const left = Math.max(0, expiresAt - now);
  if (left < MINUTE) return 'birazdan kalkacak';
  const d = Math.floor(left / DAY);
  const h = Math.floor((left % DAY) / HOUR);
  const m = Math.floor((left % HOUR) / MINUTE);
  if (d > 0) return h > 0 ? `${d} gün ${h} sa kaldı` : `${d} gün kaldı`;
  if (h > 0) return m > 0 ? `${h} sa ${m} dk kaldı` : `${h} sa kaldı`;
  return `${m} dk kaldı`;
}
