import { doc, getDocFromServer, onSnapshot, serverTimestamp, setDoc, Timestamp, type Unsubscribe } from 'firebase/firestore';
import { db } from './firebase';
import type { LoopRegion } from './pianoRoll';

// How far into the future a "start playing" instant is broadcast, relative to the moment it's
// published. Every connected device translates this shared instant into its own AudioContext
// clock and schedules playback to begin exactly then, rather than "as soon as the update
// arrives" -- onSnapshot delivery latency varies per device (worse on the long-polling fallback
// firebase.ts already falls back to on restrictive networks), so "as soon as it arrives" would
// make devices start audibly out of sync with each other. This buffer just needs to comfortably
// exceed normal propagation latency without feeling laggy when someone presses Play.
const PLAY_SYNC_BUFFER_MS = 750;
const CALIBRATION_INTERVAL_MS = 5 * 60_000;
const DEVICE_ID_STORAGE_KEY = 'ai-capella-device-id';

const SESSION_DOC_PATH = ['sessions', 'live'] as const;

// Deliberately not part of the synced state: mute/solo/true-solo. Each device chooses which
// voices it personally hears -- e.g. a soprano wants to hear only their own part while everyone
// else in the room hears the full mix -- without affecting what anyone else hears.
export interface PlaybackState {
  songId: string | null;
  playing: boolean;
  originBeat: number;
  originServerTimeMs: number;
  bpm: number;
  transpose: number;
  metronomeOn: boolean;
  loopEnabled: boolean;
  loopRegion: LoopRegion | null;
  // How many count-in clicks (if any) precede originBeat's actual music, and how many
  // quarter-beats apart each one is (e.g. 0.5 for a 6/8 measure's dotted-eighth pulse) -- both
  // required (not optional) rather than defaulting an omitted field to 0/1: publishPlaybackState
  // does a *merge* write, so a field left out of a patch keeps its previous value in the shared
  // doc rather than resetting -- every publish that starts playback without an intentional
  // count-in must explicitly zero these, or a stale count-in from an earlier Play would silently
  // reattach itself to a later BPM/transpose/seek update.
  countInBeats: number;
  countInPulseBeats: number;
}

function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  }
  return id;
}

// localClock + offsetMs ~= serverClock. Estimated once per device via a round-trip measurement
// (see calibrateClockOffset) and refreshed periodically -- device clocks can drift, and a laptop
// sleep/mobile tab suspension can jump one noticeably.
let offsetMs = 0;

export function getServerTimeOffsetMs(): number {
  return offsetMs;
}

// A single round-trip measurement's error is bounded by roughly half its round-trip time, and
// network latency is rarely symmetric (upload/download queuing differ), so one sample alone can
// easily be 100-300ms off. Taking several and keeping the one with the lowest round-trip time --
// the sample that hit the least queuing/congestion in either direction -- is the standard NTP-
// client mitigation and meaningfully tightens the estimate without adding real complexity.
const CALIBRATION_SAMPLES = 5;

/**
 * NTP-style round-trip offset estimate: write a per-device doc with a serverTimestamp(), read it
 * straight back from the server (bypassing the local cache, which would just echo our own write
 * instantly and defeat the measurement), and estimate the server clock at the midpoint of the
 * round trip. Keyed by a per-device id rather than a shared doc -- two devices calibrating
 * concurrently against the same doc would corrupt each other's round-trip reading. Repeats this
 * CALIBRATION_SAMPLES times and keeps the lowest-round-trip-time sample (see the constant's
 * comment); one bad sample doesn't abort the rest, only a doc that never once resolves does.
 */
