// Typefaces are bundled with the app rather than loaded from Google's servers: no visitor data goes
// to a third party (German courts have fined sites for remotely loaded Google Fonts), and they keep
// working on weak rehearsal-room Wi-Fi.
import '@fontsource-variable/bodoni-moda/opsz.css';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css';
import './style.css';
import { parseMusicXML } from './musicxml';
import { parseMIDI } from './midi';
import { AudioEngine, type PartMixState } from './audioEngine';
import { PianoRoll, RULER_HEIGHT_PX, type LoopRegion } from './pianoRoll';
import { StaffView, STAFF_RULER_HEIGHT_PX } from './staffView';
import { OverviewStrip } from './overview';
import { colorForPart } from './palette';
import { measureAtBeat, type Score } from './score';
import { deleteImportedSong, readScoreFile, saveImportedSong, saveSongConfig, subscribeToSongs, updateSongMetadata, type SongFormat, type StoredSong, type VoiceClef } from './library';
import { ensureSignedIn, isFirebaseConfigured } from './firebase';
import { ensureAccess } from './pinGate';
import { animateRibbons, coverDataFromScore, drawCover, drawMark, prepareCanvas, type CoverData } from './artwork';
import { icon } from './icons';
import { countLabel, keyName, lang, setLang, t } from './i18n';
import { canvasFontsReady } from './theme';
import { closeOverlay, confirmDialog, isNarrow, openMenu, openPopover, openSheet, promptDialog, toast } from './ui';
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
  savedConfig?: StoredSong['savedConfig'];
  clefOverrides?: StoredSong['clefOverrides'];
  removedParts?: string[];
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
const DEFAULT_BPM = 100;
const MIN_BPM = 20;
const MAX_BPM = 300;
const MIN_TRANSPOSE = -7;
const MAX_TRANSPOSE = 7;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
const VIEW_EDGE_SLACK_BEATS = 2;
const CLICK_DRAG_THRESHOLD_PX = 5;
const MIN_LOOP_BEATS = 0.5;
const PREVIEW_NOTE_LABEL_MS = 1200;
const SEARCH_THRESHOLD = 8; // the search field only appears once the library is long enough to need it

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <section id="landing" class="view" aria-label="AI-Capella">
    <canvas class="ribbons" id="landing-ribbons" aria-hidden="true"></canvas>
    <h1 class="landing-name">AI-Capella</h1>
    <div class="landing-modes">
      <button type="button" class="mode-btn" id="mode-solo-btn">${icon('user')}<span>${t('practiseAlone')}</span></button>
      <button type="button" class="mode-btn" id="mode-ensemble-btn">${icon('users')}<span>${t('rehearseTogether')}</span></button>
    </div>
  </section>

  <section id="library" class="view">
    <header class="lib-top">
      <span class="brand"><canvas class="mark" aria-hidden="true"></canvas><span class="wordmark">AI-Capella</span></span>
      <div class="lib-top-r">
        <div class="seg mode-seg" id="mode-seg" role="group" aria-label="${t('mode')}">
          <button type="button" data-action="mode" data-mode="solo">${icon('user')}<span>${t('solo')}</span></button>
          <button type="button" data-action="mode" data-mode="ensemble">${icon('users')}<span>${t('ensemble')}</span><i class="live-dot" aria-hidden="true"></i></button>
        </div>
        <button type="button" class="icon-btn" id="lib-menu-btn" aria-label="${t('menu')}">${icon('more')}</button>
      </div>
    </header>
    <div class="lib-scroll">
      <div class="lib-head">
        <div>
          <h1>${t('repertoire')}</h1>
          <p id="lib-count"></p>
        </div>
        <div class="lib-tools">
          <label class="search" id="lib-search-wrap" hidden>${icon('search')}<input id="lib-search" type="search" placeholder="${t('searchTitles')}" aria-label="${t('searchTitles')}" /></label>
          <button type="button" class="btn primary" id="import-btn">${icon('plus')}<span>${t('addArrangement')}</span></button>
        </div>
      </div>
      <div id="lib-banner" class="banner" role="status" hidden></div>
      <ul id="song-grid" class="song-grid"></ul>
      <p class="lib-tip">${icon('upload')}<span>${t('dropTip')}</span></p>
    </div>
    <div class="drop-veil" aria-hidden="true"><span>${icon('upload')}${t('dropHere')}</span></div>
    <input id="import-input" type="file" accept=".musicxml,.xml,.mxl,.mid,.midi" multiple hidden />
  </section>

  <section id="player" class="view">
    <header class="p-top">
      <button type="button" class="back-btn" id="library-back-btn">${icon('back')}<span>${t('back')}</span></button>
      <div class="p-title">
        <h2 id="song-title"></h2>
        <span id="song-meta"></span>
      </div>
      <div class="p-top-r">
        <div class="seg view-seg" id="view-seg" role="group" aria-label="${t('view')}">
          <button type="button" data-action="view" data-view="roll" aria-label="${t('pianoRoll')}">${icon('roll')}<span>${t('pianoRoll')}</span></button>
          <button type="button" data-action="view" data-view="staff" aria-label="${t('sheetMusic')}">${icon('sheet')}<span>${t('sheetMusic')}</span></button>
        </div>
        <button type="button" class="badge" id="mode-badge"></button>
        <button type="button" class="icon-btn landscape-only" data-action="open-mixer" aria-label="${t('voices')}">${icon('mixer')}</button>
        <button type="button" class="icon-btn" id="player-menu-btn" aria-label="${t('menu')}">${icon('more')}</button>
      </div>
    </header>
    <aside class="voices-panel" aria-label="${t('voices')}">
      <div class="panel-head"><span class="label">${t('voices')}</span><button type="button" class="link-btn" data-action="mix-reset">${t('reset')}</button></div>
      <ul class="voice-list" id="voice-list"></ul>
      <div class="duck">
        <label class="label" for="duck-range-side">${t('othersWhileSoloing')}</label>
        <div class="duck-row"><input type="range" class="duck-range" id="duck-range-side" min="0" max="0.75" step="0.05" /><output class="duck-value"></output></div>
      </div>
    </aside>
    <div class="chips" id="voice-chips" role="group" aria-label="${t('voices')}"></div>
    <div class="chips-mixer"><button type="button" class="chip mixer-chip" data-action="open-mixer" aria-label="${t('voices')}">${icon('mixer')}</button></div>
    <div class="stage" id="stage">
      <canvas id="roll"></canvas>
      <canvas id="staff" hidden></canvas>
      <div class="zoom" role="group" aria-label="Zoom">
        <button type="button" class="icon-btn" data-action="zoom-out" aria-label="${t('zoomOut')}">${icon('minus')}</button>
        <span id="zoom-value">100%</span>
        <button type="button" class="icon-btn" data-action="zoom-in" aria-label="${t('zoomIn')}">${icon('plus')}</button>
      </div>
    </div>
    <div class="overview" id="overview-wrap">
      <canvas id="overview" title="${t('wholePiece')}"></canvas>
      <div id="section-marks"></div>
      <button type="button" class="icon-btn small" id="section-add-btn" data-action="section-add" aria-label="${t('addSection')}" title="${t('addSection')}">${icon('flag')}</button>
    </div>
    <button type="button" class="info-row" data-action="open-controls">
      <span><b data-bind="pos-bar"></b> <span data-bind="pos-beat-short"></span></span>
      <span class="info-tempo">${icon('quarter')}<b data-bind="bpm"></b></span>
      <span>${t('key')} <b data-bind="transpose"></b></span>
      <span class="info-metro" data-bind-metro>${icon('metronome')}</span>
      ${icon('chevronUp')}
    </button>
    <footer class="transport">
      <button type="button" class="pos" data-action="goto" aria-label="${t('goToBar')}">
        <b data-bind="pos-bar"></b><span data-bind="pos-beat"></span>
      </button>
      <div class="t-center">
        <button type="button" class="t-btn t-stop-left" data-action="stop" aria-label="${t('stop')}" title="${t('stop')}">${icon('stop')}</button>
        <button type="button" class="t-btn" data-hold="-1" aria-label="${t('prevBar')}" title="${t('prevBar')}">${icon('prev')}</button>
        <button type="button" class="t-btn t-stop-mid" data-action="stop" aria-label="${t('stop')}" title="${t('stop')}">${icon('stop')}</button>
        <button type="button" class="play-btn" data-action="play" aria-label="${t('play')}">${icon('play')}</button>
        <button type="button" class="t-btn" data-hold="1" aria-label="${t('nextBar')}" title="${t('nextBar')}">${icon('next')}</button>
        <span class="t-sep" aria-hidden="true"></span>
        <button type="button" class="t-btn toggle" data-action="loop" aria-pressed="false">${icon('loop')}</button>
        <button type="button" class="t-btn toggle t-metro" data-action="metronome" aria-pressed="false" aria-label="${t('metronome')}" title="${t('metronome')}">${icon('metronome')}</button>
      </div>
      <div class="t-right">
        <div class="stepper" role="group" aria-label="${t('tempo')}">
          <button type="button" data-action="bpm-down" aria-label="${t('slower')}">${icon('minus')}</button>
          <button type="button" class="stepper-value" data-action="open-tempo">${icon('quarter')}<span>= <b data-bind="bpm"></b></span></button>
          <button type="button" data-action="bpm-up" aria-label="${t('faster')}">${icon('plus')}</button>
        </div>
        <div class="stepper" role="group" aria-label="${t('key')}">
          <span class="label">${t('key')}</span>
          <button type="button" data-action="transpose-down" aria-label="${t('lower')}">${icon('minus')}</button>
          <span class="stepper-value static"><b data-bind="key-short"></b></span>
          <button type="button" data-action="transpose-up" aria-label="${t('higher')}">${icon('plus')}</button>
        </div>
      </div>
    </footer>
  </section>
