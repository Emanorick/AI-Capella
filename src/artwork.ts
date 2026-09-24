import type { Score } from './score';
import { colorForPart } from './palette';
import { withAlpha } from './theme';

export interface RibbonOptions {
  voices: number;
  x0: number;
  x1: number;
  cy: number;
  gap: number;
  amp: number;
  line?: number;
  halo?: number;
  bead?: number;
}

/**
 * The title screen's moving voice lines: one ribbon per voice in the voice spectrum, parting in
 * the middle and meeting at both ends, with small beads travelling along them like notes. Drawn
 * into a transparent canvas; both ends fade out so the ribbons melt into whatever is behind.
 */
export function drawRibbons(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, o: RibbonOptions) {
  ctx.clearRect(0, 0, w, h);
  const steps = 120;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < o.voices; i++) {
    const color = colorForPart(i, o.voices);
    const k = i - (o.voices - 1) / 2;
    const pts: [number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const env = Math.pow(Math.sin(Math.PI * u), 1.25);
      const wave = Math.sin(u * (2.3 + i * 0.31) * Math.PI + t * (0.42 + i * 0.05) + i * 1.7) * o.amp;
      const swell = Math.sin(u * Math.PI * 1.15 + t * 0.23) * o.amp * 0.55;
      const breathe = 1 + Math.sin(t * 0.3 + i * 0.8) * 0.12;
      pts.push([o.x0 + (o.x1 - o.x0) * u, o.cy + k * o.gap * env * breathe + wave * env * 0.8 + swell * (0.3 + env * 0.7)]);
    }
    const trace = () => {
      ctx.beginPath();
      pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    };
    trace();
    ctx.strokeStyle = withAlpha(color, 0.07);
    ctx.lineWidth = o.halo ?? 14;
    ctx.stroke();
    trace();
    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.lineWidth = o.line ?? 2.4;
    ctx.stroke();
    for (let b = 0; b < 3; b++) {
      const u = (((t * (0.035 + i * 0.006) + b / 3 + i * 0.13) % 1) + 1) % 1;
      const [bx, by] = pts[Math.round(u * steps)];
      const a = Math.sin(Math.PI * u);
      ctx.fillStyle = withAlpha(color, 0.85 * a);
      ctx.beginPath();
      ctx.arc(bx, by, (o.bead ?? 3.2) * (0.6 + 0.4 * a), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const span = o.x1 - o.x0;
  const fadeL = ctx.createLinearGradient(o.x0, 0, o.x0 + span * 0.22, 0);
  fadeL.addColorStop(0, 'rgba(0,0,0,1)');
  fadeL.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fadeL;
  ctx.fillRect(0, 0, o.x0 + span * 0.22, h);
  const fadeR = ctx.createLinearGradient(o.x1 - span * 0.12, 0, o.x1, 0);
  fadeR.addColorStop(0, 'rgba(0,0,0,0)');
  fadeR.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = fadeR;
  ctx.fillRect(o.x1 - span * 0.12, 0, w, h);
  ctx.restore();
}

/** The app mark: four voice lines that part and meet again. `withTile` adds the app-icon tile. */
export function drawMark(ctx: CanvasRenderingContext2D, size: number, withTile: boolean) {
  ctx.clearRect(0, 0, size, size);
  if (withTile) {
    const r = size * 0.24;
    ctx.fillStyle = '#17151F';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(size, 0, size, size, r);
    ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r);
    ctx.arcTo(0, 0, size, 0, r);
    ctx.fill();
  }
  const x0 = size * (withTile ? 0.19 : 0.06);
  const x1 = size * (withTile ? 0.81 : 0.94);
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, size * (withTile ? 0.05 : 0.065));
  for (let i = 0; i < 4; i++) {
    const k = i - 1.5;
    ctx.beginPath();
    for (let s = 0; s <= 48; s++) {
      const u = s / 48;
      const env = Math.sin(Math.PI * u);
      const x = x0 + (x1 - x0) * u;
      const y = size * 0.5 + k * size * (withTile ? 0.078 : 0.1) * env + Math.sin(u * Math.PI * 2 + i * 0.9) * size * 0.028 * env;
      if (s) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = colorForPart(i, 4);
    ctx.stroke();
  }
}

/** Per-voice pitch contour, sampled at even time steps and smoothed -- the input to a cover. */
export type CoverData = { contours: number[][]; lo: number; hi: number };

export function coverDataFromScore(score: Score): CoverData {
  const samples = 64;
  const total = Math.max(1, score.totalBeats);
  const contours: number[][] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const part of score.parts) {
    const notes = score.notes.filter((n) => n.partId === part.id).sort((a, b) => a.startBeat - b.startBeat);
    if (!notes.length) continue;
    let raw: number[] = [];
    for (let k = 0, j = 0; k <= samples; k++) {
      const at = (k / samples) * total;
      while (j + 1 < notes.length && notes[j + 1].startBeat <= at) j++;
      raw.push(notes[j].midi);
    }
    for (let pass = 0; pass < 3; pass++) raw = raw.map((m, k) => (k === 0 || k === raw.length - 1 ? m : (raw[k - 1] + 2 * m + raw[k + 1]) / 4));
    for (const m of raw) {
      lo = Math.min(lo, m);
      hi = Math.max(hi, m);
    }
    contours.push(raw);
  }
  if (!contours.length) return { contours: [], lo: 60, hi: 72 };
  return { contours, lo: lo - 2, hi: Math.max(hi + 2, lo + 6) };
}

