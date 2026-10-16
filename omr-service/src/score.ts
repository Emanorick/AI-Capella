// MusicXML handling for the scan pipeline: reading Audiveris' .mxl output, splitting a score into
// the printed pages it came from, the compact notation (notation.ts) of a page for the GPT checks,
// and writing checked measures back -- only when they still add up to a full bar.
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, strFromU8 } from 'fflate';
import { beatOf, divisionsFor, emptyCarry, writeMeasureNotes, type CarryOver } from './build.js';
import { formatNote, parseVoices, voiceLength, type NoteEv, type Voice } from './notation.js';

/** One measure of every part, in the compact notation (notation.ts) the GPT checks read and answer in. */
export interface CompactMeasure {
  m: number; // 1-based position in the part (measure numbers in files can repeat or skip)
  number: string; // the printed measure number
  time: string; // "4/4"
  fifths: number;
  parts: Record<string, Voice[]>;
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

/** A part's measure at a position (0-based), if it has one. */
export function measureEl(part: Element, index: number): Element | undefined {
  return kids(part, 'measure')[index];
}

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

/**
 * A measure's notes as voices in the compact notation (grace and cue notes left out). A voice that
 * starts later than the bar, or pauses, behind an invisible <forward>, gets a rest there.
 */
function compactVoices(measure: Element, divisions: number, barDiv: number): Voice[] {
  const voices = new Map<string, Voice>();
  const ends = new Map<string, number>(); // where each voice has got to, in divisions
  const frac = (dur: number) => {
    const g = gcdInt(dur, divisions);
    return g ? `${dur / g}${divisions / g === 1 ? '' : `/${divisions / g}`}` : '0';
  };
  let cursor = 0;
  let lastStart = 0;
  for (const el of kids(measure)) {
    if (el.nodeName === 'backup' || el.nodeName === 'forward') {
      const d = Number(text(kid(el, 'duration'))) || 0;
      cursor = Math.max(0, cursor + (el.nodeName === 'backup' ? -d : d));
      continue;
    }
    if (el.nodeName !== 'note') continue;
    const note = el;
    const chord = !!kid(note, 'chord');
    const dur = Number(text(kid(note, 'duration'))) || 0;
    if (kid(note, 'grace')) continue;
    const start = chord ? lastStart : cursor;
    if (!chord) {
      lastStart = cursor;
      cursor += dur;
    }
    if (kid(note, 'cue') || !dur) continue;
    const vKey = text(kid(note, 'voice')) || '1';
    const staff = Number(text(kid(note, 'staff'))) || 1;
    let voice = voices.get(vKey);
    if (!voice) voices.set(vKey, (voice = { v: Number(vKey) || 1, staff, notes: [] }));
    const end = ends.get(vKey) ?? 0;
    if (!chord && start > end) voice.notes.push(`r ${frac(start - end)}`);
    if (!chord) ends.set(vKey, start + dur);
    const pitch = kid(note, 'pitch');
    const unpitched = kid(note, 'unpitched');
    // A whole-bar rest is as long as the bar (some files give it a 4/4 bar's length in any metre).
    const restDur = !pitch && !unpitched && kid(note, 'rest')?.getAttribute('measure') === 'yes' && barDiv > 0 ? barDiv : dur;
    const verses: string[] = [];
    // (Words under a rest -- a misplaced syllable in some files -- aren't read: a rest has none.)
    for (const lyric of pitch || unpitched ? kids(note, 'lyric') : []) {
      const k = Math.max(1, Number(lyric.getAttribute('number')) || 1) - 1;
      const t = text(kid(lyric, 'text'));
      const syl = text(kid(lyric, 'syllabic'));
      const held = !!kid(lyric, 'extend');
      verses[k] = t ? t + (syl === 'begin' || syl === 'middle' ? '-' : held ? '_' : '') : held ? '_' : '';
    }
    const place = unpitched ? unpitchedPlace(unpitched, note) : null;
    const octaveText = pitch ? text(kid(pitch, 'octave')) : '';
    const g = gcdInt(restDur, divisions);
    const ev: NoteEv = {
      chord,
      rest: !pitch && !unpitched,
      unpitched: !!unpitched,
      step: pitch ? text(kid(pitch, 'step')) : (place?.step ?? ''),
      alter: pitch ? Math.round(Number(text(kid(pitch, 'alter'))) || 0) : 0,
      octave: pitch ? (/^-?\d+$/.test(octaveText) ? Number(octaveText) : 4) : (place?.octave ?? 0),
      num: restDur / g,
      den: divisions / g,
      tie: kids(note, 'tie').some((t) => t.getAttribute('type') === 'start'),
      verses: Array.from(verses, (v) => v ?? ''),
    };
    voice.notes.push(formatNote(ev));
  }
  return [...voices.values()];
}

/**
 * Where a percussion note sits: its display step and octave, or -- where an export left those empty
 * or nonsensical -- its printed height (default-y, tenths below the top line, F5), else the middle line.
 */
function unpitchedPlace(unpitched: Element, note: Element): { step: string; octave: number } {
  const step = text(kid(unpitched, 'display-step'));
  const octave = Number(text(kid(unpitched, 'display-octave')));
  if (/^[A-G]$/.test(step) && octave >= 0 && octave <= 9) return { step, octave };
  const y = parseFloat(note.getAttribute('default-y') ?? '');
  if (Number.isFinite(y) && Math.abs(y) <= 120) {
    const index = 5 * 7 + 3 + Math.round(y / 5);
    return { step: 'CDEFGAB'[((index % 7) + 7) % 7], octave: Math.floor(index / 7) };
  }
  return { step: 'B', octave: 4 };
}

function gcdInt(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
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
      const st = states[k][i];
      if (el) cm.parts[p.ref.id] = compactVoices(el, st.divisions, (st.divisions * 4 * st.beats) / st.beatType);
    });
    return cm;
  });
  return { parts: parts.map((p) => p.ref), measures };
}

