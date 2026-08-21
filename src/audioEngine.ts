import type { Score } from './score';
import { getBeatMarkers } from './score';

const DEFAULT_DUCKED_VOLUME = 0.25; // default level for non-soloed parts when at least one part is soloed
const RELEASE_TIME = 0.25;
const MIN_NOTE_DURATION_SEC = 0.02; // floor so a zero/near-zero-duration note can't collide two automation events at the same time

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Synthesizes a single plucked-piano-ish note; returns the oscillator nodes so callers can track/stop them. */
function playPianoNote(
  ctx: AudioContext,
  destination: AudioNode,
  startTime: number,
  duration: number,
  midi: number,
): OscillatorNode[] {
  const freq = midiToFreq(midi);

  const osc1 = ctx.createOscillator();
  osc1.type = 'triangle';
  osc1.frequency.setValueAtTime(freq, startTime);

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq * 2.01, startTime);
  const osc2Gain = ctx.createGain();
  osc2Gain.gain.value = 0.15;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(freq * 6, 8000), startTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 400), startTime + 0.5);

  const ampGain = ctx.createGain();
  const attack = 0.006;
  const peak = 0.36;
  const decayTarget = Math.max(peak * 0.35, 0.001);
  const noteOffTime = startTime + duration;

  ampGain.gain.setValueAtTime(0, startTime);
  ampGain.gain.linearRampToValueAtTime(peak, startTime + attack);
  ampGain.gain.exponentialRampToValueAtTime(decayTarget, startTime + attack + Math.min(duration, 0.4));
  ampGain.gain.setValueAtTime(Math.max(decayTarget, 0.001), Math.max(noteOffTime, startTime + attack + 0.01));
  ampGain.gain.exponentialRampToValueAtTime(0.0001, noteOffTime + RELEASE_TIME);

  osc1.connect(filter);
  osc2.connect(osc2Gain).connect(filter);
  filter.connect(ampGain);
  ampGain.connect(destination);

  const stopTime = noteOffTime + RELEASE_TIME + 0.05;
  osc1.start(startTime);
  osc2.start(startTime);
  osc1.stop(stopTime);
  osc2.stop(stopTime);

  return [osc1, osc2];
}

function playClick(ctx: AudioContext, destination: AudioNode, startTime: number, accent: boolean): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(accent ? 1500 : 1000, startTime);
  const gain = ctx.createGain();
  const peak = accent ? 0.35 : 0.22;
  gain.gain.setValueAtTime(peak, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.04);
  osc.connect(gain).connect(destination);
  osc.start(startTime);
  osc.stop(startTime + 0.05);
  return osc;
}

export type PartMixState = 'normal' | 'muted' | 'solo';

export class AudioEngine {
  private ctx = new AudioContext();
  private masterGain: GainNode;
  private compressor: DynamicsCompressorNode;
  private metronomeGain: GainNode;
  private partGains = new Map<string, GainNode>();
  private scheduledNodes: OscillatorNode[] = [];
  private playStartCtxTime = 0;
  private playStartBeat = 0;
  private secPerBeat = 60 / 100;
  private playing = false;
  private pausedBeat = 0;
  private mixState = new Map<string, PartMixState>();
  private metronomeEnabled = false;
  private duckedVolume = DEFAULT_DUCKED_VOLUME;
  private score: Score;

  constructor(score: Score) {
    this.score = score;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    // Doubled/unison voices (common in choir arrangements) stack gain and can clip; compress the bus instead.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -20;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.15;
    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    this.metronomeGain = this.ctx.createGain();
    this.metronomeGain.connect(this.masterGain);

    for (const part of score.parts) {
      const g = this.ctx.createGain();
      g.connect(this.masterGain);
      this.partGains.set(part.id, g);
      this.mixState.set(part.id, 'normal');
    }
    this.applyMix();
  }

  setPartMixState(partId: string, state: PartMixState) {
    this.mixState.set(partId, state);
    this.applyMix();
  }

