// Canvas-side mirror of the CSS tokens in style.css -- the piano roll, sheet view, covers and
// ribbons draw with these so canvas and DOM share one palette and one set of typefaces.
import { PARCHMENT, REVIVAL_TYPE } from './design';

// The grounds, deepest first, and the colour things are printed in on them: night paper and paper
// white, or on parchment (design.ts) the parchment's shades and iron-gall ink.
export const INK0 = PARCHMENT ? '#E6D6B4' : '#0D0C16';
export const INK1 = PARCHMENT ? '#DFCDA7' : '#13121E';
export const INK2 = PARCHMENT ? '#EADCBD' : '#1B1929';
export const INK3 = PARCHMENT ? '#F0E5CC' : '#252235';
export const PAPER = PARCHMENT ? '#2E2219' : '#EFE7DA';
const PRINT_RGB = PARCHMENT ? [46, 34, 25] : [239, 231, 218];
// Bars the scan wasn't sure of (scan marks): a small gold "?" by their number in the rulers.
export const QUERY = PARCHMENT ? '#A46F18' : '#EDC96B';

/**
 * The stage the score sits on: velvet, a touch lighter at the top like fabric catching light,
 * instead of flat ink. Cached per height (a gradient object per frame would be wasted work).
 */
let stageCache: { ctx: CanvasRenderingContext2D; h: number; fill: CanvasGradient } | null = null;
export function stageFill(ctx: CanvasRenderingContext2D, height: number): CanvasGradient {
  if (stageCache && stageCache.ctx === ctx && stageCache.h === height) return stageCache.fill;
  const fill = ctx.createLinearGradient(0, 0, 0, height);
  for (const [t, c] of PARCHMENT ? ([[0, '#EDE0C3'], [0.55, '#E8D8B7'], [1, '#E3D1AD']] as const) : ([[0, '#17121f'], [0.55, '#110e19'], [1, '#0e0c16']] as const)) fill.addColorStop(t, c);
  stageCache = { ctx, h: height, fill };
  return fill;
}

/** The print colour at the given opacity -- hairlines, grid, secondary text (paper on the night ground, ink on parchment). */
export function paper(alpha: number): string {
  return `rgba(${PRINT_RGB[0]},${PRINT_RGB[1]},${PRINT_RGB[2]},${alpha})`;
}

export function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#')) return hex;
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/** Mixes a hex colour toward the print colour by `k` (0..1) -- a voice's syllables and slurs as printed, the "lit" state of a gel note. */
export function towardPaper(hex: string, k: number): string {
  if (!hex.startsWith('#')) return hex;
  const v = parseInt(hex.slice(1), 16);
  const mix = (c: number, p: number) => Math.round(c + (p - c) * k);
  return `rgb(${mix((v >> 16) & 255, PRINT_RGB[0])},${mix((v >> 8) & 255, PRINT_RGB[1])},${mix(v & 255, PRINT_RGB[2])})`;
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

/**
 * Paper design: the lamp behind the paper seen along a reading line at x -- a faint warm strip with
 * a bell-shaped fall-off to the sides (the same light as the punched roll's, see lantern.ts).
 */
export function readingStrip(ctx: CanvasRenderingContext2D, x: number, top: number, height: number) {
  const reach = 90;
  const g = ctx.createLinearGradient(x - reach, 0, x + reach, 0);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    g.addColorStop(t, PARCHMENT ? `rgba(236,160,64,${(0.16 * Math.exp(-(((t - 0.5) / 0.2) ** 2))).toFixed(4)})` : `rgba(255,208,156,${(0.1 * Math.exp(-(((t - 0.5) / 0.2) ** 2))).toFixed(4)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(x - reach, top, reach * 2, height);
}

export const FONT_TEXT = '"Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next", system-ui, sans-serif';
export const FONT_MONO = '"Atkinson Hyperlegible Mono Variable", "Atkinson Hyperlegible Mono", ui-monospace, monospace';
export const FONT_DISPLAY = '"Bodoni Moda Variable", "Bodoni Moda", Didot, Georgia, serif';
// The rehearsal letters in the rulers, and the "Score" of the name (inkWordmark.ts) -- faces of their
// own from Font Revival (design.ts REVIVAL_TYPE), which have one weight, or the Bodoni.
export const FONT_MARK = REVIVAL_TYPE ? `"Baltimore Bold 1832", ${FONT_DISPLAY}` : FONT_DISPLAY;
export const MARK_WEIGHT = REVIVAL_TYPE ? 400 : 700;
export const FONT_BRAND = REVIVAL_TYPE ? `"Baltimore Black Slope 1832", ${FONT_DISPLAY}` : FONT_DISPLAY;
export const BRAND_WEIGHT = REVIVAL_TYPE ? 400 : 600;
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
    ...(REVIVAL_TYPE ? [document.fonts.load(`${MARK_WEIGHT} 12px ${FONT_MARK}`, 'A')] : []),
  ]).then(() => undefined);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2500));
  return Promise.race([loads, timeout]).catch(() => undefined);
}

/** The "?" by a bar number in a ruler (x: its left edge, y: the number's baseline); returns its width. */
export function drawQueryMark(ctx: CanvasRenderingContext2D, x: number, y: number): number {
  ctx.save();
  ctx.fillStyle = QUERY;
  ctx.beginPath();
  ctx.arc(x + 5.5, y - 4, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK0;
  ctx.font = `700 9px ${FONT_TEXT}`;
  ctx.textAlign = 'center';
  ctx.fillText('?', x + 5.5, y - 0.8);
  ctx.restore();
  return 11;
}
