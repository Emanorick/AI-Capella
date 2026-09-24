// The GPT check: each page image next to what Audiveris read from it, in a compact notation; GPT
// answers with the measures it would change (complete, per part), and each one is only written
// back when it still fills its bar (see applyMeasure).
import OpenAI from 'openai';
import type { Document } from '@xmldom/xmldom';
import { applyMeasure, compactPage, CorrectionError, partsOf, setPartName, type CompactNote } from './score.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT as 'low' | 'medium' | 'high' | undefined;

const INSTRUCTIONS = `You check the output of an optical music recognition program (Audiveris) against the printed page it was read from. The music is a choir score (usually a cappella, e.g. SATB or SSAATTBB, sometimes with a piano part).

You get the page image and, as JSON, what the program read for every measure on that page, per part:
- "m": the measure's position in the piece (use it to refer to the measure), "number": its printed number
- per note: "v" voice, "staff" (1 unless the part has several staves), "chord" (true = sounds together with the previous note of the same voice), "p" pitch as step + accidental + octave ("F#4", "Bb3", "C5"; octave 4 starts at middle C) or "rest", "d" duration in quarter notes as a fraction ("1" quarter, "1/2" eighth, "3/2" dotted quarter, "1/3" triplet eighth, "4" whole), "tie" (none/start/stop/both), "lyric" (the syllable under the note, with a trailing "-" when the word continues on the next syllable, e.g. "Eve-", "ning"; "" for none).

Compare carefully, measure by measure, part by part, with the image. Typical recognition errors: wrong pitch (off by a line/space, missed or wrong accidental, missed key-signature effect is NOT an error because pitches are written as sounding with the key applied), wrong rhythm (missed dot, flag or beam), missing or extra notes/rests, notes assigned to the wrong part or voice, wrong or missing lyric syllables, wrong clef effects (e.g. a tenor part in treble-8 clef read an octave too high).

Report ONLY measures that need a change. For each, give the part id, "m", a short reason, and the COMPLETE corrected note list of that part in that measure (not just the changed notes), in the same notation. Each voice must add up to the full measure length of the time signature (or exactly what the original had, for a pickup or a short last bar). Keep pitches written as they sound with the key signature applied (in G major an F on the page is "F#4"). Don't change anything you can't see clearly on the page -- when in doubt, leave the measure as it is.

Also: "partNames" -- the voice names printed at the start of the systems (e.g. "Sopran", "Alt", "Tenor", "Bass") for parts whose current name is missing or clearly wrong, otherwise []; "title" -- the piece's title if printed on this page, else ""; "confidence" -- how sure you are the page is now correct (high/medium/low); "remarks" -- one or two sentences on anything the singers should double-check, else "".`;

const NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'staff', 'chord', 'p', 'd', 'tie', 'lyric'],
  properties: {
    v: { type: 'integer' },
    staff: { type: 'integer' },
    chord: { type: 'boolean' },
    p: { type: 'string' },
    d: { type: 'string' },
    tie: { type: 'string', enum: ['none', 'start', 'stop', 'both'] },
    lyric: { type: 'string' },
  },
};

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['corrections', 'partNames', 'title', 'confidence', 'remarks'],
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'm', 'reason', 'notes'],
        properties: {
          part: { type: 'string' },
          m: { type: 'integer' },
          reason: { type: 'string' },
          notes: { type: 'array', items: NOTE_SCHEMA },
        },
      },
    },
    partNames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'name'],
        properties: { part: { type: 'string' }, name: { type: 'string' } },
      },
    },
    title: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    remarks: { type: 'string' },
  },
};

interface ReviewAnswer {
  corrections: { part: string; m: number; reason: string; notes: CompactNote[] }[];
  partNames: { part: string; name: string }[];
  title: string;
  confidence: 'high' | 'medium' | 'low';
  remarks: string;
}