`;

const libraryEl = document.querySelector<HTMLElement>('#library')!;
const songGridEl = document.querySelector<HTMLUListElement>('#song-grid')!;
const libCountEl = document.querySelector<HTMLParagraphElement>('#lib-count')!;
const libBannerEl = document.querySelector<HTMLDivElement>('#lib-banner')!;
const searchWrapEl = document.querySelector<HTMLLabelElement>('#lib-search-wrap')!;
const searchInput = document.querySelector<HTMLInputElement>('#lib-search')!;
const importBtn = document.querySelector<HTMLButtonElement>('#import-btn')!;
const importInput = document.querySelector<HTMLInputElement>('#import-input')!;
const songTitleEl = document.querySelector<HTMLHeadingElement>('#song-title')!;
const songMetaEl = document.querySelector<HTMLSpanElement>('#song-meta')!;
const voiceListEl = document.querySelector<HTMLUListElement>('#voice-list')!;
const chipsEl = document.querySelector<HTMLDivElement>('#voice-chips')!;
const zoomValueEl = document.querySelector<HTMLSpanElement>('#zoom-value')!;
const sectionMarksEl = document.querySelector<HTMLDivElement>('#section-marks')!;
const sectionAddBtn = document.querySelector<HTMLButtonElement>('#section-add-btn')!;
const modeBadge = document.querySelector<HTMLButtonElement>('#mode-badge')!;
const canvas = document.querySelector<HTMLCanvasElement>('#roll')!;
const staffCanvas = document.querySelector<HTMLCanvasElement>('#staff')!;
const overviewCanvas = document.querySelector<HTMLCanvasElement>('#overview')!;

let currentScore: Score | null = null;
let currentPartColor: ((partId: string) => string) | null = null;
let audioEngine: AudioEngine | null = null;
let pianoRoll: PianoRoll | null = null;
let staffView: StaffView | null = null;
let overview: OverviewStrip | null = null;
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
// User-added section markers (A/B/C...), used only when the current song's MusicXML has no
// <rehearsal> marks of its own (score.rehearsalMarks) -- otherwise those are used directly and
// this stays empty. Not synced across devices via pushState (like mute/solo, see PlaybackState's
// doc comment) -- only persisted when the user explicitly saves it (saveSongConfig), and reloaded
// from the song's savedConfig on every fresh load in the meantime.
let manualSections: { label: string; beat: number }[] = [];
let loopEnabled = false;
// Whether the next Play should count-in (see PlaybackState.freshStart's doc comment in sync.ts).
// Kept in sync via applyPlaybackState the same way metronomeOn/loopEnabled are.
let freshStart = true;
let rafId: number | null = null;
let renderPending = false;
let canvasLeft = 0;
let canvasTop = 0;
// Sorted notes per part, for the voice activity lights (who is singing at the playhead).
let notesByPart = new Map<string, { startBeat: number; durationBeats: number; midi: number }[]>();

// Multi-device sync: which song is currently loaded locally, plus bookkeeping so an incoming
// shared-session update only actually touches AudioEngine when something timing-relevant
// (play/pause, position, bpm, transpose) genuinely changed -- an update that only changed the
// metronome, say, must NOT reschedule playback, or every remote toggle would audibly retrigger
// every currently-sounding note. See applyPlaybackState().
let loadedSongId: string | null = null;
// The full SongEntry for whatever's currently loaded -- used to know its format (the Sheet Music
// view isn't offered for MIDI imports) and its imported/Firestore-id status (renames and saved
// defaults only apply to actual library entries).
let currentSong: SongEntry | null = null;
let pendingSongId: string | null = null; // set when a remote songId isn't in our library list yet
let lastReceivedPlaybackState: PlaybackState | null = null;
let lastAppliedTiming: { playing: boolean; originBeat: number; originServerTimeMs: number; bpm: number; transpose: number; countInBeats: number; countInPulseBeats: number } | null = null;
let lastAppliedMetronomeOn = false;

type LibraryState = 'loading' | 'ready' | 'offline' | 'unconfigured';
let libraryState: LibraryState = isFirebaseConfigured ? 'loading' : 'unconfigured';
let libraryError = '';

function updateCanvasRect() {
  const rect = (activeView === 'staff' ? staffCanvas : canvas).getBoundingClientRect();
  canvasLeft = rect.left;
  canvasTop = rect.top;
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

let stopLandingRibbons: (() => void) | null = null;

/**
 * The app opens on a title screen (Solo vs. Ensemble, only when there's a shared backend to
 * choose between) the first time, then the repertoire so you can browse/import scores; picking a
 * song switches to the player.
 */
function setViewMode(mode: 'landing' | 'library' | 'player') {
  app.classList.toggle('mode-landing', mode === 'landing');
  app.classList.toggle('mode-library', mode === 'library');
  app.classList.toggle('mode-player', mode === 'player');
  closeOverlay();
  if (mode === 'landing' && !stopLandingRibbons) {
    stopLandingRibbons = animateRibbons(document.querySelector<HTMLCanvasElement>('#landing-ribbons')!, (w, h) =>
      w < 700
        ? { voices: 6, x0: -0.1 * w, x1: 1.1 * w, cy: h * 0.5, gap: 13, amp: 26, line: 2.2, halo: 12 }
        : { voices: 6, x0: -0.04 * w, x1: 1.04 * w, cy: h * 0.5, gap: Math.min(24, h * 0.03), amp: Math.min(46, h * 0.055), line: 2.6, halo: 16, bead: 3.6 },
    );
  } else if (mode !== 'landing' && stopLandingRibbons) {
    stopLandingRibbons();
    stopLandingRibbons = null;
  }
  if (mode === 'library') requestAnimationFrame(drawAllCovers);
  if (mode === 'player') {
    // The canvases were hidden (display:none) while in library mode, so their layout size wasn't
    // knowable until now.
    resizeCanvases();
  }
  if (mode !== 'player') releaseWakeLock();
}

document.querySelector<HTMLButtonElement>('#library-back-btn')!.addEventListener('click', () => {
  // Publishes a normal synced Stop -- in Ensemble mode this stops every device, not just this
  // one, matching the expectation that leaving to browse the library shouldn't leave a song
  // silently still playing for the rest of the group. Safe no-op if nothing is loaded/playing
  // (stopPlayback's own guard).
  stopPlayback();
  setViewMode('library');
});

// Bumped (v2) to force every device that already has a stored choice from earlier testing back
// through the landing screen once -- real rehearsal participants should always land on the
// Solo/Ensemble choice the first time they actually open the app, not silently inherit whatever
// mode a developer's own test pass last left on that device/browser. Ordinary persistence
// (so reopening the app mid-rehearsal doesn't re-ask every time) is unaffected going forward.
const MODE_STORAGE_KEY = 'ai-capella-mode-v2';
// Solo = fully local, no shared playback session at all (even though Firebase may be
// configured) -- for practicing alone without nudging anyone else's playback. Ensemble = the
// single shared session. The shared song *library* stays available either way; only playback sync
// is gated by this choice. Resolved once at startup and changed only via the mode switch, which
// just reloads -- there's no in-place teardown of an active Firestore subscription.
let sessionMode: 'solo' | 'ensemble' = 'solo';
function syncEnabled(): boolean {
  return isFirebaseConfigured && sessionMode === 'ensemble';
}

function renderModeControls() {
  document.querySelectorAll<HTMLButtonElement>('#mode-seg [data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === sessionMode));
  });
  document.querySelector<HTMLElement>('#mode-seg')!.hidden = !isFirebaseConfigured;
  modeBadge.innerHTML = sessionMode === 'ensemble' ? `${icon('users')}<span>${t('ensemble')}</span><i class="live-dot" aria-hidden="true"></i>` : `${icon('user')}<span>${t('solo')}</span>`;
  modeBadge.hidden = !isFirebaseConfigured;
}

async function requestModeSwitch(mode: 'solo' | 'ensemble') {
  if (mode === sessionMode) return;
  const name = mode === 'solo' ? t('solo') : t('ensemble');
  const ok = await confirmDialog({
    title: t('switchToTitle', { mode: name }),
    body: mode === 'solo' ? t('switchToSolo') : t('switchToEnsemble'),
    confirmLabel: t('switchAction'),
  });
  if (!ok) return;
  stopPlayback();
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  // The title screen shows on every start; after an explicit switch, go straight on in the new mode.
  sessionStorage.setItem(MODE_SWITCH_KEY, mode);
  location.reload();
}
const MODE_SWITCH_KEY = 'ai-capella-mode-switch';
modeBadge.addEventListener('click', () => requestModeSwitch(sessionMode === 'solo' ? 'ensemble' : 'solo'));

function chooseMode(mode: 'solo' | 'ensemble') {
  sessionMode = mode;
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  renderModeControls();
  setViewMode('library');
  void runBootstrap();
}
document.querySelector<HTMLButtonElement>('#mode-solo-btn')!.addEventListener('click', () => chooseMode('solo'));
document.querySelector<HTMLButtonElement>('#mode-ensemble-btn')!.addEventListener('click', () => chooseMode('ensemble'));

function languageItems() {
  return [
    { label: 'Deutsch', icon: 'globe' as const, checked: lang === 'de', onSelect: () => lang !== 'de' && setLang('de') },
    { label: 'English', icon: 'globe' as const, checked: lang === 'en', onSelect: () => lang !== 'en' && setLang('en') },
  ];
}
document.querySelector<HTMLButtonElement>('#lib-menu-btn')!.addEventListener('click', (e) => {
  openMenu(e.currentTarget as HTMLElement, languageItems(), t('language'));
});

// Brand marks (static) -- drawn once they have a layout size.
function drawMarks() {
  document.querySelectorAll<HTMLCanvasElement>('canvas.mark').forEach((c) => {
    const p = prepareCanvas(c);
    if (p) drawMark(p.ctx, p.w, false);
  });
}

// ---------------------------------------------------------------------------------------------
// Repertoire
// ---------------------------------------------------------------------------------------------

function allSongs(): SongEntry[] {
  return [...BUILTIN_SONGS, ...importedSongs];
}

interface SongMeta {
  tempo?: number;
  voices: number;
  bars: number;
  key: string;
  time: string;
  cover: CoverData;
}
const metaCache = new Map<string, Promise<SongMeta | null>>();
const coverCanvases = new Map<HTMLCanvasElement, CoverData>();
let metaQueue: Promise<unknown> = Promise.resolve();

async function readSongText(song: SongEntry): Promise<string> {
  return song.xml !== undefined ? song.xml : await fetch(song.url!).then((r) => r.text());
}

function parseSong(song: SongEntry, text: string): Score {
  // Built-in songs (fetched by URL) and imported MusicXML/.mxl files are MusicXML text; MIDI
  // imports were already parsed into a Score at import time and stored as its JSON serialization.
  return song.format === 'score' ? (JSON.parse(text) as Score) : parseMusicXML(text);
}

/** Voices, bars, key, time signature and cover for a library card -- parsed once per song version, one at a time so a big library doesn't freeze the page. */
function songMeta(song: SongEntry): Promise<SongMeta | null> {
  const key = `${song.id}:${song.xml?.length ?? 0}`;
  let cached = metaCache.get(key);
  if (!cached) {
    cached = (metaQueue = metaQueue.then(
      () =>
        new Promise<SongMeta | null>((resolve) => {
          setTimeout(async () => {
            try {
              const score = parseSong(song, await readSongText(song));
              const first = score.measures[0];
              resolve({
                tempo: score.tempo,
                voices: score.parts.length,
                bars: score.measures.at(-1)?.number ?? score.measures.length,
                // MIDI imports carry no key signature (older ones not even a fifths field), so no key is named for them.
                key: first && song.format !== 'score' ? keyName(first.fifths, first.mode) : '',
                time: first ? `${first.beats}/${first.beatType}` : '',
                cover: coverDataFromScore(score),
              });
            } catch {
              resolve(null);
            }
          }, 0);
        }),
    )) as Promise<SongMeta | null>;
    metaCache.set(key, cached);
  }
  return cached;
}

function drawCoverCanvas(c: HTMLCanvasElement) {
  const data = coverCanvases.get(c);
  if (!data || !c.isConnected) {
    coverCanvases.delete(c);
    return;
  }
  const p = prepareCanvas(c);
  if (p) drawCover(p.ctx, p.w, p.h, data);
}

function drawAllCovers() {
  for (const c of coverCanvases.keys()) drawCoverCanvas(c);
}

function voiceDots(count: number): HTMLSpanElement {
  const dots = document.createElement('span');
  dots.className = 'vdots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < Math.min(count, 8); i++) {
    const d = document.createElement('i');
    d.style.setProperty('--c', colorForPart(i, count));
    dots.appendChild(d);
  }
  return dots;
}

function songCard(song: SongEntry): HTMLLIElement {
  // Built with DOM APIs and textContent throughout -- song titles come from the shared library,
  // where anyone with the PIN can set them, so they must never be parsed as HTML.
  const li = document.createElement('li');
  li.className = 'song-card';
  li.dataset.id = song.id;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'song-open';
  open.setAttribute('aria-label', t('open', { title: song.title }));
  const cover = document.createElement('canvas');
  cover.className = 'cover';
  cover.setAttribute('aria-hidden', 'true');
  const body = document.createElement('span');
  body.className = 'song-body';
  const title = document.createElement('span');
  title.className = 'song-title';
  title.textContent = song.title;
  const meta = document.createElement('span');
  meta.className = 'song-meta';
  meta.innerHTML = '&nbsp;';
  body.append(title, meta);
  open.append(cover, body);
  li.appendChild(open);
  if (song.imported) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'icon-btn song-more';
    more.setAttribute('aria-label', t('moreFor', { title: song.title }));
    more.innerHTML = icon('more');
    li.appendChild(more);
  } else {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t('sample');
    li.appendChild(tag);
  }
  void songMeta(song).then((m) => {
    if (!m) return;
    const parts = [countLabel(m.voices, 'voicesOne', 'voicesMany'), countLabel(m.bars, 'barsOne', 'barsMany'), m.key].filter(Boolean);
    meta.replaceChildren(voiceDots(m.voices), document.createTextNode(parts.join(' · ')));
    coverCanvases.set(cover, m.cover);
    requestAnimationFrame(() => drawCoverCanvas(cover));
  });
  return li;
}

function renderSongList() {
  const songs = allSongs();
  const q = searchInput.value.trim().toLowerCase();
  searchWrapEl.hidden = songs.length <= SEARCH_THRESHOLD && !q;
  const shown = q ? songs.filter((s) => s.title.toLowerCase().includes(q)) : songs;
  const items: HTMLElement[] = shown.map(songCard);
  if (libraryState === 'loading') {
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement('li');
      sk.className = 'song-card skeleton';
      sk.setAttribute('aria-hidden', 'true');
      items.push(sk);
    }
  }
  if (q && !shown.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-note';
    empty.textContent = t('noMatches', { q: searchInput.value.trim() });
    items.push(empty);
  }
  coverCanvases.clear();
  songGridEl.replaceChildren(...items);
  const count = countLabel(songs.length, 'arrangementsOne', 'arrangementsMany');
  libCountEl.textContent = libraryState === 'ready' ? t('sharedWithChoir', { count }) : t('onThisDevice', { count });
  renderLibraryBanner();
}

function renderLibraryBanner() {
  libBannerEl.replaceChildren();
  libBannerEl.hidden = libraryState === 'ready';
  if (libraryState === 'ready') return;
  libBannerEl.classList.toggle('muted', libraryState !== 'offline');
  const text = document.createElement('div');
  if (libraryState === 'loading') text.textContent = t('loadingLibrary');
  else if (libraryState === 'unconfigured') text.textContent = t('notConfigured');
  else {
    const b = document.createElement('b');
    b.textContent = t('offlineTitle');
    const p = document.createElement('span');
    p.textContent = t('offlineBody', { msg: libraryError });
    text.append(b, p);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = t('retry');
    retry.addEventListener('click', () => location.reload());
    libBannerEl.append(text, retry);
    return;
  }
  libBannerEl.appendChild(text);
}

searchInput.addEventListener('input', renderSongList);

songGridEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const li = target.closest<HTMLElement>('li.song-card');
  const song = allSongs().find((s) => s.id === li?.dataset.id);
  if (!song) return;
  const more = target.closest<HTMLButtonElement>('.song-more');
  if (more) {
    openMenu(
      more,
      [
        { label: t('rename'), icon: 'pencil', onSelect: () => void renameSong(song) },
        { label: t('delete'), icon: 'trash', danger: true, onSelect: () => void confirmDelete(song) },
      ],
      song.title,
    );
    return;
  }
  if (target.closest('.song-open')) void selectSong(song);
});

async function confirmDelete(song: SongEntry) {
  // A shared-library delete removes the song for everyone, not just this device -- worth a
  // deliberate confirmation step (unlike this app's usual "any device can change shared state
  // immediately" trust model for renames/playback) since it's the one destructive, unrecoverable
  // action in the whole library.
  const ok = await confirmDialog({ title: t('deleteTitle', { title: song.title }), body: t('deleteBody'), confirmLabel: t('delete'), danger: true });
  if (!ok) return;
  // No optimistic local removal: the shared onSnapshot listener updates `importedSongs` and
  // re-renders for every device (including this one) once Firestore reflects the delete.
  try {
    await deleteImportedSong(song.id);
  } catch (err) {
    toast(t('deleteFailed', { msg: errorText(err) }), 'error');
  }
}

async function renameSong(song: SongEntry) {
  const value = await promptDialog(t('renameSong'), song.title, t('save'));
  if (!value) return;
  applySongTitle(song.id, value, song.title);
}

/** Renames a library song everywhere it shows, rolling back if the shared write fails. */
function applySongTitle(songId: string, value: string, previousTitle: string) {
  // Applied immediately, not after the Firestore round-trip resolves -- waiting made every rename
  // visibly flash back to the old title first, and a failed write had no visible sign at all.
  const setLocal = (title: string) => {
    const entry = importedSongs.find((s) => s.id === songId);
    if (entry) entry.title = title;
    if (currentSong?.id === songId) {
      songTitleEl.textContent = title;
      if (currentScore) currentScore.title = title;
    }
    renderSongList();
  };
  setLocal(value);
  void updateSongMetadata(songId, { title: value }).catch((err) => {
    setLocal(previousTitle);
    toast(t('renameFailed', { msg: errorText(err) }), 'error');
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function importFiles(files: FileList | File[]) {
  if (!isFirebaseConfigured) {
    toast(t('notConfigured'), 'error');
    return;
  }
  const list = Array.from(files).filter((f) => ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)));
  if (!list.length) {
    toast(t('wrongFileType'), 'error');
    return;
  }

  let lastImported: SongEntry | null = null;
  for (const file of list) {
    toast(t('adding', { name: file.name }));
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
      toast(t('added', { title }));
    } catch (err) {
      toast(t('addFailed', { name: file.name, msg: err instanceof Error ? err.message : 'invalid file' }), 'error');
    }
  }
  // The onSnapshot listener will render the confirmed list; select the new song immediately
  // rather than waiting on that round trip.
  if (lastImported) void selectSong(lastImported);
}

importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  if (importInput.files?.length) void importFiles(importInput.files);
  importInput.value = '';
});
// Files can be dropped anywhere on the repertoire page, not just on one small target.
let dragDepth = 0;
libraryEl.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  libraryEl.classList.add('drag-over');
});
libraryEl.addEventListener('dragover', (e) => e.preventDefault());
libraryEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) libraryEl.classList.remove('drag-over');
});
libraryEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  libraryEl.classList.remove('drag-over');
  if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------------------------
// Loading a song
// ---------------------------------------------------------------------------------------------

/**
 * Announces a song choice to the shared session; every connected device (including this one)
 * actually loads it once that choice comes back through applyPlaybackState(), same as every other
 * control below -- see pushState()'s doc comment for why nothing here applies state directly.
 */
async function selectSong(song: SongEntry) {
  // Every song starts at its own tempo -- never the previous song's: the saved default, else the
  // tempo written in the file, else 100.
  const fileTempo = (await songMeta(song))?.tempo;
  const startBpm = Math.min(Math.max(Math.round(song.savedConfig?.bpm ?? fileTempo ?? DEFAULT_BPM), MIN_BPM), MAX_BPM);
  pushState({
    songId: song.id,
    playing: false,
    originBeat: 0,
    originServerTimeMs: 0,
    // A saved default (the "Save" action, see saveSongConfig) takes over from the plain reset.
    transpose: song.savedConfig?.transpose ?? 0,
    bpm: startBpm,
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

const fontsReady = canvasFontsReady();

/** Does the actual work of loading a song locally. Only ever called from applyPlaybackState(). */
async function loadSongLocally(song: SongEntry) {
  stopRenderLoop();
  const score = parseSong(song, await readSongText(song));
  await fontsReady;
  if (song.partNameOverrides) {
    for (const part of score.parts) {
      const override = song.partNameOverrides[part.id];
      if (override) part.name = override;
    }
  }
  applyVoiceSetup(score, song);
  // The library title wins over the title embedded in the file -- it's what the repertoire shows,
  // and the only one a rename changes.
  if (song.title) score.title = song.title;
  currentScore = score;
  currentSong = song;
  loadedSongId = song.id;
  notesByPart = new Map(score.parts.map((p) => [p.id, score.notes.filter((n) => n.partId === p.id).sort((a, b) => a.startBeat - b.startBeat)]));
  // Only relevant when the source has no rehearsal marks of its own (see renderSections) --
  // reloaded fresh from this song's saved config every time, never carried over from whatever the
  // previously-open song had.
  manualSections = score.rehearsalMarks.length ? [] : (song.savedConfig?.sections ?? []).slice();
  zoom = 1;
  zoomValueEl.textContent = '100%';
  viewOffsetBeats = 0;
  customStartBeat = null;
  // Force whatever timing/metronome state applyPlaybackState() applies right after this returns
  // to actually run against the brand-new AudioEngine below, rather than being skipped as
  // "unchanged" by comparison against the previous song's last-applied values.
  lastAppliedTiming = null;
  lastAppliedMetronomeOn = false;

  audioEngine?.dispose();
  audioEngine = new AudioEngine(score);
  audioEngine.setDuckedVolume(duckVolume);
  const partColor = (partId: string) => colorForPart(score.parts.findIndex((p) => p.id === partId), score.parts.length);
  currentPartColor = partColor;
  // Shown first so the canvases have a real layout size when the views measure themselves.
  setViewMode('player');
  pianoRoll = new PianoRoll(canvas, score, partColor);
  pianoRoll.setLoopRegion(null);
  staffView = new StaffView(staffCanvas, score, partColor);
  overview = new OverviewStrip(overviewCanvas, score, partColor);
  // MIDI imports have no real notated spelling -- only a heuristic chromatic fallback (see
  // staffView.ts) -- so the sheet-music view isn't offered for them at all. Force back to the
  // piano roll if the previous song was left showing the staff view.
  document.querySelector<HTMLElement>('#view-seg')!.hidden = song.format === 'score';
  if (song.format === 'score' && activeView === 'staff') activeView = 'roll';

  // Mute/solo isn't synced (see PlaybackState's doc comment) -- every device starts a new song
  // with its own fresh, all-normal mix.
  partMix = new Map(score.parts.map((p) => [p.id, 'normal' as PartMixState]));
  songTitleEl.textContent = score.title;
  songTitleEl.title = song.imported ? t('renameSong') : '';
  const first = score.measures[0];
  songMetaEl.textContent = first
    ? [song.format === 'score' ? '' : keyName(first.fifths, first.mode), `${first.beats}/${first.beatType}`, countLabel(score.measures.at(-1)?.number ?? score.measures.length, 'barsOne', 'barsMany')]
        .filter(Boolean)
        .join(' · ')
    : '';
  buildVoiceControls(score);
  applyMixToViews();
  renderSections();
  setActiveView(activeView);
}

// ---------------------------------------------------------------------------------------------
// Shared playback state
// ---------------------------------------------------------------------------------------------

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
 * let it come back through applyPlaybackState(), rather than mutating local state directly.
 * Without the shared session (Solo mode, or no Firebase) there's nothing to round-trip through, so
 * state is applied immediately instead; a "start playing" patch has its sync-buffer origin
 * timestamp zeroed in that case, so AudioEngine.play() takes its normal "as soon as possible" path
 * instead of waiting for a sync instant nothing else is listening for. Mute/solo/true-solo are the
 * one exception -- deliberately local-only, see PlaybackState's doc comment in sync.ts -- so they
 * mutate state directly instead of going through here.
 */
function pushState(patch: Partial<PlaybackState>) {
  if (syncEnabled()) {
    void sync.publishPlaybackState(patch).catch((err) => {
      toast(t('syncFailed', { msg: errorText(err) }), 'error');
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
 * loads doesn't compute its sync target against a default, unmeasured offset. `extraLeadMs` (a
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
      toast(t('waitingForSong'));
      return;
    }
    pendingSongId = null;
    await loadSongLocally(song);
  }

  bpm = state.bpm;
  transpose = state.transpose;
  pianoRoll?.setTranspose(transpose);
  staffView?.setTranspose(transpose);
  loopEnabled = state.loopEnabled;
  loopRegion = state.loopRegion;
  pianoRoll?.setLoopRegion(loopRegion);
  overview?.setLoopRegion(loopRegion);
  // No side effect of its own (only read later, synchronously, inside togglePlay) -- kept
  // unconditional/undedup'd so it's never staler than necessary.
  freshStart = state.freshStart;

  if (!audioEngine) {
    refreshBindings();
    return;
  }

  if (state.metronomeOn !== lastAppliedMetronomeOn) {
    lastAppliedMetronomeOn = state.metronomeOn;
    metronomeOn = state.metronomeOn;
    audioEngine.setMetronomeEnabled(metronomeOn);
  }
  refreshBindings();

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
  if (!timingChanged) {
    renderNow();
    return;
  }

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

/** Current key after transposing, e.g. "A major" -- the key signature moves by fifths with the tonic. */
function transposedKeyName(): string {
  const first = currentScore?.measures[0];
  if (!first || currentSong?.format === 'score') return '';
  const tonic = (((first.fifths * 7) % 12) + 12) % 12;
  let fifths = ((((tonic + transpose) % 12) + 12) % 12) * 7 % 12;
  if (fifths > 6) fifths -= 12;
  return keyName(fifths, first.mode);
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0';
}

/** Pushes the current tempo/key/loop/metronome state into every control bound to it (transport, dock, sheets, popovers). */
function refreshBindings() {
  document.querySelectorAll('[data-bind="bpm"]').forEach((el) => (el.textContent = String(bpm)));
  document.querySelectorAll('[data-bind="transpose"]').forEach((el) => (el.textContent = signed(transpose)));
  const keyNow = transposedKeyName();
  document.querySelectorAll('[data-bind="key"]').forEach((el) => (el.textContent = keyNow));
  document.querySelectorAll('[data-bind="key-short"]').forEach((el) => (el.textContent = keyNow ? `${keyNow.split(/[ -]/)[0]} · ${signed(transpose)}` : signed(transpose)));
  document.querySelectorAll<HTMLButtonElement>('.bpm-preset').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.bpm) === bpm)));
  // Skipped while a field has focus -- otherwise a remote BPM change (another device's preset
  // click, in Ensemble mode) would overwrite whatever this device is still mid-typing.
  document.querySelectorAll<HTMLInputElement>('.bpm-input').forEach((input) => {
    if (document.activeElement !== input) input.value = String(bpm);
  });
  document.querySelectorAll<HTMLElement>('[data-action="metronome"]').forEach((el) => {
    el.setAttribute(el.getAttribute('role') === 'switch' ? 'aria-checked' : 'aria-pressed', String(metronomeOn));
  });
  document.querySelectorAll<HTMLElement>('[data-bind-metro]').forEach((el) => el.classList.toggle('on', metronomeOn));
  let loopTitle: string;
  if (loopEnabled) loopTitle = t('stopLooping');
  else if (loopRegion && currentScore) {
    const from = measureAtBeat(currentScore, loopRegion.start)?.number ?? 1;
    const to = measureAtBeat(currentScore, Math.max(loopRegion.start, loopRegion.end - 0.001))?.number ?? from;
    loopTitle = t('loopRegion', { from, to });
  } else loopTitle = t('loopWhole');
  document.querySelectorAll<HTMLElement>('[data-action="loop"]').forEach((el) => {
    el.setAttribute('aria-pressed', String(loopEnabled));
    el.setAttribute('aria-label', loopTitle);
    el.title = loopTitle;
  });
}

function syncPlayButtons(playing: boolean) {
  document.querySelectorAll<HTMLButtonElement>('[data-action="play"]').forEach((b) => {
    b.innerHTML = icon(playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? t('pause') : t('play'));
    b.classList.toggle('playing', playing);
  });
  if (playing) void requestWakeLock();
  else releaseWakeLock();
}

// Keeps the phone screen on while music plays -- a song running past the screen timeout used to
// dim and lock the phone mid-rehearsal.
let wakeLock: { release: () => Promise<void> } | null = null;
async function requestWakeLock() {
  const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } };
  if (!nav.wakeLock || wakeLock) return;
  try {
    wakeLock = await nav.wakeLock.request('screen');
  } catch {
    wakeLock = null; // denied or unsupported -- harmless
  }
}
function releaseWakeLock() {
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  // The browser drops a wake lock whenever the page is hidden; take it again on return.
  wakeLock = null;
  if (document.visibilityState === 'visible' && audioEngine?.isPlaying()) void requestWakeLock();
});

// ---------------------------------------------------------------------------------------------
// Voices: sidebar rows, phone chips, mixer sheet
// ---------------------------------------------------------------------------------------------

function voiceRow(partId: string, name: string, color: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'voice-row';
  li.dataset.part = partId;
  li.style.setProperty('--c', color);
  const light = document.createElement('i');
  light.className = 'light';
  light.dataset.part = partId;
  light.setAttribute('aria-hidden', 'true');
  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'voice-name';
  nameBtn.textContent = name;
  nameBtn.title = t('onlyVoice', { name });
  li.append(light, nameBtn);
  for (const [mix, letter, label] of [
    ['muted', 'M', t('mute', { name })],
    ['solo', 'S', t('soloVoice', { name })],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mix-btn ${mix === 'muted' ? 'mute-btn' : 'solo-btn'}`;
    b.dataset.mix = mix;
    b.textContent = letter;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.setAttribute('aria-pressed', 'false');
    li.appendChild(b);
  }
  if (currentSong?.imported) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'icon-btn small voice-more';
    more.setAttribute('aria-label', t('voiceMenu', { name }));
    more.title = t('voiceMenu', { name });
    more.innerHTML = icon('more');
    li.appendChild(more);
  }
  return li;
}

