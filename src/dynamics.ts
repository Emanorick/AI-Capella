import type { Score } from './score';

// Playback loudness follows the printed dynamics, gently: a gain relative to mf, about 4 dB down
// at pp and 2 dB up at ff -- audible as shape, never enough to lose a voice in the mix.
const LEVELS: Record<string, number> = {
  ppp: 0.5, pp: 0.6, p: 0.75, mp: 0.88, mf: 1, f: 1.12, ff: 1.24, fff: 1.34,
  sfp: 0.75, fp: 0.75, rfz: 1.12, sf: 1.12, sfz: 1.12, fz: 1.12, sffz: 1.24,
};
const MIN_LEVEL = 0.45;
const MAX_LEVEL = 1.36;
// A hairpin that doesn't end on a printed dynamic swells or fades by this much.
const CRESC_STEP = 1.2;
const DIM_STEP = 0.83;

type Point = { beat: number; level: number; ramp?: boolean }; // ramp: reached gradually from the point before

/** A per-part loudness curve read from the score's dynamics and hairpins: level(partId, beat)
 *  gives the gain (1 = mf) a note starting at that beat plays at. Accents (sf, fz...) set the
 *  level for what follows like a plain f; a part without any dynamics of its own follows the
 *  ones printed in other parts (some arrangements mark them once, over the top staff). */
export function dynamicLevels(score: Score): (partId: string, beat: number) => number {
  const marks = (score.marks ?? []).filter((m) => m.kind === 'dynamic' || m.kind === 'wedge');
  const curves = new Map<string, Point[]>();
  const build = (own: typeof marks): Point[] => {
    const steps = own.filter((m) => m.kind === 'dynamic' && LEVELS[m.text.toLowerCase()] !== undefined)
      .map((m) => ({ beat: m.beat, level: LEVELS[m.text.toLowerCase()] }));
    const stepAt = (beat: number) => {
      let level = 1;
      for (const s of steps) { if (s.beat <= beat + 1e-6) level = s.level; else break; }
      return level;
    };
    const points: Point[] = [];
    for (const s of steps) points.push({ beat: s.beat, level: s.level });
    for (const w of own) {
      if (w.kind !== 'wedge' || w.endBeat === undefined) continue;
      const from = stepAt(w.beat);
      // The hairpin arrives at the dynamic printed at (or just after) its end, if one is there.
      const next = steps.find((s) => s.beat >= w.endBeat! - 1e-6 && s.beat <= w.endBeat! + 1);
      const to = next ? next.level : from * (w.text === 'crescendo' ? CRESC_STEP : DIM_STEP);
      points.push({ beat: w.beat, level: from }, { beat: w.endBeat, level: to, ramp: true });
    }
    return points.sort((a, b) => a.beat - b.beat);
  };
  const byPart = new Map<string, typeof marks>();
  for (const m of marks) {
    if (!byPart.has(m.partId)) byPart.set(m.partId, []);
    byPart.get(m.partId)!.push(m);
  }
  const shared = build(marks.filter((m, i) => marks.findIndex((o) => o.kind === m.kind && o.text === m.text && Math.abs(o.beat - m.beat) < 1e-6) === i));
  for (const [id, own] of byPart) curves.set(id, build(own));
  return (partId, beat) => {
    const points = curves.get(partId) ?? shared;
    let level = 1;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.beat > beat + 1e-6) {
        const prev = points[i - 1];
        if (prev && p.ramp && p.beat > prev.beat) {
          level = prev.level + (p.level - prev.level) * ((beat - prev.beat) / (p.beat - prev.beat));
        }
        break;
      }
      level = p.level;
    }
    return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, level));
  };
}
