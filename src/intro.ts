// The introduction: a short tour for someone opening the app for the first time. A spotlight
// travels from one control to the next -- the light of the reading line, wandering over the page --
// with a small card saying what each one does. One tour for the repertoire, one for the player,
// each shown once (the first time that screen opens), skippable (it comes again next visit) or
// switched off for good, and always to be seen again from the ⋯ menu.
//
// Steps name their controls by selector; a step whose control isn't on screen (the voices panel on
// a phone, the mode switch in the public folder) is left out, so one tour fits every screen.

import { deviceChoice } from './design';
import { lang, t } from './i18n';

/**
 * On for everyone; ?intro=aus switches it off on a device (no tours, no menu entry), ?intro=an
 * back on -- and starts the tours afresh, each time the address asks for it.
 */
export const INTRO_ON = deviceChoice('intro', 'ai-capella-intro', ['an', 'aus'] as const, 'an') === 'an';

export type TourId = 'library' | 'player';

const OFF_KEY = 'ai-capella-intro-off';
const doneKey = (id: TourId) => `ai-capella-intro-${id}-done`;
const LATER_KEY = 'ai-capella-intro-later'; // sessionStorage: skipped for this visit

function get(storage: () => Storage, key: string): boolean {
  try {
    return storage().getItem(key) === '1';
  } catch {
    return false;
  }
}
function set(storage: () => Storage, key: string) {
  try {
    storage().setItem(key, '1');
  } catch {
    /* not remembered: it may come again */
  }
}

// The tours are for people new to the app: a device that was already using it when they came
// (it chose alone or together, or opened an ensemble) has them only in the menu. Decided once, on
// the first start with the tours, and remembered.
const CHECKED_KEY = 'ai-capella-intro-checked';
try {
  if (!localStorage.getItem(CHECKED_KEY)) {
    localStorage.setItem(CHECKED_KEY, '1');
    if (localStorage.getItem('ai-capella-mode-v2') || localStorage.getItem('ai-capella-ensembles-unlocked')) {
      for (const id of ['library', 'player'] as const) localStorage.setItem(doneKey(id), '1');
    }
  }
} catch {
  /* storage unavailable: shown, as for someone new */
}

