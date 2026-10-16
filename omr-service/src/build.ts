// Writing MusicXML from the compact notation (notation.ts): a whole score from a page-by-page
// transcription, and -- shared with the checks' corrections (score.ts applyMeasure) -- the notes of
// one measure: accidentals as an engraver sets them, tuplets with their brackets, ties across bar
// lines, the words of every verse with their syllables joined.
import type { Document, Element } from '@xmldom/xmldom';
import { lcm, parseVoices, voiceLength, type NoteEv, type Voice } from './notation.js';
import { parseXml } from './score.js';

// ---- one measure's notes ----------------------------------------------------------------------

/** What carries over from one measure into the next, per voice. */
export interface CarryOver {
  ties: Map<number, Set<string>>; // pitches tied into the bar
  staffOf: Map<number, number>; // each voice's staff (a tie may end in another voice of the staff)
  continuing: Map<number, Set<number>>; // verses (0-based) whose last syllable goes on ("Eve-")
  lastLyric: Map<number, Map<number, Element>>; // each verse's last syllable, for a held one ("_")
}

export const emptyCarry = (): CarryOver => ({ ties: new Map(), staffOf: new Map(), continuing: new Map(), lastLyric: new Map() });

export interface MeasureFrame {
  divisions: number; // per quarter
  fifths: number;
  staves: number;
  beat?: number; // the beat beams are grouped by, in quarters (see beatOf); a quarter if not given
}

/** The beat eighths are beamed by: a quarter in 2/4, 3/4, 4/4; a dotted quarter in 6/8, 9/8, 12/8. */
export function beatOf(time: string): number {
  const [b, bt] = time.split('/').map(Number);
  if (bt === 8 && b % 3 === 0 && b > 3) return 1.5;
  if (bt === 8) return 0.5 * (b === 3 ? 3 : 1);
  if (bt === 2) return 2;
  return 1;
}

const BEAMED = new Map([
  ['eighth', 1],
  ['16th', 2],
  ['32nd', 3],
  ['64th', 4],
]);

const TYPES: [number, string][] = [
  [8, 'breve'],
  [4, 'whole'],
  [2, 'half'],
  [1, 'quarter'],
  [0.5, 'eighth'],
  [0.25, '16th'],
  [0.125, '32nd'],
  [0.0625, '64th'],
];
const TYPE_VALUE = new Map(TYPES.map(([v, t]) => [t, v]));
const TUPLETS: [number, number][] = [
  [3, 2],
  [5, 4],
  [6, 4],
  [7, 4],
  [2, 3],
  [4, 3],
];

/** Written shape of a duration (in quarters): note type, dots, and a tuplet ratio where needed. */
export function noteShape(q: number): { type: string; dots: number; tuplet?: [number, number] } | null {
  const plain = (x: number) => {
    for (const [base, type] of TYPES) {
      if (Math.abs(x - base) < 1e-9) return { type, dots: 0 };
      if (Math.abs(x - base * 1.5) < 1e-9) return { type, dots: 1 };
      if (Math.abs(x - base * 1.75) < 1e-9) return { type, dots: 2 };
    }
    return null;
  };
  const direct = plain(q);
  if (direct) return direct;
  for (const [actual, normal] of TUPLETS) {
    const shape = plain((q * actual) / normal);
    if (shape) return { ...shape, tuplet: [actual, normal] };
  }
  return null;
}

const SHARPS = 'FCGDAEB';
/** The alteration the key signature gives a step. */
function keyAlter(fifths: number, step: string): number {
  const i = SHARPS.indexOf(step);
  if (fifths > 0) return i < fifths ? 1 : 0;
  if (fifths < 0) return 6 - i < -fifths ? -1 : 0;
  return 0;
}

const ACCIDENTAL: Record<number, string> = { [-2]: 'flat-flat', [-1]: 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };

const pitchKey = (n: NoteEv) => `${n.step}${n.alter}/${n.octave}`;