function buildVoiceControls(score: Score) {
  voiceListEl.replaceChildren(...score.parts.map((p, i) => voiceRow(p.id, p.name, colorForPart(i, score.parts.length))));
  const chips = score.parts.map((p, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.part = p.id;
    chip.style.setProperty('--c', colorForPart(i, score.parts.length));
    chip.innerHTML = '<i aria-hidden="true"></i>';
    chip.append(document.createTextNode(p.name));
    chip.title = t('onlyVoice', { name: p.name });
    return chip;
  });
  chipsEl.replaceChildren(...chips);
}

function applyMixToViews() {
  if (!currentScore) return;
  pianoRoll?.setPartMix(partMix);
  staffView?.setPartMix(partMix);
  const anySolo = Array.from(partMix.values()).some((s) => s === 'solo');
  const hidden = new Set<string>();
  const dimmed = new Set<string>();
  for (const [id, s] of partMix) {
    if (s === 'muted') hidden.add(id);
    else if (anySolo && s !== 'solo') dimmed.add(id);
  }
  overview?.setMix(dimmed, hidden);
  document.querySelectorAll<HTMLElement>('.voice-row').forEach((row) => {
    const state = partMix.get(row.dataset.part!) ?? 'normal';
    row.classList.toggle('is-muted', state === 'muted');
    row.classList.toggle('is-solo', state === 'solo');
    row.classList.toggle('is-dimmed', dimmed.has(row.dataset.part!));
    row.querySelector('.mute-btn')?.setAttribute('aria-pressed', String(state === 'muted'));
    row.querySelector('.solo-btn')?.setAttribute('aria-pressed', String(state === 'solo'));
  });
  document.querySelectorAll<HTMLElement>('.chip[data-part]').forEach((chip) => {
    const state = partMix.get(chip.dataset.part!) ?? 'normal';
    chip.classList.toggle('is-muted', state === 'muted');
    chip.classList.toggle('is-solo', state === 'solo');
    chip.classList.toggle('is-dimmed', dimmed.has(chip.dataset.part!));
  });
  document.querySelectorAll<HTMLInputElement>('.duck-range').forEach((r) => (r.value = String(duckVolume)));
  document.querySelectorAll('.duck-value').forEach((o) => (o.textContent = `${Math.round(duckVolume * 100)}%`));
  renderNow();
}

