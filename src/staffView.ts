import type { MeasureInfo, NoteEvent, Score } from './score';
import type { PartMixState } from './audioEngine';

export const BASE_PIXELS_PER_BEAT = 70;
export const STAFF_RULER_HEIGHT_PX = 22; // matches PianoRoll's ruler height, for a consistent look when toggling views
const PLAYHEAD_X_RATIO = 0.2;
// On a narrow (mobile-width) canvas, the default ratio puts the playhead line close enough to the
// clef/key-signature glyphs (fixed pixel positions near the left edge) to feel crowded -- matches
// the same 720px breakpoint style.css already uses for "mobile" layout, since there's no separate
// isMobile flag anywhere in this codebase; cssWidth itself is the right signal regardless of cause
// (device width or a resized desktop window). First-draft ratio, meant to be visually iterated.
const MOBILE_BREAKPOINT_PX = 720;
const MOBILE_PLAYHEAD_X_RATIO = 0.32;
const MAX_DPR = 2;
const LINE_SPACING_PX = 9; // distance between two adjacent staff lines
const HALF_SPACE_PX = LINE_SPACING_PX / 2; // vertical distance per diatonic step
const STAFF_HEIGHT_PX = LINE_SPACING_PX * 4; // 5 lines, 4 gaps
const MIN_STAFF_GAP_PX = 44; // minimum space between one staff's bottom line and the next staff's top line (room for ledger lines)
const NOTEHEAD_RADIUS_PX = 4.2;
const STEM_LENGTH_PX = 30;
// Note flag geometry (eighth/16th/32nd), chosen from a rendered side-by-side comparison of
// several candidate shapes -- a stroked curve (not filled) whose tip sits at a fixed angle off
// the stem rather than curling back toward it, scaled to 80% of the compared size.
const FLAG_STROKE_WIDTH_PX = 1.6;
const FLAG_DROP_PX = 12.8; // vertical extent of one flag's curve
const FLAG_SPACING_PX = 5.6; // vertical gap between stacked flags (16th/32nd notes)
const FLAG_EXIT_ANGLE = (30 * Math.PI) / 180; // off vertical, measured from the stem
const DIMMED_ALPHA = 0.5; // matches PianoRoll's dimmed-part alpha
// A note starting exactly at a measure's startBeat would otherwise land its notehead center
// exactly on the barline (both computed via the same beatToX) -- nudged right so it visually sits
// just after the barline instead. Applied only in drawNote's own local x, never in beatToX itself
// (which barlines/the playhead/ruler labels all also depend on, unmodified).
const NOTE_X_OFFSET_PX = 6;
// Fixed distance below the staff's bottom line for every lyric in that staff, rather than each
// lyric following its own note's pitch -- so a lyric line reads at one consistent height instead
// of bouncing up and down with the melody. Not 30: the next staff's clef glyph reaches up to
// bottomLineY + MIN_STAFF_GAP_PX(44) - 9 = bottomLineY + 35, so this needs headroom below that.
// Accepted trade-off, not fixable by tuning this constant: an extreme low note (e.g. after a
// large negative transpose) can sit below this fixed line, putting its lyric above/near its own
// notehead instead of under it -- inherent to "one fixed height per staff" vs. an unbounded
// ledger-line range.
const LYRIC_BASELINE_OFFSET_PX = 26;

const LETTER_INDEX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

function diatonicIndex(step: string, octave: number): number {
  return octave * 7 + (LETTER_INDEX[step] ?? 0);
}

type ClefType = 'treble' | 'bass';
// The bottom line's diatonic index for each clef -- everything else is positioned relative to it.
const CLEF_BOTTOM_LINE: Record<ClefType, number> = {
  treble: diatonicIndex('E', 4),
  bass: diatonicIndex('G', 2),
};

// Fallback spelling for notes with no parsed step/alter/octave (MIDI imports have no source
// spelling to preserve): a fixed sharps-preferred chromatic table. MusicXML-sourced notes always
// carry their real notated spelling instead (see score.ts's NoteEvent doc comment).
const CHROMATIC_FALLBACK: { step: string; alter: number }[] = [
  { step: 'C', alter: 0 },
  { step: 'C', alter: 1 },
  { step: 'D', alter: 0 },
  { step: 'D', alter: 1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'F', alter: 1 },
  { step: 'G', alter: 0 },
  { step: 'G', alter: 1 },
  { step: 'A', alter: 0 },
  { step: 'A', alter: 1 },
  { step: 'B', alter: 0 },
];

// Standard key-signature accidental positions (in the same staff-position units as note glyphs --
// even = line, odd = space, 0 = bottom line, 8 = top line), independently verified against
// external music-theory references. Order matches the traditional sharp/flat drawing order
// (F,C,G,D,A,E,B for sharps; B,E,A,D,G,C,F for flats), one entry per possible key-signature count.
const SHARP_POSITIONS: Record<ClefType, number[]> = {
  treble: [8, 5, 9, 6, 3, 7, 4],
  bass: [6, 3, 7, 4, 1, 5, 2],
};
const FLAT_POSITIONS: Record<ClefType, number[]> = {
  treble: [4, 7, 3, 6, 2, 5, 1],
  bass: [2, 5, 1, 4, 0, 3, -1],
};
const SHARP_LETTER_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_LETTER_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** Per-letter alter implied by a key signature -- e.g. fifths=2 (D major) implies F and C are sharp. */
function impliedAlterForFifths(fifths: number): Record<string, number> {
  const map: Record<string, number> = {};
  if (fifths > 0) {
    for (let i = 0; i < Math.min(fifths, 7); i++) map[SHARP_LETTER_ORDER[i]] = 1;
  } else if (fifths < 0) {
    for (let i = 0; i < Math.min(-fifths, 7); i++) map[FLAT_LETTER_ORDER[i]] = -1;
  }
  return map;
}

