// The second run: each page image next to what was read from it (in the compact notation,
// notation.ts), with what the automatic checks found odd. GPT answers with the measures it would
// change (complete, per part), marks and repeat signs that were missed, and -- where it still can't
// tell -- a question for the person who scanned, with the readings it hesitates between. A
// correction is only written back when it still fills its bar (score.ts applyMeasure).
import type { Document } from '@xmldom/xmldom';
import { addMarks, setBarlines, type Box, type Mark } from './build.js';
import { imageInput, openai, MODEL, REASONING, type PageImage } from './ai.js';
import type { Voice } from './notation.js';
import { applyMeasure, compactPage, CorrectionError, measureEl, partsOf, setPartName } from './score.js';

const LANGUAGE = { de: 'German', en: 'English' } as const;

export const NOTATION_HELP = `Music is written in a compact notation, one string per note, each voice a list of them:
- "C5 1": pitch and duration. Durations in quarter notes as a fraction: "1/2" eighth, "1" quarter, "3/2" dotted quarter, "2" half, "4" whole, "1/4" sixteenth, "1/3" triplet eighth, "2/3" triplet quarter.
- Pitches as they SOUND with the key signature applied (in G major an F on the page is "F#4"); octave 4 starts at middle C; "Bb3", "F##4". A tenor part in a treble clef with an 8 below sounds an octave lower than written ("G3" for the G on the second line).
- "r 2": a rest. A whole-bar rest is a rest as long as the bar ("r 3" in 3/4).
- "C5 2~": tied to the next note of the same pitch in this voice (also across the bar line).
- "+E5 1": sounds together with the previous note of the same voice (a chord).
- "C5 1 :Eve-|Come": the words under the note, verse by verse, separated by "|"; a trailing "-" means the word goes on with the voice's next syllable; a trailing "_" ("ah_") that the syllable is held over the following notes (a melisma line); "_" alone that the previous syllable is still held here; leave a verse empty where it has no syllable ("C5 1 :|day").
- "xF5 1/2": a percussion note (clap, drum) printed where F5 would be.
A voice is {"v": voice number, "staff": staff number (1 unless the part has several staves), "notes": [...]}. Each voice of a measure must add up to the full bar of the time signature (a pickup or a short last bar: what is printed). Leave out grace notes.`;

const INSTRUCTIONS = `You check a choir score that was read from the printed page shown in the image (a second, careful look -- the first reading was done without you). You get the image and, as JSON, what was read for every measure on that page, per part ("m" is the measure's position in the piece -- use it to refer to it; "number" is its printed number).

${NOTATION_HELP}

Compare carefully, measure by measure, part by part, with the image. Look especially at the measures listed under "lookAt" (the automatic checks or the first reading found something odd there). Typical errors: wrong pitch (a line or space off, a missed accidental, a clef's effect), wrong rhythm (a missed dot, flag, beam or triplet), missing or extra notes or rests, notes in the wrong part or voice, wrong or missing words, a verse missing.

Report:
- "corrections": ONLY measures that need a change: the part id, "m", a short reason, and the COMPLETE corrected voices of that part in that measure, every verse of the words included. Don't change anything you can't see clearly.
- Words: fix syllables that were clearly misread (letters confused -- "ii" for "ü", "B" for "ß", "rn" for "m"), but only where the page shows the right word plainly; keep the language and spelling of the page. When several verses stand under the notes, every verse goes into the notes in order (verse 1 first).
- "barlines": repeat signs, volta brackets (1. / 2. endings) and final bars that were missed or misread, per measure ("m"): "start" is "repeat" for a |: at its beginning, else "none"; "end" is "repeat" for :| at its end, "final" for the final bar, "double" for a double bar, else "normal"; "times" is how often a repeated passage is played in all when printed (e.g. 3 for "3x"), else 0; "endingNumbers" the numbers of a volta bracket over this measure ("1", "1, 2"; "" for none) with "endingStart"/"endingStop" for where the bracket begins and ends. When several verses stand under one passage that has no repeat signs (a strophic song), add a repeat around that passage with "times" = the number of verses. Leave out measures whose bar lines are right.
- "marks": rehearsal letters or numbers (kind "rehearsal"), tempo marks ("tempo", with "bpm" for a metronome mark in quarter notes per minute, else 0), segno, coda, D.C. ("dc"), D.S. ("ds"), Fine ("fine"), To Coda ("tocoda"), and other directions for everyone ("words") that are printed but missing; "part" "" for marks over the whole system. Leave out marks that are already there.
- "questions": where you still can't tell what is printed after looking closely (a smudge, an ambiguous accidental, cramped notes), ask the person who scanned -- at most 3 per page, only for things that matter for singing: the part id, "m", the question (short, plain, for a singer, naming the voice and what to look at), and 2 to 4 "options", each a label and the COMPLETE voices of that part in that measure for that reading.
- "doubts": measures you left as they are but aren't sure about (the singers should look at them), with a short note.
- "partNames": the voice names printed at the start of the systems (e.g. "Sopran", "Alt", "Tenor", "Bass") for parts whose current name is missing or clearly wrong, otherwise [].
- "title": the piece's title if printed on this page, else "".
- "confidence": how sure you are the page is now correct (high/medium/low); "remarks": one or two sentences on anything the singers should double-check, else "".`;

const VOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'staff', 'notes'],
  properties: { v: { type: 'integer' }, staff: { type: 'integer' }, notes: { type: 'array', items: { type: 'string' } } },
};

export const MARK_KINDS = ['rehearsal', 'tempo', 'words', 'dynamic', 'segno', 'coda', 'dc', 'ds', 'fine', 'tocoda'] as const;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['corrections', 'barlines', 'marks', 'questions', 'doubts', 'partNames', 'title', 'confidence', 'remarks'],
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'm', 'reason', 'voices'],
        properties: { part: { type: 'string' }, m: { type: 'integer' }, reason: { type: 'string' }, voices: { type: 'array', items: VOICE_SCHEMA } },
      },
    },
    barlines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['m', 'start', 'end', 'times', 'endingNumbers', 'endingStart', 'endingStop'],
        properties: {
          m: { type: 'integer' },
          start: { type: 'string', enum: ['none', 'repeat'] },
          end: { type: 'string', enum: ['normal', 'double', 'final', 'repeat'] },
          times: { type: 'integer' },
          endingNumbers: { type: 'string' },
          endingStart: { type: 'boolean' },
          endingStop: { type: 'boolean' },
        },
      },
    },
    marks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['m', 'kind', 'text', 'part', 'bpm'],
        properties: { m: { type: 'integer' }, kind: { type: 'string', enum: [...MARK_KINDS] }, text: { type: 'string' }, part: { type: 'string' }, bpm: { type: 'number' } },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'm', 'question', 'options'],
        properties: {
          part: { type: 'string' },
          m: { type: 'integer' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['label', 'voices'], properties: { label: { type: 'string' }, voices: { type: 'array', items: VOICE_SCHEMA } } },
          },
        },
      },
    },
    doubts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['part', 'm', 'note'], properties: { part: { type: 'string' }, m: { type: 'integer' }, note: { type: 'string' } } },
    },
    partNames: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['part', 'name'], properties: { part: { type: 'string' }, name: { type: 'string' } } },
    },
    title: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    remarks: { type: 'string' },
  },
};

interface ReviewAnswer {
  corrections: { part: string; m: number; reason: string; voices: Voice[] }[];
  barlines: { m: number; start: 'none' | 'repeat'; end: 'normal' | 'double' | 'final' | 'repeat'; times: number; endingNumbers: string; endingStart: boolean; endingStop: boolean }[];
  marks: { m: number; kind: Mark['kind']; text: string; part: string; bpm: number }[];
  questions: { part: string; m: number; question: string; options: { label: string; voices: Voice[] }[] }[];
  doubts: { part: string; m: number; note: string }[];
  partNames: { part: string; name: string }[];
  title: string;
  confidence: 'high' | 'medium' | 'low';
  remarks: string;
}

