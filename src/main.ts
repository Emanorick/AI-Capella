import './style.css';
import { parseMusicXML } from './musicxml';
import { AudioEngine, type PartMixState } from './audioEngine';
import { PianoRoll } from './pianoRoll';
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

  audioEngine = new AudioEngine(score);
  pianoRoll = new PianoRoll(canvas, score, (partId) => {
    const idx = score.parts.findIndex((p) => p.id === partId);
    return colorForPartIndex(idx);
  });

  partMix = new Map(score.parts.map((p) => [p.id, 'normal' as PartMixState]));
  pianoRoll.setPartMix(partMix);

  songTitleEl.textContent = score.title;
  playBtn.disabled = false;
  metronomeBtn.disabled = false;
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
    if (fromBeat >= currentScore.totalBeats) fromBeat = 0;
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
let dragLastX = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragPointerId = e.pointerId;
  dragLastX = e.clientX;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (dragPointerId !== e.pointerId || !pianoRoll) return;
  const dx = e.clientX - dragLastX;
  dragLastX = e.clientX;
  panByBeats(-dx / pianoRoll.getPixelsPerBeat());
});
function endDrag(e: PointerEvent) {
  if (dragPointerId !== e.pointerId) return;
  dragPointerId = null;
  canvas.classList.remove('dragging');
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

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
  const beat = engineBeat() + viewOffsetBeats;
  pianoRoll.render(beat);
  updatePositionDisplay(beat);
}

function renderLoop() {
  if (!audioEngine || !pianoRoll || !currentScore) return;
  const beat = audioEngine.getCurrentBeat();
  if (beat >= currentScore.totalBeats) {
    audioEngine.stop();
    playBtn.innerHTML = '&#9658;';
    pianoRoll.render(currentScore.totalBeats);
    updatePositionDisplay(currentScore.totalBeats);
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