// Defensive ±2 fallback (double sharp/flat) -- rare in practice but shouldn't crash if a source
// file has one.
function accidentalGlyph(alter: number): string {
  if (alter === 0) return '♮';
  if (alter === 1) return '♯';
  if (alter === -1) return '♭';
  return alter >= 2 ? '♯♯' : '♭♭';
}

function spellingFor(note: NoteEvent): { step: string; alter: number; octave: number } {
  if (note.step && note.octave != null) return { step: note.step, alter: note.alter ?? 0, octave: note.octave };
  const pitchClass = ((note.midi % 12) + 12) % 12;
  const octave = Math.floor(note.midi / 12) - 1;
  const fallback = CHROMATIC_FALLBACK[pitchClass];
  return { step: fallback.step, alter: fallback.alter, octave };
}

const LETTER_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function naturalMidi(step: string, octave: number): number {
  return (octave + 1) * 12 + (NATURAL_SEMITONES[step] ?? 0);
}

// Circle-of-fifths shift (for the transposed key signature) and diatonic letter shift (for note
// respelling), for every semitone count the app's transpose control can produce (MIN/MAX_TRANSPOSE
// = -7/+7 in main.ts). letterShift is NOT a pure function of fifthsShift alone (two semitone
// counts can share the same fifthsShift, e.g. +6/-6 both landing on fifthsShift=+6 via the
// tritone's conventional sharp-side spelling, yet need different letterShifts to match their own
// actual interval size) -- independently verified per semitone count rather than derived by a
// simpler formula that was checked and found to sometimes pick the enharmonically wrong side of a
// letter shift relative to the fifths-shift-selected key signature.
const TRANSPOSE_TABLE: Record<number, { fifthsShift: number; letterShift: number }> = {
  [-7]: { fifthsShift: -1, letterShift: -4 },
  [-6]: { fifthsShift: 6, letterShift: -4 },
  [-5]: { fifthsShift: 1, letterShift: -3 },
  [-4]: { fifthsShift: -4, letterShift: -2 },
  [-3]: { fifthsShift: 3, letterShift: -2 },
  [-2]: { fifthsShift: -2, letterShift: -1 },
  [-1]: { fifthsShift: 5, letterShift: -1 },
  0: { fifthsShift: 0, letterShift: 0 },
  1: { fifthsShift: -5, letterShift: 1 },
  2: { fifthsShift: 2, letterShift: 1 },
  3: { fifthsShift: -3, letterShift: 2 },
  4: { fifthsShift: 4, letterShift: 2 },
  5: { fifthsShift: -1, letterShift: 3 },
  6: { fifthsShift: 6, letterShift: 3 },
  7: { fifthsShift: 1, letterShift: 4 },
};

/**
 * Respells a note for a transposed key: shifts its letter by the transpose's letterShift (via
 * diatonicIndex, carrying the octave on wraparound), then solves for whichever alter makes that
 * new letter/octave hit the actual transposed pitch (midi + semitones) exactly -- so the spelling
 * always matches both the transposed key signature (same fifthsShift-derived letterShift) and the
 * real sounding pitch, rather than just shifting the alter and keeping the original letter.
 */
function transposeSpelling(spelling: { step: string; alter: number; octave: number }, midi: number, semitones: number): { step: string; alter: number; octave: number } {
  const shift = TRANSPOSE_TABLE[semitones];
  if (!semitones || !shift) return spelling;
  const newDiatonicIndex = diatonicIndex(spelling.step, spelling.octave) + shift.letterShift;
  const newOctave = Math.floor(newDiatonicIndex / 7);
  const newStep = LETTER_ORDER[((newDiatonicIndex % 7) + 7) % 7];
  const alter = midi + semitones - naturalMidi(newStep, newOctave);
  return { step: newStep, alter, octave: newOctave };
}

/** Ledger-line positions (in the same half-step units as staff position) needed for a note this far outside the staff. */
function ledgerLinePositions(staffPosition: number): number[] {
  const positions: number[] = [];
  if (staffPosition < 0) {
    const count = Math.ceil((-staffPosition - 1) / 2);
    for (let i = 1; i <= count; i++) positions.push(-2 * i);
  } else if (staffPosition > 8) {
    const count = Math.ceil((staffPosition - 8 - 1) / 2);
    for (let i = 1; i <= count; i++) positions.push(8 + 2 * i);
  }
  return positions;
}

type DurationName = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtysecond';

interface DurationShape {
  filled: boolean; // filled notehead (quarter or shorter) vs. hollow (half/whole)
  hasStem: boolean;
  flags: number; // unbeamed eighth/16th/32nd notes get 1/2/3 flags instead of a beam
  dotted: boolean;
  name: DurationName; // which standard duration this is -- rests pick their glyph from this
}

// { quarter-beat units, filled notehead, has a stem, flag count, name } for the undotted base
// durations; classifyDuration also checks each one's dotted (x1.5) variant and keeps whichever is
// closest.
const DURATION_TABLE: { units: number; filled: boolean; hasStem: boolean; flags: number; name: DurationName }[] = [
  { units: 4, filled: false, hasStem: false, flags: 0, name: 'whole' },
  { units: 2, filled: false, hasStem: true, flags: 0, name: 'half' },
  { units: 1, filled: true, hasStem: true, flags: 0, name: 'quarter' },
  { units: 0.5, filled: true, hasStem: true, flags: 1, name: 'eighth' },
  { units: 0.25, filled: true, hasStem: true, flags: 2, name: 'sixteenth' },
  { units: 0.125, filled: true, hasStem: true, flags: 3, name: 'thirtysecond' },
];

/**
 * Maps a continuous beat-length (the only duration representation the rest of the app carries) to
 * the nearest standard notated duration, for notehead/stem/flag shape. Not beam-grouping unbeamed
 * eighth/16th notes -- each gets its own flagged stem instead, a deliberately smaller scope than
 * full engraving-quality beaming (see PROJECT.md).
 */