// ---- writing corrections back ---------------------------------------------------------------

export class CorrectionError extends Error {}

/** Multiplies every duration of a part (and its divisions) by `factor`, so finer values fit. */
function rescalePart(part: Element, factor: number) {
  for (const measure of kids(part, 'measure')) {
    for (const attrs of kids(measure, 'attributes')) {
      const d = kid(attrs, 'divisions');
      if (d) d.textContent = String(Number(text(d)) * factor);
    }
    for (const c of kids(measure)) {
      if (c.nodeName !== 'note' && c.nodeName !== 'backup' && c.nodeName !== 'forward') continue;
      const d = kid(c, 'duration');
      if (d) d.textContent = String(Number(text(d)) * factor);
    }
  }
}

/** What the measures before `index` leave open: ties into it, words that go on, their last syllables. */
function carryInto(part: Element, index: number): CarryOver {
  const carry = emptyCarry();
  const measures = kids(part, 'measure');
  const prev = measures[index - 1];
  if (prev) {
    for (const note of kids(prev, 'note')) {
      const pitch = kid(note, 'pitch');
      if (!pitch || !kids(note, 'tie').some((t) => t.getAttribute('type') === 'start')) continue;
      const v = Number(text(kid(note, 'voice'))) || 1;
      const key = `${text(kid(pitch, 'step'))}${Math.round(Number(text(kid(pitch, 'alter'))) || 0)}/${text(kid(pitch, 'octave'))}`;
      if (!carry.ties.has(v)) carry.ties.set(v, new Set());
      carry.ties.get(v)!.add(key);
      carry.staffOf.set(v, Number(text(kid(note, 'staff'))) || 1);
    }
  }
  // Each voice's last syllable per verse, looking back a few bars.
  for (let i = index - 1; i >= Math.max(0, index - 8); i--) {
    const notes = kids(measures[i], 'note').reverse();
    for (const note of notes) {
      const v = Number(text(kid(note, 'voice'))) || 1;
      for (const lyric of kids(note, 'lyric')) {
        const k = Math.max(1, Number(lyric.getAttribute('number')) || 1) - 1;
        if (!carry.lastLyric.has(v)) carry.lastLyric.set(v, new Map());
        if (carry.lastLyric.get(v)!.has(k)) continue;
        carry.lastLyric.get(v)!.set(k, lyric);
        const syl = text(kid(lyric, 'syllabic'));
        if (syl === 'begin' || syl === 'middle') {
          if (!carry.continuing.has(v)) carry.continuing.set(v, new Set());
          carry.continuing.get(v)!.add(k);
        }
      }
    }
  }
  return carry;
}

/**
 * Replaces one part's notes in one measure (by position) with `voices`. Refuses -- throwing
 * CorrectionError, leaving the measure untouched -- when a note can't be read, or a voice no
 * longer fills the bar (a full bar by the time signature, or exactly what the original measure
 * had, for pickups and short final bars). Finer durations than the part was written in are made
 * room for (its divisions multiplied).
 */
export function applyMeasure(doc: Document, partId: string, m: number, voices: Voice[]): void {
  const part = partsOf(doc).find((p) => p.ref.id === partId);
  if (!part) throw new CorrectionError(`unknown part ${partId}`);
  const measures = kids(part.el, 'measure');
  const measure = measures[m - 1];
  if (!measure) throw new CorrectionError(`part ${partId} has no measure ${m}`);
  if (!voices.length || voices.every((v) => !v.notes.length)) throw new CorrectionError('empty note list');
  let parsed;
  try {
    parsed = parseVoices(voices);
  } catch (err) {
    throw new CorrectionError(err instanceof Error ? err.message : String(err));
  }
  let state = partStates(part.el)[m - 1];
  const quarters = (len: { num: number; den: number }) => len.num / len.den;
  const full = (4 * state.beats) / state.beatType;
  const originalLen = Math.max(0, ...parseVoices(compactVoices(measure, state.divisions, state.divisions * full)).map((v) => quarters(voiceLength(v.notes))));
  for (const v of parsed) {
    const len = quarters(voiceLength(v.notes));
    if (Math.abs(len - full) > 1e-9 && Math.abs(len - originalLen) > 1e-9) {
      throw new CorrectionError(`voice ${v.v} lasts ${len} quarters, the bar needs ${full}`);
    }
  }
  // (Only now that it will be written: finer durations need finer divisions.)
  const needed = divisionsFor([voices], state.divisions);
  if (needed !== state.divisions) {
    rescalePart(part.el, needed / state.divisions);
    state = partStates(part.el)[m - 1];
  }

  // Everything that isn't a note/backup/forward stays: what came before the first note stays in
  // front, the rest (directions, barlines) goes after the new notes, barlines last.
  const children = kids(measure);
  const firstNote = children.findIndex((c) => c.nodeName === 'note' || c.nodeName === 'backup' || c.nodeName === 'forward');
  const leading = firstNote < 0 ? children : children.slice(0, firstNote);
  const rest = firstNote < 0 ? [] : children.slice(firstNote).filter((c) => c.nodeName !== 'note' && c.nodeName !== 'backup' && c.nodeName !== 'forward');
  const trailing = [...rest.filter((c) => c.nodeName !== 'barline'), ...rest.filter((c) => c.nodeName === 'barline')];
  for (const c of children) if (!leading.includes(c)) measure.removeChild(c);
  writeMeasureNotes(doc, measure, voices, { divisions: state.divisions, fifths: state.fifths, staves: state.staves, beat: beatOf(`${state.beats}/${state.beatType}`) }, carryInto(part.el, m - 1), full);
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
