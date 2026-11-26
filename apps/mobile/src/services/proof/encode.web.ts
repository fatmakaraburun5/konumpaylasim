/**
 * Web demo: anlık fotoğrafın yeniden kodlanması tarayıcı tuvaliyle (`<canvas>` → `toDataURL('image/jpeg', q)`).
 * Native `encode.ts` ile aynı dışa aktarımlar ve aynı kademeli kurallar (core `PROOF_LIMITS`: uzun kenar 1280 px,
 * JPEG 0,7, ≤ 600 KB). Tuval yeniden kodlaması EXIF / GPS taşımaz. Yerel dosya yoktur (`deleteLocalFiles` boş).
 */
import { PROOF_LIMITS } from '@konum/core';
import type { CapturedPhoto } from './types';

export interface EncodedProof {
  base64: string;
  width: number;
  height: number;
  bytes: number;
}

export type ProofRender = (maxDim: number, quality: number) => Promise<{ base64: string; width: number; height: number }>;

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

export function base64ByteLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export function stripDataPrefix(b64: string): string {
  const i = b64.indexOf('base64,');
  return (i >= 0 ? b64.slice(i + 7) : b64).replace(/\s+/g, '');
}

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

export function resizeFor(width: number, height: number, maxDim: number): { width?: number; height?: number } | null {
  if (!(width > 0) || !(height > 0)) return { width: maxDim };
  if (Math.max(width, height) <= maxDim) return null;
  return width >= height ? { width: maxDim } : { height: maxDim };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ProofEncodeError('invalid_image'));
    img.src = src;
  });
}

/** Tuval kodlayıcı (yalnızca `data:` kaynağı; demo kamerası zaten JPEG verir). */
export async function encodeProofPhoto(photo: CapturedPhoto): Promise<EncodedProof> {
  if (typeof document === 'undefined') throw new ProofEncodeError('invalid_image');
  const img = await loadImage(`data:image/jpeg;base64,${stripDataPrefix(photo.base64)}`);
  const srcW = img.naturalWidth || photo.width;
  const srcH = img.naturalHeight || photo.height;
  const render: ProofRender = async (maxDim, quality) => {
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { base64: '', width: 0, height: 0 };
    ctx.drawImage(img, 0, 0, w, h);
    return { base64: canvas.toDataURL('image/jpeg', quality), width: w, height: h };
  };
  return encodeWithStepDown(render);
}

export function deleteLocalFiles(_uris: readonly string[]): void {
  // web: yerel dosya yok
}