function make(doc: Document) {
  return (name: string, content?: string | number, attrs: Record<string, string | number> = {}): Element => {
    const e = doc.createElement(name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (content !== undefined) e.appendChild(doc.createTextNode(String(content)));
    return e;
  };
}

/**
 * Writes the notes of `voices` into `measure` (after whatever it already holds) and moves `carry`
 * on to the end of the measure. Returns each voice's length in divisions. Durations must fit
 * `frame.divisions` (see divisionsFor); a voice is written as given, full or not.
 */
export function writeMeasureNotes(doc: Document, measure: Element, voices: Voice[], frame: MeasureFrame, carry: CarryOver, barQuarters: number): Map<number, number> {
  const el = make(doc);
  const parsed = parseVoices(voices).sort((a, b) => a.staff - b.staff || a.v - b.v);
  const div = (n: NoteEv) => (frame.divisions * n.num) / n.den;

  // Onsets (in divisions) of every note, for the accidentals: per staff in time order.
  interface Placed {
    n: NoteEv;
    voice: number;
    staff: number;
    at: number;
    order: number;
    accidental?: string;
    tieStop: boolean;
  }
  const placed: Placed[][] = parsed.map(() => []);
  let order = 0;
  // Ties into the bar, per staff: a voice takes its own first, then -- rarely, but engravers do it
  // -- one another voice of its staff left open.
  const incoming = new Map<number, Map<string, number>>(); // staff -> pitch -> voice it came from
  for (const [v, set] of carry.ties) {
    const staff = carry.staffOf.get(v) ?? 1;
    if (!incoming.has(staff)) incoming.set(staff, new Map());
    for (const k of set) if (!incoming.get(staff)!.has(k) || v === undefined) incoming.get(staff)!.set(k, v);
  }
  const fromBefore = (voice: number, staff: number, key: string) => {
    const own = carry.ties.get(voice);
    if (own?.has(key)) {
      own.delete(key);
      return true;
    }
    const other = incoming.get(staff)?.get(key);
    if (other !== undefined && carry.ties.get(other)?.has(key)) {
      carry.ties.get(other)!.delete(key);
      return true;
    }
    return false;
  };
  const endTies = new Map<number, Set<string>>();
  parsed.forEach((voice, vi) => {
    let t = 0;
    let last = 0;
    // The first moment stops ties from the previous bar; each later one what the moment before tied on.
    let pending: Set<string> | null = null;
    let group: Set<string> = new Set();
    for (const n of voice.notes) {
      if (!n.chord) {
        if (t > 0 || pending) pending = group;
        group = new Set();
        last = t;
        t += div(n);
      }
      const at = n.chord ? last : t - div(n);
      const key = pitchKey(n);
      const tieStop = !n.rest && (at === 0 && !pending ? fromBefore(voice.v, voice.staff, key) : !!pending?.has(key));
      if (n.tie && !n.rest) group.add(key);
      placed[vi].push({ n, voice: voice.v, staff: voice.staff, at, order: order++, tieStop });
    }
    endTies.set(voice.v, group);
    carry.staffOf.set(voice.v, voice.staff);
  });
  carry.ties = endTies;
  // Accidentals, staff by staff in time order, against the key and what the bar already altered.
  for (const staff of new Set(parsed.map((v) => v.staff))) {
    const state = new Map<string, number>();
    const notes = placed
      .flat()
      .filter((p) => p.staff === staff && !p.n.rest && !p.n.unpitched)
      .sort((a, b) => a.at - b.at || a.order - b.order);
    for (const p of notes) {
      const key = `${p.n.step}${p.n.octave}`;
      const current = state.has(key) ? state.get(key)! : keyAlter(frame.fifths, p.n.step);
      if (p.n.alter !== current && !p.tieStop) p.accidental = ACCIDENTAL[p.n.alter];
      state.set(key, p.n.alter);
    }
  }

  // Beams: in each voice, the eighths and shorter notes within one beat, a rest breaking them off
  // (the second beam for sixteenths, a hook for a lone one).
  const beams = new Map<Placed, string[]>();
  const beatDiv = (frame.beat ?? 1) * frame.divisions;
  placed.forEach((list) => {
    const heads = list.filter((p) => !p.n.chord);
    let run: Placed[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const levels = run.map((p) => BEAMED.get(noteShape(p.n.num / p.n.den)?.type ?? '') ?? 0);
        const maxLevel = Math.max(...levels);
        for (let level = 1; level <= maxLevel; level++) {
          run.forEach((p, i) => {
            if (levels[i] < level) return;
            const prev = i > 0 && levels[i - 1] >= level;
            const next = i < run.length - 1 && levels[i + 1] >= level;
            const mark = prev && next ? 'continue' : prev ? 'end' : next ? 'begin' : level === 1 ? '' : i < run.length - 1 ? 'forward hook' : 'backward hook';
            if (!mark) return;
            if (!beams.has(p)) beams.set(p, []);
            beams.get(p)![level - 1] = mark;
          });
        }
      }
      run = [];
    };
    for (const p of heads) {
      const beamable = !p.n.rest && BEAMED.has(noteShape(p.n.num / p.n.den)?.type ?? '');
      const sameBeat = run.length && Math.floor((p.at + 1e-6) / beatDiv) === Math.floor((run[0].at + 1e-6) / beatDiv);
      if (!beamable || !sameBeat) flush();
      if (beamable) run.push(p);
    }
    flush();
  });

  const totals = new Map<number, number>();
  parsed.forEach((voice, vi) => {
    const continuing = carry.continuing.get(voice.v) ?? new Set<number>();
    const lastLyric = carry.lastLyric.get(voice.v) ?? new Map<number, Element>();
    let tuplet: { ratio: string; acc: number; target: number; last: Element | null } | null = null;
    const closeTuplet = () => {
      if (tuplet?.last) addNotation(tuplet.last, el('tuplet', undefined, { type: 'stop' }));
      tuplet = null;
    };
    const voiceNotes = placed[vi];
    const length = voiceLength(voice.notes);
    const voiceDiv = (frame.divisions * length.num) / length.den;
    totals.set(voice.v, voiceDiv);
    const wholeRest = voiceNotes.length === 1 && voiceNotes[0].n.rest && Math.abs((voiceNotes[0].n.num / voiceNotes[0].n.den) - barQuarters) < 1e-9;
    let headShape: ReturnType<typeof noteShape> = null;
    for (const p of voiceNotes) {
      const n = p.n;
      const q = n.num / n.den;
      const note = el('note');
      if (n.chord) note.appendChild(el('chord'));
      if (n.rest) note.appendChild(el('rest', undefined, wholeRest ? { measure: 'yes' } : {}));
      else if (n.unpitched) {
        const u = el('unpitched');
        add(u, el('display-step', n.step), el('display-octave', n.octave));
        note.appendChild(u);
      } else {
        const pitch = el('pitch');
        pitch.appendChild(el('step', n.step));
        if (n.alter) pitch.appendChild(el('alter', n.alter));
        pitch.appendChild(el('octave', n.octave));
        note.appendChild(pitch);
      }
      note.appendChild(el('duration', div(n)));
      if (p.tieStop) note.appendChild(el('tie', undefined, { type: 'stop' }));
      if (n.tie && !n.rest) note.appendChild(el('tie', undefined, { type: 'start' }));
      note.appendChild(el('voice', voice.v));
      const shape: ReturnType<typeof noteShape> = n.chord ? headShape : noteShape(q);
      if (!n.chord) headShape = shape;
      if (shape && !(wholeRest && n.rest)) {
        note.appendChild(el('type', shape.type));
        for (let i = 0; i < shape.dots; i++) note.appendChild(el('dot'));
      }
      if (p.accidental) note.appendChild(el('accidental', p.accidental));
      if (shape?.tuplet) {
        const tm = el('time-modification');
        add(tm, el('actual-notes', shape.tuplet[0]), el('normal-notes', shape.tuplet[1]));
        note.appendChild(tm);
      }
      if (n.unpitched) note.appendChild(el('notehead', 'x'));
      if (frame.staves > 1) note.appendChild(el('staff', voice.staff));
      (beams.get(p) ?? []).forEach((mark, level) => {
        if (mark) note.appendChild(el('beam', mark, { number: level + 1 }));
      });
      if (p.tieStop) addNotation(note, el('tied', undefined, { type: 'stop' }));
      if (n.tie && !n.rest) addNotation(note, el('tied', undefined, { type: 'start' }));

      // Tuplet brackets: from the first note of a run of one ratio until the run fills its span
      // (three triplet eighths: a quarter), or another kind of note comes.
      if (!n.chord) {
        const ratio = shape?.tuplet ? shape.tuplet.join(':') : '';
        if (tuplet && tuplet.ratio !== ratio) closeTuplet();
        if (ratio && shape?.tuplet) {
          if (!tuplet) {
            addNotation(note, el('tuplet', undefined, { type: 'start', bracket: 'yes' }));
            tuplet = { ratio, acc: 0, target: shape.tuplet[1] * (TYPE_VALUE.get(shape.type) ?? q), last: null };
          }
          tuplet.acc += q;
          tuplet.last = note;
          if (tuplet.acc >= tuplet.target - 1e-9) closeTuplet();
        }
      }

      // Words, verse by verse.
      if (!n.rest && !n.chord) {
        n.verses.forEach((raw, k) => {
          const text = raw.trim();
          if (!text) return;
          if (text === '_') {
            const prev = lastLyric.get(k);
            if (prev && !childNamed(prev, 'extend')) prev.appendChild(el('extend'));
            return;
          }
          const goesOn = text.length > 1 && text.endsWith('-');
          const held = !goesOn && text.length > 1 && text.endsWith('_'); // "ah_": a melisma line from here
          const syllable = goesOn || held ? text.slice(0, -1) : text;
          const before = continuing.has(k);
          const lyric = el('lyric', undefined, { number: k + 1 });
          lyric.appendChild(el('syllabic', before ? (goesOn ? 'middle' : 'end') : goesOn ? 'begin' : 'single'));
          lyric.appendChild(el('text', syllable));
          if (held) lyric.appendChild(el('extend'));
          note.appendChild(lyric);
          if (goesOn) continuing.add(k);
          else continuing.delete(k);
          lastLyric.set(k, lyric);
        });
      }
      measure.appendChild(note);
    }
    closeTuplet();
    carry.continuing.set(voice.v, continuing);
    carry.lastLyric.set(voice.v, lastLyric);
    if (vi < parsed.length - 1 && voiceDiv > 0) {
      const backup = el('backup');
      backup.appendChild(el('duration', voiceDiv));
      measure.appendChild(backup);
    }
  });
  return totals;
}

