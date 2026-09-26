// Draft title screen (design.ts START_DRAFT): the name written in ink, floating over the paper.
// The letters are the app's Bodoni -- itself a pointed-pen letter, thick downstrokes and hairlines --
// traced as if with a fountain pen: each letter set down by hand (a hair of tilt and lift), the ink
// feathered into the paper's fibres at the edges, a little denser along them where it pooled while
// drying. Rendered once into a canvas (and again on resize); the page shows it with a soft shadow
// beneath, so it hovers, and writes it in from left to right (style.css).

import { FONT_DISPLAY } from './theme';

const INK: [number, number, number] = [239, 230, 216];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Box blur of a single channel, horizontally then vertically, radius r (in place via a buffer). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Smooth noise stretched along the paper's grain (cells cw x ch px), values 0..1. */
function fibreNoise(w: number, h: number, cw: number, ch: number, seed: number): Float32Array {
  const r = rng(seed);
  const gw = Math.ceil(w / cw) + 2;
  const gh = Math.ceil(h / ch) + 2;
  const grid = Float32Array.from({ length: gw * gh }, () => r());
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = y / ch;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = x / cw;
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const a = grid[y0 * gw + x0] + (grid[y0 * gw + x0 + 1] - grid[y0 * gw + x0]) * fx;
      const b = grid[(y0 + 1) * gw + x0] + (grid[(y0 + 1) * gw + x0 + 1] - grid[(y0 + 1) * gw + x0]) * fx;
      out[y * w + x] = a + (b - a) * fy;
    }
  }
  return out;
}

/** Replaces `host`'s text with the inked name (the text stays for screen readers). */
export function inkWordmark(host: HTMLElement) {
  const text = host.textContent?.trim() || 'AI-Capella';
  host.textContent = '';
  host.setAttribute('aria-label', text);
  const canvas = document.createElement('canvas');
  canvas.className = 'ink';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  const draw = () => {
    const size = parseFloat(getComputedStyle(host).fontSize) || 96;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const font = `500 ${size}px ${FONT_DISPLAY}`;
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = font;
    const track = -0.015 * size;
    // Letter positions from the widths of the growing text, so the font's kerning is kept.
    const xs = [...text].map((_, i) => measure.measureText(text.slice(0, i)).width + i * track);
    const width = measure.measureText(text).width + (text.length - 1) * track;
    const pad = Math.round(size * 0.22);
    const cssW = Math.ceil(width + pad * 2);
    const cssH = Math.ceil(size * 1.32 + pad);
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);

    // 1. The letters, each set down by hand.
    const mask = document.createElement('canvas');
    mask.width = W;
    mask.height = H;
    const m = mask.getContext('2d')!;
    m.scale(dpr, dpr);
    m.font = font;
    m.fillStyle = '#fff';
    // A pen's ink line is never as fine as the typeface's display hairlines: a little width all round.
    m.strokeStyle = '#fff';
    m.lineWidth = Math.max(1, size * 0.014);
    m.lineJoin = 'round';
    m.textBaseline = 'alphabetic';
    const r = rng(7);
    const baseline = pad + size * 0.98;
    [...text].forEach((ch, i) => {
      m.save();
      m.translate(pad + xs[i], baseline + (r() - 0.5) * size * 0.012);
      m.rotate(((r() - 0.5) * 1.6 * Math.PI) / 180);
      m.strokeText(ch, 0, 0);
      m.fillText(ch, 0, 0);
      m.restore();
    });
    const img = m.getImageData(0, 0, W, H);
    const alpha = new Float32Array(W * H);
    for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3] / 255;

    // 2. Ink: edges feathered along the fibres, denser where it pooled at the rim.
    const soft = boxBlur(alpha, W, H, Math.max(1, Math.round(0.9 * dpr)));
    const fibres = fibreNoise(W, H, Math.round(16 * dpr), Math.max(1, Math.round(2.2 * dpr)), 11);
    const grain = fibreNoise(W, H, Math.max(1, Math.round(3 * dpr)), Math.max(1, Math.round(1.2 * dpr)), 23);
    const out = m.createImageData(W, H);
    for (let i = 0; i < alpha.length; i++) {
      const b = soft[i];
      if (b < 0.02) continue;
      // Mostly the letter itself (so hairlines survive), its blurred edge frayed by the fibres.
      const v = 0.62 * alpha[i] + 0.38 * b + (fibres[i] - 0.5) * 0.3 + (grain[i] - 0.5) * 0.12;
      const cover = smooth(0.3, 0.55, v);
      if (cover <= 0) continue;
      const rim = cover * (1 - smooth(0.6, 0.97, b));
      const density = Math.min(1, 0.84 + 0.16 * rim + (grain[i] - 0.5) * 0.14);
      const lift = 0.3 * rim; // pooled ink catches a little more light
      out.data[i * 4] = INK[0] + (255 - INK[0]) * lift;
      out.data[i * 4 + 1] = INK[1] + (252 - INK[1]) * lift;
      out.data[i * 4 + 2] = INK[2] + (246 - INK[2]) * lift;
      out.data[i * 4 + 3] = 255 * cover * density;
    }
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    // The canvas's padding (for the feathering and the tilt) shouldn't push the layout around.
    canvas.style.margin = `${-pad}px`;
    canvas.getContext('2d')!.putImageData(out, 0, 0);
  };

  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = window.setTimeout(draw, 120);
  });
  const ready = 'fonts' in document ? document.fonts.load(`500 100px ${FONT_DISPLAY}`).catch(() => undefined) : Promise.resolve();
  draw();
  void ready.then(draw);
}
