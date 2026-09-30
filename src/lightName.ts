// The title screen's name, LightScore: "Light" moves, "Score" holds. "Light" is written with light
// by a pen, stroke by stroke as a hand writes it (lightStrokes.ts): the L, the i running into the
// g, the g's loop, the dot, the h running into the t, the t's bar -- at a writing hand's pace,
// slower through the curves, easing in and out of every stroke, with a short lift between them. A
// bright point marks the nib; what it has written glows like the voice lines behind it. Then
// "Score" follows in ink, solid, written in from left to right (style.css), and the name floats.

import { FONT_SCRIPT, loadScriptFont } from './goldInk';
import { renderInk } from './inkWordmark';
import { LIGHT_STROKES } from './lightStrokes';
import { FONT_DISPLAY } from './theme';

const LIGHT_SCALE = 1.62; // the pen script is small for its size: its "Light" stands as tall as "Score" at this
const GAP = 0.1; // between the two words, in em of Score
const PEN_SPEED = 4.3; // em of "Light" per second on a straight line (about a writing hand's pace)
const CURVE_SLOWDOWN = 0.62; // how much slower the pen moves through the tightest curves
const EASE_EM = 0.07; // stroke start and end: the pen gathers and loses speed over this distance
const LIFT_SEC = 0.12; // the pen lifted between two strokes (plus its way over to the next)
const DOT_SEC = 0.1; // setting down the i's dot
const FINISH_SEC = 0.35; // the nib's light fading once the word is written

const smoothstep = (v: number) => {
  const t = Math.min(1, Math.max(0, v));
  return t * t * (3 - 2 * t);
};

interface LightArt {
  core: HTMLCanvasElement; // the letters alone, device px
  full: HTMLCanvasElement; // the letters in their glow, device px
  dpr: number;
  pad: number; // css px of glow room around the letters
  width: number; // the word's advance, css px
  baseline: number; // in the images, css px from their top
  size: number; // font size, css px
}

/** One point of the pen's way: where (css px in the images), how wide the stroke is there, and when. */
interface PenPoint {
  x: number;
  y: number;
  r: number;
  t: number;
  dot?: boolean;
}

function renderLight(size: number, dpr: number): LightArt {
  const font = `400 ${size}px ${FONT_SCRIPT}`;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const width = probe.measureText('Light').width;
  const pad = Math.round(size * 0.35);
  const cssW = Math.ceil(width + pad * 2);
  const cssH = Math.ceil(size * 1.25 + pad * 2);
  const baseline = pad + size * 0.82;
  const canvas = () => {
    const c = document.createElement('canvas');
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.font = font;
    return [c, g] as const;
  };
  const [core, c] = canvas();
  c.fillStyle = 'rgb(255,252,244)';
  c.fillText('Light', pad, baseline);
  const [full, f] = canvas();
  glow(f, core, dpr, size);
  return { core, full, dpr, pad, width, baseline, size };
}

/** Draws `letters` (device px) onto `ctx` in their glow: warm light around a white-hot stroke. */
function glow(ctx: CanvasRenderingContext2D, letters: HTMLCanvasElement, dpr: number, size: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const [blur, a] of [
    [size * 0.45, 0.22],
    [size * 0.18, 0.3],
    [size * 0.06, 0.45],
  ]) {
    ctx.shadowColor = `rgba(255,190,112,${a})`;
    ctx.shadowBlur = blur * dpr;
    ctx.drawImage(letters, 0, 0);
  }
  ctx.shadowBlur = 0;
  ctx.drawImage(letters, 0, 0);
  ctx.restore();
}

/** The pen's way through the word, timed like a hand writing it. */
function penPath(art: LightArt): PenPoint[] {
  const k = art.size / 1000;
  const out: PenPoint[] = [];
  let t = 0;
  let last: PenPoint | null = null;
  for (const stroke of LIGHT_STROKES) {
    const pts: PenPoint[] = [];
    for (let i = 0; i < stroke.pts.length; i += 3) {
      pts.push({ x: art.pad + stroke.pts[i] * k, y: art.baseline + stroke.pts[i + 1] * k, r: stroke.pts[i + 2] * k, t: 0, dot: stroke.dot });
    }
    if (last) {
      // Lift, and over to where the next stroke starts.
      const hop = Math.hypot(pts[0].x - last.x, pts[0].y - last.y) / art.size;
      t += LIFT_SEC + hop / (PEN_SPEED * 2.2);
    }
    if (stroke.dot) {
      pts[0].t = t + DOT_SEC;
      t += DOT_SEC;
      out.push(...pts);
      last = pts[0];
      continue;
    }
    // Arc length along the stroke, in em.
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / art.size);
    const total = s[s.length - 1];
    pts[0].t = t;
    for (let i = 1; i < pts.length; i++) {
      // How sharply the way turns here (over a few points either side).
      const a = pts[Math.max(0, i - 4)];
      const b = pts[i];
      const c = pts[Math.min(pts.length - 1, i + 4)];
      const turn = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
      const bend = Math.min(1, (turn > Math.PI ? 2 * Math.PI - turn : turn) / 1.1);
      const ease = 0.3 + 0.7 * smoothstep(Math.min(s[i], total - s[i]) / EASE_EM);
      const speed = PEN_SPEED * (1 - CURVE_SLOWDOWN * bend) * ease;
      t += (s[i] - s[i - 1]) / speed;
      pts[i].t = t;
    }
    out.push(...pts);
    last = pts[pts.length - 1];
  }
  return out;
}

