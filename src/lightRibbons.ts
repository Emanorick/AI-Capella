// Draft of the next title screen (design.ts START_DRAFT): the voice lines, written by the pen as
// before, become figures of light -- a thin bright core in each voice's colour inside a soft glow
// that fades out gently (composed at a quarter of the resolution and scaled up, so it has no hard
// edge). They answer the hand: moving across a line plucks it like a string; a click or tap draws
// them toward it for a moment, with a brief flare of light where it landed.

import { colorForPart } from './palette';
import { withAlpha } from './theme';
import { pointAlong, pointedPen, type Pt } from './pen';
import { fadeEnds, ribbonPoints, type RibbonOptions } from './artwork';

const GLOW_SCALE = 0.25;
const PULL = 0.5; // how much of the way to a click the lines go, at its strongest
const PULL_SEC = 1.3; // how long a click's pull lasts
// The lines as strings: caught where the pointer crosses one, drawn along with it for a little way,
// then let go -- they ring out as a damped wave running along the line.
const STRING_SUBSTEPS = 4;
const STRING_DAMPING = 1.6; // per second
const STRING_SPEED = 2.2; // line lengths per second
const STRING_SMOOTHING = 10; // damps short ripples much more than the long swing, so no kinks run along
const HOLD_SPREAD = 2.2; // samples: the finger holds a rounded stretch of the line, not a point

type Pull = { x: number; y: number; t0: number };
type Pointer = { x: number; y: number };
type Str = { disp: Float32Array; vel: Float32Array; caught: boolean; prevRel: number | null };

/** Where the hand is, the clicks still pulling, and the strings' motion -- fed by pointer events. */
export class RibbonField {
  private pointer: Pointer | null = null;
  private prevPointer: Pointer | null = null;
  private pulls: Pull[] = [];
  private strings: Str[] = [];
  private dt = 0;

  private readonly target: HTMLElement;
  private readonly canvas: HTMLCanvasElement;

  constructor(target: HTMLElement, canvas: HTMLCanvasElement) {
    this.target = target;
    this.canvas = canvas;
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('pointerleave', this.onLeave);
  }

  dispose() {
    this.target.removeEventListener('pointermove', this.onMove);
    this.target.removeEventListener('pointerdown', this.onDown);
    this.target.removeEventListener('pointerleave', this.onLeave);
  }

