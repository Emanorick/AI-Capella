// Draft of the next title screen (design.ts START_DRAFT): the voice lines, written by the pen as
// before, become figures of light -- a thin bright core in each voice's colour inside a soft glow
// that fades out gently (composed at a quarter of the resolution and scaled up, so it has no hard
// edge). They answer the hand: near the pointer they give way a little; a click or tap draws them
// toward it for a moment, with a brief flare of light where it landed.

import { colorForPart } from './palette';
import { withAlpha } from './theme';
import { pointAlong, pointedPen, type Pt } from './pen';
import { fadeEnds, ribbonPoints, type RibbonOptions } from './artwork';

const GLOW_SCALE = 0.25;
const EVADE_PX = 26; // how far the lines give way right under the pointer
const PULL = 0.5; // how much of the way to a click the lines go, at its strongest
const PULL_SEC = 1.3; // how long a click's pull lasts

type Pull = { x: number; y: number; t0: number };

/** Where the hand is, and the clicks still pulling -- fed by pointer events, read every frame. */
export class RibbonField {
  private pointer: { x: number; y: number } | null = null;
  private presence = 0; // eases toward 1 while the pointer is over the lines' area, else 0
  private pulls: Pull[] = [];
  private lastInput = 0;

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

  /** True shortly after any input -- the animation runs at full frame rate then. */
  get lively(): boolean {
    return performance.now() - this.lastInput < 2000 || this.pulls.length > 0 || this.presence > 0.01;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onMove = (e: PointerEvent) => {
    this.pointer = this.local(e);
    this.lastInput = performance.now();
  };

  private onDown = (e: PointerEvent) => {
    // Buttons keep their own meaning; everywhere else a press draws the lines to it.
    if ((e.target as HTMLElement).closest('button')) return;
    const p = this.local(e);
    this.pulls.push({ ...p, t0: performance.now() / 1000 });
    if (this.pulls.length > 4) this.pulls.shift();
    this.lastInput = performance.now();
  };

  private onLeave = () => {
    this.pointer = null;
  };

  /** Advances the easing by dt seconds. */
  step(dt: number, now: number) {
    const target = this.pointer ? 1 : 0;
    this.presence += (target - this.presence) * Math.min(1, dt * 5);
    this.pulls = this.pulls.filter((p) => now - p.t0 < PULL_SEC * 3);
  }

  /** Bends a line's points: away from the pointer, toward recent clicks. */
  bend(pts: Pt[], h: number, now: number): Pt[] {
    const reach = Math.min(170, h * 0.28);
    const pullReach = Math.min(300, h * 0.5);
    return pts.map(([x, y]) => {
      let dy = 0;
      if (this.pointer && this.presence > 0.001) {
        const ox = x - this.pointer.x;
        const oy = y - this.pointer.y;
        const f = Math.exp(-(ox * ox + oy * oy) / (reach * reach));
        dy += (oy / (Math.abs(oy) + 14)) * EVADE_PX * f * this.presence;
      }
      for (const p of this.pulls) {
        const t = now - p.t0;
        const a = (1 - Math.exp(-t / 0.14)) * Math.exp(-t / PULL_SEC);
        const f = Math.exp(-((x - p.x) * (x - p.x)) / (pullReach * pullReach));
        dy += (p.y - y) * PULL * a * f;
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
    return { color: colorForPart(i, o.voices), pts: field ? field.bend(pts, h, now) : pts, p: progress[i] };
  });

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
        const [bx, by] = pts[Math.round(u * steps)];
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
