import { describe, expect, it } from 'vitest';
import { parseMusicXML } from './musicxml';

/** Wraps measure markup for one or more parts into a minimal valid partwise document. */
function scoreDoc(partsMeasures: Record<string, string>, extraHeader = ''): string {
  const ids = Object.keys(partsMeasures);
  const partList = ids
    .map((id) => `<score-part id="${id}"><part-name>Part ${id}</part-name></score-part>`)
    .join('');
  const parts = ids.map((id) => `<part id="${id}">${partsMeasures[id]}</part>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  ${extraHeader}
  <part-list>${partList}</part-list>
  ${parts}
</score-partwise>`;
}

function note(step: string, octave: number, duration: number, extra = ''): string {
  return `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration>${extra}</note>`;
}

const ATTRS_44 = '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';

describe('parseMusicXML', () => {
  it('parses title, parts, and basic notes with correct beats and pitches', () => {
    const xml = scoreDoc(
      { P1: `<measure number="1">${ATTRS_44}${note('C', 4, 1)}${note('G', 4, 2)}<note><rest/><duration>1</duration></note></measure>` },
      '<work><work-title>Test Song</work-title></work>',
    );
    const score = parseMusicXML(xml);
    expect(score.title).toBe('Test Song');
    expect(score.parts).toEqual([{ id: 'P1', name: 'Part P1' }]);
    expect(score.notes).toHaveLength(2); // the rest produces no note
    expect(score.notes[0]).toMatchObject({ partId: 'P1', midi: 60, startBeat: 0, durationBeats: 1, measureNumber: 1 });
    expect(score.notes[1]).toMatchObject({ midi: 67, startBeat: 1, durationBeats: 2 });
    expect(score.totalBeats).toBe(4);
  });

  it('falls back to movement-title, then "Untitled"', () => {
    const withMovement = scoreDoc({ P1: '<measure number="1"></measure>' }, '<movement-title>Movement</movement-title>');
    expect(parseMusicXML(withMovement).title).toBe('Movement');
    const bare = scoreDoc({ P1: '<measure number="1"></measure>' });
    expect(parseMusicXML(bare).title).toBe('Untitled');
  });

  it('applies <alter> to pitch (sharps and flats)', () => {
    const sharp = '<note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration></note>';
    const flat = '<note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>1</duration></note>';
    const score = parseMusicXML(scoreDoc({ P1: `<measure number="1">${ATTRS_44}${sharp}${flat}</measure>` }));
    expect(score.notes.map((n) => n.midi)).toEqual([66, 58]); // F#4, Bb3
  });

  it('stacks chord notes on the same start beat', () => {
    const chordNote = '<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration></note>';
    const score = parseMusicXML(
      parseMusicXMLInput(`<measure number="1">${ATTRS_44}${note('C', 4, 2)}${chordNote}${note('D', 4, 2)}</measure>`),
    );
    expect(score.notes.map((n) => [n.midi, n.startBeat])).toEqual([
      [60, 0],
      [64, 0], // chord member shares the C's start
      [62, 2], // next non-chord note advances normally
    ]);
  });

  it('handles <backup> for a second voice within the same measure', () => {
    const measure =
      `<measure number="1">${ATTRS_44}` +
      note('C', 5, 4) + // voice 1: whole note
      '<backup><duration>4</duration></backup>' +
      note('C', 3, 2) +
      note('D', 3, 2) + // voice 2: two halves
      '</measure>';
    const score = parseMusicXML(parseMusicXMLInput(measure));
    expect(score.notes.map((n) => [n.midi, n.startBeat])).toEqual([
      [72, 0],
      [48, 0],
      [50, 2],
    ]);
  });

  it('handles <forward> skipping time', () => {
    const measure =
      `<measure number="1">${ATTRS_44}` +
      note('C', 4, 1) +
      '<forward><duration>2</duration></forward>' +
      note('D', 4, 1) +
      '</measure>';
    const score = parseMusicXML(parseMusicXMLInput(measure));
    expect(score.notes[1].startBeat).toBe(3);
  });

  it('respects mid-piece divisions changes', () => {
    const m1 = `<measure number="1">${ATTRS_44}${note('C', 4, 1)}</measure>`;
    const m2 = `<measure number="2"><attributes><divisions>4</divisions></attributes>${note('D', 4, 4)}</measure>`;
    const score = parseMusicXML(parseMusicXMLInput(m1 + m2));
    // divisions=4 means duration 4 units = 1 quarter beat
    expect(score.notes[1]).toMatchObject({ startBeat: 4, durationBeats: 1 });
  });

  it('tracks time signature changes in measure start beats and totalBeats', () => {
    const m1 = `<measure number="1"><attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>${note('C', 4, 6)}</measure>`;
    const m2 = `<measure number="2"><attributes><time><beats>6</beats><beat-type>8</beat-type></time></attributes>${note('D', 4, 6)}</measure>`;
    const score = parseMusicXML(parseMusicXMLInput(m1 + m2));
    expect(score.measures).toEqual([
      { number: 1, startBeat: 0, beats: 3, beatType: 4 },
      { number: 2, startBeat: 3, beats: 6, beatType: 8 }, // 6/8 = 3 quarter-note beats long
    ]);
    expect(score.totalBeats).toBe(6);
  });

  it('extracts lyric text', () => {
    const withLyric = note('C', 4, 1, '<lyric><syllabic>single</syllabic><text>la</text></lyric>');
    const score = parseMusicXML(parseMusicXMLInput(`<measure number="1">${ATTRS_44}${withLyric}</measure>`));
    expect(score.notes[0].lyric).toBe('la');
  });

  it('pairs slur start/stop into arcs, keyed by slur number', () => {
    const m =
      `<measure number="1">${ATTRS_44}` +
      note('C', 4, 1, '<notations><slur type="start" number="1"/></notations>') +
      note('D', 4, 1) +
      note('E', 4, 1, '<notations><slur type="stop" number="1"/></notations>') +
      '</measure>';
    const score = parseMusicXML(parseMusicXMLInput(m));
    expect(score.slurs).toEqual([{ partId: 'P1', startBeat: 0, startMidi: 60, endBeat: 2, endMidi: 64 }]);
  });

  it('pairs ties from <tie> elements, anchored at the first note\'s end', () => {
    const m1 = `<measure number="1">${ATTRS_44}${note('C', 4, 4, '<tie type="start"/>')}</measure>`;
    const m2 = `<measure number="2">${note('C', 4, 2, '<tie type="stop"/>')}</measure>`;
    const score = parseMusicXML(parseMusicXMLInput(m1 + m2));
    expect(score.ties).toEqual([{ partId: 'P1', startBeat: 4, startMidi: 60, endBeat: 4, endMidi: 60 }]);
  });

  it('treats a note carrying both <tie> and <notations><tied> as a single tie', () => {
    const both = '<tie type="start"/><notations><tied type="start"/></notations>';
    const bothStop = '<tie type="stop"/><notations><tied type="stop"/></notations>';
    const m1 = `<measure number="1">${ATTRS_44}${note('G', 4, 4, both)}</measure>`;
    const m2 = `<measure number="2">${note('G', 4, 4, bothStop)}</measure>`;
    const score = parseMusicXML(parseMusicXMLInput(m1 + m2));
    expect(score.ties).toHaveLength(1);
  });

  it('takes totalBeats from the longest part and measures from the first', () => {
    const xml = scoreDoc({
      P1: `<measure number="1">${ATTRS_44}${note('C', 4, 4)}</measure>`,
      P2:
        `<measure number="1">${ATTRS_44}${note('C', 3, 4)}</measure>` +
        `<measure number="2">${note('D', 3, 4)}</measure>`,
    });
    const score = parseMusicXML(xml);
    expect(score.totalBeats).toBe(8);
    expect(score.measures).toHaveLength(1); // built from the first part only (documented behavior)
  });

  it('returns notes sorted by start beat across parts', () => {
    const xml = scoreDoc({
      P1: `<measure number="1">${ATTRS_44}${note('C', 5, 2)}${note('D', 5, 2)}</measure>`,
      P2: `<measure number="1">${ATTRS_44}${note('C', 3, 1)}${note('D', 3, 1)}${note('E', 3, 2)}</measure>`,
    });
    const beats = parseMusicXML(xml).notes.map((n) => n.startBeat);
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
  });

  it('throws on malformed XML', () => {
    expect(() => parseMusicXML('<score-partwise><unclosed')).toThrow(/Invalid MusicXML/);
  });

  it('defaults missing part ids/names without crashing', () => {
    const xml = `<?xml version="1.0"?><score-partwise>
      <part-list><score-part id="P1"></score-part></part-list>
      <part id="P1"><measure number="1">${ATTRS_44}${note('A', 4, 1)}</measure></part>
    </score-partwise>`;
    const score = parseMusicXML(xml);
    expect(score.parts[0].name).toBe('P1'); // falls back to the id
    expect(score.notes[0].midi).toBe(69);
  });
});

/** Single-part shorthand: measures markup for part P1 only. */
function parseMusicXMLInput(measures: string): string {
  return scoreDoc({ P1: measures });
}