export interface PageReport {
  page: number; // 1-based
  measures: string; // printed numbers, "1–8"
  // part: the voice's name (filled in once every page is checked -- see nameVoices), partId: its id
  applied: { part: string; partId: string; measure: string; reason: string }[];
  // detail: why it wasn't written back (English, for logs); the app shows its own wording.
  rejected: { part: string; partId: string; measure: string; reason: string; detail: string }[];
  confidence: 'high' | 'medium' | 'low' | 'unchecked';
  remarks: string;
}

let client: OpenAI | null = null;
function openai(): OpenAI {
  // OPENAI_API_KEY (and OPENAI_BASE_URL, for tests) are read from the environment by the SDK.
  client ??= new OpenAI({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  return client;
}

/** Asks GPT about one page; returns its parsed answer. */
async function askPage(image: { mediaType: string; base64: string }, payload: unknown, lang: 'de' | 'en'): Promise<ReviewAnswer> {
  const response = await openai().responses.create({
    model: MODEL,
    ...(REASONING_EFFORT ? { reasoning: { effort: REASONING_EFFORT } } : {}),
    instructions: `${INSTRUCTIONS}\n\nWrite "reason" and "remarks" in ${lang === 'de' ? 'German' : 'English'}, briefly, for choir singers.`,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: `data:${image.mediaType};base64,${image.base64}`, detail: 'high' },
          { type: 'input_text', text: `What the recognition program read from this page:\n${JSON.stringify(payload)}` },
        ],
      },
    ],
    text: { format: { type: 'json_schema', name: 'omr_page_review', schema: RESPONSE_SCHEMA, strict: true } },
  });
  const raw = response.output_text;
  if (!raw) throw new Error('empty answer');
  return JSON.parse(raw) as ReviewAnswer;
}

/**
 * Checks one page and writes its accepted corrections into `doc`. A page whose check fails (API
 * error, unreadable answer) keeps Audiveris' reading and is reported as unchecked.
 */
export async function reviewPage(
  doc: Document,
  pageIndex: number,
  measureIdx: number[],
  image: { mediaType: string; base64: string },
  lang: 'de' | 'en' = 'en',
): Promise<{ report: PageReport; title: string }> {
  const { parts, measures } = compactPage(doc, measureIdx);
  const numberOf = new Map(measures.map((m) => [m.m, m.number]));
  const report: PageReport = {
    page: pageIndex + 1,
    measures: measures.length ? `${measures[0].number}–${measures[measures.length - 1].number}` : '',
    applied: [],
    rejected: [],
    confidence: 'unchecked',
    remarks: '',
  };
  if (!measures.length) return { report, title: '' };

  let answer: ReviewAnswer;
  try {
    answer = await askPage(image, { parts, measures }, lang);
  } catch (err) {
    report.remarks = `Check failed: ${err instanceof Error ? err.message : String(err)}`;
    return { report, title: '' };
  }

  const known = new Set(parts.map((p) => p.id));
  for (const pn of answer.partNames) if (known.has(pn.part) && pn.name.trim()) setPartName(doc, pn.part, pn.name.trim());
  const onPage = new Set(measureIdx.map((i) => i + 1));
  for (const c of answer.corrections) {
    const measure = numberOf.get(c.m) ?? String(c.m);
    const part = c.part;
    if (!onPage.has(c.m)) {
      report.rejected.push({ part, partId: part, measure, reason: c.reason, detail: 'not on this page' });
      continue;
    }
    try {
      applyMeasure(doc, c.part, c.m, c.notes);
      report.applied.push({ part, partId: part, measure, reason: c.reason });
    } catch (err) {
      if (!(err instanceof CorrectionError)) throw err;
      report.rejected.push({ part, partId: part, measure, reason: c.reason, detail: err.message });
    }
  }
  report.confidence = answer.confidence;
  report.remarks = answer.remarks;
  return { report, title: answer.title.trim() };
}

/** Names the voices in the reports the way the singers know them (after every page's name fixes). */
export function nameVoices(doc: Document, reports: PageReport[]) {
  const names = new Map(partsOf(doc).map((p) => [p.ref.id, p.ref.name]));
  for (const r of reports) for (const e of [...r.applied, ...r.rejected]) e.part = names.get(e.partId) ?? e.partId;
}
