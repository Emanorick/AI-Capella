// MusicXML handling for the scan pipeline: reading Audiveris' .mxl output, splitting a score into
// the printed pages it came from, a compact per-page notation for the GPT check, and writing the
// checked measures back -- only when they still add up to a full bar.
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, strFromU8 } from 'fflate';

export type Tie = 'none' | 'start' | 'stop' | 'both';

/** One note or rest in the compact notation the GPT check reads and answers in. */
export interface CompactNote {
  v: number; // voice
  staff: number; // 1 unless the part has several staves
  chord: boolean; // sounds together with the previous note of the same voice
  p: string; // "F#4", "Bb3", "C5", or "rest"
  d: string; // duration in quarter notes, as a fraction: "1", "1/2", "3/2", "1/3"
  tie: Tie;
  lyric: string; // syllable, "-" at the end when the word continues ("Eve-"); "" for none
}

export interface CompactMeasure {
  m: number; // 1-based position in the part (measure numbers in files can repeat or skip)
  number: string; // the printed measure number
  time: string; // "4/4"
  fifths: number;
  parts: Record<string, CompactNote[]>;
}

export interface PartRef {
  id: string;
  name: string;
}

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (!doc.documentElement || doc.documentElement.nodeName !== 'score-partwise') {
    throw new Error('Not a partwise MusicXML score');
  }
  return doc;
}

