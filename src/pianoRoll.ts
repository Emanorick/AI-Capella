import type { Score } from './score';
import { getBeatMarkers } from './score';

const PIXELS_PER_BEAT = 70;
const PLAYHEAD_X_RATIO = 0.22;
const ROW_PADDING_SEMITONES = 2;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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
  private visibleParts: Set<string>;
  private transpose = 0;
  private beatMarkers: ReturnType<typeof getBeatMarkers>;

  constructor(canvas: HTMLCanvasElement, score: Score, partColor: (partId: string) => string) {
    this.canvas = canvas;
    this.score = score;
    this.partColor = partColor;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx2d = ctx;
    this.visibleParts = new Set(score.parts.map((p) => p.id));
    this.beatMarkers = getBeatMarkers(score);

    const pitches = score.notes.map((n) => n.midi);
    this.minMidi = (pitches.length ? Math.min(...pitches) : 60) - ROW_PADDING_SEMITONES;
    this.maxMidi = (pitches.length ? Math.max(...pitches) : 72) + ROW_PADDING_SEMITONES;
  }

  setVisibleParts(ids: Set<string>) {
    this.visibleParts = ids;
  }

  setTranspose(semitones: number) {
    this.transpose = semitones;
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
    const playheadX = width * PLAYHEAD_X_RATIO;
    const rowHeight = height / (this.maxMidi - this.minMidi);

    const beatToX = (beat: number) => playheadX + (beat - currentBeat) * PIXELS_PER_BEAT;

    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, width, height);

    // octave row shading (C rows) for a visual anchor
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const y = this.rowY(midi, height) - rowHeight;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, y, width, rowHeight);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(midiName(midi), 4, y + rowHeight - 2);
    }

    // beat / measure gridlines
    for (const marker of this.beatMarkers) {
      const x = beatToX(marker.beat);
      if (x < -20 || x > width + 20) continue;
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
      if (!this.visibleParts.has(note.partId)) continue;
      const midi = note.midi + this.transpose;
      const x = beatToX(note.startBeat);
      const w = note.durationBeats * PIXELS_PER_BEAT;
      if (x + w < -10 || x > width + 10) continue;
      const y = this.rowY(midi, height) - rowHeight;

      const color = this.partColor(note.partId);
      ctx.fillStyle = color;
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
    }

    // playhead
    ctx.strokeStyle = '#ff3b57';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
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
