// "Die erste Zeile" -- the title screen as the first line of a score (design.ts START_STAFF).
//
// The app is a score with light passing through it; the title shows that once, in miniature:
//   1. a rastral -- the five-nibbed pen music paper was ruled with -- draws a staff across the
//      paper, the five lines at once, a hand's slight unevenness in them;
//   2. "Score" is pressed into it in gold: its letters stand exactly between the staff's top and
//      bottom lines (the container, holding still);
//   3. the pen of light writes "Light" across the staff -- its L, g and h breaking out of the five
//      lines (the contained, moving) -- and the reading line of the player follows the pen, lighting
//      the staff from behind as it passes;
//   4. the reading line runs on to the end of the staff, and the lines take on the five voices'
//      colours in its wake: the choir comes in. Afterwards a few notes of light travel along them.
// A tap sends a pulse of light along the staff from where it landed.

import { colorForPart } from './palette';
import { withAlpha } from './theme';
import type { TitleName } from './lightName';

const RULE_SEC = 1.15; // the rastral's way across
const PEN_AFTER_SEC = 1.25; // the pen of light sets down
const RUN_ON_SEC = 1.1; // the reading line from the end of "Light" to the end of the staff
const VOICES = 5;
const PULSE_SPEED = 620; // px/s
const PULSE_SEC = 1.1;

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(2 - 2 * u, 3) / 2);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

interface Frame {
  x0: number;
  x1: number;
  top: number; // top line
  space: number; // between lines
}

/** A hand's slight unevenness in a ruled line (px). */
function wobble(x: number, k: number): number {
  return 0.55 * Math.sin(x / 97 + k * 1.7) + 0.35 * Math.sin(x / 41 + k * 2.9) + 0.2 * Math.sin(x / 13 + k);
}

