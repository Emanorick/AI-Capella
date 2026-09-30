// "Die erste Zeile" -- the title screen as the first line of a score (design.ts START_STAFF).
//
// The app is a score with light passing through it; the title shows that once, in miniature:
//   1. a rastral -- the five-nibbed pen music paper was ruled with -- draws a staff across the
//      paper, the five lines at once, a hand's slight unevenness in them;
//   2. "Score" is pressed into it in gold: its letters stand exactly between the staff's top and
//      bottom lines (the container, holding still);
//   3. the pen of light writes "Light" across the staff, its L, g and h breaking out of the five
//      lines (the contained, moving);
//   4. "Light" flares up once, and sends out the reading line of the player: it rises at the end of
//      the word and glides, easing in and out, to the end of the staff, lighting the lines from
//      behind as it passes. Past "Score" it finds the voices -- five notes, punched into the paper
//      like the piano roll's, entering one after another from the lowest and held together -- and
//      lights them in their colours as it crosses them.
// The lines stay the staff's: neutral, as in the sheet view; the colours belong to the notes, as
// everywhere in the app. A tap sends a pulse of light along the staff from where it landed.

import { colorForPart } from './palette';
import { withAlpha } from './theme';
import type { TitleName } from './lightName';

const RULE_SEC = 1.15; // the rastral's way across
const PEN_AFTER_SEC = 1.25; // the pen of light sets down
const BIRTH_AFTER_SEC = 0.45; // "Light" written -> it flares (style.css) -> the reading line rises
const RISE_SEC = 0.55; // the reading line growing to its height
const GLIDE_SEC = 2.8; // ...then gliding to the end of the staff
const FADE_SEC = 0.7; // ...and fading out there
const VOICES = 5;
// The voices' notes, in half staff spaces above the bottom line, top voice first; they enter one
// after another from the lowest up, each held as long as the others -- a canon's entries.
const NOTE_STEPS = [7, 5, 3, 1, -1];
const PULSE_SPEED = 620; // px/s
const PULSE_SEC = 1.1;

const easeInOut = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * u);
const easeOut = (u: number) => 1 - (1 - u) * (1 - u);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

interface Frame {
  x0: number;
  x1: number;
  top: number; // top line, canvas px
  space: number; // between lines
  born: number; // where the reading line rises: the end of "Light"
  notes: { x: number; end: number; y: number; color: string }[];
}

/** A hand's slight unevenness in a ruled line (px). */
function wobble(x: number, k: number): number {
  return 0.55 * Math.sin(x / 97 + k * 1.7) + 0.35 * Math.sin(x / 41 + k * 2.9) + 0.2 * Math.sin(x / 13 + k);
}

/** The reading line at x: a hairline of light with the lamp's warm glow behind the paper. */
function readingLine(ctx: CanvasRenderingContext2D, x: number, cy: number, staffH: number, height: number, alpha: number) {
  const reach = 70;
  const tall = (Math.max(staffH * 2.4, 120) / reach) * height;
  if (tall > 0.01) {
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
  }
  const half = staffH * 1.1 * height;
  if (half < 1) return;
  const line = ctx.createLinearGradient(0, cy - half, 0, cy + half);
  line.addColorStop(0, 'rgba(255,240,214,0)');
  line.addColorStop(0.5, `rgba(255,240,214,${0.6 * alpha})`);
  line.addColorStop(1, 'rgba(255,240,214,0)');
  ctx.fillStyle = line;
  ctx.fillRect(x - 0.5, cy - half, 1, half * 2);
}

/** A note punched into the paper, lit from behind: a rounded slot in the voice's colour. */
function note(ctx: CanvasRenderingContext2D, x: number, end: number, y: number, h: number, color: string, alpha: number, hot: number) {
  if (end - x < 1 || alpha <= 0.01) return;
  const r = h / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = new Path2D();
  halo.roundRect(x - r * 0.9, y - r * 1.9, end - x + r * 1.8, r * 3.8, r * 1.9);
  ctx.fillStyle = withAlpha(color, 0.1 * alpha);
  ctx.fill(halo);
  ctx.restore();
  const slot = new Path2D();
  slot.roundRect(x, y - r, end - x, h, r);
  ctx.fillStyle = withAlpha(color, 0.85 * alpha);
  ctx.fill(slot);
  if (hot > 0.01) {
    ctx.fillStyle = `rgba(255,250,240,${0.8 * hot * alpha})`;
    const core = new Path2D();
    core.roundRect(x + r * 0.4, y - r * 0.35, Math.max(0, end - x - r * 0.8), r * 0.7, r * 0.35);
    ctx.fill(core);
  }
}