function setPartMixState(partId: string, next: PartMixState) {
  partMix.set(partId, next);
  audioEngine?.setPartMixState(partId, next);
}

/**
 * "Only this voice": mutes AND hides every other voice so only this one is visible/audible (unlike
 * the Solo button, which just ducks/dims the others). Clicking the same voice again restores everyone.
 */
function toggleTrueSolo(partId: string) {
  if (!audioEngine || !currentScore) return;
  const alreadyIsolated = partMix.get(partId) !== 'muted' && currentScore.parts.every((p) => p.id === partId || partMix.get(p.id) === 'muted');
  for (const p of currentScore.parts) setPartMixState(p.id, alreadyIsolated || p.id === partId ? 'normal' : 'muted');
  applyMixToViews();
}

function toggleMix(partId: string, action: PartMixState) {
  const current = partMix.get(partId) ?? 'normal';
  setPartMixState(partId, current === action ? 'normal' : action);
  applyMixToViews();
}

async function renameVoice(partId: string) {
  const part = currentScore?.parts.find((p) => p.id === partId);
  if (!part || !currentSong?.imported) return;
  const songId = currentSong.id;
  const previousName = part.name;
  const value = await promptDialog(t('renameVoice'), previousName, t('save'));
  if (!value) return;
  const setName = (name: string) => {
    part.name = name;
    document.querySelectorAll<HTMLElement>(`.voice-row[data-part="${CSS.escape(partId)}"] .voice-name`).forEach((el) => (el.textContent = name));
    document.querySelectorAll<HTMLElement>(`.chip[data-part="${CSS.escape(partId)}"]`).forEach((chip) => {
      chip.replaceChildren(chip.firstChild!, document.createTextNode(name));
    });
  };
  // Applied immediately, rolled back on failure -- see applySongTitle.
  setName(value);
  void updateSongMetadata(songId, { partName: { partId, name: value } }).catch((err) => {
    if (currentSong?.id === songId) setName(previousName);
    toast(t('renameFailed', { msg: errorText(err) }), 'error');
  });
}

const CLEF_SPECS: Record<VoiceClef, NonNullable<Score['parts'][number]['clef']>> = {
  treble: { sign: 'G', line: 2 },
  treble8: { sign: 'G', line: 2, octaveChange: -1 },
  bass: { sign: 'F', line: 4 },
};