/** The lamp behind the paper at x: warm, tall and narrow, fading off every way. */
function lampGlow(ctx: CanvasRenderingContext2D, x: number, cy: number, staffH: number, alpha: number) {
  const reach = 70;
  const tall = Math.max(staffH * 2.4, 120) / reach;
  ctx.save();
  ctx.translate(x, cy);
  ctx.scale(1, tall);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
  g.addColorStop(0, `rgba(255,214,166,${0.2 * alpha})`);
  g.addColorStop(0.35, `rgba(255,200,150,${0.09 * alpha})`);
  g.addColorStop(1, 'rgba(255,200,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
  ctx.restore();
  // The reading line itself: a hairline of light through the staff.
  const line = ctx.createLinearGradient(0, cy - staffH * 1.1, 0, cy + staffH * 1.1);
  line.addColorStop(0, 'rgba(255,240,214,0)');
  line.addColorStop(0.5, `rgba(255,240,214,${0.55 * alpha})`);
  line.addColorStop(1, 'rgba(255,240,214,0)');
  ctx.fillStyle = line;
  ctx.fillRect(x - 0.5, cy - staffH * 1.1, 1, staffH * 2.2);
}

export function animateStaff(canvas: HTMLCanvasElement, name: TitleName): () => void {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d')!;
  let start = Infinity; // when the ruling began
  let penAt = Infinity; // when the pen set down
  let writtenAt = Infinity; // when "Light" was finished
  let lampX = -Infinity; // the reading line: furthest the pen has come
  let frame: Frame | null = null;
  let raf = 0;
  const pulses: { x: number; t0: number }[] = [];

  const layout = () => {
    const g = name.geometry();
    if (!g) return null;
    const r = canvas.getBoundingClientRect();
    const w = r.width;
    const narrow = w < 700;
    const space = (g.baseline - g.capTop) / 4;
    return {
      x0: narrow ? 14 : Math.min(g.left - space * 4, w * 0.07),
      x1: narrow ? w - 14 : Math.max(g.right + space * 4, w * 0.93),
      top: g.capTop - r.top,
      space,
    };
  };

  void name.shown.then(() => {
    start = performance.now() / 1000;
    window.setTimeout(() => {
      name.push();
      penAt = performance.now() / 1000;
    }, PEN_AFTER_SEC * 1000);
    void name.written.then(() => (writtenAt = performance.now() / 1000));
  });

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = canvas.getBoundingClientRect();
    pulses.push({ x: e.clientX - r.left, t0: performance.now() / 1000 });
    if (pulses.length > 4) pulses.shift();
  };
  canvas.parentElement?.addEventListener('pointerdown', onDown);

  const draw = (nowMs: number) => {
    raf = still ? 0 : requestAnimationFrame(draw);
    const now = still ? Infinity : nowMs / 1000;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      frame = null;
    }
    frame ??= layout();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!frame || now < start) return;
    const { x0, x1, top, space } = frame;
    const t = now - start;

    // 1. The rastral's way across.
    const ruled = still ? 1 : ease(clamp01(t / RULE_SEC));
    const xr = x0 + (x1 - x0) * ruled;

    // 3. The reading line follows the pen (only ever forward); 4. then runs on to the end.
    const nib = name.nib();
    if (nib) lampX = Math.max(lampX, nib.x - canvas.getBoundingClientRect().left);
    let lamp = -Infinity;
    let lampAlpha = 0;
    if (still) lamp = x1;
    else if (now >= penAt) {
      if (now < writtenAt) {
        lamp = lampX;
        lampAlpha = clamp01((now - penAt) / 0.4);
      } else {
        const u = clamp01((now - writtenAt) / RUN_ON_SEC);
        lamp = lampX + (x1 + 40 - lampX) * ease(u);
        lampAlpha = 1 - clamp01((now - writtenAt - RUN_ON_SEC * 0.7) / 0.6);
      }
    }
    // Where the voices' colours have reached (they follow the reading line once "Light" is done).
    const voicedTo = still ? x1 + 1 : now >= writtenAt ? lamp : -Infinity;

    // The reading line: the player's lamp behind the paper, a soft upright glow over the staff.
    if (lampAlpha > 0.01 && Number.isFinite(lamp)) lampGlow(ctx, lamp, top + space * 2, space * 4, lampAlpha);

    ctx.lineCap = 'round';
    for (let k = 0; k < VOICES; k++) {
      const color = colorForPart(k, VOICES);
      const yAt = (x: number) => top + k * space + wobble(x, k);
      const path = new Path2D();
      const step = 6;
      let first = true;
      for (let x = x0; x <= xr; x += step) {
        const px = Math.min(x, xr);
        if (first) path.moveTo(px, yAt(px));
        else path.lineTo(px, yAt(px));
        first = false;
      }
      path.lineTo(xr, yAt(xr));

      // The line's ink: paper-white; in the voice's colour where the choir has come in; brighter
      // where the reading line lights it, fading off behind it.
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      const span = x1 - x0;
      const at = (x: number) => clamp01((x - x0) / span);
      const ink = 'rgba(239,231,218,0.34)';
      const voiced = withAlpha(color, 0.62);
      const hot = 'rgba(255,240,214,0.95)';
      const stops: [number, string][] = [];
      if (Number.isFinite(voicedTo) && voicedTo > x0) {
        stops.push([0, voiced], [at(voicedTo - 30), voiced], [at(voicedTo), ink]);
      } else stops.push([0, ink]);
      if (lampAlpha > 0.01 && Number.isFinite(lamp) && lamp > x0 - 60) {
        const behind = voicedTo >= lamp - 30 ? voiced : 'rgba(255,226,186,0.5)';
        stops.push([at(lamp - 220), behind], [at(lamp - 14), hot], [at(lamp + 10), hot], [at(lamp + 70), ink]);
      }
      stops.push([1, ink]);
      stops.sort((a, b) => a[0] - b[0]);
      for (const [o, c] of stops) g.addColorStop(o, c);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.15;
      ctx.stroke(path);

      // A soft glow round the voiced lines.
      if (Number.isFinite(voicedTo) && voicedTo > x0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createLinearGradient(x0, 0, x1, 0);
        glow.addColorStop(0, withAlpha(color, 0.1));
        glow.addColorStop(at(voicedTo - 30), withAlpha(color, 0.1));
        glow.addColorStop(at(voicedTo), withAlpha(color, 0));
        glow.addColorStop(1, withAlpha(color, 0));
        ctx.strokeStyle = glow;
        ctx.lineWidth = 5;
        ctx.stroke(path);
        ctx.restore();
      }

      // The rastral's nib, one of five, while it rules.
      if (ruled < 1) {
        ctx.fillStyle = 'rgba(255,246,230,0.9)';
        ctx.beginPath();
        ctx.arc(xr, yAt(xr), 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Notes of light travelling along the lines, once the voices are in.
      if (!still && now > writtenAt + RUN_ON_SEC) {
        const since = now - writtenAt - RUN_ON_SEC;
        for (let b = 0; b < 2; b++) {
          const speed = 34 + ((k * 7 + b * 13) % 5) * 7;
          const u = ((since * speed + (k * 211 + b * 397)) % (span + 200)) - 100;
          const x = x0 + u;
          if (x < x0 || x > x1) continue;
          const edge = Math.min(1, (x - x0) / 80, (x1 - x) / 80) * clamp01(since / 1.5);
          const y = yAt(x);
          const spot = ctx.createRadialGradient(x, y, 0, x, y, 7);
          spot.addColorStop(0, withAlpha(color, 0.75 * edge));
          spot.addColorStop(1, withAlpha(color, 0));
          ctx.fillStyle = spot;
          ctx.fillRect(x - 7, y - 7, 14, 14);
        }
      }

      // A tap's pulse, running both ways along the staff.
      for (const p of pulses) {
        const age = now - p.t0;
        if (age > PULSE_SEC) continue;
        const a = (1 - age / PULSE_SEC) ** 2;
        for (const dir of [-1, 1]) {
          const x = p.x + dir * age * PULSE_SPEED;
          if (x < x0 || x > xr) continue;
          const y = yAt(x);
          const spot = ctx.createRadialGradient(x, y, 0, x, y, 16);
          spot.addColorStop(0, `rgba(255,244,224,${0.8 * a})`);
          spot.addColorStop(0.35, withAlpha(color, 0.35 * a));
          spot.addColorStop(1, withAlpha(color, 0));
          ctx.fillStyle = spot;
          ctx.fillRect(x - 16, y - 16, 32, 32);
        }
      }
    }
    // Ends of the staff: as a ruled line lifts off, not cut.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const [from, to] of [
      [x0 - 2, x0 + 26],
      [x1 + 2, x1 - 26],
    ]) {
      const fade = ctx.createLinearGradient(from, 0, to, 0);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fade;
      ctx.fillRect(Math.min(from, to), top - space * 3, Math.abs(to - from), space * 10);
    }
    ctx.restore();
    while (pulses.length && now - pulses[0].t0 > PULSE_SEC) pulses.shift();
  };
  raf = requestAnimationFrame(draw);

  const onResize = () => {
    frame = null;
    if (still) requestAnimationFrame(draw);
  };
  window.addEventListener('resize', onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    canvas.parentElement?.removeEventListener('pointerdown', onDown);
  };
}
