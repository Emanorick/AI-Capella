// "Die Bühne" -- the title screen as a stage before the light comes on (design.ts START_STAGE).
//
//   1. Darkness: black paper, "Score" in its gold, "Light" only a shadow of itself, the five lines of
//      a staff barely there -- running in from the left through the name and sweeping up to the
//      right, where the voices wait as unlit notes.
//   2. The light comes on: a spotlight from the upper left flickers on, catches and settles on the
//      name; "Light" lights up with it (style.css, .ls-name.lit). In its cone the grain of the paper
//      shows, dust drifts and glints, a few rays shimmer.
//   3. The staff takes the light, and the voices are lit one after another, lowest first.
// A tap stirs the dust.

import { colorForPart } from './palette';
import { withAlpha } from './theme';
import type { TitleName } from './lightName';

const IGNITE_AFTER_SEC = 1.5; // in the dark, "Score" alone
const LINES_SEC = [0.35, 1.6]; // after the light: the staff brightening, from/to
const NOTES_AFTER_SEC = 0.9; // after the light: the first voice lit...
const NOTE_STEP_SEC = 0.17; // ...then each next one
const NOTE_FADE_SEC = 0.55;
const VOICES = 5;
const DUST = 150;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/** The spotlight's strength u seconds after it is switched on: a lamp's flicker, then steady. */
function lampLevel(u: number): number {
  if (u < 0) return 0;
  const steps: [number, number][] = [
    [0, 0],
    [0.05, 0.55],
    [0.11, 0.12],
    [0.17, 0.7],
    [0.23, 0.35],
    [0.3, 0.82],
    [0.9, 1],
  ];
  for (let i = 1; i < steps.length; i++) {
    const [t1, v1] = steps[i];
    const [t0, v0] = steps[i - 1];
    if (u <= t1) return v0 + (v1 - v0) * smooth((u - t0) / (t1 - t0));
  }
  // Steady, with the faint unrest of a real lamp.
  return 0.97 + 0.03 * Math.sin(u * 2.1) * Math.sin(u * 0.73);
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
  glint: boolean; // a larger one that catches the light now and then
}

interface Scene {
  w: number;
  h: number;
  src: { x: number; y: number }; // the lamp, off the upper left
  axis: number; // the cone's direction (rad)
  half: number; // its half angle
  reach: number; // px from the lamp to where it has faded
  pool: { x: number; y: number; rx: number; ry: number }; // where it falls: on "Light"
  rays: { phase: number; speed: number }[]; // the two ray layers' shimmer
  lineY: (k: number, x: number) => number; // line k (0 = top) at x
  x0: number;
  x1: number;
  space: number;
  notes: { k: number; from: number; to: number; color: string; lit: Sprite }[];
}

