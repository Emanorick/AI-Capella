import './style.css';
import { parseMusicXML } from './musicxml';
import { parseMIDI } from './midi';
import { AudioEngine, type PartMixState } from './audioEngine';
import { PianoRoll, RULER_HEIGHT_PX, type LoopRegion } from './pianoRoll';
import { colorForPartIndex } from './palette';
import { measureAtBeat, type Score } from './score';
import { deleteImportedSong, readScoreFile, saveImportedSong, subscribeToSongs, type SongFormat } from './library';
import { ensureSignedIn, isFirebaseConfigured } from './firebase';
import { ensureAccess } from './pinGate';
import * as sync from './sync';
import type { PlaybackState } from './sync';

interface SongEntry {
  id: string;
  title: string;
  url?: string; // built-in songs, fetched on demand
  xml?: string; // imported songs, already in memory
  format?: SongFormat; // only meaningful alongside `xml`; built-in songs are always MusicXML
  imported?: boolean;
}

// import.meta.env.BASE_URL (not a bare "/...") since the app is served from a subpath on
// GitHub Pages (https://<user>.github.io/AI-Capella/) as well as from "/" in local dev.
const BUILTIN_SONGS: SongEntry[] = [
  { id: 'evening-rise', title: 'Evening Rise', url: `${import.meta.env.BASE_URL}evening-rise.musicxml` },
];
let importedSongs: SongEntry[] = [];
const ACCEPTED_EXTENSIONS = ['.musicxml', '.xml', '.mxl', '.mid', '.midi'];
const MIDI_EXTENSIONS = ['.mid', '.midi'];

const BPM_PRESETS = [50, 80, 100, 120, 140];
const DUCK_VOLUME_PRESETS = [0.1, 0.25, 0.5, 0.75];
const MIN_TRANSPOSE = -7;
const MAX_TRANSPOSE = 7;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
const VIEW_EDGE_SLACK_BEATS = 2;
const CLICK_DRAG_THRESHOLD_PX = 5;
const MIN_LOOP_BEATS = 0.5;
const PREVIEW_NOTE_LABEL_MS = 1200;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside id="library">
    <h1>AI-Capella</h1>
    <h2>Library</h2>
    <ul id="song-list"></ul>
    <button id="import-btn">+ Import score</button>
    <input id="import-input" type="file" accept=".musicxml,.xml,.mxl,.mid,.midi" multiple hidden />
    <div id="import-status"></div>
  </aside>
  <main id="workspace">
    <header id="song-header">
      <div id="header-left">
        <button id="library-back-btn" title="Back to library">&#8592; Library</button>
        <h2 id="song-title">Choose a song</h2>
      </div>
      <div id="header-right">
        <div id="position-display">—</div>
        <button id="stop-btn-mini" disabled title="Stop and reset to the start">&#9632;</button>
        <button id="play-btn-mini" disabled title="Play/Pause">&#9658;</button>
      </div>
    </header>
    <div id="settings-panel">
      <div id="parts-panel"></div>
      <div id="transport">
        <button id="play-btn" disabled>&#9658;</button>
        <button id="stop-btn" disabled title="Stop and reset to the start">&#9632;</button>
        <button id="metronome-btn" disabled>Metronome</button>
        <button id="loop-btn" disabled title="Drag the ruler above the roll to set a loop">Loop</button>
        <div class="transport-group" id="bpm-group">
          <span class="transport-label">BPM</span>
          ${BPM_PRESETS.map((b) => `<button class="bpm-btn" data-bpm="${b}">${b}</button>`).join('')}
        </div>
        <div class="transport-group" id="transpose-group">
          <span class="transport-label">Transpose</span>
          <button id="transpose-down">&minus;</button>
          <span id="transpose-value">0</span>
          <button id="transpose-up">&plus;</button>
        </div>
        <div class="transport-group" id="zoom-group">
          <span class="transport-label">Zoom</span>
          <button id="zoom-out">&minus;</button>
          <span id="zoom-value">100%</span>
          <button id="zoom-in">&plus;</button>
        </div>
        <div class="transport-group" id="duck-volume-group" title="Volume of the other voices while one is soloed">
          <span class="transport-label">Solo Volume</span>
          ${DUCK_VOLUME_PRESETS.map((v) => `<button class="duck-btn" data-duck="${v}">${Math.round(v * 100)}%</button>`).join('')}
        </div>
      </div>
    </div>
    <div id="settings-toggle-row">
      <button id="settings-toggle" title="Hide settings" aria-expanded="true">&#9662;</button>
    </div>
    <canvas id="roll"></canvas>
  </main>