/** Applies the song's removed voices and clef choices (both stored beside the score, never in it). */
function applyVoiceSetup(score: Score, song: SongEntry) {
  const removed = new Set(song.removedParts ?? []);
  // Never leave a song without voices, even if the stored list says otherwise.
  if (removed.size && score.parts.some((p) => !removed.has(p.id))) {
    score.parts = score.parts.filter((p) => !removed.has(p.id));
    score.notes = score.notes.filter((n) => !removed.has(n.partId));
    score.slurs = score.slurs.filter((sl) => !removed.has(sl.partId));
  }
  for (const part of score.parts) {
    const choice = song.clefOverrides?.[part.id];
    if (choice) part.clef = CLEF_SPECS[choice];
  }
}

function voiceSetupKey(song: SongEntry): string {
  return JSON.stringify([song.removedParts ?? [], song.clefOverrides ?? {}]);
}

/** The clef a voice is shown with -- its chosen/notated clef, else the same pitch heuristic the sheet view uses. */
function currentClef(partId: string): VoiceClef {
  const part = currentScore?.parts.find((p) => p.id === partId);
  if (part?.clef?.sign === 'F') return 'bass';
  if (part?.clef?.sign === 'G') return part.clef.octaveChange === -1 ? 'treble8' : 'treble';
  const notes = notesByPart.get(partId) ?? [];
  const avg = notes.length ? notes.reduce((sum, n) => sum + n.midi, 0) / notes.length : 60;
  return avg >= 60 ? 'treble' : 'bass';
}

function openVoiceMenu(anchor: HTMLElement, partId: string) {
  const part = currentScore?.parts.find((p) => p.id === partId);
  if (!part || !currentSong?.imported) return;
  const items: Parameters<typeof openMenu>[1] = [{ label: t('renameVoice'), icon: 'pencil', onSelect: () => void renameVoice(partId) }];
  // Clefs only matter for the sheet music view, which MIDI imports don't have.
  if (currentSong.format !== 'score') {
    const clef = currentClef(partId);
    for (const [value, label] of [
      ['treble', t('clefTreble')],
      ['treble8', t('clefTenor')],
      ['bass', t('clefBass')],
    ] as const) {
      items.push({ label, icon: 'sheet', checked: clef === value, onSelect: () => void setVoiceClef(partId, value) });
    }
  }
  items.push({ label: t('removeVoice'), icon: 'trash', danger: true, onSelect: () => void confirmRemoveVoice(partId) });
  openMenu(anchor, items, part.name);
}

async function setVoiceClef(partId: string, clef: VoiceClef) {
  const song = currentSong;
  const part = currentScore?.parts.find((p) => p.id === partId);
  if (!song?.imported || !part) return;
  // Applied locally straight away; written for everyone in the background (rolled back if it fails).
  const previous = { ...(song.clefOverrides ?? {}) };
  song.clefOverrides = { ...previous, [partId]: clef };
  part.clef = CLEF_SPECS[clef];
  rebuildStaffView();
  try {
    await updateSongMetadata(song.id, { clef: { partId, clef } });
  } catch (err) {
    song.clefOverrides = previous;
    toast(t('changeFailed', { msg: errorText(err) }), 'error');
    void reloadCurrentSong();
  }
}

async function confirmRemoveVoice(partId: string) {
  const part = currentScore?.parts.find((p) => p.id === partId);
  if (!part || !currentSong?.imported || !currentScore) return;
  if (currentScore.parts.length <= 1) {
    toast(t('lastVoice'), 'error');
    return;
  }
  const ok = await confirmDialog({ title: t('removeVoiceTitle', { name: part.name }), body: t('removeVoiceBody'), confirmLabel: t('remove'), danger: true });
  if (!ok) return;
  await setRemovedParts([...(currentSong.removedParts ?? []), partId]);
}

/** Writes the song's removed-voice list for everyone and reloads the open song with it. */
async function setRemovedParts(removedParts: string[]) {
  const song = currentSong;
  if (!song?.imported) return;
  const previous = song.removedParts;
  song.removedParts = removedParts;
  const entry = importedSongs.find((s) => s.id === song.id);
  if (entry) entry.removedParts = removedParts;
  closeOverlay();
  await reloadCurrentSong();
  try {
    await updateSongMetadata(song.id, { removedParts });
  } catch (err) {
    song.removedParts = previous;
    if (entry) entry.removedParts = previous;
    toast(t('changeFailed', { msg: errorText(err) }), 'error');
    await reloadCurrentSong();
  }
}

/** Reloads the open song (paused, same position/tempo/key) after its voice setup changed. */
async function reloadCurrentSong() {
  if (!currentSong) return;
  const song = importedSongs.find((s) => s.id === currentSong!.id) ?? currentSong;
  const state = currentStateSnapshot();
  audioEngine?.stop();
  loadedSongId = null;
  await applyPlaybackState({ ...state, songId: song.id, playing: false, originServerTimeMs: 0 });
}

/** Recreates the sheet view (after a clef change), keeping its zoom/transpose/mix/sections. */
function rebuildStaffView() {
  if (!currentScore || !currentPartColor) return;
  staffView = new StaffView(staffCanvas, currentScore, currentPartColor);
  staffView.setTranspose(transpose);
  staffView.setZoom(zoom);
  staffView.setPartMix(partMix);
  staffView.setSections(effectiveSections());
  resizeCanvases();
}

function openMixerSheet(opener: HTMLElement) {
  if (!currentScore) return;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-body';
  const list = document.createElement('ul');
  list.className = 'voice-list';
  currentScore.parts.forEach((p, i) => {
    list.appendChild(voiceRow(p.id, p.name, colorForPart(i, currentScore!.parts.length)));
  });
  const duck = document.createElement('div');
  duck.className = 'duck';
  duck.innerHTML = `<label class="label" for="duck-range-sheet"></label><div class="duck-row"><input type="range" class="duck-range" id="duck-range-sheet" min="0" max="0.75" step="0.05" /><output class="duck-value"></output></div>`;
  duck.querySelector('label')!.textContent = t('othersWhileSoloing');
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn wide';
  reset.dataset.action = 'mix-reset';
  reset.textContent = t('reset');
  wrap.append(list, duck, reset);
  openSheet(t('voices'), wrap, opener);
  applyMixToViews();
}

// ---------------------------------------------------------------------------------------------
// Tempo, key, sections, go-to-bar panels
// ---------------------------------------------------------------------------------------------

function tempoBlock(): HTMLElement {
  const block = document.createElement('div');
  block.className = 'ctl-block';
  block.innerHTML = `
    <div class="ctl-head"><span class="label">${t('tempo')}</span></div>
    <div class="big-stepper">
      <button type="button" class="round-btn" data-action="bpm-down" aria-label="${t('slower')}">${icon('minus')}</button>
      <span class="big-value">${icon('quarter')}<span>= <b data-bind="bpm"></b></span></span>
      <button type="button" class="round-btn" data-action="bpm-up" aria-label="${t('faster')}">${icon('plus')}</button>
    </div>
    <div class="presets">
      ${BPM_PRESETS.map((b) => `<button type="button" class="bpm-preset" data-action="bpm-preset" data-bpm="${b}" aria-pressed="false">${b}</button>`).join('')}
    </div>
    <label class="custom-tempo"><span>${t('customTempo')}</span><input class="bpm-input field" type="number" min="${MIN_BPM}" max="${MAX_BPM}" step="1" inputmode="numeric" /></label>`;
  return block;
}

function keyBlock(): HTMLElement {
  const block = document.createElement('div');
  block.className = 'ctl-block';
  const first = currentScore?.measures[0];
  block.innerHTML = `
    <div class="ctl-head"><span class="label">${t('key')}</span><span class="ctl-note"></span></div>
    <div class="big-stepper">
      <button type="button" class="round-btn" data-action="transpose-down" aria-label="${t('lower')}">${icon('minus')}</button>
      <span class="big-value"><b data-bind="transpose"></b><small data-bind="key"></small></span>
      <button type="button" class="round-btn" data-action="transpose-up" aria-label="${t('higher')}">${icon('plus')}</button>
    </div>`;
  if (first && currentSong?.format !== 'score') block.querySelector('.ctl-note')!.textContent = t('writtenIn', { key: keyName(first.fifths, first.mode) });
  return block;
}

function gotoBlock(): HTMLElement {
  const block = document.createElement('form');
  block.className = 'ctl-block goto';
  const maxBar = currentScore?.measures.at(-1)?.number ?? 1;
  const current = currentScore ? (measureAtBeat(currentScore, engineBeat())?.number ?? 1) : 1;
  block.innerHTML = `
    <label class="label" for="goto-input">${t('goToBar')}</label>
    <div class="goto-row">
      <input id="goto-input" class="field measure-input" type="number" min="1" max="${maxBar}" step="1" inputmode="numeric" value="${current}" />
      <button type="submit" class="btn primary">${t('go')}</button>
    </div>`;
  block.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = block.querySelector<HTMLInputElement>('input')!;
    const n = Math.min(Math.max(parseInt(input.value, 10) || 1, 1), maxBar);
    input.value = String(n);
    jumpToMeasure(n);
    closeOverlay();
  });
  return block;
}

function sectionsBlock(): HTMLElement | null {
  const sections = effectiveSections();
  if (!sections.length) return null;
  const block = document.createElement('div');
  block.className = 'ctl-block';
  const head = document.createElement('div');
  head.className = 'ctl-head';
  head.innerHTML = `<span class="label">${t('sections')}</span>`;
  const note = document.createElement('span');
  note.className = 'ctl-note';
  if (!currentScore?.rehearsalMarks.length && currentSong?.imported) note.textContent = t('addSectionsOnLaptop');
  head.appendChild(note);
  const row = document.createElement('div');
  row.className = 'mark-row';
  sections.forEach((s, i) => row.appendChild(sectionButton(s.label, i)));
  block.append(head, row);
  return block;
}

function metronomeBlock(): HTMLElement {
  const block = document.createElement('div');
  block.className = 'ctl-block switch-row';
  block.innerHTML = `<span><b>${t('metronome')}</b><span class="ctl-note">${t('countInHint')}</span></span><button type="button" class="switch" role="switch" data-action="metronome" aria-checked="false" aria-label="${t('metronome')}"></button>`;
  return block;
}

function openControlsSheet(opener: HTMLElement) {
  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.append(tempoBlock(), keyBlock(), metronomeBlock());
  const sections = sectionsBlock();
  if (sections) body.appendChild(sections);
  body.appendChild(gotoBlock());
  openSheet(t('tempoAndKey'), body, opener);
  refreshBindings();
}

// ---------------------------------------------------------------------------------------------
// Transport actions
// ---------------------------------------------------------------------------------------------

