// The piano roll's "lantern" look: the roll is dark paper with round holes, and a lamp some way
// behind it shines through them from the reading line. Two passes per frame, both composed at a
// fraction of the screen's resolution (light is soft; the crisp hole edges come from the
// full-resolution paper drawn between them):
//
//   under(): what is seen through the holes -- each hole's colour filter (the voice colour), lit by
//            the lamp: full colour in its spot, dimmer with distance but never unreadable (coming
//            notes must stay clear), and white-hot right at the reading line, where the notes
//            sound. It also composes the light in front of the paper (below), part of which is
//            added back into the holes, so those near the lamp glow brighter than their colour.
//   over():  that light in front of the paper -- the lamp's glow through the paper itself, and a
//            halo of each hole's light on the paper around it (strongest near the lamp, in the
//            voice's colour for a note that is sounding).
//
// The lamp's shape: one light aimed obliquely at the paper, so its spot is egg-shaped -- the hot
// end on the reading line, falling off quickly over the music already played and reaching far
// ahead over the music to come.

export type Flare = { x: number; y: number; w: number; h: number; color: string };

type Cone = { x: number; y: number; d: number; r: number; sy: number };

// Fractions of the screen's (CSS pixel) size the passes are composed at.
const LIGHT_SCALE = 0.5;
const HALO_SCALE = 0.25;
const WIDE_SCALE = 0.125;
const WIDEST_SCALE = 0.0625;

// Through the holes, along the lamp's spot (0 = its hot end, 1 = its rim and beyond): full colour
// in the spot, darkening with distance.
const THROUGH_STOPS: [number, string][] = [
  [0, 'rgba(6,4,12,0)'],
  [0.2, 'rgba(6,4,12,0)'],
  [0.5, 'rgba(6,4,12,0.22)'],
  [0.8, 'rgba(6,4,12,0.38)'],
  [1, 'rgba(6,4,12,0.46)'],
];
// The reading line itself: a narrow band where the holes go white-hot (px before and after it).
const HOT_BEHIND_PX = 22;
const HOT_AHEAD_PX = 34;
const HOT_WHITE = 'rgba(255,249,240,';
// How much of the holes' light spills onto the paper, by distance from the lamp.
const HALO_STOPS: [number, string][] = [
  [0, 'rgba(0,0,0,1)'],
  [0.18, 'rgba(0,0,0,0.75)'],
  [0.42, 'rgba(0,0,0,0.26)'],
  [0.8, 'rgba(0,0,0,0.04)'],
  [1, 'rgba(0,0,0,0)'],
];
// The lamp seen through the paper itself.
const PAPER_GLOW_STOPS: [number, string][] = [
  [0, 'rgba(255,212,160,0.3)'],
  [0.1, 'rgba(255,206,154,0.22)'],
  [0.25, 'rgba(255,200,150,0.11)'],
  [0.45, 'rgba(255,198,150,0.04)'],
  [0.7, 'rgba(255,198,150,0.01)'],
  [0.9, 'rgba(255,198,150,0)'],
];
// How much of the holes' light reaches the paper around them, from the sharpest to the widest blur.
const HALO_WEIGHTS = [0.3, 0.32, 0.3];
// A sounding note's halo, in the voice's colour.
const FLARE_HALO_ALPHA = 0.5;
// How much of that light is added back into the holes it comes from.
const HOLE_BOOST = 1.3;

function cone(width: number, height: number, x: number): Cone {
  const r = Math.max(width * 0.75, 300);
  const d = r * 0.55;
  // Stretched vertically where the roll is tall and narrow (a phone), so the top and bottom rows
  // on the reading line are still well inside the spot.
  const reachY = Math.sqrt(r * r - d * d);
  return { x, y: height / 2, d, r, sy: Math.max(1, height / reachY) };
}

/** Fills the whole area with a gradient that follows the lamp's spot (ctx in CSS pixels). */
function fillCone(ctx: CanvasRenderingContext2D, c: Cone, stops: [number, string][], width: number, height: number) {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(1, c.sy);
  const g = ctx.createRadialGradient(0, 0, 0, c.d, 0, c.r);
  for (const [t, color] of stops) g.addColorStop(t, color);
  ctx.fillStyle = g;
  ctx.fillRect(-c.x - 1, (-c.y - 1) / c.sy, width + 2, (height + 2) / c.sy);
  ctx.restore();
}

function layer(canvas: HTMLCanvasElement | null, width: number, height: number, scale: number): HTMLCanvasElement {
  const c = canvas ?? document.createElement('canvas');
  const w = Math.max(1, Math.ceil(width * scale));
  const h = Math.max(1, Math.ceil(height * scale));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = true;
  return ctx;
}

/** Draws `src` (composed at `fromScale`) into `ctx` (at `toScale`) for a width x height area. */
function resample(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, fromScale: number, toScale: number, width: number, height: number) {
  ctx.drawImage(src, 0, 0, width * fromScale, height * fromScale, 0, 0, width * toScale, height * toScale);
}

function capsule(ctx: CanvasRenderingContext2D, f: Flare, pad: number) {
  ctx.beginPath();
  ctx.roundRect(f.x - pad, f.y - pad, f.w + pad * 2, f.h + pad * 2, (f.h + pad * 2) / 2);
  ctx.fill();
}