function classifyDuration(durationBeats: number): DurationShape {
  let best = DURATION_TABLE[2];
  let bestDotted = false;
  let bestDiff = Infinity;
  for (const entry of DURATION_TABLE) {
    for (const dotted of [false, true]) {
      const units = dotted ? entry.units * 1.5 : entry.units;
      const diff = Math.abs(units - durationBeats);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = entry;
        bestDotted = dotted;
      }
    }
  }
  return { filled: best.filled, hasStem: best.hasStem, flags: best.flags, dotted: bestDotted, name: best.name };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// Standard notated durations, descending, including dotted variants -- for splitIntoNotatedSegments's
// largest-fits-without-exceeding pick. Deliberately not classifyDuration (which picks the *nearest*
// value and can exceed the remaining span, e.g. rounding a 0.9-beat remainder up to a 1-beat quarter
// note) -- classifyDuration stays exactly right for the separate job of choosing each already-
// decomposed segment's notehead/stem/flag shape, since by construction its length matches a table entry.
const STANDARD_DURATIONS = [6, 4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.1875, 0.125];
const MIN_REPRESENTABLE_BEATS = 0.0625; // half the smallest standard duration
const MAX_SEGMENTS_PER_NOTE = 64; // defensive cap against an unexpected float edge case

function measureEndBeat(measures: MeasureInfo[], idx: number): number {
  const m = measures[idx];
  const next = measures[idx + 1];
  return next ? next.startBeat : m.startBeat + m.beats * (4 / m.beatType);
}

function measureIndexAtBeat(measures: MeasureInfo[], beat: number): number {
  let idx = 0;
  for (let i = 0; i < measures.length; i++) {
    if (measures[i].startBeat > beat + 1e-9) break;
    idx = i;
  }
  return idx;
}

/**
 * Splits one (possibly tie-merged) note's duration into individually-notatable segments: forces a
 * split at every barline crossing (a note can't cross one in real notation, same as MusicXML
 * itself), and within a barline-clipped span greedily picks the largest standard duration that
 * fits without exceeding it. Fixes the concretely observed bug where a merged tied note (see
 * NoteEvent's doc comment on why ties are merged at parse time) rendered as one long,
 * rhythmically-illegible notehead -- e.g. the "Butterfly" arrangement's opening notes.
 */
function splitIntoNotatedSegments(startBeat: number, durationBeats: number, measures: MeasureInfo[]): { startBeat: number; durationBeats: number }[] {
  const segments: { startBeat: number; durationBeats: number }[] = [];
  let cursor = startBeat;
  let remaining = durationBeats;
  let measureIdx = measures.length ? measureIndexAtBeat(measures, cursor) : -1;
  let iterations = 0;

  while (remaining > 1e-6 && iterations < MAX_SEGMENTS_PER_NOTE) {
    iterations++;
    let span = remaining;
    if (measureIdx >= 0) {
      const untilBarline = measureEndBeat(measures, measureIdx) - cursor;
      if (untilBarline > 1e-6) span = Math.min(span, untilBarline);
    }

    if (span < MIN_REPRESENTABLE_BEATS && segments.length) {
      // Too small to represent as its own segment (a barline landing a hair off due to float
      // accumulation, or genuine leftover at the very end) -- fold it into the previous segment
      // instead, so segment durations still sum exactly to the original.
      segments[segments.length - 1].durationBeats += span;
      cursor += span;
      remaining -= span;
    } else {
      const picked = Math.min(STANDARD_DURATIONS.find((d) => d <= span + 1e-6) ?? MIN_REPRESENTABLE_BEATS, span);
      segments.push({ startBeat: cursor, durationBeats: picked });
      cursor += picked;
      remaining -= picked;
    }

    while (measureIdx >= 0 && measureIdx + 1 < measures.length && cursor >= measureEndBeat(measures, measureIdx) - 1e-6) {
      measureIdx++;
    }
  }

  if (!segments.length) {
    segments.push({ startBeat, durationBeats });
  } else if (remaining > 1e-6) {
    console.warn('[AI-Capella] splitIntoNotatedSegments hit its iteration cap; a note may render with an approximated duration.');
    segments[segments.length - 1].durationBeats += remaining;
  }
  return segments;
}

/**
 * Turns a NoteEvent's preserved tieSegments (the individual duration of each originally
 * tied-together <note> write) into the same {startBeat, durationBeats}[] shape
 * splitIntoNotatedSegments produces -- but without any of its barline-clipping logic, since each
 * original <note> element, by construction, could never cross a measure boundary in MusicXML
 * (that's literally why ties exist), so these segments are inherently already barline-safe.
 */
function segmentsFromTieLengths(startBeat: number, lengths: number[]): { startBeat: number; durationBeats: number }[] {
  const segments: { startBeat: number; durationBeats: number }[] = [];
  let cursor = startBeat;
  for (const len of lengths) {
    segments.push({ startBeat: cursor, durationBeats: len });
    cursor += len;
  }
  return segments;
}

/**
 * Infers the silent gaps in one part's part-writing: any span where nothing is sounding, between
 * notes or before the first/after the last. Notes sharing a startBeat (a chord/homophonic layer)
 * count as one event, using the latest end-time among them, so a gap is only reported once
 * everything sounding at that point has actually finished. Scoped to one monophonic voice per
 * part -- true for typical SATB choir writing (this app's primary use case). A genuinely
 * multi-voice part (MusicXML <backup>/<forward> producing overlapping non-chord content within
 * one part) may infer incorrect/overlapping gaps -- a known limitation, not silently mishandled
 * (it just won't happen to look right for that unusual case). `notes` must be sorted by
 * startBeat, which every part's note list already is (score.notes is sorted once at parse time).
 */
