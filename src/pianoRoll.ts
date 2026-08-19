import type { Score } from './score';
import { getBeatMarkers } from './score';

export const BASE_PIXELS_PER_BEAT = 70;
const KEYBOARD_WIDTH = 34;
const PLAYHEAD_X_RATIO = 0.2;
const ROW_PADDING_SEMITONES = 2;
const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const DIMMED_ALPHA = 0.5;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export type PartMixState = 'normal' | 'muted' | 'solo';

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
  private beatMarkers: ReturnType<typeof getBeatMarkers>;

  constructor(canvas: HTMLCanvasElement, score: Score, partColor: (partId: string) => string) {
    this.canvas = canvas;
    this.score = score;
    this.partColor = partColor;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx2d = ctx;
    this.beatMarkers = getBeatMarkers(score);

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
  }

  setTranspose(semitones: number) {
    this.transpose = semitones;
  }

  setZoom(factor: number) {
    this.pixelsPerBeat = BASE_PIXELS_PER_BEAT * factor;
  }

  getPixelsPerBeat() {
    return this.pixelsPerBeat;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private rowY(midi: number, height: number): number {
    const range = this.maxMidi - this.minMidi;
    const t = (midi - this.minMidi) / range;
    return height - t * height;
  }

  render(currentBeat: number) {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ctx = this.ctx2d;
    const contentWidth = Math.max(1, width - KEYBOARD_WIDTH);
    const playheadX = KEYBOARD_WIDTH + contentWidth * PLAYHEAD_X_RATIO;
    const rowHeight = height / (this.maxMidi - this.minMidi);

    const beatToX = (beat: number) => playheadX + (beat - currentBeat) * this.pixelsPerBeat;

    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYBOARD_WIDTH, 0, contentWidth, height);
    ctx.clip();

    // octave row shading (C rows) for a visual anchor
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const y = this.rowY(midi, height) - rowHeight;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(KEYBOARD_WIDTH, y, contentWidth, rowHeight);
    }

    // beat / measure gridlines
    for (const marker of this.beatMarkers) {
      const x = beatToX(marker.beat);
      if (x < KEYBOARD_WIDTH - 20 || x > width + 20) continue;
      ctx.strokeStyle = marker.isDownbeat ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = marker.isDownbeat ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      if (marker.isDownbeat) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillText(String(marker.measureNumber), x + 4, 14);
      }
    }

    // notes
    for (const note of this.score.notes) {
      if (this.hiddenParts.has(note.partId)) continue;
      const midi = note.midi + this.transpose;
      const x = beatToX(note.startBeat);
      const w = note.durationBeats * this.pixelsPerBeat;
      if (x + w < KEYBOARD_WIDTH - 10 || x > width + 10) continue;
      const y = this.rowY(midi, height) - rowHeight;

      const dimmed = this.dimmedParts.has(note.partId);
      ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;

      ctx.fillStyle = this.partColor(note.partId);
      const barH = Math.max(rowHeight - 2, 4);
      const barPad = (rowHeight - barH) / 2;
      roundRect(ctx, x, y + barPad, Math.max(w - 2, 3), barH, 3);
      ctx.fill();

      if (note.lyric && w > 14) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(note.lyric, x + w / 2, y + rowHeight + 11);
        ctx.textAlign = 'left';
      }

      ctx.globalAlpha = 1;
    }

    // playhead
    ctx.strokeStyle = '#ff3b57';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.restore();

    this.drawKeyboard(ctx, height, rowHeight);
  }

  /** Fixed left-side piano keyboard, always on screen regardless of horizontal scroll/zoom. */
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