`;

const songListEl = document.querySelector<HTMLUListElement>('#song-list')!;
const importBtn = document.querySelector<HTMLButtonElement>('#import-btn')!;
const importInput = document.querySelector<HTMLInputElement>('#import-input')!;
const importStatusEl = document.querySelector<HTMLDivElement>('#import-status')!;
const libraryEl = document.querySelector<HTMLElement>('#library')!;
const libraryBackBtn = document.querySelector<HTMLButtonElement>('#library-back-btn')!;
const songTitleEl = document.querySelector<HTMLHeadingElement>('#song-title')!;
const positionEl = document.querySelector<HTMLDivElement>('#position-display')!;
const settingsPanelEl = document.querySelector<HTMLDivElement>('#settings-panel')!;
const settingsToggleBtn = document.querySelector<HTMLButtonElement>('#settings-toggle')!;
const partsPanelEl = document.querySelector<HTMLDivElement>('#parts-panel')!;
const playBtn = document.querySelector<HTMLButtonElement>('#play-btn')!;
const playBtnMini = document.querySelector<HTMLButtonElement>('#play-btn-mini')!;
const stopBtn = document.querySelector<HTMLButtonElement>('#stop-btn')!;
const stopBtnMini = document.querySelector<HTMLButtonElement>('#stop-btn-mini')!;
const metronomeBtn = document.querySelector<HTMLButtonElement>('#metronome-btn')!;
const loopBtn = document.querySelector<HTMLButtonElement>('#loop-btn')!;
const transposeValueEl = document.querySelector<HTMLSpanElement>('#transpose-value')!;
const transposeDownBtn = document.querySelector<HTMLButtonElement>('#transpose-down')!;
const transposeUpBtn = document.querySelector<HTMLButtonElement>('#transpose-up')!;
const zoomValueEl = document.querySelector<HTMLSpanElement>('#zoom-value')!;
const zoomOutBtn = document.querySelector<HTMLButtonElement>('#zoom-out')!;
const zoomInBtn = document.querySelector<HTMLButtonElement>('#zoom-in')!;
const canvas = document.querySelector<HTMLCanvasElement>('#roll')!;

let currentScore: Score | null = null;
let audioEngine: AudioEngine | null = null;
let pianoRoll: PianoRoll | null = null;
let bpm = 100;
let duckVolume = 0.25;
let transpose = 0;
let zoom = 1;
let viewOffsetBeats = 0;
let metronomeOn = false;
let customStartBeat: number | null = null; // last spot set via the ruler; Stop returns here
let previewNoteTimeout: number | null = null;
let partMix = new Map<string, PartMixState>();
let loopRegion: LoopRegion | null = null;
let loopEnabled = false;
let rafId: number | null = null;
let renderPending = false;
let canvasLeft = 0;
let canvasTop = 0;

// Multi-device sync: which song is currently loaded locally, plus bookkeeping so an incoming
// shared-session update only actually touches AudioEngine when something timing-relevant
// (play/pause, position, bpm, transpose) genuinely changed -- an update that only changed the
// metronome, say, must NOT reschedule playback, or every remote toggle would audibly retrigger
// every currently-sounding note. See applyPlaybackState().
let loadedSongId: string | null = null;
let pendingSongId: string | null = null; // set when a remote songId isn't in our library list yet
let lastReceivedPlaybackState: PlaybackState | null = null;
let lastAppliedTiming: { playing: boolean; originBeat: number; originServerTimeMs: number; bpm: number; transpose: number } | null = null;
let lastAppliedMetronomeOn = false;

function updateCanvasRect() {
  const rect = canvas.getBoundingClientRect();
  canvasLeft = rect.left;
  canvasTop = rect.top;
}
updateCanvasRect();

/** The app opens on the library so you can browse/import scores; picking one switches to the player. */
function setViewMode(mode: 'library' | 'player') {
  app.classList.toggle('mode-library', mode === 'library');
  app.classList.toggle('mode-player', mode === 'player');
  if (mode === 'player') {
    // The canvas was hidden (display:none) while in library mode, so its layout size wasn't
    // knowable until now.
    pianoRoll?.resize();
    updateCanvasRect();
    renderNow();
  }
}
setViewMode('library');
libraryBackBtn.addEventListener('click', () => setViewMode('library'));

settingsToggleBtn.addEventListener('click', () => {
  const collapsed = settingsPanelEl.classList.toggle('collapsed');
  settingsToggleBtn.innerHTML = collapsed ? '&#9656;' : '&#9662;';
  settingsToggleBtn.title = collapsed ? 'Show settings' : 'Hide settings';
  settingsToggleBtn.setAttribute('aria-expanded', String(!collapsed));
  // Collapsing/expanding changes how much vertical space the canvas has.
  pianoRoll?.resize();
  updateCanvasRect();
  renderNow();
});

/**
 * Coalesces render requests to at most one per animation frame. Wheel/trackpad events and
 * pointermove can fire far faster than the display refreshes (100+/sec during a fast swipe);
 * rendering synchronously per event does far more repaint work than can ever be shown and was
 * the main source of stutter while panning.
 */
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderNow();
  });
}

function allSongs(): SongEntry[] {
  return [...BUILTIN_SONGS, ...importedSongs];
}

function renderSongList() {
  songListEl.innerHTML = allSongs()
    .map(
      (s) => `
      <li data-id="${s.id}">
        <button class="song-btn">${s.title}</button>
        ${s.imported ? '<button class="song-delete-btn" title="Remove from library">&times;</button>' : ''}
      </li>`,
    )
    .join('');
}
renderSongList();

songListEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const li = target.closest<HTMLElement>('li');
  const id = li?.getAttribute('data-id');
  if (!id) return;

  if (target.closest('.song-delete-btn')) {
    void removeImportedSong(id);
    return;
  }
  const song = allSongs().find((s) => s.id === id);
  if (song) selectSong(song);
});

async function removeImportedSong(id: string) {
  // No optimistic local removal: the shared onSnapshot listener updates `importedSongs` and
  // re-renders for every device (including this one) once Firestore reflects the delete.
  try {
    await deleteImportedSong(id);
  } catch (err) {
    setImportStatus(`Couldn't remove song: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

