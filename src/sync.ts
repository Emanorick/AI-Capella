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

/**
 * NTP-style round-trip offset estimate: write a per-device doc with a serverTimestamp(), read it
 * straight back from the server (bypassing the local cache, which would just echo our own write
 * instantly and defeat the measurement), and estimate the server clock at the midpoint of the
 * round trip. Keyed by a per-device id rather than a shared doc -- two devices calibrating
 * concurrently against the same doc would corrupt each other's round-trip reading.
 */
export async function calibrateClockOffset(): Promise<void> {
  if (!db) return;
  try {
    const ref = doc(db, 'sessions', `clockPing_${getDeviceId()}`);
    const t0 = Date.now();
    await setDoc(ref, { ts: serverTimestamp() });
    const snap = await getDocFromServer(ref);
    const t1 = Date.now();
    const ts = snap.data()?.ts as Timestamp | undefined;
    if (!ts) return;
    offsetMs = ts.toMillis() - (t0 + (t1 - t0) / 2);
  } catch {
    // Leave the previous (or default zero) offset in place; a stale/missing calibration just
    // means the sync buffer absorbs a bit more slack than ideal, not a hard failure.
  }
}

/** Calibrates immediately, then periodically and whenever the tab becomes visible again. */
export function startPeriodicCalibration() {
  void calibrateClockOffset();
  setInterval(() => void calibrateClockOffset(), CALIBRATION_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void calibrateClockOffset();
  });
}

/** The instant a "start playing" broadcast should target, in server time. */
export function computeFutureOriginServerTimeMs(): number {
  return Date.now() + offsetMs + PLAY_SYNC_BUFFER_MS;
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
