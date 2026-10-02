// A hint when the device shows the music at only 30 frames per second.
//
// Energy savers -- an iPhone's Low Power Mode, a browser's energy saver on battery -- cap pages at
// 30 frames a second. The roll and the sheet then move in half (or a quarter of) the steps, and
// moving lyrics smear: hard to read, though nothing is wrong with the app. A page can't ask whether
// such a mode is on, but it can see its effect: frames arriving steadily 33 ms apart while drawing
// one takes only a millisecond or two (so it isn't the app being slow). After a few seconds of
// that while playing, a small note says what is likely behind it -- once per visit, and never again
// once the singer asks so.

import { t } from './i18n';

const OFF_KEY = 'ai-capella-power-hint-off';
const SHOWN_KEY = 'ai-capella-power-hint-shown';
const WINDOW_MS = 1500; // judged over this much playing...
const CHECK_EVERY_MS = 1000; // ...once a second...
const CHECKS_NEEDED = 3; // ...and shown after this many capped checks in a row
const BREAK_MS = 250; // a gap this long is a pause, not a slow frame: start counting again

function stored(storage: () => Storage, key: string): boolean {
  try {
    return storage().getItem(key) === '1';
  } catch {
    return false;
  }
}
function store(storage: () => Storage, key: string) {
  try {
    storage().setItem(key, '1');
  } catch {
    /* not remembered */
  }
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Shows the hint (exported for trying it out from the console). */
export function showPowerHint() {
  if (document.querySelector('.power-hint')) return;
  const el = document.createElement('div');
  el.className = 'power-hint';
  el.setAttribute('role', 'status');
  const title = document.createElement('b');
  title.textContent = t('powerHintTitle');
  const body = document.createElement('p');
  body.textContent = t(isIos() ? 'powerHintIos' : 'powerHintOther');
  const actions = document.createElement('div');
  actions.className = 'power-hint-actions';
  const close = () => {
    el.classList.remove('show');
    window.setTimeout(() => el.remove(), 400);
  };
  const never = document.createElement('button');
  never.type = 'button';
  never.className = 'link-btn';
  never.textContent = t('powerHintNever');
  never.addEventListener('click', () => {
    store(() => localStorage, OFF_KEY);
    close();
  });
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn';
  ok.textContent = t('powerHintOk');
  ok.addEventListener('click', close);
  actions.append(never, ok);
  el.append(title, body, actions);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
}

/** Watches the playing frames (their timestamps and how long drawing each took); see above. */
export function createPowerHint(): (frameMs: number, drawMs: number) => void {
  const stamps: number[] = [];
  const draws: number[] = [];
  let lastCheck = 0;
  let capped = 0;
  let done = stored(() => localStorage, OFF_KEY) || stored(() => sessionStorage, SHOWN_KEY);
  return (frameMs, drawMs) => {
    if (done) return;
    if (stamps.length && frameMs - stamps[stamps.length - 1] > BREAK_MS) {
      stamps.length = 0;
      draws.length = 0;
      capped = 0;
    }
    stamps.push(frameMs);
    draws.push(drawMs);
    while (stamps.length && stamps[0] < frameMs - WINDOW_MS) {
      stamps.shift();
      draws.shift();
    }
    if (frameMs - lastCheck < CHECK_EVERY_MS || frameMs - stamps[0] < WINDOW_MS * 0.9) return;
    lastCheck = frameMs;
    const gaps = stamps.slice(1).map((s, i) => s - stamps[i]).sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    const low = gaps[Math.floor(gaps.length * 0.25)];
    const drawing = draws.reduce((a, b) => a + b, 0) / draws.length;
    // Steadily ~33 ms apart (not just now and then), the drawing quick, and the page on screen.
    const isCapped = median > 28 && median < 40 && low > 26 && drawing < 8 && document.visibilityState === 'visible';
    capped = isCapped ? capped + 1 : 0;
    if (capped < CHECKS_NEEDED) return;
    done = true;
    store(() => sessionStorage, SHOWN_KEY);
    showPowerHint();
  };
}
