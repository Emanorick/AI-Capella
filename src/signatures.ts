// Time and key signatures in the ruler of both views: at the first bar and wherever the metre or
// the key changes, a small stacked time signature (as engraved) and the new key as a row of
// sharps or flats, next to the bar number.

import type { MeasureInfo } from './score';
import { FONT_MUSIC } from './theme';

export interface SignatureChange {
  beat: number;
  time?: { beats: number; beatType: number };
  fifths?: number; // untransposed
  keyChange: boolean; // a key change after the start (bar lines double there)
}

/** Bar 1's signatures, and every bar where the time or key signature differs from the bar before. */
export function signatureChanges(measures: MeasureInfo[]): SignatureChange[] {
  const out: SignatureChange[] = [];
  measures.forEach((m, i) => {
    const prev = measures[i - 1];
    const timeChanged = !prev || prev.beats !== m.beats || prev.beatType !== m.beatType;
    const keyChanged = !prev || prev.fifths !== m.fifths;
    if (!timeChanged && !keyChanged) return;
    out.push({
      beat: m.startBeat,
      time: timeChanged ? { beats: m.beats, beatType: m.beatType } : undefined,
      fifths: keyChanged ? m.fifths : undefined,
      keyChange: !!prev && keyChanged,
    });
  });
  return out;
}

/** A key signature moved by a transposition of `semitones`, along the circle of fifths. */
export function transposeFifths(fifths: number, semitones: number): number {
  const r = (((semitones * 7) % 12) + 12) % 12;
  return fifths + (r > 6 ? r - 12 : r);
}

/** SMuFL time signature digits (timeSig0..9). */
export function timeSigText(n: number): string {
  return String(n)
    .split('')
    .map((d) => String.fromCharCode(0xe080 + Number(d)))
    .join('');
}

const FLAT = '';
const SHARP = '';
const NATURAL = '';

/**
 * Draws a signature change into a 28px ruler from x; returns how wide it came out. `fifths` is the
 * transposed key (only drawn when the key changed there); C major after another key shows a natural.
 */
export function drawRulerSignature(ctx: CanvasRenderingContext2D, change: SignatureChange, fifths: number | undefined, x: number, color: string): number {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  let at = x;
  if (fifths !== undefined && (fifths !== 0 || change.keyChange)) {
    ctx.font = `21px ${FONT_MUSIC}`;
    const glyph = fifths > 0 ? SHARP : fifths < 0 ? FLAT : NATURAL;
    const count = Math.max(1, Math.min(7, Math.abs(fifths)));
    for (let i = 0; i < count; i++) {
      // A little staircase, as the accidentals of a key signature climb and fall on the staff.
      const lift = (fifths >= 0 ? [4, 1, 5, 2, -1, 3, 0][i] : [0, 3, -1, 2, -2, 1, -3][i]) * 1.2;
      ctx.fillText(glyph, at, 19 - lift);
      at += 6.6;
    }
    at += 8;
  }
  if (change.time) {
    ctx.font = `21px ${FONT_MUSIC}`;
    const top = timeSigText(change.time.beats);
    const bottom = timeSigText(change.time.beatType);
    const w = Math.max(ctx.measureText(top).width, ctx.measureText(bottom).width);
    ctx.fillText(top, at + (w - ctx.measureText(top).width) / 2, 8.5);
    ctx.fillText(bottom, at + (w - ctx.measureText(bottom).width) / 2, 20);
    at += w;
  }
  ctx.restore();
  return at - x;
}
