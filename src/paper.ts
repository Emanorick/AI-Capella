// The paper of the paper design (design.ts). One texture, made on the device when the app starts
// (seeded, so the same everywhere), and used by every paper surface: the CSS ones -- the ground,
// the song cards, the bars, the sheets -- as a background image (--fibre), the canvases -- the
// punched roll, the sheet view, the covers -- as a pattern.
//
// On the moving score the paper moves with the music, as the sheet the music is printed on would:
// anchored to beat 0 and the top row, stretched with the music when it is zoomed. Stretched past
// twice or half its size its fibres would turn into streaks or a blur, so it is drawn as two layers
// an octave of scale apart that cross-fade as the zoom goes on (as an endless zoom does): each layer
// stays put on the music, the grain keeps its size.
//
// Held against the lamp at the reading line, paper shows its inside: the clouds of more and less
// fibre (its formation), long fibres as dark strands, in laid paper the lines of the mould. That is
// a second texture, of what light passes through, shown in a strip around the lamp (backlight()).
//
// Four kinds: Vergé (laid paper, its lines showing in the light -- everyone's), and on a device
// (?papier=… or the menu) Nachtpapier (fine fibres along the roll), Bütten (handmade: cloudy,
// rough, flecks) or Washi (Japanese paper, long silky fibres). The parchment design (design.ts)
// has its own: Pergament -- skin, not pulp: cloudy, with the pores where hair was and faint veins,
// glowing amber against the lamp.

import { deviceChoice, PARCHMENT } from './design';

export type PaperKind = 'nacht' | 'buetten' | 'verge' | 'washi' | 'pergament';
/** The kinds of night paper a device can choose (the parchment design has only parchment). */
export const PAPER_KINDS: readonly PaperKind[] = ['verge', 'nacht', 'buetten', 'washi'];
/** Everyone's paper, unless a device chose another: Vergé, chosen in October 2026. */
export const DEFAULT_PAPER: PaperKind = 'verge';

/** The paper's own colour (the roll, the sheet view, the covers): night paper, or parchment. */
export const NIGHT_PAPER = PARCHMENT ? '#E8D8B6' : '#1b1621';

const N = 512; // the tile, in texture pixels
const TS = 0.5; // CSS px per texture pixel: a tile is 256 px wide, and crisp on a 2x screen

let kind: PaperKind = PARCHMENT ? 'pergament' : deviceChoice('papier', 'ai-capella-papier', PAPER_KINDS, DEFAULT_PAPER);
type Tiles = { surface: HTMLCanvasElement; light: HTMLCanvasElement };
const made = new Map<PaperKind, Tiles>();

export function paperKind(): PaperKind {
  return kind;
}

/** Switches this device to another paper (remembered), and tells the views to paint it. */
export function setPaperKind(next: PaperKind) {
  if (next === kind) return;
  kind = next;
  try {
    if (next === DEFAULT_PAPER) localStorage.removeItem('ai-capella-papier');
    else localStorage.setItem('ai-capella-papier', next);
  } catch {
    /* for this visit only */
  }
  // (The others were only made for the chooser's previews.)
  for (const k of made.keys()) if (k !== next) made.delete(k);
  composed.clear();
  applyCss();
  window.dispatchEvent(new Event('paperchange'));
}

// ---- making the texture -------------------------------------------------------------------------