export function serializeXml(doc: Document): string {
  const body = new XMLSerializer().serializeToString(doc);
  return body.startsWith('<?xml') ? body : `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/** The MusicXML text inside a compressed .mxl (the rootfile named in META-INF/container.xml). */
export function readMxl(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const container = files['META-INF/container.xml'];
  let root: string | undefined;
  if (container) {
    const m = strFromU8(container).match(/full-path="([^"]+)"/);
    if (m) root = m[1];
  }
  root ??= Object.keys(files).find((f) => !f.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(f));
  if (!root || !files[root]) throw new Error('No score inside the .mxl file');
  return strFromU8(files[root]);
}

const kids = (el: Element, name?: string): Element[] => {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || n.nodeName === name)) out.push(n as Element);
  }
  return out;
};
const kid = (el: Element, name: string): Element | undefined => kids(el, name)[0];
const text = (el: Element | undefined): string => (el?.textContent ?? '').trim();

export function partsOf(doc: Document): { ref: PartRef; el: Element }[] {
  const names = new Map<string, string>();
  const list = doc.getElementsByTagName('score-part');
  for (let i = 0; i < list.length; i++) {
    const sp = list[i] as Element;
    names.set(sp.getAttribute('id') ?? '', text(kid(sp, 'part-name')));
  }
  return kids(doc.documentElement as Element, 'part').map((el) => {
    const id = el.getAttribute('id') ?? '';
    return { ref: { id, name: names.get(id) || id }, el };
  });
}

/**
 * Which page each measure (by position) was printed on, from the page breaks Audiveris writes
 * (<print new-page="yes"> or a page-number) on the first part. Returns null when the file has no
 * page breaks at all.
 */
export function pageOfMeasures(doc: Document): number[] | null {
  const first = partsOf(doc)[0];
  if (!first) return [];
  const pages: number[] = [];
  let page = 0;
  let sawBreak = false;
  kids(first.el, 'measure').forEach((measure, i) => {
    const print = kid(measure, 'print');
    if (i > 0 && print && (print.getAttribute('new-page') === 'yes' || print.getAttribute('page-number'))) {
      page++;
      sawBreak = true;
    }
    pages.push(page);
  });
  return sawBreak ? pages : null;
}

/** Measures grouped by page; without page breaks in the file, spread evenly over `pageCount` pages. */
export function measuresByPage(doc: Document, pageCount: number): number[][] {
  const total = partsOf(doc)[0] ? kids(partsOf(doc)[0].el, 'measure').length : 0;
  const pages = pageOfMeasures(doc) ?? Array.from({ length: total }, (_, i) => Math.min(pageCount - 1, Math.floor((i * pageCount) / Math.max(total, 1))));
  const groups: number[][] = [];
  pages.forEach((p, i) => (groups[p] ??= []).push(i));
  return groups.map((g) => g ?? []);
}

// ---- fractions -------------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function fraction(num: number, den: number): string {
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  return d === 1 ? String(n) : `${n}/${d}`;
}

/** "3/2" -> 1.5; null when not a positive fraction. */
export function parseFraction(s: string): { num: number; den: number } | null {
  const m = String(s).trim().match(/^(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  if (!num || !den) return null;
  return { num, den };
}

// ---- reading measures into compact notation ---------------------------------------------------

interface PartState {
  divisions: number;
  beats: number;
  beatType: number;
  fifths: number;
  staves: number;
}

/** Walks a part's measures, tracking the attributes in effect at each one. */
function partStates(part: Element): PartState[] {
  const state: PartState = { divisions: 1, beats: 4, beatType: 4, fifths: 0, staves: 1 };
  return kids(part, 'measure').map((measure) => {
    for (const attrs of kids(measure, 'attributes')) {
      const div = Number(text(kid(attrs, 'divisions')));
      if (div > 0) state.divisions = div;
      const time = kid(attrs, 'time');
      if (time) {
        const b = Number(text(kid(time, 'beats')).split('+')[0]);
        const bt = Number(text(kid(time, 'beat-type')));
        if (b > 0 && bt > 0) {
          state.beats = b;
          state.beatType = bt;
        }
      }
      const key = kid(attrs, 'key');
      if (key && kid(key, 'fifths')) state.fifths = Number(text(kid(key, 'fifths'))) || 0;
      const staves = Number(text(kid(attrs, 'staves')));
      if (staves > 0) state.staves = staves;
    }
    return { ...state };
  });
}

function pitchName(note: Element): string {
  const pitch = kid(note, 'pitch');
  if (!pitch) return 'rest';
  const alter = Math.round(Number(text(kid(pitch, 'alter'))) || 0);
  const acc = alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter);
  return `${text(kid(pitch, 'step'))}${acc}${text(kid(pitch, 'octave'))}`;
}

function compactNotes(measure: Element, divisions: number): CompactNote[] {
  const out: CompactNote[] = [];
  for (const note of kids(measure, 'note')) {
    if (kid(note, 'grace') || kid(note, 'cue')) continue;
    const dur = Number(text(kid(note, 'duration'))) || 0;
    const ties = kids(note, 'tie').map((t) => t.getAttribute('type'));
    const tie: Tie = ties.includes('start') && ties.includes('stop') ? 'both' : ties.includes('start') ? 'start' : ties.includes('stop') ? 'stop' : 'none';
    const lyricEl = kid(note, 'lyric');
    let lyric = '';
    if (lyricEl) {
      lyric = text(kid(lyricEl, 'text'));
      const syl = text(kid(lyricEl, 'syllabic'));
      if (lyric && (syl === 'begin' || syl === 'middle')) lyric += '-';
    }
    out.push({
      v: Number(text(kid(note, 'voice'))) || 1,
      staff: Number(text(kid(note, 'staff'))) || 1,
      chord: !!kid(note, 'chord'),
      p: pitchName(note),
      d: fraction(dur, divisions),
      tie,
      lyric,
    });
  }
  return out;
}

/** The given measures (by position) of every part, in the compact notation. */
export function compactPage(doc: Document, measureIdx: number[]): { parts: PartRef[]; measures: CompactMeasure[] } {
  const parts = partsOf(doc);
  const states = parts.map((p) => partStates(p.el));
  const measureEls = parts.map((p) => kids(p.el, 'measure'));
  const measures: CompactMeasure[] = measureIdx.map((i) => {
    const s0 = states[0][i];
    const cm: CompactMeasure = {
      m: i + 1,
      number: measureEls[0][i]?.getAttribute('number') ?? String(i + 1),
      time: `${s0.beats}/${s0.beatType}`,
      fifths: s0.fifths,
      parts: {},
    };
    parts.forEach((p, k) => {
      const el = measureEls[k][i];
      if (el) cm.parts[p.ref.id] = compactNotes(el, states[k][i].divisions);
    });
    return cm;
  });
  return { parts: parts.map((p) => p.ref), measures };
}

// ---- writing corrections back ---------------------------------------------------------------

const TYPES: [number, string][] = [
  [4, 'whole'],
  [2, 'half'],
  [1, 'quarter'],
  [0.5, 'eighth'],
  [0.25, '16th'],
  [0.125, '32nd'],
  [0.0625, '64th'],
];

/** Note type and dot count for a duration in quarters, when it's a plain (possibly dotted) value. */
function typeAndDots(q: number): { type: string; dots: number } | null {
  for (const [base, type] of TYPES) {
    if (Math.abs(q - base) < 1e-9) return { type, dots: 0 };
    if (Math.abs(q - base * 1.5) < 1e-9) return { type, dots: 1 };
    if (Math.abs(q - base * 1.75) < 1e-9) return { type, dots: 2 };
  }
  return null;
}

const PITCH_RE = /^([A-G])(#{1,2}|b{1,2})?(-?\d)$/;

export class CorrectionError extends Error {}

/** Per-voice total of a note list, in divisions (chord notes don't advance time). */
function voiceTotals(notes: { v: number; chord: boolean; div: number }[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const n of notes) if (!n.chord) totals.set(n.v, (totals.get(n.v) ?? 0) + n.div);
  return totals;
}

/**
 * Replaces one part's notes in one measure (by position) with `notes`. Refuses -- throwing
 * CorrectionError, leaving the measure untouched -- when a note can't be written in the part's
 * divisions, a pitch is malformed, or a voice no longer fills the bar (a full bar by the time
 * signature, or exactly what the original measure had, for pickups and short final bars).
 */
export function applyMeasure(doc: Document, partId: string, m: number, notes: CompactNote[]): void {
  const part = partsOf(doc).find((p) => p.ref.id === partId);
  if (!part) throw new CorrectionError(`unknown part ${partId}`);
  const measures = kids(part.el, 'measure');
  const measure = measures[m - 1];
  if (!measure) throw new CorrectionError(`part ${partId} has no measure ${m}`);
  const state = partStates(part.el)[m - 1];
  if (!notes.length) throw new CorrectionError('empty note list');

  const parsed = notes.map((n) => {
    const f = parseFraction(n.d);
    if (!f) throw new CorrectionError(`bad duration "${n.d}"`);
    const div = (state.divisions * f.num) / f.den;
    if (!Number.isInteger(div)) throw new CorrectionError(`duration ${n.d} can't be written with ${state.divisions} divisions per quarter`);
    if (n.p !== 'rest' && !PITCH_RE.test(n.p)) throw new CorrectionError(`bad pitch "${n.p}"`);
    return { ...n, v: Math.max(1, Math.round(n.v) || 1), staff: Math.max(1, Math.round(n.staff) || 1), div, q: f.num / f.den };
  });

  const full = (state.divisions * 4 * state.beats) / state.beatType;
  const original = voiceTotals(compactNotes(measure, state.divisions).map((n) => {
    const f = parseFraction(n.d)!;
    return { v: n.v, chord: n.chord, div: (state.divisions * f.num) / f.den };
  }));
  const originalLen = Math.max(0, ...original.values());
  for (const [v, total] of voiceTotals(parsed)) {
    if (total !== full && total !== originalLen) {
      throw new CorrectionError(`voice ${v} lasts ${fraction(total, state.divisions)} quarters, the bar needs ${fraction(full, state.divisions)}`);
    }
  }

  // Everything that isn't a note/backup/forward stays: what came before the first note stays in
  // front, the rest (directions, barlines) goes after the new notes, barlines last.
  const children = kids(measure);
  const firstNote = children.findIndex((c) => c.nodeName === 'note' || c.nodeName === 'backup' || c.nodeName === 'forward');
  const leading = firstNote < 0 ? children : children.slice(0, firstNote);
  const rest = firstNote < 0 ? [] : children.slice(firstNote).filter((c) => c.nodeName !== 'note' && c.nodeName !== 'backup' && c.nodeName !== 'forward');
  const trailing = [...rest.filter((c) => c.nodeName !== 'barline'), ...rest.filter((c) => c.nodeName === 'barline')];
  for (const c of children) if (!leading.includes(c)) measure.removeChild(c);

  const el = (name: string, content?: string, attrs: Record<string, string> = {}): Element => {
    const e = doc.createElement(name);
    for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
    if (content !== undefined) e.appendChild(doc.createTextNode(content));
    return e;
  };

  const voices = [...new Set(parsed.map((n) => n.v))];
  const totals = voiceTotals(parsed);
  voices.forEach((v, vi) => {
    let continuing = false; // previous syllable of this voice ended with "-"
    for (const n of parsed.filter((x) => x.v === v)) {
      const note = el('note');
      if (n.chord) note.appendChild(el('chord'));
      if (n.p === 'rest') {
        note.appendChild(el('rest'));
      } else {
        const [, step, acc, octave] = n.p.match(PITCH_RE)!;
        const pitch = el('pitch');
        pitch.appendChild(el('step', step));
        if (acc) pitch.appendChild(el('alter', String(acc[0] === '#' ? acc.length : -acc.length)));
        pitch.appendChild(el('octave', octave));
        note.appendChild(pitch);
      }
      note.appendChild(el('duration', String(n.div)));
      if (n.tie === 'stop' || n.tie === 'both') note.appendChild(el('tie', undefined, { type: 'stop' }));
      if (n.tie === 'start' || n.tie === 'both') note.appendChild(el('tie', undefined, { type: 'start' }));
      note.appendChild(el('voice', String(v)));
      const td = typeAndDots(n.q);
      if (td) {
        note.appendChild(el('type', td.type));
        for (let i = 0; i < td.dots; i++) note.appendChild(el('dot'));
      }
      if (state.staves > 1) note.appendChild(el('staff', String(n.staff)));
      if (n.tie !== 'none' && n.p !== 'rest') {
        const notations = el('notations');
        if (n.tie === 'stop' || n.tie === 'both') notations.appendChild(el('tied', undefined, { type: 'stop' }));
        if (n.tie === 'start' || n.tie === 'both') notations.appendChild(el('tied', undefined, { type: 'start' }));
        note.appendChild(notations);
      }
      const raw = n.lyric.trim();
      if (raw && n.p !== 'rest' && !n.chord) {
        const continues = raw.endsWith('-') && raw.length > 1;
        const syllable = continues ? raw.slice(0, -1) : raw;
        const syllabic = continuing ? (continues ? 'middle' : 'end') : continues ? 'begin' : 'single';
        const lyric = el('lyric', undefined, { number: '1' });
        lyric.appendChild(el('syllabic', syllabic));
        lyric.appendChild(el('text', syllable));
        note.appendChild(lyric);
        continuing = continues;
      }
      measure.appendChild(note);
    }
    if (vi < voices.length - 1) {
      const backup = el('backup');
      backup.appendChild(el('duration', String(totals.get(v) ?? 0)));
      measure.appendChild(backup);
    }
  });
  for (const c of trailing) measure.appendChild(c);
}

