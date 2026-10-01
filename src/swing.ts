import type { Score } from './score';

// Swing: eighth notes written straight, played long-short -- the first of each pair takes two
// thirds of the beat, the second the last third (the triplet feel of jazz and pop arrangements).
// A per-song choice (the player's ⋯ menu); playback, the piano roll and the overview play and
// show the swung rhythm, the sheet view keeps the notation as written and lights each note when it
// sounds (StaffView.setSwing).

const LONG = 2 / 3; // where the second eighth of a beat falls
const EPS = 1e-6;

/** Where a straight-written position sounds with swing, counted in quarter beats from `origin`
 *  (the start of its bar -- a piece with an upbeat has its bars off the whole beats). */
function swingFrom(beat: number, origin: number): number {
  const local = beat - origin;
  const whole = Math.floor(local + EPS);
  const f = local - whole;
  if (f < EPS) return origin + whole;
  // Triplets already have the swing's grid: they stay where they are.
  if (Math.abs(f - 1 / 3) < 1e-4 || Math.abs(f - 2 / 3) < 1e-4) return beat;
  return origin + whole + (f <= 0.5 ? f * 2 * LONG : LONG + (f - 0.5) * 2 * (1 - LONG));
}

/** The swing mapping for a score: a written beat -> where it sounds. */
export function swingMap(score: Score): (beat: number) => number {
  const starts = score.measures.map((m) => m.startBeat);
  // Each bar's beats counted from its start -- but a bar of a fraction of beats (an upbeat) from its
  // end, where its beats really lie: an upbeat eighth is the "and" of the bar before.
  const origins = starts.map((start, i) => {
    const end = starts[i + 1] ?? score.totalBeats;
    const len = end - start;
    return Math.abs(len - Math.round(len)) < EPS ? start : end - Math.ceil(len);
  });
  return (beat) => {
    // The bar the position is in (the last one starting at or before it).
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= beat + EPS) lo = mid;
      else hi = mid - 1;
    }
    return swingFrom(beat, starts.length ? origins[lo] : 0);
  };
}

/** Swing only makes sense where the beat is a quarter (or half) note -- not in 6/8, 12/8 or 3/8. */
export function canSwing(score: Score): boolean {
  return score.measures.length > 0 && score.measures.every((m) => m.beatType === 4 || m.beatType === 2);
}

/** The score as it sounds with swing: every note's start and end moved onto the swung grid. */
export function swingScore(score: Score): Score {
  const swingBeat = swingMap(score);
  return {
    ...score,
    notes: score.notes.map((n) => {
      const start = swingBeat(n.startBeat);
      const end = swingBeat(n.startBeat + n.durationBeats);
      return { ...n, startBeat: start, durationBeats: Math.max(end - start, 1e-3) };
    }),
    slurs: score.slurs.map((s) => ({ ...s, startBeat: swingBeat(s.startBeat), endBeat: swingBeat(s.endBeat) })),
  };
}