function computeRestGaps(notes: NoteEvent[], totalBeats: number): { startBeat: number; durationBeats: number }[] {
  const gaps: { startBeat: number; durationBeats: number }[] = [];
  let cursor = 0;
  let i = 0;
  while (i < notes.length) {
    const eventStart = notes[i].startBeat;
    let eventEnd = eventStart + notes[i].durationBeats;
    let j = i + 1;
    while (j < notes.length && Math.abs(notes[j].startBeat - eventStart) < 1e-6) {
      eventEnd = Math.max(eventEnd, notes[j].startBeat + notes[j].durationBeats);
      j++;
    }
    if (eventStart > cursor + 1e-6) gaps.push({ startBeat: cursor, durationBeats: eventStart - cursor });
    cursor = Math.max(cursor, eventEnd);
    i = j;
  }
  if (cursor < totalBeats - 1e-6) gaps.push({ startBeat: cursor, durationBeats: totalBeats - cursor });
  return gaps;
}

interface PartLayout {
  partId: string;
  clef: ClefType;
  topY: number; // css px, y of the staff's top line within the content area (before scroll)
}

/**
 * Traditional staff notation, one 5-line staff per voice stacked top to bottom (never overlaid --
 * SATB voices sharing a pitch would be unreadable on a shared staff), each in that part's color,
 * black background. An additional, toggleable view alongside PianoRoll -- not a replacement, and
 * not sharing its rendering code: the two are different enough (staff positions vs. piano-key
 * rows, noteheads/stems vs. proportional bars) that a shared base would mostly be indirection.
 * Deliberately simpler than PianoRoll's offscreen-buffer/DPR-tuned pipeline: this redraws directly
 * every frame, which is fine at the note density a single choir arrangement realistically has --
 * the piano roll's buffering exists for smooth continuous horizontal scroll during long playback
 * sessions, which matters less for a view meant primarily for reading rather than driving
 * transport (there's no click-to-seek or loop-drag here; use the shared transport bar/ruler on the
 * piano roll, or the measure-jump control, to move playback).
 *
 * Reflects the app's transpose setting fully, like a real transposed part: both the key signature
 * and every note's spelling shift together, derived from the same circle-of-fifths shift (see
 * TRANSPOSE_TABLE/transposeSpelling) so they always agree with each other.
 */
export class StaffView {
  private canvas: HTMLCanvasElement;
  private score: Score;
  private partColor: (partId: string) => string;
  private ctx2d: CanvasRenderingContext2D;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private pixelsPerBeat = BASE_PIXELS_PER_BEAT;
  private scrollY = 0; // css px scrolled down, when the stacked staves don't all fit vertically
  private notesByPart: Map<string, NoteEvent[]>;
  private layouts: PartLayout[];
  private contentHeightPx: number;
  private hiddenParts = new Set<string>();
  private dimmedParts = new Set<string>();
  private measureByNumber: Map<number, MeasureInfo>;
  private restsByPart: Map<string, { startBeat: number; durationBeats: number }[]>;
  private transpose = 0;

