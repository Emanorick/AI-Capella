import './style.css';
import { parseMusicXML } from './musicxml';
import { Player, ZOOM_STEP } from './player';
import type { LoopRegion } from './pianoRoll';
import { colorForPartIndex } from './palette';
import type { Score } from './score';
import { escapeHtml } from './escapeHtml';
import { initLibraryView, type SongEntry } from './libraryView';
import { installCanvasInput } from './canvasInput';

const BPM_PRESETS = [50, 80, 100, 120, 140];
const DUCK_VOLUME_PRESETS = [0.1, 0.25, 0.5, 0.75];

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside id="library">
    <h1>AI-Capella</h1>
    <h2>Library</h2>
    <ul id="song-list"></ul>
    <button id="import-btn">+ Import score</button>
    <input id="import-input" type="file" accept=".musicxml,.xml,.mxl" multiple hidden />
    <div id="import-status" role="status" aria-live="polite"></div>
  </aside>
  <main id="workspace">
    <header id="song-header">
      <div id="header-left">
        <button id="library-back-btn" title="Back to library">&#8592; Library</button>
        <h2 id="song-title">Choose a song</h2>
      </div>
      <div id="header-right">
        <div id="position-display">—</div>
        <button id="stop-btn-mini" disabled title="Stop and reset to the start" aria-label="Stop">&#9632;</button>
        <button id="play-btn-mini" disabled title="Play/Pause" aria-label="Play or pause">&#9658;</button>
      </div>
    </header>
    <div id="settings-panel">
      <div id="parts-panel"></div>
      <div id="transport">
        <button id="play-btn" disabled aria-label="Play or pause">&#9658;</button>
        <button id="stop-btn" disabled title="Stop and reset to the start" aria-label="Stop">&#9632;</button>
        <button id="metronome-btn" disabled aria-pressed="false">Metronome</button>
        <button id="loop-btn" disabled title="Drag the ruler above the roll to set a loop" aria-pressed="false">Loop</button>
        <div class="transport-group" id="bpm-group">
          <span class="transport-label">BPM</span>
          ${BPM_PRESETS.map((b) => `<button class="bpm-btn" data-bpm="${b}">${b}</button>`).join('')}
        </div>
        <div class="transport-group" id="transpose-group">
          <span class="transport-label">Transpose</span>
          <button id="transpose-down" aria-label="Transpose down a semitone">&minus;</button>
          <span id="transpose-value">0</span>
          <button id="transpose-up" aria-label="Transpose up a semitone">&plus;</button>
        </div>
        <div class="transport-group" id="zoom-group">
          <span class="transport-label">Zoom</span>
          <button id="zoom-out" aria-label="Zoom out">&minus;</button>
          <span id="zoom-value">100%</span>
          <button id="zoom-in" aria-label="Zoom in">&plus;</button>
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

/** Keeps the header's compact play button and the transport's full one showing the same state. */
function syncPlayButtons(playing: boolean) {
  const icon = playing ? '&#10074;&#10074;' : '&#9658;';
  playBtn.innerHTML = icon;
  playBtnMini.innerHTML = icon;
}