/** A measure the checks (or the first reading) found odd, for the second look. */
export interface Hint {
  part: string; // "" for all
  m: number;
  note: string;
}

export interface Question {
  id: string;
  page: number; // 0-based
  m: number;
  measure: string; // printed number
  part: string; // the voice's name (see nameVoices)
  partId: string;
  question: string;
  options: { label: string; voices: Voice[] }[];
  status: 'open' | 'answered' | 'skipped' | 'failed';
  answer: string; // what was chosen or typed
  note: string; // what came of it (a typed answer: what was changed; failed: why not)
  box: Box | null; // where the measure stands on its page (filled in by the pipeline)
}

export interface Doubt {
  page: number;
  m: number;
  measure: string;
  part: string;
  partId: string;
  note: string;
  box: Box | null;
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

/** Asks GPT about one page; returns its parsed answer. */
async function askPage(image: PageImage, payload: unknown, lang: 'de' | 'en'): Promise<ReviewAnswer> {
  const response = await openai().responses.create({
    model: MODEL,
    ...REASONING,
    instructions: `${INSTRUCTIONS}\n\nWrite "reason", "question", option labels, "note" and "remarks" in ${LANGUAGE[lang]}, briefly, for choir singers.`,
    input: [
      {
        role: 'user',
        content: [
          imageInput(image),
          { type: 'input_text', text: `What was read from this page:\n${JSON.stringify(payload)}` },
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
 * Checks one page and writes its accepted corrections, bar lines and marks into `doc`. A page whose
 * check fails (API error, unreadable answer) keeps the first reading and is reported as unchecked.
 */
export async function reviewPage(
  doc: Document,
  pageIndex: number,
  measureIdx: number[],
  image: PageImage,
  lang: 'de' | 'en' = 'en',
  hints: Hint[] = [],
): Promise<{ report: PageReport; title: string; questions: Question[]; doubts: Doubt[] }> {
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
  if (!measures.length) return { report, title: '', questions: [], doubts: [] };

  let answer: ReviewAnswer;
  try {
    answer = await askPage(image, { parts, measures, lookAt: hints }, lang);
  } catch (err) {
    report.remarks = `Check failed: ${err instanceof Error ? err.message : String(err)}`;
    return { report, title: '', questions: [], doubts: [] };
  }

  const known = new Set(parts.map((p) => p.id));
  for (const pn of answer.partNames) if (known.has(pn.part) && pn.name.trim()) setPartName(doc, pn.part, pn.name.trim());
  const onPage = new Set(measureIdx.map((i) => i + 1));
  for (const c of answer.corrections) {
    const measure = numberOf.get(c.m) ?? String(c.m);
    if (!onPage.has(c.m)) {
      report.rejected.push({ part: c.part, partId: c.part, measure, reason: c.reason, detail: 'not on this page' });
      continue;
    }
    try {
      applyMeasure(doc, c.part, c.m, c.voices);
      report.applied.push({ part: c.part, partId: c.part, measure, reason: c.reason });
    } catch (err) {
      if (!(err instanceof CorrectionError)) throw err;
      report.rejected.push({ part: c.part, partId: c.part, measure, reason: c.reason, detail: err.message });
    }
  }
  // Repeat signs and voltas belong to every part's bar lines.
  for (const b of answer.barlines) {
    if (!onPage.has(b.m)) continue;
    const numbers = b.endingNumbers.split(/[^0-9]+/).map(Number).filter((n) => n > 0);
    const ending = numbers.length && (b.endingStart || b.endingStop) ? { numbers, start: b.endingStart, stop: b.endingStop } : null;
    for (const p of partsOf(doc)) {
      const el = measureEl(p.el, b.m - 1);
      if (el) setBarlines(el, { barStart: b.start, barEnd: b.end, repeatTimes: Math.max(0, b.times), ending });
    }
  }
  const first = partsOf(doc)[0];
  for (const mk of answer.marks) {
    if (!onPage.has(mk.m)) continue;
    const target = mk.part && known.has(mk.part) ? partsOf(doc).find((p) => p.ref.id === mk.part) : first;
    const el = target && measureEl(target.el, mk.m - 1);
    if (el) addMarks(el, [{ kind: mk.kind, text: mk.text, part: mk.part, bpm: mk.bpm }]);
  }
  const questions: Question[] = answer.questions
    .filter((q) => onPage.has(q.m) && known.has(q.part) && q.options.length >= 2)
    .slice(0, 3)
    .map((q, i) => ({
      id: `p${pageIndex + 1}q${i + 1}`,
      page: pageIndex,
      m: q.m,
      measure: numberOf.get(q.m) ?? String(q.m),
      part: q.part,
      partId: q.part,
      question: q.question,
      options: q.options.slice(0, 4),
      status: 'open',
      answer: '',
      note: '',
      box: null,
    }));
  const doubts: Doubt[] = answer.doubts
    .filter((d) => onPage.has(d.m))
    .map((d) => ({ page: pageIndex, m: d.m, measure: numberOf.get(d.m) ?? String(d.m), part: d.part, partId: d.part, note: d.note, box: null }));
  report.confidence = answer.confidence;
  report.remarks = answer.remarks;
  return { report, title: answer.title.trim(), questions, doubts };
}

/** Names the voices in the reports and questions the way the singers know them (after every page's name fixes). */
export function nameVoices(doc: Document, reports: PageReport[], questions: Question[] = [], doubts: Doubt[] = []) {
  const names = new Map(partsOf(doc).map((p) => [p.ref.id, p.ref.name]));
  for (const r of reports) for (const e of [...r.applied, ...r.rejected]) e.part = names.get(e.partId) ?? e.partId;
  for (const q of questions) q.part = names.get(q.partId) ?? q.partId;
  for (const d of doubts) d.part = d.partId ? (names.get(d.partId) ?? d.partId) : '';
}

// ---- an answer typed in for a question ------------------------------------------------------------

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['understood', 'voices', 'note'],
  properties: { understood: { type: 'boolean' }, voices: { type: 'array', items: VOICE_SCHEMA }, note: { type: 'string' } },
};

/**
 * Turns what someone typed in answer to a question into the measure it describes: the page image,
 * the measure as it stands, the question and the answer. Null when the answer can't be made into
 * notes (then the measure stays as it is).
 */
export async function voicesFromAnswer(
  image: PageImage,
  payload: { part: string; m: number; question: string; current: Voice[]; time: string; fifths: number; answer: string },
  lang: 'de' | 'en',
): Promise<{ voices: Voice[]; note: string } | null> {
  const response = await openai().responses.create({
    model: MODEL,
    ...REASONING,
    instructions: `A choir score was read from the printed page in the image. For one measure of one part, the person who scanned it was asked a question, and answered in their own words. Write that measure of that part as the answer describes it, using the page to fill in what the answer doesn't say.

${NOTATION_HELP}

Answer with "understood" (false if the answer doesn't say what the measure should be, or contradicts the page in a way you can't resolve), the COMPLETE voices of that part in that measure, and a short "note" in ${LANGUAGE[lang]} on what you changed.`,
    input: [
      {
        role: 'user',
        content: [
          imageInput(image),
          { type: 'input_text', text: JSON.stringify(payload) },
        ],
      },
    ],
    text: { format: { type: 'json_schema', name: 'omr_answer', schema: ANSWER_SCHEMA, strict: true } },
  });
  const raw = response.output_text;
  if (!raw) return null;
  const out = JSON.parse(raw) as { understood: boolean; voices: Voice[]; note: string };
  return out.understood && out.voices.length ? { voices: out.voices, note: out.note } : null;
}