  constructor(canvas: HTMLCanvasElement, score: Score, partColor: (partId: string) => string) {
    this.canvas = canvas;
    this.score = score;
    this.partColor = partColor;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx2d = ctx;

    this.measureByNumber = new Map(score.measures.map((m) => [m.number, m]));

    this.notesByPart = new Map();
    for (const note of score.notes) {
      const list = this.notesByPart.get(note.partId);
      if (list) list.push(note);
      else this.notesByPart.set(note.partId, [note]);
    }

    // Rest gaps depend only on each part's own notes and the piece's total length -- static for
    // the life of this score, so computed once here rather than every render.
    this.restsByPart = new Map();
    for (const [partId, notes] of this.notesByPart) {
      this.restsByPart.set(partId, computeRestGaps(notes, score.totalBeats));
    }

    // Clef per part: no clef is parsed anywhere in this app's pipeline, so it's assigned from each
    // part's own average pitch -- a common, reasonable heuristic (a soprano/alto part's average is
    // almost always well above middle C; a bass part's well below it) rather than always treble.
    let y = STAFF_HEIGHT_PX / 2 + 10;
    this.layouts = score.parts.map((p) => {
      const notes = this.notesByPart.get(p.id) ?? [];
      const avgMidi = notes.length ? notes.reduce((sum, n) => sum + n.midi, 0) / notes.length : 60;
      const clef: ClefType = avgMidi >= 60 ? 'treble' : 'bass';
      const layout: PartLayout = { partId: p.id, clef, topY: y };
      y += STAFF_HEIGHT_PX + MIN_STAFF_GAP_PX;
      return layout;
    });
    this.contentHeightPx = y;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setZoom(factor: number) {
    this.pixelsPerBeat = BASE_PIXELS_PER_BEAT * factor;
  }

  /** Fully key-signature-aware: also shifts the drawn key signature, not just note spellings. */
  setTranspose(semitones: number) {
    this.transpose = semitones;
  }

  /** This note's spelling as actually drawn -- the printed spelling, respelled for the current transpose. */
  private effectiveSpelling(note: NoteEvent): { step: string; alter: number; octave: number } {
    const spelling = spellingFor(note);
    return this.transpose ? transposeSpelling(spelling, note.midi, this.transpose) : spelling;
  }

  private transposedFifths(rawFifths: number): number {
    return rawFifths + (this.transpose ? (TRANSPOSE_TABLE[this.transpose]?.fifthsShift ?? 0) : 0);
  }

  /**
   * Mirrors PianoRoll.setPartMix: muted (or true-soloed-away) parts don't draw their staff at
   * all -- lines, clef, notes, nothing -- while ducked (non-soloed during a regular Solo) parts
   * draw at DIMMED_ALPHA with their lyrics skipped entirely. Unlike PianoRoll, no draw-order
   * trick is needed: each part gets its own vertical band here, so dimmed/soloed staves never
   * visually overlap the way piano-roll rows sharing a pitch axis could.
   */
  setPartMix(mix: Map<string, PartMixState>) {
    this.hiddenParts = new Set();
    this.dimmedParts = new Set();
    const anySolo = Array.from(mix.values()).some((s) => s === 'solo');
    for (const [partId, state] of mix) {
      if (state === 'muted') this.hiddenParts.add(partId);
      else if (anySolo && state !== 'solo') this.dimmedParts.add(partId);
    }
  }

  getPixelsPerBeat() {
    return this.pixelsPerBeat;
  }

  /** Vertical pan, css px -- only does anything once the stacked staves overflow the viewport. */
  scrollByPixels(deltaPx: number) {
    const maxScroll = Math.max(0, this.contentHeightPx - (this.cssHeight - STAFF_RULER_HEIGHT_PX) + 20);
    this.scrollY = clamp(this.scrollY + deltaPx, 0, maxScroll);
  }

  private playheadX(): number {
    const ratio = this.cssWidth < MOBILE_BREAKPOINT_PX ? MOBILE_PLAYHEAD_X_RATIO : PLAYHEAD_X_RATIO;
    return this.cssWidth * ratio;
  }

  /**
   * The measure that governs the given beat -- the last measure whose startBeat doesn't exceed
   * it, falling back to the first measure for a beat before the piece even starts. Used to decide
   * which key/time signature to show pinned at the staff's left edge for whatever's currently
   * scrolled into view (see drawStaff): a fixed screen position, like the clef, rather than a
   * glyph anchored to the beat where a change happens -- correct for the common case (one key/time
   * signature for the whole piece) and, for a piece with a genuine mid-piece change, always shows
   * the signature governing the leftmost visible measure as you scroll past the change point.
   * Known limitation, not fixed here: a change occurring *inside* the visible viewport isn't also
   * marked inline at its own beat position, only reflected once it reaches the left edge.
   */
  private measureAtOrBefore(beat: number): MeasureInfo | undefined {
    let current: MeasureInfo | undefined;
    for (const m of this.score.measures) {
      if (m.startBeat > beat) break;
      current = m;
    }
    return current ?? this.score.measures[0];
  }

  /** Draws the key signature's sharps/flats right after the clef; returns the x just past it. */
  private drawKeySignature(ctx: CanvasRenderingContext2D, fifths: number, clef: ClefType, bottomLineY: number, color: string, xStart: number): number {
    if (!fifths) return xStart;
    const positions = fifths > 0 ? SHARP_POSITIONS[clef] : FLAT_POSITIONS[clef];
    const count = Math.min(Math.abs(fifths), positions.length);
    const glyph = fifths > 0 ? '♯' : '♭';
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    let x = xStart;
    for (let i = 0; i < count; i++) {
      ctx.fillText(glyph, x, bottomLineY - positions[i] * HALF_SPACE_PX);
      x += 7;
    }
    return x + 4;
  }

  private beatToX(beat: number, displayBeat: number): number {
    return this.playheadX() + (beat - displayBeat) * this.pixelsPerBeat;
  }

  /** Inverse of beatToX -- canvas-local x to beat, for the ruler's click-to-seek. */
  xToBeat(x: number, displayBeat: number): number {
    return displayBeat + (x - this.playheadX()) / this.pixelsPerBeat;
  }

  render(displayBeat: number, playheadBeat: number) {
    const ctx = this.ctx2d;
    const width = this.cssWidth;
    const height = this.cssHeight;
    if (width <= 0 || height <= 0) return;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    // Ruler strip: measure numbers, same visual role as PianoRoll's.
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, width, STAFF_RULER_HEIGHT_PX);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, STAFF_RULER_HEIGHT_PX, width, height - STAFF_RULER_HEIGHT_PX);
    ctx.clip();
    ctx.translate(0, STAFF_RULER_HEIGHT_PX - this.scrollY);

    const startBeat = displayBeat - this.playheadX() / this.pixelsPerBeat;
    const endBeat = displayBeat + (width - this.playheadX()) / this.pixelsPerBeat;

    this.drawBarlines(ctx, displayBeat, startBeat, endBeat);
    for (const layout of this.layouts) {
      if (this.hiddenParts.has(layout.partId)) continue;
      this.drawStaff(ctx, layout, displayBeat, startBeat, endBeat);
    }
    ctx.restore();

    // Ruler measure numbers, drawn last so they sit above the barlines/staves below the strip.
    this.drawRulerLabels(ctx, displayBeat, startBeat, endBeat);