function setImportStatus(text: string, isError = false) {
  importStatusEl.textContent = text;
  importStatusEl.classList.toggle('error', isError);
}

async function importFiles(files: FileList | File[]) {
  if (!isFirebaseConfigured) {
    setImportStatus('Shared library not configured yet.', true);
    return;
  }
  const list = Array.from(files).filter((f) => ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)));
  if (!list.length) {
    setImportStatus('Choose a .musicxml, .xml, or .mxl file.', true);
    return;
  }

  let lastImported: SongEntry | null = null;
  for (const file of list) {
    try {
      const isMidi = MIDI_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
      let title: string;
      let xml: string;
      let format: SongFormat;
      if (isMidi) {
        // MIDI notes are already plain numeric pitches with no notation-level spelling to
        // reconstruct, so this stores the parsed Score directly (as JSON) rather than forcing it
        // through a synthetic MusicXML round-trip that would only add a lossy conversion step.
        const score = parseMIDI(await file.arrayBuffer());
        title = score.title && score.title !== 'Untitled' ? score.title : file.name.replace(/\.(mid|midi)$/i, '');
        xml = JSON.stringify(score);
        format = 'score';
      } else {
        xml = await readScoreFile(file);
        const score = parseMusicXML(xml); // validates the file and gives us a title
        title = score.title && score.title !== 'Untitled' ? score.title : file.name.replace(/\.(musicxml|xml|mxl)$/i, '');
        format = 'musicxml';
      }
      const id = await saveImportedSong({ title, xml, format });
      lastImported = { id, title, xml, format, imported: true };
      setImportStatus(`Imported "${title}" -- now available on every device.`);
    } catch (err) {
      setImportStatus(`Couldn't import ${file.name}: ${err instanceof Error ? err.message : 'invalid file'}`, true);
    }
  }
  // The onSnapshot listener will render the confirmed list; select the new song immediately
  // rather than waiting on that round trip.
  if (lastImported) selectSong(lastImported);
}

importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  if (importInput.files?.length) importFiles(importInput.files);
  importInput.value = '';
});
libraryEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  libraryEl.classList.add('drag-over');
});
libraryEl.addEventListener('dragleave', () => libraryEl.classList.remove('drag-over'));
libraryEl.addEventListener('drop', (e) => {
  e.preventDefault();
  libraryEl.classList.remove('drag-over');
  if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
});

/**
 * Announces a song choice to the shared session; every connected device (including this one)
 * actually loads it once that choice comes back through applyPlaybackState(), same as every other
 * control below -- see pushState()'s doc comment for why nothing here applies state directly.
 */
function selectSong(song: SongEntry) {
  pushState({
    songId: song.id,
    playing: false,
    originBeat: 0,
    originServerTimeMs: 0,
    transpose: 0,
    metronomeOn: false,
    loopEnabled: false,
    loopRegion: null,
  });
}

/** Does the actual work of loading a song locally. Only ever called from applyPlaybackState(). */
async function loadSongLocally(song: SongEntry) {
  stopRenderLoop();
  const xmlText: string = song.xml !== undefined ? song.xml : await fetch(song.url!).then((r) => r.text());
  // Built-in songs (fetched by URL) and imported MusicXML/.mxl files are MusicXML text; MIDI
  // imports were already parsed into a Score at import time and stored as its JSON serialization.
  const score: Score = song.format === 'score' ? (JSON.parse(xmlText) as Score) : parseMusicXML(xmlText);
  currentScore = score;
  loadedSongId = song.id;
  zoom = 1;
  zoomValueEl.textContent = '100%';
  viewOffsetBeats = 0;
  customStartBeat = null;
  // Force whatever timing/metronome state applyPlaybackState() applies right after this returns
  // to actually run against the brand-new AudioEngine below, rather than being skipped as
  // "unchanged" by comparison against the previous song's last-applied values.
  lastAppliedTiming = null;
  lastAppliedMetronomeOn = false;

  audioEngine = new AudioEngine(score);
  audioEngine.setDuckedVolume(duckVolume);
  pianoRoll = new PianoRoll(canvas, score, (partId) => {
    const idx = score.parts.findIndex((p) => p.id === partId);
    return colorForPartIndex(idx);
  });
  pianoRoll.setLoopRegion(null);

  // Mute/solo isn't synced (see PlaybackState's doc comment) -- every device starts a new song
  // with its own fresh, all-normal mix.
  partMix = new Map(score.parts.map((p) => [p.id, 'normal' as PartMixState]));
  pianoRoll.setPartMix(partMix);

  songTitleEl.textContent = score.title;
  playBtn.disabled = false;
  playBtnMini.disabled = false;
  stopBtn.disabled = false;
  stopBtnMini.disabled = false;
  metronomeBtn.disabled = false;
  loopBtn.disabled = false;
  buildPartsPanel(score);
  setViewMode('player');
}

