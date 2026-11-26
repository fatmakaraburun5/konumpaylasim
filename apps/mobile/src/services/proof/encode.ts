/**
 * Faz 9: anlık fotoğrafın cihazda yeniden kodlanması (core `PROOF_LIMITS`).
 *
 *  - Uzun kenar `targetDimension` (1280 px; büyütme yok), JPEG `jpegQuality` (0,7), base64 (`data:` öneki yok).
 *  - Yeniden kodlama EXIF / GPS / cihaz bilgisini düşürür (sunucu ayrıca `stripJpegMetadata` uygular).
 *  - Sonuç `maxBytes`'tan (600 KB) büyükse kalite ve boyut kademeli düşürülür; olmazsa `proof_invalid`.
 *  - Ham kamera karesi ve ara dosya kodlamadan sonra silinir (önbellek dizininde kalmaz).
 *
 * `encodeWithStepDown` saf (render bağımlılığı enjekte edilir; testler ve web demosu kullanır).
 */
import { PROOF_LIMITS } from '@konum/core';
import type { CapturedPhoto } from './types';

export interface EncodedProof {
  /** Standart base64 JPEG (`data:` öneki yok). */
  base64: string;
  width: number;
  height: number;
  bytes: number;
}

/** Tek kodlama denemesi: uzun kenar en çok `maxDim`, JPEG kalitesi `quality`. */
export type ProofRender = (maxDim: number, quality: number) => Promise<{ base64: string; width: number; height: number }>;

/** Denemeler sırayla: önce hedef kalite, sonra daha düşük kalite / daha küçük boyut. [Varsayım] */
export const PROOF_ENCODE_STEPS: readonly { maxDim: number; quality: number }[] = [
  { maxDim: PROOF_LIMITS.targetDimension, quality: PROOF_LIMITS.jpegQuality },
  { maxDim: PROOF_LIMITS.targetDimension, quality: 0.55 },
  { maxDim: 1080, quality: 0.5 },
  { maxDim: 960, quality: 0.45 },
  { maxDim: 800, quality: 0.4 },
];

export class ProofEncodeError extends Error {
  constructor(readonly reason: 'too_large' | 'invalid_image') {
    super(reason === 'too_large' ? 'Fotoğraf çok büyük' : 'Fotoğraf okunamadı');
  }
}

/** base64 → bayt sayısı (dolgu düşülür). */
export function base64ByteLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** `data:image/jpeg;base64,` önekini ve boşlukları atar. */
export function stripDataPrefix(b64: string): string {
  const i = b64.indexOf('base64,');
  return (i >= 0 ? b64.slice(i + 7) : b64).replace(/\s+/g, '');
}

/** Kademeli kodlama: ≤ maxBytes ve ≤ maxDimension olan ilk sonuç. */
export async function encodeWithStepDown(render: ProofRender, steps = PROOF_ENCODE_STEPS): Promise<EncodedProof> {
  let sawImage = false;
  for (const step of steps) {
    const out = await render(step.maxDim, step.quality);
    const base64 = stripDataPrefix(out.base64);
    if (!base64 || out.width <= 0 || out.height <= 0) continue;
    sawImage = true;
    if (out.width > PROOF_LIMITS.maxDimension || out.height > PROOF_LIMITS.maxDimension) continue;
    const bytes = base64ByteLength(base64);
    if (bytes <= PROOF_LIMITS.maxBytes) return { base64, width: Math.round(out.width), height: Math.round(out.height), bytes };
  }
  throw new ProofEncodeError(sawImage ? 'too_large' : 'invalid_image');
}

/** Uzun kenarı `maxDim`'e indiren (büyütmeyen) boyutlandırma: tek kenar verilir, oran korunur. */
export function resizeFor(width: number, height: number, maxDim: number): { width?: number; height?: number } | null {
  if (!(width > 0) || !(height > 0)) return { width: maxDim };
  if (Math.max(width, height) <= maxDim) return null;
  return width >= height ? { width: maxDim } : { height: maxDim };
}

/** Yerel (expo-image-manipulator) kodlayıcı. Ham kare ve ara dosyalar silinir. */
export async function encodeProofPhoto(photo: CapturedPhoto): Promise<EncodedProof> {
  // Yerel modüller tembel yüklenir: testler ve saf yardımcılar modül olmadan çalışsın.
  const { ImageManipulator, SaveFormat } = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
  const source = photo.uri ?? `data:image/jpeg;base64,${stripDataPrefix(photo.base64)}`;
  const temp: string[] = [];
  const render: ProofRender = async (maxDim, quality) => {
    const ctx = ImageManipulator.manipulate(source);
    const size = resizeFor(photo.width, photo.height, maxDim);
    if (size) ctx.resize(size);
    const img = await ctx.renderAsync();
    try {
      const out = await img.saveAsync({ compress: quality, format: SaveFormat.JPEG, base64: true });
      temp.push(out.uri);
      return { base64: out.base64 ?? '', width: out.width, height: out.height };
    } finally {
      img.release();
      ctx.release();
    }
  };
  try {
    return await encodeWithStepDown(render);
  } finally {
    deleteLocalFiles([...temp, ...(photo.uri ? [photo.uri] : [])]);
  }
}

/** Yerel dosyaları sessizce siler (önbellek / kamera geçici dosyaları). */
export function deleteLocalFiles(uris: readonly string[]): void {
  if (uris.length === 0) return;
  try {
    const { File } = require('expo-file-system') as typeof import('expo-file-system');
    for (const uri of uris) {
      try {
        const f = new File(uri);
        if (f.exists) f.delete();
      } catch {
        // dosya zaten yok / erişilemiyor
      }
    }
  } catch {
    // modül yok (test / web)
  }
}
