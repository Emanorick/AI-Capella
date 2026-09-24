import type { MeasureInfo, NoteEvent, PartInfo, RehearsalMark, Score, SlurArc } from './score';

const STEP_SEMITONES: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

function pitchToMidi(step: string, alter: number, octave: number): number {
  return (octave + 1) * 12 + (STEP_SEMITONES[step] ?? 0) + alter;
}

// MusicXML's <type> values, in beats (a quarter note is 1 beat) -- used only as a fallback when
// <duration> is missing/zero (see the 'note' case below), independent of <divisions>.
const TYPE_BEATS: Record<string, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
};

// A grace note has no real duration of its own (see the 'note' case's isGrace handling) -- this
// is purely a nominal, short audible/visible length for playback and the piano roll/staff view,
// not derived from the source file.
const GRACE_NOTE_DURATION_BEATS = 0.25;

/**
 * Parses a MusicXML partwise document into a flat Score model.
 * Supports the subset produced by typical OMR/engraving tools: multiple parts,
 * chord notes, rests, <backup>/<forward>, and mid-piece divisions/time-signature changes.
 */
export function parseMusicXML(xmlText: string): Score {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid MusicXML: ' + parseError.textContent);
  }

  const title =
    doc.querySelector('work > work-title')?.textContent?.trim() ||
    doc.querySelector('movement-title')?.textContent?.trim() ||
    'Untitled';

  const parts: PartInfo[] = Array.from(doc.querySelectorAll('part-list > score-part')).map((el) => ({
    id: el.getAttribute('id') || '',
    name: el.querySelector('part-name')?.textContent?.trim() || el.getAttribute('id') || '',
  }));

  const notes: NoteEvent[] = [];
  const measures: MeasureInfo[] = [];
  const slurs: SlurArc[] = [];
  const rehearsalMarks: RehearsalMark[] = [];
  let totalBeats = 0;
  let measuresBuilt = false;

  const partEls = Array.from(doc.querySelectorAll('score-partwise > part'));

  for (const partEl of partEls) {
    const partId = partEl.getAttribute('id') || '';
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let fifths = 0;
    let keyMode: MeasureInfo['mode'];
    let measureStartBeat = 0;
    let cursor = 0;
    let lastNoteStart = 0;
    let partClef: PartInfo['clef'];
    const openSlurs = new Map<number, { beat: number; midi: number }>();
    // A tie is MusicXML's way of representing one sustained pitch that had to be split into
    // multiple <note> elements because a note can't itself cross a measure boundary in the file
    // format -- musically (and for playback/rendering purposes) it's one continuous note, so tied
    // notes are merged into a single NoteEvent here rather than kept as separate ones bridged by a
    // visual line: this map holds, per currently-open pitch, the actual NoteEvent object already
    // pushed to `notes` that a subsequent tied note should extend instead of duplicating. A tie
    // chain (a note held across more than one boundary) keeps extending the same object.
    const openTieNotes = new Map<number, NoteEvent>();

    const measureEls = Array.from(partEl.querySelectorAll('measure'));
    for (const measureEl of measureEls) {
      const numAttr = measureEl.getAttribute('number');
      const measureNumber = numAttr ? parseInt(numAttr, 10) : measures.length + 1;
      cursor = measureStartBeat;
      // Tracks the furthest `cursor` actually reaches while processing this measure's content
      // (across every backup/forward-interleaved voice) -- see its use below, once the measure's
      // content has all been walked, for why this replaces a fixed time-signature-derived length.
      let measureCursorMax = measureStartBeat;

      for (const child of Array.from(measureEl.children)) {
        switch (child.tagName) {
          case 'attributes': {
            const divText = child.querySelector('divisions')?.textContent;
            if (divText) divisions = parseFloat(divText) || 1;
            const fifthsText = child.querySelector('key > fifths')?.textContent;
            if (fifthsText) fifths = parseInt(fifthsText, 10) || 0;
            const modeText = child.querySelector('key > mode')?.textContent?.trim();
            if (modeText === 'major' || modeText === 'minor') keyMode = modeText;
            const timeEl = child.querySelector('time');
            if (timeEl) {
              const b = timeEl.querySelector('beats')?.textContent;
              const bt = timeEl.querySelector('beat-type')?.textContent;
              if (b) beats = parseInt(b, 10) || beats;
              if (bt) beatType = parseInt(bt, 10) || beatType;
            }
            // Only the first (unnumbered, or number="1") <clef> -- a part with more than one staff
            // (piano grand staff, e.g.) can have several, but this app renders one staff per part.
            const clefEl = child.querySelector(':scope > clef:not([number]), :scope > clef[number="1"]');
            const clefSign = clefEl?.querySelector('sign')?.textContent;
            if (clefSign) {
              const lineText = clefEl!.querySelector('line')?.textContent;
              const octaveChangeText = clefEl!.querySelector('clef-octave-change')?.textContent;
              partClef = {
                sign: clefSign,
                line: lineText ? parseInt(lineText, 10) : undefined,
                octaveChange: octaveChangeText ? parseInt(octaveChangeText, 10) : undefined,
              };
            }
            break;
          }
          case 'note': {
            const isChord = !!child.querySelector(':scope > chord');
            const restEl = child.querySelector(':scope > rest');
            const isRest = !!restEl;
            // A grace note (<grace/>) is spec-defined to carry no <duration> at all -- it's
            // deliberately "outside" normal measured time (an ornamental note played quickly
            // before/around the note it decorates), not a file that merely forgot to include one.
            // Confirmed concretely from a submitted score excerpt ("Jagdlied"): a grace note leads
            // into a triplet run. Must be excluded from the <type> duration fallback just below
            // (which exists for actually-missing durations, e.g. the "Nachtigall" rest bug) --
            // otherwise it gets assigned a real, nonzero duration from its <type> and that gets
            // added to `cursor`, silently displacing every later note in the part by that amount.
            const isGrace = !!child.querySelector(':scope > grace');
            const durationText = child.querySelector(':scope > duration')?.textContent;
            const durationUnits = durationText ? parseFloat(durationText) : 0;
            let durationBeats = divisions > 0 ? durationUnits / divisions : 0;

            // <duration> is technically required by the spec on every note/rest, but not every
            // real-world file is spec-perfect -- hand-edited files and this app's own OMR
            // vision-transcription spike alike can emit a <type> (the note's notated appearance:
            // "quarter", "eighth", ...) without a computed <duration>, especially for a rest with
            // nothing musically "there" to double-check a length against. Left unhandled,
            // durationBeats above comes out 0, `cursor` never advances past this note/rest, and
            // the *next* note in the part silently inherits its startBeat instead of landing after
            // it -- the concretely reported "Nachtigall" bug: a part opening with a rest had its
            // first real note land on beat 1 instead of where it actually starts. Fall back to
            // <type> (+ a dot) when that happens, same beats-per-type units `staffView.ts`'s
            // DURATION_TABLE already uses (a quarter note is 1 beat, independent of `divisions`).
            if (durationBeats <= 0 && !isGrace) {
              const typeText = child.querySelector(':scope > type')?.textContent;
              const typeBeats = typeText ? TYPE_BEATS[typeText] : undefined;
              if (typeBeats != null) {
                const dotted = child.querySelectorAll(':scope > dot').length > 0;
                durationBeats = dotted ? typeBeats * 1.5 : typeBeats;
              }
            }
            // Still audible/visible as a real (very short) note -- just never allowed to touch
            // `cursor` (see isGrace's declaration above). Placed to end exactly at the current
            // cursor position, i.e. just before whatever main note follows it, rather than
            // overlapping it.
            if (isGrace) durationBeats = GRACE_NOTE_DURATION_BEATS;
            const startBeat = isGrace ? Math.max(0, cursor - durationBeats) : isChord ? lastNoteStart : cursor;

            // A whole-measure rest (<rest measure="yes"/>) is spec-legal without an explicit
            // <duration> OR <type> -- its length is implied entirely by the measure's own time
            // signature, since that's the whole point of the measure="yes" flag. Fill to the end
            // of the measure (not just `beats * 4/beatType`) so this is still correct for a
            // measure rest that isn't at the very start of the measure.
            if (isRest && restEl?.getAttribute('measure') === 'yes' && durationBeats <= 0) {
              durationBeats = measureStartBeat + beats * (4 / beatType) - cursor;
            }

            if (!isRest) {
              const pitchEl = child.querySelector(':scope > pitch');
              if (pitchEl) {
                const step = pitchEl.querySelector('step')?.textContent || 'C';
                const alter = parseFloat(pitchEl.querySelector('alter')?.textContent || '0');
                const octave = parseInt(pitchEl.querySelector('octave')?.textContent || '4', 10);
                const midi = pitchToMidi(step, alter, octave);
                const lyric = child.querySelector(':scope > lyric > text')?.textContent?.trim();

                // Tools vary in which element they emit for a tie: <tie> is the sound-level
                // element, <notations><tied> is the notation/visual-level one. Real-world files
                // (especially OMR/scan-derived ones) sometimes carry only one of the two, so check
                // both -- a note with both start and stop for the same element type is harmless
                // (a Set collapses the duplicate).
                const tieTypes = new Set(
                  Array.from(child.querySelectorAll(':scope > tie, :scope > notations > tied')).map((el) => el.getAttribute('type')),
                );
                const continuesOpenTie = tieTypes.has('stop') && openTieNotes.has(midi);

                if (continuesOpenTie) {
                  // Extend the already-pushed NoteEvent through this note's end instead of adding
                  // a second one -- see openTieNotes' doc comment for why. newTotal is recomputed
                  // from the tie-start's own startBeat (not a running sum), which already
                  // self-corrects for any gap/rounding between consecutive tied notes -- the new
                  // tieSegments entry uses the same self-correcting math (this segment's real
                  // length is "however much newTotal grew", not just this note's own raw
                  // durationBeats) so segments always sum exactly to durationBeats.
                  const open = openTieNotes.get(midi)!;
                  const newTotal = startBeat + durationBeats - open.startBeat;
                  if (open.tieSegments) {
                    const priorSum = open.tieSegments.reduce((a, b) => a + b, 0);
                    open.tieSegments.push(newTotal - priorSum);
                  }
                  open.durationBeats = newTotal;
                  if (tieTypes.has('start')) {
                    openTieNotes.set(midi, open); // chain continues into a further tied note
                  } else {
                    openTieNotes.delete(midi);
                  }
                } else {
                  const noteEvent: NoteEvent = {
                    partId,
                    midi,
                    startBeat,
                    durationBeats,
                    lyric: lyric || undefined,
                    measureNumber,
                    step,
                    alter,
                    octave,
                    tieSegments: tieTypes.has('start') ? [durationBeats] : undefined,
                  };
                  notes.push(noteEvent);
                  if (tieTypes.has('start')) openTieNotes.set(midi, noteEvent);
                }

                for (const slurEl of Array.from(child.querySelectorAll(':scope > notations > slur'))) {
                  const num = parseInt(slurEl.getAttribute('number') || '1', 10);
                  const type = slurEl.getAttribute('type');
                  if (type === 'start') {
                    openSlurs.set(num, { beat: startBeat, midi });
                  } else if (type === 'stop') {
                    const open = openSlurs.get(num);
                    if (open) {
                      slurs.push({ partId, startBeat: open.beat, startMidi: open.midi, endBeat: startBeat, endMidi: midi });
                      openSlurs.delete(num);
                    }
                  }
                }
              }
            }

            if (!isChord && !isGrace) {
              cursor += durationBeats;
              lastNoteStart = startBeat;
              measureCursorMax = Math.max(measureCursorMax, cursor);
            }
            break;
          }
          case 'backup': {
            const durationText = child.querySelector('duration')?.textContent;
            const durationUnits = durationText ? parseFloat(durationText) : 0;
            cursor -= divisions > 0 ? durationUnits / divisions : 0;
            break;
          }
          case 'forward': {
            const durationText = child.querySelector('duration')?.textContent;
            const durationUnits = durationText ? parseFloat(durationText) : 0;
            cursor += divisions > 0 ? durationUnits / divisions : 0;
            measureCursorMax = Math.max(measureCursorMax, cursor);
            break;
          }
          case 'direction': {
            // Only recorded from the first part processed (like `measures` itself, via
            // `measuresBuilt`) -- a rehearsal mark is a piece-level structural concept, and real
            // scores conventionally print it only once (usually on the top staff), not per part.
            if (measuresBuilt) break;
            const rehearsalText = child.querySelector(':scope > direction-type > rehearsal')?.textContent?.trim();
            if (rehearsalText) rehearsalMarks.push({ label: rehearsalText, beat: cursor });
            break;
          }
        }
      }

      // A measure's real length is however far its own content actually reaches, not always the
      // full time-signature-implied length (beats * 4/beatType) -- those only coincide for an
      // ordinarily-complete measure. A pickup/anacrusis measure (a real, common case, not an
      // error: this app's own "Nachtigall" test piece opens with a single eighth-note upbeat in a
      // 3/8 piece, well short of a full 3/8 measure) is genuinely shorter than the time signature
      // suggests. Blindly using the time-signature length there inflated measureStartBeat by the
      // pickup's own shortfall, silently padding an extra gap of silence before measure 2 and
      // shifting every subsequent measure/note in the piece later than the source actually
      // notates -- the real mechanism behind a concretely reported bug (a part's first real note,
      // after a pickup + several measures of rests in other voices, landing at the wrong beat).
      // Falls back to the time-signature length only for a measure with no content at all (an
      // empty measure has nothing to measure `cursor` against).
      const measureDurationBeats = measureCursorMax > measureStartBeat ? measureCursorMax - measureStartBeat : beats * (4 / beatType);
      if (!measuresBuilt) {
        measures.push({ number: measureNumber, startBeat: measureStartBeat, beats, beatType, fifths, mode: keyMode });
      }
      measureStartBeat += measureDurationBeats;
    }

    measuresBuilt = true;
    totalBeats = Math.max(totalBeats, measureStartBeat);
    if (partClef) {
      const partInfo = parts.find((p) => p.id === partId);
      if (partInfo) partInfo.clef = partClef;
    }
  }

  notes.sort((a, b) => a.startBeat - b.startBeat);
  rehearsalMarks.sort((a, b) => a.beat - b.beat);

  return { title, parts, notes, measures, slurs, totalBeats, rehearsalMarks };
}
