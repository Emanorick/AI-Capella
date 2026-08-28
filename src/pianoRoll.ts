import type { NoteEvent, Score, SlurArc } from './score';
import { getBeatMarkers } from './score';

export const BASE_PIXELS_PER_BEAT = 70;
// The only place a click/drag sets the playback start point or defines a loop region -- clicks in
// the scrollable note area below are just for previewing a note's pitch, and can't accidentally
// jump playback (a real problem before: any click during scrolling or note-preview would seek).
export const RULER_HEIGHT_PX = 22;
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
const MIN_ROW_HEIGHT_PX = 30;
const BAR_PAD_PX = 2; // gap from the top of the row to the note bar
const LYRIC_AREA_PX = 15; // space reserved below the bar for its lyric, within the same row
const DIMMED_ALPHA = 0.5;
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
const KEYBOARD_WIDTH_PX = 40;
const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]); // C#, D#, F#, G#, A#

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
    this.slursByPart = new Map();
    for (const slur of score.slurs) {
      const list = this.slursByPart.get(slur.partId);
      if (list) list.push(slur);
      else this.slursByPart.set(slur.partId, [slur]);
    }
    const pitches = score.notes.map((n) => n.midi);
    this.minMidi = (pitches.length ? Math.min(...pitches) : 60) - ROW_PADDING_SEMITONES;
    this.maxMidi = (pitches.length ? Math.max(...pitches) : 72) + ROW_PADDING_SEMITONES;
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
    this.scrollY = clamp(this.scrollY + dy, 0, this.maxScrollY());
  }

  setLoopRegion(region: LoopRegion | null) {
    this.loopRegion = region;
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
    const contentY = (y - RULER_HEIGHT_PX) + this.scrollY;
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
    const beat = this.xToBeat(x, displayBeat);
    if (beat < -keyboardWidthBeats || beat >= 0) return null;
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
    const rowHeight = this.rowHeightPx;
    const contentH = this.contentHeightPx();

    // beatToX is anchored to displayBeat (the view's own reference point, at the fixed anchorX
    // fraction of the width) -- everything scrolls relative to that. playheadBeat is a separate,
    // independent beat: where the piece actually is / will resume from. The two coincide (so the
    // red line sits right at anchorX) exactly when the view hasn't been panned away from it.
    const beatToX = (beat: number) => anchorX + (beat - displayBeat) * this.pixelsPerBeat;

    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, width, height);

    // Ruler: the only clickable strip for setting the playback start point or a loop region (see
    // RULER_HEIGHT_PX). Fixed at the top, never scrolls vertically, but shares the same horizontal
    // beat->x mapping as the note content below so measure numbers/markers line up with their bars.
    ctx.fillStyle = '#181b26';
    ctx.fillRect(0, 0, width, RULER_HEIGHT_PX);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT_PX - 0.5);
    ctx.lineTo(width, RULER_HEIGHT_PX - 0.5);
    ctx.stroke();
    if (this.loopRegion) {
      const x1 = beatToX(this.loopRegion.start);
      const x2 = beatToX(this.loopRegion.end);
      ctx.fillStyle = 'rgba(79,168,255,0.35)';
      ctx.fillRect(x1, 0, x2 - x1, RULER_HEIGHT_PX);
    }
    // Measure-number labels themselves are pre-rendered into rulerBuffer (see ensureContentBuffer)
    // and just blitted here, same as the note content below -- see snapToDevicePx's doc comment.
    this.ensureContentBuffer(displayBeat, width, rowHeight);
    if (this.rulerBuffer) {
      const destX = this.snapToDevicePx(anchorX - (displayBeat - this.contentBufferOriginBeat) * this.pixelsPerBeat);
      const bufferCssWidth = this.contentBufferBeatsSpan * this.pixelsPerBeat;
      const srcStartCss = Math.max(0, -destX);
      const srcEndCss = Math.min(bufferCssWidth, width - destX);
      const srcWidthCss = srcEndCss - srcStartCss;
      if (srcWidthCss > 0) {
        ctx.drawImage(
          this.rulerBuffer,
          srcStartCss * this.dpr,
          0,
          srcWidthCss * this.dpr,
          RULER_HEIGHT_PX * this.dpr,
          destX + srcStartCss,
          0,
          srcWidthCss,
          RULER_HEIGHT_PX,
        );
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT_PX, width, contentAreaHeight);
    ctx.clip();
    ctx.translate(0, RULER_HEIGHT_PX);

    // loop region highlight
    // Thin vertical markers below are drawn as fillRect, not stroke(): a 1-2px straight line is
    // exactly representable as a filled rectangle, and stroked paths go through a much heavier
    // rasterization path than plain rect fills in most renderers -- this was the single biggest
    // per-frame cost during playback (a stroked 2-point playhead line, redrawn every frame).
    if (this.loopRegion) {
      const x1 = beatToX(this.loopRegion.start);
      const x2 = beatToX(this.loopRegion.end);
      ctx.fillStyle = 'rgba(79,168,255,0.14)';
      ctx.fillRect(x1, 0, x2 - x1, contentAreaHeight);
      ctx.fillStyle = 'rgba(79,168,255,0.7)';
      ctx.fillRect(x1 - 0.75, 0, 1.5, contentAreaHeight);
      ctx.fillRect(x2 - 0.75, 0, 1.5, contentAreaHeight);
    }

    // Scrolling content (gridlines, notes, slurs): rebuilt only occasionally (already ensured
    // above, alongside the ruler buffer); every frame is a single cheap blit of the pre-rendered
    // buffer at the correct scroll offset. Only the slice that actually lands in the visible
    // content area is blitted -- the buffer itself spans several viewport-widths so it doesn't
    // need rebuilding every frame, but drawing all of that every frame (most of which the clip
    // would throw away anyway) defeats the point.
    // Self-correcting: the incremental rebuild-margin check above assumes steady, smooth beat
    // progression, but a dropped frame, a tab coming back from the background, or anything else
    // that lets the beat jump further than expected in one tick can still leave the buffer not
    // actually covering the full visible width. Rather than trust that assumption blindly (which
    // showed up in the field as a black, unpainted strip next to the content), verify the blit
    // will really cover [0, width] and force one immediate rebuild if it won't -- this makes "the
    // buffer covers what's on screen" an invariant checked every frame instead of a hope.
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
      const scrollYSnapped = this.snapToDevicePx(this.scrollY);
      const bufferCssWidth = this.contentBufferBeatsSpan * this.pixelsPerBeat;
      const srcStartCss = Math.max(0, -destX);
      const srcEndCss = Math.min(bufferCssWidth, width - destX);
      const srcWidthCss = srcEndCss - srcStartCss;
      const srcHeightCss = Math.min(contentAreaHeight, contentH - scrollYSnapped);
      if (srcWidthCss > 0 && srcHeightCss > 0) {
        ctx.drawImage(
          this.contentBuffer,
          srcStartCss * this.dpr,
          scrollYSnapped * this.dpr,
          srcWidthCss * this.dpr,
          srcHeightCss * this.dpr,
          destX + srcStartCss,
          0,
          srcWidthCss,
          srcHeightCss,
        );
      }
    }

    // preview note label: set by a click on a note (see hitTestNote); shows its pitch name at the
    // start of that note's bar. Drawn fresh each frame (not baked into the content buffer) since
    // it's transient UI state, not part of the score.
    if (this.previewNote) {
      const x = this.snapToDevicePx(beatToX(this.previewNote.startBeat));
      const y = this.rowY(this.previewNote.midi) - rowHeight - this.scrollY;
      if (x >= -60 && x <= width + 10 && y >= -20 && y <= contentAreaHeight) {
        const label = midiName(this.previewNote.midi);
        ctx.font = 'bold 12px system-ui, sans-serif';
        const textWidth = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(10,11,16,0.85)';
        ctx.fillRect(x, y - 18, textWidth + 10, 16);
        ctx.fillStyle = '#ffd166';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + 5, y - 10);
      }
    }

    ctx.restore();

    // playhead: always the actual current-or-paused position (playheadBeat), not necessarily
    // displayBeat -- panning the view away from it (e.g. browsing the score while paused) is
    // allowed, and this keeps genuinely tracking where the piece is/will resume from as you do,
    // rather than silently relabeling whatever's under the view's fixed anchor point. So its x is
    // recomputed from playheadBeat like anything else in the content, and it can end up off-screen
    // if you've panned far enough away -- correct, since that position isn't visible right now.
    // Drawn last, full height (ruler + content), unclipped/untranslated.
    const playheadXPos = this.snapToDevicePx(beatToX(playheadBeat));
    if (playheadXPos >= -2 && playheadXPos <= width + 2) {
      ctx.fillStyle = '#ff3b57';
      ctx.fillRect(playheadXPos - 1, 0, 2, height);
    }
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
      rctx.fillStyle = 'rgba(255,255,255,0.6)';
      rctx.font = 'bold 10px system-ui, sans-serif';
      for (const marker of this.beatMarkers) {
        if (!marker.isDownbeat) continue;
        const x = (marker.beat - originBeat) * this.pixelsPerBeat;
        if (x < -20 || x > bufCssWidth + 20) continue;
        rctx.fillText(String(marker.measureNumber), x + 4, 15);
      }
      this.rulerBuffer = rulerBuf;
    }

    this.contentBufferDirty = false;
  }

  /** Paints gridlines, notes, and slurs into a buffer strip spanning the full pitch range, using buffer-local (not screen) coordinates. */
  private paintContent(ctx: CanvasRenderingContext2D, originBeat: number, widthCss: number, heightCss: number, rowHeight: number) {
    const localBeatToX = (beat: number) => (beat - originBeat) * this.pixelsPerBeat;
    ctx.clearRect(0, 0, widthCss, heightCss);

    // octave row shading (C rows)
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const y = this.rowY(midi) - rowHeight;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y, widthCss, rowHeight);
    }

    // Piano keyboard strip, just before beat 0 -- see KEYBOARD_WIDTH_PX's comment. Uses the exact
    // same rowY/rowHeight as note rows, so it lines up with the pitch gridlines. widthCss-anchored
    // pixel width converted to beats at the current pixelsPerBeat, so it renders as a consistent
    // physical size regardless of zoom (recomputed on every rebuild, which zoom changes trigger).
    const keyboardWidthBeats = KEYBOARD_WIDTH_PX / this.pixelsPerBeat;
    const keyboardStartX = localBeatToX(-keyboardWidthBeats);
    const keyboardEndX = localBeatToX(0);
    if (keyboardEndX > 0 && keyboardStartX < widthCss) {
      for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
        const isBlack = BLACK_KEY_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
        ctx.fillStyle = isBlack ? '#1a1a1a' : '#e8e8e8';
        ctx.fillRect(keyboardStartX, this.rowY(midi) - rowHeight, keyboardEndX - keyboardStartX, rowHeight);
      }
    }

    // semitone gridlines: a barely-visible line at every pitch row boundary, just enough to give
    // a sense of interval distance at a glance without competing with the beat/measure gridlines.
    const semitonePath = new Path2D();
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      const y = this.rowY(midi);
      semitonePath.moveTo(0, y);
      semitonePath.lineTo(widthCss, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.stroke(semitonePath);

    // beat / measure gridlines, batched into one stroke() per tier instead of one per line. Measure
    // numbers are drawn in the fixed ruler strip instead (see render()), not here: this buffer
    // scrolls with pitch, so a label baked in here would scroll away with whatever voice happened
    // to be on top when the buffer was last rebuilt.
    let thinPath: Path2D | null = null;
    let thickPath: Path2D | null = null;
    for (const marker of this.beatMarkers) {
      const x = localBeatToX(marker.beat);
      if (x < -20 || x > widthCss + 20) continue;
      const path = marker.isDownbeat ? (thickPath ??= new Path2D()) : (thinPath ??= new Path2D());
      path.moveTo(x, 0);
      path.lineTo(x, heightCss);
    }
    if (thinPath) {
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.stroke(thinPath);
    }
    if (thickPath) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke(thickPath);
    }

    // notes: dimmed (non-soloed) parts first, then normal/soloed parts on top so a soloed voice's
    // color is never partially covered by an overlapping dimmed bar at the same pitch/time.
    // Batched into one fill() per part rather than per note.
    // The bar fills the row down to where the lyric area starts: when rows stretch to fill a tall
    // viewport (few enough distinct pitches that the whole range fits), the bar grows with them
    // instead of staying a thin sliver in a comparatively tall row.
    const barPad = BAR_PAD_PX;
    const barH = Math.max(4, rowHeight - barPad * 2 - LYRIC_AREA_PX);
    const drawPart = (partId: string) => {
      const notes = this.notesByPart.get(partId);
      if (!notes || !notes.length) return;
      const dimmed = this.dimmedParts.has(partId);
      const path = new Path2D();
      const lyricNotes: NoteEvent[] = [];
      for (const note of notes) {
        const midi = note.midi + this.transpose;
        const x = localBeatToX(note.startBeat);
        const w = note.durationBeats * this.pixelsPerBeat;
        if (x + w < -10 || x > widthCss + 10) continue;
        const y = this.rowY(midi) - rowHeight;
        addRoundRectSubpath(path, x, y + barPad, Math.max(w - 2, 3), barH, 3);
        if (!dimmed && note.lyric && w > 14) lyricNotes.push(note);
      }
      ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
      ctx.fillStyle = this.partColor(partId);
      ctx.fill(path);
      ctx.globalAlpha = 1;

      // Draw each syllable from a cached bitmap instead of fillText: re-shaping/rasterizing text
      // for every note on every buffer rebuild adds up fast. Drawn below the bar, but still fully
      // inside this note's own row (the row is sized to fit bar + text) so it never reaches into
      // the neighboring pitch row's territory.
      for (const note of lyricNotes) {
        const midi = note.midi + this.transpose;
        const x = localBeatToX(note.startBeat);
        const w = note.durationBeats * this.pixelsPerBeat;
        const y = this.rowY(midi) - rowHeight;
        const bmp = this.getLyricBitmap(note.lyric!);
        const textY = y + barPad + barH + 1;
        ctx.drawImage(bmp.canvas, x + w / 2 - bmp.cssWidth / 2, textY, bmp.cssWidth, bmp.cssHeight);
      }
    };
    for (const part of this.score.parts) if (!this.hiddenParts.has(part.id) && this.dimmedParts.has(part.id)) drawPart(part.id);
    for (const part of this.score.parts) if (!this.hiddenParts.has(part.id) && !this.dimmedParts.has(part.id)) drawPart(part.id);

    // slurs, drawn in each voice's color above its notes, batched into one stroke() per part
    for (const part of this.score.parts) {
      if (this.hiddenParts.has(part.id)) continue;
      const slurs = this.slursByPart.get(part.id);
      if (!slurs || !slurs.length) continue;
      const path = new Path2D();
      let any = false;
      for (const slur of slurs) {
        const startMidi = slur.startMidi + this.transpose;
        const endMidi = slur.endMidi + this.transpose;
        const x1 = localBeatToX(slur.startBeat) + 2;
        const x2 = localBeatToX(slur.endBeat) + 2;
        if (x2 < -10 || x1 > widthCss + 10) continue;
        const y1 = this.rowY(startMidi) - rowHeight + barPad;
        const y2 = this.rowY(endMidi) - rowHeight + barPad;
        const arcLift = Math.min(18, 6 + Math.abs(x2 - x1) * 0.08);
        const midX = (x1 + x2) / 2;
        const topY = Math.min(y1, y2) - arcLift;
        path.moveTo(x1, y1);
        path.quadraticCurveTo(midX, topY, x2, y2);
        any = true;
      }
      if (!any) continue;
      ctx.globalAlpha = this.dimmedParts.has(part.id) ? DIMMED_ALPHA : 0.9;
      ctx.strokeStyle = this.partColor(part.id);
      ctx.lineWidth = 1.5;
      ctx.stroke(path);
      ctx.globalAlpha = 1;
    }

  }

  private getLyricBitmap(text: string): { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number } {
    const cached = this.lyricBitmaps.get(text);
    if (cached) return cached;

    const font = '11px system-ui, sans-serif';
    const measurer = (this.lyricMeasureCtx ??= document.createElement('canvas').getContext('2d')!);
    measurer.font = font;
    const cssWidth = Math.ceil(measurer.measureText(text).width) + 2;
    const cssHeight = 13;

    const bmp = document.createElement('canvas');
    bmp.width = Math.max(1, Math.round(cssWidth * this.dpr));
    bmp.height = Math.max(1, Math.round(cssHeight * this.dpr));
    const bctx = bmp.getContext('2d')!;
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    bctx.font = font;
    bctx.fillStyle = 'rgba(255,255,255,0.92)';
    bctx.textAlign = 'center';
    bctx.textBaseline = 'alphabetic';
    bctx.fillText(text, cssWidth / 2, cssHeight - 3);

    const entry = { canvas: bmp, cssWidth, cssHeight };
    this.lyricBitmaps.set(text, entry);
    return entry;
  }

}

function addRoundRectSubpath(path: Path2D, x: number, y: number, w: number, h: number, r: number) {
  path.moveTo(x + r, y);
  path.arcTo(x + w, y, x + w, y + h, r);
  path.arcTo(x + w, y + h, x, y + h, r);
  path.arcTo(x, y + h, x, y, r);
  path.arcTo(x, y, x + w, y, r);
  path.closePath();
}