/** The full shared-session shape reconstructed from this device's own current state. */
function currentStateSnapshot(): PlaybackState {
  return {
    songId: loadedSongId,
    playing: audioEngine?.isPlaying() ?? false,
    originBeat: engineBeat(),
    originServerTimeMs: 0,
    bpm,
    transpose,
    metronomeOn,
    loopEnabled,
    loopRegion,
  };
}

/**
 * The single way every synced control below changes playback/loop state: publish the change and
 * let it come back through applyPlaybackState(), rather than mutating local state directly. This
 * mirrors a pattern the shared song library already used (deleting a song updates every device,
 * including the one that clicked delete, only once Firestore reflects it) -- applied consistently
 * to every transport control instead of just song deletion. Without Firebase configured there's no
 * shared session to round-trip through, so state is applied immediately instead (single-device
 * fallback, matching this app's pre-sync behavior); a "start playing" patch has its sync-buffer
 * origin timestamp zeroed in that case, so AudioEngine.play() takes its normal "as soon as
 * possible" path instead of waiting for a sync instant nothing else is listening for.
 * Mute/solo/true-solo are the one exception -- deliberately local-only, see PlaybackState's doc
 * comment in sync.ts -- so they mutate state directly instead of going through here.
 */
function pushState(patch: Partial<PlaybackState>) {
  if (isFirebaseConfigured) {
    void sync.publishPlaybackState(patch).catch((err) => {
      setImportStatus(`Couldn't sync: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  } else {
    const local = patch.playing ? { ...patch, originServerTimeMs: 0 } : patch;
    void applyPlaybackState({ ...currentStateSnapshot(), ...local });
  }
}

/** The single place that applies shared-session state locally -- see pushState()'s doc comment. */
async function applyPlaybackState(state: PlaybackState) {
  if (state.songId !== loadedSongId) {
    if (!state.songId) return; // nothing selected yet (fresh/empty session)
    const song = allSongs().find((s) => s.id === state.songId);
    if (!song) {
      pendingSongId = state.songId;
      setImportStatus('Waiting for the shared song to finish syncing…');
      return;
    }
    pendingSongId = null;
    await loadSongLocally(song);
  }

  bpm = state.bpm;
  document.querySelectorAll<HTMLButtonElement>('.bpm-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-bpm') === String(bpm)));
  transpose = state.transpose;
  transposeValueEl.textContent = transpose > 0 ? `+${transpose}` : String(transpose);
  pianoRoll?.setTranspose(transpose);
  loopEnabled = state.loopEnabled;
  loopRegion = state.loopRegion;
  pianoRoll?.setLoopRegion(loopRegion);
  updateLoopButton();

  if (!audioEngine) return;

  if (state.metronomeOn !== lastAppliedMetronomeOn) {
    lastAppliedMetronomeOn = state.metronomeOn;
    metronomeOn = state.metronomeOn;
    metronomeBtn.classList.toggle('active', metronomeOn);
    audioEngine.setMetronomeEnabled(metronomeOn);
  }

  const timingChanged =
    !lastAppliedTiming ||
    lastAppliedTiming.playing !== state.playing ||
    lastAppliedTiming.originBeat !== state.originBeat ||
    lastAppliedTiming.originServerTimeMs !== state.originServerTimeMs ||
    lastAppliedTiming.bpm !== state.bpm ||
    lastAppliedTiming.transpose !== state.transpose;
  lastAppliedTiming = {
    playing: state.playing,
    originBeat: state.originBeat,
    originServerTimeMs: state.originServerTimeMs,
    bpm: state.bpm,
    transpose: state.transpose,
  };
  if (!timingChanged) return;

  viewOffsetBeats = 0;
  if (!state.playing) {
    audioEngine.stop();
    audioEngine.setPausedBeat(state.originBeat);
    customStartBeat = state.originBeat > 0 ? state.originBeat : null;
    syncPlayButtons(false);
    stopRenderLoop();
    renderNow();
    return;
  }
  // A zero originServerTimeMs is the single-device-fallback sentinel from pushState() above --
  // no shared instant to translate, so AudioEngine.play() falls back to its own "now" default.
  const startAtEpochMs = state.originServerTimeMs > 0 ? state.originServerTimeMs - sync.getServerTimeOffsetMs() : undefined;
  audioEngine.play(state.originBeat, state.bpm, state.transpose, startAtEpochMs);
  syncPlayButtons(true);
  startRenderLoop();
}

function buildPartsPanel(score: Score) {
  partsPanelEl.innerHTML = score.parts
    .map((p, idx) => {
      const color = colorForPartIndex(idx);
      return `
      <div class="part-row" data-part="${p.id}">
        <span class="swatch" style="background:${color}"></span>
        <span class="part-name">${p.name}</span>
        <button class="mix-btn mute-btn" data-action="muted">M</button>
        <button class="mix-btn solo-btn" data-action="solo">S</button>
      </div>`;
    })
    .join('');
}

function syncPartRowClasses() {
  partsPanelEl.querySelectorAll<HTMLElement>('.part-row').forEach((row) => {
    const partId = row.getAttribute('data-part')!;
    const state = partMix.get(partId) ?? 'normal';
    row.classList.toggle('is-muted', state === 'muted');
    row.classList.toggle('is-solo', state === 'solo');
  });
}

/**
 * "True solo": mutes AND hides every other voice so only this one is visible/audible (unlike the
 * Solo button, which just ducks/dims the others). Clicking the same voice again restores everyone.
 */
function toggleTrueSolo(partId: string) {
  if (!audioEngine || !pianoRoll || !currentScore) return;
  const alreadyIsolated =
    partMix.get(partId) !== 'muted' && currentScore.parts.every((p) => p.id === partId || partMix.get(p.id) === 'muted');
  for (const p of currentScore.parts) {
    const next: PartMixState = alreadyIsolated || p.id === partId ? 'normal' : 'muted';
    partMix.set(p.id, next);
    audioEngine.setPartMixState(p.id, next);
  }
  pianoRoll.setPartMix(partMix);
  syncPartRowClasses();
  renderNow();
}

partsPanelEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.part-row');
  if (!row || !audioEngine || !pianoRoll) return;
  const partId = row.getAttribute('data-part')!;
  const action = target.getAttribute('data-action') as PartMixState | null;

  if (!action) {
    toggleTrueSolo(partId);
    return;
  }

  const current = partMix.get(partId) ?? 'normal';
  const next: PartMixState = current === action ? 'normal' : action;
  partMix.set(partId, next);
  audioEngine.setPartMixState(partId, next);
  pianoRoll.setPartMix(partMix);
  syncPartRowClasses();
  renderNow();
});

/** Keeps the header's compact play button and the transport's full one showing the same state. */
function syncPlayButtons(playing: boolean) {
  const icon = playing ? '&#10074;&#10074;' : '&#9658;';
  playBtn.innerHTML = icon;
  playBtnMini.innerHTML = icon;
}

function togglePlay() {
  if (!audioEngine || !currentScore || playBtn.disabled) return;
  if (audioEngine.isPlaying()) {
    pushState({ playing: false, originBeat: audioEngine.getCurrentBeat(), originServerTimeMs: 0 });
  } else {
    let fromBeat = audioEngine.getPausedBeat();
    if (loopRegion) {
      fromBeat = loopRegion.start;
    } else if (fromBeat >= currentScore.totalBeats) {
      fromBeat = 0;
    }
    pushState({ playing: true, originBeat: fromBeat, originServerTimeMs: sync.computeFutureOriginServerTimeMs() });
  }
}
playBtn.addEventListener('click', togglePlay);
playBtnMini.addEventListener('click', togglePlay);

/** Stops playback and resets to the loop region's start, the last ruler-set start point, or the beginning. */
function stopPlayback() {
  if (!audioEngine || !pianoRoll || stopBtn.disabled) return;
  const wasPlaying = audioEngine.isPlaying();
  const priorPausedBeat = audioEngine.getPausedBeat();
  const target = loopRegion ? loopRegion.start : (customStartBeat ?? 0);
  // Pressing Stop again while already stopped at the target (loop/custom start) goes the rest of
  // the way to the very beginning, same as a media player's Stop button.
  const alreadyAtTarget = !wasPlaying && Math.abs(priorPausedBeat - target) < 0.01;
  const resetBeat = alreadyAtTarget ? 0 : target;

  pushState({ playing: false, originBeat: resetBeat, originServerTimeMs: 0 });
}
stopBtn.addEventListener('click', stopPlayback);
stopBtnMini.addEventListener('click', stopPlayback);

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  togglePlay();
});

metronomeBtn.addEventListener('click', () => {
  if (!audioEngine) return;
  pushState({ metronomeOn: !metronomeOn });
});

function updateLoopButton() {
  loopBtn.classList.toggle('active', loopEnabled);
  if (loopRegion) {
    loopBtn.title = loopEnabled
      ? `Looping ${loopRegion.start.toFixed(1)}–${loopRegion.end.toFixed(1)} (click to stop there instead)`
      : `Loop region set, off — click to loop it (drag the ruler to redefine)`;
  } else {
    loopBtn.title = loopEnabled
      ? 'Looping the whole piece (drag the ruler above the roll to loop a region instead)'
      : 'Click to loop the whole piece, or drag the ruler above the roll to loop a region';
  }
}
loopBtn.addEventListener('click', () => {
  if (!currentScore) return;
  pushState({ loopEnabled: !loopEnabled });
});

document.querySelectorAll<HTMLButtonElement>('.bpm-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const newBpm = parseInt(btn.getAttribute('data-bpm')!, 10);
    if (audioEngine?.isPlaying()) {
      pushState({ bpm: newBpm, playing: true, originBeat: audioEngine.getCurrentBeat(), originServerTimeMs: sync.computeFutureOriginServerTimeMs() });
    } else {
      pushState({ bpm: newBpm });
    }
  });
});
document.querySelector(`.bpm-btn[data-bpm="${bpm}"]`)?.classList.add('active');

document.querySelectorAll<HTMLButtonElement>('.duck-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    duckVolume = parseFloat(btn.getAttribute('data-duck')!);
    document.querySelectorAll('.duck-btn').forEach((b) => b.classList.toggle('active', b === btn));
    audioEngine?.setDuckedVolume(duckVolume);
  });
});
document.querySelector(`.duck-btn[data-duck="${duckVolume}"]`)?.classList.add('active');

function applyTranspose(delta: number) {
  if (!audioEngine || !pianoRoll) return;
  const newTranspose = Math.max(MIN_TRANSPOSE, Math.min(MAX_TRANSPOSE, transpose + delta));
  if (audioEngine.isPlaying()) {
    pushState({ transpose: newTranspose, playing: true, originBeat: audioEngine.getCurrentBeat(), originServerTimeMs: sync.computeFutureOriginServerTimeMs() });
  } else {
    pushState({ transpose: newTranspose });
  }
}
transposeDownBtn.addEventListener('click', () => applyTranspose(-1));
transposeUpBtn.addEventListener('click', () => applyTranspose(1));

function applyZoom(factor: number) {
  if (!pianoRoll) return;
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
  pianoRoll.setZoom(zoom);
  zoomValueEl.textContent = `${Math.round(zoom * 100)}%`;
  clampViewOffset();
  renderNow();
}
zoomOutBtn.addEventListener('click', () => applyZoom(1 / ZOOM_STEP));
zoomInBtn.addEventListener('click', () => applyZoom(ZOOM_STEP));

function engineBeat(): number {
  if (!audioEngine) return 0;
  return audioEngine.isPlaying() ? audioEngine.getCurrentBeat() : audioEngine.getPausedBeat();
}

function displayBeat(): number {
  return engineBeat() + viewOffsetBeats;
}

function clampViewOffset() {
  if (!currentScore) return;
  const base = engineBeat();
  const display = base + viewOffsetBeats;
  const clamped = Math.max(-VIEW_EDGE_SLACK_BEATS, Math.min(currentScore.totalBeats + VIEW_EDGE_SLACK_BEATS, display));
  viewOffsetBeats = clamped - base;
}

function panByBeats(deltaBeats: number) {
  if (!pianoRoll) return;
  // Keep the view locked to the actual playback position while playing: panning it away is
  // exactly what put the red line out of sync with the music (the view would show a different
  // beat than the one actually sounding, since the line's screen x is fixed but the beat under it
  // becomes whatever was panned to). Still allowed while paused/stopped, to browse the score.
  if (audioEngine?.isPlaying()) return;
  viewOffsetBeats += deltaBeats;
  clampViewOffset();
  scheduleRender();
}

/**
 * Sets where the next Play (or an already-playing transport) should be, without moving the
 * view: the beat under the click stays under the same screen x, so scrolling never jumps.
 */
function seekToBeat(beat: number) {
  if (!audioEngine || !currentScore || !pianoRoll) return;
  const clamped = Math.max(0, Math.min(currentScore.totalBeats, beat));
  const oldEngineBeat = engineBeat();
  if (audioEngine.isPlaying()) {
    pushState({ playing: true, originBeat: clamped, originServerTimeMs: sync.computeFutureOriginServerTimeMs() });
  } else {
    pushState({ playing: false, originBeat: clamped, originServerTimeMs: 0 });
  }
  // View-position compensation only, so the screen doesn't visibly jump for the person who just
  // tapped -- purely local, independent of the authoritative position change published above.
  viewOffsetBeats += oldEngineBeat - clamped;
  clampViewOffset();
  renderNow();
}

function clearLoopRegion() {
  if (!loopRegion) return;
  pushState({ loopRegion: null });
}

function finalizeLoopSelection(beatA: number, beatB: number) {
  if (!currentScore || !pianoRoll) return;
  const start = Math.max(0, Math.min(beatA, beatB));
  const end = Math.min(currentScore.totalBeats, Math.max(beatA, beatB));
  if (end - start < MIN_LOOP_BEATS) {
    pushState({ loopRegion: null });
  } else {
    pushState({ loopRegion: { start, end }, loopEnabled: true });
  }
}

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!pianoRoll) return;
    e.preventDefault();
    if (e.shiftKey) {
      panByBeats(e.deltaY / pianoRoll.getPixelsPerBeat());
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Trackpad gestures are rarely perfectly axis-aligned; picking whichever delta actually
      // dominates (rather than "any nonzero deltaX means horizontal") keeps an intended vertical
      // scroll from bleeding a little horizontal pan into the view on every tick.
      panByBeats(e.deltaX / pianoRoll.getPixelsPerBeat());
    } else if (e.deltaY !== 0) {
      pianoRoll.scrollByPixels(e.deltaY);
      scheduleRender();
    }
  },
  { passive: false },
);

let dragPointerId: number | null = null;
let dragStartX = 0;
let dragStartY = 0;
let dragLastX = 0;
let dragLastY = 0;
let dragMoved = false;
let dragAxis: 'x' | 'y' | null = null;
let loopSelectStartBeat: number | null = null;

function clientXToBeat(clientX: number): number {
  return pianoRoll!.xToBeat(clientX - canvasLeft, displayBeat());
}

canvas.addEventListener('pointerdown', (e) => {
  if (!pianoRoll || !currentScore) return;
  dragPointerId = e.pointerId;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragLastX = e.clientX;
  dragLastY = e.clientY;
  dragMoved = false;
  dragAxis = null;
  canvas.setPointerCapture(e.pointerId);

  // The ruler strip at the top of the roll is the only place that sets the playback start point
  // or a loop region -- everywhere else, clicking/scrolling can't accidentally jump playback.
  if (e.clientY - canvasTop < RULER_HEIGHT_PX) {
    loopSelectStartBeat = clientXToBeat(e.clientX);
  } else {
    loopSelectStartBeat = null;
    canvas.classList.add('dragging');
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (dragPointerId !== e.pointerId || !pianoRoll) return;
  const totalDx = e.clientX - dragStartX;
  const totalDy = e.clientY - dragStartY;
  if (Math.hypot(totalDx, totalDy) > CLICK_DRAG_THRESHOLD_PX) dragMoved = true;

  if (loopSelectStartBeat != null) {
    const endBeat = clientXToBeat(e.clientX);
    pianoRoll.setLoopRegion({
      start: Math.min(loopSelectStartBeat, endBeat),
      end: Math.max(loopSelectStartBeat, endBeat),
    });
    scheduleRender();
  } else {
    // Lock to whichever axis the drag committed to early on: real pointer movement is rarely
    // perfectly straight, and applying both axes' deltas on every move let a drag meant as
    // vertical-only bleed a little horizontal pan into the view (and vice versa) on every tick.
    if (dragAxis === null && dragMoved) dragAxis = Math.abs(totalDx) > Math.abs(totalDy) ? 'x' : 'y';
    const dx = e.clientX - dragLastX;
    const dy = e.clientY - dragLastY;
    if (dragAxis !== 'y') panByBeats(-dx / pianoRoll.getPixelsPerBeat());
    if (dragAxis !== 'x') pianoRoll.scrollByPixels(-dy);
    scheduleRender();
  }
  dragLastX = e.clientX;
  dragLastY = e.clientY;
});
function endDrag(e: PointerEvent) {
  if (dragPointerId !== e.pointerId) return;
  dragPointerId = null;
  canvas.classList.remove('dragging');

  if (loopSelectStartBeat != null) {
    if (dragMoved) {
      finalizeLoopSelection(loopSelectStartBeat, clientXToBeat(e.clientX));
    } else {
      // A tap (not a drag) in the ruler just sets the start point, same as the old plain click.
      // seekToBeat's published originBeat is what sets customStartBeat, via applyPlaybackState.
      clearLoopRegion();
      seekToBeat(loopSelectStartBeat);
    }
    loopSelectStartBeat = null;
  } else if (!dragMoved && currentScore && pianoRoll) {
    // A tap in the note area (not the ruler) only previews whatever note is under it -- it never
    // moves playback, so casual clicks or short scrolls while playing can't jump the position.
    const hit = pianoRoll.hitTestNote(e.clientX - canvasLeft, e.clientY - canvasTop, displayBeat());
    if (previewNoteTimeout != null) {
      clearTimeout(previewNoteTimeout);
      previewNoteTimeout = null;
    }
    if (hit) {
      audioEngine?.previewNote(hit.midi);
      pianoRoll.setPreviewNote({ startBeat: hit.startBeat, midi: hit.midi });
      // The label is only shown briefly, while the tone plays -- not left on screen until the
      // next click.
      previewNoteTimeout = window.setTimeout(() => {
        previewNoteTimeout = null;
        pianoRoll?.setPreviewNote(null);
        renderNow();
      }, PREVIEW_NOTE_LABEL_MS);
    } else {
      pianoRoll.setPreviewNote(null);
    }
    // Unlike during playback (where the render loop repaints every frame regardless), nothing
    // else forces a redraw while paused -- without this the tone would play but its label would
    // never actually appear on screen until some other interaction happened to trigger one.
    renderNow();
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => {
  dragPointerId = null;
  loopSelectStartBeat = null;
  canvas.classList.remove('dragging');
});

let lastPositionText = '';
function setPositionText(text: string) {
  // During playback this runs every animation frame; writing textContent unconditionally forces
  // a style/layout invalidation even when the displayed string hasn't actually changed (which is
  // most frames, since it only changes once per beat).
  if (text === lastPositionText) return;
  lastPositionText = text;
  positionEl.textContent = text;
}

function updatePositionDisplay(beat: number) {
  if (!currentScore) return;
  const measure = measureAtBeat(currentScore, beat);
  if (!measure) {
    setPositionText('—');
    return;
  }
  const pulseBeats = 4 / measure.beatType;
  const beatInMeasure = Math.floor((beat - measure.startBeat) / pulseBeats) + 1;
  setPositionText(`Measure ${measure.number} · Beat ${Math.min(beatInMeasure, measure.beats)}/${measure.beats}`);
}

function renderNow() {
  if (!pianoRoll || !audioEngine) return;
  const beat = displayBeat();
  pianoRoll.render(beat, engineBeat());
  updatePositionDisplay(beat);
}

function renderLoop() {
  if (!audioEngine || !pianoRoll || !currentScore) return;
  audioEngine.tick(); // tops up the bounded lookahead schedule as playback progresses
  const beat = audioEngine.getCurrentBeat();
  // A loop region, once marked, bounds playback; the Loop button decides whether hitting that
  // bound (or the end of the piece, when no region is marked) wraps around or stops there.
  const boundary = loopRegion ? loopRegion.end : currentScore.totalBeats;

  if (beat >= boundary) {
    if (loopEnabled) {
      const loopStart = loopRegion ? loopRegion.start : 0;
      audioEngine.play(loopStart, bpm, transpose);
      rafId = requestAnimationFrame(renderLoop);
      return;
    }

    const resetBeat = loopRegion ? loopRegion.start : 0;
    audioEngine.stop();
    audioEngine.setPausedBeat(resetBeat);
    viewOffsetBeats = 0;
    syncPlayButtons(false);
    pianoRoll.render(resetBeat, resetBeat);
    updatePositionDisplay(resetBeat);
    rafId = null;
    return;
  }

  pianoRoll.render(beat + viewOffsetBeats, beat);
  updatePositionDisplay(beat + viewOffsetBeats);
  rafId = requestAnimationFrame(renderLoop);
}
function startRenderLoop() {
  if (rafId == null) rafId = requestAnimationFrame(renderLoop);
}
function stopRenderLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

window.addEventListener('resize', () => {
  pianoRoll?.resize();
  updateCanvasRect();
  renderNow();
});

// Mobile browsers can change the canvas's actual laid-out size (address bar show/hide, dynamic
// toolbar, app-switcher return) without firing a window 'resize' event -- when that happened, the
// canvas kept rendering at its old (now stale) cssWidth/cssHeight while the element itself sat in
// a differently-sized box, leaving raw unpainted canvas showing as a black area next to the
// content. ResizeObserver watches the canvas's own box directly, so it catches every case.
const canvasResizeObserver = new ResizeObserver(() => {
  pianoRoll?.resize();
  updateCanvasRect();
  renderNow();
});
canvasResizeObserver.observe(canvas);

(async () => {
  // The app opens on the library view (see setViewMode above); no song is auto-loaded.
  if (!isFirebaseConfigured) {
    importBtn.disabled = true;
    importBtn.title = 'Shared library not configured yet';
    return;
  }

  try {
    // Sign in first: verifyPin (inside ensureAccess) reads Firestore, and the security rules
    // require request.auth != null, so an unsigned-in read would just hang/get rejected.
    await ensureSignedIn();
    await ensureAccess(); // PIN gate; resolves immediately if already granted on this device
    sync.startPeriodicCalibration();
    subscribeToSongs(
      (songs) => {
        importedSongs = songs.map((s) => ({ id: s.id, title: s.title, xml: s.xml, format: s.format, imported: true }));
        renderSongList();
        // A remote songId can arrive before this device's own library listener has caught up
        // with it (e.g. it was just imported elsewhere) -- re-apply the last state we got once
        // the library list might actually contain it.
        if (pendingSongId && lastReceivedPlaybackState && allSongs().some((s) => s.id === pendingSongId)) {
          void applyPlaybackState(lastReceivedPlaybackState);
        }
      },
      (err) => {
        setImportStatus(`Shared library unavailable: ${err instanceof Error ? err.message : String(err)}`, true);
      },
    );
    sync.subscribePlaybackState(
      (state) => {
        if (!state) return;
        lastReceivedPlaybackState = state;
        void applyPlaybackState(state);
      },
      (err) => {
        setImportStatus(`Shared session unavailable: ${err instanceof Error ? err.message : String(err)}`, true);
      },
    );
  } catch (err) {
    setImportStatus(`Couldn't connect to the shared library: ${err instanceof Error ? err.message : String(err)}`, true);
  }
})();
