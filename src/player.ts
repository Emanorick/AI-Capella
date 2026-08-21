import { AudioEngine, type PartMixState } from './audioEngine';
import { PianoRoll, type LoopRegion } from './pianoRoll';
import { colorForPartIndex } from './palette';
import { measureAtBeat, type Score } from './score';

const MIN_TRANSPOSE = -7;
const MAX_TRANSPOSE = 7;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
const VIEW_EDGE_SLACK_BEATS = 2;
const MIN_LOOP_BEATS = 0.5;
const PREVIEW_NOTE_LABEL_MS = 1200;

export { ZOOM_STEP };

/**
 * How the player reports state changes back to whatever renders the chrome around the canvas.
 * The player never touches DOM outside its canvas; main.ts implements these against the real UI.
 */
export interface PlayerUI {
  /** Playback started/stopped -- keep every play/pause button's icon in sync. */
  onPlayStateChanged(playing: boolean): void;
  /** Loop region and/or enabled flag changed -- update the Loop button. */
  onLoopChanged(enabled: boolean, region: LoopRegion | null): void;
  /** The measure/beat readout text changed. */
  onPositionText(text: string): void;
  /** Part mix states changed (mute/solo/true-solo) -- re-sync the parts panel rows. */
  onPartMixChanged(): void;
}

/**
 * Owns everything about playing and viewing one score: the audio engine, the piano roll, and all
 * the playback/view state (bpm, transpose, zoom, pan offset, loop region, custom start point)
 * that used to live as loose module-level variables in main.ts. One instance outlives songs;
 * loadScore() swaps the score-bound internals (engine, roll, per-part mix).
 */
export class Player {
  private canvas: HTMLCanvasElement;
  private ui: PlayerUI;

  private score: Score | null = null;
  private engine: AudioEngine | null = null;
  private roll: PianoRoll | null = null;
  private partMix = new Map<string, PartMixState>();

  private bpm = 100;
  private duckVolume = 0.25;
  private transpose = 0;
  private zoom = 1;
  private viewOffsetBeats = 0;
  private metronomeOn = false;
  private customStartBeat: number | null = null; // last spot set via the ruler; Stop returns here
  private loopRegion: LoopRegion | null = null;
  private loopEnabled = false;

  private rafId: number | null = null;
  private renderPending = false;
  private previewNoteTimeout: number | null = null;
  private lastPositionText = '';
  private canvasLeft = 0;
  private canvasTop = 0;

  constructor(canvas: HTMLCanvasElement, ui: PlayerUI) {
    this.canvas = canvas;
    this.ui = ui;
    this.refreshCanvasRect();
  }

  // ---- score lifecycle -------------------------------------------------------------------

  loadScore(score: Score) {
    this.stopRenderLoop();
    this.engine?.dispose(); // each engine owns an AudioContext; browsers cap how many can exist
    this.score = score;
    this.transpose = 0;
    this.zoom = 1;
    this.viewOffsetBeats = 0;
    this.loopRegion = null;
    this.loopEnabled = false;
    this.customStartBeat = null;
    this.metronomeOn = false;

    this.engine = new AudioEngine(score);
    this.engine.setDuckedVolume(this.duckVolume);
    this.roll = new PianoRoll(this.canvas, score, (partId) => {
      const idx = score.parts.findIndex((p) => p.id === partId);
      return colorForPartIndex(idx);
    });
    this.roll.setLoopRegion(null);

    this.partMix = new Map(score.parts.map((p) => [p.id, 'normal' as PartMixState]));
    this.roll.setPartMix(this.partMix);
    this.ui.onLoopChanged(this.loopEnabled, this.loopRegion);
    this.ui.onPlayStateChanged(false);
  }

  hasScore(): boolean {
    return this.score !== null;
  }

  getScore(): Score | null {
    return this.score;
  }

  // ---- transport -------------------------------------------------------------------------

  togglePlay() {
    if (!this.engine || !this.score) return;
    if (this.engine.isPlaying()) {
      this.engine.pause();
      this.ui.onPlayStateChanged(false);
      this.stopRenderLoop();
    } else {
      let fromBeat = this.engine.getPausedBeat();
      if (this.loopRegion) {
        fromBeat = this.loopRegion.start;
      } else if (fromBeat >= this.score.totalBeats) {
        fromBeat = 0;
      }
      this.viewOffsetBeats = 0;
      this.engine.play(fromBeat, this.bpm, this.transpose);
      this.ui.onPlayStateChanged(true);
      this.startRenderLoop();
    }
  }

