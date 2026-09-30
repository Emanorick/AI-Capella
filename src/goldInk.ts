// Performance markings -- dynamics, hairpins, tempo, printed words (Score.marks) -- written over
// the score in dark gold ink, as if added by hand. Draft behind a switch (?zeichen=stich|feder;
// ?zeichen=aus hides them again):
//   stich: the dynamics as engraved (Bravura's swung italic p, m, f, s, z), words in Bodoni italic;
//   feder: everything in a tall, narrow pen script (Italianno).
// Kept quiet so the page doesn't fill up: tempo marks, and dynamics every voice shares, sit once in
// a lane along the top; only what belongs to one voice stands by that voice's notes. The gold is
// dark and still -- it catches the light only as the reading line passes: a sheen travels across
// the letters and a few specks sparkle.

import italiannoUrl from '@fontsource/italianno/files/italianno-latin-400-normal.woff2?url';
import bodoniItalicUrl from '@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-opsz-italic.woff2?url';
import { deviceChoice } from './design';
import type { NoteEvent, Score, ScoreMark } from './score';
import { FONT_MUSIC } from './theme';

export type InkStyle = 'stich' | 'feder';
const choice = deviceChoice('zeichen', 'ai-capella-marks', ['aus', 'stich', 'feder'] as const, 'aus');
export const MARK_STYLE: InkStyle | null = choice === 'aus' ? null : choice;

const SCRIPT = '"Lightscore Script", cursive';
const ITALIC = '"Bodoni Moda Variable", "Bodoni Moda", Georgia, serif';

let fontsReady: Promise<void> | null = null;
/** Loads the typefaces the marks are written in (only when they are switched on). */
export function loadMarkFonts(): Promise<void> {
  if (!MARK_STYLE) return Promise.resolve();
  fontsReady ??= (async () => {
    try {
      const faces = [
        new FontFace('Lightscore Script', `url(${italiannoUrl})`),
        new FontFace('Bodoni Moda Variable', `url(${bodoniItalicUrl})`, { style: 'italic', weight: '400 900' }),
      ];
      await Promise.all(faces.map(async (f) => document.fonts.add(await f.load())));
      await document.fonts.load(`20px ${FONT_MUSIC}`, '');
    } catch (err) {
      console.warn('Mark fonts unavailable:', err);
    }
  })();
  return fontsReady;
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

/** The part's first note starting at (or just after) `beat` -- the one a mark there is written over. */
export function noteAt(notes: NoteEvent[], beat: number, within = 3): NoteEvent | undefined {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].startBeat < beat - 0.02) lo = mid + 1;
    else hi = mid;
  }
  const n = notes[lo];
  if (n && n.startBeat <= beat + within) return n;
  // Or the note already sounding there.
  const prev = notes[lo - 1];
  return prev && prev.startBeat + prev.durationBeats > beat ? prev : undefined;
}

// ---------------------------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------------------------

const DYNAMIC_GLYPH: Record<string, string> = { p: '', m: '', f: '', r: '', s: '', z: '', n: '' };
const METRONOME_NOTE: Record<string, string> = { half: '', quarter: '', eighth: '' };

// Dark gold, and the light it gives back.
const GOLD_DEEP = [112, 84, 36];
const GOLD = [168, 132, 62];
const GOLD_LIGHT = [242, 212, 140];

const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

function seeded(text: string, beat: number) {
  let s = Math.round(beat * 997) ^ 0x9e3779b9;
  for (const ch of text) s = Math.imul(s ^ ch.charCodeAt(0), 16777619);
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
}

/** How close the reading line is to x: 1 on it, fading out over a hand's breadth. */
function glintAt(x0: number, x1: number, lampX: number): number {
  const d = lampX < x0 ? x0 - lampX : lampX > x1 ? lampX - x1 : 0;
  return Math.exp(-(d * d) / (2 * 46 * 46));
}

/** The gold fill for a mark spanning x0..x1, its sheen where the lamp is. */
function goldFill(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number, lampX: number, glint: number): CanvasGradient {
  const g = ctx.createLinearGradient(x0, top, x1 + (bottom - top) * 0.6, bottom);
  const at = Math.min(0.92, Math.max(0.08, (lampX - x0) / Math.max(1, x1 - x0)));
  const sheenAt = glint > 0.02 ? at : 0.42;
  const light = mix(GOLD, GOLD_LIGHT, 0.35 + 0.65 * glint);
  g.addColorStop(0, rgba(GOLD_DEEP, 1));
  g.addColorStop(Math.max(0, sheenAt - 0.22), rgba(GOLD, 1));
  g.addColorStop(sheenAt, rgba(light, 1));
  g.addColorStop(Math.min(1, sheenAt + 0.22), rgba(GOLD, 1));
  g.addColorStop(1, rgba(GOLD_DEEP, 1));
  return g;
}

