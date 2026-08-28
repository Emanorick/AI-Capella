import './style.css';
import { parseMusicXML } from './musicxml';
import { parseMIDI } from './midi';
import { AudioEngine, type PartMixState } from './audioEngine';
import { PianoRoll, RULER_HEIGHT_PX, type LoopRegion } from './pianoRoll';
import { StaffView, STAFF_RULER_HEIGHT_PX } from './staffView';
import { colorForPartIndex } from './palette';
import { measureAtBeat, type Score } from './score';
import { deleteImportedSong, readScoreFile, saveImportedSong, subscribeToSongs, updateSongMetadata, type SongFormat } from './library';
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
  partNameOverrides?: Record<string, string>;
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
  <div id="landing">
    <h1>AI-Capella</h1>
    <p id="landing-subtitle">Practicing alone, or rehearsing together?</p>
    <button id="mode-solo-btn">Solo<span>Just this device -- nothing shared</span></button>
    <button id="mode-ensemble-btn">Ensemble<span>Synced playback with everyone else</span></button>
  </div>
  <aside id="library">
    <h1>AI-Capella</h1>
    <h2>Library</h2>
    <ul id="song-list"></ul>
    <button id="import-btn">+ Import score</button>
    <input id="import-input" type="file" accept=".musicxml,.xml,.mxl,.mid,.midi" multiple hidden />
    <div id="import-status"></div>
    <button id="switch-mode-btn" title="Switch between Solo and Ensemble mode"></button>
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
        <button id="view-toggle-btn" disabled title="Switch between piano roll and sheet music">Sheet Music</button>
        <div class="transport-group" id="bpm-group">
          <span class="transport-label">BPM</span>
          ${BPM_PRESETS.map((b) => `<button class="bpm-btn" data-bpm="${b}">${b}</button>`).join('')}
        </div>
        <div class="transport-group" id="measure-group">
          <span class="transport-label">Measure</span>
          <button id="measure-prev-btn" class="measure-step-btn" disabled title="Hold to jump back faster">&minus;</button>
          <input id="measure-input" type="number" min="1" step="1" inputmode="numeric" disabled />
          <button id="measure-go-btn" disabled>Go</button>
          <button id="measure-next-btn" class="measure-step-btn" disabled title="Hold to jump forward faster">&plus;</button>
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
    <canvas id="staff" class="hidden"></canvas>
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
const measureInput = document.querySelector<HTMLInputElement>('#measure-input')!;
const measureGoBtn = document.querySelector<HTMLButtonElement>('#measure-go-btn')!;
const measurePrevBtn = document.querySelector<HTMLButtonElement>('#measure-prev-btn')!;
const measureNextBtn = document.querySelector<HTMLButtonElement>('#measure-next-btn')!;
const canvas = document.querySelector<HTMLCanvasElement>('#roll')!;
const staffCanvas = document.querySelector<HTMLCanvasElement>('#staff')!;
const viewToggleBtn = document.querySelector<HTMLButtonElement>('#view-toggle-btn')!;

let currentScore: Score | null = null;
let audioEngine: AudioEngine | null = null;
let pianoRoll: PianoRoll | null = null;
let staffView: StaffView | null = null;
// Which view is currently visible -- a personal display preference like zoom, not synced across
// devices. The staff view is read-only (see StaffView's doc comment): it just displays and
// follows the shared beat position; every transport control lives on the shared bar regardless of
// which view is showing.
let activeView: 'roll' | 'staff' = 'roll';
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
// Whether the next Play should count-in (see PlaybackState.freshStart's doc comment in sync.ts).
// Kept in sync via applyPlaybackState the same way metronomeOn/loopEnabled are.
let freshStart = true;
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
// The full SongEntry for whatever's currently loaded -- used to know its format (for hiding the
// Sheet Music toggle on a MIDI import, task 3) and its imported/Firestore-id status (for gating
// rename editing to only actual library entries, task 4). loadedSongId alone isn't enough for
// either.
let currentSong: SongEntry | null = null;
let pendingSongId: string | null = null; // set when a remote songId isn't in our library list yet
let lastReceivedPlaybackState: PlaybackState | null = null;
let lastAppliedTiming: { playing: boolean; originBeat: number; originServerTimeMs: number; bpm: number; transpose: number; countInBeats: number; countInPulseBeats: number } | null = null;
let lastAppliedMetronomeOn = false;