  /** Stops playback and resets to the loop region's start, the last ruler-set start point, or the beginning. */
  stopPlayback() {
    if (!this.engine || !this.roll) return;
    const wasPlaying = this.engine.isPlaying();
    const priorPausedBeat = this.engine.getPausedBeat();
    const target = this.loopRegion ? this.loopRegion.start : (this.customStartBeat ?? 0);
    // Pressing Stop again while already stopped at the target (loop/custom start) goes the rest of
    // the way to the very beginning, same as a media player's Stop button.
    const alreadyAtTarget = !wasPlaying && Math.abs(priorPausedBeat - target) < 0.01;
    const resetBeat = alreadyAtTarget ? 0 : target;

    this.engine.stop();
    this.stopRenderLoop();
    this.engine.setPausedBeat(resetBeat);
    this.viewOffsetBeats = 0;
    this.ui.onPlayStateChanged(false);
    this.renderNow();
  }

  isPlaying(): boolean {
    return this.engine?.isPlaying() ?? false;
  }

  /** Returns the new metronome state. */
  toggleMetronome(): boolean {
    if (!this.engine) return false;
    this.metronomeOn = !this.metronomeOn;
    this.engine.setMetronomeEnabled(this.metronomeOn);
    return this.metronomeOn;
  }

  toggleLoop() {
    if (!this.score) return;
    this.loopEnabled = !this.loopEnabled;
    this.ui.onLoopChanged(this.loopEnabled, this.loopRegion);
  }

  getBpm(): number {
    return this.bpm;
  }

  getDuckVolume(): number {
    return this.duckVolume;
  }

  setBpm(bpm: number) {
    this.bpm = bpm;
    if (this.engine?.isPlaying()) {
      this.engine.play(this.engine.getCurrentBeat(), this.bpm, this.transpose);
    }
  }

  setDuckVolume(level: number) {
    this.duckVolume = level;
    this.engine?.setDuckedVolume(level);
  }

  /** Clamps and applies a transpose delta; returns the resulting semitone offset. */
  applyTranspose(delta: number): number {
    if (!this.engine || !this.roll) return this.transpose;
    this.transpose = Math.max(MIN_TRANSPOSE, Math.min(MAX_TRANSPOSE, this.transpose + delta));
    this.roll.setTranspose(this.transpose);
    if (this.engine.isPlaying()) {
      this.engine.play(this.engine.getCurrentBeat(), this.bpm, this.transpose);
    } else {
      this.renderNow();
    }
    return this.transpose;
  }

  /** Clamps and applies a zoom factor; returns the resulting zoom level. */
  applyZoom(factor: number): number {
    if (!this.roll) return this.zoom;
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    this.roll.setZoom(this.zoom);
    this.clampViewOffset();
    this.renderNow();
    return this.zoom;
  }

  // ---- part mix --------------------------------------------------------------------------

  getPartMixState(partId: string): PartMixState {
    return this.partMix.get(partId) ?? 'normal';
  }

  /** Toggles a part between the given state and normal (the M/S buttons). */
  togglePartMix(partId: string, action: PartMixState) {
    if (!this.engine || !this.roll) return;
    const current = this.partMix.get(partId) ?? 'normal';
    const next: PartMixState = current === action ? 'normal' : action;
    this.partMix.set(partId, next);
    this.engine.setPartMixState(partId, next);
    this.roll.setPartMix(this.partMix);
    this.ui.onPartMixChanged();
    this.renderNow();
  }

  /**
   * "True solo": mutes AND hides every other voice so only this one is visible/audible (unlike the
   * Solo button, which just ducks/dims the others). Clicking the same voice again restores everyone.
   */
  toggleTrueSolo(partId: string) {
    if (!this.engine || !this.roll || !this.score) return;
    const alreadyIsolated =
      this.partMix.get(partId) !== 'muted' &&
      this.score.parts.every((p) => p.id === partId || this.partMix.get(p.id) === 'muted');
    for (const p of this.score.parts) {
      const next: PartMixState = alreadyIsolated || p.id === partId ? 'normal' : 'muted';
      this.partMix.set(p.id, next);
      this.engine.setPartMixState(p.id, next);
    }
    this.roll.setPartMix(this.partMix);
    this.ui.onPartMixChanged();
    this.renderNow();
  }