function random(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Value noise that wraps around the tile: `cx` x `cy` cells, smooth between them, -1..1. */
function noise(cx: number, cy: number, rnd: () => number): Float32Array {
  const grid = Float32Array.from({ length: cx * cy }, () => rnd() * 2 - 1);
  const out = new Float32Array(N * N);
  const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const sx = new Float32Array(N);
  const ix = new Int32Array(N);
  for (let x = 0; x < N; x++) {
    const f = (x / N) * cx;
    ix[x] = Math.floor(f);
    sx[x] = smooth(f - ix[x]);
  }
  for (let y = 0; y < N; y++) {
    const f = (y / N) * cy;
    const iy = Math.floor(f);
    const ty = smooth(f - iy);
    const r0 = iy * cx;
    const r1 = ((iy + 1) % cy) * cx;
    for (let x = 0; x < N; x++) {
      const a = ix[x];
      const b = (a + 1) % cx;
      const top = grid[r0 + a] + (grid[r0 + b] - grid[r0 + a]) * sx[x];
      const bottom = grid[r1 + a] + (grid[r1 + b] - grid[r1 + a]) * sx[x];
      out[y * N + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

/** Octaves of noise added up ([cells across, cells down, weight]), scaled to about -1..1. */
function fbm(octaves: [number, number, number][], rnd: () => number): Float32Array {
  const out = new Float32Array(N * N);
  for (const [cx, cy, w] of octaves) {
    const n = noise(cx, cy, rnd);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * w;
  }
  let sq = 0;
  for (let i = 0; i < out.length; i++) sq += out[i] * out[i];
  const k = 1 / (2 * Math.sqrt(sq / out.length) || 1);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

interface Fibre {
  pts: [number, number][];
  width: number;
  shade: number; // > 0 lighter than the paper, < 0 darker (on its surface)
  block: number; // how much light it holds back, seen against the lamp (0..1)
}

interface Recipe {
  seed: number;
  formation: [number, number, number][]; // the soft mottling seen on the surface
  flocs: [number, number, number][]; // the clumps of fibre that show against the light
  tooth: [number, number, number][];
  surface: { formation: number; tooth: number; laid: number; chain: number };
  light: { formation: number; tooth: number; laid: number; chain: number };
  laid?: { period: number; chains: number };
  fibres: (rnd: () => number) => Fibre[];
  flecks: number;
  /** Made for a light ground (parchment): its shades in umber rather than black. */
  onLight?: boolean;
}

/** A short fibre: a few points along a gently bending line. */
function strand(rnd: () => number, length: number, angle: number, bend: number, segments: number): [number, number][] {
  let x = rnd() * N;
  let y = rnd() * N;
  let a = angle;
  const step = length / segments;
  const pts: [number, number][] = [[x, y]];
  for (let i = 0; i < segments; i++) {
    a += (rnd() - 0.5) * bend;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    pts.push([x, y]);
  }
  return pts;
}

const pick = (rnd: () => number, lo: number, hi: number) => lo + rnd() * (hi - lo);

const RECIPES: Record<PaperKind, Recipe> = {
  // Machine-made night paper: fine fibres lying along the roll, a soft formation.
  nacht: {
    seed: 11,
    formation: [[4, 8, 1], [8, 16, 0.5], [16, 32, 0.25]],
    flocs: [[16, 32, 1], [32, 64, 0.6], [64, 128, 0.35]],
    tooth: [[128, 256, 1], [256, 512, 0.6]],
    surface: { formation: 0.45, tooth: 0.35, laid: 0, chain: 0 },
    light: { formation: 0.8, tooth: 0.3, laid: 0, chain: 0 },
    fibres: (rnd) =>
      Array.from({ length: 1500 }, () => {
        const light = rnd() < 0.55;
        return { pts: strand(rnd, pick(rnd, 8, 34), (rnd() - 0.5) * 0.25, 0.25, 3), width: pick(rnd, 0.6, 1.2), shade: light ? pick(rnd, 0.6, 1.4) : -pick(rnd, 0.6, 1.3), block: pick(rnd, 0.15, 0.35) };
      }),
    flecks: 40,
  },
  // Handmade: clouds of fibre, a rough tooth, fibres every way, flecks.
  buetten: {
    seed: 23,
    formation: [[3, 3, 1], [6, 6, 0.65], [12, 12, 0.4], [24, 24, 0.22]],
    flocs: [[8, 8, 1], [16, 16, 0.75], [32, 32, 0.5], [64, 64, 0.3]],
    tooth: [[96, 96, 1], [192, 192, 0.7], [384, 384, 0.4]],
    surface: { formation: 0.85, tooth: 0.55, laid: 0, chain: 0 },
    light: { formation: 1.1, tooth: 0.4, laid: 0, chain: 0 },
    fibres: (rnd) =>
      Array.from({ length: 1900 }, () => {
        const light = rnd() < 0.5;
        return { pts: strand(rnd, pick(rnd, 6, 38), rnd() * Math.PI * 2, 0.9, 4), width: pick(rnd, 0.7, 1.6), shade: light ? pick(rnd, 0.8, 1.7) : -pick(rnd, 0.8, 1.7), block: pick(rnd, 0.2, 0.5) };
      }),
    flecks: 170,
  },
  // Laid paper: the wires of the mould leave fine lines across the sheet and the chains that held
  // them a few lines along it -- faint on the paper, clear against the light.
  verge: {
    seed: 37,
    formation: [[4, 4, 1], [8, 8, 0.5], [16, 16, 0.25]],
    flocs: [[12, 12, 1], [24, 24, 0.6], [48, 48, 0.3]],
    tooth: [[128, 128, 1], [256, 256, 0.5]],
    surface: { formation: 0.35, tooth: 0.3, laid: 0.14, chain: 0.08 },
    light: { formation: 0.55, tooth: 0.2, laid: 0.45, chain: 0.4 },
    laid: { period: 7, chains: 4 },
    fibres: (rnd) =>
      Array.from({ length: 650 }, () => {
        const light = rnd() < 0.5;
        return { pts: strand(rnd, pick(rnd, 6, 26), rnd() * Math.PI * 2, 0.6, 3), width: pick(rnd, 0.6, 1.1), shade: light ? pick(rnd, 0.5, 1.1) : -pick(rnd, 0.5, 1.1), block: pick(rnd, 0.15, 0.3) };
      }),
    flecks: 30,
  },
  // Japanese paper: a thin, even sheet with long fibres in it, silky on the surface, dark strands
  // against the light.
  washi: {
    seed: 53,
    formation: [[2, 2, 1], [4, 4, 0.6], [8, 8, 0.4]],
    flocs: [[6, 6, 1], [12, 12, 0.5], [24, 24, 0.25]],
    tooth: [[192, 192, 1]],
    surface: { formation: 0.45, tooth: 0.15, laid: 0, chain: 0 },
    light: { formation: 0.6, tooth: 0.1, laid: 0, chain: 0 },
    fibres: (rnd) => [
      ...Array.from({ length: 230 }, () => ({ pts: strand(rnd, pick(rnd, 70, 300), rnd() * Math.PI * 2, 0.35, 12), width: pick(rnd, 0.5, 1.5), shade: pick(rnd, 0.6, 1.6), block: pick(rnd, 0.45, 0.9) })),
      ...Array.from({ length: 900 }, () => ({ pts: strand(rnd, pick(rnd, 8, 30), rnd() * Math.PI * 2, 0.5, 3), width: pick(rnd, 0.5, 0.9), shade: rnd() < 0.6 ? pick(rnd, 0.4, 1) : -pick(rnd, 0.4, 0.9), block: pick(rnd, 0.2, 0.4) })),
    ],
    flecks: 25,
  },
  // Parchment: skin, not pulp. Clouds of thicker and thinner hide, the pores where the hair was in
  // little scattered groups, a few faint veins; against the lamp the clouds and veins show dark in
  // the amber light.
  pergament: {
    seed: 71,
    formation: [[2, 2, 1], [4, 4, 0.75], [8, 8, 0.45], [16, 16, 0.25]],
    flocs: [[3, 3, 1], [6, 6, 0.7], [12, 12, 0.4], [24, 24, 0.2]],
    tooth: [[160, 160, 1], [320, 320, 0.5]],
    surface: { formation: 0.7, tooth: 0.12, laid: 0, chain: 0 },
    light: { formation: 0.9, tooth: 0.08, laid: 0, chain: 0 },
    fibres: (rnd) =>
      Array.from({ length: 70 }, () => ({ pts: strand(rnd, pick(rnd, 60, 220), rnd() * Math.PI * 2, 0.5, 10), width: pick(rnd, 0.8, 2.2), shade: -pick(rnd, 0.25, 0.6), block: pick(rnd, 0.25, 0.5) })),
    flecks: 420,
    onLight: true,
  },
};

// How far a texture pixel may lighten or darken what is under it (alpha at full strength).
// (Kept quiet: the paper is felt more than seen -- it mustn't draw the eye from the music.)
const SURFACE_LIGHT = 0.055;
const SURFACE_DARK = 0.085;
// Against the lamp the paper only lets light through, more where it is thinner: light only.
const LIGHT_BRIGHT = 0.3;
const LIGHT_BASE = 0.35; // what passes even where it is thickest (relative)

/** One field (-1..1 or so) into a tile: lighter as warm white, darker as shade, both as alpha. */
function fieldTile(field: Float32Array, bright: [number, number, number], brightMax: number, darkMax: number, dark: [number, number, number] = [6, 4, 10]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const d = img.data;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    const o = i * 4;
    if (v >= 0) {
      d[o] = bright[0];
      d[o + 1] = bright[1];
      d[o + 2] = bright[2];
      d[o + 3] = Math.min(255, v * brightMax * 255);
    } else {
      d[o] = dark[0];
      d[o + 1] = dark[1];
      d[o + 2] = dark[2];
      d[o + 3] = Math.min(255, -v * darkMax * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Draws a fibre (or fleck) and its copies across the tile's edges, so the tile wraps. */
function wrapped(ctx: CanvasRenderingContext2D, pts: [number, number][], draw: (dx: number, dy: number) => void) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs) - 3, Math.max(...xs) + 3, Math.min(...ys) - 3, Math.max(...ys) + 3];
  for (const dx of [-N, 0, N]) {
    for (const dy of [-N, 0, N]) {
      if (x1 + dx < 0 || x0 + dx > N || y1 + dy < 0 || y0 + dy > N) continue;
      ctx.save();
      ctx.translate(dx, dy);
      draw(dx, dy);
      ctx.restore();
    }
  }
}

function path(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function make(k: PaperKind) {
  const r = RECIPES[k];
  const rnd = random(r.seed);
  const formation = fbm(r.formation, rnd);
  const flocs = fbm(r.flocs, rnd);
  const tooth = fbm(r.tooth, rnd);
  // The mould's lines: `laid` across (dense, a little irregular), `chain` along (a few, wavering).
  const laid = new Float32Array(N * N);
  const chain = new Float32Array(N * N);
  if (r.laid) {
    const { period, chains } = r.laid;
    const lines = Math.round(N / period);
    const wobble = noise(1, 8, rnd);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        // Laid lines run down the sheet (across the roll's direction), one every `period` px.
        const u = ((x + wobble[i] * 1.2) / N) * lines;
        laid[i] = Math.pow(Math.max(0, Math.cos(u * Math.PI * 2)), 2) * 1.6 - 0.5;
        const v = ((y + wobble[i] * 6) / N) * chains;
        const dist = Math.abs(v - Math.round(v)) * (N / chains);
        // (Soft bands rather than lines: lines across would read as staff lines.)
        chain[i] = Math.exp(-((dist / 7) ** 2)) * 1.4 - 0.25;
      }
    }
  }
  const sum = (w: Recipe['surface']) => {
    const f = new Float32Array(N * N);
    for (let i = 0; i < f.length; i++) f[i] = formation[i] * w.formation + tooth[i] * w.tooth + laid[i] * w.laid + chain[i] * w.chain;
    return f;
  };
  // In the light, more fibre is darker: the formation turns round, the mould's lines shine.
  const lightField = new Float32Array(N * N);
  for (let i = 0; i < lightField.length; i++) lightField[i] = Math.max(0, LIGHT_BASE - (flocs[i] + formation[i] * 0.4) * r.light.formation - tooth[i] * r.light.tooth + laid[i] * r.light.laid + chain[i] * r.light.chain);
  // (On parchment the shades are umber, the light through it amber.)
  const shadow: [number, number, number] = r.onLight ? [96, 62, 28] : [6, 4, 10];
  const surface = r.onLight ? fieldTile(sum(r.surface), [255, 250, 236], SURFACE_LIGHT * 1.2, SURFACE_DARK, shadow) : fieldTile(sum(r.surface), [255, 244, 228], SURFACE_LIGHT, SURFACE_DARK);
  const light = fieldTile(lightField, r.onLight ? [238, 162, 66] : [255, 204, 150], LIGHT_BRIGHT, 0); // the lamp's warm light
  const darkFibre = r.onLight ? '96,62,28' : '4,2,8';

  const sctx = surface.getContext('2d')!;
  const lctx = light.getContext('2d')!;
  sctx.lineCap = lctx.lineCap = 'round';
  for (const f of r.fibres(rnd)) {
    wrapped(sctx, f.pts, () => {
      path(sctx, f.pts);
      sctx.lineWidth = f.width;
      sctx.strokeStyle = f.shade > 0 ? `rgba(255,244,228,${(0.032 * f.shade).toFixed(3)})` : `rgba(${darkFibre},${(0.06 * -f.shade).toFixed(3)})`;
      sctx.stroke();
    });
    wrapped(lctx, f.pts, () => {
      path(lctx, f.pts);
      // A fibre holds the light back: it takes away what the paper lets through there.
      lctx.globalCompositeOperation = 'destination-out';
      lctx.lineWidth = f.width * 1.3;
      lctx.strokeStyle = `rgba(0,0,0,${(0.7 * f.block).toFixed(3)})`;
      lctx.stroke();
      lctx.globalCompositeOperation = 'source-over';
    });
  }
  // Flecks: specks of something else caught in the pulp.
  for (let i = 0; i < r.flecks; i++) {
    const pts: [number, number][] = [[rnd() * N, rnd() * N]];
    const size = rnd() < 0.85 ? pick(rnd, 0.6, 1.4) : pick(rnd, 1.6, 3);
    const dark = rnd() < 0.8;
    const warm = rnd() < 0.25;
    const draw = (ctx: CanvasRenderingContext2D, alpha: number) => () => {
      ctx.beginPath();
      ctx.ellipse(pts[0][0], pts[0][1], size, size * pick(rnd, 0.5, 1), rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = dark ? (warm ? `rgba(70,40,20,${alpha})` : `rgba(${darkFibre},${alpha})`) : `rgba(255,244,228,${alpha * 0.6})`;
      ctx.fill();
    };
    wrapped(sctx, pts, draw(sctx, 0.2));
    lctx.globalCompositeOperation = 'destination-out';
    wrapped(lctx, pts, draw(lctx, 0.8));
    lctx.globalCompositeOperation = 'source-over';
  }
  return { surface, light };
}

function tilesOf(k: PaperKind = kind): Tiles {
  let t = made.get(k);
  if (!t) {
    t = make(k);
    made.set(k, t);
  }
  return t;
}

/** The paper for CSS surfaces: --fibre, a 256 px tile (the same paper as on the canvases). */
function applyCss() {
  if (document.documentElement.dataset.design !== 'papier') return;
  const small = document.createElement('canvas');
  small.width = small.height = N * TS;
  const ctx = small.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tilesOf().surface, 0, 0, small.width, small.height);
  document.documentElement.style.setProperty('--fibre', `url(${small.toDataURL('image/png')})`);
}

/** Puts the paper's texture onto the CSS surfaces; called once at start (paper design only). */
export function initPaper() {
  applyCss();
}

// ---- painting it --------------------------------------------------------------------------------

/**
 * Where the paper lies: the screen position of its origin (beat 0, the top row) and how far it is
 * stretched across (sx) and down (sy) -- 1 as the music is at zoom 1.
 */
export interface PaperFrame {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

export const STILL: PaperFrame = { x: 0, y: 0, sx: 1, sy: 1 };

/** A stretch folded into one octave: the coarser layer's scale (1..2) and the finer one's weight. */
function fold(s: number): { a: number; f: number } {
  const l = Math.log2(Math.max(1e-3, s));
  const f = l - Math.floor(l);
  return { a: 2 ** f, f };
}

// The layers for the current stretch, composed once into one tile (with the paper's colour, when
// asked): the coarser layer at the tile's own scale, the finer at half (which repeats exactly in it),
// so the screen needs one fill per frame. Composed again only when the stretch moves on (weights in
// steps of 1/48, too fine to see).
const composed = new Map<string, HTMLCanvasElement>();
const patterns = new WeakMap<CanvasRenderingContext2D, Map<HTMLCanvasElement, CanvasPattern>>();

function composedTile(of: PaperKind, which: 'surface' | 'light', base: string | null, fx: number, fy: number): HTMLCanvasElement {
  const qx = Math.round(fx * 48) / 48;
  const qy = Math.round(fy * 48) / 48;
  const key = `${of}|${which}|${base}|${qx}|${qy}`;
  let c = composed.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  if (base) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, N, N);
  }
  const tile = tilesOf(of)[which];
  const pattern = ctx.createPattern(tile, 'repeat')!;
  const layers: [number, number, number][] = [];
  for (const [rx, wx] of [[1, 1 - qx], [0.5, qx]]) for (const [ry, wy] of [[1, 1 - qy], [0.5, qy]]) if (wx * wy > 0.01) layers.push([rx, ry, wx * wy]);
  // Two half-strong layers look flatter than one: made up for, so the grain stays as strong.
  const norm = 1 / Math.sqrt(layers.reduce((sum, [, , w]) => sum + w * w, 0));
  for (const [rx, ry, w] of layers) {
    pattern.setTransform(new DOMMatrix([rx, 0, 0, ry, 0, 0]));
    ctx.globalAlpha = Math.min(1, w * norm);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, N, N);
  }
  if (composed.size > 12) composed.delete(composed.keys().next().value!);
  composed.set(key, c);
  return c;
}

function patternOf(ctx: CanvasRenderingContext2D, tile: HTMLCanvasElement): CanvasPattern {
  let m = patterns.get(ctx);
  if (!m) patterns.set(ctx, (m = new Map()));
  let p = m.get(tile);
  if (!p) {
    if (m.size > 6) m.clear();
    p = ctx.createPattern(tile, 'repeat')!;
    m.set(tile, p);
  }
  return p;
}

/**
 * The paper over (x, y, w, h), in one fill: with its colour when `base` is given (opaque), else
 * its texture alone, over what is there. `which`: its surface, or what the lamp shows through it
 * (see backlight).
 */
export function paintPaper(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frame: PaperFrame, which: 'surface' | 'light' = 'surface', base: string | null = null, of: PaperKind = kind) {
  if (w <= 0 || h <= 0) return;
  const fx = fold(frame.sx);
  const fy = fold(frame.sy);
  const pattern = patternOf(ctx, composedTile(of, which, base, fx.f, fy.f));
  const px = N * TS * fx.a;
  const py = N * TS * fy.a;
  const tx = ((frame.x % px) + px) % px;
  const ty = ((frame.y % py) + py) % py;
  pattern.setTransform(new DOMMatrix([TS * fx.a, 0, 0, TS * fy.a, tx, ty]));
  ctx.fillStyle = pattern;
  ctx.fillRect(x, y, w, h);
}

let strip: HTMLCanvasElement | null = null;

/** How far the lamp shows the paper's inside: px over the music played, px over the music to come. */
export const BACKLIGHT_REACH = { behind: 60, ahead: 120 };

/**
 * The lamp behind the paper at x: in a strip around it the paper shows what light passes through it.
 * `mask` draws, in the strip's own coordinates (its left edge at x - reach), what isn't paper there
 * (the roll's holes, as transparent) -- the light only shows on the paper.
 */
export function backlight(ctx: CanvasRenderingContext2D, x: number, top: number, height: number, frame: PaperFrame, strength: number, mask?: (sctx: CanvasRenderingContext2D, left: number) => void, of: PaperKind = kind) {
  const { behind, ahead } = BACKLIGHT_REACH;
  const w = behind + ahead;
  if (height <= 0) return;
  // Light through paper is soft: the strip is composed at CSS resolution, whatever the screen's.
  const res = 1;
  strip ??= document.createElement('canvas');
  const cw = Math.ceil(w * res);
  const ch = Math.ceil(height * res);
  if (strip.width !== cw || strip.height !== ch) {
    strip.width = cw;
    strip.height = ch;
  }
  const s = strip.getContext('2d')!;
  s.setTransform(res, 0, 0, res, 0, 0);
  s.globalCompositeOperation = 'source-over';
  s.clearRect(0, 0, w, height);
  const left = x - behind;
  paintPaper(s, 0, 0, w, height, { ...frame, x: frame.x - left, y: frame.y - top }, 'light', null, of);
  // Strongest at the lamp, fading out over the music to come and, sooner, over what was played.
  s.globalCompositeOperation = 'destination-in';
  const g = s.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(behind / w / 2, 'rgba(0,0,0,0.35)');
  g.addColorStop(behind / w, 'rgba(0,0,0,1)');
  g.addColorStop((behind + ahead * 0.35) / w, 'rgba(0,0,0,0.55)');
  g.addColorStop((behind + ahead * 0.7) / w, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  s.fillStyle = g;
  s.fillRect(0, 0, w, height);
  if (mask) mask(s, left);
  s.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.drawImage(strip, 0, 0, cw, ch, left, top, w, height);
  ctx.restore();
}

/**
 * A preview of a paper (the chooser): its surface, the lamp behind it a little right of the middle
 * with its reading line, on a canvas of w x h CSS px.
 */
export function paintSwatch(canvas: HTMLCanvasElement, of: PaperKind, w: number, h: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintPaper(ctx, 0, 0, w, h, STILL, 'surface', NIGHT_PAPER, of);
  const lamp = Math.round(w * 0.42);
  const glow = ctx.createLinearGradient(lamp - 60, 0, lamp + 140, 0);
  glow.addColorStop(0, 'rgba(255,208,156,0)');
  glow.addColorStop(0.3, 'rgba(255,208,156,0.1)');
  glow.addColorStop(1, 'rgba(255,208,156,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  backlight(ctx, lamp, 0, h, STILL, 0.6, undefined, of);
  ctx.fillStyle = 'rgba(239,231,218,0.72)';
  ctx.fillRect(lamp - 0.5, 0, 1, h);
}
