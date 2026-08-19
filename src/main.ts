import './style.css';
import { parseMusicXML } from './musicxml';
import { AudioEngine, type PartMixState } from './audioEngine';
import { PianoRoll, type LoopRegion } from './pianoRoll';
import { colorForPartIndex } from './palette';
import { measureAtBeat, type Score } from './score';
import { deleteImportedSong, readScoreFile, saveImportedSong, subscribeToSongs } from './library';
import { ensureSignedIn, isFirebaseConfigured } from './firebase';
import { ensureAccess } from './pinGate';

interface SongEntry {
  id: string;
  title: string;
  url?: string; // built-in songs, fetched on demand
  xml?: string; // imported songs, already in memory
  imported?: boolean;
}

// import.meta.env.BASE_URL (not a bare "/...") since the app is served from a subpath on
// GitHub Pages (https://<user>.github.io/AI-Capella/) as well as from "/" in local dev.
const BUILTIN_SONGS: SongEntry[] = [
  { id: 'evening-rise', title: 'Evening Rise', url: `${import.meta.env.BASE_URL}evening-rise.musicxml` },
];
let importedSongs: SongEntry[] = [];
const ACCEPTED_EXTENSIONS = ['.musicxml', '.xml', '.mxl'];

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

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside id="library">
    <h1>AI-Capella</h1>
    <h2>Library</h2>
    <ul id="song-list"></ul>
    <button id="import-btn">+ Import score</button>
    <input id="import-input" type="file" accept=".musicxml,.xml,.mxl" multiple hidden />
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
        <button id="settings-toggle" title="Hide settings" aria-expanded="true">&#9662;</button>
      </div>
    </header>
    <div id="settings-panel">
      <div id="parts-panel"></div>
      <div id="transport">
        <button id="play-btn" disabled>&#9658;</button>
        <button id="metronome-btn" disabled>Metronome</button>
        <button id="loop-btn" disabled title="Shift+drag on the roll to set a loop">Loop</button>
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
let partMix = new Map<string, PartMixState>();
let loopRegion: LoopRegion | null = null;
let loopEnabled = false;
let rafId: number | null = null;
let renderPending = false;
let canvasLeft = 0;

function updateCanvasRect() {
  canvasLeft = canvas.getBoundingClientRect().left;
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
  if (song) loadSong(song);
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
      const xml = await readScoreFile(file);
      const score = parseMusicXML(xml); // validates the file and gives us a title
      const title = score.title && score.title !== 'Untitled' ? score.title : file.name.replace(/\.(musicxml|xml|mxl)$/i, '');
      const id = await saveImportedSong({ title, xml });
      lastImported = { id, title, xml, imported: true };
      setImportStatus(`Imported "${title}" -- now available on every device.`);
    } catch (err) {
      setImportStatus(`Couldn't import ${file.name}: ${err instanceof Error ? err.message : 'invalid file'}`, true);
    }
  }
  // The onSnapshot listener will render the confirmed list; load the new song immediately
  // rather than waiting on that round trip.
  if (lastImported) loadSong(lastImported);
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

async function loadSong(song: SongEntry) {
  stopRenderLoop();
  const xmlText: string = song.xml !== undefined ? song.xml : await fetch(song.url!).then((r) => r.text());
  const score = parseMusicXML(xmlText);
  currentScore = score;
  transpose = 0;
  transposeValueEl.textContent = '0';
  zoom = 1;
  zoomValueEl.textContent = '100%';
  viewOffsetBeats = 0;
  loopRegion = null;
  loopEnabled = false;

  audioEngine = new AudioEngine(score);
  audioEngine.setDuckedVolume(duckVolume);
  pianoRoll = new PianoRoll(canvas, score, (partId) => {
    const idx = score.parts.findIndex((p) => p.id === partId);
    return colorForPartIndex(idx);
  });
  pianoRoll.setLoopRegion(null);

  partMix = new Map(score.parts.map((p) => [p.id, 'normal' as PartMixState]));
  pianoRoll.setPartMix(partMix);

  songTitleEl.textContent = score.title;
  playBtn.disabled = false;
  metronomeBtn.disabled = false;
  loopBtn.disabled = false;
  updateLoopButton();
  buildPartsPanel(score);
  setViewMode('player');
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

function togglePlay() {
  if (!audioEngine || !currentScore || playBtn.disabled) return;
  if (audioEngine.isPlaying()) {
    audioEngine.pause();
    playBtn.innerHTML = '&#9658;';
    stopRenderLoop();
  } else {
    let fromBeat = audioEngine.getPausedBeat();
    if (loopRegion) {
      fromBeat = loopRegion.start;
    } else if (fromBeat >= currentScore.totalBeats) {
      fromBeat = 0;
    }
    viewOffsetBeats = 0;
    pianoRoll?.setSeekMarker(null); // consumed once playback starts; stop drawing it every frame
    audioEngine.play(fromBeat, bpm, transpose);
    playBtn.innerHTML = '&#10074;&#10074;';
    startRenderLoop();
  }
}
playBtn.addEventListener('click', togglePlay);

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  togglePlay();
});