function updateLoopButton(loopEnabled: boolean, loopRegion: LoopRegion | null) {
  loopBtn.classList.toggle('active', loopEnabled);
  loopBtn.setAttribute('aria-pressed', String(loopEnabled));
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

function syncPartRowClasses() {
  partsPanelEl.querySelectorAll<HTMLElement>('.part-row').forEach((row) => {
    const partId = row.getAttribute('data-part')!;
    const state = player.getPartMixState(partId);
    row.classList.toggle('is-muted', state === 'muted');
    row.classList.toggle('is-solo', state === 'solo');
    row.querySelector('.mute-btn')?.setAttribute('aria-pressed', String(state === 'muted'));
    row.querySelector('.solo-btn')?.setAttribute('aria-pressed', String(state === 'solo'));
  });
}

const player = new Player(canvas, {
  onPlayStateChanged: syncPlayButtons,
  onLoopChanged: updateLoopButton,
  onPositionText: (text) => {
    positionEl.textContent = text;
  },
  onPartMixChanged: syncPartRowClasses,
});
installCanvasInput(canvas, player);

/** The app opens on the library so you can browse/import scores; picking one switches to the player. */
function setViewMode(mode: 'library' | 'player') {
  app.classList.toggle('mode-library', mode === 'library');
  app.classList.toggle('mode-player', mode === 'player');
  if (mode === 'player') {
    // The canvas was hidden (display:none) while in library mode, so its layout size wasn't
    // knowable until now.
    player.refreshLayout();
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
  player.refreshLayout();
});

const libraryView = initLibraryView({
  songListEl: document.querySelector<HTMLUListElement>('#song-list')!,
  importBtn: document.querySelector<HTMLButtonElement>('#import-btn')!,
  importInput: document.querySelector<HTMLInputElement>('#import-input')!,
  importStatusEl: document.querySelector<HTMLDivElement>('#import-status')!,
  libraryEl,
  onSongChosen: (song) => void loadSong(song),
});

async function loadSong(song: SongEntry) {
  let score: Score;
  try {
    let xmlText: string;
    if (song.xml !== undefined) {
      xmlText = song.xml;
    } else {
      const res = await fetch(song.url!);
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      xmlText = await res.text();
    }
    score = parseMusicXML(xmlText);
  } catch (err) {
    libraryView.setStatus(`Couldn't load "${song.title}": ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }

  player.loadScore(score);
  transposeValueEl.textContent = '0';
  zoomValueEl.textContent = '100%';
  metronomeBtn.classList.remove('active');
  metronomeBtn.setAttribute('aria-pressed', 'false');

  songTitleEl.textContent = score.title;
  for (const btn of [playBtn, playBtnMini, stopBtn, stopBtnMini, metronomeBtn, loopBtn]) btn.disabled = false;
  buildPartsPanel(score);
  setViewMode('player');
}

function buildPartsPanel(score: Score) {
  partsPanelEl.innerHTML = score.parts
    .map((p, idx) => {
      const color = colorForPartIndex(idx);
      const name = escapeHtml(p.name);
      return `
      <div class="part-row" data-part="${escapeHtml(p.id)}">
        <span class="swatch" style="background:${color}"></span>
        <span class="part-name">${name}</span>
        <button class="mix-btn mute-btn" data-action="muted" aria-pressed="false" aria-label="Mute ${name}">M</button>
        <button class="mix-btn solo-btn" data-action="solo" aria-pressed="false" aria-label="Solo ${name}">S</button>
      </div>`;
    })
    .join('');
}

partsPanelEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.part-row');
  if (!row || !player.hasScore()) return;
  const partId = row.getAttribute('data-part')!;
  const action = target.getAttribute('data-action');

  if (action === 'muted' || action === 'solo') {
    player.togglePartMix(partId, action);
  } else {
    player.toggleTrueSolo(partId);
  }
});

playBtn.addEventListener('click', () => player.togglePlay());
playBtnMini.addEventListener('click', () => player.togglePlay());
stopBtn.addEventListener('click', () => player.stopPlayback());
stopBtnMini.addEventListener('click', () => player.stopPlayback());

const KEY_PAN_BEATS = 2;

window.addEventListener('keydown', (e) => {
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // e.g. the PIN gate's input
  if (!player.hasScore() || !app.classList.contains('mode-player')) return;

  switch (e.code) {
    case 'Space':
      // Not when a button has focus: space "clicks" the focused button natively, and doing both
      // would toggle playback twice (or fight the button's own action).
      if (tag === 'BUTTON') return;
      e.preventDefault();
      player.togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      player.panByBeats(e.shiftKey ? -KEY_PAN_BEATS * 4 : -KEY_PAN_BEATS);
      break;
    case 'ArrowRight':
      e.preventDefault();
      player.panByBeats(e.shiftKey ? KEY_PAN_BEATS * 4 : KEY_PAN_BEATS);
      break;
    case 'ArrowUp':
      e.preventDefault();
      player.scrollByPixels(-40);
      break;
    case 'ArrowDown':
      e.preventDefault();
      player.scrollByPixels(40);
      break;
    case 'Minus':
    case 'NumpadSubtract':
      e.preventDefault();
      applyZoom(1 / ZOOM_STEP);
      break;
    case 'Equal': // the +/= key, without requiring shift
    case 'NumpadAdd':
      e.preventDefault();
      applyZoom(ZOOM_STEP);
      break;
    case 'KeyM':
      metronomeBtn.click(); // reuses the button path so UI state stays in sync
      break;
    case 'KeyL':
      loopBtn.click();
      break;
  }
});

metronomeBtn.addEventListener('click', () => {
  const on = player.toggleMetronome();
  metronomeBtn.classList.toggle('active', on);
  metronomeBtn.setAttribute('aria-pressed', String(on));
});

loopBtn.addEventListener('click', () => player.toggleLoop());

document.querySelectorAll<HTMLButtonElement>('.bpm-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    player.setBpm(parseInt(btn.getAttribute('data-bpm')!, 10));
    document.querySelectorAll('.bpm-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});
document.querySelector(`.bpm-btn[data-bpm="${player.getBpm()}"]`)?.classList.add('active');

document.querySelectorAll<HTMLButtonElement>('.duck-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    player.setDuckVolume(parseFloat(btn.getAttribute('data-duck')!));
    document.querySelectorAll('.duck-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});
document.querySelector(`.duck-btn[data-duck="${player.getDuckVolume()}"]`)?.classList.add('active');

transposeDownBtn.addEventListener('click', () => applyTranspose(-1));
transposeUpBtn.addEventListener('click', () => applyTranspose(1));
function applyTranspose(delta: number) {
  const t = player.applyTranspose(delta);
  transposeValueEl.textContent = t > 0 ? `+${t}` : String(t);
}

zoomOutBtn.addEventListener('click', () => applyZoom(1 / ZOOM_STEP));
zoomInBtn.addEventListener('click', () => applyZoom(ZOOM_STEP));
function applyZoom(factor: number) {
  const z = player.applyZoom(factor);
  zoomValueEl.textContent = `${Math.round(z * 100)}%`;
}

window.addEventListener('resize', () => player.refreshLayout());

// Mobile browsers can change the canvas's actual laid-out size (address bar show/hide, dynamic
// toolbar, app-switcher return) without firing a window 'resize' event -- when that happened, the
// canvas kept rendering at its old (now stale) cssWidth/cssHeight while the element itself sat in
// a differently-sized box, leaving raw unpainted canvas showing as a black area next to the
// content. ResizeObserver watches the canvas's own box directly, so it catches every case.
new ResizeObserver(() => player.refreshLayout()).observe(canvas);