function updateCanvasRect() {
  const rect = canvas.getBoundingClientRect();
  canvasLeft = rect.left;
  canvasTop = rect.top;
}
updateCanvasRect();

/**
 * The app opens on a landing screen (Solo vs. Ensemble, only when there's a shared backend to
 * choose between) the first time, then the library so you can browse/import scores; picking a
 * song switches to the player.
 */
function setViewMode(mode: 'landing' | 'library' | 'player') {
  app.classList.toggle('mode-landing', mode === 'landing');
  app.classList.toggle('mode-library', mode === 'library');
  app.classList.toggle('mode-player', mode === 'player');
  if (mode === 'player') {
    // The canvas was hidden (display:none) while in library mode, so its layout size wasn't
    // knowable until now.
    pianoRoll?.resize();
    staffView?.resize();
    updateCanvasRect();
    renderNow();
  }
}
libraryBackBtn.addEventListener('click', () => {
  // Publishes a normal synced Stop -- in Ensemble mode this stops every device, not just this
  // one, matching the expectation that leaving to browse the library shouldn't leave a song
  // silently still playing for the rest of the group. Safe no-op if nothing is loaded/playing
  // (stopPlayback's own guard).
  stopPlayback();
  setViewMode('library');
});

const MODE_STORAGE_KEY = 'ai-capella-mode';
// Solo = fully local, no shared playback session at all (even though Firebase may be
// configured) -- for practicing alone without nudging anyone else's playback. Ensemble = today's
// behavior, the single shared session. The shared song *library* stays available either way; only
// playback sync is gated by this choice. Resolved once at startup (see the bootstrap below) and
// changed only via the "switch mode" control, which just reloads -- there's no in-place teardown
// of an active Firestore subscription.
let sessionMode: 'solo' | 'ensemble' = 'solo';
function syncEnabled(): boolean {
  return isFirebaseConfigured && sessionMode === 'ensemble';
}

const switchModeBtn = document.querySelector<HTMLButtonElement>('#switch-mode-btn')!;
switchModeBtn.textContent = 'Switch mode';
switchModeBtn.addEventListener('click', () => {
  localStorage.removeItem(MODE_STORAGE_KEY);
  location.reload();
});

function chooseMode(mode: 'solo' | 'ensemble') {
  sessionMode = mode;
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  setViewMode('library');
  void runBootstrap();
}
document.querySelector<HTMLButtonElement>('#mode-solo-btn')!.addEventListener('click', () => chooseMode('solo'));
document.querySelector<HTMLButtonElement>('#mode-ensemble-btn')!.addEventListener('click', () => chooseMode('ensemble'));

// Mode resolution: a stored choice skips straight to the library; with no stored choice, show the
// landing screen only if there's actually a backend to choose Ensemble on -- otherwise Ensemble is
// meaningless and Solo is the only real option, so skip straight to the library as before this
// feature existed.
const storedMode = localStorage.getItem(MODE_STORAGE_KEY);
if (storedMode === 'solo' || storedMode === 'ensemble') {
  sessionMode = storedMode;
  setViewMode('library');
  void runBootstrap();
} else if (isFirebaseConfigured) {
  switchModeBtn.style.display = 'none'; // nothing to switch to yet -- no mode has been chosen
  setViewMode('landing');
} else {
  switchModeBtn.style.display = 'none'; // no backend at all -- there's no other mode to switch to
  setViewMode('library');
  void runBootstrap();
}

