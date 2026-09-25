import { VOICE_SPECTRUM } from './palette';

// The velvet ground behind the whole app: layered waves in close shades of the ink colour, drifting
// slowly, with a faint rim of voice colour along each crest -- felt more than seen. Drawn at half
// resolution (it's soft anyway) and at most 30 times a second; it stands still in a background tab,
// when the system asks for reduced motion, and on phones while music plays (battery). On a laptop
// it only slows down while playing.
const TONES = ['#110d1b', '#141020', '#181326', '#1c162d', '#211934', '#261c3a'];
const FRAME_MS = 1000 / 30;
const SCALE = 0.5;

export class WaveBackdrop {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private t = 0;
  private last = 0;
  private raf: number | null = null;
  private playing = false;
  private readonly reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly narrow = window.matchMedia('(max-width: 899px)');

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'bg-waves';
    this.canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    window.addEventListener('resize', () => this.draw());
    document.addEventListener('visibilitychange', () => this.update());
    this.reduceMotion.addEventListener('change', () => this.update());
    this.narrow.addEventListener('change', () => this.update());
    this.draw();
    this.update();
  }

  /** Playback started or stopped (see the class comment for what that changes). */
  setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    this.update();
  }

  private speed(): number {
    if (this.playing) return this.narrow.matches ? 0 : 0.25;
    return 1;
  }

  private update() {
    const moving = !document.hidden && !this.reduceMotion.matches && this.speed() > 0;
    if (moving && this.raf == null) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((now) => this.frame(now));
    } else if (!moving && this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  private frame(now: number) {
    this.raf = requestAnimationFrame((n) => this.frame(n));
    const elapsed = now - this.last;
    if (elapsed < FRAME_MS) return;
    this.last = now;
    this.t += (Math.min(elapsed, 100) / 1000) * this.speed();
    this.draw();
  }

  private draw() {
    const w = Math.max(1, Math.round(window.innerWidth * SCALE));
    const h = Math.max(1, Math.round(window.innerHeight * SCALE));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;
    const ground = ctx.createLinearGradient(0, 0, 0, h);
    ground.addColorStop(0, '#0c0a14');
    ground.addColorStop(1, '#120e1c');
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, w, h);
    const t = this.t;
    const step = Math.max(6, Math.round(w / 90));
    for (let i = 0; i < TONES.length; i++) {
      const base = h * (0.3 + i * 0.11);
      const amp = h * (0.035 + i * 0.008);
      // Wave lengths as in the design draft; a narrow screen gets somewhat shorter waves so a few
      // crests still show across it.
      const widthFactor = Math.sqrt(680 / w);
      const k1 = (0.006 - i * 0.0004) * widthFactor;
      const k2 = (0.013 + i * 0.001) * widthFactor;
      ctx.beginPath();
      ctx.moveTo(0, h);
      let y0 = 0;
      for (let x = 0; x <= w + step; x += step) {
        const y = base + Math.sin(x * k1 + t * (0.16 + i * 0.03) + i * 1.3) * amp + Math.sin(x * k2 - t * (0.1 + i * 0.02) + i * 0.7) * amp * 0.45;
        if (x === 0) y0 = y;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = TONES[i];
      ctx.fill();
      // The crest's rim of light: the same curve, stroked thin in a voice colour.
      ctx.beginPath();
      ctx.moveTo(0, y0);
      for (let x = step; x <= w + step; x += step) {
        ctx.lineTo(x, base + Math.sin(x * k1 + t * (0.16 + i * 0.03) + i * 1.3) * amp + Math.sin(x * k2 - t * (0.1 + i * 0.02) + i * 0.7) * amp * 0.45);
      }
      ctx.strokeStyle = VOICE_SPECTRUM[(i * 3) % VOICE_SPECTRUM.length] + '14';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
