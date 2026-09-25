import type { NoteEvent, Score, SlurArc } from './score';
import { getBeatMarkers } from './score';
import { FONT_DISPLAY, FONT_MONO, FONT_TEXT, INK0, INK1, PAPER, paper, towardPaper, stageFill, gelPill, playheadBeam } from './theme';

export const BASE_PIXELS_PER_BEAT = 70;
// The only place a click/drag sets the playback start point or defines a loop region -- clicks in
// the scrollable note area below are just for previewing a note's pitch, and can't accidentally
// jump playback (a real problem before: any click during scrolling or note-preview would seek).
export const RULER_HEIGHT_PX = 28;
const PLAYHEAD_X_RATIO = 0.2;
const ROW_PADDING_SEMITONES = 2;
// Row height in css px is the larger of MIN_ROW_HEIGHT_PX and "stretch to fill the viewport": a
// piece whose full pitch range fits within the canvas at a comfortable size gets rows that stretch
// to use all the available vertical space (no dead space below the lowest note, no scrolling
// needed -- the pre-scrolling behavior). A piece with too wide a range to fit falls back to the
// minimum and scrolls for the rest. Either way, MIN_ROW_HEIGHT_PX is tall enough for a note bar
// plus its lyric syllable drawn below it, both fully inside the row: a bar-only row was tried but
// even a small overlap between the lyric and the bar of an adjacent voice on the next semitone
// (common in close choral harmony) reads as broken/misaligned, and it's less readable than text
// sitting clearly below its note.
const MIN_ROW_HEIGHT_PX = 32;
const BAR_PAD_PX = 3; // gap from the top of the row to the note pill
// Lyrics always sit in a lane under their note (never inside it), sized with the row: 10.5 px
// text on the smallest rows up to 15 px when follow-the-music zooms in on a phone.
const LYRIC_MIN_PX = 10.5;
const LYRIC_MAX_PX = 15;
// 'score': the syllable in a light tint of its voice colour, hyphens between the syllables of a
// word and an extender line under a held syllable, as printed in choral scores. 'plain': neutral
// syllables only.
const LYRIC_STYLE: 'score' | 'plain' = 'score';

function lyricFontPx(rowHeight: number): number {
  return clamp(rowHeight * 0.27, LYRIC_MIN_PX, LYRIC_MAX_PX);
}

function lyricLanePx(rowHeight: number): number {
  return Math.round(lyricFontPx(rowHeight) + 1.5);
}
const DIMMED_ALPHA = 0.3;
const PAST_SHADE = 'rgba(13,12,22,0.38)'; // laid over everything left of the playhead: played notes step back
const MAX_DPR = 2; // native Retina density; only caps 3x phones, doesn't soften a normal laptop screen
const BUFFER_SPAN_MULTIPLIER = 3; // scrolling-content buffer covers this many viewport-widths of beats
const MAX_BUFFER_DEVICE_PX = 8192; // defensive cap on the content buffer's width in device px (see ensureContentBuffer)
const BUFFER_REBUILD_MARGIN = 0.25; // rebuild once the playhead gets within this fraction of a viewport-width of the buffer's edge
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// A simplified "keyboard-style gutter" (alternating light/dark bands per semitone row, matching
// real piano key coloring -- not literal interlocking key polygons, out of scope for the visual
// gain) drawn once immediately before beat 0, as part of the scrollable content itself rather
// than a persistent left-edge sidebar (the old, already-removed design) -- it scrolls out of view
// naturally once the user scrolls past the piece's start, same as any other content.
const KEYBOARD_WIDTH_PX = 44;
const KEYBOARD_GAP_PX = 8; // space between the keyboard and the first beat
const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]); // C#, D#, F#, G#, A#
// "Follow the music" (setAutoFit): the rows zoom to the pitch range being sung around the playhead,
// gliding to each new range. Never fewer rows than FIT_MIN_ROWS (so one sustained note doesn't
// blow up to fill the screen) and never taller than FIT_MAX_ROW_PX; a new range is only chosen when
// the music leaves the current one or it has become much wider than needed.
const FIT_MIN_ROWS = 11;
const FIT_MAX_ROW_PX = 56;
const FIT_PAD_SEMITONES = 1;
const FIT_LOOKAHEAD_BEATS = 2;
const FIT_GLIDE_MS = 420;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export type PartMixState = 'normal' | 'muted' | 'solo';
export interface LoopRegion {
  start: number;
  end: number;
}

