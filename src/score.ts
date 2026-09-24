export interface PartInfo {
  id: string;
  name: string;
  // The clef actually notated in the source (MusicXML <clef>: <sign>/<line>/<clef-octave-change>),
  // when known -- absent for MIDI imports and any MusicXML file that omits it, in which case
  // staffView.ts falls back to a heuristic guess from the part's average pitch. octaveChange is
  // most commonly -1 for the real-engraving "treble clef, sounds an octave lower than written"
  // convention choir tenor parts use (a small "8" printed below a treble clef) -- without it, a
  // tenor part heuristically assigned (or even correctly assigned) a treble clef would still be
  // positioned on the staff as if it sounded where it's written, hanging on many ledger lines
  // below the staff instead of sitting where a real tenor clef actually places it.
  clef?: { sign: string; line?: number; octaveChange?: number };
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
  mode?: 'major' | 'minor'; // from <key><mode>, when the file states it (only used to name the key in the library)
}

export interface SlurArc {
  partId: string;
  startBeat: number;
  startMidi: number;
  endBeat: number;
  endMidi: number;
}

export interface RehearsalMark {
  label: string;
  beat: number;
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
  // Rehearsal marks (<direction><direction-type><rehearsal>) actually printed in the source, e.g.
  // "A"/"B"/"C" letters or measure-range labels -- sorted by beat. Only ever populated from
  // MusicXML (recorded once, from whichever part is processed first, since these are a piece-level
  // structural concept rather than a per-part one); always empty for MIDI imports. When empty,
  // main.ts falls back to letting the user mark their own section boundaries instead (persisted
  // per-song via library.ts's savedConfig, not part of this parsed-from-source Score at all).
  rehearsalMarks: RehearsalMark[];
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