function add(parent: Element, ...children: Element[]) {
  for (const c of children) parent.appendChild(c);
}

function childNamed(e: Element, name: string): Element | undefined {
  for (let c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.nodeName === name) return c as Element;
  return undefined;
}

function addNotation(note: Element, child: Element) {
  const doc = note.ownerDocument!;
  let notations = childNamed(note, 'notations');
  if (!notations) {
    notations = doc.createElement('notations');
    // <notations> goes before any <lyric>.
    const lyric = childNamed(note, 'lyric');
    if (lyric) note.insertBefore(notations, lyric);
    else note.appendChild(notations);
  }
  notations.appendChild(child);
}

/** Divisions per quarter that write every duration of these voices exactly. */
export function divisionsFor(voiceLists: Voice[][], start = 1): number {
  let d = start;
  for (const voices of voiceLists) for (const v of parseVoices(voices)) for (const n of v.notes) d = lcm(d, n.den);
  return d;
}

// ---- a whole score ----------------------------------------------------------------------------

export type MarkKind = 'rehearsal' | 'tempo' | 'words' | 'dynamic' | 'segno' | 'coda' | 'dc' | 'ds' | 'fine' | 'tocoda';

export interface Mark {
  kind: MarkKind;
  text: string;
  part: string; // "" for the whole score (written over the top part)
  bpm: number; // tempo: quarter notes per minute, 0 if none printed
}

