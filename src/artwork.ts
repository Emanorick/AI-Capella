import type { Score } from './score';
import { colorForPart } from './palette';
import { paperGrain, withAlpha } from './theme';
import { LOGO_DRAFT, PAPER_DESIGN, START_DRAFT, type LogoDraft } from './design';
import { drawLightRibbons, RibbonField } from './lightRibbons';
import { broadNib, pointAlong, pointedPen, type Pt } from './pen';

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
    const pts = ribbonPoints(i, o, t, steps);
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
  fadeEnds(ctx, w, h, o, 0.22, 0.12);
}

/** One voice's ribbon at time t: parting from the others in the middle, meeting them at both ends. */
export function ribbonPoints(i: number, o: RibbonOptions, t: number, steps: number, swing = 1): Pt[] {
  const k = i - (o.voices - 1) / 2;
  const pts: Pt[] = [];
  const amp = o.amp * swing;
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;
    const env = Math.pow(Math.sin(Math.PI * u), 1.25);
    const wave = Math.sin(u * (2.3 + i * 0.31) * Math.PI + t * (0.42 + i * 0.05) + i * 1.7) * amp;
    const swell = Math.sin(u * Math.PI * 1.15 + t * 0.23) * amp * 0.55;
    const breathe = 1 + Math.sin(t * 0.3 + i * 0.8) * 0.12;
    pts.push([o.x0 + (o.x1 - o.x0) * u, o.cy + k * o.gap * env * breathe + wave * env * 0.8 + swell * (0.3 + env * 0.7)]);
  }
  return pts;
}

/** Lets the ribbons melt into the ground at both ends. */
export function fadeEnds(ctx: CanvasRenderingContext2D, w: number, h: number, o: RibbonOptions, left: number, right: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const span = o.x1 - o.x0;
  const fadeL = ctx.createLinearGradient(o.x0, 0, o.x0 + span * left, 0);
  fadeL.addColorStop(0, 'rgba(0,0,0,1)');
  fadeL.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fadeL;
  ctx.fillRect(0, 0, o.x0 + span * left, h);
  const fadeR = ctx.createLinearGradient(o.x1 - span * right, 0, o.x1, 0);
  fadeR.addColorStop(0, 'rgba(0,0,0,0)');
  fadeR.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = fadeR;
  ctx.fillRect(o.x1 - span * right, 0, w, h);
  ctx.restore();
}

/**
 * Paper design: the title screen's voice lines written by a pen, left to right, while they already
 * sway gently. `progress[i]` is how far voice i has been written (0..1); `glow` (0..1) brings in
 * what follows once every line has arrived: the lines swing out fully, glow and carry their beads,
 * as the ribbons always have.
 *   draft '1': a broad nib, all voices written together;
 *   draft '2': a pointed pen, the voices one after another from the highest down -- like the
 *              starting tones, then the chord.
 */