  // ---- view ------------------------------------------------------------------------------

  /** Re-reads the canvas's layout box; call after anything that can move or resize it. */
  refreshLayout() {
    this.roll?.resize();
    this.refreshCanvasRect();
    this.renderNow();
  }

  private refreshCanvasRect() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvasLeft = rect.left;
    this.canvasTop = rect.top;
  }

  /** Canvas-local y for a client (viewport) y, from the cached canvas rect. */
  localY(clientY: number): number {
    return clientY - this.canvasTop;
  }

  pixelsPerBeat(): number {
    return this.roll?.getPixelsPerBeat() ?? 1;
  }

  panByBeats(deltaBeats: number) {
    if (!this.roll) return;
    // Keep the view locked to the actual playback position while playing: panning it away is
    // exactly what put the red line out of sync with the music (the view would show a different
    // beat than the one actually sounding, since the line's screen x is fixed but the beat under it
    // becomes whatever was panned to). Still allowed while paused/stopped, to browse the score.
    if (this.engine?.isPlaying()) return;
    this.viewOffsetBeats += deltaBeats;
    this.clampViewOffset();
    this.scheduleRender();
  }

  scrollByPixels(dy: number) {
    if (!this.roll) return;
    this.roll.scrollByPixels(dy);
    this.scheduleRender();
  }

  private engineBeat(): number {
    if (!this.engine) return 0;
    return this.engine.isPlaying() ? this.engine.getCurrentBeat() : this.engine.getPausedBeat();
  }

  private displayBeat(): number {
    return this.engineBeat() + this.viewOffsetBeats;
  }

  private clampViewOffset() {
    if (!this.score) return;
    const base = this.engineBeat();
    const display = base + this.viewOffsetBeats;
    const clamped = Math.max(-VIEW_EDGE_SLACK_BEATS, Math.min(this.score.totalBeats + VIEW_EDGE_SLACK_BEATS, display));
    this.viewOffsetBeats = clamped - base;
  }

  // ---- seeking, loop selection, note preview ---------------------------------------------

  beatAtClientX(clientX: number): number {
    if (!this.roll) return 0;
    return this.roll.xToBeat(clientX - this.canvasLeft, this.displayBeat());
  }

  /**
   * Sets where the next Play (or an already-playing transport) should be, without moving the
   * view: the beat under the click stays under the same screen x, so scrolling never jumps.
   */
  seekToBeat(beat: number) {
    if (!this.engine || !this.score || !this.roll) return;
    const clamped = Math.max(0, Math.min(this.score.totalBeats, beat));
    const oldEngineBeat = this.engineBeat();
    if (this.engine.isPlaying()) {
      this.engine.play(clamped, this.bpm, this.transpose);
    } else {
      this.engine.setPausedBeat(clamped);
    }
    this.viewOffsetBeats += oldEngineBeat - clamped;
    this.clampViewOffset();
    this.renderNow();
  }

  /** A tap (not a drag) in the ruler: clears any loop region and makes this the start point. */
  setCustomStart(beat: number) {
    this.clearLoopRegion();
    this.customStartBeat = beat;
    this.seekToBeat(beat);
  }

  clearLoopRegion() {
    if (!this.loopRegion) return;
    this.loopRegion = null;
    this.roll?.setLoopRegion(null);
    this.ui.onLoopChanged(this.loopEnabled, this.loopRegion);
  }

  /** Live preview while dragging in the ruler -- not yet committed as the loop region. */
  previewLoopSelection(beatA: number, beatB: number) {
    if (!this.roll) return;
    this.roll.setLoopRegion({ start: Math.min(beatA, beatB), end: Math.max(beatA, beatB) });
    this.scheduleRender();
  }

  finalizeLoopSelection(beatA: number, beatB: number) {
    if (!this.score || !this.roll) return;
    const start = Math.max(0, Math.min(beatA, beatB));
    const end = Math.min(this.score.totalBeats, Math.max(beatA, beatB));
    if (end - start < MIN_LOOP_BEATS) {
      this.loopRegion = null;
    } else {
      this.loopRegion = { start, end };
      this.loopEnabled = true;
    }
    this.roll.setLoopRegion(this.loopRegion);
    this.ui.onLoopChanged(this.loopEnabled, this.loopRegion);
    this.renderNow();
  }

  /**
   * A tap in the note area: previews whatever note is under it (audibly and with a label) --
   * never moves playback, so casual clicks or short scrolls while playing can't jump the position.
   */
  previewNoteAt(clientX: number, clientY: number) {
    if (!this.roll || !this.score) return;
    const hit = this.roll.hitTestNote(clientX - this.canvasLeft, clientY - this.canvasTop, this.displayBeat());
    if (this.previewNoteTimeout != null) {
      clearTimeout(this.previewNoteTimeout);
      this.previewNoteTimeout = null;
    }
    if (hit) {
      this.engine?.previewNote(hit.midi);
      this.roll.setPreviewNote({ startBeat: hit.startBeat, midi: hit.midi });
      // The label is only shown briefly, while the tone plays -- not left on screen until the
      // next click.
      this.previewNoteTimeout = window.setTimeout(() => {
        this.previewNoteTimeout = null;
        this.roll?.setPreviewNote(null);
        this.renderNow();
      }, PREVIEW_NOTE_LABEL_MS);
    } else {
      this.roll.setPreviewNote(null);
    }
    // Unlike during playback (where the render loop repaints every frame regardless), nothing
    // else forces a redraw while paused -- without this the tone would play but its label would
    // never actually appear on screen until some other interaction happened to trigger one.
    this.renderNow();
  }

  // ---- rendering -------------------------------------------------------------------------

  /**
   * Coalesces render requests to at most one per animation frame. Wheel/trackpad events and
   * pointermove can fire far faster than the display refreshes (100+/sec during a fast swipe);
   * rendering synchronously per event does far more repaint work than can ever be shown and was
   * the main source of stutter while panning.
   */
  scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.renderNow();
    });
  }

  renderNow() {
    if (!this.roll || !this.engine) return;
    const beat = this.displayBeat();
    this.roll.render(beat, this.engineBeat());
    this.updatePositionDisplay(beat);
  }

  private updatePositionDisplay(beat: number) {
    if (!this.score) return;
    const measure = measureAtBeat(this.score, beat);
    let text = '—';
    if (measure) {
      const pulseBeats = 4 / measure.beatType;
      const beatInMeasure = Math.floor((beat - measure.startBeat) / pulseBeats) + 1;
      text = `Measure ${measure.number} · Beat ${Math.min(beatInMeasure, measure.beats)}/${measure.beats}`;
    }
    // During playback this runs every animation frame; pushing the text unconditionally forces a
    // style/layout invalidation even when the displayed string hasn't actually changed (which is
    // most frames, since it only changes once per beat).
    if (text === this.lastPositionText) return;
    this.lastPositionText = text;
    this.ui.onPositionText(text);
  }

  private renderLoopTick = () => {
    if (!this.engine || !this.roll || !this.score) return;
    const beat = this.engine.getCurrentBeat();
    // A loop region, once marked, bounds playback; the Loop button decides whether hitting that
    // bound (or the end of the piece, when no region is marked) wraps around or stops there.
    const boundary = this.loopRegion ? this.loopRegion.end : this.score.totalBeats;

    if (beat >= boundary) {
      if (this.loopEnabled) {
        const loopStart = this.loopRegion ? this.loopRegion.start : 0;
        this.engine.play(loopStart, this.bpm, this.transpose);
        this.rafId = requestAnimationFrame(this.renderLoopTick);
        return;
      }

      const resetBeat = this.loopRegion ? this.loopRegion.start : 0;
      this.engine.stop();
      this.engine.setPausedBeat(resetBeat);
      this.viewOffsetBeats = 0;
      this.ui.onPlayStateChanged(false);
      this.roll.render(resetBeat, resetBeat);
      this.updatePositionDisplay(resetBeat);
      this.rafId = null;
      return;
    }

    this.roll.render(beat + this.viewOffsetBeats, beat);
    this.updatePositionDisplay(beat + this.viewOffsetBeats);
    this.rafId = requestAnimationFrame(this.renderLoopTick);
  };

  private startRenderLoop() {
    if (this.rafId == null) this.rafId = requestAnimationFrame(this.renderLoopTick);
  }

  private stopRenderLoop() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