export interface TranscriptPart {
  id: string;
  name: string;
  staves: number;
  clefs: string[]; // per staff: "G2", "G2-8" (tenor), "F4", "C3", "C4", "percussion"
}

/** Where a measure stands on its page, as fractions of the page's width (x) and height (y). */
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface TranscriptMeasure {
  number: string; // as printed ("" when none)
  page: number; // 0-based
  box: Box | null; // on its page: the measure's width, its system's height
  rows?: Record<string, [number, number]>; // per part: where its staff (and words) stands, top to bottom
  time: string | null; // "3/4" where one is printed
  key: number | null; // fifths, where a key signature is printed
  barStart: 'none' | 'repeat';
  barEnd: 'normal' | 'double' | 'final' | 'repeat';
  repeatTimes: number; // how often the passage is played, all told (0: twice)
  ending: { numbers: number[]; start: boolean; stop: boolean } | null;
  marks: Mark[];
  parts: Record<string, Voice[]>;
}

export interface Transcript {
  title: string;
  parts: TranscriptPart[];
  measures: TranscriptMeasure[];
}

function clefElement(el: ReturnType<typeof make>, clef: string, number: number | null): Element {
  const attrs: Record<string, number> = number ? { number } : {};
  const c = el('clef', undefined, attrs);
  if (clef === 'percussion') {
    c.appendChild(el('sign', 'percussion'));
    return c;
  }
  const m = clef.match(/^([GFC])(\d)(?:([-+])(8|15))?$/) ?? ['', 'G', '2'];
  add(c, el('sign', m[1]), el('line', m[2]));
  if (m[3]) c.appendChild(el('clef-octave-change', (m[3] === '-' ? -1 : 1) * (m[4] === '15' ? 2 : 1)));
  return c;
}