export class Lantern {
  private through: HTMLCanvasElement | null = null;
  private halo: HTMLCanvasElement | null = null;
  private wide: HTMLCanvasElement | null = null;
  private widest: HTMLCanvasElement | null = null;
  private glow: HTMLCanvasElement | null = null;
  private width = 0;
  private height = 0;
  private ready = false; // under() has composed this frame's glow for over()

  /**
   * Behind the paper. `drawFilters` paints the holes' colour filters into the given context, which
   * is scaled to CSS pixels of the content area; `flares` are the notes sounding right now. `lampX`
   * is where the lamp is (the reading line). Draw the paper over this, then call over().
   */
  under(ctx: CanvasRenderingContext2D, width: number, height: number, lampX: number, drawFilters: (ctx: CanvasRenderingContext2D) => void, flares: Flare[]) {
    this.width = width;
    this.height = height;
    const spot = cone(width, height, lampX);
    const through = (this.through = layer(this.through, width, height, LIGHT_SCALE));
    const t = context(through);
    t.clearRect(0, 0, through.width, through.height);
    t.scale(LIGHT_SCALE, LIGHT_SCALE);
    drawFilters(t);
    t.globalCompositeOperation = 'source-atop';
    fillCone(t, spot, THROUGH_STOPS, width, height);
    const hot = t.createLinearGradient(lampX - HOT_BEHIND_PX, 0, lampX + HOT_AHEAD_PX, 0);
    const at = HOT_BEHIND_PX / (HOT_BEHIND_PX + HOT_AHEAD_PX);
    hot.addColorStop(0, HOT_WHITE + '0)');
    hot.addColorStop(at * 0.6, HOT_WHITE + '0.3)');
    hot.addColorStop(at, HOT_WHITE + '0.82)');
    hot.addColorStop(at + (1 - at) * 0.35, HOT_WHITE + '0.4)');
    hot.addColorStop(1, HOT_WHITE + '0)');
    t.fillStyle = hot;
    t.fillRect(lampX - HOT_BEHIND_PX, 0, HOT_BEHIND_PX + HOT_AHEAD_PX, height);

    // The holes' light, blurred by halving it down three times (each halving averages 2x2 pixels).
    const halo = (this.halo = layer(this.halo, width, height, HALO_SCALE));
    const h = context(halo);
    h.globalCompositeOperation = 'copy';
    resample(h, through, LIGHT_SCALE, HALO_SCALE, width, height);
    h.globalCompositeOperation = 'lighter';
    h.scale(HALO_SCALE, HALO_SCALE);
    h.globalAlpha = FLARE_HALO_ALPHA;
    for (const f of flares) {
      h.fillStyle = f.color;
      capsule(h, f, 2);
    }
    const wide = (this.wide = layer(this.wide, width, height, WIDE_SCALE));
    const w = context(wide);
    w.globalCompositeOperation = 'copy';
    resample(w, halo, HALO_SCALE, WIDE_SCALE, width, height);
    const widest = (this.widest = layer(this.widest, width, height, WIDEST_SCALE));
    const ws = context(widest);
    ws.globalCompositeOperation = 'copy';
    resample(ws, wide, WIDE_SCALE, WIDEST_SCALE, width, height);

    // Together, kept to the lamp's reach, plus the lamp's glow through the paper...
    const glow = (this.glow = layer(this.glow, width, height, HALO_SCALE));
    const g = context(glow);
    g.clearRect(0, 0, glow.width, glow.height);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = HALO_WEIGHTS[0];
    resample(g, halo, HALO_SCALE, HALO_SCALE, width, height);
    g.globalAlpha = HALO_WEIGHTS[1];
    resample(g, wide, WIDE_SCALE, HALO_SCALE, width, height);
    g.globalAlpha = HALO_WEIGHTS[2];
    resample(g, widest, WIDEST_SCALE, HALO_SCALE, width, height);
    g.globalAlpha = 1;
    g.scale(HALO_SCALE, HALO_SCALE);
    g.globalCompositeOperation = 'destination-in';
    fillCone(g, spot, HALO_STOPS, width, height);
    g.globalCompositeOperation = 'lighter';
    fillCone(g, spot, PAPER_GLOW_STOPS, width, height);

    // ...which also brightens the holes themselves (added here, on the small layer: adding it to
    // the full screen costs a lot more on some devices -- see over()).
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'lighter';
    t.globalAlpha = HOLE_BOOST;
    resample(t, glow, HALO_SCALE, LIGHT_SCALE, width, height);

    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(through, 0, 0, width * LIGHT_SCALE, height * LIGHT_SCALE, 0, 0, width, height);
    ctx.imageSmoothingEnabled = smoothing;
    this.ready = true;
  }

  /** In front of the paper (after under() in the same frame): the lamp's glow and the holes' halos. */
  over(ctx: CanvasRenderingContext2D) {
    if (!this.ready || !this.glow) return;
    this.ready = false;
    // Laid over rather than added ('lighter'): on the dark paper the two look alike, and adding a
    // full-screen layer costs a lot more on some devices.
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.glow, 0, 0, this.width * HALO_SCALE, this.height * HALO_SCALE, 0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = smoothing;
  }
}
