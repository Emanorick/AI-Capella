export interface PartInfo {
  id: string;
  name: string;
}

export interface NoteEvent {
  partId: string;
  midi: number;
  startBeat: number; // in quarter-note beats from the start of the piece
  durationBeats: number;
  lyric?: string;
  measureNumber: number;
}

export interface MeasureInfo {
  number: number;
  startBeat: number; // quarter-note beats
  beats: number; // time signature numerator
  beatType: number; // time signature denominator
}

export interface SlurArc {
  partId: string;
  startBeat: number;
  startMidi: number;
  endBeat: number;
  endMidi: number;
}

export interface Score {
  title: string;
  parts: PartInfo[];
  notes: NoteEvent[];
  measures: MeasureInfo[];
  slurs: SlurArc[];
  totalBeats: number;
}

export interface BeatMarker {
  beat: number;
  isDownbeat: boolean;
  measureNumber: number;
}

/** One pulse per time-signature beat (a quarter note when beatType=4, an eighth when beatType=8, etc). */
export function getBeatMarkers(score: Score): BeatMarker[] {
  const markers: BeatMarker[] = [];
  for (const m of score.measures) {
    const pulseBeats = 4 / m.beatType;
    for (let i = 0; i < m.beats; i++) {
      markers.push({
        beat: m.startBeat + i * pulseBeats,
        isDownbeat: i === 0,
        measureNumber: m.number,
      });
    }
  }
  return markers;
}

export function measureAtBeat(score: Score, beat: number): MeasureInfo | undefined {
  let current: MeasureInfo | undefined;
  for (const m of score.measures) {
    if (m.startBeat <= beat) current = m;
    else break;
  }
  return current;
}