const DYNAMICS = new Set(['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'fp', 'sf', 'sfz', 'sfp', 'fz', 'rf', 'rfz']);

function directionFor(el: ReturnType<typeof make>, mark: Mark): Element | null {
  const dir = el('direction', undefined, { placement: mark.kind === 'dynamic' ? 'below' : 'above' });
  const type = el('direction-type');
  dir.appendChild(type);
  const words = (text: string) => type.appendChild(el('words', text));
  switch (mark.kind) {
    case 'rehearsal':
      if (!mark.text.trim()) return null;
      type.appendChild(el('rehearsal', mark.text.trim()));
      break;
    case 'tempo': {
      if (mark.text.trim()) words(mark.text.trim());
      if (mark.bpm > 0) {
        const metro = el('direction-type');
        const m = el('metronome');
        add(m, el('beat-unit', 'quarter'), el('per-minute', Math.round(mark.bpm)));
        metro.appendChild(m);
        dir.appendChild(metro);
      }
      if (!mark.text.trim() && !(mark.bpm > 0)) return null;
      if (mark.bpm > 0) dir.appendChild(el('sound', undefined, { tempo: Math.round(mark.bpm) }));
      break;
    }
    case 'dynamic': {
      const d = mark.text.trim();
      if (DYNAMICS.has(d)) {
        const dyn = el('dynamics');
        dyn.appendChild(el(d));
        type.appendChild(dyn);
      } else if (d) words(d);
      else return null;
      break;
    }
    case 'words':
      if (!mark.text.trim()) return null;
      words(mark.text.trim());
      break;
    case 'segno':
      type.appendChild(el('segno'));
      dir.appendChild(el('sound', undefined, { segno: 'segno' }));
      break;
    case 'coda':
      type.appendChild(el('coda'));
      dir.appendChild(el('sound', undefined, { coda: 'coda' }));
      break;
    case 'dc':
      words(mark.text.trim() || 'D.C.');
      dir.appendChild(el('sound', undefined, { dacapo: 'yes' }));
      break;
    case 'ds':
      words(mark.text.trim() || 'D.S.');
      dir.appendChild(el('sound', undefined, { dalsegno: 'segno' }));
      break;
    case 'fine':
      words(mark.text.trim() || 'Fine');
      dir.appendChild(el('sound', undefined, { fine: 'yes' }));
      break;
    case 'tocoda':
      words(mark.text.trim() || 'To Coda');
      dir.appendChild(el('sound', undefined, { tocoda: 'coda' }));
      break;
  }
  return dir;
}

const AT_END = new Set<MarkKind>(['dc', 'ds', 'fine', 'tocoda']);

export type Barlines = Pick<TranscriptMeasure, 'barStart' | 'barEnd' | 'repeatTimes' | 'ending'>;

/**
 * Sets a measure's bar lines: repeat start and volta start at its beginning, repeat end, volta end
 * and final or double bar at its end (any it had are replaced).
 */
export function setBarlines(measure: Element, b: Barlines) {
  const el = make(measure.ownerDocument!);
  for (let c = measure.firstChild; c; ) {
    const next = c.nextSibling;
    if (c.nodeType === 1 && c.nodeName === 'barline') measure.removeChild(c);
    c = next;
  }
  if (b.barStart === 'repeat' || b.ending?.start) {
    const bl = el('barline', undefined, { location: 'left' });
    if (b.barStart === 'repeat') bl.appendChild(el('bar-style', 'heavy-light'));
    if (b.ending?.start) bl.appendChild(el('ending', undefined, { number: b.ending.numbers.join(', ') || '1', type: 'start' }));
    if (b.barStart === 'repeat') bl.appendChild(el('repeat', undefined, { direction: 'forward' }));
    // First in the bar, after a page break.
    let at = measure.firstChild;
    while (at && at.nodeType === 1 && at.nodeName === 'print') at = at.nextSibling;
    measure.insertBefore(bl, at);
  }
  if (b.barEnd !== 'normal' || b.ending?.stop) {
    const bl = el('barline', undefined, { location: 'right' });
    bl.appendChild(el('bar-style', b.barEnd === 'double' ? 'light-light' : b.barEnd === 'normal' ? 'regular' : 'light-heavy'));
    if (b.ending?.stop) bl.appendChild(el('ending', undefined, { number: b.ending.numbers.join(', ') || '1', type: b.barEnd === 'repeat' ? 'stop' : 'discontinue' }));
    if (b.barEnd === 'repeat') bl.appendChild(el('repeat', undefined, b.repeatTimes > 2 ? { direction: 'backward', times: b.repeatTimes } : { direction: 'backward' }));
    measure.appendChild(bl);
  }
}

/**
 * Adds marks to a measure: at its start (rehearsal letters, tempo, words, dynamics, segno, coda) or
 * its end (D.C., D.S., Fine, To Coda) -- the end before any closing bar line.
 */
export function addMarks(measure: Element, marks: Mark[]) {
  const el = make(measure.ownerDocument!);
  for (const mark of marks) {
    const d = directionFor(el, mark);
    if (!d) continue;
    if (AT_END.has(mark.kind)) {
      let closing: Element | null = null;
      for (let c = measure.lastChild; c; c = c.previousSibling) if (c.nodeType === 1 && c.nodeName === 'barline' && (c as Element).getAttribute('location') === 'right') closing = c as Element;
      measure.insertBefore(d, closing);
    } else {
      // After the bar's opening elements (page break, bar line, attributes), before its notes.
      let at = measure.firstChild;
      while (at && at.nodeType === 1 && ['print', 'barline', 'attributes', 'direction'].includes(at.nodeName)) at = at.nextSibling;
      measure.insertBefore(d, at);
    }
  }
}

/** The bar length in quarters of a "3/4"-style time signature. */
export function barQuartersOf(time: string): number {
  const [b, bt] = time.split('/').map(Number);
  return b > 0 && bt > 0 ? (4 * b) / bt : 4;
}

/**
 * A MusicXML score from a transcription. Parts missing from a measure (staves an engraver hid
 * where they rest) get a whole-bar rest. Every bar is written as read; whether it adds up is for
 * the checks (checks.ts) to say.
 */
export function buildScore(t: Transcript): Document {
  const doc = parseXml('<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"/>');
  const el = make(doc);
  const root = doc.documentElement!;
  const work = el('work');
  work.appendChild(el('work-title', t.title || 'Scan'));
  root.appendChild(work);
  const ident = el('identification');
  const enc = el('encoding');
  enc.appendChild(el('software', 'LightScore scan (GPT)'));
  ident.appendChild(enc);
  root.appendChild(ident);
  const list = el('part-list');
  for (const p of t.parts) {
    const sp = el('score-part', undefined, { id: p.id });
    sp.appendChild(el('part-name', p.name || p.id));
    list.appendChild(sp);
  }
  root.appendChild(list);

  const divisions = divisionsFor(t.measures.flatMap((m) => Object.values(m.parts)));
  t.parts.forEach((part, pi) => {
    const partEl = el('part', undefined, { id: part.id });
    root.appendChild(partEl);
    const carry = emptyCarry();
    let fifths = 0;
    let time = '4/4';
    t.measures.forEach((m, mi) => {
      const measure = el('measure', undefined, { number: /^\d+$/.test(m.number) ? m.number : String(mi + 1) });
      partEl.appendChild(measure);
      // Where a new page of the scan begins (the checks go page by page, see measuresByPage).
      if (pi === 0 && mi > 0 && m.page !== t.measures[mi - 1].page) measure.appendChild(el('print', undefined, { 'new-page': 'yes' }));
      // Attributes: everything at the first bar, then what changes.
      const newKey = m.key !== null && (mi === 0 || m.key !== fifths);
      const newTime = !!m.time && (mi === 0 || m.time !== time);
      if (mi === 0 || newKey || newTime) {
        const attrs = el('attributes');
        if (mi === 0) attrs.appendChild(el('divisions', divisions));
        if (m.key !== null) fifths = m.key;
        if (m.time) time = m.time;
        if (mi === 0 || newKey) {
          const key = el('key');
          key.appendChild(el('fifths', fifths));
          attrs.appendChild(key);
        }
        if (mi === 0 || newTime) {
          const [b, bt] = time.split('/');
          const ts = el('time');
          add(ts, el('beats', b || '4'), el('beat-type', bt || '4'));
          attrs.appendChild(ts);
        }
        if (mi === 0) {
          if (part.staves > 1) attrs.appendChild(el('staves', part.staves));
          for (let s = 0; s < Math.max(1, part.staves); s++) attrs.appendChild(clefElement(el, part.clefs[s] ?? (s === 0 ? 'G2' : 'F4'), part.staves > 1 ? s + 1 : null));
        }
        measure.appendChild(attrs);
      }
      const marks = m.marks.filter((mk) => (mk.part ? mk.part === part.id : pi === 0));
      for (const mk of marks.filter((x) => !AT_END.has(x.kind))) {
        const d = directionFor(el, mk);
        if (d) measure.appendChild(d);
      }
      const barQ = barQuartersOf(time);
      const rest = `r ${fractionText(barQ)}`;
      const voices = m.parts[part.id]?.length ? m.parts[part.id] : Array.from({ length: Math.max(1, part.staves) }, (_, k) => ({ v: 4 * k + 1, staff: k + 1, notes: [rest] }));
      writeMeasureNotes(doc, measure, voices, { divisions, fifths, staves: part.staves, beat: beatOf(time) }, carry, barQ);
      for (const mk of marks.filter((x) => AT_END.has(x.kind))) {
        const d = directionFor(el, mk);
        if (d) measure.appendChild(d);
      }
      setBarlines(measure, m);
    });
  });
  return doc;
}

function fractionText(q: number): string {
  for (let den = 1; den <= 64; den *= 2) {
    const num = q * den;
    if (Math.abs(num - Math.round(num)) < 1e-9) return den === 1 ? String(Math.round(num)) : `${Math.round(num)}/${den}`;
  }
  return String(q);
}