export async function calibrateClockOffset(): Promise<void> {
  if (!db) return;
  const ref = doc(db, 'sessions', `clockPing_${getDeviceId()}`);
  let best: { offsetMs: number; rttMs: number } | null = null;
  for (let i = 0; i < CALIBRATION_SAMPLES; i++) {
    try {
      const t0 = Date.now();
      await setDoc(ref, { ts: serverTimestamp() });
      const snap = await getDocFromServer(ref);
      const t1 = Date.now();
      const ts = snap.data()?.ts as Timestamp | undefined;
      if (!ts) continue;
      const rttMs = t1 - t0;
      if (!best || rttMs < best.rttMs) best = { offsetMs: ts.toMillis() - (t0 + rttMs / 2), rttMs };
    } catch {
      // This one sample failed (transient network blip) -- keep trying the rest.
    }
  }
  if (best) {
    offsetMs = best.offsetMs;
    return;
  }
  // Leave the previous (or default zero) offset in place; every sample failing outright is the
  // dangerous case though -- a *default* (never-succeeded) offset of 0 makes
  // computeFutureOriginServerTimeMs silently substitute this device's raw, unmeasured clock skew
  // from the server for the real offset, which can plausibly be a second or more on a device that
  // hasn't NTP-synced recently -- logged so it's diagnosable rather than a mysteriously "async"
  // sounding group. A likely cause if this keeps failing: Firestore security rules that only
  // cover sessions/live and not the whole sessions/** collection (this writes sessions/clockPing_*).
  console.warn('[AI-Capella] Clock calibration failed; synced playback may start noticeably out of sync on this device until it succeeds.');
}

/** Calibrates immediately, then periodically and whenever the tab becomes visible again. */
let calibrationAttempted: Promise<void> | null = null;
export function startPeriodicCalibration() {
  calibrationAttempted = calibrateClockOffset();
  setInterval(() => void calibrateClockOffset(), CALIBRATION_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void calibrateClockOffset();
  });
}

/**
 * Resolves once the first calibration attempt (success or failure) has finished. Broadcasting a
 * "start playing" instant before that point would compute it against the default offsetMs of 0
 * (see calibrateClockOffset's comment) instead of a real measurement -- awaited by every synced
 * "start playing" write in main.ts so the very first Play right after the app loads isn't the one
 * play that starts audibly out of sync. A no-op once the first attempt has already resolved.
 */
export async function ensureCalibrated(): Promise<void> {
  if (calibrationAttempted) await calibrationAttempted;
}

/**
 * The instant a "start playing" broadcast should target, in server time. `extraLeadMs` pushes
 * that instant further into the future -- needed for a count-in, whose clicks have to fit in the
 * gap before the music actually starts; the fixed PLAY_SYNC_BUFFER_MS alone is nowhere near long
 * enough for that (a one-measure count-in can easily take several seconds).
 */
export function computeFutureOriginServerTimeMs(extraLeadMs = 0): number {
  return Date.now() + offsetMs + PLAY_SYNC_BUFFER_MS + extraLeadMs;
}

/** Live-subscribes to the shared playback session; fires immediately and on every change from any device. */
export function subscribePlaybackState(callback: (state: PlaybackState | null) => void, onError: (err: unknown) => void): Unsubscribe {
  if (!db) {
    onError(new Error('Firebase is not configured'));
    return () => {};
  }
  return onSnapshot(
    doc(db, ...SESSION_DOC_PATH),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      const data = snap.data();
      callback({
        songId: (data.songId as string | null) ?? null,
        playing: (data.playing as boolean) ?? false,
        originBeat: (data.originBeat as number) ?? 0,
        originServerTimeMs: (data.originServerTimeMs as number) ?? 0,
        bpm: (data.bpm as number) ?? 100,
        transpose: (data.transpose as number) ?? 0,
        metronomeOn: (data.metronomeOn as boolean) ?? false,
        loopEnabled: (data.loopEnabled as boolean) ?? false,
        loopRegion: (data.loopRegion as LoopRegion | null) ?? null,
        countInBeats: (data.countInBeats as number) ?? 0,
        countInPulseBeats: (data.countInPulseBeats as number) ?? 1,
      });
    },
    onError,
  );
}

/** Merges the given fields into the shared playback session doc, creating it if it doesn't exist yet. */
export async function publishPlaybackState(patch: Partial<PlaybackState>): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  await setDoc(doc(db, ...SESSION_DOC_PATH), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
}
