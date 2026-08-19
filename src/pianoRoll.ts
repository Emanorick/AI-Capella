import type { NoteEvent, Score, SlurArc } from './score';
import { getBeatMarkers } from './score';

export const BASE_PIXELS_PER_BEAT = 70;
const KEYBOARD_WIDTH = 34;
const PLAYHEAD_X_RATIO = 0.2;
const ROW_PADDING_SEMITONES = 2;
const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const DIMMED_ALPHA = 0.5;
const MAX_DPR = 2; // native Retina density; only caps 3x phones, doesn't soften a normal laptop screen
const BUFFER_SPAN_MULTIPLIER = 3; // scrolling-content buffer covers this many viewport-widths of beats
const BUFFER_REBUILD_MARGIN = 0.25; // rebuild once the playhead gets within this fraction of a viewport-width of the buffer's edge
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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
  private dpr = 1;
  private keyboardCache: HTMLCanvasElement | null = null;
  private keyboardCacheDirty = true;
  private lyricBitmaps = new Map<string, { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number }>();
  private lyricMeasureCtx: CanvasRenderingContext2D | null = null;
  private cssWidth = 0;
  private cssHeight = 0;

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

  setLoopRegion(region: LoopRegion | null) {
    this.loopRegion = region;
  }

  /** The beat a click-to-seek set as the next playback start point, shown independent of the playhead. */
  setSeekMarker(beat: number | null) {
    this.seekMarkerBeat = beat;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.keyboardCacheDirty = true;
    this.contentBufferDirty = true;
    this.lyricBitmaps.clear(); // cached bitmaps are baked at the old dpr
  }

  private rowY(midi: number, height: number): number {
    const range = this.maxMidi - this.minMidi;
    const t = (midi - this.minMidi) / range;
    return height - t * height;
  }

  private playheadX(width: number): number {
    const contentWidth = Math.max(1, width - KEYBOARD_WIDTH);
    return KEYBOARD_WIDTH + contentWidth * PLAYHEAD_X_RATIO;
  }

  /** Inverse of the render-time beat->x mapping: canvas-local x (from the cached canvas rect) -> beat. */
  xToBeat(x: number, displayBeat: number): number {
    return displayBeat + (x - this.playheadX(this.cssWidth)) / this.pixelsPerBeat;
  }

  render(currentBeat: number) {
    // Cached in resize() rather than read from getBoundingClientRect() here: this runs every
    // animation frame (and on every wheel/pointer event), and a layout read interleaved with the
    // position-display text write each frame forces the browser into synchronous layout thrashing.
    const width = this.cssWidth;
    const height = this.cssHeight;
    const ctx = this.ctx2d;
    const contentWidth = Math.max(1, width - KEYBOARD_WIDTH);
    const playheadX = this.playheadX(width);
    const rowHeight = height / (this.maxMidi - this.minMidi);

    const beatToX = (beat: number) => playheadX + (beat - currentBeat) * this.pixelsPerBeat;

    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYBOARD_WIDTH, 0, contentWidth, height);
    ctx.clip();

    // octave row shading (C rows): scroll-independent, cheap enough to draw directly each frame
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const y = this.rowY(midi, height) - rowHeight;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(KEYBOARD_WIDTH, y, contentWidth, rowHeight);
    }

    // loop region highlight
    // Thin vertical markers below are drawn as fillRect, not stroke(): a 1-2px straight line is
    // exactly representable as a filled rectangle, and stroked paths go through a much heavier
    // rasterization path than plain rect fills in most renderers -- this was the single biggest
    // per-frame cost during playback (a stroked 2-point playhead line, redrawn every frame).
    if (this.loopRegion) {
      const x1 = beatToX(this.loopRegion.start);
      const x2 = beatToX(this.loopRegion.end);
      ctx.fillStyle = 'rgba(79,168,255,0.14)';
      ctx.fillRect(x1, 0, x2 - x1, height);
      ctx.fillStyle = 'rgba(79,168,255,0.7)';
      ctx.fillRect(x1 - 0.75, 0, 1.5, height);
      ctx.fillRect(x2 - 0.75, 0, 1.5, height);
    }

    // seek marker: where the next Play will start from, independent of the current scroll position
    if (this.seekMarkerBeat != null) {
      const x = beatToX(this.seekMarkerBeat);
      if (x >= KEYBOARD_WIDTH - 6 && x <= width + 6) {
        ctx.fillStyle = 'rgba(255,209,102,0.85)';
        for (let dashY = 0; dashY < height; dashY += 7) {
          ctx.fillRect(x - 0.75, dashY, 1.5, 4);
        }
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 8);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Scrolling content (gridlines, notes, slurs): rebuilt only occasionally; every frame is a
    // single cheap blit of the pre-rendered buffer at the correct scroll offset. Only the slice
    // that actually lands in the visible content area is blitted -- the buffer itself spans
    // several viewport-widths so it doesn't need rebuilding every frame, but drawing all of that
    // every frame (most of which the clip would throw away anyway) defeats the point.
    this.ensureContentBuffer(currentBeat, contentWidth, height, rowHeight);
    if (this.contentBuffer) {
      const destX = playheadX - (currentBeat - this.contentBufferOriginBeat) * this.pixelsPerBeat;
      const bufferCssWidth = this.contentBufferBeatsSpan * this.pixelsPerBeat;
      const srcStartCss = Math.max(0, KEYBOARD_WIDTH - destX);
      const srcEndCss = Math.min(bufferCssWidth, width - destX);
      const srcWidthCss = srcEndCss - srcStartCss;
      if (srcWidthCss > 0) {
        ctx.drawImage(
          this.contentBuffer,
          srcStartCss * this.dpr,
          0,
          srcWidthCss * this.dpr,
          this.contentBuffer.height,
          destX + srcStartCss,
          0,
          srcWidthCss,
          height,
        );
      }
    }

    // playhead
    ctx.fillStyle = '#ff3b57';
    ctx.fillRect(playheadX - 1, 0, 2, height);

    ctx.restore();

    if (this.keyboardCacheDirty || !this.keyboardCache) {
      this.rebuildKeyboardCache(height, rowHeight);
      this.keyboardCacheDirty = false;
    }
    // Blit the cached keyboard bitmap 1:1 in device pixels: the gutter never changes except on
    // resize, so re-drawing 20-40 key rects and labels every frame was pure waste.
    if (this.keyboardCache) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.keyboardCache, 0, 0);
      ctx.restore();
    }
  }

  private ensureContentBuffer(currentBeat: number, contentWidth: number, height: number, rowHeight: number) {
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

    const bufCssWidth = Math.max(1, beatsSpan * this.pixelsPerBeat);
    const buf = this.contentBuffer ?? document.createElement('canvas');
    buf.width = Math.max(1, Math.round(bufCssWidth * this.dpr));
    buf.height = Math.max(1, Math.round(height * this.dpr));
    const bctx = buf.getContext('2d');
    if (!bctx) return;
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintContent(bctx, originBeat, bufCssWidth, height, rowHeight);
    this.contentBuffer = buf;
    this.contentBufferDirty = false;
  }

  /** Paints gridlines, notes, and slurs into a buffer strip using buffer-local (not screen) x coordinates. */
  private paintContent(ctx: CanvasRenderingContext2D, originBeat: number, widthCss: number, heightCss: number, rowHeight: number) {
    const localBeatToX = (beat: number) => (beat - originBeat) * this.pixelsPerBeat;
    ctx.clearRect(0, 0, widthCss, heightCss);

    // beat / measure gridlines, batched into one stroke() per tier instead of one per line
    let thinPath: Path2D | null = null;
    let thickPath: Path2D | null = null;
    const measureLabels: { x: number; number: number }[] = [];
    for (const marker of this.beatMarkers) {
      const x = localBeatToX(marker.beat);
      if (x < -20 || x > widthCss + 20) continue;
      const path = marker.isDownbeat ? (thickPath ??= new Path2D()) : (thinPath ??= new Path2D());
      path.moveTo(x, 0);
      path.lineTo(x, heightCss);
      if (marker.isDownbeat) measureLabels.push({ x, number: marker.measureNumber });
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
    if (measureLabels.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = 'bold 11px system-ui, sans-serif';
      for (const label of measureLabels) ctx.fillText(String(label.number), label.x + 4, 14);
    }

    // notes: dimmed (non-soloed) parts first, then normal/soloed parts on top so a soloed voice's
    // color is never partially covered by an overlapping dimmed bar at the same pitch/time.
    // Batched into one fill() per part rather than per note.
    const barH = Math.max(rowHeight - 2, 4);
    const barPad = (rowHeight - barH) / 2;
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
        const y = this.rowY(midi, heightCss) - rowHeight;
        addRoundRectSubpath(path, x, y + barPad, Math.max(w - 2, 3), barH, 3);
        if (!dimmed && note.lyric && w > 14) lyricNotes.push(note);
      }
      ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
      ctx.fillStyle = this.partColor(partId);
      ctx.fill(path);
      ctx.globalAlpha = 1;

      // Draw each syllable from a cached bitmap instead of fillText: re-shaping/rasterizing text
      // for every note on every buffer rebuild adds up fast.
      for (const note of lyricNotes) {
        const midi = note.midi + this.transpose;
        const x = localBeatToX(note.startBeat);
        const w = note.durationBeats * this.pixelsPerBeat;
        const y = this.rowY(midi, heightCss) - rowHeight;
        const bmp = this.getLyricBitmap(note.lyric!);
        const baselineY = y + rowHeight + 11;
        ctx.drawImage(bmp.canvas, x + w / 2 - bmp.cssWidth / 2, baselineY - (bmp.cssHeight - 3), bmp.cssWidth, bmp.cssHeight);
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
        const y1 = this.rowY(startMidi, heightCss) - rowHeight + barPad;
        const y2 = this.rowY(endMidi, heightCss) - rowHeight + barPad;
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

  private rebuildKeyboardCache(heightCss: number, rowHeight: number) {
    const kc = this.keyboardCache ?? document.createElement('canvas');
    kc.width = Math.max(1, Math.round(KEYBOARD_WIDTH * this.dpr));
    kc.height = Math.max(1, Math.round(heightCss * this.dpr));
    const kctx = kc.getContext('2d');
    if (!kctx) return;
    kctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawKeyboard(kctx, heightCss, rowHeight);
    this.keyboardCache = kc;
  }

  /** Fixed left-side piano keyboard; rendered once into a cached bitmap by rebuildKeyboardCache. */
  private drawKeyboard(ctx: CanvasRenderingContext2D, height: number, rowHeight: number) {
    ctx.fillStyle = '#1a1c24';
    ctx.fillRect(0, 0, KEYBOARD_WIDTH, height);

    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const isBlack = BLACK_KEY_PITCH_CLASSES.has(pc);
      const y = this.rowY(midi, height) - rowHeight;
      const keyWidth = isBlack ? KEYBOARD_WIDTH * 0.62 : KEYBOARD_WIDTH;
      ctx.fillStyle = isBlack ? '#0c0d12' : '#dcdde3';
      ctx.fillRect(0, y, keyWidth, Math.max(rowHeight - 1, 1));

      if (pc === 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillText(midiName(midi), 2, y + rowHeight - 2);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(KEYBOARD_WIDTH, 0);
    ctx.lineTo(KEYBOARD_WIDTH, height);
    ctx.stroke();
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