// Shared by the settings-toggle button and the mobile swipe-up/down gesture below. Sets the
// panel's max-height from its measured scrollHeight (rather than a guessed fixed value, which
// risks clipping a larger ensemble's wrapped controls on a narrow phone) before toggling the
// collapsed class, so the CSS max-height transition animates smoothly instead of snapping.
function toggleSettingsPanel() {
  const collapsed = settingsPanelEl.classList.contains('collapsed');
  settingsPanelEl.style.maxHeight = settingsPanelEl.scrollHeight + 'px';
  if (collapsed) {
    settingsPanelEl.classList.remove('collapsed');
  } else {
    // Forces the browser to apply the just-set max-height (the panel's full height) in one frame
    // before adding 'collapsed' sets it to 0 in the next -- without this the two style writes
    // would coalesce and there'd be nothing for the transition to animate from.
    requestAnimationFrame(() => settingsPanelEl.classList.add('collapsed'));
  }
  settingsToggleBtn.innerHTML = collapsed ? '&#9662;' : '&#9656;';
  settingsToggleBtn.title = collapsed ? 'Hide settings' : 'Show settings';
  settingsToggleBtn.setAttribute('aria-expanded', String(collapsed));
}
settingsToggleBtn.addEventListener('click', toggleSettingsPanel);
settingsPanelEl.addEventListener('transitionend', (e) => {
  if (e.propertyName !== 'max-height') return;
  // Collapsing/expanding changes how much vertical space the canvas has.
  pianoRoll?.resize();
  staffView?.resize();
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
    // Explicit, not omitted -- publishPlaybackState is a merge write, and a fresh song should
    // always be a fresh start regardless of whatever count-in/freshStart state was left over.
    countInBeats: 0,
    countInPulseBeats: 1,
    freshStart: true,
  });
}