  private local(e: PointerEvent): Pointer {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onMove = (e: PointerEvent) => {
    this.pointer = this.local(e);
  };

  private onDown = (e: PointerEvent) => {
    // Buttons keep their own meaning; everywhere else a press draws the lines to it.
    if ((e.target as HTMLElement).closest('button')) return;
    const p = this.local(e);
    this.pointer = p;
    this.pulls.push({ ...p, t0: performance.now() / 1000 });
    if (this.pulls.length > 4) this.pulls.shift();
  };

  private onLeave = () => {
    this.pointer = null;
  };

  /** Called once per frame before the lines are drawn: dt seconds since the last frame. */
  step(dt: number, now: number) {
    this.dt = dt;
    this.pulls = this.pulls.filter((p) => now - p.t0 < PULL_SEC * 3);
  }

  /** Called after the lines of a frame: the pointer's position now becomes "before". */
  endFrame() {
    this.prevPointer = this.pointer ? { ...this.pointer } : null;
  }

  /**
   * Moves line i's string on by this frame (catching it where the pointer crosses, letting it go
   * once pulled too far) and returns the line bent by it and by recent clicks.
   */
  bend(i: number, pts: Pt[], h: number, now: number): Pt[] {
    const n = pts.length - 1;
    const str = (this.strings[i] ??= { disp: new Float32Array(n + 1), vel: new Float32Array(n + 1), caught: false, prevRel: null });
    if (str.disp.length !== n + 1) {
      str.disp = new Float32Array(n + 1);
      str.vel = new Float32Array(n + 1);
    }
    const { disp, vel } = str;
    const x0 = pts[0][0];
    const dx = (pts[n][0] - x0) / n;
    const maxPull = Math.min(70, h * 0.1);
    const p = this.pointer;
    let held = -1; // centre of the stretch held by the pointer
    if (p && p.x > x0 && p.x < pts[n][0]) {
      const j = Math.min(n - 4, Math.max(4, Math.round((p.x - x0) / dx)));
      const rest = pts[j][1];
      const rel = p.y - (rest + disp[j]);
      // Crossing the string catches it.
      if (!str.caught && str.prevRel !== null && this.prevPointer && Math.sign(rel) !== Math.sign(str.prevRel) && Math.abs(rel) < maxPull) str.caught = true;
      if (str.caught) {
        const pull = p.y - rest;
        if (Math.abs(pull) > maxPull) str.caught = false; // slips off and rings
        else held = j;
        if (held >= 0) {
          for (let k = -3; k <= 3; k++) {
            const w = Math.exp(-((k / HOLD_SPREAD) ** 2));
            disp[j + k] = disp[j + k] * (1 - w) + pull * w;
            vel[j + k] *= 1 - w;
          }
        }
      }
      str.prevRel = str.caught ? 0 : rel;
    } else {
      str.caught = false;
      str.prevRel = null;
    }
    // The wave equation, damped, both ends fixed where the voices meet.
    // Enough steps a second (c * step < 1 sample) whatever the frame rate, so it stays stable.
    const sub = Math.max(STRING_SUBSTEPS, Math.ceil(this.dt * STRING_SPEED * n * 1.6));
    const h2 = this.dt / sub;
    const c = STRING_SPEED * n; // in samples per second
    for (let s = 0; s < sub && this.dt > 0; s++) {
      for (let j = 1; j < n; j++) {
        if (j === held) {
          vel[j] = 0;
          continue;
        }
        vel[j] +=
          (c * c * (disp[j - 1] - 2 * disp[j] + disp[j + 1]) + STRING_SMOOTHING * (vel[j - 1] - 2 * vel[j] + vel[j + 1]) - STRING_DAMPING * vel[j]) * h2;
      }
      for (let j = 1; j < n; j++) if (j !== held) disp[j] += vel[j] * h2;
    }
    const pullReach = Math.min(300, h * 0.5);
    return pts.map(([x, y], j) => {
      let dy = disp[j];
      for (const q of this.pulls) {
        const t = now - q.t0;
        const a = (1 - Math.exp(-t / 0.14)) * Math.exp(-t / PULL_SEC);
        const f = Math.exp(-((x - q.x) * (x - q.x)) / (pullReach * pullReach));
        dy += (q.y - y) * PULL * a * f;
      }
      return [x, y + dy];
    });
  }

  /** Recent clicks, with how bright their flare still is (0..1). */
  flares(now: number): { x: number; y: number; k: number }[] {
    return this.pulls.map((p) => {
      const t = now - p.t0;
      return { x: p.x, y: p.y, k: (1 - Math.exp(-t / 0.06)) * Math.exp(-t / 0.7) };
    });
  }
}

/** The point at fraction u (0..1) along a line of evenly spaced samples, between samples too. */
function sampleAt(pts: Pt[], u: number): Pt {
  const f = u * (pts.length - 1);
  const j = Math.min(pts.length - 2, Math.floor(f));
  const k = f - j;
  return [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * k, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * k];
}

let glowLayer: HTMLCanvasElement | null = null;

/**
 * One frame: `progress[i]` how far voice i has been written, `lit` (0..1) how far the lines have
 * turned to light and swung out after the writing.
 */
export function drawLightRibbons(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, o: RibbonOptions, progress: number[], lit: number, field: RibbonField | null, now: number) {
  ctx.clearRect(0, 0, w, h);
  const steps = 140;
  const line = o.line ?? 2.4;
  const halo = o.halo ?? 14;
  const lines = Array.from({ length: o.voices }, (_, i) => {
    const pts = ribbonPoints(i, o, t, steps, 0.6 + 0.4 * lit);
    return { color: colorForPart(i, o.voices), pts: field ? field.bend(i, pts, h, now) : pts, p: progress[i] };
  });
  field?.endFrame();

  // The glow: the lines drawn wide and faint at a quarter of the size, in three widths, then
  // scaled up -- which blurs it into a soft fall-off.
  const gw = Math.max(1, Math.ceil(w * GLOW_SCALE));
  const gh = Math.max(1, Math.ceil(h * GLOW_SCALE));
  const layer = (glowLayer ??= document.createElement('canvas'));
  if (layer.width !== gw || layer.height !== gh) {
    layer.width = gw;
    layer.height = gh;
  }
  const g = layer.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, gw, gh);
  g.scale(GLOW_SCALE, GLOW_SCALE);
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const glowK = 0.35 + 0.65 * lit;
  for (const { color, pts, p } of lines) {
    if (p <= 0) continue;
    const upTo = Math.max(2, Math.round(p * steps));
    for (const [width, alpha] of [[halo * 0.6, 0.12], [halo * 1.3, 0.07], [halo * 2.6, 0.04]] as const) {
      g.beginPath();
      for (let j = 0; j <= upTo; j++) (j ? g.lineTo : g.moveTo).call(g, pts[j][0], pts[j][1]);
      g.strokeStyle = withAlpha(color, alpha * glowK);
      g.lineWidth = width;
      g.stroke();
    }
  }
  if (field) {
    for (const f of field.flares(now)) {
      if (f.k < 0.01) continue;
      const r = Math.min(90, h * 0.14);
      const flare = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      flare.addColorStop(0, `rgba(255,226,186,${0.75 * f.k})`);
      flare.addColorStop(0.3, `rgba(255,200,150,${0.22 * f.k})`);
      flare.addColorStop(1, 'rgba(255,200,150,0)');
      g.fillStyle = flare;
      g.fillRect(f.x - r, f.y - r, r * 2, r * 2);
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(layer, 0, 0, gw, gh, 0, 0, gw / GLOW_SCALE, gh / GLOW_SCALE);

  // The lines themselves: pen strokes in the voice colour with a thin bright core, like a trace of
  // light in a long exposure.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const { color, pts, p } of lines) {
    if (p <= 0) continue;
    const stroke = new Path2D();
    pointedPen(stroke, pts, { w: line * 3.2, hair: Math.max(0.8, line * 0.34), taper: 0.06, upTo: p });
    ctx.fillStyle = withAlpha(color, 0.85);
    ctx.fill(stroke, 'nonzero');
    if (lit > 0) {
      const upTo = Math.max(2, Math.round(p * steps));
      ctx.beginPath();
      for (let j = 0; j <= upTo; j++) (j ? ctx.lineTo : ctx.moveTo).call(ctx, pts[j][0], pts[j][1]);
      ctx.strokeStyle = `rgba(255,250,242,${0.55 * lit})`;
      ctx.lineWidth = Math.max(0.6, line * 0.3);
      ctx.stroke();
    }
    if (p < 1) {
      // The pen's point: a spark where the light is being drawn.
      const [px, py] = pointAlong(pts, p);
      const spot = ctx.createRadialGradient(px, py, 0, px, py, line * 7);
      spot.addColorStop(0, withAlpha(color, 0.6));
      spot.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = spot;
      ctx.fillRect(px - line * 7, py - line * 7, line * 14, line * 14);
      ctx.fillStyle = 'rgba(255,250,242,0.95)';
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.3, line * 0.65), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Sparks travelling along the lines once they are lit.
  if (lit > 0) {
    lines.forEach(({ color, pts }, i) => {
      for (let b = 0; b < 3; b++) {
        const u = (((t * (0.035 + i * 0.006) + b / 3 + i * 0.13) % 1) + 1) % 1;
        const [bx, by] = sampleAt(pts, u);
        const a = Math.sin(Math.PI * u) * lit;
        const r = (o.bead ?? 3.2) * (0.6 + 0.4 * a);
        const spark = ctx.createRadialGradient(bx, by, 0, bx, by, r * 3.5);
        spark.addColorStop(0, `rgba(255,250,242,${0.9 * a})`);
        spark.addColorStop(0.3, withAlpha(color, 0.6 * a));
        spark.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = spark;
        ctx.fillRect(bx - r * 3.5, by - r * 3.5, r * 7, r * 7);
      }
    });
  }
  ctx.restore();
  // Where all the voices meet at the ends their light would pile up to white -- let it fade there.
  fadeEnds(ctx, w, h, o, 0.2, 0.18);
}