metronomeBtn.addEventListener('click', () => {
  if (!audioEngine) return;
  metronomeOn = !metronomeOn;
  audioEngine.setMetronomeEnabled(metronomeOn);
  metronomeBtn.classList.toggle('active', metronomeOn);
});

function updateLoopButton() {
  loopBtn.classList.toggle('active', loopEnabled);
  if (loopRegion) {
    loopBtn.title = loopEnabled
      ? `Looping ${loopRegion.start.toFixed(1)}–${loopRegion.end.toFixed(1)} (click to stop there instead)`
      : `Loop region set, off — click to loop it (shift+drag to redefine)`;
  } else {
    loopBtn.title = loopEnabled
      ? 'Looping the whole piece (shift+drag the roll to loop a region instead)'
      : 'Click to loop the whole piece, or shift+drag the roll to loop a region';
  }
}
loopBtn.addEventListener('click', () => {
  if (!currentScore) return;
  loopEnabled = !loopEnabled;
  updateLoopButton();
});

document.querySelectorAll<HTMLButtonElement>('.bpm-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    bpm = parseInt(btn.getAttribute('data-bpm')!, 10);
    document.querySelectorAll('.bpm-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (audioEngine?.isPlaying()) {
      audioEngine.play(audioEngine.getCurrentBeat(), bpm, transpose);
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
  transpose = Math.max(MIN_TRANSPOSE, Math.min(MAX_TRANSPOSE, transpose + delta));
  transposeValueEl.textContent = transpose > 0 ? `+${transpose}` : String(transpose);
  pianoRoll.setTranspose(transpose);
  if (audioEngine.isPlaying()) {
    audioEngine.play(audioEngine.getCurrentBeat(), bpm, transpose);
  } else {
    renderNow();
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
    audioEngine.play(clamped, bpm, transpose);
  } else {
    audioEngine.setPausedBeat(clamped);
  }
  viewOffsetBeats += oldEngineBeat - clamped;
  clampViewOffset();
  pianoRoll.setSeekMarker(clamped);
  renderNow();
}

function clearLoopRegion() {
  if (!loopRegion) return;
  loopRegion = null;
  pianoRoll?.setLoopRegion(null);
  updateLoopButton();
}

function finalizeLoopSelection(beatA: number, beatB: number) {
  if (!currentScore || !pianoRoll) return;
  const start = Math.max(0, Math.min(beatA, beatB));
  const end = Math.min(currentScore.totalBeats, Math.max(beatA, beatB));
  if (end - start < MIN_LOOP_BEATS) {
    loopRegion = null;
  } else {
    loopRegion = { start, end };
    loopEnabled = true;
    pianoRoll.setSeekMarker(null);
  }
  pianoRoll.setLoopRegion(loopRegion);
  updateLoopButton();
  renderNow();
}

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!pianoRoll) return;
    e.preventDefault();
    if (e.deltaX !== 0) {
      panByBeats(e.deltaX / pianoRoll.getPixelsPerBeat());
    } else if (e.shiftKey) {
      panByBeats(e.deltaY / pianoRoll.getPixelsPerBeat());
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
  canvas.setPointerCapture(e.pointerId);

  if (e.shiftKey) {
    loopSelectStartBeat = clientXToBeat(e.clientX);
  } else {
    loopSelectStartBeat = null;
    canvas.classList.add('dragging');
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (dragPointerId !== e.pointerId || !pianoRoll) return;
  if (Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > CLICK_DRAG_THRESHOLD_PX) dragMoved = true;

  if (loopSelectStartBeat != null) {
    const endBeat = clientXToBeat(e.clientX);
    pianoRoll.setLoopRegion({
      start: Math.min(loopSelectStartBeat, endBeat),
      end: Math.max(loopSelectStartBeat, endBeat),
    });
    scheduleRender();
  } else {
    const dx = e.clientX - dragLastX;
    const dy = e.clientY - dragLastY;
    panByBeats(-dx / pianoRoll.getPixelsPerBeat());
    pianoRoll.scrollByPixels(-dy);
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
    finalizeLoopSelection(loopSelectStartBeat, clientXToBeat(e.clientX));
    loopSelectStartBeat = null;
  } else if (!dragMoved && currentScore) {
    clearLoopRegion();
    seekToBeat(clientXToBeat(e.clientX));
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
  pianoRoll.render(beat);
  updatePositionDisplay(beat);
}

function renderLoop() {
  if (!audioEngine || !pianoRoll || !currentScore) return;
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
    playBtn.innerHTML = '&#9658;';
    pianoRoll.render(resetBeat);
    updatePositionDisplay(resetBeat);
    rafId = null;
    return;
  }

  pianoRoll.render(beat + viewOffsetBeats);
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
    subscribeToSongs(
      (songs) => {
        importedSongs = songs.map((s) => ({ id: s.id, title: s.title, xml: s.xml, imported: true }));
        renderSongList();
      },
      (err) => {
        setImportStatus(`Shared library unavailable: ${err instanceof Error ? err.message : String(err)}`, true);
      },
    );
  } catch (err) {
    setImportStatus(`Couldn't connect to the shared library: ${err instanceof Error ? err.message : String(err)}`, true);
  }
})();