/**
 * A song's cover: its own voice lines, smoothed into ribbons in the voice colours over two soft
 * glows (top voice and bottom voice). Same piece, same picture, on every device.
 */
export function drawCover(ctx: CanvasRenderingContext2D, w: number, h: number, data: CoverData) {
  const count = data.contours.length;
  ctx.fillStyle = '#15131F';
  ctx.fillRect(0, 0, w, h);
  if (!count) return;
  const top = colorForPart(0, count);
  const bottom = colorForPart(count - 1, count);
  const g1 = ctx.createRadialGradient(w * 0.82, h * 0.12, 0, w * 0.82, h * 0.12, w * 0.75);
  g1.addColorStop(0, withAlpha(top, 0.22));
  g1.addColorStop(1, withAlpha(top, 0));
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, w, h);
  const g2 = ctx.createRadialGradient(w * 0.12, h * 1.05, 0, w * 0.12, h * 1.05, w * 0.8);
  g2.addColorStop(0, withAlpha(bottom, 0.2));
  g2.addColorStop(1, withAlpha(bottom, 0));
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, w, h);

  const scale = Math.max(0.6, Math.min(1.4, w / 260));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  data.contours.forEach((contour, i) => {
    const color = colorForPart(i, count);
    const n = contour.length - 1;
    const pts = contour.map((m, k) => [w * 0.05 + (k / n) * w * 0.9, h * 0.86 - ((m - data.lo) / (data.hi - data.lo)) * h * 0.72] as const);
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let j = 1; j < pts.length; j++) {
        const [px, py] = pts[j - 1];
        const [x, y] = pts[j];
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      }
      ctx.lineTo(pts[n][0], pts[n][1]);
    };
    trace();
    ctx.strokeStyle = withAlpha(color, 0.12);
    ctx.lineWidth = 7 * scale;
    ctx.stroke();
    trace();
    ctx.strokeStyle = withAlpha(color, 0.95);
    ctx.lineWidth = 1.7 * scale;
    ctx.stroke();
  });
  ctx.restore();
}

/**
 * Runs drawRibbons on `canvas` every frame (~30fps) until the returned stop function is called.
 * Draws a single still frame for people who ask for reduced motion, and skips frames while the
 * tab is hidden.
 */
export function animateRibbons(canvas: HTMLCanvasElement, layout: (w: number, h: number) => RibbonOptions): () => void {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  let last = 0;
  const start = performance.now();
  const frame = (now: number) => {
    raf = still ? 0 : requestAnimationFrame(frame);
    if (!still && (document.hidden || now - last < 32)) return;
    last = now;
    const prepared = prepareCanvas(canvas);
    if (prepared) drawRibbons(prepared.ctx, prepared.w, prepared.h, still ? 12 : 12 + (now - start) / 1000, layout(prepared.w, prepared.h));
  };
  raf = requestAnimationFrame(frame);
  const onResize = () => {
    if (still) requestAnimationFrame(frame);
  };
  window.addEventListener('resize', onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  };
}

/** Sizes a canvas's backing store to its laid-out CSS size × devicePixelRatio (capped) and returns a ready context. */
export function prepareCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * ratio);
  const ph = Math.round(h * ratio);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}
