import './style.css';
import { parseMusicXML } from './musicxml';
import { AudioEngine, type PartMixState } from './audioEngine';
import { PianoRoll, type LoopRegion } from './pianoRoll';
import { colorForPartIndex } from './palette';
import { measureAtBeat, type Score } from './score';

interface SongRef {
  id: string;
  title: string;
  url: string;
}

const SONGS: SongRef[] = [
  { id: 'sample-satb', title: 'Alleluia (Demo SATB)', url: '/sample-satb.musicxml' },
  { id: 'evening-rise', title: 'Evening Rise', url: '/evening-rise.musicxml' },
];

const BPM_PRESETS = [50, 80, 100, 120, 140];
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
  </aside>
  <main id="workspace">
    <header id="song-header">
      <h2 id="song-title">Choose a song</h2>
      <div id="position-display">—</div>
    </header>
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
    </div>
    <canvas id="roll"></canvas>
  </main>
`;

const songListEl = document.querySelector<HTMLUListElement>('#song-list')!;
const songTitleEl = document.querySelector<HTMLHeadingElement>('#song-title')!;
const positionEl = document.querySelector<HTMLDivElement>('#position-display')!;
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
let transpose = 0;
let zoom = 1;
let viewOffsetBeats = 0;
let metronomeOn = false;
let partMix = new Map<string, PartMixState>();
let loopRegion: LoopRegion | null = null;
let loopEnabled = false;
let rafId: number | null = null;

songListEl.innerHTML = SONGS.map((s) => `<li data-id="${s.id}"><button class="song-btn">${s.title}</button></li>`).join('');
songListEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.song-btn');
  const li = btn?.closest('li');
  const id = li?.getAttribute('data-id');
  const song = SONGS.find((s) => s.id === id);
  if (song) loadSong(song);
});

async function loadSong(song: SongRef) {
  stopRenderLoop();
  const xmlText = await fetch(song.url).then((r) => r.text());
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
  pianoRoll.resize();
  renderNow();
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

partsPanelEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.part-row');
  if (!row || !audioEngine || !pianoRoll) return;
  const partId = row.getAttribute('data-part')!;
  const action = target.getAttribute('data-action') as PartMixState | null;
  if (!action) return;
  const current = partMix.get(partId) ?? 'normal';
  const next: PartMixState = current === action ? 'normal' : action;
  partMix.set(partId, next);
  audioEngine.setPartMixState(partId, next);
  pianoRoll.setPartMix(partMix);
  row.classList.toggle('is-muted', next === 'muted');
  row.classList.toggle('is-solo', next === 'solo');
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
  renderNow();
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
    const delta = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (delta === 0) return;
    panByBeats(delta / pianoRoll.getPixelsPerBeat());
  },
  { passive: false },
);

let dragPointerId: number | null = null;
let dragStartX = 0;
let dragLastX = 0;
let dragMoved = false;
let loopSelectStartBeat: number | null = null;

function clientXToBeat(clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  return pianoRoll!.xToBeat(clientX - rect.left, displayBeat());
}

canvas.addEventListener('pointerdown', (e) => {
  if (!pianoRoll || !currentScore) return;
  dragPointerId = e.pointerId;
  dragStartX = e.clientX;
  dragLastX = e.clientX;
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
  if (Math.abs(e.clientX - dragStartX) > CLICK_DRAG_THRESHOLD_PX) dragMoved = true;

  if (loopSelectStartBeat != null) {
    const endBeat = clientXToBeat(e.clientX);
    pianoRoll.setLoopRegion({
      start: Math.min(loopSelectStartBeat, endBeat),
      end: Math.max(loopSelectStartBeat, endBeat),
    });
    renderNow();
  } else {
    const dx = e.clientX - dragLastX;
    panByBeats(-dx / pianoRoll.getPixelsPerBeat());
  }
  dragLastX = e.clientX;
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

function updatePositionDisplay(beat: number) {
  if (!currentScore) return;
  const measure = measureAtBeat(currentScore, beat);
  if (!measure) {
    positionEl.textContent = '—';
    return;
  }
  const pulseBeats = 4 / measure.beatType;
  const beatInMeasure = Math.floor((beat - measure.startBeat) / pulseBeats) + 1;
  positionEl.textContent = `Measure ${measure.number} · Beat ${Math.min(beatInMeasure, measure.beats)}/${measure.beats}`;
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
  renderNow();
});

loadSong(SONGS[0]);
