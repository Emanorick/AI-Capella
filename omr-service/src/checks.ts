// Plausibility checks on a score as read, without GPT: what a careful singer would frown at.
// They don't change anything; the measures they find odd are handed to the second run as places
// to look at closely (review.ts "lookAt").
import type { Document } from '@xmldom/xmldom';
import { parseVoices, pitchText, voiceLength, type NoteEv } from './notation.js';
import { compactPage, partsOf } from './score.js';
import type { Hint } from './review.js';

// Comfortable ranges (MIDI numbers, sounding) by the voice names choirs use, with a little room.
const RANGES: [RegExp, number, number, string][] = [
  [/sopr|^s\s*\d*$|^s\.|diskant|treble/i, 57, 84, 'soprano'],
  [/mezzo/i, 55, 81, 'mezzo'],
  [/alt|alto|^a\s*\d*$|^a\./i, 52, 79, 'alto'],
  [/tenor|^t\s*\d*$|^t\./i, 45, 72, 'tenor'],
  [/bari/i, 40, 69, 'baritone'],
  [/bass|^b\s*\d*$|^b\./i, 34, 67, 'bass'],
];

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>;
const midiOf = (n: NoteEv) => 12 * (n.octave + 1) + STEP[n.step] + n.alter;

/** The measures of `doc` a careful reader would look at twice, with why. */
export function plausibility(doc: Document): Hint[] {
  const hints: Hint[] = [];
  const parts = partsOf(doc);
  const count = parts[0] ? parts[0].el.getElementsByTagName('measure').length : 0;
  if (!count) return hints;
  const { measures } = compactPage(doc, Array.from({ length: count }, (_, i) => i));
  for (const { ref } of parts) {
    const range = RANGES.find(([re]) => re.test(ref.name.trim()));
    const vocal = !!range;
    // Each voice's notes through the piece, for leaps and ties across bar lines.
    const lastOf = new Map<number, { n: NoteEv; m: number }>();
    measures.forEach((cm, i) => {
      const voices = cm.parts[ref.id];
      if (!voices) return;
      let parsed;
      try {
        parsed = parseVoices(voices);
      } catch {
        hints.push({ part: ref.id, m: cm.m, note: 'notes that cannot be read' });
        return;
      }
      const [b, bt] = cm.time.split('/').map(Number);
      const bar = (4 * b) / bt;
      const edge = i === 0 || i === count - 1; // a pickup or a short last bar
      for (const v of parsed) {
        const len = voiceLength(v.notes);
        const q = len.num / len.den;
        if (!edge && Math.abs(q - bar) > 1e-9) hints.push({ part: ref.id, m: cm.m, note: `voice ${v.v} adds up to ${q} quarters, the ${cm.time} bar to ${bar}` });
        let prev = lastOf.get(v.v) ?? null;
        for (const n of v.notes) {
          if (n.chord) continue;
          if (n.rest) {
            if (prev?.n.verses.some((w) => w.endsWith('-'))) hints.push({ part: ref.id, m: cm.m, note: `a word broken off before a rest ("${prev.n.verses.find((w) => w.endsWith('-'))}")` });
            prev = null;
            continue;
          }
          if (n.unpitched) continue;
          const midi = midiOf(n);
          if (range && (midi < range[1] || midi > range[2])) hints.push({ part: ref.id, m: cm.m, note: `${pitchText(n)} is unusual for a ${range[3]} part (a clef or octave misread?)` });
          if (prev && vocal && Math.abs(midi - midiOf(prev.n)) > 12) hints.push({ part: ref.id, m: cm.m, note: `a leap of more than an octave to ${pitchText(n)}` });
          if (prev?.n.tie && midiOf(prev.n) !== midi) hints.push({ part: ref.id, m: cm.m, note: `a tie from ${pitchText(prev.n)} to a different note, ${pitchText(n)}` });
          prev = { n, m: cm.m };
        }
        lastOf.set(v.v, prev ?? { n: { chord: false, rest: true, unpitched: false, step: '', alter: 0, octave: 0, num: 1, den: 1, tie: false, verses: [] }, m: cm.m });
      }
    });
  }
  // One hint per part and measure is enough to send the second run there.
  const seen = new Set<string>();
  return hints.filter((h) => {
    const key = `${h.part}|${h.m}|${h.note.split(' ')[0]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
