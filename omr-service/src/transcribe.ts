// The first reading, without a recognition program: GPT reads each page image into the compact
// notation (notation.ts) -- the parts, every measure of every part with the words of every verse,
// time and key signatures, repeat signs, voltas, rehearsal letters, tempo and jumps -- together
// with where each measure stands on the page (for showing it later) and what it wasn't sure of.
// The first page is read first and fixes the parts; the others are read with that list. The
// pages are then put together into one transcription (build.ts makes the MusicXML).
import { MARK_KINDS, NOTATION_HELP, type Hint } from './review.js';
import { imageInput, openai, MODEL, REASONING, type PageImage } from './ai.js';
import { parseVoices, type Voice } from './notation.js';
import type { Mark, Transcript, TranscriptMeasure, TranscriptPart } from './build.js';

const INSTRUCTIONS = `You transcribe a printed choir score (usually a cappella, e.g. SATB or SSAATTBB, sometimes with piano or band parts) from the image of one page into a compact notation, exactly as printed.

${NOTATION_HELP}

Read every system from top to bottom, and in each system every measure from left to right, every part. Then answer with:
- "parts": the parts from top to bottom of a full system, as {"id", "name", "staves", "clefs"}. On the first page, give each part an id "P1", "P2", ... in order and its name as printed at the start of the first system (e.g. "Sopran", "Alt", "Tenor 1", "Bass"; for abbreviations like S, A, T, B write the full name; for a part without a printed name use its role, e.g. "Klavier"). "staves" is 2 for a piano part on a pair of staves, else 1; "clefs" per staff: "G2" treble, "G2-8" treble with an 8 below (a tenor part, sounding an octave lower), "F4" bass, "C3" alto clef, "C4" tenor clef, "percussion". When you are given the parts already (a later page), use exactly those ids and give "parts": [].
- "systems": per system on the page, from the top, "top" and "bottom" as fractions of the image height (0 = top edge, 1 = bottom edge): from the highest staff line of the system down to the lowest line of words under its lowest staff; and "parts": for each part printed in that system, its id with "top" and "bottom" of its staff (both staves for a piano) and the words under it, in the same fractions.
- "measures": every measure on the page in order, each with:
  - "number": its printed measure number if one is printed at it, else "";
  - "system": which system (1 = top) it stands in, and "left"/"right": where it begins and ends across the image width, as fractions (0 = left edge, 1 = right edge);
  - "time": the time signature where one is printed at this measure ("3/4", "6/8", "4/4" for C, "2/2" for alla breve), else "";
  - "keyPrinted": true where a key signature is printed at this measure (also at the start of a system), with "key" the number of sharps (positive) or flats (negative), else false and 0;
  - "barStart": "repeat" for |: at its beginning, else "none"; "barEnd": "repeat" for :|, "final" for the final bar, "double" for a double bar, else "normal"; "repeatTimes": how often a repeated passage is played when a number is printed (e.g. 3 for "3x"), else 0;
  - "endingNumbers": the numbers of a volta bracket over this measure ("1", "2", "1, 2"; "" for none), with "endingStart" true at the bracket's first measure and "endingStop" true at its last (both for a one-measure bracket);
  - "marks": printed at this measure: rehearsal letters or numbers ("rehearsal"), tempo marks ("tempo", text as printed and "bpm" for a metronome mark in quarter notes per minute, else 0), dynamics ("dynamic", e.g. "mf"), segno, coda, D.C. ("dc"), D.S. ("ds"), Fine ("fine"), To Coda ("tocoda"), and other directions ("words"); "part" is the part id for a mark printed at one part only, else "";
  - "parts": for EVERY part {"part": id, "voices": [...]}: the voices of that part in this measure. A part whose staff isn't printed in a system (an engraver hides staves that rest) gets one voice with a whole-bar rest.
- "stackedVerses": passages where several verses stand under the same notes (a strophic song) as {"first", "last", "verses"}: the positions (1 = first measure on this page) of the first and last measure of the passage, and how many verses stand under it. [] if there are none.
- "doubts": places you couldn't read with certainty, as {"measure" (position on this page, 1 = first), "part" (id, or "" for all), "note" (what is unclear)}.
- "title": the piece's title if printed on this page, else "".
- "confidence": how sure you are of the whole page (high/medium/low).

Durations of each voice must add up to the bar (a pickup or a short last bar: what is printed). Write the words exactly as printed, every verse in order (verse 1 first; follow printed verse numbers "1.", "2." where there are some); a refrain with a single line of words under it has only verse 1. Leave out grace notes, fingerings, chord symbols and slurs. Where something is hard to read, write your best reading and add a doubt.`;

const VOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'staff', 'notes'],
  properties: { v: { type: 'integer' }, staff: { type: 'integer' }, notes: { type: 'array', items: { type: 'string' } } },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['parts', 'systems', 'measures', 'stackedVerses', 'doubts', 'title', 'confidence'],
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'staves', 'clefs'],
        properties: { id: { type: 'string' }, name: { type: 'string' }, staves: { type: 'integer' }, clefs: { type: 'array', items: { type: 'string' } } },
      },
    },
    systems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['top', 'bottom', 'parts'],
        properties: {
          top: { type: 'number' },
          bottom: { type: 'number' },
          parts: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['part', 'top', 'bottom'], properties: { part: { type: 'string' }, top: { type: 'number' }, bottom: { type: 'number' } } },
          },
        },
      },
    },
    measures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'system', 'left', 'right', 'time', 'keyPrinted', 'key', 'barStart', 'barEnd', 'repeatTimes', 'endingNumbers', 'endingStart', 'endingStop', 'marks', 'parts'],
        properties: {
          number: { type: 'string' },
          system: { type: 'integer' },
          left: { type: 'number' },
          right: { type: 'number' },
          time: { type: 'string' },
          keyPrinted: { type: 'boolean' },
          key: { type: 'integer' },
          barStart: { type: 'string', enum: ['none', 'repeat'] },
          barEnd: { type: 'string', enum: ['normal', 'double', 'final', 'repeat'] },
          repeatTimes: { type: 'integer' },
          endingNumbers: { type: 'string' },
          endingStart: { type: 'boolean' },
          endingStop: { type: 'boolean' },
          marks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'text', 'part', 'bpm'],
              properties: { kind: { type: 'string', enum: [...MARK_KINDS] }, text: { type: 'string' }, part: { type: 'string' }, bpm: { type: 'number' } },
            },
          },
          parts: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['part', 'voices'], properties: { part: { type: 'string' }, voices: { type: 'array', items: VOICE_SCHEMA } } },
          },
        },
      },
    },
    stackedVerses: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['first', 'last', 'verses'], properties: { first: { type: 'integer' }, last: { type: 'integer' }, verses: { type: 'integer' } } },
    },
    doubts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['measure', 'part', 'note'], properties: { measure: { type: 'integer' }, part: { type: 'string' }, note: { type: 'string' } } },
    },
    title: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export interface PageReading {
  parts: TranscriptPart[];
  systems: { top: number; bottom: number; parts: { part: string; top: number; bottom: number }[] }[];
  measures: {
    number: string;
    system: number;
    left: number;
    right: number;
    time: string;
    keyPrinted: boolean;
    key: number;
    barStart: 'none' | 'repeat';
    barEnd: 'normal' | 'double' | 'final' | 'repeat';
    repeatTimes: number;
    endingNumbers: string;
    endingStart: boolean;
    endingStop: boolean;
    marks: Mark[];
    parts: { part: string; voices: Voice[] }[];
  }[];
  stackedVerses: { first: number; last: number; verses: number }[];
  doubts: { measure: number; part: string; note: string }[];
  title: string;
  confidence: 'high' | 'medium' | 'low';
}

