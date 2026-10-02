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
 * Behind a flag while it's a draft: ?intro=an shows it on this device (and starts it afresh each
 * time the address asks for it), ?intro=aus hides it again.
 */
export const INTRO_ON = deviceChoice('intro', 'ai-capella-intro', ['an', 'aus'] as const, 'aus') === 'an';

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
}

const TOURS: Record<TourId, Step[]> = {
  library: [
    {
      at: ['.ens-switch'],
      title: { de: 'Euer Repertoire', en: 'Your repertoire' },
      text: {
        de: 'Hier liegen die Stücke deines Ensembles. Bist du in mehreren, wechselst du hier – oder öffnest mit einem Code ein weiteres.',
        en: "Your ensemble's pieces live here. Belong to more than one? Switch here – or open another with its code.",
      },
    },
    {
      at: ['#song-grid .song-card:not(.skeleton)'],
      title: { de: 'Ein Stück öffnen', en: 'Open a piece' },
      text: { de: 'Tippe ein Stück an, um es zu öffnen – zum Hören, Mitlesen und Üben.', en: 'Tap a piece to open it – to listen, read along and practise.' },
    },
    {
      at: ['#import-btn'],
      title: { de: 'Neue Stücke', en: 'New pieces' },
      text: {
        de: 'Füge MusicXML-, MXL- oder MIDI-Dateien hinzu – am Laptop auch einfach ins Fenster ziehen. Sie stehen dann allen im Ensemble zur Verfügung.',
        en: 'Add MusicXML, MXL or MIDI files – on a laptop, just drop them onto the window. Everyone in the ensemble gets them.',
      },
    },
    {
      at: ['#mode-seg'],
      title: { de: 'Allein oder gemeinsam', en: 'Alone or together' },
      text: {
        de: 'Allein übst du für dich. Gemeinsam seid ihr in einer Probe verbunden: Wer leitet, startet und stoppt die Musik auf allen Geräten.',
        en: 'Alone, you practise on your own. Together, you are joined in one rehearsal: whoever leads starts and stops the music on every device.',
      },
    },
    {
      at: ['#lib-menu-btn'],
      title: { de: 'Menü', en: 'Menu' },
      text: { de: 'Hier wählst du die Sprache – und findest diese Einführung jederzeit wieder.', en: 'Choose the language here – and find this introduction again any time.' },
    },
  ],
  player: [
    {
      at: ['#stage'],
      title: { de: 'Die Musik als Licht', en: 'The music as light' },
      text: {
        de: 'Jede Stimme hat ihre Farbe, der Text steht darunter. Was gerade erklingt, leuchtet an der Leselinie auf. Ziehen verschiebt die Ansicht, ein Klick in die Taktleiste oben setzt den Startpunkt – dort ziehen markiert eine Wiederholung.',
        en: 'Each voice has its colour, with the lyrics beneath. What sounds right now lights up at the reading line. Drag to move the view; click the bar ruler at the top to set the start – drag there to mark a loop.',
      },
      phone: {
        de: 'Jede Stimme hat ihre Farbe, der Text steht darunter. Was gerade erklingt, leuchtet an der Leselinie auf. Wischen verschiebt die Ansicht, zwei Finger zoomen. Tippe in die Taktleiste oben, um dort zu starten.',
        en: 'Each voice has its colour, with the lyrics beneath. What sounds right now lights up at the reading line. Swipe to move the view, pinch to zoom. Tap the bar ruler at the top to start there.',
      },
    },
    {
      at: ['.play-btn'],
      title: { de: 'Abspielen', en: 'Play' },
      text: {
        de: 'Start und Pause – auch mit der Leertaste. Die Pfeile daneben springen taktweise (gedrückt halten geht schneller), ■ führt zurück zum Startpunkt.',
        en: 'Play and pause – the space bar does it too. The arrows beside it step bar by bar (hold for faster); ■ goes back to the start point.',
      },
      phone: {
        de: 'Start und Pause. Die Pfeile daneben springen taktweise (gedrückt halten geht schneller), ■ führt zurück zum Startpunkt.',
        en: 'Play and pause. The arrows beside it step bar by bar (hold for faster); ■ goes back to the start point.',
      },
    },
    {
      at: ['#view-seg'],
      title: { de: 'Klavierrolle oder Noten', en: 'Piano roll or sheet music' },
      text: {
        de: 'Die Klavierrolle zeigt Tonhöhe und Länge als Lichtbalken, die Notenansicht das gewohnte Notenbild. Beide leuchten mit.',
        en: 'The piano roll shows pitch and length as bars of light, the sheet view the usual notation. Both light up as the music plays.',
      },
    },
    {
      at: ['.voices-panel', '#voice-chips'],
      title: { de: 'Stimmen', en: 'Voices' },
      text: {
        de: 'Ein Klick auf den Namen spielt nur diese Stimme (nochmal: alle). M schaltet stumm, S hebt eine Stimme hervor – die anderen werden leiser; wie leise, stellst du unten ein.',
        en: 'Click a name to hear only that voice (again: all). M mutes, S brings a voice forward – the others get quieter; how quiet, you set below.',
      },
      phone: {
        de: 'Tippe eine Stimme an, um nur sie zu hören (nochmal: alle). Gedrückt halten – oder der Regler rechts – öffnet das Mischpult mit Stumm und Solo.',
        en: 'Tap a voice to hear only it (again: all). Hold it – or the sliders on the right – for the mixer with mute and solo.',
      },
    },
    {
      at: ['#overview-wrap'],
      title: { de: 'Das ganze Stück', en: 'The whole piece' },
      text: {
        de: 'Hier liegt das ganze Stück im Überblick. Klicken springt an eine Stelle, Ziehen markiert einen Teil zum Wiederholen. Die Buchstaben sind die Abschnitte.',
        en: 'The whole piece at a glance. Click to jump there; drag to mark a part to loop. The letters are its sections.',
      },
      phone: {
        de: 'Hier liegt das ganze Stück im Überblick. Tippen springt an eine Stelle, Ziehen markiert einen Teil zum Wiederholen.',
        en: 'The whole piece at a glance. Tap to jump there; drag to mark a part to loop.',
      },
    },
    {
      // Laptop: the three practice switches; phone: the line that opens tempo, key and the rest.
      at: ['.t-center .toggle'],
      atPhone: ['.info-row'],
      title: { de: 'Üben', en: 'Practice' },
      text: {
        de: 'Wiederholen (L) spielt den markierten Teil in Schleife, das Metronom (M) zählt mit, und die Stimmgabel singt vor jedem Start die Anfangstöne aller Stimmen.',
        en: 'Loop (L) repeats the marked part, the metronome (M) counts along, and the tuning fork sings every voice’s first note before each start.',
      },
      phone: {
        de: 'Tippe hier für Tempo, Tonart, Sprung zu einem Takt, Abschnitte, Metronom und Anfangstöne. Wiederholen findest du unten rechts.',
        en: 'Tap here for tempo, key, going to a bar, sections, metronome and starting notes. Loop is at the bottom right.',
      },
    },
    {
      at: ['.t-right'],
      title: { de: 'Tempo und Tonart', en: 'Tempo and key' },
      text: {
        de: 'Langsamer üben oder die Tonart verschieben, bis sie zu euren Stimmen passt. Ein Klick auf das Tempo öffnet Eingabe, Takt-Sprung und Abschnitte.',
        en: 'Practise slower, or move the key until it suits your voices. Click the tempo for typing it, going to a bar and sections.',
      },
    },
    {
      at: ['#mode-badge'],
      title: { de: 'Allein oder gemeinsam', en: 'Alone or together' },
      text: {
        de: 'Zeigt, ob du allein übst oder in der gemeinsamen Probe bist. In der Probe übernimmst du hier die Leitung – dann folgen alle Geräte deinem Abspielen.',
        en: 'Shows whether you practise alone or are in the shared rehearsal. In a rehearsal, take the lead here – every device then follows your playing.',
      },
    },
    {
      at: ['#player-menu-btn'],
      title: { de: 'Noch mehr', en: 'More' },
      text: {
        de: 'Klang (Flügel oder Stimme), Swing, Licht und Ton abgleichen, Sprache – und diese Einführung zum Nachlesen.',
        en: 'Sound (piano or voice), swing, matching light and sound, language – and this introduction to read again.',
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
      title.textContent = say(step.title);
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