export function drawPenRibbons(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, o: RibbonOptions, progress: number[], glow: number, draft: LogoDraft) {
  ctx.clearRect(0, 0, w, h);
  const steps = 140;
  const line = o.line ?? 2.4;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < o.voices; i++) {
    const p = progress[i];
    if (p <= 0) continue;
    const color = colorForPart(i, o.voices);
    const pts = ribbonPoints(i, o, t, steps, 0.6 + 0.4 * glow);
    if (glow > 0) {
      ctx.beginPath();
      pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = withAlpha(color, 0.07 * glow);
      ctx.lineWidth = o.halo ?? 14;
      ctx.stroke();
    }
    const stroke = new Path2D();
    if (draft === '1') broadNib(stroke, pts, { w: line * 3.1, angle: 30, floor: 0.14, taper: 0.06, upTo: p });
    else pointedPen(stroke, pts, { w: line * 3.4, hair: Math.max(0.8, line * 0.34), taper: 0.06, upTo: p });
    ctx.fillStyle = withAlpha(color, 0.92);
    ctx.fill(stroke, 'nonzero');
    if (p < 1) {
      // The pen's point: a small bright spot where the ink is going down.
      const [px, py] = pointAlong(pts, p);
      const spot = ctx.createRadialGradient(px, py, 0, px, py, line * 5);
      spot.addColorStop(0, withAlpha(color, 0.5));
      spot.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = spot;
      ctx.fillRect(px - line * 5, py - line * 5, line * 10, line * 10);
      ctx.fillStyle = 'rgba(255,250,242,0.9)';
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.2, line * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    if (glow > 0) {
      for (let b = 0; b < 3; b++) {
        const u = (((t * (0.035 + i * 0.006) + b / 3 + i * 0.13) % 1) + 1) % 1;
        const [bx, by] = pts[Math.round(u * steps)];
        const a = Math.sin(Math.PI * u) * glow;
        ctx.fillStyle = withAlpha(color, 0.85 * a);
        ctx.beginPath();
        ctx.arc(bx, by, (o.bead ?? 3.2) * (0.6 + 0.4 * a), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
  fadeEnds(ctx, w, h, o, 0.08, 0.08);
}

/** How far each voice has been written `sec` seconds into the title animation, and when all are done. */
export function writing(draft: LogoDraft, voices: number, sec: number): { progress: number[]; done: number } {
  const start = (i: number) => (draft === '1' ? i * 0.12 : i * 0.42);
  const dur = draft === '1' ? 2.4 : 1.35;
  const ease = (u: number) => 0.35 * u * u * (3 - 2 * u) + 0.65 * u;
  const progress = Array.from({ length: voices }, (_, i) => ease(Math.min(1, Math.max(0, (sec - start(i)) / dur))));
  return { progress, done: start(voices - 1) + dur };
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
  if (PAPER_DESIGN) {
    // Written with a pointed pen, as in the title animation (and the app icon, public/icon-*.png).
    for (let i = 0; i < 4; i++) {
      const k = i - 1.5;
      const pts: Pt[] = [];
      for (let s = 0; s <= 48; s++) {
        const u = s / 48;
        const env = Math.sin(Math.PI * u);
        pts.push([x0 + (x1 - x0) * u, size * 0.5 + k * size * (withTile ? 0.105 : 0.12) * env + Math.sin(u * Math.PI * 2 + i * 0.9) * size * 0.03 * env]);
      }
      const stroke = new Path2D();
      pointedPen(stroke, pts, { w: Math.max(2, size * (withTile ? 0.052 : 0.07)), hair: Math.max(0.9, size * 0.018), taper: 0.12 });
      ctx.fillStyle = colorForPart(i, 4);
      ctx.fill(stroke, 'nonzero');
    }
    return;
  }
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
  if (PAPER_DESIGN) {
    drawPenCover(ctx, w, h, data);
    return;
  }
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

/** Paper design: the song's voice lines written with a broad nib in the voice colours on night paper. */
function drawPenCover(ctx: CanvasRenderingContext2D, w: number, h: number, data: CoverData) {
  const count = data.contours.length;
  ctx.fillStyle = '#1b1621';
  ctx.fillRect(0, 0, w, h);
  paperGrain(ctx, w, h);
  if (!count) return;
  const scale = Math.max(0.6, Math.min(1.4, w / 260));
  data.contours.forEach((contour, i) => {
    const n = contour.length - 1;
    const at = contour.map((m, k) => [w * 0.05 + (k / n) * w * 0.9, h * 0.86 - ((m - data.lo) / (data.hi - data.lo)) * h * 0.72] as Pt);
    // The same smoothing as the ribbon covers (quadratic curves through the midpoints), sampled.
    const pts: Pt[] = [at[0]];
    for (let j = 1; j < at.length; j++) {
      const [px, py] = at[j - 1];
      const from = pts[pts.length - 1];
      const to: Pt = j === at.length - 1 ? at[j] : [(px + at[j][0]) / 2, (py + at[j][1]) / 2];
      for (let s = 1; s <= 6; s++) {
        const u = s / 6;
        pts.push([(1 - u) * (1 - u) * from[0] + 2 * u * (1 - u) * px + u * u * to[0], (1 - u) * (1 - u) * from[1] + 2 * u * (1 - u) * py + u * u * to[1]]);
      }
    }
    const stroke = new Path2D();
    broadNib(stroke, pts, { w: 3.6 * scale, angle: 35, floor: 0.22, taper: 0.05 });
    ctx.fillStyle = withAlpha(colorForPart(i, count), 0.95);
    ctx.fill(stroke, 'nonzero');
  });
}

/**
 * Runs drawRibbons on `canvas` every frame (~30fps) until the returned stop function is called.
 * Draws a single still frame for people who ask for reduced motion, and skips frames while the
 * tab is hidden.
 */
export function animateRibbons(canvas: HTMLCanvasElement, layout: (w: number, h: number) => RibbonOptions): () => void {
  // (In the paper design the lines are first written by a pen -- see drawPenRibbons.)
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0;
  let last = 0;
  const start = performance.now();
  // The draft title screen: lines of light that answer the pointer (see lightRibbons.ts).
  const field = START_DRAFT && !still && canvas.parentElement ? new RibbonField(canvas.parentElement, canvas) : null;
  const frame = (now: number) => {
    raf = still ? 0 : requestAnimationFrame(frame);
    // About 30 frames a second; the interactive draft runs at the full rate (strings, sparks).
    if (!still && (document.hidden || now - last < (field ? 0 : 32))) return;
    field?.step(Math.min(0.1, (now - last) / 1000), now / 1000);
    last = now;
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const sec = still ? 99 : (now - start) / 1000;
    const o = layout(prepared.w, prepared.h);
    if (START_DRAFT) {
      const { progress, done } = writing(LOGO_DRAFT, o.voices, sec);
      const lit = Math.min(1, Math.max(0, (sec - done) / 1.4));
      drawLightRibbons(prepared.ctx, prepared.w, prepared.h, 12 + sec, o, progress, lit * lit * (3 - 2 * lit), field, now / 1000);
    } else if (PAPER_DESIGN) {
      const { progress, done } = writing(LOGO_DRAFT, o.voices, sec);
      const glow = Math.min(1, Math.max(0, (sec - done) / 1.4));
      drawPenRibbons(prepared.ctx, prepared.w, prepared.h, 12 + sec, o, progress, glow * glow * (3 - 2 * glow), LOGO_DRAFT);
    } else drawRibbons(prepared.ctx, prepared.w, prepared.h, still ? 12 : 12 + sec, o);
  };
  raf = requestAnimationFrame(frame);
  const onResize = () => {
    if (still) requestAnimationFrame(frame);
  };
  window.addEventListener('resize', onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    field?.dispose();
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