/** Part names and the work title, where a check found better ones than the recognizer. */
export function setTitle(doc: Document, title: string) {
  const root = doc.documentElement as Element;
  let work = kid(root, 'work');
  if (!work) {
    work = doc.createElement('work');
    root.insertBefore(work, root.firstChild);
  }
  let wt = kid(work, 'work-title');
  if (!wt) {
    wt = doc.createElement('work-title');
    work.appendChild(wt);
  }
  wt.textContent = title;
  const mt = kid(root, 'movement-title');
  if (mt) mt.textContent = title;
}

export function setPartName(doc: Document, partId: string, name: string) {
  const list = doc.getElementsByTagName('score-part');
  for (let i = 0; i < list.length; i++) {
    const sp = list[i] as Element;
    if (sp.getAttribute('id') !== partId) continue;
    let pn = kid(sp, 'part-name');
    if (!pn) {
      pn = doc.createElement('part-name');
      sp.insertBefore(pn, sp.firstChild);
    }
    pn.textContent = name;
  }
}

export function getTitle(doc: Document): string {
  const root = doc.documentElement as Element;
  return text(kid(kid(root, 'work') ?? root, 'work-title')) || text(kid(root, 'movement-title'));
}

/**
 * Appends the measures of later movements (Audiveris splits a book into movements where it sees a
 * new piece start) to the first score, part by part -- only when they have the same number of
 * parts; otherwise the later movement is dropped and reported.
 */
export function mergeMovements(docs: Document[]): { doc: Document; dropped: number } {
  const [first, ...more] = docs;
  let dropped = 0;
  const firstParts = partsOf(first);
  for (const d of more) {
    const parts = partsOf(d);
    if (parts.length !== firstParts.length) {
      dropped++;
      continue;
    }
    parts.forEach((p, k) => {
      for (const m of kids(p.el, 'measure')) firstParts[k].el.appendChild(first.importNode(m, true));
    });
  }
  // Renumber so the merged measures continue from the first movement.
  if (more.length > dropped) for (const p of firstParts) kids(p.el, 'measure').forEach((m, i) => m.setAttribute('number', String(i + 1)));
  return { doc: first, dropped };
}