function togglePlay() {
  if (!audioEngine || !currentScore) return;
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

/** Stops playback and resets to the loop region's start, the last ruler-set start point, or the beginning. */
function stopPlayback() {
  if (!audioEngine || !currentScore) return;
  const wasPlaying = audioEngine.isPlaying();
  const priorPausedBeat = audioEngine.getPausedBeat();
  const target = loopRegion ? loopRegion.start : (customStartBeat ?? 0);
  // Pressing Stop again while already stopped at the target (loop/custom start) goes the rest of
  // the way to the very beginning, same as a media player's Stop button.
  const alreadyAtTarget = !wasPlaying && Math.abs(priorPausedBeat - target) < 0.01;
  const resetBeat = alreadyAtTarget ? 0 : target;
  pushState({ playing: false, originBeat: resetBeat, originServerTimeMs: 0, freshStart: true });
}

function applyBpm(newBpm: number) {
  const clamped = Math.min(Math.max(Math.round(newBpm), MIN_BPM), MAX_BPM);
  if (clamped === bpm) return;
  if (audioEngine?.isPlaying()) {
    // Explicitly zeroed, not omitted: publishPlaybackState is a merge write, so an omitted
    // field would keep whatever count-in the last fresh Play set, silently reattaching a
    // several-second count-in-then-delay to an ordinary BPM change.
    void publishPlayingAt(audioEngine.getCurrentBeat(), { bpm: clamped, countInBeats: 0, countInPulseBeats: 1 });
  } else {
    pushState({ bpm: clamped });
  }
}

/** Reads/clamps a custom BPM field and applies it. Ignores an empty field instead of coercing it
 *  to MIN_BPM, so clearing the field to retype doesn't briefly apply a wrong tempo. */
function applyBpmInput(input: HTMLInputElement) {
  if (!input.value.trim()) return;
  const n = Math.min(Math.max(parseInt(input.value, 10) || bpm, MIN_BPM), MAX_BPM);
  input.value = String(n);
  applyBpm(n);
}
document.addEventListener('change', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('bpm-input')) applyBpmInput(target as HTMLInputElement);
});
document.addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  if (!target.classList?.contains('duck-range')) return;
  duckVolume = parseFloat(target.value);
  audioEngine?.setDuckedVolume(duckVolume);
  document.querySelectorAll<HTMLInputElement>('.duck-range').forEach((r) => r !== target && (r.value = target.value));
  document.querySelectorAll('.duck-value').forEach((o) => (o.textContent = `${Math.round(duckVolume * 100)}%`));
});
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (e.key === 'Enter' && target.classList?.contains('bpm-input')) {
    e.preventDefault();
    applyBpmInput(target as HTMLInputElement);
    (target as HTMLInputElement).blur();
  }
});

function jumpToMeasure(n: number) {
  if (!currentScore) return;
  const measure = currentScore.measures.find((m) => m.number === n);
  if (measure) seekToBeat(measure.startBeat, { recenterView: true });
}

/** One bar back/forward from the bar under the playhead -- snapping to the bar start first when mid-bar going back. */
function stepMeasure(delta: number) {
  if (!currentScore) return;
  const measures = currentScore.measures;
  const beat = engineBeat();
  const idx = Math.max(0, measures.findIndex((m) => m === measureAtBeat(currentScore!, beat)));
  let targetIdx = idx + delta;
  if (delta < 0 && beat - measures[idx].startBeat > 0.25) targetIdx = idx;
  targetIdx = Math.min(Math.max(targetIdx, 0), measures.length - 1);
  seekToBeat(measures[targetIdx].startBeat, { recenterView: true });
}

// Press-and-hold acceleration for previous/next bar: a tap moves one bar, holding repeats and
// speeds up -- the phone substitute for typing a bar number.
const STEPPER_INITIAL_DELAY_MS = 400;
const STEPPER_MIN_INTERVAL_MS = 60;
const STEPPER_ACCELERATION = 0.75;
let stepperTimeoutId: number | null = null;
function stopHold() {
  if (stepperTimeoutId != null) {
    clearTimeout(stepperTimeoutId);
    stepperTimeoutId = null;
  }
}
document.addEventListener('pointerdown', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-hold]');
  if (!btn || e.button > 0) return;
  const delta = Number(btn.dataset.hold);
  stepMeasure(delta);
  let intervalMs = STEPPER_INITIAL_DELAY_MS;
  const next = () => {
    stepperTimeoutId = window.setTimeout(() => {
      stepMeasure(delta);
      intervalMs = Math.max(STEPPER_MIN_INTERVAL_MS, intervalMs * STEPPER_ACCELERATION);
      next();
    }, intervalMs);
  };
  stopHold();
  next();
  const end = () => {
    stopHold();
    btn.removeEventListener('pointerup', end);
    btn.removeEventListener('pointerleave', end);
    btn.removeEventListener('pointercancel', end);
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointerleave', end);
  btn.addEventListener('pointercancel', end);
});

function applyTranspose(delta: number) {
  if (!audioEngine) return;
  const newTranspose = Math.max(MIN_TRANSPOSE, Math.min(MAX_TRANSPOSE, transpose + delta));
  if (newTranspose === transpose) return;
  if (audioEngine.isPlaying()) {
    // See the BPM handler's comment: explicitly zeroed so a stale count-in never reattaches.
    void publishPlayingAt(audioEngine.getCurrentBeat(), { transpose: newTranspose, countInBeats: 0, countInPulseBeats: 1 });
  } else {
    pushState({ transpose: newTranspose });
  }
}

function applyZoom(factor: number) {
  if (!pianoRoll && !staffView) return;
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
  pianoRoll?.setZoom(zoom);
  staffView?.setZoom(zoom);
  zoomValueEl.textContent = `${Math.round(zoom * 100)}%`;
  clampViewOffset();
  renderNow();
}

/** Rehearsal marks straight from the source when it has any; otherwise whatever the user has
 *  manually marked for this song (see manualSections' own doc comment). */
function effectiveSections(): { label: string; beat: number }[] {
  return currentScore?.rehearsalMarks.length ? currentScore.rehearsalMarks : manualSections;
}

/** A boxed rehearsal letter that jumps to its section -- the same look as a printed score's marks. */
function sectionButton(label: string, index: number): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rmark';
  b.dataset.action = 'section-jump';
  b.dataset.index = String(index);
  b.textContent = label;
  b.title = t('jumpToSection', { label });
  b.setAttribute('aria-label', t('jumpToSection', { label }));
  return b;
}

/** Places the section letters over the whole-piece strip, and sets whether + (add) is offered. */
function renderSections() {
  const sections = effectiveSections();
  pianoRoll?.setSections(sections);
  staffView?.setSections(sections);
  const total = currentScore?.totalBeats || 1;
  sectionMarksEl.replaceChildren(
    ...sections.map((s, i) => {
      const b = sectionButton(s.label, i);
      b.style.left = `calc(16px + (100% - 32px) * ${Math.max(0, Math.min(1, s.beat / total))})`;
      return b;
    }),
  );
  // Hand-adding marks only makes sense when the source didn't already provide a complete set --
  // and only for a song this device can write a saved default back to.
  sectionAddBtn.hidden = !currentSong?.imported || (currentScore?.rehearsalMarks.length ?? 0) > 0;
}

function openPlayerMenu(anchor: HTMLElement) {
  const items: Parameters<typeof openMenu>[1] = [];
  if (currentSong?.imported) {
    items.push({ label: t('renameSong'), icon: 'pencil', onSelect: () => currentSong && void renameSong(currentSong) });
    const removed = currentSong.removedParts?.length ?? 0;
    if (removed) items.push({ label: t('restoreVoices', { n: removed }), icon: 'users', onSelect: () => void setRemovedParts([]) });
    // Saving defaults is a laptop task, like adding sections.
    if (!isNarrow()) items.push({ label: t('saveDefaults'), icon: 'save', onSelect: saveDefaults });
  }
  items.push(...languageItems());
  openMenu(anchor, items, t('menu'));
}

function saveDefaults() {
  if (!currentSong?.imported) return;
  saveSongConfig(currentSong.id, { transpose, bpm, sections: manualSections })
    .then(() => toast(t('savedDefaults')))
    .catch((err) => toast(t('saveDefaultsFailed', { msg: errorText(err) }), 'error'));
}

// One delegated click handler for every [data-action] control -- the laptop transport, the phone
// dock, sheets and popovers all share it, so duplicated controls can't drift apart.
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const voiceRowEl = target.closest<HTMLElement>('.voice-row');
  if (voiceRowEl) {
    const partId = voiceRowEl.dataset.part!;
    const mixBtn = target.closest<HTMLElement>('.mix-btn');
    if (mixBtn) toggleMix(partId, mixBtn.dataset.mix as PartMixState);
    else if (target.closest('.voice-more')) openVoiceMenu(target.closest<HTMLElement>('.voice-more')!, partId);
    else if (target.closest('.voice-name')) toggleTrueSolo(partId);
    return;
  }
  const chip = target.closest<HTMLElement>('.chip[data-part]');
  if (chip) {
    toggleTrueSolo(chip.dataset.part!);
    return;
  }
  const el = target.closest<HTMLElement>('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'play':
      togglePlay();
      break;
    case 'stop':
      stopPlayback();
      break;
    case 'loop':
      if (currentScore) pushState({ loopEnabled: !loopEnabled });
      break;
    case 'metronome':
      if (audioEngine) pushState({ metronomeOn: !metronomeOn });
      break;
    case 'bpm-down':
      applyBpm(bpm - (bpm > 60 ? 5 : 2));
      break;
    case 'bpm-up':
      applyBpm(bpm + (bpm >= 60 ? 5 : 2));
      break;
    case 'bpm-preset':
      applyBpm(Number(el.dataset.bpm));
      break;
    case 'transpose-down':
      applyTranspose(-1);
      break;
    case 'transpose-up':
      applyTranspose(1);
      break;
    case 'zoom-in':
      applyZoom(ZOOM_STEP);
      break;
    case 'zoom-out':
      applyZoom(1 / ZOOM_STEP);
      break;
    case 'view':
      setActiveView(el.dataset.view === 'staff' ? 'staff' : 'roll');
      break;
    case 'mode':
      void requestModeSwitch(el.dataset.mode === 'ensemble' ? 'ensemble' : 'solo');
      break;
    case 'mix-reset':
      if (currentScore) {
        for (const p of currentScore.parts) setPartMixState(p.id, 'normal');
        applyMixToViews();
      }
      break;
    case 'open-mixer':
      openMixerSheet(el);
      break;
    case 'open-controls':
      openControlsSheet(el);
      break;
    case 'open-tempo': {
      const panel = document.createElement('div');
      panel.className = 'popover-body';
      panel.appendChild(tempoBlock());
      openPopover(el, panel, 'center');
      refreshBindings();
      break;
    }
    case 'goto': {
      const panel = document.createElement('div');
      panel.className = 'popover-body';
      panel.appendChild(gotoBlock());
      openPopover(el, panel, 'start');
      break;
    }
    case 'section-jump': {
      const section = effectiveSections()[Number(el.dataset.index)];
      if (section) seekToBeat(section.beat, { recenterView: true });
      closeOverlay();
      break;
    }
    case 'section-add':
      if (currentSong?.imported && audioEngine) {
        const label = manualSections.length < 26 ? String.fromCharCode(65 + manualSections.length) : `#${manualSections.length + 1}`;
        manualSections.push({ label, beat: engineBeat() });
        manualSections.sort((a, b) => a.beat - b.beat);
        renderSections();
        renderNow();
      }
      break;
  }
});
document.querySelector<HTMLButtonElement>('#player-menu-btn')!.addEventListener('click', (e) => openPlayerMenu(e.currentTarget as HTMLElement));
voiceListEl.addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.voice-row');
  if (row && (e.target as HTMLElement).closest('.voice-name')) void renameVoice(row.dataset.part!);
});
songTitleEl.addEventListener('dblclick', () => currentSong?.imported && void renameSong(currentSong));

