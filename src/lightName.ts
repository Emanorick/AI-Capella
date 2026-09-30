// The title screen's name, LightScore: "Light" moves, "Score" holds. "Light" is written with light
// as by a pen -- a bright point travels along the letters from left to right and leaves them
// glowing, like the voice lines behind them; then "Score" follows in ink, solid, written in from
// left to right (style.css), and the name floats over the paper.

import { FONT_SCRIPT, loadScriptFont } from './goldInk';
import { renderInk } from './inkWordmark';
import { FONT_DISPLAY } from './theme';

const LIGHT_SCALE = 1.62; // the pen script is small for its size: its "Light" stands as tall as "Score" at this
const GAP = 0.1; // between the two words, in em of Score
const WRITE_SEC = 1.75; // the pen's journey through "Light"
const PEN_FOLLOW = 0.3; // how quickly the pen's point follows the letters up and down (per frame)

const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

interface LightArt {
  image: HTMLCanvasElement; // the glowing word, device px
  pad: number; // css px of glow room around the letters
  width: number; // the word's advance, css px
  baseline: number; // in the image, css px from its top
  column: (x: number) => number | null; // where the letters are at x (css px from the word's start): their mid-height
}

/** "Light" in light: a warm white stroke in a soft glow, rendered once per size. */
function renderLight(size: number, dpr: number): LightArt {
  const font = `400 ${size}px ${FONT_SCRIPT}`;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const width = probe.measureText('Light').width;
  const pad = Math.round(size * 0.35);
  const cssW = Math.ceil(width + pad * 2);
  const cssH = Math.ceil(size * 1.25 + pad * 2);
  const baseline = pad + size * 0.82;

  // Where the ink of the letters lies, column by column (for the pen's point).
  const mask = document.createElement('canvas');
  mask.width = cssW;
  mask.height = cssH;
  const m = mask.getContext('2d', { willReadFrequently: true })!;
  m.font = font;
  m.fillText('Light', pad, baseline);
  const data = m.getImageData(0, 0, cssW, cssH).data;
  const centres: (number | null)[] = [];
  for (let x = 0; x < cssW; x++) {
    let sum = 0;
    let weight = 0;
    for (let y = 0; y < cssH; y++) {
      const a = data[(y * cssW + x) * 4 + 3];
      sum += a * y;
      weight += a;
    }
    centres.push(weight > 40 ? sum / weight : null);
  }

  const image = document.createElement('canvas');
  image.width = Math.round(cssW * dpr);
  image.height = Math.round(cssH * dpr);
  const g = image.getContext('2d')!;
  g.scale(dpr, dpr);
  g.font = font;
  g.globalCompositeOperation = 'lighter';
  for (const [blur, a] of [
    [size * 0.45, 0.22],
    [size * 0.18, 0.3],
    [size * 0.06, 0.45],
  ]) {
    // A shadow is as strong as what casts it: an opaque stroke, which the core covers below.
    g.shadowColor = `rgba(255,190,112,${a})`;
    g.shadowBlur = blur * dpr;
    g.fillStyle = 'rgb(255,226,186)';
    g.fillText('Light', pad, baseline);
  }
  g.shadowBlur = 0;
  // The stroke itself, white-hot like the core of the voice lines.
  g.fillStyle = 'rgba(255,252,244,1)';
  g.fillText('Light', pad, baseline);
  g.globalCompositeOperation = 'source-over';

  return { image, pad, width, baseline, column: (x) => centres[Math.round(x + pad)] ?? null };
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
  let started = 0;
  let raf = 0;
  let penY: number | null = null;

  const drawLight = (now: number) => {
    if (!art) return;
    const dpr = art.image.width / (art.width + art.pad * 2);
    const ctx = light.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, light.width, light.height);
    const t = reduce ? Infinity : (now - started) / 1000;
    const u = Math.min(1, t / WRITE_SEC);
    const front = art.pad + easeInOut(u) * (art.width + art.pad * 0.2); // css px in the image
    ctx.drawImage(art.image, 0, 0);
    if (u < 1) {
      // Only what the pen has written so far, fading off just behind its point.
      ctx.globalCompositeOperation = 'destination-in';
      const edge = ctx.createLinearGradient((front - 18) * dpr, 0, (front + 2) * dpr, 0);
      edge.addColorStop(0, '#000');
      edge.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, light.width, light.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    // The pen's bright point, riding on the letters.
    const target = art.column(front - art.pad);
    if (target !== null) penY = penY === null ? target : penY + (target - penY) * PEN_FOLLOW;
    const fade = u < 1 ? 1 : Math.max(0, 1 - (t - WRITE_SEC) / 0.5);
    if (penY !== null && fade > 0) {
      const x = front * dpr;
      const y = penY * dpr;
      const r = 26 * dpr;
      const spot = ctx.createRadialGradient(x, y, 0, x, y, r);
      spot.addColorStop(0, `rgba(255,236,200,${0.75 * fade})`);
      spot.addColorStop(0.25, `rgba(255,200,140,${0.28 * fade})`);
      spot.addColorStop(1, 'rgba(255,200,140,0)');
      ctx.fillStyle = spot;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.fillStyle = `rgba(255,252,244,${fade})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.2 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    if (t < WRITE_SEC + 0.6) raf = requestAnimationFrame(drawLight);
    else wrap.classList.add('written');
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
    light.width = art.image.width;
    light.height = art.image.height;
    light.style.width = `${art.image.width / dpr}px`;
    light.style.height = `${art.image.height / dpr}px`;

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
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(drawLight);
  });
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      layout();
      if (!raf || wrap.classList.contains('written')) drawLight(performance.now() + 1e6);
    }, 120);
  });
}