/** A few specks of gold catching the light, where the reading line is. */
function sparkle(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number, text: string, beat: number, lampX: number, strength: number, now: number) {
  if (glintAt(x0, x1, lampX) < 0.05) return;
  const r = seeded(text, beat);
  const count = 2 + Math.floor((x1 - x0) / 60);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const x = x0 + r() * (x1 - x0);
    const y = top + (0.25 + r() * 0.6) * (bottom - top);
    const phase = r() * Math.PI * 2;
    const tw = 0.5 + 0.5 * Math.sin(now * (2.2 + r() * 2.5) + phase);
    const a = strength * glintAt(x, x, lampX) * tw * tw;
    if (a < 0.03) continue;
    const size = 1.4 + 2.6 * a;
    const spot = ctx.createRadialGradient(x, y, 0, x, y, size * 1.6);
    spot.addColorStop(0, `rgba(255,244,214,${0.85 * a})`);
    spot.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = spot;
    ctx.fillRect(x - size * 1.6, y - size * 1.6, size * 3.2, size * 3.2);
    ctx.fillStyle = `rgba(255,248,226,${0.9 * a})`;
    ctx.fillRect(x - size, y - 0.35, size * 2, 0.7);
    ctx.fillRect(x - 0.35, y - size, 0.7, size * 2);
  }
  ctx.restore();
}

export interface InkPlace {
  x: number; // where the mark starts
  y: number; // baseline
  x2?: number; // hairpins: where they close
  alpha?: number;
  scale?: number; // 1 by a voice's notes, larger in the tempo lane
}

/**
 * Writes one mark; returns its width. `lampX` is the reading line's x, `now` seconds (for the
 * sparkle). Measuring only (no drawing) when `measure` is set.
 */
export function drawInkMark(ctx: CanvasRenderingContext2D, mark: ScoreMark, place: InkPlace, lampX: number, now: number, measure = false): number {
  const style = MARK_STYLE ?? 'stich';
  const s = place.scale ?? 1;
  ctx.save();
  ctx.globalAlpha = place.alpha ?? 1;
  ctx.textBaseline = 'alphabetic';
  let width = 0;

  if (mark.kind === 'wedge') {
    const x1 = place.x;
    const x2 = Math.max(x1 + 12, place.x2 ?? x1 + 40);
    width = x2 - x1;
    if (!measure) {
      const open = 5.5 * s;
      const glint = glintAt(x1, x2, lampX);
      const [wide, narrow] = mark.text === 'crescendo' ? [x2, x1] : [x1, x2];
      ctx.fillStyle = goldFill(ctx, x1, x2, place.y - open, place.y + open, lampX, glint);
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
      sparkle(ctx, x1, x2, place.y - open, place.y + open, mark.text, mark.beat, lampX, 0.6 * (place.alpha ?? 1), now);
    }
    ctx.restore();
    return width;
  }

  // The text, and how it is written.
  const pieces: { text: string; font: string; dy?: number }[] = [];
  const dynamic = mark.kind === 'dynamic';
  if (dynamic) {
    const letters = mark.text.toLowerCase();
    const engraved = style === 'stich' && [...letters].every((c) => DYNAMIC_GLYPH[c]);
    if (engraved) pieces.push({ text: [...letters].map((c) => DYNAMIC_GLYPH[c]).join(''), font: `${Math.round(30 * s)}px ${FONT_MUSIC}` });
    else pieces.push({ text: mark.text, font: style === 'feder' ? `${Math.round(40 * s)}px ${SCRIPT}` : `italic 700 ${Math.round(19 * s)}px ${ITALIC}` });
  } else {
    const tempo = mark.kind === 'tempo';
    const size = style === 'feder' ? (tempo ? 34 : 29) : tempo ? 18 : 15;
    const font = style === 'feder' ? `${Math.round(size * s)}px ${SCRIPT}` : `italic ${tempo ? 600 : 500} ${Math.round(size * s)}px ${ITALIC}`;
    // Typed-in separators become space; a metronome mark already spelled out in the words isn't doubled.
    const text = mark.text.replace(/\s*[·•]\s*/g, '  ');
    if (text) pieces.push({ text, font });
    if (mark.metronome && !/=\s*(ca\.?\s*)?\d/.test(text)) {
      const glyph = METRONOME_NOTE[mark.metronome.unit] ?? METRONOME_NOTE.quarter;
      const dots = mark.metronome.dots ? ''.repeat(mark.metronome.dots) : '';
      if (mark.text) pieces.push({ text: '  ', font });
      pieces.push({ text: glyph + dots, font: `${Math.round(22 * s)}px ${FONT_MUSIC}`, dy: -1 });
      pieces.push({ text: ` = ${mark.metronome.perMinute}`, font });
    }
  }
  // A hand writes a little taller and more upright-swung than type: stretch it upward a touch.
  const stretchY = style === 'feder' ? 1.05 : 1.1;
  for (const p of pieces) {
    ctx.font = p.font;
    width += ctx.measureText(p.text).width;
  }
  if (measure) {
    ctx.restore();
    return width;
  }
  const height = (style === 'feder' ? 17 : 14) * s;
  const top = place.y - height;
  const glint = glintAt(place.x, place.x + width, lampX);
  ctx.translate(place.x, place.y);
  ctx.scale(1, stretchY);
  // A soft shadow of the paper under the ink, so it reads over the notes it passes.
  ctx.shadowColor = 'rgba(10,8,14,0.85)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = goldFill(ctx, 0, width, -height, 0, lampX - place.x, glint);
  let x = 0;
  for (const p of pieces) {
    ctx.font = p.font;
    ctx.fillText(p.text, x, p.dy ?? 0);
    x += ctx.measureText(p.text).width;
  }
  ctx.restore();
  sparkle(ctx, place.x, place.x + width, top, place.y, mark.text, mark.beat, lampX, place.alpha ?? 1, now);
  return width;
}
