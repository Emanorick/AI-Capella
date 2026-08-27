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
// clearSchedule() needs to fade a voice's gain to (near-)zero before stopping its oscillators --
// stopping a still-sounding oscillator with no ramp truncates the waveform mid-cycle, which is an
// audible click/pop. This just needs to be short enough that an early Stop/Pause/reschedule
// doesn't feel laggy.
const FADE_SEC = 0.01;

/** An audible "voice": whichever oscillators make up one note or click, sharing one gain node
 *  that controls its envelope/volume. clearSchedule() fades/stops a whole voice at once. */
interface Voice {
  oscillators: OscillatorNode[];
  gain: GainNode;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Synthesizes a single plucked-piano-ish note; returns the voice so callers can track/stop it. */
function playPianoNote(
  ctx: AudioContext,
  destination: AudioNode,
  startTime: number,
  duration: number,
  midi: number,
): Voice {
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
  const decayEndTime = startTime + attack + Math.min(duration, 0.4);
  ampGain.gain.exponentialRampToValueAtTime(decayTarget, decayEndTime);
  // This hold event must never land before decayEndTime -- Web Audio resolves automation events
  // in time order regardless of call order, so a setValueAtTime landing earlier than a pending
  // ramp's own end time pre-empts it: the value would hold flat at `peak` and then jump straight
  // to decayTarget instead of actually decaying, silently discarding the ramp above for most
  // notes (anything shorter than ~0.4s, i.e. most of them).
  ampGain.gain.setValueAtTime(Math.max(decayTarget, 0.001), Math.max(noteOffTime, decayEndTime));
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

  return { oscillators: [osc1, osc2], gain: ampGain };
}

function playClick(ctx: AudioContext, destination: AudioNode, startTime: number, accent: boolean): Voice {
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
  return { oscillators: [osc], gain };
}

export type PartMixState = 'normal' | 'muted' | 'solo';

export class AudioEngine {
  private ctx = new AudioContext();
  private masterGain: GainNode;
  private compressor: DynamicsCompressorNode;
  private metronomeGain: GainNode;
  private partGains = new Map<string, GainNode>();
  private scheduledVoices: Voice[] = [];
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
    // Diagnostics for a reported "metronome shows on but stays silent, and won't toggle" bug that
    // couldn't be reproduced from reading the code alone -- if it recurs, these traces are the
    // fastest way to see whether the flag/scheduling actually desynced, or something upstream
    // (the sync/UI layer) never got this call at all.
    console.debug('[AI-Capella] setMetronomeEnabled', { enabled, playing: this.playing, scheduledUpToBeat: this.scheduledUpToBeat });
    this.metronomeEnabled = enabled;
    // Skip the reschedule while a count-in is still sounding: play()'s "now + 0.06" local
    // rescheduling path (no startAtEpochMs here) would cut the count-in short and start the music
    // immediately, ahead of the synced instant every other device is still counting down to. The
    // flag change still takes effect once the count-in ends naturally -- tick()'s ordinary
    // lookahead top-up schedules the live click track (or doesn't) using the fresh value.
    if (this.playing && !this.isCountingIn()) this.play(this.getCurrentBeat(), 60 / this.secPerBeat, this.lastTranspose);
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
  private lastCountInBeats = 0; // set by play(); isCountingIn() needs this to tell "pre-roll before a count-in" apart from "pre-roll before a plain synced Play"

  private clearSchedule() {
    const now = this.ctx.currentTime;
    for (const voice of this.scheduledVoices) {
      try {
        // Fade from wherever the gain currently is down to (near-)zero before stopping, instead
        // of cutting the oscillator off mid-waveform -- an abrupt stop() on a still-sounding node
        // is an audible click/pop. cancelAndHoldAtTime freezes whatever automation curve was in
        // progress at its current value so the fade starts smoothly from there, not from
        // whatever the *next* scheduled automation event would have been.
        voice.gain.gain.cancelAndHoldAtTime(now);
        voice.gain.gain.linearRampToValueAtTime(0.0001, now + FADE_SEC);
      } catch {
        // already disconnected/errored -- fall through and still try to stop the oscillators
      }
      for (const osc of voice.oscillators) {
        try {
          osc.stop(now + FADE_SEC);
        } catch {
          // already stopped
        }
      }
    }
    this.scheduledVoices = [];
  }

