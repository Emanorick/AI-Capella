// The compact notation and the MusicXML written from it (build.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatNote, parseNote, NotationError } from '../dist/notation.js';
import { buildScore, noteShape, beatOf } from '../dist/build.js';
import { compactPage, parseXml, partsOf, serializeXml } from '../dist/score.js';

test('note strings read and write back', () => {
  for (const s of ['C5 1', 'F#4 1/2', 'Bb3 3/2~', 'r 2', '+E5 1', 'C5 1 :Eve-|Come', 'G4 1/3 :|day', 'xF5 1/2', 'A0 1/4', 'D5 1 :ah_']) {
    assert.equal(formatNote(parseNote(s)), s);
  }
  const n = parseNote('F##4 3/2~ :Glo-|_');
  assert.deepEqual([n.step, n.alter, n.octave, n.num, n.den, n.tie, n.verses], ['F', 2, 4, 3, 2, true, ['Glo-', '_']]);
  assert.throws(() => parseNote('H4 1'), NotationError);
  assert.throws(() => parseNote('C4'), NotationError);
});

test('durations get their written shape: dots, triplets, quintuplets', () => {
  assert.deepEqual(noteShape(1.5), { type: 'quarter', dots: 1 });
  assert.deepEqual(noteShape(1 / 3), { type: 'eighth', dots: 0, tuplet: [3, 2] });
  assert.deepEqual(noteShape(2 / 3), { type: 'quarter', dots: 0, tuplet: [3, 2] });
  assert.deepEqual(noteShape(0.2), { type: '16th', dots: 0, tuplet: [5, 4] });
  assert.equal(beatOf('6/8'), 1.5);
  assert.equal(beatOf('4/4'), 1);
});

const piece = () => ({
  title: 'Probe',
  parts: [
    { id: 'S', name: 'Sopran', staves: 1, clefs: ['G2'] },
    { id: 'T', name: 'Tenor', staves: 1, clefs: ['G2-8'] },
  ],
  measures: [
    {
      number: '1', page: 0, box: null, time: '3/4', key: 1, barStart: 'repeat', barEnd: 'normal', repeatTimes: 0, ending: null,
      marks: [{ kind: 'rehearsal', text: 'A', part: '', bpm: 0 }, { kind: 'tempo', text: 'Andante', part: '', bpm: 96 }],
      parts: { S: [{ v: 1, staff: 1, notes: ['D5 1 :Eh-|Lob', 'C5 1 :re|sei', 'B4 1~ :sei|Gott'] }], T: [{ v: 1, staff: 1, notes: ['G3 3 :Ehre|Lob'] }] },
    },
    {
      number: '2', page: 0, box: null, time: null, key: null, barStart: 'none', barEnd: 'repeat', repeatTimes: 3, ending: null, marks: [],
      parts: { S: [{ v: 1, staff: 1, notes: ['B4 1', 'C5 1/3', 'D5 1/3', 'F5 1/3', 'G5 1/2', 'F#5 1/2'] }] }, // T missing: a hidden staff
    },
    {
      number: '3', page: 1, box: null, time: null, key: null, barStart: 'none', barEnd: 'final', repeatTimes: 0, ending: { numbers: [1, 2], start: true, stop: true },
      marks: [{ kind: 'dc', text: '', part: '', bpm: 0 }],
      parts: { S: [{ v: 1, staff: 1, notes: ['G4 3'] }], T: [{ v: 1, staff: 1, notes: ['G3 2', 'r 1'] }] },
    },
  ],
});

