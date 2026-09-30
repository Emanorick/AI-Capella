// Performance markings -- dynamics, hairpins, tempo, printed words (Score.marks) -- written above
// the staves of the sheet view in gold ink with a pen, in a tall, narrow script (Italianno), as if
// added to the score by hand. Ink on the paper: no glow, nothing lights up as the reading line
// passes. On by default; ?zeichen=aus hides them on a device (?zeichen=feder shows them again).
// Kept quiet so the page doesn't fill up: tempo marks and words every voice shares stand once, over
// the top staff; dynamics and hairpins stand over each staff as in a printed choral score; words
// repeated bar after bar are written the first time only.

import { deviceChoice } from './design';
import type { Score, ScoreMark } from './score';
import { FONT_MUSIC } from './theme';

export const MARKS_ON = deviceChoice('zeichen', 'ai-capella-marks', ['aus', 'feder'] as const, 'feder') === 'feder';

/** The pen script (Italianno, bundled -- see main.ts; also the "Light" of the LightScore name). */
export const FONT_SCRIPT = '"Italianno", cursive';

/** Resolves once the pen script and the metronome glyphs can be drawn on a canvas. */
export function loadScriptFont(): Promise<void> {
  return Promise.all([document.fonts.load(`20px ${FONT_SCRIPT}`, 'Light'), document.fonts.load(`20px ${FONT_MUSIC}`, '\uECA5')]).then(
    () => undefined,
    () => undefined,
  );
}

// ---------------------------------------------------------------------------------------------
// Which marks go where
// ---------------------------------------------------------------------------------------------

export interface MarkLayout {
  lane: ScoreMark[]; // tempo, and what every voice has alike
  byPart: Map<string, ScoreMark[]>; // what belongs to one voice
}

export function layoutMarks(score: Score): MarkLayout {
  // Words repeated bar after bar in a voice ("repeat of preceding bar") are written the first time only.
  const lastWords = new Map<string, string>();
  const marks = (score.marks ?? []).filter((m) => {
    if (m.kind !== 'words') return true;
    const same = lastWords.get(m.partId) === m.text;
    lastWords.set(m.partId, m.text);
    return !same;
  });
  const singing = new Set(score.notes.map((n) => n.partId));
  const lane: ScoreMark[] = [];
  const byPart = new Map<string, ScoreMark[]>();
  const key = (m: ScoreMark) => `${m.kind}|${m.text}|${m.beat.toFixed(3)}|${(m.endBeat ?? 0).toFixed(3)}`;
  const groups = new Map<string, ScoreMark[]>();
  for (const m of marks) {
    const k = m.kind === 'tempo' ? `tempo|${m.beat.toFixed(3)}` : key(m);
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const parts = new Set(group.map((m) => m.partId));
    const everyone = singing.size > 1 && [...singing].every((p) => parts.has(p));
    if (first.kind === 'tempo' || everyone) {
      lane.push(first.kind === 'tempo' ? group.reduce((a, b) => (b.text.length + (b.metronome ? 5 : 0) > a.text.length + (a.metronome ? 5 : 0) ? b : a)) : first);
    } else {
      for (const m of group) byPart.set(m.partId, [...(byPart.get(m.partId) ?? []), m]);
    }
  }
  lane.sort((a, b) => a.beat - b.beat);
  return { lane, byPart };
}

// ---------------------------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------------------------

const METRONOME_NOTE: Record<string, string> = { half: '', quarter: '', eighth: '' };

/** Gold ink: a little deeper where it pooled, a little brighter where it lies thin. */
function goldInk(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number): CanvasGradient {
  const g = ctx.createLinearGradient(x0, top, x1 + (bottom - top), bottom);
  g.addColorStop(0, 'rgb(150,114,50)');
  g.addColorStop(0.45, 'rgb(196,158,84)');
  g.addColorStop(1, 'rgb(140,106,46)');
  return g;
}

export interface InkPlace {
  x: number; // where the mark starts
  y: number; // baseline
  x2?: number; // hairpins: where they close
  alpha?: number;
  scale?: number;
}

/** Writes one mark (or only measures it, with `measure`); returns its width. */
export function drawInkMark(ctx: CanvasRenderingContext2D, mark: ScoreMark, place: InkPlace, measure = false): number {
  const s = place.scale ?? 1;
  ctx.save();
  ctx.globalAlpha = place.alpha ?? 1;
  ctx.textBaseline = 'alphabetic';

  if (mark.kind === 'wedge') {
    const x1 = place.x;
    const x2 = Math.max(x1 + 12, place.x2 ?? x1 + 40);
    if (!measure) {
      const open = 5.5 * s;
      const [wide, narrow] = mark.text === 'crescendo' ? [x2, x1] : [x1, x2];
      ctx.fillStyle = goldInk(ctx, x1, x2, place.y - open, place.y + open);
      // Two pen strokes, each thinning to a hairline where the hairpin closes.
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(narrow, place.y - 0.3);
        ctx.lineTo(narrow, place.y + 0.3);
        ctx.lineTo(wide, place.y + side * open + 1.1);
        ctx.lineTo(wide, place.y + side * open - 1.1);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
    return x2 - x1;
  }

  const pieces: { text: string; font: string; dy?: number }[] = [];
  const size = mark.kind === 'dynamic' ? 38 : mark.kind === 'tempo' ? 34 : 29;
  const font = `${Math.round(size * s)}px ${FONT_SCRIPT}`;
  // Typed-in separators become space; a metronome mark already spelled out in the words isn't doubled.
  const text = mark.text.replace(/\s*[·•]\s*/g, '  ');
  if (text) pieces.push({ text, font });
  if (mark.kind === 'tempo' && mark.metronome && !/=\s*(ca\.?\s*)?\d/.test(text)) {
    const glyph = METRONOME_NOTE[mark.metronome.unit] ?? METRONOME_NOTE.quarter;
    const dots = mark.metronome.dots ? ''.repeat(mark.metronome.dots) : '';
    if (text) pieces.push({ text: '  ', font });
    pieces.push({ text: glyph + dots, font: `${Math.round(22 * s)}px ${FONT_MUSIC}`, dy: -1 });
    pieces.push({ text: ` = ${mark.metronome.perMinute}`, font });
  }
  let width = 0;
  for (const p of pieces) {
    ctx.font = p.font;
    width += ctx.measureText(p.text).width;
  }
  if (!measure) {
    const height = 17 * s;
    ctx.fillStyle = goldInk(ctx, place.x, place.x + width, place.y - height, place.y);
    let x = place.x;
    for (const p of pieces) {
      ctx.font = p.font;
      ctx.fillText(p.text, x, place.y + (p.dy ?? 0));
      x += ctx.measureText(p.text).width;
    }
  }
  ctx.restore();
  return width;
}
