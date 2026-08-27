import type { MeasureInfo, NoteEvent, PartInfo, Score, SlurArc } from './score';

const STEP_SEMITONES: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

function pitchToMidi(step: string, alter: number, octave: number): number {
  return (octave + 1) * 12 + (STEP_SEMITONES[step] ?? 0) + alter;
}

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
  let totalBeats = 0;
  let measuresBuilt = false;

  const partEls = Array.from(doc.querySelectorAll('score-partwise > part'));

  for (const partEl of partEls) {
    const partId = partEl.getAttribute('id') || '';
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let measureStartBeat = 0;
    let cursor = 0;
    let lastNoteStart = 0;
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

      for (const child of Array.from(measureEl.children)) {
        switch (child.tagName) {
          case 'attributes': {
            const divText = child.querySelector('divisions')?.textContent;
            if (divText) divisions = parseFloat(divText) || 1;
            const timeEl = child.querySelector('time');
            if (timeEl) {
              const b = timeEl.querySelector('beats')?.textContent;
              const bt = timeEl.querySelector('beat-type')?.textContent;
              if (b) beats = parseInt(b, 10) || beats;
              if (bt) beatType = parseInt(bt, 10) || beatType;
            }
            break;
          }
          case 'note': {
            const isChord = !!child.querySelector(':scope > chord');
            const isRest = !!child.querySelector(':scope > rest');
            const durationText = child.querySelector(':scope > duration')?.textContent;
            const durationUnits = durationText ? parseFloat(durationText) : 0;
            const durationBeats = divisions > 0 ? durationUnits / divisions : 0;
            const startBeat = isChord ? lastNoteStart : cursor;

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
                  // a second one -- see openTieNotes' doc comment for why.
                  const open = openTieNotes.get(midi)!;
                  open.durationBeats = startBeat + durationBeats - open.startBeat;
                  if (tieTypes.has('start')) {
                    openTieNotes.set(midi, open); // chain continues into a further tied note
                  } else {
                    openTieNotes.delete(midi);
                  }
                } else {
                  const noteEvent: NoteEvent = { partId, midi, startBeat, durationBeats, lyric: lyric || undefined, measureNumber, step, alter, octave };
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

            if (!isChord) {
              cursor += durationBeats;
              lastNoteStart = startBeat;
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
            break;
          }
        }
      }

      const measureDurationBeats = beats * (4 / beatType);
      if (!measuresBuilt) {
        measures.push({ number: measureNumber, startBeat: measureStartBeat, beats, beatType });
      }
      measureStartBeat += measureDurationBeats;
    }

    measuresBuilt = true;
    totalBeats = Math.max(totalBeats, measureStartBeat);
  }

  notes.sort((a, b) => a.startBeat - b.startBeat);

  return { title, parts, notes, measures, slurs, totalBeats };
}
