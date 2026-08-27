import type { NoteEvent, Score } from './score';

export const BASE_PIXELS_PER_BEAT = 70;
export const STAFF_RULER_HEIGHT_PX = 22; // matches PianoRoll's ruler height, for a consistent look when toggling views
const PLAYHEAD_X_RATIO = 0.2;
const MAX_DPR = 2;
const LINE_SPACING_PX = 9; // distance between two adjacent staff lines
const HALF_SPACE_PX = LINE_SPACING_PX / 2; // vertical distance per diatonic step
const STAFF_HEIGHT_PX = LINE_SPACING_PX * 4; // 5 lines, 4 gaps
const MIN_STAFF_GAP_PX = 44; // minimum space between one staff's bottom line and the next staff's top line (room for ledger lines)
const NOTEHEAD_RADIUS_PX = 4.2;
const STEM_LENGTH_PX = 30;

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

function spellingFor(note: NoteEvent): { step: string; alter: number; octave: number } {
  if (note.step && note.octave != null) return { step: note.step, alter: note.alter ?? 0, octave: note.octave };
  const pitchClass = ((note.midi % 12) + 12) % 12;
  const octave = Math.floor(note.midi / 12) - 1;
  const fallback = CHROMATIC_FALLBACK[pitchClass];
  return { step: fallback.step, alter: fallback.alter, octave };
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

interface DurationShape {
  filled: boolean; // filled notehead (quarter or shorter) vs. hollow (half/whole)
  hasStem: boolean;
  flags: number; // unbeamed eighth/16th/32nd notes get 1/2/3 flags instead of a beam
  dotted: boolean;
}

// { quarter-beat units, filled notehead, has a stem, flag count } for the undotted base durations;
// classifyDuration also checks each one's dotted (x1.5) variant and keeps whichever is closest.
const DURATION_TABLE: { units: number; filled: boolean; hasStem: boolean; flags: number }[] = [
  { units: 4, filled: false, hasStem: false, flags: 0 }, // whole
  { units: 2, filled: false, hasStem: true, flags: 0 }, // half
  { units: 1, filled: true, hasStem: true, flags: 0 }, // quarter
  { units: 0.5, filled: true, hasStem: true, flags: 1 }, // eighth
  { units: 0.25, filled: true, hasStem: true, flags: 2 }, // sixteenth
  { units: 0.125, filled: true, hasStem: true, flags: 3 }, // 32nd
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
  return { filled: best.filled, hasStem: best.hasStem, flags: best.flags, dotted: bestDotted };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
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
 * Renders at the score's *printed* pitches always, ignoring the app's transpose setting: real
 * notated transposition would also change the key signature, which this doesn't model. Use the
 * piano roll (which does reflect transpose) as the transposed reference; PROJECT.md documents this.
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

  constructor(canvas: HTMLCanvasElement, score: Score, partColor: (partId: string) => string) {
    this.canvas = canvas;
    this.score = score;
    this.partColor = partColor;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx2d = ctx;

    this.notesByPart = new Map();
    for (const note of score.notes) {
      const list = this.notesByPart.get(note.partId);
      if (list) list.push(note);
      else this.notesByPart.set(note.partId, [note]);
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

  getPixelsPerBeat() {
    return this.pixelsPerBeat;
  }

  /** Vertical pan, css px -- only does anything once the stacked staves overflow the viewport. */
  scrollByPixels(deltaPx: number) {
    const maxScroll = Math.max(0, this.contentHeightPx - (this.cssHeight - STAFF_RULER_HEIGHT_PX) + 20);
    this.scrollY = clamp(this.scrollY + deltaPx, 0, maxScroll);
  }

  private playheadX(): number {
    return this.cssWidth * PLAYHEAD_X_RATIO;
  }

  private beatToX(beat: number, displayBeat: number): number {
    return this.playheadX() + (beat - displayBeat) * this.pixelsPerBeat;
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
    // Final barline at the end of the piece.
    const endX = this.beatToX(this.score.totalBeats, displayBeat);
    if (endX >= startBeat - 4 && endX <= endBeat + this.pixelsPerBeat) {
      ctx.beginPath();
      ctx.moveTo(endX, top);
      ctx.lineTo(endX, bottom);
      ctx.stroke();
    }
  }

  private drawStaff(ctx: CanvasRenderingContext2D, layout: PartLayout, displayBeat: number, startBeat: number, endBeat: number) {
    const color = this.partColor(layout.partId);
    const bottomLineIndex = CLEF_BOTTOM_LINE[layout.clef];
    const bottomLineY = layout.topY + STAFF_HEIGHT_PX;

    // 5 staff lines.
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = layout.topY + i * LINE_SPACING_PX;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.cssWidth, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Clef mark: a simplified, hand-drawn glyph rather than a Unicode music symbol -- this app
    // doesn't bundle a music font, and Unicode clef characters render as missing-glyph boxes on
    // many systems. Not calligraphic, but unambiguous as "treble" vs. "bass" at a glance.
    this.drawClef(ctx, layout.clef, layout.topY, bottomLineY, color);

    const notes = this.notesByPart.get(layout.partId) ?? [];
    for (const note of notes) {
      if (note.startBeat + note.durationBeats < startBeat - 2 || note.startBeat > endBeat) continue;
      this.drawNote(ctx, note, bottomLineIndex, bottomLineY, displayBeat, color);
    }
  }

  private drawClef(ctx: CanvasRenderingContext2D, clef: ClefType, topY: number, bottomLineY: number, color: string) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (clef === 'treble') {
      // A loop suggesting the treble clef's curl, centered on the G line (second from bottom).
      const gLineY = bottomLineY - LINE_SPACING_PX;
      ctx.beginPath();
      ctx.ellipse(14, gLineY, 7, 11, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(14, topY - 4, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Two dots flanking the F line (second from top), plus a short hook -- the bass clef's
      // defining marks.
      const fLineY = topY + LINE_SPACING_PX;
      ctx.beginPath();
      ctx.arc(18, fLineY - HALF_SPACE_PX, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(18, fLineY + HALF_SPACE_PX, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(8, fLineY, 6, -Math.PI * 0.6, Math.PI * 0.3);
      ctx.stroke();
    }
  }

  private drawNote(
    ctx: CanvasRenderingContext2D,
    note: NoteEvent,
    bottomLineIndex: number,
    bottomLineY: number,
    displayBeat: number,
    color: string,
  ) {
    const x = this.beatToX(note.startBeat, displayBeat);
    if (x < -20 || x > this.cssWidth + 20) return;

    const spelling = spellingFor(note);
    const staffPosition = diatonicIndex(spelling.step, spelling.octave) - bottomLineIndex;
    const y = bottomLineY - staffPosition * HALF_SPACE_PX;
    const shape = classifyDuration(note.durationBeats);

    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    // Ledger lines, drawn first so the notehead sits on top of them.
    ctx.lineWidth = 1;
    for (const pos of ledgerLinePositions(staffPosition)) {
      const ly = bottomLineY - pos * HALF_SPACE_PX;
      ctx.beginPath();
      ctx.moveTo(x - NOTEHEAD_RADIUS_PX - 3, ly);
      ctx.lineTo(x + NOTEHEAD_RADIUS_PX + 3, ly);
      ctx.stroke();
    }

    // Accidental, when this pitch isn't natural.
    if (spelling.alter !== 0) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(spelling.alter > 0 ? '♯' : '♭', x - NOTEHEAD_RADIUS_PX - 12, y);
    }

    // Notehead: filled for quarter-or-shorter, hollow (stroked ring) for half/whole.
    ctx.beginPath();
    ctx.ellipse(x, y, NOTEHEAD_RADIUS_PX, NOTEHEAD_RADIUS_PX * 0.75, -0.25, 0, Math.PI * 2);
    if (shape.filled) {
      ctx.fill();
    } else {
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    if (shape.dotted) {
      ctx.beginPath();
      ctx.arc(x + NOTEHEAD_RADIUS_PX + 5, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    if (shape.hasStem) {
      // Standard convention: stem up (on the right of the notehead) when the note is below the
      // middle line, down (on the left) when at or above it.
      const stemUp = staffPosition < 4;
      const stemX = stemUp ? x + NOTEHEAD_RADIUS_PX : x - NOTEHEAD_RADIUS_PX;
      const stemEndY = stemUp ? y - STEM_LENGTH_PX : y + STEM_LENGTH_PX;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(stemX, y);
      ctx.lineTo(stemX, stemEndY);
      ctx.stroke();

      for (let i = 0; i < shape.flags; i++) {
        const flagY = stemEndY + (stemUp ? 1 : -1) * i * 6;
        ctx.beginPath();
        ctx.moveTo(stemX, flagY);
        ctx.quadraticCurveTo(stemX + (stemUp ? 8 : -8), flagY + (stemUp ? 6 : -6), stemX, flagY + (stemUp ? 12 : -12));
        ctx.fill();
      }
    }
  }
}
