// Canvas-side mirror of the CSS tokens in style.css -- the piano roll, sheet view, covers and
// ribbons draw with these so canvas and DOM share one palette and one set of typefaces.
export const INK0 = '#0D0C16';
export const INK1 = '#13121E';
export const INK2 = '#1B1929';
export const INK3 = '#252235';
export const PAPER = '#EFE7DA';

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