test('a score is built from a transcription', () => {
  const doc = parseXml(serializeXml(buildScore(piece())));
  const xml = serializeXml(doc);
  assert.match(xml, /<work-title>Probe<\/work-title>/);
  assert.match(xml, /<part-name>Tenor<\/part-name>/);
  assert.match(xml, /<clef><sign>G<\/sign><line>2<\/line><clef-octave-change>-1<\/clef-octave-change><\/clef>/);
  assert.match(xml, /<key><fifths>1<\/fifths><\/key><time><beats>3<\/beats><beat-type>4<\/beat-type><\/time>/);
  assert.match(xml, /<repeat direction="forward"\/>/);
  assert.match(xml, /<repeat direction="backward" times="3"\/>/);
  assert.match(xml, /<ending number="1, 2" type="start"\/>/);
  assert.match(xml, /<rehearsal>A<\/rehearsal>/);
  assert.match(xml, /<per-minute>96<\/per-minute>/);
  assert.match(xml, /<sound tempo="96"\/>/);
  assert.match(xml, /<sound dacapo="yes"\/>/);
  assert.match(xml, /<print new-page="yes"\/>/, 'page break where page 2 begins');
  assert.match(xml, /<time-modification><actual-notes>3<\/actual-notes><normal-notes>2<\/normal-notes><\/time-modification>/);
  assert.match(xml, /<tuplet type="start" bracket="yes"\/>/);
  assert.match(xml, /<beam number="1">begin<\/beam>/);
  // F5 in G major needs a natural, the F#5 after it a sharp again; B4 tied over the bar line.
  assert.match(xml, /<step>F<\/step><octave>5<\/octave><\/pitch><duration>\d+<\/duration><voice>1<\/voice><type>eighth<\/type><accidental>natural<\/accidental>/);
  assert.match(xml, /<accidental>sharp<\/accidental>/);
  assert.match(xml, /<tie type="stop"\/>/);
  // Two verses, numbered, their syllables joined.
  assert.match(xml, /<lyric number="1"><syllabic>begin<\/syllabic><text>Eh<\/text><\/lyric><lyric number="2"><syllabic>single<\/syllabic><text>Lob<\/text><\/lyric>/);
  assert.match(xml, /<lyric number="1"><syllabic>end<\/syllabic><text>re<\/text>/);

  const { measures } = compactPage(doc, [0, 1, 2]);
  assert.deepEqual(measures[0].parts.S[0].notes, ['D5 1 :Eh-|Lob', 'C5 1 :re|sei', 'B4 1~ :sei|Gott']);
  assert.deepEqual(measures[1].parts.T[0].notes, ['r 3'], 'a hidden staff rests the whole bar');
  assert.deepEqual(measures[1].parts.S[0].notes, ['B4 1', 'C5 1/3', 'D5 1/3', 'F5 1/3', 'G5 1/2', 'F#5 1/2']);
});

// A transcription of an existing file, as the GPT reading would give it.
function toTranscript(doc) {
  const parts = partsOf(doc).map(({ ref }) => ({ id: ref.id, name: ref.name, staves: 1, clefs: [] }));
  const n = partsOf(doc)[0].el.getElementsByTagName('measure').length;
  const { measures } = compactPage(doc, Array.from({ length: n }, (_, i) => i));
  let time = '', key = null;
  return {
    title: 'x',
    parts,
    measures: measures.map((cm) => {
      const m = { number: cm.number, page: 0, box: null, time: cm.time !== time ? cm.time : null, key: cm.fifths !== key ? cm.fifths : null, barStart: 'none', barEnd: 'normal', repeatTimes: 0, ending: null, marks: [], parts: cm.parts };
      time = cm.time;
      key = cm.fifths;
      return m;
    }),
  };
}

test('Evening Rise, read and built again, reads the same', () => {
  const doc = parseXml(readFileSync(new URL('../../public/evening-rise.musicxml', import.meta.url), 'utf8'));
  const t = toTranscript(doc);
  const again = parseXml(serializeXml(buildScore(t)));
  const idx = t.measures.map((_, i) => i);
  const sort = (ms) => ms.map((m) => Object.fromEntries(Object.entries(m.parts).map(([k, v]) => [k, v.map((x) => `${x.staff}/${x.v} ${x.notes.join(' ')}`).sort()])));
  assert.deepEqual(sort(compactPage(again, idx).measures), sort(compactPage(doc, idx).measures));
});
