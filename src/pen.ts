// Pen strokes along a polyline, for the paper design's hand-drawn lines (title animation, app mark,
// covers). Two kinds of pen:
//   broad nib:   a flat nib held at a fixed angle -- broad where the line runs across the nib, a
//                hairline where it runs along it (calligraphy, the hand of old manuscript scores);
//   pointed pen: a flexible point -- a hairline that swells where the line goes down, as the pen is
//                pressed on the downstroke (copperplate).
// `upTo` (0..1) draws only the first part of the line, for writing it out over time.

export type Pt = [number, number];

export interface BroadNib {
  w: number; // nib width in px
  angle?: number; // nib angle in degrees (35 is a common calligraphic angle)
  floor?: number; // fraction of the width kept where the line runs along the nib
  taper?: number; // fraction of the line over which the nib touches down / lifts off
  upTo?: number;
}

export interface PointedPen {
  w: number; // widest swell in px
  hair?: number; // hairline width in px
  taper?: number;
  upTo?: number;
}

function lengths(pts: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return out;
}

function taperAt(u: number, taper: number): number {
  const e = Math.min(1, u / taper, (1 - u) / taper);
  return e * (2 - e);
}

/** Adds a broad-nib stroke along `pts` to `path` (fill it with 'nonzero'). */
export function broadNib(path: Path2D, pts: Pt[], o: BroadNib) {
  if (pts.length < 2) return;
  const len = lengths(pts);
  const total = len[len.length - 1] || 1;
  const upTo = (o.upTo ?? 1) * total;
  const a = ((o.angle ?? 35) * Math.PI) / 180;
  const nx = Math.cos(a);
  const ny = -Math.sin(a);
  const floor = o.floor ?? 0.18;
  const taper = o.taper ?? 0.08;
  for (let i = 0; i + 1 < pts.length && len[i + 1] <= upTo + 0.01; i++) {
    const h0 = (o.w / 2) * (floor + (1 - floor) * taperAt(len[i] / total, taper));
    const h1 = (o.w / 2) * (floor + (1 - floor) * taperAt(len[i + 1] / total, taper));
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    let q: Pt[] = [
      [x0 + nx * h0, y0 + ny * h0],
      [x1 + nx * h1, y1 + ny * h1],
      [x1 - nx * h1, y1 - ny * h1],
      [x0 - nx * h0, y0 - ny * h0],
    ];
    // Same winding for every quad, so their union fills without gaps.
    let area = 0;
    for (let j = 0; j < 4; j++) area += q[j][0] * q[(j + 1) % 4][1] - q[(j + 1) % 4][0] * q[j][1];
    if (area < 0) q = q.reverse();
    path.moveTo(q[0][0], q[0][1]);
    for (let j = 1; j < 4; j++) path.lineTo(q[j][0], q[j][1]);
    path.closePath();
  }
}

/** Adds a pointed-pen stroke along `pts` to `path`: hairline, swelling on the downstrokes. */
export function pointedPen(path: Path2D, pts: Pt[], o: PointedPen) {
  if (pts.length < 2) return;
  const len = lengths(pts);
  const total = len[len.length - 1] || 1;
  const upTo = (o.upTo ?? 1) * total;
  const hair = o.hair ?? 0.9;
  const taper = o.taper ?? 0.1;
  const left: Pt[] = [];
  const right: Pt[] = [];
  let shade = 0;
  for (let i = 0; i < pts.length && len[i] <= upTo + 0.01; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    // Pressure builds and eases off smoothly, as a hand's does.
    const target = Math.min(1, Math.max(0, dy) * 3.4 + 0.08);
    shade += (target - shade) * 0.25;
    const w = hair / 2 + ((o.w - hair) / 2) * shade * taperAt(len[i] / total, taper);
    left.push([pts[i][0] - dy * w, pts[i][1] + dx * w]);
    right.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
  }
  if (left.length < 2) return;
  path.moveTo(left[0][0], left[0][1]);
  for (const [x, y] of left) path.lineTo(x, y);
  for (let i = right.length - 1; i >= 0; i--) path.lineTo(right[i][0], right[i][1]);
  path.closePath();
}

/** The point `upTo` (0..1) of the way along `pts` -- where the pen is while writing. */
export function pointAlong(pts: Pt[], upTo: number): Pt {
  const len = lengths(pts);
  const at = upTo * len[len.length - 1];
  for (let i = 1; i < pts.length; i++) {
    if (len[i] >= at) {
      const k = (at - len[i - 1]) / Math.max(1e-6, len[i] - len[i - 1]);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
    }
  }
  return pts[pts.length - 1];
}