export function animateStaff(canvas: HTMLCanvasElement, name: TitleName): () => void {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d')!;
  let start = Infinity; // when the ruling began
  let writtenAt = Infinity; // when "Light" was finished
  let frame: Frame | null = null;
  let raf = 0;
  const pulses: { x: number; t0: number }[] = [];

  const layout = (): Frame | null => {
    const g = name.geometry();
    if (!g) return null;
    const r = canvas.getBoundingClientRect();
    const w = r.width;
    const narrow = w < 700;
    const space = (g.baseline - g.capTop) / 4;
    const x0 = narrow ? 14 : Math.min(g.left - space * 4, w * 0.07);
    const x1 = narrow ? w - 14 : Math.max(g.right + space * 4, w * 0.93);
    const baseline = g.baseline - r.top;
    // The voices' notes, in the staff after "Score" -- as long as there's room for them.
    const from = g.right - r.left + space * 2.2;
    const to = x1 - Math.max(space * 1.2, 30);
    const notes: Frame['notes'] = [];
    if (to - from > space * 6) {
      const step = Math.min(space * 2.2, (to - from) / 7.5);
      const length = to - from - step * (VOICES - 1);
      for (let k = 0; k < VOICES; k++) {
        const x = from + (VOICES - 1 - k) * step; // lowest first
        notes.push({ x, end: x + length, y: baseline - (NOTE_STEPS[k] * space) / 2, color: colorForPart(k, VOICES) });
      }
    }
    return { x0, x1, top: g.capTop - r.top, space, born: g.lightRight - r.left + space * 0.4, notes };
  };

  void name.shown.then(() => {
    start = performance.now() / 1000;
    window.setTimeout(() => name.push(), PEN_AFTER_SEC * 1000);
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
    const now = still ? Infinity : nowMs / 1000;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    raf = still ? 0 : requestAnimationFrame(draw);
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
    const { x0, x1, top, space, born, notes } = frame;
    const t = now - start;
    const staffH = space * 4;
    const cy = top + space * 2;

    // 1. The rastral's way across.
    const ruled = still ? 1 : easeInOut(clamp01(t / RULE_SEC));
    const xr = x0 + (x1 - x0) * ruled;

    // 4. The reading line: rises at the end of "Light", glides to the end of the staff, fades.
    const since = now - writtenAt - BIRTH_AFTER_SEC;
    const rise = still ? 1 : easeOut(clamp01(since / RISE_SEC));
    const glide = still ? 1 : easeInOut(clamp01((since - RISE_SEC * 0.6) / GLIDE_SEC));
    const lamp = born + (x1 + 10 - born) * glide;
    const fade = still ? 0 : since < 0 ? 0 : 1 - clamp01((since - RISE_SEC * 0.6 - GLIDE_SEC + FADE_SEC * 0.5) / FADE_SEC);
    const lampOn = fade > 0.01 && since > 0;
    // How far the light has been: the notes and the lines keep what it has lit.
    const reached = still ? Infinity : since > 0 ? lamp : -Infinity;

    if (lampOn) readingLine(ctx, lamp, cy, staffH, rise, fade);

    ctx.lineCap = 'round';
    for (let k = 0; k < VOICES; k++) {
      const yAt = (x: number) => top + k * space + wobble(x, k);
      const path = new Path2D();
      path.moveTo(x0, yAt(x0));
      for (let x = x0 + 6; x < xr; x += 6) path.lineTo(x, yAt(x));
      path.lineTo(xr, yAt(xr));

      // Paper-white ink, as the sheet view's staff; lit warm where the reading line passes, with a
      // little of its light lingering behind it.
      const span = x1 - x0;
      const at = (x: number) => clamp01((x - x0) / span);
      const ink = 'rgba(239,231,218,0.34)';
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      if (lampOn) {
        const hot = `rgba(255,240,214,${(0.34 + 0.6 * fade * rise).toFixed(3)})`;
        const after = `rgba(255,232,200,${(0.34 + 0.16 * fade).toFixed(3)})`;
        g.addColorStop(0, ink);
        g.addColorStop(at(lamp - 320), ink);
        g.addColorStop(at(lamp - 90), after);
        g.addColorStop(at(lamp - 8), hot);
        g.addColorStop(at(lamp + 8), hot);
        g.addColorStop(at(lamp + 60), ink);
        g.addColorStop(1, ink);
        ctx.strokeStyle = g;
      } else ctx.strokeStyle = ink;
      ctx.lineWidth = 1.15;
      ctx.stroke(path);

      // The rastral's nib, one of five, while it rules.
      if (ruled < 1) {
        ctx.fillStyle = 'rgba(255,246,230,0.9)';
        ctx.beginPath();
        ctx.arc(xr, yAt(xr), 1.6, 0, Math.PI * 2);
        ctx.fill();
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
          const spot = ctx.createRadialGradient(x, y, 0, x, y, 14);
          spot.addColorStop(0, `rgba(255,244,224,${0.75 * a})`);
          spot.addColorStop(1, 'rgba(255,230,190,0)');
          ctx.fillStyle = spot;
          ctx.fillRect(x - 14, y - 14, 28, 28);
        }
      }
    }

    // The voices: their notes, dark slots in the paper until the reading line reaches them, then lit
    // in their colours -- brightest where it is crossing them, settling to a steady glow behind it.
    for (const n of notes) {
      const h = space * 0.6;
      if (since > 0 && !still) note(ctx, n.x, n.end, n.y, h, n.color, 0.14 * rise, 0);
      const litTo = Math.min(n.end, reached);
      if (litTo <= n.x) continue;
      const near = lampOn ? clamp01(1 - Math.abs(lamp - litTo) / 40) : 0;
      note(ctx, n.x, litTo, n.y, h, n.color, 0.8, near * fade);
    }

    // Ends of the staff: as a ruled line lifts off, not cut.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const [from, to] of [
      [x0 - 2, x0 + 26],
      [x1 + 2, x1 - 26],
    ]) {
      const f = ctx.createLinearGradient(from, 0, to, 0);
      f.addColorStop(0, 'rgba(0,0,0,1)');
      f.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = f;
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