function midiName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export class PianoRoll {
  private canvas: HTMLCanvasElement;
  private score: Score;
  private partColor: (partId: string) => string;
  private ctx2d: CanvasRenderingContext2D;
  private minMidi: number;
  private maxMidi: number;
  // Untransposed pitch extremes -- minMidi/maxMidi (below) are recomputed from these plus the
  // current transpose every time it changes, rather than fixed forever at construction time.
  private basePitchMin: number;
  private basePitchMax: number;
  private transpose = 0;
  private pixelsPerBeat = BASE_PIXELS_PER_BEAT;
  private hiddenParts = new Set<string>();
  private dimmedParts = new Set<string>();
  private loopRegion: LoopRegion | null = null;
  private beatMarkers: ReturnType<typeof getBeatMarkers>;
  private notesByPart: Map<string, NoteEvent[]>;
  private slursByPart: Map<string, SlurArc[]>;
  private dpr = 1;
  private previewNote: { startBeat: number; midi: number } | null = null;
  private lyricBitmaps = new Map<string, { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number }>();
  private lyricMeasureCtx: CanvasRenderingContext2D | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private rowHeightPx = MIN_ROW_HEIGHT_PX;
  private scrollY = 0; // content-space px scrolled down from the top of the pitch range
  private scrollYInitialized = false;
  // Follow-the-music state (see FIT_* above). The content buffer is painted at the fitted row
  // height; while gliding between two ranges it is blitted scaled by viewScale (1 at rest), so a
  // zoom change costs one buffer repaint, not one per frame.
  private autoFit = false;
  private autoFitSuspended = false;
  private viewScale = 1;
  private fitView: { top: number; row: number } | null = null; // current display: pitch at the top edge, row height
  private fitGlide: { from: { top: number; row: number }; to: { top: number; row: number }; t0: number } | null = null;
  private maxNoteBeats = 0;

  // Scrolling-content buffer: gridlines/notes/slurs pre-rendered into a wide offscreen strip.
  // During playback only the scroll offset changes each frame -- nothing about notes' positions
  // relative to each other -- so re-rasterizing hundreds of shapes/text every frame was wasted
  // work. Rebuilt only when structural state changes or the playhead nears the buffered edge.
  private contentBuffer: HTMLCanvasElement | null = null;
  private contentBufferOriginBeat = 0;
  private contentBufferBeatsSpan = 0;
  private contentBufferDirty = true;

  // Ruler measure-number labels, pre-rendered alongside the content buffer (same origin/span, same
  // rebuild trigger) instead of being fillText'd fresh every frame -- text shaping/rasterizing on
  // every animation frame was real per-frame cost, and doing it at a different fractional x each
  // frame (as playback beat progresses continuously) is exactly what makes text look like it's
  // shimmering/blurring: see snapToDevicePx below for the other half of that fix.
  private rulerBuffer: HTMLCanvasElement | null = null;
  private sections: { label: string; beat: number }[] = [];

  constructor(canvas: HTMLCanvasElement, score: Score, partColor: (partId: string) => string) {
    this.canvas = canvas;
    this.score = score;
    this.partColor = partColor;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx2d = ctx;
    this.beatMarkers = getBeatMarkers(score);

    this.notesByPart = new Map();
    for (const note of score.notes) {
      const list = this.notesByPart.get(note.partId);
      if (list) list.push(note);
      else this.notesByPart.set(note.partId, [note]);
    }
    for (const list of this.notesByPart.values()) list.sort((a, b) => a.startBeat - b.startBeat);
    this.maxNoteBeats = score.notes.reduce((max, n) => Math.max(max, n.durationBeats), 0);
    this.slursByPart = new Map();
    for (const slur of score.slurs) {
      const list = this.slursByPart.get(slur.partId);
      if (list) list.push(slur);
      else this.slursByPart.set(slur.partId, [slur]);
    }
    // The fixed pitch-row range (and therefore the scrollable content height) has to cover every
    // pitch a note could ever be drawn at, not just its untransposed one: notes are drawn at
    // `note.midi + this.transpose` (see render()), but this range itself is computed once here
    // and never revisited when transpose changes. Padding only by ROW_PADDING_SEMITONES left a
    // transposed-far-enough note's row outside [minMidi, maxMidi] entirely -- rowY() would place
    // it beyond the content area's bottom/top, and maxScrollY() (itself derived from this same
    // untransposed range) couldn't scroll far enough to reach it. A concretely reported bug: bass
    // notes becoming permanently invisible/unreachable-by-scroll after transposing down.
    const pitches = score.notes.map((n) => n.midi);
    this.basePitchMin = pitches.length ? Math.min(...pitches) : 60;
    this.basePitchMax = pitches.length ? Math.max(...pitches) : 72;
    this.minMidi = 0;
    this.maxMidi = 0;
    this.updatePitchRange();
  }

  /**
   * Recomputes the fixed pitch-row range from basePitchMin/Max plus the current transpose --
   * called at construction and every setTranspose(). Notes are drawn at `note.midi +
   * this.transpose` (see render()), but minMidi/maxMidi used to be computed once from the
   * untransposed pitches and never revisited: transposing far enough could put a note's row
   * outside [minMidi, maxMidi] entirely, where rowY() places it beyond the content area's
   * bottom/top and maxScrollY() (itself derived from this same range) can't scroll far enough to
   * reach it. A concretely reported bug: bass notes becoming permanently invisible/unreachable-
   * by-scroll after transposing down. Both bounds shift by the same `transpose` amount, so `range`
   * (and therefore contentHeightPx()/maxScrollY(), which only depend on the range's *size*, not
   * its offset) stays constant across any transpose value -- this only remaps which pitches the
   * existing scroll position shows, not how much there is to scroll through, so it doesn't need
   * to touch/preserve scrollY itself.
   */
  private updatePitchRange() {
    this.minMidi = this.basePitchMin + this.transpose - ROW_PADDING_SEMITONES;
    this.maxMidi = this.basePitchMax + this.transpose + ROW_PADDING_SEMITONES;
  }

  /** Mute hides a part entirely; when any part is soloed, every non-soloed (and non-muted) part is dimmed. */
  setPartMix(mix: Map<string, PartMixState>) {
    this.hiddenParts = new Set();
    this.dimmedParts = new Set();
    const anySolo = Array.from(mix.values()).some((s) => s === 'solo');
    for (const [partId, state] of mix) {
      if (state === 'muted') this.hiddenParts.add(partId);
      else if (anySolo && state !== 'solo') this.dimmedParts.add(partId);
    }
    this.contentBufferDirty = true;
  }

  setTranspose(semitones: number) {
    this.transpose = semitones;
    this.updatePitchRange();
    this.contentBufferDirty = true;
  }

  setZoom(factor: number) {
    this.pixelsPerBeat = BASE_PIXELS_PER_BEAT * factor;
    this.contentBufferDirty = true;
  }

  getPixelsPerBeat() {
    return this.pixelsPerBeat;
  }

  private contentHeightPx(): number {
    return (this.maxMidi - this.minMidi) * this.rowHeightPx;
  }

  /** The scrollable note area's own height: total canvas height minus the fixed ruler strip. */
  private contentAreaHeight(): number {
    return Math.max(1, this.cssHeight - RULER_HEIGHT_PX);
  }

  private maxScrollY(): number {
    return Math.max(0, this.contentHeightPx() - this.contentAreaHeight());
  }

  /** Pans the pitch axis by a delta in css px; positive scrolls down toward lower pitches. */
  scrollByPixels(dy: number) {
    // Scrolling by hand takes over from follow-the-music until resumeAutoFit() (the next Play).
    if (this.autoFit && !this.autoFitSuspended) this.settleAutoFit();
    this.scrollY = clamp(this.scrollY + dy, 0, this.maxScrollY());
  }

  /**
   * Follow the music: rows zoom to the range being sung around the playhead instead of always
   * showing the whole piece's range. Used on phones and in the sing-along view.
   */
  setAutoFit(on: boolean) {
    if (on === this.autoFit) return;
    this.autoFit = on;
    this.autoFitSuspended = false;
    this.fitView = null;
    this.fitGlide = null;
    this.viewScale = 1;
    if (!on) this.applyStaticLayout();
  }

  /** Picks follow-the-music back up after the user scrolled by hand. */
  resumeAutoFit() {
    if (!this.autoFitSuspended) return;
    this.autoFitSuspended = false;
    this.fitView = null;
  }

  /** True while a zoom glide is in progress (the caller keeps rendering until it ends). */
  isAnimating(): boolean {
    return this.fitGlide !== null;
  }

  /** Ends a glide where it is and freezes the fitted zoom, so hand scrolling works from there. */
  private settleAutoFit() {
    this.autoFitSuspended = true;
    this.fitGlide = null;
    if (this.fitView) this.setBufferRow(this.fitView.row);
    this.viewScale = 1;
    this.scrollY = clamp(this.scrollY, 0, this.maxScrollY());
  }

  private setBufferRow(row: number) {
    if (Math.abs(row - this.rowHeightPx) < 0.01) return;
    this.rowHeightPx = row;
    this.contentBufferDirty = true;
    this.lyricBitmaps.clear(); // the lyric size follows the row height
  }

  /** The whole piece's range: rows stretch to fill the height, else MIN_ROW_HEIGHT_PX and scroll. */
  private applyStaticLayout() {
    const totalRows = Math.max(1, this.maxMidi - this.minMidi);
    this.setBufferRow(Math.max(MIN_ROW_HEIGHT_PX, this.contentAreaHeight() / totalRows));
    this.scrollY = clamp(this.scrollY, 0, this.maxScrollY());
  }

  /** Lowest and highest pitch (transposed) sung by a visible voice between two beats, or null. */
  private rangeBetween(from: number, to: number): { lo: number; hi: number } | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const part of this.score.parts) {
      if (this.hiddenParts.has(part.id)) continue;
      const notes = this.notesByPart.get(part.id);
      if (!notes) continue;
      let a = 0;
      let b = notes.length;
      const earliest = from - this.maxNoteBeats;
      while (a < b) {
        const mid = (a + b) >> 1;
        if (notes[mid].startBeat < earliest) a = mid + 1;
        else b = mid;
      }
      for (let i = a; i < notes.length && notes[i].startBeat < to; i++) {
        const n = notes[i];
        if (n.startBeat + n.durationBeats <= from) continue;
        lo = Math.min(lo, n.midi);
        hi = Math.max(hi, n.midi);
      }
    }
    return lo <= hi ? { lo: lo + this.transpose, hi: hi + this.transpose } : null;
  }

  /** The view (top pitch, row height) that frames a pitch range, centred, within the content. */
  private frameFor(lo: number, hi: number): { top: number; row: number } {
    const area = this.contentAreaHeight();
    const rows = Math.max(FIT_MIN_ROWS, hi - lo + 1 + 2 * FIT_PAD_SEMITONES);
    const row = clamp(area / rows, MIN_ROW_HEIGHT_PX, FIT_MAX_ROW_PX);
    const visibleRows = area / row;
    // Pitch coordinate p: row m spans p in [m, m + 1]; the content's top edge is p = maxMidi.
    let top = (lo + hi + 1) / 2 + visibleRows / 2;
    top = clamp(top, Math.min(this.maxMidi, this.minMidi + visibleRows), this.maxMidi);
    return { top, row };
  }

  /** Advances follow-the-music for this frame: chooses a new range when needed, glides to it. */
  private updateAutoFit(displayBeat: number) {
    if (!this.autoFit || this.autoFitSuspended || this.cssHeight <= 0) return;
    const area = this.contentAreaHeight();
    const anchorX = this.playheadX(this.cssWidth);
    const from = displayBeat - anchorX / this.pixelsPerBeat;
    const to = displayBeat + (this.cssWidth - anchorX) / this.pixelsPerBeat + FIT_LOOKAHEAD_BEATS;
    const range = this.rangeBetween(from, to);
    const now = performance.now();
    if (range) {
      const target = this.frameFor(range.lo, range.hi);
      const current = this.fitGlide?.to ?? this.fitView;
      const shown = current ? { hi: current.top, lo: current.top - area / current.row } : null;
      const fits = shown && range.lo >= shown.lo + 0.3 && range.hi + 1 <= shown.hi - 0.3;
      const tooWide = current && target.row > current.row * 1.35;
      if (!current || !fits || tooWide) {
        if (!this.fitView) {
          this.fitView = target;
        } else {
          this.fitGlide = { from: { ...this.fitView }, to: target, t0: now };
        }
        // Paint the buffer at the destination's row height once; the glide scales toward it.
        this.setBufferRow(target.row);
      }
    } else if (!this.fitView) {
      this.fitView = this.frameFor(60, 72);
      this.setBufferRow(this.fitView.row);
    }
    if (this.fitGlide) {
      const k = Math.min(1, (now - this.fitGlide.t0) / FIT_GLIDE_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const { from: a, to: b } = this.fitGlide;
      this.fitView = { top: a.top + (b.top - a.top) * e, row: a.row + (b.row - a.row) * e };
      if (k >= 1) {
        this.fitView = { ...b };
        this.fitGlide = null;
      }
    }
    const view = this.fitView!;
    this.viewScale = view.row / this.rowHeightPx;
    this.scrollY = (this.maxMidi - view.top) * this.rowHeightPx;
  }

  setLoopRegion(region: LoopRegion | null) {
    this.loopRegion = region;
  }

  /** Section letters (rehearsal marks) printed as boxed letters in the ruler. */
  setSections(sections: { label: string; beat: number }[]) {
    this.sections = sections;
    this.contentBufferDirty = true;
  }

  /** Shows the pitch name label at a clicked note's position (or clears it, if null). */
  setPreviewNote(note: { startBeat: number; midi: number } | null) {
    this.previewNote = note;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Resizing the backing store resets context state, including this -- see snapToDevicePx for
    // why it matters (an unsnapped position wouldn't need smoothing disabled, but a snapped one
    // still gets blitted at a fractional *device* pixel unless smoothing is off, since some
    // browsers interpolate a 1:1 drawImage anyway when antialiasing hints are on).
    this.ctx2d.imageSmoothingEnabled = false;
    this.contentBufferDirty = true;
    this.lyricBitmaps.clear(); // cached bitmaps are baked at the old dpr

    if (this.autoFit) {
      // Re-frame for the new size on the next render, without a glide.
      this.fitView = null;
      this.fitGlide = null;
      this.autoFitSuspended = false;
      return;
    }
    const totalRows = Math.max(1, this.maxMidi - this.minMidi);
    this.rowHeightPx = Math.max(MIN_ROW_HEIGHT_PX, this.contentAreaHeight() / totalRows);

    if (!this.scrollYInitialized) {
      // Center the view on first layout rather than starting pinned to the top of the range.
      this.scrollY = this.maxScrollY() / 2;
      this.scrollYInitialized = true;
    } else {
      this.scrollY = clamp(this.scrollY, 0, this.maxScrollY());
    }
  }

  /** Content-space (unscrolled) y of a pitch row's bottom edge, within the fixed full pitch range. */
  private rowY(midi: number): number {
    const range = this.maxMidi - this.minMidi;
    const t = (midi - this.minMidi) / range;
    const height = this.contentHeightPx();
    return height - t * height;
  }

  private playheadX(width: number): number {
    return width * PLAYHEAD_X_RATIO;
  }

  /**
   * Rounds a css-px x to the nearest whole *device* pixel. The scrolling content buffer is blitted
   * at a continuously-changing x (following the playback beat), and a fractional device-pixel
   * offset forces the browser to resample/interpolate an otherwise 1:1 image copy -- softening
   * already-crisp pre-rendered text a little differently every frame, which reads as blur/shimmer.
   * Snapping the destination keeps every frame's blit pixel-aligned; the sub-device-pixel error
   * this introduces is far below what's visible.
   */
  private snapToDevicePx(x: number): number {
    return Math.round(x * this.dpr) / this.dpr;
  }

  /** Inverse of the render-time beat->x mapping: canvas-local x (from the cached canvas rect) -> beat. */
  xToBeat(x: number, displayBeat: number): number {
    return displayBeat + (x - this.playheadX(this.cssWidth)) / this.pixelsPerBeat;
  }

  /** Inverse of rowY(): canvas-local y (accounting for the ruler strip and current vertical scroll) -> midi. */
  private yToMidi(y: number): number {
    const contentY = (y - RULER_HEIGHT_PX) / this.viewScale + this.scrollY;
    const height = this.contentHeightPx();
    return this.minMidi + Math.floor((height - contentY) / this.rowHeightPx);
  }

  /**
   * Finds the note (if any, among currently-visible parts) at a canvas-local point, accounting
   * for the current transpose -- so the returned midi is the pitch that would actually sound.
   */
  hitTestNote(x: number, y: number, displayBeat: number): { partId: string; startBeat: number; midi: number } | null {
    const beat = this.xToBeat(x, displayBeat);
    const midi = this.yToMidi(y);
    for (const part of this.score.parts) {
      if (this.hiddenParts.has(part.id)) continue;
      const notes = this.notesByPart.get(part.id);
      if (!notes) continue;
      for (const note of notes) {
        if (note.midi + this.transpose !== midi) continue;
        if (beat >= note.startBeat && beat < note.startBeat + note.durationBeats) {
          return { partId: part.id, startBeat: note.startBeat, midi };
        }
      }
    }
    return null;
  }

  /**
   * Whether a canvas-local point hits the piano-keyboard strip near beat 0 (see
   * KEYBOARD_WIDTH_PX), and if so, which pitch's key -- for click-to-preview. yToMidi is an
   * unclamped linear extrapolation, so a click within the keyboard's x-range but above/below the
   * actual drawn rows (e.g. when the content is shorter than the viewport) is rejected rather
   * than returning a midi with no visible key.
   */
  hitTestKeyboard(x: number, y: number, displayBeat: number): number | null {
    const keyboardWidthBeats = KEYBOARD_WIDTH_PX / this.pixelsPerBeat;
    const gapBeats = KEYBOARD_GAP_PX / this.pixelsPerBeat;
    const beat = this.xToBeat(x, displayBeat);
    if (beat < -keyboardWidthBeats - gapBeats || beat >= -gapBeats) return null;
    const midi = this.yToMidi(y);
    if (midi < this.minMidi || midi > this.maxMidi) return null;
    return midi;
  }

  render(displayBeat: number, playheadBeat: number) {
    // Cached in resize() rather than read from getBoundingClientRect() here: this runs every
    // animation frame (and on every wheel/pointer event), and a layout read interleaved with the
    // position-display text write each frame forces the browser into synchronous layout thrashing.
    const width = this.cssWidth;
    const height = this.cssHeight;
    const contentAreaHeight = this.contentAreaHeight();
    const ctx = this.ctx2d;
    const anchorX = this.playheadX(width);
    this.updateAutoFit(displayBeat);
    const rowHeight = this.rowHeightPx;
    const scale = this.viewScale;
    const contentH = this.contentHeightPx();

    // beatToX is anchored to displayBeat (the view's own reference point, at the fixed anchorX
    // fraction of the width) -- everything scrolls relative to that. playheadBeat is a separate,
    // independent beat: where the piece actually is / will resume from. The two coincide (so the
    // red line sits right at anchorX) exactly when the view hasn't been panned away from it.
    const beatToX = (beat: number) => anchorX + (beat - displayBeat) * this.pixelsPerBeat;

    ctx.fillStyle = stageFill(ctx, height);
    ctx.fillRect(0, 0, width, height);

    // Ruler: the only clickable strip for setting the playback start point or a loop region (see
    // RULER_HEIGHT_PX). Fixed at the top, never scrolls vertically, but shares the same horizontal
    // beat->x mapping as the note content below so bar numbers/section letters line up with bars.
    ctx.fillStyle = INK1;
    ctx.fillRect(0, 0, width, RULER_HEIGHT_PX);
    ctx.fillStyle = paper(0.12);
    ctx.fillRect(0, RULER_HEIGHT_PX - 1, width, 1);
    if (this.loopRegion) {
      const x1 = beatToX(this.loopRegion.start);
      const x2 = beatToX(this.loopRegion.end);
      ctx.fillStyle = paper(0.14);
      roundedRect(ctx, x1, 5, x2 - x1, RULER_HEIGHT_PX - 10, 4);
      ctx.fill();
      ctx.fillStyle = PAPER;
      roundedRect(ctx, x1 - 2, 4, 4, RULER_HEIGHT_PX - 8, 2);
      ctx.fill();
      roundedRect(ctx, x2 - 2, 4, 4, RULER_HEIGHT_PX - 8, 2);
      ctx.fill();
    }
    // Bar numbers and section letters are pre-rendered into rulerBuffer (see ensureContentBuffer)
    // and just blitted here, same as the note content below -- see snapToDevicePx's doc comment.
    this.ensureContentBuffer(displayBeat, width, rowHeight);
    if (this.rulerBuffer) {
      const destX = this.snapToDevicePx(anchorX - (displayBeat - this.contentBufferOriginBeat) * this.pixelsPerBeat);
      const bufferCssWidth = this.contentBufferBeatsSpan * this.pixelsPerBeat;
      const srcStartCss = Math.max(0, -destX);
      const srcEndCss = Math.min(bufferCssWidth, width - destX);
      const srcWidthCss = srcEndCss - srcStartCss;
      if (srcWidthCss > 0) {
        ctx.drawImage(this.rulerBuffer, srcStartCss * this.dpr, 0, srcWidthCss * this.dpr, RULER_HEIGHT_PX * this.dpr, destX + srcStartCss, 0, srcWidthCss, RULER_HEIGHT_PX);
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT_PX, width, contentAreaHeight);
    ctx.clip();
    ctx.translate(0, RULER_HEIGHT_PX);

    // Thin vertical markers below are drawn as fillRect, not stroke(): a 1-2px straight line is
    // exactly representable as a filled rectangle, and stroked paths go through a much heavier
    // rasterization path in most renderers.
    if (this.loopRegion) {
      const x1 = beatToX(this.loopRegion.start);
      const x2 = beatToX(this.loopRegion.end);
      ctx.fillStyle = paper(0.035);
      ctx.fillRect(x1, 0, x2 - x1, contentAreaHeight);
      ctx.fillStyle = paper(0.3);
      ctx.fillRect(Math.round(x1), 0, 1, contentAreaHeight);
      ctx.fillRect(Math.round(x2), 0, 1, contentAreaHeight);
    }

    // Scrolling content (rows, gridlines, notes, lyrics, slurs): pre-rendered, blitted each frame.
    // Self-correcting: a dropped frame or a tab returning from the background can let the beat
    // jump further than the incremental rebuild check expects -- verify the blit will really cover
    // [0, width] and force one immediate rebuild if it won't.
    if (this.contentBuffer) {
      const destXCheck = anchorX - (displayBeat - this.contentBufferOriginBeat) * this.pixelsPerBeat;
      const bufferCssWidthCheck = this.contentBufferBeatsSpan * this.pixelsPerBeat;
      if (destXCheck > 0.5 || destXCheck + bufferCssWidthCheck < width - 0.5) {
        this.contentBufferDirty = true;
        this.ensureContentBuffer(displayBeat, width, rowHeight);
      }
    }
    if (this.contentBuffer) {
      const destX = this.snapToDevicePx(anchorX - (displayBeat - this.contentBufferOriginBeat) * this.pixelsPerBeat);
      // During a follow-the-music glide the buffer is scaled vertically (scale != 1); at rest it
      // is a pixel-aligned 1:1 copy, as before.
      const scrollYSnapped = scale === 1 ? this.snapToDevicePx(this.scrollY) : this.scrollY;
      const bufferCssWidth = this.contentBufferBeatsSpan * this.pixelsPerBeat;
      const srcStartCss = Math.max(0, -destX);
      const srcEndCss = Math.min(bufferCssWidth, width - destX);
      const srcWidthCss = srcEndCss - srcStartCss;
      const srcTop = Math.max(0, scrollYSnapped);
      const destTop = (srcTop - scrollYSnapped) * scale;
      const srcHeightCss = Math.min(contentAreaHeight / scale, contentH - srcTop);
      if (srcWidthCss > 0 && srcHeightCss > 0) {
        ctx.drawImage(this.contentBuffer, srcStartCss * this.dpr, srcTop * this.dpr, srcWidthCss * this.dpr, srcHeightCss * this.dpr, destX + srcStartCss, destTop, srcWidthCss, srcHeightCss * scale);
      }
    }

    const playheadXPos = this.snapToDevicePx(beatToX(playheadBeat));
    // Played music steps back; the notes sounding right now light up. Both are per-frame overlays
    // on top of the buffer (they depend on the playhead), and cheap: one rect, plus one glowing
    // pill per voice that is actually singing at this instant.
    if (playheadXPos > 0) {
      ctx.fillStyle = PAST_SHADE;
      ctx.fillRect(0, 0, Math.min(width, playheadXPos), contentAreaHeight);
    }
    this.drawSoundingNotes(ctx, playheadBeat, beatToX, rowHeight, contentAreaHeight, scale);

    // Preview note label: set by a click on a note (see hitTestNote); shows its pitch name at the
    // start of that note. Drawn fresh each frame since it's transient UI state, not score content.
    if (this.previewNote) {
      const x = this.snapToDevicePx(beatToX(this.previewNote.startBeat));
      const y = (this.rowY(this.previewNote.midi) - rowHeight - this.scrollY) * scale;
      if (x >= -60 && x <= width + 10 && y >= -20 && y <= contentAreaHeight) {
        const label = midiName(this.previewNote.midi);
        ctx.font = `600 12px ${FONT_MONO}`;
        const textWidth = ctx.measureText(label).width;
        ctx.fillStyle = PAPER;
        roundedRect(ctx, x, y - 22, textWidth + 14, 20, 6);
        ctx.fill();
        ctx.fillStyle = INK0;
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + 7, y - 11.5);
      }
    }

    ctx.restore();

    // Playhead: always the actual current-or-paused position (playheadBeat), not necessarily
    // displayBeat -- panning the view away from it (e.g. browsing while paused) is allowed, and
    // this keeps tracking where the piece is/will resume from. Drawn last, full height.
    if (playheadXPos >= -36 && playheadXPos <= width + 36) {
      playheadBeam(ctx, playheadXPos, 0, height);
      ctx.fillStyle = PAPER;
      ctx.fillRect(playheadXPos - 1, 0, 2, height);
      ctx.beginPath();
      ctx.moveTo(playheadXPos - 6, 0);
      ctx.lineTo(playheadXPos + 6, 0);
      ctx.lineTo(playheadXPos, 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Redraws, lit and glowing, the pill of every note sounding at the playhead (in content-area coordinates). */
  private drawSoundingNotes(ctx: CanvasRenderingContext2D, beat: number, beatToX: (b: number) => number, rowHeight: number, areaHeight: number, scale: number) {
    const pillH = this.pillHeight(rowHeight) * scale;
    for (const part of this.score.parts) {
      if (this.hiddenParts.has(part.id) || this.dimmedParts.has(part.id)) continue;
      const notes = this.notesByPart.get(part.id);
      if (!notes) continue;
      let lo = 0;
      let hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].startBeat <= beat) lo = mid + 1;
        else hi = mid;
      }
      const color = this.partColor(part.id);
      for (let i = lo - 1; i >= Math.max(0, lo - 6); i--) {
        const note = notes[i];
        if (note.startBeat + note.durationBeats <= beat) continue;
        const x = beatToX(note.startBeat);
        const w = note.durationBeats * this.pixelsPerBeat;
        const y = (this.rowY(note.midi + this.transpose) - rowHeight - this.scrollY + BAR_PAD_PX) * scale;
        if (y + pillH < 0 || y > areaHeight) continue;
        // Lit gel, glowing in the voice's colour.
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 18;
        gelPill(ctx, x + 1, y, Math.max(w - 3, 7), pillH, color, true);
        ctx.restore();
        // The syllable being sung lights up in its lane (drawn over the buffer's quieter copy).
        if (note.lyric) {
          const bmp = this.getLyricBitmap(note.lyric, PAPER, lyricFontPx(rowHeight), 700);
          ctx.drawImage(bmp.canvas, x + 2, y + pillH + scale, bmp.cssWidth * scale, bmp.cssHeight * scale);
        }
      }
    }
  }

  private pillHeight(rowHeight: number): number {
    return Math.max(6, rowHeight - BAR_PAD_PX * 2 - lyricLanePx(rowHeight));
  }

  private ensureContentBuffer(currentBeat: number, contentWidth: number, rowHeight: number) {
    const visibleBeatsSpan = Math.max(1, contentWidth / this.pixelsPerBeat);
    const margin = visibleBeatsSpan * BUFFER_REBUILD_MARGIN;
    const needsRebuild =
      this.contentBufferDirty ||
      !this.contentBuffer ||
      currentBeat - margin < this.contentBufferOriginBeat ||
      currentBeat + margin > this.contentBufferOriginBeat + this.contentBufferBeatsSpan;
    if (!needsRebuild) return;

    // Cap the buffer's device-pixel width defensively: some browser/GPU combinations silently
    // clamp or fail to paint canvases beyond roughly 16k device px on a side, which on a very
    // wide and/or high-DPI desktop display could turn "3 viewport-widths of buffer" into a canvas
    // larger than that. Staying comfortably under it costs a smaller (but still ample) buffer only
    // in that extreme combination -- everywhere else this has no effect.
    const idealHalfSpan = (visibleBeatsSpan * BUFFER_SPAN_MULTIPLIER) / 2;
    const maxBeatsSpan = MAX_BUFFER_DEVICE_PX / this.dpr / this.pixelsPerBeat;
    const halfSpan = Math.min(idealHalfSpan, Math.max(visibleBeatsSpan, maxBeatsSpan / 2));
    const originBeat = currentBeat - halfSpan;
    const beatsSpan = halfSpan * 2;
    this.contentBufferOriginBeat = originBeat;
    this.contentBufferBeatsSpan = beatsSpan;

    const contentH = this.contentHeightPx();
    const bufCssWidth = Math.max(1, beatsSpan * this.pixelsPerBeat);
    const buf = this.contentBuffer ?? document.createElement('canvas');
    buf.width = Math.max(1, Math.round(bufCssWidth * this.dpr));
    buf.height = Math.max(1, Math.round(contentH * this.dpr));
    const bctx = buf.getContext('2d');
    if (!bctx) return;
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintContent(bctx, originBeat, bufCssWidth, contentH, rowHeight);
    this.contentBuffer = buf;

    const rulerBuf = this.rulerBuffer ?? document.createElement('canvas');
    rulerBuf.width = buf.width;
    rulerBuf.height = Math.max(1, Math.round(RULER_HEIGHT_PX * this.dpr));
    const rctx = rulerBuf.getContext('2d');
    if (rctx) {
      rctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      rctx.imageSmoothingEnabled = false;
      rctx.clearRect(0, 0, bufCssWidth, RULER_HEIGHT_PX);
      rctx.textBaseline = 'alphabetic';
      for (const marker of this.beatMarkers) {
        const x = Math.round((marker.beat - originBeat) * this.pixelsPerBeat);
        if (x < -30 || x > bufCssWidth + 30) continue;
        rctx.fillStyle = paper(marker.isDownbeat ? 0.4 : 0.16);
        rctx.fillRect(x, RULER_HEIGHT_PX - (marker.isDownbeat ? 10 : 5), 1, marker.isDownbeat ? 9 : 4);
        if (!marker.isDownbeat) continue;
        let textX = x + 6;
        const section = this.sections.find((sec) => Math.abs(sec.beat - marker.beat) < 1e-6);
        if (section) {
          // A rehearsal letter as printed in the score: bold serif capital in a square box.
          rctx.strokeStyle = PAPER;
          rctx.lineWidth = 1.3;
          const boxW = Math.max(17, rctx.measureText(section.label).width + 8);
          rctx.strokeRect(x + 5.5, 5.5, boxW, 17);
          rctx.font = `700 12px ${FONT_DISPLAY}`;
          rctx.fillStyle = PAPER;
          rctx.textAlign = 'center';
          rctx.fillText(section.label, x + 5.5 + boxW / 2, 18.5);
          rctx.textAlign = 'start';
          textX = x + boxW + 11;
        }
        rctx.font = `600 11px ${FONT_MONO}`;
        rctx.fillStyle = paper(0.62);
        rctx.fillText(String(marker.measureNumber), textX, 18);
      }
      // Section letters that don't sit on a bar line (hand-marked mid-bar) still get their box.
      for (const section of this.sections) {
        if (this.beatMarkers.some((m) => m.isDownbeat && Math.abs(m.beat - section.beat) < 1e-6)) continue;
        const x = Math.round((section.beat - originBeat) * this.pixelsPerBeat);
        if (x < -30 || x > bufCssWidth + 30) continue;
        rctx.strokeStyle = PAPER;
        rctx.lineWidth = 1.3;
        rctx.strokeRect(x + 0.5, 5.5, 17, 17);
        rctx.font = `700 12px ${FONT_DISPLAY}`;
        rctx.fillStyle = PAPER;
        rctx.textAlign = 'center';
        rctx.fillText(section.label, x + 9, 18.5);
        rctx.textAlign = 'start';
      }
      this.rulerBuffer = rulerBuf;
    }

    this.contentBufferDirty = false;
  }

  /** Paints gridlines, notes, and slurs into a buffer strip spanning the full pitch range, using buffer-local (not screen) coordinates. */
  private paintContent(ctx: CanvasRenderingContext2D, originBeat: number, widthCss: number, heightCss: number, rowHeight: number) {
    const localBeatToX = (beat: number) => (beat - originBeat) * this.pixelsPerBeat;
    ctx.clearRect(0, 0, widthCss, heightCss);

    // Rows shaded like piano keys: black-key rows a touch darker, and a hairline under every C, so
    // intervals and octaves can be read at a glance without a persistent keyboard.
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const y = this.rowY(midi) - rowHeight;
      if (BLACK_KEY_PITCH_CLASSES.has(pc)) {
        ctx.fillStyle = 'rgba(0,0,0,0.26)';
        ctx.fillRect(0, y, widthCss, rowHeight);
      }
      if (pc === 0) {
        ctx.fillStyle = paper(0.08);
        ctx.fillRect(0, Math.round(y + rowHeight - 1), widthCss, 1);
      }
    }

    // Beat / bar gridlines as plain 1px rects (see render()'s note on fillRect vs stroke).
    for (const marker of this.beatMarkers) {
      const x = Math.round(localBeatToX(marker.beat));
      if (x < -20 || x > widthCss + 20) continue;
      ctx.fillStyle = paper(marker.isDownbeat ? 0.15 : 0.05);
      ctx.fillRect(x, 0, 1, heightCss);
    }
    const endX = Math.round(localBeatToX(this.score.totalBeats));
    if (endX > -20 && endX < widthCss + 20) {
      ctx.fillStyle = paper(0.3);
      ctx.fillRect(endX, 0, 1, heightCss);
      ctx.fillRect(endX + 3, 0, 3, heightCss);
    }

    this.paintKeyboard(ctx, localBeatToX(0) - KEYBOARD_GAP_PX - KEYBOARD_WIDTH_PX, widthCss, rowHeight);

    // Notes: dimmed (ducked) parts first, then normal/soloed parts on top, so a soloed voice is
    // never partly covered by a dimmed pill at the same pitch/time. One fill() per part.
    const pillH = this.pillHeight(rowHeight);
    const lyricLane = new Map<number, [number, number][]>(); // per row: x-ranges already holding an under-note syllable
    const drawPart = (partId: string) => {
      const notes = this.notesByPart.get(partId);
      if (!notes || !notes.length) return;
      const dimmed = this.dimmedParts.has(partId);
      const color = this.partColor(partId);
      const pills: [number, number, number][] = [];
      const lyricNotes: { note: NoteEvent; x: number; y: number; index: number }[] = [];
      for (let index = 0; index < notes.length; index++) {
        const note = notes[index];
        const midi = note.midi + this.transpose;
        const x = localBeatToX(note.startBeat);
        const w = note.durationBeats * this.pixelsPerBeat;
        if (x + w < -10 || x > widthCss + 10) continue;
        const y = this.rowY(midi) - rowHeight + BAR_PAD_PX;
        pills.push([x + 1, y, Math.max(w - 3, 7)]);
        if (!dimmed && note.lyric) lyricNotes.push({ note, x, y, index });
      }
      ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
      for (const [px, py, pw] of pills) gelPill(ctx, px, py, pw, pillH, color);
      this.paintSlurThreads(ctx, partId, localBeatToX, widthCss, rowHeight, color, dimmed);
      ctx.globalAlpha = 1;

      // Syllables from cached bitmaps (re-shaping text per note per rebuild adds up fast), always in
      // the lane under their note -- skipped there if another voice already printed a syllable at
      // that spot (unison voices would print over each other).
      const fontPx = lyricFontPx(rowHeight);
      const score = LYRIC_STYLE === 'score';
      const textColor = score ? towardPaper(color, 0.62) : paper(0.8);
      for (let i = 0; i < lyricNotes.length; i++) {
        const { note, x, y, index } = lyricNotes[i];
        const bmp = this.getLyricBitmap(note.lyric!, textColor, fontPx, 550);
        const row = Math.round(y);
        const used = lyricLane.get(row) ?? [];
        const x1 = x + 2;
        const x2 = x1 + bmp.cssWidth;
        if (used.some(([a, b]) => x1 < b + 3 && a < x2 + 3)) continue;
        used.push([x1, x2]);
        lyricLane.set(row, used);
        const top = y + pillH + 1;
        ctx.drawImage(bmp.canvas, x1, top, bmp.cssWidth, bmp.cssHeight);
        if (!score) continue;
        const mid = top + bmp.cssHeight * 0.58;
        ctx.fillStyle = textColor;
        if (note.lyricJoin && lyricNotes[i + 1]) {
          // Hyphen, centred in the space before the word's next syllable.
          const gapStart = x2 + 3;
          const gapEnd = lyricNotes[i + 1].x - 1;
          const dash = Math.min(fontPx * 0.55, gapEnd - gapStart - 2);
          if (dash >= 3) ctx.fillRect(Math.round((gapStart + gapEnd - dash) / 2), Math.round(mid), dash, Math.max(1, fontPx * 0.09));
        } else if (note.lyricExtend) {
          // Extender: a line under the held syllable to the end of its last note.
          let last = note;
          for (let j = index + 1; j < notes.length && !notes[j].lyric; j++) last = notes[j];
          const end = localBeatToX(last.startBeat + last.durationBeats) - 4;
          const base = top + bmp.cssHeight - 2;
          if (end > x2 + 6) ctx.fillRect(x2 + 3, Math.round(base), end - x2 - 3, 1);
        }
      }
    };
    for (const part of this.score.parts) if (!this.hiddenParts.has(part.id) && this.dimmedParts.has(part.id)) drawPart(part.id);
    for (const part of this.score.parts) if (!this.hiddenParts.has(part.id) && !this.dimmedParts.has(part.id)) drawPart(part.id);

  }

  /**
   * Slurs as threads in the logo's style: a glowing line in a light tint of the voice's colour,
   * running from inside the tail of each slurred note into the head of the next, a small dot where
   * it lands on each note. On top of the notes (lyrics are drawn over it), since back-to-back notes
   * leave no room between them for a bow of any real shape.
   */
  private paintSlurThreads(ctx: CanvasRenderingContext2D, partId: string, localBeatToX: (beat: number) => number, widthCss: number, rowHeight: number, color: string, dimmed: boolean) {
    const slurs = this.slursByPart.get(partId);
    const notes = this.notesByPart.get(partId);
    if (!slurs?.length || !notes?.length) return;
    const capR = this.pillHeight(rowHeight) / 2;
    const path = new Path2D();
    const dots = new Path2D();
    const reach = (n: NoteEvent) => Math.min(Math.max(capR, n.durationBeats * this.pixelsPerBeat * 0.4), capR * 6);
    for (const slur of slurs) {
      if (localBeatToX(slur.endBeat) < -60 || localBeatToX(slur.startBeat) > widthCss + 60) continue;
      const chain = slurChain(notes, slur);
      for (let i = 0; i + 1 < chain.length; i++) {
        const a = chain[i];
        const b = chain[i + 1];
        const x0 = localBeatToX(a.startBeat + a.durationBeats) - 2 - reach(a);
        const x1 = localBeatToX(b.startBeat) + 1 + reach(b);
        const y0 = this.rowY(a.midi + this.transpose) - rowHeight + BAR_PAD_PX + capR;
        const y1 = this.rowY(b.midi + this.transpose) - rowHeight + BAR_PAD_PX + capR;
        const pull = (x1 - x0) * 0.5;
        path.moveTo(x0, y0);
        path.bezierCurveTo(x0 + pull, y0, x1 - pull, y1, x1, y1);
        for (const [x, y] of [[x0, y0], [x1, y1]]) {
          dots.moveTo(x + 2.4, y);
          dots.arc(x, y, 2.4, 0, Math.PI * 2);
        }
      }
    }
    const dim = dimmed ? DIMMED_ALPHA : 1;
    const light = towardPaper(color, 0.6);
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3 * dim;
    ctx.lineWidth = Math.max(5, capR);
    ctx.stroke(path);
    ctx.strokeStyle = light;
    ctx.globalAlpha = 0.95 * dim;
    ctx.lineWidth = 1.6;
    ctx.stroke(path);
    ctx.fillStyle = light;
    ctx.fill(dots);
  }

  /**
   * A small piano keyboard just before beat 0 (part of the scrolling content, so it scrolls away
   * with the piece's start): white keys with hairline joins, shorter black keys on top, C labels.
   * Uses the note rows' own geometry, so every key lines up with its pitch row.
   */
  private paintKeyboard(ctx: CanvasRenderingContext2D, x0: number, widthCss: number, rowHeight: number) {
    if (x0 + KEYBOARD_WIDTH_PX < 0 || x0 > widthCss) return;
    const rowTop = (midi: number) => this.rowY(midi) - rowHeight;
    const yTop = rowTop(this.maxMidi);
    const yBottom = rowTop(this.minMidi) + rowHeight;
    ctx.fillStyle = '#E8E0D2';
    ctx.fillRect(x0, yTop, KEYBOARD_WIDTH_PX, yBottom - yTop);
    ctx.fillStyle = 'rgba(13,12,22,0.3)';
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      const pc = ((midi % 12) + 12) % 12;
      if (BLACK_KEY_PITCH_CLASSES.has(pc)) continue;
      // Between two white keys with a black key in between, the join sits mid-way through the
      // black key's row; E-F and B-C have no black key, so their join is the row boundary.
      if (BLACK_KEY_PITCH_CLASSES.has((pc + 1) % 12)) ctx.fillRect(x0, Math.round(rowTop(midi + 1) + rowHeight / 2), KEYBOARD_WIDTH_PX, 1);
      else ctx.fillRect(x0, Math.round(rowTop(midi)), KEYBOARD_WIDTH_PX, 1);
    }
    ctx.fillStyle = '#17151F';
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      if (!BLACK_KEY_PITCH_CLASSES.has(((midi % 12) + 12) % 12)) continue;
      roundedRect(ctx, x0 - 3, rowTop(midi) + 1.5, KEYBOARD_WIDTH_PX * 0.62 + 3, rowHeight - 3, 3);
      ctx.fill();
    }
    ctx.font = `600 9px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(13,12,22,0.62)';
    ctx.textBaseline = 'middle';
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      if (((midi % 12) + 12) % 12 === 0) ctx.fillText(midiName(midi), x0 + KEYBOARD_WIDTH_PX - 19, rowTop(midi) + rowHeight / 2);
    }
    const shadow = ctx.createLinearGradient(x0 + KEYBOARD_WIDTH_PX, 0, x0 + KEYBOARD_WIDTH_PX + 10, 0);
    shadow.addColorStop(0, 'rgba(0,0,0,0.45)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(x0 + KEYBOARD_WIDTH_PX, yTop, 10, yBottom - yTop);
  }

  /** A syllable rendered once and cached, in the given colour, size and weight. */
  private getLyricBitmap(text: string, color: string, fontPx: number, weight: number): { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number } {
    const key = `${color}|${fontPx.toFixed(1)}|${weight}|${text}`;
    const cached = this.lyricBitmaps.get(key);
    if (cached) return cached;

    const font = `${weight} ${fontPx.toFixed(1)}px ${FONT_TEXT}`;
    const measurer = (this.lyricMeasureCtx ??= document.createElement('canvas').getContext('2d')!);
    measurer.font = font;
    const cssWidth = Math.ceil(measurer.measureText(text).width) + 2;
    const cssHeight = Math.ceil(fontPx * 1.2);

    const bmp = document.createElement('canvas');
    bmp.width = Math.max(1, Math.round(cssWidth * this.dpr));
    bmp.height = Math.max(1, Math.round(cssHeight * this.dpr));
    const bctx = bmp.getContext('2d')!;
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    bctx.font = font;
    bctx.fillStyle = color;
    bctx.textBaseline = 'alphabetic';
    bctx.fillText(text, 1, cssHeight - fontPx * 0.24);

    const entry = { canvas: bmp, cssWidth, cssHeight };
    this.lyricBitmaps.set(key, entry);
    return entry;
  }
}

/** Adds a rounded-rect subpath to the current path of `ctx` (for single shapes; see addRoundRectSubpath for batched ones). */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * The notes a slur binds, in order: every note of the voice from the slur's first to its last note.
 * Where a voice has two notes at once (a divisi), the one closest in pitch to the line so far is followed.
 */
function slurChain(notes: NoteEvent[], slur: SlurArc): NoteEvent[] {
  const eps = 1e-6;
  const chain: NoteEvent[] = [];
  for (const n of notes) {
    if (n.startBeat < slur.startBeat - eps) continue;
    if (n.startBeat > slur.endBeat + eps) break;
    const last = chain.at(-1);
    if (last && Math.abs(last.startBeat - n.startBeat) < eps) {
      const target = chain.length === 1 ? slur.startMidi : chain[chain.length - 2].midi;
      if (Math.abs(n.midi - target) < Math.abs(last.midi - target)) chain[chain.length - 1] = n;
      continue;
    }
    chain.push(n);
  }
  return chain;
}