window.addEventListener('keydown', (e) => {
  if (!app.classList.contains('mode-player') || document.querySelector('.overlay')) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    stepMeasure(e.key === 'ArrowLeft' ? -1 : 1);
  } else if (e.key === 'l' || e.key === 'L') {
    if (currentScore) pushState({ loopEnabled: !loopEnabled });
  } else if (e.key === 'm' || e.key === 'M') {
    if (audioEngine) pushState({ metronomeOn: !metronomeOn });
  }
});

// ---------------------------------------------------------------------------------------------
// Position, seeking, panning
// ---------------------------------------------------------------------------------------------

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
  // exactly what put the playhead out of sync with the music. Still allowed while paused/stopped,
  // to browse the score.
  if (audioEngine?.isPlaying()) return;
  viewOffsetBeats += deltaBeats;
  clampViewOffset();
  scheduleRender();
}

/**
 * Sets where the next Play (or an already-playing transport) should be. `recenterView`, when true
 * (bar jumps, sections), snaps the view to the new position -- "take me there." When false
 * (default; ruler taps), the view stays exactly where it was so the screen doesn't jump for someone
 * who's just marking a start point while reading elsewhere.
 */
function seekToBeat(beat: number, opts?: { recenterView?: boolean }) {
  if (!audioEngine || !currentScore) return;
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
  if (!currentScore) return;
  const start = Math.max(0, Math.min(beatA, beatB));
  const end = Math.min(currentScore.totalBeats, Math.max(beatA, beatB));
  if (end - start < MIN_LOOP_BEATS) {
    pushState({ loopRegion: null });
  } else {
    pushState({ loopRegion: { start, end }, loopEnabled: true });
  }
}

/**
 * Coalesces render requests to at most one per animation frame. Wheel/trackpad events and
 * pointermove can fire far faster than the display refreshes (100+/sec during a fast swipe);
 * rendering synchronously per event does far more repaint work than can ever be shown.
 */
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderNow();
  });
}

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!pianoRoll) return;
    e.preventDefault();
    if (e.ctrlKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      applyZoom(Math.exp(-e.deltaY * 0.01));
    } else if (e.shiftKey) {
      panByBeats(e.deltaY / pianoRoll.getPixelsPerBeat());
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Trackpad gestures are rarely perfectly axis-aligned; picking whichever delta actually
      // dominates keeps an intended vertical scroll from bleeding horizontal pan into the view.
      panByBeats(e.deltaX / pianoRoll.getPixelsPerBeat());
    } else if (e.deltaY !== 0) {
      pianoRoll.scrollByPixels(e.deltaY);
      scheduleRender();
    }
  },
  { passive: false },
);

/**
 * Two-finger pinch-to-zoom, shared by both canvases. Tracks every currently-down pointer by id;
 * once exactly two are down, each move reports the ratio of the new inter-finger distance to the
 * previous move's (incremental, since applyZoom() expects a per-call multiplicative factor).
 */
class PinchZoomTracker {
  private points = new Map<number, { x: number; y: number }>();
  private lastDist: number | null = null;

  get activeCount(): number {
    return this.points.size;
  }

  private currentDist(): number | null {
    const pts = Array.from(this.points.values());
    return pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : null;
  }

  onPointerDown(e: PointerEvent) {
    this.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.lastDist = this.currentDist();
  }

  /** Returns a zoom ratio to apply once two fingers are down, else null (nothing to do). */
  onPointerMove(e: PointerEvent): number | null {
    if (!this.points.has(e.pointerId)) return null;
    this.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dist = this.currentDist();
    if (dist == null) return null;
    const ratio = this.lastDist ? dist / this.lastDist : 1;
    this.lastDist = dist;
    return ratio;
  }

  onPointerUp(e: PointerEvent) {
    this.points.delete(e.pointerId);
    this.lastDist = this.currentDist();
  }
}

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

const rollPinch = new PinchZoomTracker();

canvas.addEventListener('pointerdown', (e) => {
  if (!pianoRoll || !currentScore) return;
  rollPinch.onPointerDown(e);
  if (rollPinch.activeCount >= 2) {
    // A second finger just came down mid-drag -- abandon whatever single-pointer gesture (pan,
    // scroll, or a ruler loop-selection) was in progress and hand off to the pinch instead.
    dragPointerId = null;
    loopSelectStartBeat = null;
    canvas.classList.remove('dragging');
    return;
  }
  updateCanvasRect();
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
  const pinchRatio = rollPinch.onPointerMove(e);
  if (pinchRatio != null) {
    applyZoom(pinchRatio);
    return;
  }
  if (dragPointerId !== e.pointerId || !pianoRoll) return;
  const totalDx = e.clientX - dragStartX;
  const totalDy = e.clientY - dragStartY;
  if (Math.hypot(totalDx, totalDy) > CLICK_DRAG_THRESHOLD_PX) dragMoved = true;

  if (loopSelectStartBeat != null) {
    const endBeat = clientXToBeat(e.clientX);
    pianoRoll.setLoopRegion({ start: Math.min(loopSelectStartBeat, endBeat), end: Math.max(loopSelectStartBeat, endBeat) });
    scheduleRender();
  } else {
    // Lock to whichever axis the drag committed to early on: real pointer movement is rarely
    // perfectly straight, and applying both axes' deltas on every move let a drag meant as
    // vertical-only bleed a little horizontal pan into the view (and vice versa).
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
  rollPinch.onPointerUp(e);
  if (dragPointerId !== e.pointerId) return;
  dragPointerId = null;
  canvas.classList.remove('dragging');

  if (loopSelectStartBeat != null) {
    if (dragMoved) {
      finalizeLoopSelection(loopSelectStartBeat, clientXToBeat(e.clientX));
    } else {
      // A tap (not a drag) in the ruler sets the start point, snapped to the containing
      // measure's start ("grid locking") so a slightly-off tap lands exactly on a bar line.
      const snapped = currentScore ? (measureAtBeat(currentScore, loopSelectStartBeat)?.startBeat ?? loopSelectStartBeat) : loopSelectStartBeat;
      clearLoopRegion();
      seekToBeat(snapped);
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
      // The label is only shown briefly, while the tone plays.
      previewNoteTimeout = window.setTimeout(() => {
        previewNoteTimeout = null;
        pianoRoll?.setPreviewNote(null);
        renderNow();
      }, PREVIEW_NOTE_LABEL_MS);
    } else {
      const keyboardMidi = pianoRoll.hitTestKeyboard(e.clientX - canvasLeft, e.clientY - canvasTop, displayBeat());
      // The keyboard strip near beat 0 (see pianoRoll.ts) isn't a real NoteEvent -- just plays the
      // tone, no preview label.
      if (keyboardMidi != null) audioEngine?.previewNote(keyboardMidi);
      pianoRoll.setPreviewNote(null);
    }
    // Nothing else forces a redraw while paused -- without this the label would never appear.
    renderNow();
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', (e) => {
  rollPinch.onPointerUp(e);
  dragPointerId = null;
  loopSelectStartBeat = null;
  canvas.classList.remove('dragging');
});

// Whole-piece strip: click jumps (to the bar start); a mouse drag marks a loop; a touch drag
// scrubs through the piece and commits the position on release.
let overviewPointer: { id: number; startX: number; moved: boolean; touch: boolean } | null = null;
function overviewBeat(clientX: number): number {
  const rect = overviewCanvas.getBoundingClientRect();
  return overview ? overview.xToBeat(clientX - rect.left) : 0;
}
overviewCanvas.addEventListener('pointerdown', (e) => {
  if (!overview || !currentScore) return;
  overviewPointer = { id: e.pointerId, startX: e.clientX, moved: false, touch: e.pointerType !== 'mouse' };
  overviewCanvas.setPointerCapture(e.pointerId);
});
overviewCanvas.addEventListener('pointermove', (e) => {
  if (!overviewPointer || overviewPointer.id !== e.pointerId || !overview || !currentScore) return;
  if (Math.abs(e.clientX - overviewPointer.startX) > CLICK_DRAG_THRESHOLD_PX) overviewPointer.moved = true;
  if (!overviewPointer.moved) return;
  if (overviewPointer.touch) {
    if (audioEngine?.isPlaying()) return;
    viewOffsetBeats = overviewBeat(e.clientX) - engineBeat();
    clampViewOffset();
    scheduleRender();
  } else {
    const a = overviewBeat(overviewPointer.startX);
    const b = overviewBeat(e.clientX);
    const region = { start: Math.min(a, b), end: Math.max(a, b) };
    pianoRoll?.setLoopRegion(region);
    overview.setLoopRegion(region);
    scheduleRender();
  }
});
overviewCanvas.addEventListener('pointerup', (e) => {
  if (!overviewPointer || overviewPointer.id !== e.pointerId || !currentScore) return;
  const p = overviewPointer;
  overviewPointer = null;
  const beat = overviewBeat(e.clientX);
  if (p.moved && !p.touch) {
    finalizeLoopSelection(overviewBeat(p.startX), beat);
    return;
  }
  const snapped = measureAtBeat(currentScore, beat)?.startBeat ?? beat;
  if (!p.moved) clearLoopRegion();
  seekToBeat(snapped, { recenterView: true });
});
overviewCanvas.addEventListener('pointercancel', () => {
  overviewPointer = null;
  pianoRoll?.setLoopRegion(loopRegion);
  overview?.setLoopRegion(loopRegion);
});

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const boundTexts = new Map<string, string>();
function setBound(bind: string, text: string) {
  // During playback this runs every animation frame; writing textContent unconditionally forces a
  // style/layout invalidation even when the string hasn't changed (most frames).
  if (boundTexts.get(bind) === text) return;
  boundTexts.set(bind, text);
  document.querySelectorAll(`[data-bind="${bind}"]`).forEach((el) => (el.textContent = text));
}

function updatePositionDisplay(beat: number) {
  if (!currentScore) return;
  if (audioEngine?.isCountingIn()) {
    setBound('pos-bar', t('countIn'));
    setBound('pos-beat', '');
    setBound('pos-beat-short', '');
    return;
  }
  const measure = measureAtBeat(currentScore, beat);
  if (!measure) return;
  const pulseBeats = 4 / measure.beatType;
  const beatInMeasure = Math.min(Math.floor((beat - measure.startBeat) / pulseBeats) + 1, measure.beats);
  setBound('pos-bar', t('bar', { n: measure.number }));
  setBound('pos-beat', t('beat', { b: beatInMeasure, n: measure.beats }));
  setBound('pos-beat-short', `· ${beatInMeasure}/${measure.beats}`);
}

/** Lights the dot next to each voice that is singing at the playhead. */
let litParts = '';
function updateVoiceLights(beat: number) {
  const lit: string[] = [];
  for (const [partId, notes] of notesByPart) {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].startBeat <= beat) lo = mid + 1;
      else hi = mid;
    }
    // Notes within a part rarely overlap; checking a few before the insertion point covers chords.
    for (let i = lo - 1; i >= Math.max(0, lo - 4); i--) {
      if (notes[i].startBeat + notes[i].durationBeats > beat) {
        lit.push(partId);
        break;
      }
    }
  }
  const key = lit.join('|');
  if (key === litParts) return;
  litParts = key;
  document.querySelectorAll<HTMLElement>('.light[data-part]').forEach((el) => el.classList.toggle('on', lit.includes(el.dataset.part!)));
}

