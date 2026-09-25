import type { Score } from './score';
import type { LoopRegion } from './pianoRoll';
import { PAPER, paper, withAlpha } from './theme';

const PAD_X = 16;

/**
 * The whole piece in one strip: every voice as a thin line at its pitch, the loop band, the part
 * already played dimmed, and the playhead. The notes layer is pre-rendered once per size/mix
 * change; each frame only blits it and draws the playhead, so this adds next to nothing to the
 * playback frame cost.
 */
export class OverviewStrip {
  private canvas: HTMLCanvasElement;
  private score: Score;
  private partColor: (partId: string) => string;
  private notesLayer: HTMLCanvasElement | null = null;
  private dirty = true;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private dimmed = new Set<string>();
  private hidden = new Set<string>();
  private loop: LoopRegion | null = null;
  private lo = 48;
  private hi = 72;

  constructor(canvas: HTMLCanvasElement, score: Score, partColor: (partId: string) => string) {
    this.canvas = canvas;
    this.score = score;
    this.partColor = partColor;
    if (score.notes.length) {
      this.lo = Math.min(...score.notes.map((n) => n.midi)) - 1;
      this.hi = Math.max(...score.notes.map((n) => n.midi)) + 1;
    }
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(this.cssWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.cssHeight * this.dpr));
    this.dirty = true;
  }

  setMix(dimmed: Set<string>, hidden: Set<string>) {
    this.dimmed = dimmed;
    this.hidden = hidden;
    this.dirty = true;
  }

  setLoopRegion(loop: LoopRegion | null) {
    this.loop = loop;
  }

  beatToX(beat: number): number {
    return PAD_X + (beat / Math.max(1e-6, this.score.totalBeats)) * (this.cssWidth - PAD_X * 2);
  }

  xToBeat(x: number): number {
    const frac = (x - PAD_X) / Math.max(1, this.cssWidth - PAD_X * 2);
    return Math.max(0, Math.min(this.score.totalBeats, frac * this.score.totalBeats));
  }

  private laneTop() {
    return 7;
  }

  private laneBottom() {
    return this.cssHeight - 7;
  }

  private buildNotesLayer() {
    const layer = this.notesLayer ?? document.createElement('canvas');
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    const top = this.laneTop();
    const bottom = this.laneBottom();
    const y = (midi: number) => bottom - ((midi - this.lo) / Math.max(1, this.hi - this.lo)) * (bottom - top);
    for (const m of this.score.measures) {
      ctx.fillStyle = paper(0.06);
      ctx.fillRect(Math.round(this.beatToX(m.startBeat)), top - 3, 1, bottom - top + 6);
    }
    const lineH = this.cssHeight > 40 ? 2 : 1.6;
    for (const dimPass of [true, false]) {
      for (const part of this.score.parts) {
        if (this.hidden.has(part.id) || this.dimmed.has(part.id) !== dimPass) continue;
        ctx.fillStyle = withAlpha(this.partColor(part.id), dimPass ? 0.3 : 0.95);
        for (const n of this.score.notes) {
          if (n.partId !== part.id) continue;
          const x = this.beatToX(n.startBeat);
          const w = Math.max(1.5, this.beatToX(n.startBeat + n.durationBeats) - x - 0.8);
          ctx.fillRect(x, y(n.midi) - lineH / 2, w, lineH);
        }
      }
    }
    this.notesLayer = layer;
    this.dirty = false;
  }

  render(playheadBeat: number) {
    if (this.cssWidth <= 0 || this.cssHeight <= 0) return;
    if (this.dirty || !this.notesLayer) this.buildNotesLayer();
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Transparent: the strip sits on the glass of its container (see style.css).
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = paper(0.09);
    ctx.fillRect(0, 0, this.cssWidth, 1);
    const top = this.laneTop();
    const bottom = this.laneBottom();
    if (this.loop) {
      const x1 = this.beatToX(this.loop.start);
      const x2 = this.beatToX(this.loop.end);
      ctx.fillStyle = paper(0.12);
      ctx.fillRect(x1, top - 4, x2 - x1, bottom - top + 8);
      ctx.fillStyle = paper(0.55);
      ctx.fillRect(Math.round(x1), top - 4, 1, bottom - top + 8);
      ctx.fillRect(Math.round(x2), top - 4, 1, bottom - top + 8);
    }
    if (this.notesLayer) ctx.drawImage(this.notesLayer, 0, 0, this.cssWidth, this.cssHeight);
    const px = Math.round(this.beatToX(playheadBeat));
    ctx.fillStyle = 'rgba(19,18,30,0.55)';
    ctx.fillRect(PAD_X, top - 4, Math.max(0, px - PAD_X), bottom - top + 8);
    ctx.fillStyle = PAPER;
    ctx.fillRect(px - 1, 2, 2, this.cssHeight - 4);
  }
}
