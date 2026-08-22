import type { Score } from './score';
import { getBeatMarkers } from './score';

const DEFAULT_DUCKED_VOLUME = 0.25; // default level for non-soloed parts when at least one part is soloed
const RELEASE_TIME = 0.25;
const MIN_NOTE_DURATION_SEC = 0.02; // floor so a zero/near-zero-duration note can't collide two automation events at the same time
// Scheduling every remaining note in the piece synchronously, on every single play() call, doesn't
// scale: a note-dense score can be thousands of notes (5 audio nodes each), and BPM/transpose/seek/
// metronome changes all reschedule from scratch. Under enough simultaneous load the audio thread
// can't keep up and ctx.currentTime itself starts lagging real time -- which then poisons
// everything derived from it (the reported playback position, and therefore every future
// reschedule's math too). Instead, only ever schedule a bounded lookahead window of real time
// ahead of the current position, topped up incrementally as playback progresses (see tick()).
const LOOKAHEAD_SEC = 8; // schedule this many seconds of audio ahead of the current position
const LOOKAHEAD_REFILL_SEC = 3; // top up once the scheduled horizon is within this many seconds of "now"

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

  // Stopping a source node doesn't disconnect the rest of its chain -- the downstream gain/filter
  // nodes stay wired into the graph (doing zero-output work) until something explicitly
  // disconnects them or the browser's GC eventually reclaims them. Over a note-dense piece (or
  // repeated reschedules, each rebuilding a batch of these) that adds up to a graph with far more
  // live nodes than are actually sounding, which is exactly what was making the audio clock itself
  // fall behind real time under load. Disconnect the whole chain the moment the primary oscillator
  // ends -- whether that's its natural stop time, or an early one from clearSchedule() preempting
  // it -- so the live graph stays bounded to what's actually still sounding.
  osc1.addEventListener('ended', () => {
    for (const node of [osc1, osc2, osc2Gain, filter, ampGain]) {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
  });

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
  osc.addEventListener('ended', () => {
    try {
      osc.disconnect();
    } catch {
      // already disconnected
    }
    try {
      gain.disconnect();
    } catch {
      // already disconnected
    }
  });
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
  private beatMarkers: ReturnType<typeof getBeatMarkers>;
  private scheduledUpToBeat = 0; // notes/clicks with a beat before this have already been scheduled for the current play() session

  constructor(score: Score) {
    this.score = score;
    this.beatMarkers = getBeatMarkers(score);
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
    // below (see scheduleRange()'s per-note guard for why a single bad value must never abort the
    // whole loop).
    this.secPerBeat = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : this.secPerBeat;
    this.lastTranspose = transposeSemitones;
    this.playStartCtxTime = this.ctx.currentTime + 0.06;
    this.playStartBeat = fromBeat;
    this.playing = true;
    this.scheduledUpToBeat = fromBeat;
    // The initial schedule must scan from the very start of the piece, not just from fromBeat:
    // a long-held note that started earlier but is still sounding at fromBeat (seeking/starting
    // into its middle) needs to be picked up too, not just notes that start at-or-after it. Every
    // later top-up from tick() can then safely range-limit its scan, since anything overlapping an
    // earlier window was already handled by this call or a previous top-up.
    this.scheduleAhead(true);
  }

  /**
   * Tops up the schedule as playback progresses. Called once per animation frame from the render
   * loop while playing -- cheap when there's nothing to do (a single beat comparison), and only
   * actually schedules anything once the already-scheduled horizon gets close.
   */
  tick() {
    if (!this.playing) return;
    const horizonBeats = LOOKAHEAD_REFILL_SEC / this.secPerBeat;
    if (this.scheduledUpToBeat - this.getCurrentBeat() < horizonBeats) this.scheduleAhead(false);
  }

  private scheduleAhead(includeAlreadySounding: boolean) {
    const lookaheadBeats = LOOKAHEAD_SEC / this.secPerBeat;
    const targetBeat = this.getCurrentBeat() + lookaheadBeats;
    if (targetBeat <= this.scheduledUpToBeat && !includeAlreadySounding) return;
    const fromBeatExclusive = includeAlreadySounding ? -Infinity : this.scheduledUpToBeat;
    this.scheduleNotesInRange(fromBeatExclusive, targetBeat);
    if (this.metronomeEnabled) this.scheduleMetronomeInRange(fromBeatExclusive, targetBeat);
    this.scheduledUpToBeat = Math.max(this.scheduledUpToBeat, targetBeat);
  }

  /** Both this.score.notes and this.beatMarkers are sorted ascending by beat, so each top-up can
   *  resume scanning from roughly where the last one left off rather than rescanning from zero. */
  private scheduleNotesInRange(fromBeatExclusive: number, toBeatExclusive: number) {
    for (const note of this.score.notes) {
      if (note.startBeat < fromBeatExclusive) continue;
      if (note.startBeat >= toBeatExclusive) break;
      // A note with a non-finite (or otherwise unschedulable) start/duration -- e.g. from a
      // malformed source file -- would make `start`/`dur` below NaN or Infinity, which Web Audio
      // rejects by throwing synchronously. Skip anything unschedulable up front, and
      // belt-and-suspenders wrap the actual scheduling call too, so one bad note can never take
      // the rest of the piece down with it.
      if (!Number.isFinite(note.startBeat) || !Number.isFinite(note.durationBeats)) continue;
      if (note.startBeat + note.durationBeats <= this.playStartBeat) continue;
      const start = this.playStartCtxTime + Math.max(0, note.startBeat - this.playStartBeat) * this.secPerBeat;
      const dur = Math.max(MIN_NOTE_DURATION_SEC, note.durationBeats * this.secPerBeat);
      const gainNode = this.partGains.get(note.partId);
      if (!gainNode) continue;
      try {
        const nodes = playPianoNote(this.ctx, gainNode, start, dur, note.midi + this.lastTranspose);
        this.scheduledNodes.push(...nodes);
      } catch (err) {
        console.error('Skipping a note that could not be scheduled:', note, err);
      }
    }
  }

  private scheduleMetronomeInRange(fromBeatExclusive: number, toBeatExclusive: number) {
    for (const marker of this.beatMarkers) {
      if (marker.beat < fromBeatExclusive) continue;
      if (marker.beat >= toBeatExclusive) break;
      if (!Number.isFinite(marker.beat) || marker.beat < this.playStartBeat) continue;
      const start = this.playStartCtxTime + (marker.beat - this.playStartBeat) * this.secPerBeat;
      try {
        this.scheduledNodes.push(playClick(this.ctx, this.metronomeGain, start, marker.isDownbeat));
      } catch (err) {
        console.error('Skipping a metronome click that could not be scheduled:', marker, err);
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
