// Canvas-side mirror of the CSS tokens in style.css -- the piano roll, sheet view, covers and
// ribbons draw with these so canvas and DOM share one palette and one set of typefaces.
export const INK0 = '#0D0C16';
export const INK1 = '#13121E';
export const INK2 = '#1B1929';
export const INK3 = '#252235';
export const PAPER = '#EFE7DA';

/**
 * The stage the score sits on: velvet, a touch lighter at the top like fabric catching light,
 * instead of flat ink. Cached per height (a gradient object per frame would be wasted work).
 */
let stageCache: { ctx: CanvasRenderingContext2D; h: number; fill: CanvasGradient } | null = null;
export function stageFill(ctx: CanvasRenderingContext2D, height: number): CanvasGradient {
  if (stageCache && stageCache.ctx === ctx && stageCache.h === height) return stageCache.fill;
  const fill = ctx.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, '#17121f');
  fill.addColorStop(0.55, '#110e19');
  fill.addColorStop(1, '#0e0c16');
  stageCache = { ctx, h: height, fill };
  return fill;
}

let grainTile: HTMLCanvasElement | null = null;
/**
 * The paper's fibres, painted into the piano roll's content buffer (so they scroll with the roll
 * like real paper, and cost nothing per frame).
 */
export function paperGrain(ctx: CanvasRenderingContext2D, width: number, height: number) {
  if (!grainTile) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 96;
    const t = tile.getContext('2d')!;
    const img = t.createImageData(96, 96);
    let seed = 11;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < img.data.length; i += 4) {
      const v = random() < 0.5 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = random() < 0.35 ? 9 : 0;
    }
    t.putImageData(img, 0, 0);
    // Fibres run along the roll: the noise is stretched horizontally.
    grainTile = document.createElement('canvas');
    grainTile.width = 288;
    grainTile.height = 96;
    grainTile.getContext('2d')!.drawImage(tile, 0, 0, 288, 96);
  }
  const pattern = ctx.createPattern(grainTile, 'repeat');
  if (!pattern) return;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, width, height);
}

/** Paper at the given opacity -- hairlines, grid, secondary text on the dark ground. */
export function paper(alpha: number): string {
  return `rgba(239,231,218,${alpha})`;
}

export function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#')) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/** Mixes a hex colour toward paper by `k` (0..1) -- used for the "lit" state of sounding notes. */
export function towardPaper(hex: string, k: number): string {
  if (!hex.startsWith('#')) return hex;
  const v = parseInt(hex.slice(1), 16);
  const mix = (c: number, p: number) => Math.round(c + (p - c) * k);
  return `rgb(${mix((v >> 16) & 255, 239)},${mix((v >> 8) & 255, 231)},${mix(v & 255, 218)})`;
}

/** Mixes a hex colour toward deep ink by `k` (0..1) -- the shaded underside of a gel note. */
export function towardInk(hex: string, k: number): string {
  if (!hex.startsWith('#')) return hex;
  const v = parseInt(hex.slice(1), 16);
  const mix = (c: number, p: number) => Math.round(c + (p - c) * k);
  return `rgb(${mix((v >> 16) & 255, 20)},${mix((v >> 8) & 255, 12)},${mix(v & 255, 30)})`;
}

// Gel notes ("Licht"): lit from above, a glossy highlight along the top, a fine rim -- strength as
// agreed for the app (between "subtle" and "balanced" in the design draft).
const GEL_GLOSS = 0.75;
const gelShades = new Map<string, { top: string; bottom: string }>();

/** A note bead as gel. `lit` brightens it (the note sounding at the playhead). */
export function gelPill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, lit = false) {
  let shades = gelShades.get(color);
  if (!shades) {
    shades = { top: towardPaper(color, 0.28 * GEL_GLOSS), bottom: towardInk(color, 0.26 * GEL_GLOSS) };
    gelShades.set(color, shades);
  }
  const r = Math.min(h / 2, w / 2);
  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, lit ? towardPaper(color, 0.5) : shades.top);
  body.addColorStop(0.55, lit ? towardPaper(color, 0.3) : color);
  body.addColorStop(1, lit ? color : shades.bottom);
  ctx.fillStyle = body;
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
  if (h < 9) return;
  const inset = Math.min(r * 0.6, 5);
  const shine = ctx.createLinearGradient(0, y + 1.5, 0, y + h * 0.5);
  shine.addColorStop(0, `rgba(255,255,255,${0.5 * GEL_GLOSS})`);
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  roundRectPath(ctx, x + inset, y + 1.5, Math.max(0, w - inset * 2), h * 0.46, r * 0.8);
  ctx.fill();
  ctx.strokeStyle = `rgba(255,255,255,${0.16 * GEL_GLOSS})`;
  ctx.lineWidth = 1;
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, r - 0.5));
  ctx.stroke();
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** The playhead as a warm beam of light: a soft band behind the line. */
export function playheadBeam(ctx: CanvasRenderingContext2D, x: number, top: number, height: number) {
  const beam = ctx.createLinearGradient(x - 36, 0, x + 36, 0);
  beam.addColorStop(0, 'rgba(255,228,196,0)');
  beam.addColorStop(0.5, 'rgba(255,228,196,0.12)');
  beam.addColorStop(1, 'rgba(255,228,196,0)');
  ctx.fillStyle = beam;
  ctx.fillRect(x - 36, top, 72, height);
}

export const FONT_TEXT = '"Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next", system-ui, sans-serif';
export const FONT_MONO = '"Atkinson Hyperlegible Mono Variable", "Atkinson Hyperlegible Mono", ui-monospace, monospace';
export const FONT_DISPLAY = '"Bodoni Moda Variable", "Bodoni Moda", Didot, Georgia, serif';
/** SMuFL music font (Bravura, subset to the glyphs the sheet view uses -- see assets/fonts). */
export const FONT_MUSIC = 'Bravura';

/**
 * Resolves once the bundled faces the canvases draw with are loaded. Canvas text silently falls
 * back to a system font if drawn before its web font arrives -- and the piano roll caches lyric
 * bitmaps, so a fallback-rendered syllable would stick until the next rebuild -- so the first
 * paint of either score view waits on this (with a timeout, so a failed font load never blocks
 * the app).
 */
export function canvasFontsReady(): Promise<void> {
  if (!('fonts' in document)) return Promise.resolve();
  const loads = Promise.all([
    document.fonts.load(`600 12px ${FONT_TEXT}`),
    document.fonts.load(`600 11px ${FONT_MONO}`),
    document.fonts.load(`32px ${FONT_MUSIC}`, ''),
  ]).then(() => undefined);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2500));
  return Promise.race([loads, timeout]).catch(() => undefined);
}