// Opening the app with ?intro=an starts the tours afresh.
if (INTRO_ON && new URLSearchParams(location.search).get('intro') === 'an') {
  try {
    for (const key of [OFF_KEY, doneKey('library'), doneKey('player')]) localStorage.removeItem(key);
    sessionStorage.removeItem(LATER_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Whether a tour should start on its own: the flag is on, and it wasn't seen, skipped or switched off. */
export function introDue(id: TourId): boolean {
  return INTRO_ON && !get(() => localStorage, OFF_KEY) && !get(() => localStorage, doneKey(id)) && !get(() => sessionStorage, LATER_KEY);
}

export function introRunning(): boolean {
  return !!document.querySelector('.intro');
}

// ---- The steps ----------------------------------------------------------------------------------

type Text = { de: string; en: string };
interface Step {
  /** The control to light: the first selector with something on screen; all its matches together. */
  at: string[];
  /** On a phone (narrow screen), when the control is another one there. */
  atPhone?: string[];
  title: Text;
  text: Text;
  /** On a phone (narrow screen), when it says something else there. */
  phone?: Text;
  phoneTitle?: Text;
}

// Written as a coach would say it: one thing per step, what you can do and what it brings you,
// beginning with the doing ("Tippe", "Zieh"), in a sentence or two. Shortcuts and the finer points
// stay in the controls' own tooltips.
const TOURS: Record<TourId, Step[]> = {
  library: [
    {
      at: ['.ens-switch'],
      title: { de: 'Dein Ensemble', en: 'Your ensemble' },
      text: {
        de: 'Hier sind die Stücke deines Chors. Mit einem Code öffnest du ein weiteres Ensemble.',
        en: "Here are your choir's pieces. Open another ensemble with its code.",
      },
    },
    {
      at: ['#song-grid .song-card:not(.skeleton)'],
      title: { de: 'Stück öffnen', en: 'Open a piece' },
      text: { de: 'Klick ein Stück an, um zu üben.', en: 'Click a piece to start practising.' },
      phone: { de: 'Tippe ein Stück an, um zu üben.', en: 'Tap a piece to start practising.' },
    },
    {
      at: ['#import-btn'],
      title: { de: 'Stück hinzufügen', en: 'Add a piece' },
      text: {
        de: 'Lade MusicXML oder MIDI hoch – dein ganzes Ensemble hat es sofort.',
        en: 'Upload MusicXML or MIDI – your whole ensemble gets it at once.',
      },
    },
    {
      at: ['#mode-seg'],
      title: { de: 'Gemeinsam proben', en: 'Rehearse together' },
      text: {
        de: 'Wähle »Gemeinsam«: Wer leitet, startet die Musik auf allen Geräten.',
        en: 'Choose “Together”: whoever leads starts the music on every device.',
      },
    },
  ],
  player: [
    {
      at: ['#stage'],
      title: { de: 'Die Musik leuchtet', en: 'The music lights up' },
      text: {
        de: 'Jede Stimme hat ihre Farbe, was gerade klingt, leuchtet auf. Klick oben in die Taktleiste, um dort zu starten.',
        en: 'Each voice has its colour; what sounds now lights up. Click the bar ruler at the top to start there.',
      },
      phone: {
        de: 'Jede Stimme hat ihre Farbe, was gerade klingt, leuchtet auf. Tippe oben in die Taktleiste, um dort zu starten.',
        en: 'Each voice has its colour; what sounds now lights up. Tap the bar ruler at the top to start there.',
      },
    },
    {
      at: ['.play-btn'],
      title: { de: 'Abspielen', en: 'Play' },
      text: { de: 'Starte und pausiere hier – oder mit der Leertaste.', en: 'Start and pause here – or with the space bar.' },
      phone: { de: 'Starte und pausiere hier. Die Pfeile springen einen Takt weiter.', en: 'Start and pause here. The arrows move a bar at a time.' },
    },
    {
      at: ['#view-seg'],
      title: { de: 'Noten oder Klavierrolle', en: 'Sheet music or piano roll' },
      text: {
        de: 'Wechsle zwischen Notenbild und Klavierrolle.',
        en: 'Switch between sheet music and piano roll.',
      },
    },
    {
      at: ['.voices-panel', '#voice-chips'],
      title: { de: 'Deine Stimme hören', en: 'Hear your voice' },
      text: {
        de: 'Klick auf deine Stimme, um nur sie zu hören. Mit S bleiben die anderen leise dabei.',
        en: 'Click your voice to hear only it. With S, the others stay in, quietly.',
      },
      phone: {
        de: 'Tippe deine Stimme an, um nur sie zu hören. Halte sie gedrückt für mehr.',
        en: 'Tap your voice to hear only it. Hold it for more.',
      },
    },
    {
      at: ['#overview-wrap'],
      title: { de: 'Das ganze Stück', en: 'The whole piece' },
      text: {
        de: 'Hier siehst du das ganze Stück. Klick auf eine Stelle oder einen Abschnitt (A, B, C …), um dorthin zu springen.',
        en: 'Here is the whole piece. Click a spot or a section (A, B, C …) to jump there.',
      },
      phone: {
        de: 'Hier siehst du das ganze Stück. Tippe auf eine Stelle oder einen Abschnitt (A, B, C …), um dorthin zu springen.',
        en: 'Here is the whole piece. Tap a spot or a section (A, B, C …) to jump there.',
      },
    },
    {
      // Laptop: the practice switches; phone: the line that opens tempo, key and the rest.
      at: ['.t-center .t-metro'],
      atPhone: ['.info-row'],
      title: { de: 'Mitzählen und Anfangstöne', en: 'Count-in and starting notes' },
      phoneTitle: { de: 'Tempo und Tonart', en: 'Tempo and key' },
      text: {
        de: 'Das Metronom zählt mit, die Stimmgabel singt vor jedem Start eure Anfangstöne.',
        en: 'The metronome counts along; the tuning fork sings your starting notes before each start.',
      },
      phone: {
        de: 'Tippe hier, um langsamer zu üben, die Tonart anzupassen oder mitzählen zu lassen.',
        en: 'Tap here to practise slower, change the key or turn on the metronome.',
      },
    },
    {
      at: ['.t-right'],
      title: { de: 'Tempo und Tonart', en: 'Tempo and key' },
      text: {
        de: 'Übe langsamer oder verschiebe die Tonart, bis sie zu euch passt.',
        en: 'Practise slower, or move the key until it suits you.',
      },
    },
    {
      at: ['#mode-badge'],
      title: { de: 'Probe leiten', en: 'Lead the rehearsal' },
      text: {
        de: 'In der gemeinsamen Probe übernimmst du hier die Leitung – alle Geräte folgen dann dir.',
        en: 'In a shared rehearsal, take the lead here – every device then follows you.',
      },
    },
    {
      at: ['#player-menu-btn'],
      title: { de: 'Noch mehr', en: 'More' },
      text: {
        de: 'Klang, Swing und Sprache – und diese Einführung, falls du sie nochmal brauchst.',
        en: 'Sound, swing and language – and this introduction, should you need it again.',
      },
    },
  ],
};

// ---- The tour ---------------------------------------------------------------------------------

const PAD = 8; // the spotlight's margin around its control
const GAP = 14; // between the spotlight and the card
const EDGE = 10; // the card's least distance from the screen's edge

const narrow = () => window.matchMedia('(max-width: 899px)').matches;
const say = (text: Text) => text[lang];

function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** The step's control on screen now: the first selector that matches something visible, all its matches. */
function targetsOf(step: Step): HTMLElement[] {
  for (const sel of (narrow() && step.atPhone) || step.at) {
    const els = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(onScreen);
    if (els.length) return sel.startsWith('#song-grid') ? els.slice(0, 1) : els;
  }
  return [];
}

function unionRect(els: HTMLElement[]) {
  const rects = els.map((e) => e.getBoundingClientRect());
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(Math.min(...rects.map((r) => r.left)) - PAD, 4);
  const top = Math.max(Math.min(...rects.map((r) => r.top)) - PAD, 4);
  const right = Math.min(Math.max(...rects.map((r) => r.right)) + PAD, vw - 4);
  const bottom = Math.min(Math.max(...rects.map((r) => r.bottom)) + PAD, vh - 4);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

let stopCurrent: (() => void) | null = null;

/**
 * Runs a tour. `force`: asked for from the menu (shown even if seen). Returns when it closes. The
 * page underneath isn't usable meanwhile; the keyboard steps through it (→ / Enter, ←, Esc).
 */
export function startIntro(id: TourId, onClose?: () => void) {
  stopCurrent?.();
  const steps = TOURS[id].filter((s) => targetsOf(s).length);
  if (!steps.length) return;
  let index = 0;

  const root = document.createElement('div');
  root.className = 'intro';
  // Catches every click outside the card; the spotlight lies over it, only to be seen.
  const block = document.createElement('div');
  block.className = 'intro-block';
  const spot = document.createElement('div');
  spot.className = 'intro-spot';
  spot.setAttribute('aria-hidden', 'true');
  const card = document.createElement('div');
  card.className = 'intro-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'intro-title');
  const count = document.createElement('span');
  count.className = 'intro-count';
  const title = document.createElement('h2');
  title.id = 'intro-title';
  const text = document.createElement('p');
  const dots = document.createElement('div');
  dots.className = 'intro-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.append(...steps.map(() => document.createElement('i')));
  const actions = document.createElement('div');
  actions.className = 'intro-actions';
  const asides = document.createElement('div');
  asides.className = 'intro-asides';
  const button = (label: string, cls: string, action: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', action);
    return b;
  };
  const skip = button(t('introSkip'), 'link-btn', () => close('later'));
  const never = button(t('introNever'), 'link-btn', () => close('never'));
  asides.append(skip, never);
  const back = button(t('introBack'), 'btn', () => go(index - 1));
  const next = button(t('introNext'), 'btn primary', () => (index === steps.length - 1 ? close('done') : go(index + 1)));
  const moves = document.createElement('div');
  moves.className = 'intro-moves';
  moves.append(back, next);
  actions.append(asides, moves);
  const head = document.createElement('div');
  head.className = 'intro-head';
  head.append(count, dots);
  card.append(head, title, text, actions);
  root.append(block, spot, card);
  document.body.appendChild(root);

  const spotRect = () => {
    const els = targetsOf(steps[index]);
    return els.length ? unionRect(els) : null;
  };
  const placeSpot = () => {
    const r = spotRect();
    if (!r) return;
    spot.style.transform = `translate(${r.left}px, ${r.top}px)`;
    spot.style.width = `${r.width}px`;
    spot.style.height = `${r.height}px`;
  };
  const place = () => {
    const r = spotRect();
    if (!r) return;
    placeSpot();
    // The card beside the light: below, above, right or left of it, wherever it fits -- or, for a
    // control filling most of the screen (the music itself), inside it, at the bottom.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - cw - EDGE);
    const clampY = (y: number) => Math.min(Math.max(y, EDGE), vh - ch - EDGE);
    const midX = clampX(r.left + r.width / 2 - cw / 2);
    const midY = clampY(r.top + r.height / 2 - ch / 2);
    let x: number;
    let y: number;
    if (r.bottom + GAP + ch <= vh - EDGE) [x, y] = [midX, r.bottom + GAP];
    else if (r.top - GAP - ch >= EDGE) [x, y] = [midX, r.top - GAP - ch];
    else if (r.right + GAP + cw <= vw - EDGE) [x, y] = [r.right + GAP, midY];
    else if (r.left - GAP - cw >= EDGE) [x, y] = [r.left - GAP - cw, midY];
    else [x, y] = [midX, clampY(r.bottom - ch - 2 * GAP)];
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  let swap = 0;
  const go = (to: number) => {
    if (to < 0 || to >= steps.length) return;
    index = to;
    const step = steps[index];
    targetsOf(step)[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    Array.from(dots.children).forEach((d, i) => d.classList.toggle('on', i === index));
    back.hidden = index === 0;
    next.textContent = index === steps.length - 1 ? t('introDone') : t('introNext');
    next.focus({ preventScroll: true });
    // The light moves on at once; the card fades, takes the new text, and comes back at its new place.
    const fill = () => {
      count.textContent = `${index + 1} / ${steps.length}`;
      title.textContent = say(narrow() && step.phoneTitle ? step.phoneTitle : step.title);
      text.textContent = say(narrow() && step.phone ? step.phone : step.text);
      place();
      card.classList.add('shown');
    };
    window.clearTimeout(swap);
    placeSpot();
    if (card.classList.contains('shown')) {
      card.classList.remove('shown');
      swap = window.setTimeout(fill, 170);
    } else fill();
  };

  // Steps through with the keyboard -- and keeps the player's own keys (space, arrows, L, M) from
  // acting meanwhile.
  const onKey = (e: KeyboardEvent) => {
    e.stopImmediatePropagation();
    const onButton = document.activeElement instanceof HTMLButtonElement && card.contains(document.activeElement);
    if (e.key === 'Escape') close('later');
    else if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && onButton) return; // the button's own click
    else if (e.key === 'Enter') next.click();
    else if (e.key === 'Tab') {
      // Tab stays within the card.
      const focusable = Array.from(card.querySelectorAll<HTMLButtonElement>('button:not([hidden])'));
      const at = focusable.indexOf(document.activeElement as HTMLButtonElement);
      focusable[(at + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
    } else if (e.key !== ' ') return;
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => e.stopImmediatePropagation();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  const onResize = () => place();
  window.addEventListener('resize', onResize);
  // Controls can move under the light (a list filling in, a panel opening): follow them.
  const follow = window.setInterval(place, 500);

  let closed = false;
  function close(how: 'done' | 'later' | 'never') {
    if (closed) return;
    closed = true;
    if (how === 'never') set(() => localStorage, OFF_KEY);
    else if (how === 'done') set(() => localStorage, doneKey(id));
    else set(() => sessionStorage, LATER_KEY);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('resize', onResize);
    window.clearInterval(follow);
    stopCurrent = null;
    root.classList.remove('open');
    window.setTimeout(() => root.remove(), 350);
    onClose?.();
  }
  stopCurrent = () => close('later');
  placeSpot(); // where the light first appears, before it is drawn (so it doesn't fly in from a corner)

  // In: the dark comes up first, then the light finds the first control.
  requestAnimationFrame(() => {
    root.classList.add('open');
    go(0);
  });
}

/** Closes a running tour without marking it seen (the screen it belongs to is going away). */
export function stopIntro() {
  stopCurrent?.();
}
