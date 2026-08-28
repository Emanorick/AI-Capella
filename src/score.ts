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
  // Original notated pitch spelling (e.g. F# vs Gb), when known -- MusicXML imports carry this
  // straight from the source file's <pitch>; `midi` alone can't distinguish enharmonic spellings.
  // Absent for MIDI imports, which have no spelling in the source to preserve (see staffView.ts's
  // fallback for that case). Only consumed by the sheet-music view -- playback and the piano roll
  // use `midi` alone, as before.
  step?: string;
  alter?: number;
  octave?: number;
  // The individual duration (in beats) of each originally tied-together <note> write, in order,
  // summing exactly to durationBeats -- MusicXML can't represent a note crossing a measure
  // boundary without a tie, so a source file's own tie-note boundaries are meaningful notated
  // information (which specific notes/rhythms the engraver actually chose), not recoverable from
  // durationBeats alone once merged (see Score's doc comment below). Absent for MIDI imports (no
  // tie concept in the source) and for any note that was never part of a tie chain. Only
  // consumed by the sheet-music view, as the preferred alternative to mathematically re-deriving
  // a split -- playback and the piano roll use durationBeats alone, as before.
  tieSegments?: number[];
}

export interface MeasureInfo {
  number: number;
  startBeat: number; // quarter-note beats
  beats: number; // time signature numerator
  beatType: number; // time signature denominator
  fifths: number; // key signature, circle-of-fifths count: positive = sharps, negative = flats
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
  // A tied MusicXML note (split across a measure boundary, since a note can't itself cross one in
  // the file format) is always merged into a single NoteEvent at parse time, so it plays back --
  // and the piano roll renders it -- as the one continuous note it really is. The original
  // tie-note boundaries aren't discarded, though: they're optionally preserved on the NoteEvent
  // itself (see its tieSegments field) for the sheet-music view to notate faithfully.
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