/** Reads one page. `parts`: the parts as the first page fixed them (none for the first page). */
export async function readPage(image: PageImage, pageIndex: number, pageCount: number, parts: TranscriptPart[] | null, lang: 'de' | 'en'): Promise<PageReading> {
  const context = parts
    ? `This is page ${pageIndex + 1} of ${pageCount}. The parts (use these ids): ${JSON.stringify(parts)}.`
    : `This is page 1 of ${pageCount}: name the parts.`;
  const response = await openai().responses.create({
    model: MODEL,
    ...REASONING,
    instructions: `${INSTRUCTIONS}\n\nWrite the "note" of each doubt in ${lang === 'de' ? 'German' : 'English'}, briefly.`,
    input: [
      {
        role: 'user',
        content: [
          imageInput(image),
          { type: 'input_text', text: context },
        ],
      },
    ],
    text: { format: { type: 'json_schema', name: 'omr_page_transcription', schema: SCHEMA, strict: true } },
  });
  const raw = response.output_text;
  if (!raw) throw new Error(`page ${pageIndex + 1}: empty answer`);
  return JSON.parse(raw) as PageReading;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const CLEF = /^([GFC]\d([-+](8|15))?|percussion)$/;

/** The parts as read on the first page, made usable: unique ids, one clef per staff. */
export function cleanParts(parts: TranscriptPart[]): TranscriptPart[] {
  const seen = new Set<string>();
  return parts.map((p, i) => {
    let id = (p.id || `P${i + 1}`).replace(/[^\w-]/g, '') || `P${i + 1}`;
    while (seen.has(id)) id += 'b';
    seen.add(id);
    const staves = Math.min(4, Math.max(1, Math.round(p.staves) || 1));
    const clefs = Array.from({ length: staves }, (_, s) => (CLEF.test(p.clefs[s] ?? '') ? p.clefs[s] : s === 0 ? 'G2' : 'F4'));
    return { id, name: (p.name || id).trim(), staves, clefs };
  });
}

/**
 * The parts as the first page names them, made usable (cleanParts), with that page's own
 * references to them renamed to match.
 */
export function adoptParts(first: PageReading): TranscriptPart[] {
  const parts = cleanParts(first.parts);
  const rename = new Map<string, string>();
  first.parts.forEach((p, i) => {
    if (!rename.has(p.id)) rename.set(p.id, parts[i].id);
  });
  const to = (id: string) => rename.get(id) ?? id;
  // (In marks and doubts "" means every part, not a part without an id.)
  const toOrAll = (id: string) => (id ? to(id) : id);
  for (const m of first.measures) {
    for (const p of m.parts) p.part = to(p.part);
    for (const mk of m.marks) mk.part = toOrAll(mk.part);
  }
  for (const d of first.doubts) d.part = toOrAll(d.part);
  for (const sys of first.systems) for (const p of sys.parts ?? []) p.part = to(p.part);
  return parts;
}

/**
 * The pages put together into one transcription. Measures a part's voices couldn't be read in
 * (a malformed note string) get a whole-bar rest there, and a hint for the second run; so do the
 * reading's own doubts. Passages with stacked verses and no repeat signs of their own get a repeat
 * around them, played as often as there are verses (the app sings verse n on pass n).
 */
export function stitch(pages: PageReading[], parts: TranscriptPart[]): { transcript: Transcript; hints: Hint[]; title: string } {
  const ids = new Set(parts.map((p) => p.id));
  const measures: TranscriptMeasure[] = [];
  const hints: Hint[] = [];
  const blocks: { first: number; last: number; verses: number }[] = [];
  let title = '';
  pages.forEach((page, pageIndex) => {
    title ||= page.title?.trim() ?? '';
    const base = measures.length;
    for (const [i, r] of page.measures.entries()) {
      const sys = page.systems[r.system - 1];
      const numbers = r.endingNumbers.split(/[^0-9]+/).map(Number).filter((n) => n > 0);
      const m: TranscriptMeasure = {
        number: /^\d+$/.test(r.number.trim()) ? r.number.trim() : '',
        page: pageIndex,
        box: sys ? { x0: clamp01(r.left), x1: clamp01(r.right), y0: clamp01(sys.top), y1: clamp01(sys.bottom) } : null,
        rows: sys ? Object.fromEntries((sys.parts ?? []).filter((p) => ids.has(p.part) && p.bottom > p.top).map((p) => [p.part, [clamp01(p.top), clamp01(p.bottom)] as [number, number]])) : {},
        time: /^\d+\/\d+$/.test(r.time.trim()) ? r.time.trim() : null,
        key: r.keyPrinted && Math.abs(r.key) <= 7 ? Math.round(r.key) : null,
        barStart: r.barStart,
        barEnd: r.barEnd,
        repeatTimes: Math.max(0, Math.round(r.repeatTimes) || 0),
        // (A measure inside a bracket carries its numbers without start or stop: nothing to write.)
        ending: numbers.length && (r.endingStart || r.endingStop) ? { numbers, start: r.endingStart, stop: r.endingStop } : null,
        marks: r.marks.filter((mk) => !mk.part || ids.has(mk.part)),
        parts: {},
      };
      for (const p of r.parts) {
        if (!ids.has(p.part)) continue;
        try {
          parseVoices(p.voices);
          m.parts[p.part] = p.voices;
        } catch (err) {
          hints.push({ part: p.part, m: base + i + 1, note: `the first reading of this measure couldn't be read (${err instanceof Error ? err.message : err}) -- it is a rest now; transcribe it` });
        }
      }
      measures.push(m);
    }
    for (const d of page.doubts) if (d.measure >= 1 && d.measure <= page.measures.length) hints.push({ part: ids.has(d.part) ? d.part : '', m: base + d.measure, note: `first reading unsure: ${d.note}` });
    for (const b of page.stackedVerses) {
      if (b.verses >= 2 && b.first >= 1 && b.last >= b.first && b.last <= page.measures.length) blocks.push({ first: base + b.first - 1, last: base + b.last - 1, verses: b.verses });
    }
  });
  // Numbers where none were printed: counting on from the previous one.
  measures.forEach((m, i) => {
    if (!m.number) m.number = String(i === 0 ? 1 : (Number(measures[i - 1].number) || i) + 1);
  });
  // A strophic passage spread over two pages is one passage.
  blocks.sort((a, b) => a.first - b.first);
  const merged: typeof blocks = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && b.first <= prev.last + 1 && b.verses === prev.verses) prev.last = Math.max(prev.last, b.last);
    else merged.push({ ...b });
  }
  for (const b of merged) {
    const inside = measures.slice(b.first, b.last + 1);
    if (inside.some((m) => m.barStart === 'repeat' || m.barEnd === 'repeat')) continue;
    measures[b.first].barStart = 'repeat';
    measures[b.last].barEnd = 'repeat';
    measures[b.last].repeatTimes = b.verses;
  }
  return { transcript: { title, parts, measures }, hints, title };
}