/** Does the actual work of loading a song locally. Only ever called from applyPlaybackState(). */
async function loadSongLocally(song: SongEntry) {
  stopRenderLoop();
  const xmlText: string = song.xml !== undefined ? song.xml : await fetch(song.url!).then((r) => r.text());
  // Built-in songs (fetched by URL) and imported MusicXML/.mxl files are MusicXML text; MIDI
  // imports were already parsed into a Score at import time and stored as its JSON serialization.
  const score: Score = song.format === 'score' ? (JSON.parse(xmlText) as Score) : parseMusicXML(xmlText);
  if (song.partNameOverrides) {
    for (const part of score.parts) {
      const override = song.partNameOverrides[part.id];
      if (override) part.name = override;
    }
  }
  currentScore = score;
  currentSong = song;
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
  const partColor = (partId: string) => {
    const idx = score.parts.findIndex((p) => p.id === partId);
    return colorForPartIndex(idx);
  };
  pianoRoll = new PianoRoll(canvas, score, partColor);
  pianoRoll.setLoopRegion(null);
  staffView = new StaffView(staffCanvas, score, partColor);
  staffView.resize();
  viewToggleBtn.disabled = false;
  // MIDI imports have no real notated spelling -- only a heuristic chromatic fallback (see
  // staffView.ts) -- so the sheet-music view isn't offered for them at all. Force back to the
  // piano roll if the previous song was left showing the staff view.
  viewToggleBtn.classList.toggle('hidden', song.format === 'score');
  if (song.format === 'score' && activeView === 'staff') setActiveView('roll');

  // Mute/solo isn't synced (see PlaybackState's doc comment) -- every device starts a new song
  // with its own fresh, all-normal mix.
  partMix = new Map(score.parts.map((p) => [p.id, 'normal' as PartMixState]));
  pianoRoll.setPartMix(partMix);
  staffView?.setPartMix(partMix);

  songTitleEl.textContent = score.title;
  playBtn.disabled = false;
  playBtnMini.disabled = false;
  stopBtn.disabled = false;
  stopBtnMini.disabled = false;
  metronomeBtn.disabled = false;
  loopBtn.disabled = false;
  measureInput.disabled = false;
  measureGoBtn.disabled = false;
  measurePrevBtn.disabled = false;
  measureNextBtn.disabled = false;
  measureInput.max = String(score.measures.at(-1)?.number ?? 1);
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
    countInBeats: 0,
    countInPulseBeats: 1,
    freshStart,
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
  if (syncEnabled()) {
    void sync.publishPlaybackState(patch).catch((err) => {
      setImportStatus(`Couldn't sync: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  } else {
    // The sync-buffer skip below only applies when there's no count-in: a count-in still needs
    // real scheduling room even with nobody else to sync with, so it keeps a real future instant
    // instead of collapsing to "now."
    const local = patch.playing && !patch.countInBeats ? { ...patch, originServerTimeMs: 0 } : patch;
    void applyPlaybackState({ ...currentStateSnapshot(), ...local });
  }
}

/**
 * pushState() for every "start playing at this beat" patch (Play, seek-while-playing, BPM/
 * transpose change while playing) -- waits for clock calibration to have attempted at least once
 * first (see sync.ensureCalibrated's doc comment), so the very first Play right after the app
 * loads doesn't compute its sync target against a default, unmeasured offset. Callers stay
 * synchronous and fire this without awaiting it, so it never delays anything else the calling
 * handler does locally (e.g. seekToBeat's own view-position compensation). `extraLeadMs` (a
 * count-in's real duration) pushes the music's start instant further out so the count-in has room
 * to play before it -- see sync.computeFutureOriginServerTimeMs's doc comment.
 */
async function publishPlayingAt(originBeat: number, extra: Partial<PlaybackState> = {}, extraLeadMs = 0) {
  await sync.ensureCalibrated();
  pushState({ ...extra, playing: true, originBeat, originServerTimeMs: sync.computeFutureOriginServerTimeMs(extraLeadMs) });
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
  staffView?.setTranspose(transpose);
  loopEnabled = state.loopEnabled;
  loopRegion = state.loopRegion;
  pianoRoll?.setLoopRegion(loopRegion);
  updateLoopButton();
  // No side effect of its own (only read later, synchronously, inside togglePlay) -- kept
  // unconditional/undedup'd so it's never staler than necessary.
  freshStart = state.freshStart;

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
    lastAppliedTiming.transpose !== state.transpose ||
    lastAppliedTiming.countInBeats !== state.countInBeats ||
    lastAppliedTiming.countInPulseBeats !== state.countInPulseBeats;
  lastAppliedTiming = {
    playing: state.playing,
    originBeat: state.originBeat,
    originServerTimeMs: state.originServerTimeMs,
    bpm: state.bpm,
    transpose: state.transpose,
    countInBeats: state.countInBeats,
    countInPulseBeats: state.countInPulseBeats,
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
  audioEngine.play(state.originBeat, state.bpm, state.transpose, startAtEpochMs, state.countInBeats, state.countInPulseBeats);
  syncPlayButtons(true);
  startRenderLoop();
}

/**
 * Swaps `el` for an inline text input, prefilled with `initialValue` and focused/selected; Enter
 * or blur commits (calling `onCommit` only if the value is non-empty and actually changed),
 * Escape reverts. `el` itself is put back in place before `onCommit` runs, so the caller can
 * safely mutate it (e.g. set its text) once the write it kicks off actually succeeds.
 */
function startInlineEdit(el: HTMLElement, initialValue: string, onCommit: (value: string) => void) {
  const input = document.createElement('input');
  input.className = 'inline-edit-input';
  input.value = initialValue;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(el);
    if (commit && value && value !== initialValue) onCommit(value);
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
}

// Renaming only writes to Firestore for actual shared-library songs (currentSong.imported) --
// the bundled built-in sample has no Firestore doc to write to. Immediate, no confirmation step,
// matching the app's existing trust model (any device can already import/delete library songs
// the same way). #song-title and #parts-panel have no live onSnapshot subscription of their own
// (only the library sidebar does) -- so the local text is only updated here, once the write
// actually succeeds, rather than waiting on a round-trip that will never arrive for this
// already-open view.
songTitleEl.addEventListener('dblclick', () => {
  if (!currentSong?.imported || !currentScore) return;
  startInlineEdit(songTitleEl, currentScore.title, (value) => {
    void updateSongMetadata(currentSong!.id, { title: value })
      .then(() => {
        songTitleEl.textContent = value;
        if (currentScore) currentScore.title = value;
      })
      .catch((err) => console.warn('[AI-Capella] Failed to rename song:', err));
  });
});

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
  staffView?.setPartMix(partMix);
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
  staffView?.setPartMix(partMix);
  syncPartRowClasses();
  renderNow();
});

// Event delegation, not a per-span listener -- buildPartsPanel fully replaces partsPanelEl's
// innerHTML on every song load, which would orphan a direct listener.
partsPanelEl.addEventListener('dblclick', (e) => {
  const nameEl = (e.target as HTMLElement).closest<HTMLElement>('.part-name');
  const partId = nameEl?.closest<HTMLElement>('.part-row')?.getAttribute('data-part');
  const part = currentScore?.parts.find((p) => p.id === partId);
  if (!nameEl || !part || !currentSong?.imported) return;
  startInlineEdit(nameEl, part.name, (value) => {
    void updateSongMetadata(currentSong!.id, { partName: { partId: part.id, name: value } })
      .then(() => {
        part.name = value;
        nameEl.textContent = value;
      })
      .catch((err) => console.warn('[AI-Capella] Failed to rename voice:', err));
  });
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
    // A plain Pause -- resuming from here later should NOT count in, only a genuinely fresh start
    // should (see freshStart's doc comment in sync.ts).
    pushState({ playing: false, originBeat: audioEngine.getCurrentBeat(), originServerTimeMs: 0, freshStart: false });
  } else {
    let fromBeat = audioEngine.getPausedBeat();
    if (loopRegion) {
      fromBeat = loopRegion.start;
    } else if (fromBeat >= currentScore.totalBeats) {
      fromBeat = 0;
    }
    // A fresh Play with the metronome on gets a synced count-in ("Einzählen") -- one measure's
    // worth of clicks at the target measure's own time signature, so 6/8 etc. count in dotted-
    // eighth pulses rather than misreading the beats numerator as quarter-note pulses. Only a
    // genuinely fresh Play does this (metronome on AND freshStart) -- BPM/transpose changes and
    // seeks while already playing explicitly zero countInBeats (see those call sites), and a
    // plain Pause->Play resume never has freshStart set, so an ordinary tempo tweak or resuming
    // where you left off never re-triggers one.
    const measure = measureAtBeat(currentScore, fromBeat);
    const countInPulseBeats = measure ? 4 / measure.beatType : 1;
    const countInBeats = metronomeOn && measure && freshStart ? measure.beats : 0;
    const extraLeadMs = countInBeats > 0 ? countInBeats * countInPulseBeats * (60_000 / bpm) : 0;
    void publishPlayingAt(fromBeat, { countInBeats, countInPulseBeats }, extraLeadMs);
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

  pushState({ playing: false, originBeat: resetBeat, originServerTimeMs: 0, freshStart: true });
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
      // Explicitly zeroed, not omitted: publishPlaybackState is a merge write, so an omitted
      // field would keep whatever count-in the last fresh Play set, silently reattaching a
      // several-second count-in-then-delay to an ordinary BPM change.
      void publishPlayingAt(audioEngine.getCurrentBeat(), { bpm: newBpm, countInBeats: 0, countInPulseBeats: 1 });
    } else {
      pushState({ bpm: newBpm });
    }
  });
});
document.querySelector(`.bpm-btn[data-bpm="${bpm}"]`)?.classList.add('active');

// Proactively keeps the field's value in-range instead of relying on the native min/max
// validation -- an out-of-range value on a number input triggers the browser's own visual
// "invalid" feedback (a shake/wobble on mobile Safari in particular), which our own code has no
// control over and can't suppress after the fact. Clamping before that value is ever committed
// avoids it ever happening.
function clampMeasureInput() {
  if (!currentScore) return;
  const maxN = currentScore.measures.at(-1)?.number ?? 1;
  const n = Math.min(Math.max(parseInt(measureInput.value, 10) || 1, 1), maxN);
  measureInput.value = String(n);
}

function jumpToMeasure() {
  if (!currentScore) return;
  clampMeasureInput();
  const n = parseInt(measureInput.value, 10);
  const measure = currentScore.measures.find((m) => m.number === n);
  if (measure) seekToBeat(measure.startBeat, { recenterView: true });
}
measureGoBtn.addEventListener('click', jumpToMeasure);
measureInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') jumpToMeasure();
});
measureInput.addEventListener('change', clampMeasureInput);

// Plus/minus stepper for the measure number, with press-and-hold acceleration: a single tap
// moves one measure, but holding down repeats and speeds up over time -- the confirmed mobile
// substitute for typing a measure number, since numeric keyboards are slow to reach on a phone.
// Each step immediately jumps and recenters the view (same as pressing Go), so rapid taps or a
// hold both give live feedback rather than only updating the number field.
const STEPPER_INITIAL_DELAY_MS = 400;
const STEPPER_MIN_INTERVAL_MS = 60;
const STEPPER_ACCELERATION = 0.75;
let stepperTimeoutId: number | null = null;

function stepMeasure(delta: number) {
  if (!currentScore) return;
  const maxN = currentScore.measures.at(-1)?.number ?? 1;
  const current = parseInt(measureInput.value, 10) || 1;
  const next = Math.min(Math.max(current + delta, 1), maxN);
  if (next === current) return;
  measureInput.value = String(next);
  jumpToMeasure();
}

function startMeasureStepperHold(delta: number) {
  stepMeasure(delta);
  let intervalMs = STEPPER_INITIAL_DELAY_MS;
  const scheduleNext = () => {
    stepperTimeoutId = window.setTimeout(() => {
      stepMeasure(delta);
      intervalMs = Math.max(STEPPER_MIN_INTERVAL_MS, intervalMs * STEPPER_ACCELERATION);
      scheduleNext();
    }, intervalMs);
  };
  scheduleNext();
}

function stopMeasureStepperHold() {
  if (stepperTimeoutId != null) {
    clearTimeout(stepperTimeoutId);
    stepperTimeoutId = null;
  }
}

for (const [btn, delta] of [
  [measurePrevBtn, -1],
  [measureNextBtn, 1],
] as const) {
  btn.addEventListener('pointerdown', () => startMeasureStepperHold(delta));
  btn.addEventListener('pointerup', stopMeasureStepperHold);
  btn.addEventListener('pointerleave', stopMeasureStepperHold);
  btn.addEventListener('pointercancel', stopMeasureStepperHold);
}

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
    // See the BPM handler's comment: explicitly zeroed so a stale count-in never reattaches.
    void publishPlayingAt(audioEngine.getCurrentBeat(), { transpose: newTranspose, countInBeats: 0, countInPulseBeats: 1 });
  } else {
    pushState({ transpose: newTranspose });
  }
}
transposeDownBtn.addEventListener('click', () => applyTranspose(-1));
transposeUpBtn.addEventListener('click', () => applyTranspose(1));

function applyZoom(factor: number) {
  if (!pianoRoll && !staffView) return;
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
  pianoRoll?.setZoom(zoom);
  staffView?.setZoom(zoom);
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
/**
 * `recenterView`, when true (Measure-jump-Go), deliberately snaps the view to the new position
 * instead of holding it still -- the point of that control is navigation, "take me there." When
 * false (default; ruler/staff-ruler grid-lock tap), the view stays exactly where it was so the
 * screen doesn't jump for someone who's just marking a start point while reading elsewhere.
 */
function seekToBeat(beat: number, opts?: { recenterView?: boolean }) {
  if (!audioEngine || !currentScore || !pianoRoll) return;
  const clamped = Math.max(0, Math.min(currentScore.totalBeats, beat));
  const oldEngineBeat = engineBeat();
  if (audioEngine.isPlaying()) {
    // See the BPM handler's comment: explicitly zeroed so a stale count-in never reattaches.
    void publishPlayingAt(clamped, { countInBeats: 0, countInPulseBeats: 1 });
  } else {
    pushState({ playing: false, originBeat: clamped, originServerTimeMs: 0, freshStart: true });
  }
  if (opts?.recenterView) {
    viewOffsetBeats = 0;
  } else {
    // View-position compensation only, so the screen doesn't visibly jump for the person who just
    // tapped -- purely local, independent of the authoritative position change published above.
    viewOffsetBeats += oldEngineBeat - clamped;
  }
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
let dragStartTime = 0;
let dragLastX = 0;
let dragLastY = 0;
let dragMoved = false;
let dragAxis: 'x' | 'y' | null = null;
let loopSelectStartBeat: number | null = null;

// A vertical drag this fast and this short is a deliberate flick, not a scroll -- used below to
// toggle the mobile settings panel on a quick swipe, without needing a dedicated gesture zone.
const SWIPE_MAX_MS = 300;
const SWIPE_MIN_DY_PX = 40;

function clientXToBeat(clientX: number): number {
  return pianoRoll!.xToBeat(clientX - canvasLeft, displayBeat());
}

canvas.addEventListener('pointerdown', (e) => {
  if (!pianoRoll || !currentScore) return;
  dragPointerId = e.pointerId;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartTime = performance.now();
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
      // Snapped to the containing measure's start ("grid locking") so a slightly-off tap always
      // lands exactly on a measure boundary instead of wherever the pixel happened to map to.
      const snapped = currentScore ? (measureAtBeat(currentScore, loopSelectStartBeat)?.startBeat ?? loopSelectStartBeat) : loopSelectStartBeat;
      clearLoopRegion();
      seekToBeat(snapped);
    }
    loopSelectStartBeat = null;
  } else if (dragMoved && dragAxis === 'y') {
    // A quick vertical flick anywhere on the canvas collapses/expands the mobile settings panel
    // -- the pointermove handler above already applied a bit of vertical scroll live, before this
    // gesture could be classified as a swipe; leaving that small scroll in place (rather than
    // buffering and un-applying it) is an accepted trade-off for a cosmetic edge case.
    const elapsedMs = performance.now() - dragStartTime;
    const totalDy = e.clientY - dragStartY;
    if (elapsedMs < SWIPE_MAX_MS && Math.abs(totalDy) > SWIPE_MIN_DY_PX) {
      toggleSettingsPanel();
    }
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
      const keyboardMidi = pianoRoll.hitTestKeyboard(e.clientX - canvasLeft, e.clientY - canvasTop, displayBeat());
      // The keyboard strip near beat 0 (see pianoRoll.ts) isn't a real NoteEvent -- just plays the
      // tone, no preview label (nothing at its own beat position to anchor one to).
      if (keyboardMidi != null) audioEngine?.previewNote(keyboardMidi);
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
  if (audioEngine?.isCountingIn()) {
    setPositionText('Count-in…');
    return;
  }
  const measure = measureAtBeat(currentScore, beat);
  if (!measure) {
    setPositionText('—');
    return;
  }
  const pulseBeats = 4 / measure.beatType;
  const beatInMeasure = Math.floor((beat - measure.startBeat) / pulseBeats) + 1;
  setPositionText(`Measure ${measure.number} · Beat ${Math.min(beatInMeasure, measure.beats)}/${measure.beats}`);
}

/** Renders only whichever view is currently visible -- the hidden one costs nothing per frame. */
function renderActiveView(displayBeatValue: number, playheadBeatValue: number) {
  if (activeView === 'staff') staffView?.render(displayBeatValue, playheadBeatValue);
  else pianoRoll?.render(displayBeatValue, playheadBeatValue);
}

function renderNow() {
  if (!pianoRoll || !audioEngine) return;
  const beat = displayBeat();
  renderActiveView(beat, engineBeat());
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
    renderActiveView(resetBeat, resetBeat);
    updatePositionDisplay(resetBeat);
    rafId = null;
    return;
  }

  renderActiveView(beat + viewOffsetBeats, beat);
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
  staffView?.resize();
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
  staffView?.resize();
  updateCanvasRect();
  renderNow();
});
canvasResizeObserver.observe(canvas);
canvasResizeObserver.observe(staffCanvas);

function setActiveView(view: 'roll' | 'staff') {
  activeView = view;
  canvas.classList.toggle('hidden', activeView !== 'roll');
  staffCanvas.classList.toggle('hidden', activeView !== 'staff');
  viewToggleBtn.textContent = activeView === 'roll' ? 'Sheet Music' : 'Piano Roll';
  // The just-shown canvas may not have had a correct backing-store size while hidden
  // (display:none elements report a zero layout box), so resize before rendering into it.
  pianoRoll?.resize();
  staffView?.resize();
  updateCanvasRect();
  renderNow();
}

viewToggleBtn.addEventListener('click', () => {
  setActiveView(activeView === 'roll' ? 'staff' : 'roll');
});

staffCanvas.addEventListener(
  'wheel',
  (e) => {
    if (!staffView) return;
    e.preventDefault();
    if (e.shiftKey) {
      panByBeats(e.deltaX / staffView.getPixelsPerBeat());
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      panByBeats(e.deltaX / staffView.getPixelsPerBeat());
    } else if (e.deltaY !== 0) {
      staffView.scrollByPixels(e.deltaY);
      scheduleRender();
    }
  },
  { passive: false },
);

// Grid-lock click-to-seek in the staff view's own ruler strip, mirroring the piano roll's ruler
// tap. A plain click suffices (no drag/loop-region support here, by design -- see StaffView's
// class doc comment) since nothing else on this canvas handles pointerdown/drag today.
staffCanvas.addEventListener('click', (e) => {
  if (!staffView || !currentScore) return;
  const rect = staffCanvas.getBoundingClientRect();
  const localY = e.clientY - rect.top;
  if (localY >= STAFF_RULER_HEIGHT_PX) return;
  const localX = e.clientX - rect.left;
  const beat = staffView.xToBeat(localX, displayBeat());
  const snapped = measureAtBeat(currentScore, beat)?.startBeat ?? beat;
  seekToBeat(snapped);
});

/**
 * Invoked once the app's mode (Solo vs. Ensemble, or "no backend at all") is resolved -- either
 * immediately at startup (a stored choice, or no backend to choose on) or from the landing
 * screen's buttons. Sets up the shared song library (available in both modes) and, only in
 * Ensemble mode, the shared playback session.
 */
async function runBootstrap() {
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
    subscribeToSongs(
      (songs) => {
        importedSongs = songs.map((s) => ({ id: s.id, title: s.title, xml: s.xml, format: s.format, imported: true, partNameOverrides: s.partNameOverrides }));
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
    if (syncEnabled()) {
      sync.startPeriodicCalibration();
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
    }
  } catch (err) {
    setImportStatus(`Couldn't connect to the shared library: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}