/** A pre-rendered image and where it goes (css px). */
interface Sprite {
  img: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A canvas for `w` x `h` css px at `dpr`, its context scaled to css px. */
function offscreen(w: number, h: number, dpr: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const x = c.getContext('2d')!;
  x.scale(dpr, dpr);
  return [c, x] as const;
}

/** A soft warm point of light, drawn once and scaled for every mote of dust. */
function moteSprite(): HTMLCanvasElement {
  const [c, x] = offscreen(32, 32, 1);
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,246,228,1)');
  g.addColorStop(0.4, 'rgba(255,222,170,0.35)');
  g.addColorStop(1, 'rgba(255,222,170,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 32, 32);
  return c;
}

export function animateStage(canvas: HTMLCanvasElement, name: TitleName): () => void {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d')!;
  // The light itself -- the cone, the paper's grain in it, and the rays (two layers, shimmering in
  // turn) -- is drawn once into layers under the scene and only faded in and out (style.css,
  // .stage-layer): repainting it full-screen every frame would be far too slow.
  const layer = () => {
    const c = document.createElement('canvas');
    c.className = 'stage-layer';
    c.setAttribute('aria-hidden', 'true');
    canvas.parentElement?.insertBefore(c, canvas);
    return c;
  };
  const lightLayer = layer();
  const rayLayers = [layer(), layer()];
  const staffDark = layer();
  const staffLit = layer();
  const noteLayers = Array.from({ length: VOICES }, layer);
  staffDark.style.opacity = '1';
  const shown = new Map<HTMLCanvasElement, number>();
  const fade = (c: HTMLCanvasElement, v: number) => {
    const o = Math.round(clamp01(v) * 200) / 200;
    if (shown.get(c) === o) return;
    shown.set(c, o);
    c.style.opacity = String(o);
  };
  const dot = moteSprite();
  let start = Infinity; // "Score" up
  let ignited = false;
  let scene: Scene | null = null;
  let motes: Mote[] = [];
  let raf = 0;
  let last = 0;

  const coneAt = (s: Scene, x: number, y: number) => {
    // How much of the light reaches (x, y): inside the cone, fading toward its edges and its end.
    const dx = x - s.src.x;
    const dy = y - s.src.y;
    const d = Math.hypot(dx, dy);
    let a = Math.atan2(dy, dx) - s.axis;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    const across = 1 - smooth(Math.abs(a) / s.half);
    const along = 1 - smooth((d - s.reach * 0.55) / (s.reach * 0.45));
    return across * along;
  };

  const spawn = (s: Scene, anywhere: boolean): Mote => {
    // A point in the cone, more of them near the name than near the lamp.
    const d = s.reach * (anywhere ? 0.15 + 0.8 * Math.sqrt(Math.random()) : 0.3 + 0.6 * Math.random());
    const a = s.axis + (Math.random() * 2 - 1) * s.half * 0.95;
    const big = Math.random() < 0.12;
    return {
      x: s.src.x + Math.cos(a) * d,
      y: s.src.y + Math.sin(a) * d,
      vx: (Math.random() - 0.5) * 6,
      vy: (Math.random() - 0.35) * 5,
      r: big ? 1.3 + Math.random() * 1.1 : 0.45 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
      glint: big,
    };
  };

  const build = (): Scene | null => {
    const g = name.geometry();
    if (!g) return null;
    const r = canvas.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    if (!w || !h) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const narrow = w < 700;
    const space = (g.baseline - g.capTop) / 4;
    const top = g.capTop - r.top;
    const lightMid = (g.left + g.lightRight) / 2 - r.left;
    const nameMid = top + space * 2;

    // The lamp: above and left of the screen, aimed at "Light".
    const src = { x: -w * (narrow ? 0.18 : 0.06), y: -h * 0.22 };
    const aim = { x: lightMid, y: nameMid + space };
    const axis = Math.atan2(aim.y - src.y, aim.x - src.x);
    const reach = Math.hypot(aim.x - src.x, aim.y - src.y) * 1.35;
    const half = narrow ? 0.2 : 0.17;
    const pool = { x: aim.x, y: aim.y, rx: Math.max(space * 9, (g.lightRight - g.left) * 0.75), ry: space * 5.5 };

    const off = () => offscreen(w, h, dpr);

    // The cone: light fading along its way (radial), and softly across it (conic) -- two smooth
    // passes; many faint layers would round off differently in each colour channel and tint it.
    const [cone, cx] = off();
    const along = cx.createRadialGradient(src.x, src.y, 0, src.x, src.y, reach);
    along.addColorStop(0, 'rgba(255,236,200,0.55)');
    along.addColorStop(0.3, 'rgba(255,214,150,0.3)');
    along.addColorStop(0.65, 'rgba(250,196,120,0.16)');
    along.addColorStop(1, 'rgba(255,200,140,0)');
    cx.fillStyle = along;
    cx.fillRect(0, 0, w, h);
    const edge = half * 1.25;
    const turn = (edge * 2) / (Math.PI * 2);
    const across = cx.createConicGradient(axis - edge, src.x, src.y);
    for (const [at, a] of [
      [0, 0],
      [0.12, 0.05],
      [0.3, 0.45],
      [0.42, 0.9],
      [0.5, 1],
      [0.58, 0.9],
      [0.7, 0.45],
      [0.88, 0.05],
      [1, 0],
    ]) across.addColorStop(at * turn, `rgba(0,0,0,${a})`);
    across.addColorStop(Math.min(1, turn + 0.001), 'rgba(0,0,0,0)');
    across.addColorStop(1, 'rgba(0,0,0,0)');
    cx.globalCompositeOperation = 'destination-in';
    cx.fillStyle = across;
    cx.fillRect(0, 0, w, h);
    cx.globalCompositeOperation = 'source-over';
    // Where it falls on the paper: a pool of warm light around "Light".
    cx.save();
    cx.translate(pool.x, pool.y);
    cx.scale(1, pool.ry / pool.rx);
    const pg = cx.createRadialGradient(0, 0, 0, 0, 0, pool.rx);
    pg.addColorStop(0, 'rgba(255,214,160,0.12)');
    pg.addColorStop(0.5, 'rgba(255,200,140,0.05)');
    pg.addColorStop(1, 'rgba(255,200,140,0)');
    cx.fillStyle = pg;
    cx.fillRect(-pool.rx, -pool.rx, pool.rx * 2, pool.rx * 2);
    cx.restore();
    // The haze at the lamp itself.
    const haze = cx.createRadialGradient(src.x, src.y, 0, src.x, src.y, reach * 0.4);
    haze.addColorStop(0, 'rgba(255,240,214,0.35)');
    haze.addColorStop(1, 'rgba(255,220,170,0)');
    cx.fillStyle = haze;
    cx.fillRect(0, 0, w, h);

    // The paper's grain -- fibres and specks -- showing only where the light falls.
    const [grain, gx] = off();
    const rnd = mulberry(7);
    gx.lineCap = 'round';
    for (let i = 0; i < (w * h) / 900; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const l = 6 + rnd() * 26;
      const tilt = (rnd() - 0.5) * 0.5;
      gx.strokeStyle = `rgba(255,232,200,${0.05 + rnd() * 0.09})`;
      gx.lineWidth = 0.4 + rnd() * 0.7;
      gx.beginPath();
      gx.moveTo(x, y);
      gx.quadraticCurveTo(x + l / 2, y + tilt * 6 + (rnd() - 0.5) * 3, x + l, y + tilt * l * 0.3);
      gx.stroke();
    }
    for (let i = 0; i < (w * h) / 2600; i++) {
      gx.fillStyle = `rgba(255,236,210,${0.04 + rnd() * 0.1})`;
      gx.beginPath();
      gx.arc(rnd() * w, rnd() * h, 0.4 + rnd() * 0.6, 0, Math.PI * 2);
      gx.fill();
    }
    gx.globalCompositeOperation = 'destination-in';
    gx.setTransform(1, 0, 0, 1, 0, 0);
    gx.drawImage(cone, 0, 0);
    gx.drawImage(cone, 0, 0); // twice: the mask a little stronger
    gx.drawImage(cone, 0, 0);

    // Into the light layer: the cone and the grain it shows.
    const lc = sized(lightLayer, w, h, dpr);
    lc.drawImage(cone, 0, 0, w, h);
    lc.globalCompositeOperation = 'lighter';
    lc.drawImage(grain, 0, 0, w, h);
    // The rays: thin brighter streaks in the cone, every other one on the second layer.
    const rc = rayLayers.map((c) => sized(c, w, h, dpr));
    for (let i = 0; i < 8; i++) {
      const angle = axis + (((i + 0.5) / 8) * 2 - 1) * half * 0.8 + (rnd() - 0.5) * 0.02;
      const width = 0.004 + rnd() * 0.01;
      const x = rc[i % 2];
      const grad = x.createRadialGradient(src.x, src.y, 0, src.x, src.y, reach * 0.95);
      grad.addColorStop(0, 'rgba(255,244,222,0.1)');
      grad.addColorStop(0.6, 'rgba(255,226,180,0.05)');
      grad.addColorStop(1, 'rgba(255,220,170,0)');
      x.fillStyle = grad;
      x.beginPath();
      x.moveTo(src.x, src.y);
      x.arc(src.x, src.y, reach, angle - width, angle + width);
      x.closePath();
      x.fill();
    }
    const rays = rayLayers.map(() => ({ phase: rnd() * Math.PI * 2, speed: 0.4 + rnd() * 0.4 }));

    // The staff: in from the left through the name, then sweeping up to the right and opening out.
    const x0 = narrow ? -10 : w * 0.02;
    const x1 = w + 20;
    const bend = narrow ? g.scoreLeft - r.left : g.right - r.left - space * 2;
    const rise = Math.max(space * 6, top - h * (narrow ? 0.1 : 0.12));
    const lineY = (k: number, x: number) => {
      const u = clamp01((x - bend) / (x1 - bend));
      const lift = rise * Math.pow(u, 1.55);
      return top + 2 * space - lift + (k - 2) * space * (1 + 0.85 * u);
    };
    // The voices on the rising lines, lowest first from the left, the top voice furthest right.
    const notes: Scene['notes'] = [];
    const span = x1 - 20 - bend;
    for (let k = 0; k < VOICES; k++) {
      const from = bend + span * (0.3 + 0.075 * (VOICES - 1 - k) + (narrow ? 0.2 : 0));
      const to = from + span * (narrow ? 0.18 : 0.21);
      const end = Math.min(to, x1 - 30);
      notes.push({ k, from, to: end, color: colorForPart(k, VOICES), lit: litNote(from, end, (x) => lineY(k - 0.5, x), space * 0.62, colorForPart(k, VOICES), dpr) });
    }

    // The staff, dark and lit: barely there in the dark; lit warm where the light falls, faintly elsewhere.
    for (const [c, level] of [
      [staffDark, 0],
      [staffLit, 1],
    ] as const) {
      const x = sized(c, w, h, dpr);
      x.lineCap = 'round';
      const grad = x.createLinearGradient(x0, 0, x1, 0);
      const at = (v: number) => clamp01((v - x0) / (x1 - x0));
      const lit = (k: number) => `rgba(239,228,210,${(0.07 + level * k).toFixed(3)})`;
      grad.addColorStop(0, 'rgba(239,228,210,0)');
      grad.addColorStop(at(x0 + 40), lit(0.12));
      grad.addColorStop(at(pool.x - pool.rx), lit(0.18));
      grad.addColorStop(at(pool.x), lit(0.34));
      grad.addColorStop(at(pool.x + pool.rx * 1.2), lit(0.2));
      grad.addColorStop(1, lit(0.14));
      x.strokeStyle = grad;
      x.lineWidth = 1.1;
      for (let k = 0; k < VOICES; k++) {
        x.beginPath();
        x.moveTo(x0, lineY(k, x0));
        for (let v = x0 + 8; v < x1; v += 8) x.lineTo(v, lineY(k, v));
        x.lineTo(x1, lineY(k, x1));
        x.stroke();
      }
      // The voices' notes as unlit slots, a little clearer on the lit staff.
      x.lineWidth = space * 0.62;
      for (const n of notes) {
        x.strokeStyle = withAlpha(n.color, 0.07 + 0.08 * level);
        x.beginPath();
        x.moveTo(n.from, lineY(n.k - 0.5, n.from));
        x.lineTo(n.to, lineY(n.k - 0.5, n.to));
        x.stroke();
      }
    }
    // Each voice's lit note: its own small layer, placed over its slot.
    notes.forEach((n, k) => {
      const c = noteLayers[k];
      c.width = n.lit.img.width;
      c.height = n.lit.img.height;
      c.getContext('2d')!.drawImage(n.lit.img, 0, 0);
      c.style.inset = 'auto'; // (before left/top: the shorthand would reset them)
      Object.assign(c.style, { left: `${n.lit.x}px`, top: `${n.lit.y}px`, width: `${n.lit.w}px`, height: `${n.lit.h}px` });
    });

    const s: Scene = { w, h, src, axis, half, reach, pool, rays, lineY, x0, x1, space, notes };
    motes = Array.from({ length: narrow ? Math.round(DUST * 0.6) : DUST }, () => spawn(s, true));
    return s;
  };

  void name.shown.then(() => {
    start = performance.now() / 1000;
    if (still) {
      ignited = true;
      name.ignite();
    }
  });

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, form') || !scene) return;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    for (const m of motes) {
      const d = Math.hypot(m.x - px, m.y - py);
      if (d > 180 || d < 1) continue;
      const k = (1 - d / 180) * 60;
      m.vx += ((m.x - px) / d) * k;
      m.vy += ((m.y - py) / d) * k;
    }
  };
  canvas.parentElement?.addEventListener('pointerdown', onDown);

  const draw = (nowMs: number) => {
    raf = still ? 0 : requestAnimationFrame(draw);
    const now = nowMs / 1000;
    const dt = Math.min(0.05, last ? now - last : 0);
    last = now;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      scene = null;
    }
    scene ??= build();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!scene || now < start) return;
    const s = scene;
    const t = now - start;
    const u = still ? 99 : t - IGNITE_AFTER_SEC; // since the light came on
    if (!ignited && u >= 0) {
      ignited = true;
      name.ignite();
    }
    const lamp = still ? 1 : lampLevel(u);

    fade(lightLayer, lamp);
    s.rays.forEach((ray, i) => {
      const shimmer = 0.5 + 0.5 * Math.sin(now * ray.speed + ray.phase);
      fade(rayLayers[i], lamp * (still ? 0.6 : shimmer));
    });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The staff and the voices (drawn once, see build()): the lit staff fades in over the dark
    // one, the voices' notes one after another, lowest first.
    fade(staffLit, still ? 1 : smooth((u - LINES_SEC[0]) / (LINES_SEC[1] - LINES_SEC[0])));
    noteLayers.forEach((c, k) => {
      const order = VOICES - 1 - k;
      fade(c, still ? 1 : smooth((u - NOTES_AFTER_SEC - order * NOTE_STEP_SEC) / NOTE_FADE_SEC));
    });

    // Dust in the light: drifting, glinting now and then; seen only where the light is.
    if (lamp > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < motes.length; i++) {
        const m = motes[i];
        if (!still) {
          m.vx += (Math.random() - 0.5) * 9 * dt;
          m.vy += (Math.random() - 0.5) * 9 * dt + 0.6 * dt; // settling, slowly
          m.vx *= 1 - 0.9 * dt;
          m.vy *= 1 - 0.9 * dt;
          m.x += m.vx * dt;
          m.y += m.vy * dt;
        }
        const inLight = coneAt(s, m.x, m.y);
        if (inLight < 0.02 && !still) {
          motes[i] = spawn(s, false);
          continue;
        }
        const tw = 0.55 + 0.45 * Math.sin(now * (m.glint ? 1.7 : 0.9) + m.phase);
        let a = lamp * inLight * tw * (m.glint ? 0.9 : 0.6);
        if (a < 0.01) continue;
        const rr = m.r;
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(dot, m.x - rr * 3, m.y - rr * 3, rr * 6, rr * 6);
        ctx.globalAlpha = 1;
        // A glint: a short cross of light at its brightest.
        if (m.glint && tw > 0.93) {
          a *= (tw - 0.93) / 0.07;
          ctx.strokeStyle = `rgba(255,248,232,${a * 0.8})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(m.x - rr * 5, m.y);
          ctx.lineTo(m.x + rr * 5, m.y);
          ctx.moveTo(m.x, m.y - rr * 5);
          ctx.lineTo(m.x, m.y + rr * 5);
          ctx.stroke();
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  };
  raf = requestAnimationFrame(draw);

  const onResize = () => {
    scene = null;
    if (still) requestAnimationFrame(draw);
  };
  window.addEventListener('resize', onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    canvas.parentElement?.removeEventListener('pointerdown', onDown);
    for (const c of [lightLayer, ...rayLayers, staffDark, staffLit, ...noteLayers]) c.remove();
  };
}

/** Sizes a layer canvas to the scene and returns its context in css px, cleared. */
function sized(c: HTMLCanvasElement, w: number, h: number, dpr: number): CanvasRenderingContext2D {
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const x = c.getContext('2d')!;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return x;
}

/** A voice's note lit: a bar of its colour along the rising line, glowing, with a bright core. */
function litNote(from: number, to: number, y: (x: number) => number, thick: number, color: string, dpr: number): Sprite {
  const pad = thick * 2.6;
  const left = from - pad;
  const top = Math.min(y(from), y(to)) - pad;
  const w = to - from + pad * 2;
  const h = Math.abs(y(to) - y(from)) + pad * 2;
  const [img, x] = offscreen(w, h, dpr);
  x.translate(-left, -top);
  x.lineCap = 'round';
  x.lineWidth = thick;
  x.shadowColor = withAlpha(color, 0.75);
  x.shadowBlur = thick * 1.6 * dpr;
  x.strokeStyle = withAlpha(color, 0.85);
  x.beginPath();
  x.moveTo(from, y(from));
  x.lineTo(to, y(to));
  x.stroke();
  x.shadowBlur = 0;
  x.lineWidth = thick * 0.28;
  x.strokeStyle = 'rgba(255,250,240,0.55)';
  x.beginPath();
  x.moveTo(from + thick * 0.3, y(from + thick * 0.3) - thick * 0.08);
  x.lineTo(to - thick * 0.3, y(to - thick * 0.3) - thick * 0.08);
  x.stroke();
  return { img, x: left, y: top, w, h };
}

/** A small seeded random generator: the same grain every time. */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
