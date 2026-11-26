/**
 * Web demo · Faz 9: simüle kamera sahnesi (tarayıcı kamerası İSTENMEZ, galeri / dosya seçici YOKTUR).
 *
 * `drawProofScene` vizörde her karede çizilir (buhar, arka lambalar, hafif el titremesi); deklanşörde aynı sahne
 * 1280 px tuvale çizilip `toDataURL('image/jpeg', 0,7)` ile o anın JPEG'i üretilir. Botların "anlık fotoğrafı" da
 * buradan gelir (tuval yoksa sunucu gömülü küçük JPEG'i kullanır).
 */
export type ProofSceneKind = 'cafe' | 'traffic';

export const PROOF_SCENES: readonly { kind: ProofSceneKind; label: string }[] = [
  { kind: 'cafe', label: 'Kafe masası' },
  { kind: 'traffic', label: 'Trafik' },
];

type Ctx = CanvasRenderingContext2D;

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string | CanvasGradient): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawCafe(ctx: Ctx, w: number, h: number, t: number): void {
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, '#C9A27A');
  wall.addColorStop(1, '#8C6446');
  rect(ctx, 0, 0, w, h, wall);
  // Pencere ve dışarıdaki ışık
  const wx = w * 0.58;
  const wy = h * 0.06;
  const ww = w * 0.36;
  const wh = h * 0.38;
  const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
  sky.addColorStop(0, '#F6E7C8');
  sky.addColorStop(1, '#E9C893');
  rect(ctx, wx, wy, ww, wh, sky);
  ctx.strokeStyle = '#6E4A2E';
  ctx.lineWidth = w * 0.012;
  ctx.strokeRect(wx, wy, ww, wh);
  ctx.beginPath();
  ctx.moveTo(wx + ww / 2, wy);
  ctx.lineTo(wx + ww / 2, wy + wh);
  ctx.moveTo(wx, wy + wh / 2);
  ctx.lineTo(wx + ww, wy + wh / 2);
  ctx.stroke();
  // Saksı
  ellipse(ctx, w * 0.14, h * 0.3, w * 0.09, h * 0.12, '#4F7F52');
  ellipse(ctx, w * 0.1, h * 0.24, w * 0.05, h * 0.08, '#5E9461');
  rect(ctx, w * 0.1, h * 0.38, w * 0.08, h * 0.14, '#A35F3A');
  // Masa (perspektif)
  ctx.fillStyle = '#7A4B2C';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.62);
  ctx.lineTo(w, h * 0.56);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(0, h * (0.62 + i * 0.07));
    ctx.lineTo(w, h * (0.56 + i * 0.075));
    ctx.stroke();
  }
  // Fincanlar + buhar
  const cups: [number, number][] = [
    [0.32, 0.64],
    [0.66, 0.6],
  ];
  cups.forEach(([cx, cy], i) => {
    const x = w * cx;
    const y = h * cy;
    const r = w * 0.085;
    ellipse(ctx, x, y + r * 0.95, r * 1.45, r * 0.38, '#EFEDE6');
    rect(ctx, x - r * 0.75, y - r * 0.55, r * 1.5, r * 1.3, '#FAFAF7');
    ellipse(ctx, x, y + r * 0.75, r * 0.75, r * 0.2, '#FAFAF7');
    ellipse(ctx, x, y - r * 0.55, r * 0.75, r * 0.22, '#5B371F');
    ctx.strokeStyle = '#FAFAF7';
    ctx.lineWidth = r * 0.2;
    ctx.beginPath();
    ctx.arc(x + r * 0.85, y, r * 0.35, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = r * 0.12;
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      const phase = t / 600 + i + k * 1.7;
      const bx = x - r * 0.25 + k * r * 0.5;
      ctx.moveTo(bx, y - r * 0.7);
      ctx.bezierCurveTo(bx + Math.sin(phase) * r * 0.4, y - r * 1.3, bx - Math.sin(phase + 1) * r * 0.4, y - r * 1.8, bx + Math.sin(phase + 2) * r * 0.3, y - r * 2.4);
      ctx.stroke();
    }
  });
  // "Rezerve" kartı
  rect(ctx, w * 0.46, h * 0.68, w * 0.12, h * 0.1, '#FFFFFF');
  ctx.fillStyle = '#3C2A1E';
  ctx.font = `600 ${Math.round(h * 0.032)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('MASA 4', w * 0.52, h * 0.74);
}

function drawTraffic(ctx: Ctx, w: number, h: number, t: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.5);
  sky.addColorStop(0, '#2B3A67');
  sky.addColorStop(1, '#E08E6D');
  rect(ctx, 0, 0, w, h * 0.5, sky);
  // Binalar
  for (let i = 0; i < 9; i++) {
    const bw = w * 0.11;
    const bh = h * (0.12 + ((i * 37) % 17) / 100);
    rect(ctx, i * bw * 1.02, h * 0.5 - bh, bw, bh, i % 2 ? '#38405E' : '#2F3550');
  }
  // Yol
  ctx.fillStyle = '#3A3A40';
  ctx.beginPath();
  ctx.moveTo(w * 0.42, h * 0.5);
  ctx.lineTo(w * 0.58, h * 0.5);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  rect(ctx, 0, h * 0.5, w, h * 0.012, '#55555C');
  // Araç sıraları (arka lambalar yanıp söner)
  const blink = Math.floor(t / 700) % 2 === 0;
  for (let row = 0; row < 4; row++) {
    const y = h * (0.56 + row * 0.11);
    const s = 0.45 + row * 0.28;
    for (let lane = -1; lane <= 1; lane++) {
      const cx = w / 2 + lane * w * 0.16 * s * 1.6;
      const cw = w * 0.13 * s;
      const ch = h * 0.07 * s;
      const colors = ['#B33A3A', '#E0E0E0', '#2F5D8A', '#C9A227'];
      rect(ctx, cx - cw / 2, y, cw, ch, colors[(row + lane + 3) % colors.length] as string);
      rect(ctx, cx - cw * 0.4, y - ch * 0.45, cw * 0.8, ch * 0.5, '#1E1E24');
      const lamp = blink || row % 2 ? '#FF3B30' : '#8E1F1A';
      rect(ctx, cx - cw / 2 + 2, y + ch * 0.25, cw * 0.16, ch * 0.22, lamp);
      rect(ctx, cx + cw / 2 - cw * 0.16 - 2, y + ch * 0.25, cw * 0.16, ch * 0.22, lamp);
    }
  }
  // Trafik ışığı
  rect(ctx, w * 0.86, h * 0.18, w * 0.05, h * 0.2, '#15151A');
  ellipse(ctx, w * 0.885, h * 0.22, w * 0.014, w * 0.014, '#FF3B30');
  ellipse(ctx, w * 0.885, h * 0.28, w * 0.014, w * 0.014, '#4A3A10');
  ellipse(ctx, w * 0.885, h * 0.34, w * 0.014, w * 0.014, '#103A1A');
  rect(ctx, w * 0.88, h * 0.38, w * 0.01, h * 0.14, '#15151A');
}

/** Sahneyi çizer; `t` ms (canlanma), `shake` hafif el titremesi (vizör). */
export function drawProofScene(ctx: Ctx, w: number, h: number, t: number, kind: ProofSceneKind, shake = true): void {
  ctx.save();
  if (shake) ctx.translate(Math.sin(t / 900) * w * 0.004, Math.cos(t / 1100) * h * 0.004);
  ctx.clearRect(-w, -h, w * 3, h * 3);
  if (kind === 'traffic') drawTraffic(ctx, w, h, t);
  else drawCafe(ctx, w, h, t);
  // Vinyet (lens)
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vg;
  ctx.fillRect(-w, -h, w * 3, h * 3);
  ctx.restore();
}

/** O anın karesi: `width`×`height` JPEG (base64, `data:` öneki yok). Tuval yoksa null. */
export function renderProofJpeg(kind: ProofSceneKind, t: number = Date.now(), width = 1280, height = 960, quality = 0.7): { base64: string; width: number; height: number } | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawProofScene(ctx, width, height, t, kind, false);
    const url = canvas.toDataURL('image/jpeg', quality);
    const i = url.indexOf('base64,');
    if (!url.startsWith('data:image/jpeg') || i < 0) return null;
    return { base64: url.slice(i + 7), width, height };
  } catch {
    return null;
  }
}
