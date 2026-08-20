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
const BUFFER_REBUILD_MARGIN = 0.25; // rebuild once the playhead gets within this fraction of a viewport-width of the buffer's edge
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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
  private seekMarkerBeat: number | null = null;
  private beatMarkers: ReturnType<typeof getBeatMarkers>;
  private notesByPart: Map<string, NoteEvent[]>;
  private slursByPart: Map<string, SlurArc[]>;
  private tiesByPart: Map<string, SlurArc[]>;
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
    this.tiesByPart = new Map();
    for (const tie of score.ties) {
      const list = this.tiesByPart.get(tie.partId);
      if (list) list.push(tie);
      else this.tiesByPart.set(tie.partId, [tie]);
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

  /** The beat a click-to-seek set as the next playback start point, shown independent of the playhead. */
  setSeekMarker(beat: number | null) {
    this.seekMarkerBeat = beat;
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

  render(currentBeat: number) {
    // Cached in resize() rather than read from getBoundingClientRect() here: this runs every
    // animation frame (and on every wheel/pointer event), and a layout read interleaved with the
    // position-display text write each frame forces the browser into synchronous layout thrashing.
    const width = this.cssWidth;
    const height = this.cssHeight;
    const contentAreaHeight = this.contentAreaHeight();
    const ctx = this.ctx2d;
    const playheadX = this.playheadX(width);
    const rowHeight = this.rowHeightPx;
    const contentH = this.contentHeightPx();

    const beatToX = (beat: number) => playheadX + (beat - currentBeat) * this.pixelsPerBeat;

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
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    for (const marker of this.beatMarkers) {
      if (!marker.isDownbeat) continue;
      const x = beatToX(marker.beat);
      if (x < -20 || x > width + 20) continue;
      ctx.fillText(String(marker.measureNumber), x + 4, 15);
    }
    if (this.seekMarkerBeat != null) {
      const x = beatToX(this.seekMarkerBeat);
      if (x >= -6 && x <= width + 6) {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.moveTo(x - 5, 2);
        ctx.lineTo(x + 5, 2);
        ctx.lineTo(x, 10);
        ctx.closePath();
        ctx.fill();
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

    // seek marker: where the next Play will start from, independent of the current scroll position
    if (this.seekMarkerBeat != null) {
      const x = beatToX(this.seekMarkerBeat);
      if (x >= -6 && x <= width + 6) {
        ctx.fillStyle = 'rgba(255,209,102,0.85)';
        for (let dashY = 0; dashY < contentAreaHeight; dashY += 7) {
          ctx.fillRect(x - 0.75, dashY, 1.5, 4);
        }
      }
    }

    // Scrolling content (gridlines, notes, slurs): rebuilt only occasionally; every frame is a
    // single cheap blit of the pre-rendered buffer at the correct scroll offset. Only the slice
    // that actually lands in the visible content area is blitted -- the buffer itself spans
    // several viewport-widths so it doesn't need rebuilding every frame, but drawing all of that
    // every frame (most of which the clip would throw away anyway) defeats the point.
    this.ensureContentBuffer(currentBeat, width, rowHeight);
    if (this.contentBuffer) {
      const destX = playheadX - (currentBeat - this.contentBufferOriginBeat) * this.pixelsPerBeat;
      const bufferCssWidth = this.contentBufferBeatsSpan * this.pixelsPerBeat;
      const srcStartCss = Math.max(0, -destX);
      const srcEndCss = Math.min(bufferCssWidth, width - destX);
      const srcWidthCss = srcEndCss - srcStartCss;
      const srcHeightCss = Math.min(contentAreaHeight, contentH - this.scrollY);
      if (srcWidthCss > 0 && srcHeightCss > 0) {
        ctx.drawImage(
          this.contentBuffer,
          srcStartCss * this.dpr,
          this.scrollY * this.dpr,
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
      const x = beatToX(this.previewNote.startBeat);
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

    // playhead: drawn last, full height (ruler + content), unclipped/untranslated
    ctx.fillStyle = '#ff3b57';
    ctx.fillRect(playheadX - 1, 0, 2, height);
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

    const halfSpan = (visibleBeatsSpan * BUFFER_SPAN_MULTIPLIER) / 2;
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

    // ties (same-pitch notes sustained across a boundary, most commonly a barline): drawn as a
    // straight line rather than an arched slur, bridging the gap between the two note bars.
    for (const part of this.score.parts) {
      if (this.hiddenParts.has(part.id)) continue;
      const ties = this.tiesByPart.get(part.id);
      if (!ties || !ties.length) continue;
      const path = new Path2D();
      let any = false;
      for (const tie of ties) {
        const midi = tie.startMidi + this.transpose;
        const x1 = localBeatToX(tie.startBeat);
        const x2 = localBeatToX(tie.endBeat);
        if (x2 < -10 || x1 > widthCss + 10) continue;
        const y = this.rowY(midi) - rowHeight + barPad + barH / 2;
        path.moveTo(x1, y);
        path.lineTo(x2, y);
        any = true;
      }
      if (!any) continue;
      ctx.globalAlpha = this.dimmedParts.has(part.id) ? DIMMED_ALPHA : 0.9;
      ctx.strokeStyle = this.partColor(part.id);
      ctx.lineWidth = 2;
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