  /**
   * `startAtEpochMs`, when given, is a shared wall-clock instant (e.g. from a multi-device sync
   * broadcast) to start at, translated into this device's own AudioContext clock -- rather than
   * the default "as soon as possible" (`ctx.currentTime + 0.06`). If that instant has already
   * passed (slow delivery, a device joining mid-song), playback joins already in progress from
   * wherever it would be right now instead of starting late from `fromBeat`.
   *
   * `countInBeats` (spaced `countInPulseBeats` quarter-beats apart, e.g. 0.5 for a 6/8 measure's
   * dotted-eighth pulse), when > 0, schedules that many metronome-style clicks (first one
   * accented) ending exactly at the music's start instant -- a synced "Einzählen." If there isn't
   * actually room before that instant (a late-joining/late-delivered device with no lead time to
   * spare), the count-in is silently skipped and playback just starts as scheduled, same
   * principle as the "join already in progress" branch above.
   */
  play(fromBeat: number, bpm: number, transposeSemitones: number, startAtEpochMs?: number, countInBeats = 0, countInPulseBeats = 1) {
    this.clearSchedule();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // A non-finite/non-positive bpm would make every downstream time calculation NaN/Infinity;
    // fall back to the last known-good tempo rather than propagating that into the scheduling
    // below (see scheduleRange()'s per-note guard for why a single bad value must never abort the
    // whole loop).
    this.secPerBeat = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : this.secPerBeat;
    this.lastTranspose = transposeSemitones;
    this.lastCountInBeats = countInBeats;
    const now = this.ctx.currentTime;
    if (startAtEpochMs != null) {
      const deltaSec = (startAtEpochMs - Date.now()) / 1000;
      if (deltaSec > 0) {
        this.playStartCtxTime = now + deltaSec;
        this.playStartBeat = fromBeat;
      } else {
        this.playStartCtxTime = now;
        this.playStartBeat = fromBeat + -deltaSec / this.secPerBeat;
      }
    } else {
      this.playStartCtxTime = now + 0.06;
      this.playStartBeat = fromBeat;
    }
    this.playing = true;
    this.scheduledUpToBeat = this.playStartBeat;
    if (countInBeats > 0) {
      const pulseSec = countInPulseBeats * this.secPerBeat;
      if (this.playStartCtxTime - countInBeats * pulseSec > now + 0.05) {
        for (let i = 0; i < countInBeats; i++) {
          const clickTime = this.playStartCtxTime - (countInBeats - i) * pulseSec;
          try {
            this.scheduledVoices.push(playClick(this.ctx, this.metronomeGain, clickTime, i === 0));
          } catch (err) {
            console.error('Skipping a count-in click that could not be scheduled:', err);
          }
        }
      }
    }
    // The initial schedule must scan from the very start of the piece, not just from fromBeat:
    // a long-held note that started earlier but is still sounding at fromBeat (seeking/starting
    // into its middle) needs to be picked up too, not just notes that start at-or-after it. Every
    // later top-up from tick() can then safely range-limit its scan, since anything overlapping an
    // earlier window was already handled by this call or a previous top-up.
    this.scheduleAhead(true);
  }

  /** True while a count-in scheduled by the most recent play() is still sounding, before the actual music starts. */
  isCountingIn(): boolean {
    return this.playing && this.lastCountInBeats > 0 && this.ctx.currentTime < this.playStartCtxTime;
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
        this.scheduledVoices.push(playPianoNote(this.ctx, gainNode, start, dur, note.midi + this.lastTranspose));
      } catch (err) {
        console.error('Skipping a note that could not be scheduled:', note, err);
      }
    }
  }

  private scheduleMetronomeInRange(fromBeatExclusive: number, toBeatExclusive: number) {
    let scheduledCount = 0;
    for (const marker of this.beatMarkers) {
      if (marker.beat < fromBeatExclusive) continue;
      if (marker.beat >= toBeatExclusive) break;
      if (!Number.isFinite(marker.beat) || marker.beat < this.playStartBeat) continue;
      const start = this.playStartCtxTime + (marker.beat - this.playStartBeat) * this.secPerBeat;
      try {
        this.scheduledVoices.push(playClick(this.ctx, this.metronomeGain, start, marker.isDownbeat));
        scheduledCount++;
      } catch (err) {
        console.error('Skipping a metronome click that could not be scheduled:', marker, err);
      }
    }
    // See setMetronomeEnabled's comment -- if a repro turns up, checking whether this ever logs
    // 0 while metronomeEnabled is true (vs. never being called at all) narrows down where the
    // stuck-metronome bug actually lives.
    console.debug('[AI-Capella] scheduleMetronomeInRange', { fromBeatExclusive, toBeatExclusive, scheduledCount });
  }

  pause() {
    this.pausedBeat = this.getCurrentBeat();
    // Suspending the context freezes its clock but does NOT cancel already-scheduled oscillators
    // -- they just wait. If anything later resumes the context (previewNote() does, to audition a
    // clicked note while paused), those old notes would suddenly fire in a burst, sounding like
    // playback had resumed on its own. Clearing the schedule here removes that risk entirely; the
    // resume-from-pause path always goes through play(), which reschedules from scratch anyway.
    this.clearSchedule();
    // ctx.suspend() halts rendering almost immediately (the next render quantum), which would cut
    // clearSchedule()'s FADE_SEC-long gain ramp short -- defer it just past the fade so Pause
    // still fades cleanly instead of clicking.
    setTimeout(() => this.ctx.suspend(), FADE_SEC * 1000 + 5);
    this.playing = false;
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