  /** Plays a single short tone at the given (already-transposed) pitch, for click-to-audition. */
  previewNote(midi: number) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    playPianoNote(this.ctx, this.masterGain, this.ctx.currentTime, 0.5, midi);
  }

  setMetronomeEnabled(enabled: boolean) {
    this.metronomeEnabled = enabled;
    if (this.playing) this.play(this.getCurrentBeat(), 60 / this.secPerBeat, this.lastTranspose);
  }

  /** Volume (0-1) for non-soloed parts while at least one part has its Solo button active. */
  setDuckedVolume(level: number) {
    this.duckedVolume = level;
    this.applyMix();
  }

  getBpm() {
    return 60 / this.secPerBeat;
  }

  private applyMix() {
    const anySolo = Array.from(this.mixState.values()).some((s) => s === 'solo');
    const now = this.ctx.currentTime;
    for (const [partId, gain] of this.partGains) {
      const state = this.mixState.get(partId) ?? 'normal';
      let level = 1;
      if (state === 'muted') level = 0;
      else if (anySolo && state !== 'solo') level = this.duckedVolume;
      gain.gain.setTargetAtTime(level, now, 0.03);
    }
  }

  private lastTranspose = 0;

  private clearSchedule() {
    for (const n of this.scheduledNodes) {
      try {
        n.stop();
      } catch {
        // already stopped
      }
    }
    this.scheduledNodes = [];
  }

  play(fromBeat: number, bpm: number, transposeSemitones: number) {
    this.clearSchedule();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // A non-finite/non-positive bpm would make every downstream time calculation NaN/Infinity;
    // fall back to the last known-good tempo rather than propagating that into the scheduling
    // below (see the note-loop guard for why a single bad value must never abort the whole loop).
    this.secPerBeat = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : this.secPerBeat;
    this.lastTranspose = transposeSemitones;
    const now = this.ctx.currentTime + 0.06;
    this.playStartCtxTime = now;
    this.playStartBeat = fromBeat;
    this.playing = true;

    for (const note of this.score.notes) {
      // A note with a non-finite (or otherwise unschedulable) start/duration -- e.g. from a
      // malformed source file -- would make `start`/`dur` below NaN or Infinity, which Web Audio
      // rejects by throwing synchronously. Since that throw would happen partway through this
      // loop, it wouldn't just skip the one bad note: it would abort scheduling for every note
      // after it too, while `this.playing` above has already flipped to true -- silence, with no
      // way to recover short of reloading the page. Skip anything unschedulable up front, and
      // belt-and-suspenders wrap the actual scheduling call too, so one bad note can never take
      // the rest of the piece down with it.
      if (!Number.isFinite(note.startBeat) || !Number.isFinite(note.durationBeats)) continue;
      if (note.startBeat + note.durationBeats <= fromBeat) continue;
      const start = now + Math.max(0, note.startBeat - fromBeat) * this.secPerBeat;
      const dur = Math.max(MIN_NOTE_DURATION_SEC, note.durationBeats * this.secPerBeat);
      const gainNode = this.partGains.get(note.partId);
      if (!gainNode) continue;
      try {
        const nodes = playPianoNote(this.ctx, gainNode, start, dur, note.midi + transposeSemitones);
        this.scheduledNodes.push(...nodes);
      } catch (err) {
        console.error('Skipping a note that could not be scheduled:', note, err);
      }
    }

    if (this.metronomeEnabled) {
      for (const marker of getBeatMarkers(this.score)) {
        if (!Number.isFinite(marker.beat) || marker.beat < fromBeat) continue;
        const start = now + (marker.beat - fromBeat) * this.secPerBeat;
        try {
          this.scheduledNodes.push(playClick(this.ctx, this.metronomeGain, start, marker.isDownbeat));
        } catch (err) {
          console.error('Skipping a metronome click that could not be scheduled:', marker, err);
        }
      }
    }
  }

  pause() {
    this.pausedBeat = this.getCurrentBeat();
    // Suspending the context freezes its clock but does NOT cancel already-scheduled oscillators
    // -- they just wait. If anything later resumes the context (previewNote() does, to audition a
    // clicked note while paused), those old notes would suddenly fire in a burst, sounding like
    // playback had resumed on its own. Clearing the schedule here removes that risk entirely; the
    // resume-from-pause path always goes through play(), which reschedules from scratch anyway.
    this.clearSchedule();
    this.ctx.suspend();
    this.playing = false;
  }

  resume() {
    this.ctx.resume();
    this.playing = true;
  }

  stop() {
    this.clearSchedule();
    this.pausedBeat = 0;
    this.playing = false;
  }

  isPlaying() {
    return this.playing;
  }

  getPausedBeat() {
    return this.pausedBeat;
  }

  setPausedBeat(beat: number) {
    this.pausedBeat = Math.max(0, Math.min(this.score.totalBeats, beat));
  }

  getCurrentBeat(): number {
    if (!this.playing) return this.pausedBeat;
    const beat = this.playStartBeat + (this.ctx.currentTime - this.playStartCtxTime) / this.secPerBeat;
    return Math.max(this.playStartBeat, beat);
  }
}