/** Renders only whichever view is currently visible -- the hidden one costs nothing per frame. */
function renderActiveView(displayBeatValue: number, playheadBeatValue: number) {
  if (activeView === 'staff') staffView?.render(displayBeatValue, playheadBeatValue);
  else pianoRoll?.render(displayBeatValue, playheadBeatValue);
  overview?.render(playheadBeatValue);
  updateVoiceLights(playheadBeatValue);
}

function renderNow() {
  if (!pianoRoll || !audioEngine) return;
  const beat = displayBeat();
  renderActiveView(beat, engineBeat());
  updatePositionDisplay(beat);
}

// Scheduling top-up (audioEngine.tick()) and the loop/end-of-piece boundary check run on their
// own setInterval tick, separate from the purely-visual rAF loop below: browsers throttle rAF to
// near-zero (or stop it) once the tab/screen is backgrounded, which used to silence playback a few
// seconds after switching away. setInterval keeps firing (throttled to about once a second, well
// within LOOKAHEAD_REFILL_SEC's margin) while hidden.
const AUDIO_TICK_INTERVAL_MS = 200;
let audioTickIntervalId: number | null = null;

function audioTick() {
  if (!audioEngine || !currentScore) return;
  audioEngine.tick();
  const beat = audioEngine.getCurrentBeat();
  // A loop region, once marked, bounds playback; the Loop button decides whether hitting that
  // bound (or the end of the piece, when no region is marked) wraps around or stops there.
  const boundary = loopRegion ? loopRegion.end : currentScore.totalBeats;
  if (beat < boundary) return;

  if (loopEnabled) {
    audioEngine.play(loopRegion ? loopRegion.start : 0, bpm, transpose);
    return;
  }

  const resetBeat = loopRegion ? loopRegion.start : 0;
  audioEngine.stop();
  audioEngine.setPausedBeat(resetBeat);
  viewOffsetBeats = 0;
  syncPlayButtons(false);
  renderActiveView(resetBeat, resetBeat);
  updatePositionDisplay(resetBeat);
  stopRenderLoop();
}
function startAudioTick() {
  if (audioTickIntervalId == null) audioTickIntervalId = window.setInterval(audioTick, AUDIO_TICK_INTERVAL_MS);
}
function stopAudioTick() {
  if (audioTickIntervalId != null) {
    clearInterval(audioTickIntervalId);
    audioTickIntervalId = null;
  }
}

function renderLoop() {
  if (!audioEngine || !pianoRoll || !currentScore || !audioEngine.isPlaying()) {
    rafId = null; // stopped (e.g. by audioTick's own boundary check) since this frame was requested
    return;
  }
  const beat = audioEngine.getCurrentBeat();
  renderActiveView(beat + viewOffsetBeats, beat);
  updatePositionDisplay(beat + viewOffsetBeats);
  rafId = requestAnimationFrame(renderLoop);
}
function startRenderLoop() {
  startAudioTick();
  if (rafId == null) rafId = requestAnimationFrame(renderLoop);
}
function stopRenderLoop() {
  stopAudioTick();
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function resizeCanvases() {
  pianoRoll?.resize();
  staffView?.resize();
  overview?.resize();
  updateCanvasRect();
  renderNow();
}

window.addEventListener('resize', () => {
  resizeCanvases();
  drawAllCovers();
  drawMarks();
});

// Mobile browsers can change the canvas's laid-out size (address bar show/hide, dynamic toolbar,
// app-switcher return) without firing a window 'resize' event -- ResizeObserver watches the
// canvases' own boxes directly, so it catches every case.
const canvasResizeObserver = new ResizeObserver(resizeCanvases);
canvasResizeObserver.observe(canvas);
canvasResizeObserver.observe(staffCanvas);
canvasResizeObserver.observe(overviewCanvas);

function setActiveView(view: 'roll' | 'staff') {
  activeView = view;
  canvas.hidden = activeView !== 'roll';
  staffCanvas.hidden = activeView !== 'staff';
  document.querySelectorAll<HTMLButtonElement>('#view-seg [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  // The just-shown canvas may not have had a correct backing-store size while hidden (hidden
  // elements report a zero layout box), so resize before rendering into it.
  resizeCanvases();
}

staffCanvas.addEventListener(
  'wheel',
  (e) => {
    if (!staffView) return;
    e.preventDefault();
    if (e.ctrlKey) {
      applyZoom(Math.exp(-e.deltaY * 0.01));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      panByBeats((e.shiftKey ? e.deltaY : e.deltaX) / staffView.getPixelsPerBeat());
    } else if (e.deltaY !== 0) {
      staffView.scrollByPixels(e.deltaY);
      scheduleRender();
    }
  },
  { passive: false },
);

// Grid-lock click-to-seek in the staff view's own ruler strip, mirroring the piano roll's ruler
// tap. A plain click suffices there (no drag/loop-region support in this ruler, by design).
staffCanvas.addEventListener('click', (e) => {
  if (!staffView || !currentScore) return;
  const rect = staffCanvas.getBoundingClientRect();
  if (e.clientY - rect.top >= STAFF_RULER_HEIGHT_PX) return;
  const beat = staffView.xToBeat(e.clientX - rect.left, displayBeat());
  seekToBeat(measureAtBeat(currentScore, beat)?.startBeat ?? beat);
});

// Touch/pointer drag-to-scroll below the ruler strip (#staff sets touch-action:none, so this is the
// only way to scroll the stacked staves on a phone). Mirrors the piano roll's axis-locked drag.
let staffDragPointerId: number | null = null;
let staffDragStartX = 0;
let staffDragStartY = 0;
let staffDragLastX = 0;
let staffDragLastY = 0;
let staffDragAxis: 'x' | 'y' | null = null;

const staffPinch = new PinchZoomTracker();

staffCanvas.addEventListener('pointerdown', (e) => {
  if (!staffView) return;
  staffPinch.onPointerDown(e);
  if (staffPinch.activeCount >= 2) {
    staffDragPointerId = null;
    return;
  }
  const rect = staffCanvas.getBoundingClientRect();
  if (e.clientY - rect.top < STAFF_RULER_HEIGHT_PX) return; // ruler strip stays tap-to-seek only
  staffDragPointerId = e.pointerId;
  staffDragStartX = e.clientX;
  staffDragStartY = e.clientY;
  staffDragLastX = e.clientX;
  staffDragLastY = e.clientY;
  staffDragAxis = null;
  staffCanvas.setPointerCapture(e.pointerId);
});
staffCanvas.addEventListener('pointermove', (e) => {
  const pinchRatio = staffPinch.onPointerMove(e);
  if (pinchRatio != null) {
    applyZoom(pinchRatio);
    return;
  }
  if (staffDragPointerId !== e.pointerId || !staffView) return;
  const totalDx = e.clientX - staffDragStartX;
  const totalDy = e.clientY - staffDragStartY;
  if (staffDragAxis === null && Math.hypot(totalDx, totalDy) > CLICK_DRAG_THRESHOLD_PX) {
    staffDragAxis = Math.abs(totalDx) > Math.abs(totalDy) ? 'x' : 'y';
  }
  const dx = e.clientX - staffDragLastX;
  const dy = e.clientY - staffDragLastY;
  if (staffDragAxis !== 'y') panByBeats(-dx / staffView.getPixelsPerBeat());
  if (staffDragAxis !== 'x') {
    staffView.scrollByPixels(-dy);
    scheduleRender();
  }
  staffDragLastX = e.clientX;
  staffDragLastY = e.clientY;
});
function endStaffDrag(e: PointerEvent) {
  staffPinch.onPointerUp(e);
  if (staffDragPointerId !== e.pointerId) return;
  staffDragPointerId = null;
  staffDragAxis = null;
}
staffCanvas.addEventListener('pointerup', endStaffDrag);
staffCanvas.addEventListener('pointercancel', endStaffDrag);

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

/**
 * Invoked once the app's mode (Solo vs. Ensemble, or "no backend at all") is resolved -- either
 * immediately at startup (a stored choice, or no backend to choose on) or from the title screen's
 * buttons. Sets up the shared song library (available in both modes) and, only in Ensemble mode,
 * the shared playback session.
 */
async function runBootstrap() {
  if (!isFirebaseConfigured) {
    importBtn.hidden = true;
    renderSongList();
    return;
  }

  try {
    // Sign in first: verifyPin (inside ensureAccess) reads Firestore, and the security rules
    // require request.auth != null, so an unsigned-in read would just hang/get rejected.
    await ensureSignedIn();
    await ensureAccess(); // PIN gate; resolves immediately if already granted on this device
    subscribeToSongs(
      (songs) => {
        libraryState = 'ready';
        importedSongs = songs.map((s) => ({
          id: s.id,
          title: s.title,
          xml: s.xml,
          format: s.format,
          imported: true,
          partNameOverrides: s.partNameOverrides,
          savedConfig: s.savedConfig,
          clefOverrides: s.clefOverrides,
          removedParts: s.removedParts,
        }));
        renderSongList();
        // Clef changes and removed voices from another device apply to the open song too (once
        // it's paused -- reloading mid-playback would cut the music off).
        const fresh = currentSong && importedSongs.find((s) => s.id === currentSong!.id);
        if (fresh && currentSong && voiceSetupKey(fresh) !== voiceSetupKey(currentSong) && !audioEngine?.isPlaying()) void reloadCurrentSong();
        // A remote songId can arrive before this device's own library listener has caught up
        // with it (e.g. it was just imported elsewhere) -- re-apply the last state we got once
        // the library list might actually contain it.
        if (pendingSongId && lastReceivedPlaybackState && allSongs().some((s) => s.id === pendingSongId)) {
          void applyPlaybackState(lastReceivedPlaybackState);
        }
      },
      (err) => {
        libraryState = 'offline';
        libraryError = errorText(err);
        renderSongList();
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
        (err) => toast(t('syncFailed', { msg: errorText(err) }), 'error'),
      );
    }
  } catch (err) {
    libraryState = 'offline';
    libraryError = errorText(err);
    renderSongList();
  }
}

// Mode resolution: with a shared backend, every start opens on the title screen and the Solo /
// Ensemble choice comes after it (the last choice is marked). The one exception is the reload right
// after switching modes from inside the app, which goes straight on in the new mode.
const storedMode = localStorage.getItem(MODE_STORAGE_KEY);
const switchedMode = sessionStorage.getItem(MODE_SWITCH_KEY);
sessionStorage.removeItem(MODE_SWITCH_KEY);
if (storedMode === 'solo' || storedMode === 'ensemble') sessionMode = storedMode;
if (isFirebaseConfigured && (switchedMode === 'solo' || switchedMode === 'ensemble')) {
  chooseMode(switchedMode);
} else if (isFirebaseConfigured) {
  document.querySelector(storedMode === 'ensemble' ? '#mode-ensemble-btn' : '#mode-solo-btn')?.classList.toggle('last-used', storedMode === 'solo' || storedMode === 'ensemble');
  setViewMode('landing');
} else {
  setViewMode('library');
  void runBootstrap();
}
renderModeControls();
renderSongList();
refreshBindings();
requestAnimationFrame(drawMarks);
