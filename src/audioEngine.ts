import type { Score } from './score';
import { getBeatMarkers } from './score';

const DUCKED_VOLUME = 0.28; // level for non-soloed parts when at least one part is soloed
const RELEASE_TIME = 0.25;

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

  setMetronomeEnabled(enabled: boolean) {
    this.metronomeEnabled = enabled;
    if (this.playing) this.play(this.getCurrentBeat(), 60 / this.secPerBeat, this.lastTranspose);
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
      else if (anySolo && state !== 'solo') level = DUCKED_VOLUME;
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
    this.secPerBeat = 60 / bpm;
    this.lastTranspose = transposeSemitones;
    const now = this.ctx.currentTime + 0.06;
    this.playStartCtxTime = now;
    this.playStartBeat = fromBeat;
    this.playing = true;

    for (const note of this.score.notes) {
      if (note.startBeat + note.durationBeats <= fromBeat) continue;
      const start = now + Math.max(0, note.startBeat - fromBeat) * this.secPerBeat;
      const dur = note.durationBeats * this.secPerBeat;
      const gainNode = this.partGains.get(note.partId);
      if (!gainNode) continue;
      const nodes = playPianoNote(this.ctx, gainNode, start, dur, note.midi + transposeSemitones);
      this.scheduledNodes.push(...nodes);
    }

    if (this.metronomeEnabled) {
      for (const marker of getBeatMarkers(this.score)) {
        if (marker.beat < fromBeat) continue;
        const start = now + (marker.beat - fromBeat) * this.secPerBeat;
        this.scheduledNodes.push(playClick(this.ctx, this.metronomeGain, start, marker.isDownbeat));
      }
    }
  }

  pause() {
    this.pausedBeat = this.getCurrentBeat();
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