/** Replaces `host`'s text with the name (it stays readable for screen readers as a label). */
export function lightScoreName(host: HTMLElement) {
  host.textContent = '';
  host.setAttribute('aria-label', 'LightScore');
  const wrap = document.createElement('span');
  wrap.className = 'ls-name';
  wrap.setAttribute('aria-hidden', 'true');
  const light = document.createElement('canvas');
  light.className = 'ls-light';
  const score = document.createElement('canvas');
  score.className = 'ink ls-score';
  wrap.append(light, score);
  host.appendChild(wrap);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let art: LightArt | null = null;
  let path: PenPoint[] = [];
  let mask: HTMLCanvasElement | null = null;
  let revealed: HTMLCanvasElement | null = null;
  let masked = 0; // how many points of the path are already in the mask
  let started = 0;
  let raf = 0;
  let done = false;

  const finish = () => {
    done = true;
    wrap.classList.add('light-written');
    wrap.classList.add('light-settled');
    const ctx = light.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, light.width, light.height);
    if (art) ctx.drawImage(art.full, 0, 0);
  };

  const frame = (now: number) => {
    raf = 0;
    if (!art || !mask || !revealed || done) return;
    const t = (now - started) / 1000;
    const end = path.length ? path[path.length - 1].t : 0;
    if (reduce || t > end + FINISH_SEC) {
      finish();
      return;
    }
    // "Score" follows as soon as the last stroke is down (while the nib's light still fades).
    if (t > end) wrap.classList.add('light-written');
    const dpr = art.dpr;
    // What the nib has covered since the last frame joins the written part.
    const m = mask.getContext('2d')!;
    m.fillStyle = '#000';
    while (masked < path.length && path[masked].t <= t) {
      const p = path[masked];
      m.beginPath();
      m.arc(p.x * dpr, p.y * dpr, (p.r * 1.4 + 0.8) * dpr, 0, Math.PI * 2);
      m.fill();
      masked++;
    }
    // The dot grows under the nib as it is set down.
    const next = path[masked];
    let nib: PenPoint | null = masked > 0 ? path[masked - 1] : null;
    if (next?.dot) {
      const prevT = masked > 0 ? path[masked - 1].t : 0;
      const grow = Math.max(0, Math.min(1, (t - (next.t - DOT_SEC)) / DOT_SEC));
      if (t > prevT + LIFT_SEC * 0.5 && grow > 0) {
        m.beginPath();
        m.arc(next.x * dpr, next.y * dpr, (next.r * 1.4 + 0.8) * grow * dpr, 0, Math.PI * 2);
        m.fill();
        nib = next;
      }
    }
    const rv = revealed.getContext('2d')!;
    rv.globalCompositeOperation = 'source-over';
    rv.clearRect(0, 0, revealed.width, revealed.height);
    rv.drawImage(art.core, 0, 0);
    rv.globalCompositeOperation = 'destination-in';
    rv.drawImage(mask, 0, 0);

    const ctx = light.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, light.width, light.height);
    glow(ctx, revealed, dpr, art.size);

    // The nib: a bright point where the pen is, dimming while it is lifted and after the last stroke.
    if (nib) {
      const lifted = next && !next.dot && t < next.t ? Math.max(0, 1 - (t - (masked > 0 ? path[masked - 1].t : 0)) / 0.08) : 1;
      const fade = t > end ? Math.max(0, 1 - (t - end) / FINISH_SEC) : 1;
      const k = Math.max(0.25, lifted) * fade;
      const x = nib.x * dpr;
      const y = nib.y * dpr;
      const r = art.size * 0.09 * dpr;
      const spot = ctx.createRadialGradient(x, y, 0, x, y, r);
      spot.addColorStop(0, `rgba(255,236,200,${0.8 * k})`);
      spot.addColorStop(0.3, `rgba(255,200,140,${0.25 * k})`);
      spot.addColorStop(1, 'rgba(255,200,140,0)');
      ctx.fillStyle = spot;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.fillStyle = `rgba(255,253,246,${k})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.6, art.size * 0.007) * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  };

  const layout = () => {
    const base = parseFloat(getComputedStyle(host).fontSize) || 96;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // The name fits the screen: shrink it on a narrow one.
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `400 ${base * LIGHT_SCALE}px ${FONT_SCRIPT}`;
    const lightW = probe.measureText('Light').width;
    const fit = Math.min(1, (window.innerWidth * 0.9) / (lightW + base * (GAP + 2.95)));
    const size = base * fit;

    const ink = renderInk(score, 'Score', size, 600);
    art = renderLight(size * LIGHT_SCALE, dpr);
    path = penPath(art);
    light.width = art.core.width;
    light.height = art.core.height;
    light.style.width = `${art.core.width / dpr}px`;
    light.style.height = `${art.core.height / dpr}px`;
    mask = document.createElement('canvas');
    mask.width = art.core.width;
    mask.height = art.core.height;
    revealed = document.createElement('canvas');
    revealed.width = art.core.width;
    revealed.height = art.core.height;
    masked = 0;

    // One baseline for both words.
    const scoreW = ink.cssW - ink.pad * 2;
    const baseline = size * 1.02;
    wrap.style.width = `${Math.round(art.width + size * GAP + scoreW)}px`;
    wrap.style.height = `${Math.round(size * 1.3)}px`;
    light.style.left = `${-art.pad}px`;
    light.style.top = `${baseline - art.baseline}px`;
    score.style.left = `${art.width + size * GAP - ink.pad}px`;
    score.style.top = `${baseline - ink.baseline}px`;
  };

  const fonts = Promise.all([loadScriptFont(), document.fonts.load(`600 100px ${FONT_DISPLAY}`).catch(() => undefined)]);
  void fonts.then(() => {
    layout();
    started = performance.now();
    raf = requestAnimationFrame(frame);
  });
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      layout();
      if (done) finish();
      else if (!raf) raf = requestAnimationFrame(frame);
    }, 120);
  });
}