    // Playhead, unclipped, full height -- positioned from playheadBeat (the actual sounding
    // position), not displayBeat (which can differ briefly during local view-only panning).
    const playheadPx = this.beatToX(playheadBeat, displayBeat);
    if (playheadPx >= 0 && playheadPx <= width) {
      ctx.strokeStyle = '#ff5566';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadPx, 0);
      ctx.lineTo(playheadPx, height);
      ctx.stroke();
    }
  }

  private drawRulerLabels(ctx: CanvasRenderingContext2D, displayBeat: number, startBeat: number, endBeat: number) {
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textBaseline = 'middle';
    for (const measure of this.score.measures) {
      if (measure.startBeat < startBeat - 4 || measure.startBeat > endBeat) continue;
      const x = this.beatToX(measure.startBeat, displayBeat);
      if (x < -20 || x > this.cssWidth + 20) continue;
      ctx.fillText(String(measure.number), x + 3, STAFF_RULER_HEIGHT_PX / 2);
    }
  }

  private drawBarlines(ctx: CanvasRenderingContext2D, displayBeat: number, startBeat: number, endBeat: number) {
    if (!this.layouts.length) return;
    const top = this.layouts[0].topY - HALF_SPACE_PX * 2;
    const bottom = this.layouts[this.layouts.length - 1].topY + STAFF_HEIGHT_PX + HALF_SPACE_PX * 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    for (const measure of this.score.measures) {
      if (measure.startBeat < startBeat - 4 || measure.startBeat > endBeat) continue;
      const x = this.beatToX(measure.startBeat, displayBeat);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    // Final barline at the end of the piece: a classical thin+thick double bar. Culled in
    // pixel-space (matching the on-screen checks used elsewhere in this file, e.g. drawNote's
    // `x < -20 || x > this.cssWidth + 20`) -- a pre-existing bug here compared this same endX
    // (pixel-space, from beatToX) against startBeat/endBeat (beat-space), a unit mismatch that
    // could make the final barline fail to draw, or draw off-screen, depending on the piece's
    // beat range vs. the viewport's pixel width.
    const endX = this.beatToX(this.score.totalBeats, displayBeat);
    if (endX >= -4 && endX <= this.cssWidth + this.pixelsPerBeat) {
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(endX, top);
      ctx.lineTo(endX, bottom);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(endX + 4, top);
      ctx.lineTo(endX + 4, bottom);
      ctx.stroke();
      ctx.lineWidth = 1; // restore -- good practice even though nothing downstream currently relies on it
    }
  }

  private drawStaff(ctx: CanvasRenderingContext2D, layout: PartLayout, displayBeat: number, startBeat: number, endBeat: number) {
    const color = this.partColor(layout.partId);
    // Ducking (regular Solo elsewhere): dim the whole staff, matching PianoRoll's DIMMED_ALPHA.
    // Muting/true-solo-away is handled one level up in render() by skipping drawStaff entirely.
    const dimmed = this.dimmedParts.has(layout.partId);
    const bottomLineIndex = CLEF_BOTTOM_LINE[layout.clef];
    const bottomLineY = layout.topY + STAFF_HEIGHT_PX;

    // 5 staff lines.
    ctx.strokeStyle = color;
    ctx.globalAlpha = dimmed ? 0.85 * DIMMED_ALPHA : 0.85;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = layout.topY + i * LINE_SPACING_PX;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.cssWidth, y);
      ctx.stroke();
    }
    // Left active for the clef/notes below too -- neither sets its own globalAlpha.
    ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;

    // Clef mark: a simplified, hand-drawn glyph rather than a Unicode music symbol -- this app
    // doesn't bundle a music font, and Unicode clef characters render as missing-glyph boxes on
    // many systems. Not calligraphic, but unambiguous as "treble" vs. "bass" at a glance.
    this.drawClef(ctx, layout.clef, layout.topY, bottomLineY, color);

    const effectiveMeasure = this.measureAtOrBefore(startBeat);
    if (effectiveMeasure) {
      this.drawKeySignature(ctx, this.transposedFifths(effectiveMeasure.fifths), layout.clef, bottomLineY, color, 26);
    }

    // Accidental-awareness bookkeeping (which pitches this measure already has an accidental
    // established for, per standard notation convention) walks every note for this part in
    // startBeat order, not just the ones on screen -- deliberately decoupled from the viewport
    // cull below. Otherwise, scrolling to a mid-measure position could skip an earlier same-
    // measure note that already established an accidental, showing a wrong (missing or extra)
    // accidental on the first visible note.
    let currentMeasureNumber = -1;
    let impliedAlter: Record<string, number> = {};
    const accidentalMap = new Map<string, number>();
    const notes = this.notesByPart.get(layout.partId) ?? [];
    for (const note of notes) {
      if (note.measureNumber !== currentMeasureNumber) {
        currentMeasureNumber = note.measureNumber;
        accidentalMap.clear();
        impliedAlter = impliedAlterForFifths(this.transposedFifths(this.measureByNumber.get(currentMeasureNumber)?.fifths ?? 0));
      }
      const spelling = this.effectiveSpelling(note);
      const key = `${spelling.step}${spelling.octave}`;
      const trackedAlter = accidentalMap.has(key) ? accidentalMap.get(key)! : (impliedAlter[spelling.step] ?? 0);
      const showAccidental = spelling.alter !== trackedAlter;
      accidentalMap.set(key, spelling.alter);

      if (note.startBeat + note.durationBeats < startBeat - 2 || note.startBeat > endBeat) continue;
      this.drawNote(ctx, note, bottomLineIndex, bottomLineY, displayBeat, color, dimmed, showAccidental);
    }

    const rests = this.restsByPart.get(layout.partId) ?? [];
    for (const gap of rests) {
      if (gap.startBeat + gap.durationBeats < startBeat - 2 || gap.startBeat > endBeat) continue;
      this.drawRestGap(ctx, gap, bottomLineY, displayBeat, color);
    }
    ctx.globalAlpha = 1;
  }

  /** Splits one silent gap into notated segments (reusing I5's helper) and draws each as a rest glyph. */
  private drawRestGap(ctx: CanvasRenderingContext2D, gap: { startBeat: number; durationBeats: number }, bottomLineY: number, displayBeat: number, color: string) {
    const segments = splitIntoNotatedSegments(gap.startBeat, gap.durationBeats, this.score.measures);
    for (const seg of segments) {
      const x = this.beatToX(seg.startBeat, displayBeat) + NOTE_X_OFFSET_PX;
      if (x < -20 || x > this.cssWidth + 20) continue;
      const shape = classifyDuration(seg.durationBeats);
      this.drawRestGlyph(ctx, shape, x, bottomLineY, color);
    }
  }

  // Hand-drawn rest glyphs (no music font bundled, same as the clef/flag shapes elsewhere in this
  // file) -- aesthetic judgment calls, distinct from each other and from the notehead shapes at a
  // glance rather than calligraphically exact.
  private drawRestGlyph(ctx: CanvasRenderingContext2D, shape: DurationShape, x: number, bottomLineY: number, color: string) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    const midLineY = bottomLineY - 4 * HALF_SPACE_PX; // middle (3rd) line
    const REST_RECT_W = 7;
    const REST_RECT_H = 4;

    switch (shape.name) {
      case 'whole': {
        // Hangs below the 4th line (position 6).
        const ly = bottomLineY - 6 * HALF_SPACE_PX;
        ctx.fillRect(x - REST_RECT_W / 2, ly, REST_RECT_W, REST_RECT_H);
        break;
      }
      case 'half': {
        // Sits on top of the middle line -- same rectangle, flipped, so it's distinguishable from
        // the whole rest at a glance even though both are otherwise identical rectangles.
        ctx.fillRect(x - REST_RECT_W / 2, midLineY - REST_RECT_H, REST_RECT_W, REST_RECT_H);
        break;
      }
      case 'quarter': {
        // A bold zigzag centered on the middle line -- not the real engraved squiggle, just
        // distinct from the whole/half rectangles and the eighth/16th hook shapes.
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 3, midLineY - 9);
        ctx.lineTo(x + 3, midLineY - 3);
        ctx.lineTo(x - 3, midLineY + 3);
        ctx.lineTo(x + 3, midLineY + 9);
        ctx.stroke();
        break;
      }
      default: {
        // eighth/sixteenth/thirtysecond: a filled dot with one hook curve per flag, reusing the
        // same quadraticCurveTo shape language as the notehead flags, detached from a stem.
        const hooks = shape.name === 'eighth' ? 1 : shape.name === 'sixteenth' ? 2 : 3;
        ctx.beginPath();
        ctx.arc(x, midLineY - 6, 1.8, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < hooks; i++) {
          const hookY = midLineY - 6 + i * 7;
          ctx.beginPath();
          ctx.moveTo(x, hookY);
          ctx.quadraticCurveTo(x + 7, hookY + 5, x, hookY + 11);
          ctx.fill();
        }
      }
    }

    if (shape.dotted) {
      ctx.beginPath();
      ctx.arc(x + REST_RECT_W + 2, midLineY, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawClef(ctx: CanvasRenderingContext2D, clef: ClefType, topY: number, bottomLineY: number, color: string) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (clef === 'treble') {
      // A bezier approximation of the G-clef's spiral, centered on the G line (2nd from bottom) --
      // still hand-drawn (no music font bundled), but meaningfully more recognizable than a plain
      // ellipse+dot. A first-pass shape, expected to be visually iterated on.
      const gLineY = bottomLineY - LINE_SPACING_PX;
      const tailY = bottomLineY + HALF_SPACE_PX * 2;
      const capY = topY - HALF_SPACE_PX * 2;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(16, tailY);
      ctx.bezierCurveTo(8, tailY, 6, gLineY + 8, 12, gLineY + 4);
      ctx.bezierCurveTo(20, gLineY, 20, gLineY - 8, 12, gLineY - 8);
      ctx.bezierCurveTo(6, gLineY - 8, 6, gLineY + 2, 13, gLineY + 3);
      ctx.bezierCurveTo(18, gLineY - 6, 18, topY + 6, 15, topY - 2);
      ctx.bezierCurveTo(11, topY - 6, 10, capY + 4, 15, capY);
      ctx.bezierCurveTo(19, capY - 3, 17, capY - 8, 13, capY - 5);
      ctx.stroke();
    } else {
      // Two dots flanking the F line (second from top), plus a fuller backward-C hook -- the bass
      // clef's defining marks.
      const fLineY = topY + LINE_SPACING_PX;
      ctx.beginPath();
      ctx.arc(18, fLineY - HALF_SPACE_PX, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(18, fLineY + HALF_SPACE_PX, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(6, fLineY - HALF_SPACE_PX * 3);
      ctx.bezierCurveTo(20, fLineY - HALF_SPACE_PX * 3, 20, fLineY + HALF_SPACE_PX * 2, 8, fLineY + HALF_SPACE_PX * 3);
      ctx.stroke();
    }
  }

  /** A shallow curve connecting two tied noteheads at the same pitch, bulging away from the stem side. */
  private drawTie(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, stemUp: boolean, color: string) {
    const dir = stemUp ? 1 : -1;
    const edgeY = y + dir * NOTEHEAD_RADIUS_PX * 0.9;
    const bulgeY = y + dir * (NOTEHEAD_RADIUS_PX * 0.9 + 5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(x1 + NOTEHEAD_RADIUS_PX * 0.6, edgeY);
    ctx.quadraticCurveTo((x1 + x2) / 2, bulgeY, x2 - NOTEHEAD_RADIUS_PX * 0.6, edgeY);
    ctx.stroke();
  }

  private drawNote(
    ctx: CanvasRenderingContext2D,
    note: NoteEvent,
    bottomLineIndex: number,
    bottomLineY: number,
    displayBeat: number,
    color: string,
    dimmed: boolean,
    showAccidental: boolean,
  ) {
    const firstX = this.beatToX(note.startBeat, displayBeat) + NOTE_X_OFFSET_PX;
    const lastX = this.beatToX(note.startBeat + note.durationBeats, displayBeat) + NOTE_X_OFFSET_PX;
    if (lastX < -20 || firstX > this.cssWidth + 20) return;

    const spelling = this.effectiveSpelling(note);
    const staffPosition = diatonicIndex(spelling.step, spelling.octave) - bottomLineIndex;
    const y = bottomLineY - staffPosition * HALF_SPACE_PX;
    // Standard convention: stem up (on the right of the notehead) when the note is below the
    // middle line, down (on the left) when at or above it -- the same for every tied segment,
    // since they all share this note's one pitch.
    const stemUp = staffPosition < 4;

    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    // Ledger lines, drawn first (under the noteheads) and only once at the note's actual start --
    // every tied segment shares the same staff position, so repeating them per segment would just
    // duplicate the same lines under each notehead.
    ctx.lineWidth = 1;
    for (const pos of ledgerLinePositions(staffPosition)) {
      const ly = bottomLineY - pos * HALF_SPACE_PX;
      ctx.beginPath();
      ctx.moveTo(firstX - NOTEHEAD_RADIUS_PX - 3, ly);
      ctx.lineTo(firstX + NOTEHEAD_RADIUS_PX + 3, ly);
      ctx.stroke();
    }

    // Accidental: only drawn when this note's alter differs from what the key signature (or an
    // earlier note in the same measure) already implies for this pitch -- standard notation
    // practice, and the user's explicit ask to avoid a cluttered measure full of redundant
    // sharps/flats. showAccidental (computed by the caller, which tracks this per measure) covers
    // the natural-sign case too, unlike the old "alter !== 0" check. Only on the first segment --
    // a tied note doesn't repeat its accidental on each tied-to notehead.
    if (showAccidental) {
      ctx.font = '15px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(accidentalGlyph(spelling.alter), firstX - NOTEHEAD_RADIUS_PX - 15, y);
    }

    // A tie-merged note (see NoteEvent's doc comment) is split back into individually-notatable
    // segments here -- each drawn as its own notehead/stem/flags, connected by a tie curve, so a
    // long held note reads as real rhythmic notation instead of one illegibly-elongated notehead.
    // Prefer the ORIGINAL tie-note boundaries the source file actually notated (tieSegments) when
    // available -- this preserves the engraver's own rhythmic choices even when they'd
    // mathematically collapse into one "clean" value (e.g. two tied eighths summing to exactly
    // one quarter would otherwise render as a single undivided notehead, losing the tie). Falls
    // back to the mathematical largest-fits split for MIDI imports (no tie concept in the source)
    // and any non-tied note with an unusually long single duration.
    const segments = note.tieSegments
      ? segmentsFromTieLengths(note.startBeat, note.tieSegments)
      : splitIntoNotatedSegments(note.startBeat, note.durationBeats, this.score.measures);
    let prevSegX: number | null = null;
    for (const seg of segments) {
      const segX = this.beatToX(seg.startBeat, displayBeat) + NOTE_X_OFFSET_PX;
      const onScreen = segX >= -20 && segX <= this.cssWidth + 20;
      const shape = classifyDuration(seg.durationBeats);

      if (onScreen) {
        // Notehead: filled for quarter-or-shorter, hollow (stroked ring) for half/whole.
        ctx.beginPath();
        ctx.ellipse(segX, y, NOTEHEAD_RADIUS_PX, NOTEHEAD_RADIUS_PX * 0.75, -0.25, 0, Math.PI * 2);
        if (shape.filled) {
          ctx.fill();
        } else {
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }

        if (shape.dotted) {
          ctx.beginPath();
          ctx.arc(segX + NOTEHEAD_RADIUS_PX + 5, y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }

        if (shape.hasStem) {
          const stemX = stemUp ? segX + NOTEHEAD_RADIUS_PX : segX - NOTEHEAD_RADIUS_PX;
          // 32nd notes (3 flags) get a longer stem than the standard length -- three stacked
          // flags need more vertical room to read as distinct rather than visually overloaded.
          const extraStemPx = shape.flags >= 3 ? 6 : 0;
          const stemEndY = stemUp ? y - (STEM_LENGTH_PX + extraStemPx) : y + (STEM_LENGTH_PX + extraStemPx);
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(stemX, y);
          ctx.lineTo(stemX, stemEndY);
          ctx.stroke();

          // A single stroked curve (no fill) off the stem -- reads as a genuinely thin flag
          // rather than a filled shape. The tip is placed geometrically at FLAG_EXIT_ANGLE off
          // vertical (not just eyeballed), so it swings clearly away from the stem instead of
          // curling back toward it, and holds that angle regardless of the flag's own size.
          ctx.strokeStyle = color;
          ctx.lineWidth = FLAG_STROKE_WIDTH_PX;
          ctx.lineCap = 'round';
          for (let i = 0; i < shape.flags; i++) {
            const flagY = stemEndY + (stemUp ? 1 : -1) * i * FLAG_SPACING_PX;
            const dir = stemUp ? 1 : -1;
            const endX = stemX + dir * FLAG_DROP_PX * Math.tan(FLAG_EXIT_ANGLE);
            const endY = flagY + dir * FLAG_DROP_PX;
            ctx.beginPath();
            ctx.moveTo(stemX, flagY);
            ctx.quadraticCurveTo(stemX + dir * 9.6, flagY + dir * 3.2, endX, endY);
            ctx.stroke();
          }
          ctx.lineCap = 'butt'; // restore canvas default -- nothing downstream else sets its own
        }
      }

      if (prevSegX != null) this.drawTie(ctx, prevSegX, segX, y, stemUp, color);
      prevSegX = segX;
    }

    // Lyric, at a fixed height below the staff (LYRIC_BASELINE_OFFSET_PX) rather than following
    // this note's own pitch, so a whole lyric line reads level -- white (not the part's color) so
    // it stays legible against any of the six-or-so voice colors, drawn straight to the canvas
    // each frame (no bitmap cache, unlike PianoRoll's buffered pipeline -- this view already
    // redraws directly every frame and the note density here doesn't need one). Skipped for
    // dimmed (ducked) parts entirely, matching PianoRoll's dimmed-lyric-skip precedent, not just
    // faded.
    if (note.lyric && !dimmed) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(note.lyric, firstX, bottomLineY + LYRIC_BASELINE_OFFSET_PX);
      // Reset -- these aren't touched at the top of drawNote, so a leftover value here would
      // otherwise silently affect the next note's ledger-line/accidental drawing.
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = color;
    }
  }
}
