import { describe, expect, it } from 'vitest';
import { getBeatMarkers, measureAtBeat, type Score } from './score';

function scoreWithMeasures(measures: Score['measures'], totalBeats: number): Score {
  return { title: 't', parts: [], notes: [], measures, slurs: [], ties: [], totalBeats };
}

describe('getBeatMarkers', () => {
  it('emits one pulse per time-signature beat with downbeats first', () => {
    const score = scoreWithMeasures(
      [
        { number: 1, startBeat: 0, beats: 3, beatType: 4 },
        { number: 2, startBeat: 3, beats: 6, beatType: 8 },
      ],
      6,
    );
    const markers = getBeatMarkers(score);
    expect(markers).toHaveLength(3 + 6);
    expect(markers[0]).toEqual({ beat: 0, isDownbeat: true, measureNumber: 1 });
    expect(markers[3]).toEqual({ beat: 3, isDownbeat: true, measureNumber: 2 });
    // 6/8 pulses are eighth notes: half a quarter-note beat apart
    expect(markers[4].beat).toBeCloseTo(3.5);
    expect(markers.filter((m) => m.isDownbeat)).toHaveLength(2);
  });
});

describe('measureAtBeat', () => {
  const score = scoreWithMeasures(
    [
      { number: 1, startBeat: 0, beats: 4, beatType: 4 },
      { number: 2, startBeat: 4, beats: 4, beatType: 4 },
      { number: 3, startBeat: 8, beats: 4, beatType: 4 },
    ],
    12,
  );

  it('finds the measure containing a beat', () => {
    expect(measureAtBeat(score, 0)?.number).toBe(1);
    expect(measureAtBeat(score, 3.99)?.number).toBe(1);
    expect(measureAtBeat(score, 4)?.number).toBe(2);
    expect(measureAtBeat(score, 11)?.number).toBe(3);
  });

  it('clamps past-the-end beats to the last measure and rejects negative beats', () => {
    expect(measureAtBeat(score, 100)?.number).toBe(3);
    expect(measureAtBeat(score, -1)).toBeUndefined();
  });

  it('returns undefined for an empty score', () => {
    expect(measureAtBeat(scoreWithMeasures([], 0), 0)).toBeUndefined();
  });
});
