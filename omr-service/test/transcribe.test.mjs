// Putting the pages GPT read together (transcribe.ts) and the automatic checks (checks.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptParts, cleanParts, stitch } from '../dist/transcribe.js';
import { buildScore } from '../dist/build.js';
import { plausibility } from '../dist/checks.js';
import { compactPage, parseXml, serializeXml } from '../dist/score.js';

const measure = (parts, extra = {}) => ({
  number: '', system: 1, left: 0, right: 0.5, time: '', keyPrinted: false, key: 0,
  barStart: 'none', barEnd: 'normal', repeatTimes: 0, endingNumbers: '', endingStart: false, endingStop: false,
  marks: [], parts: Object.entries(parts).map(([part, notes]) => ({ part, voices: [{ v: 1, staff: 1, notes }] })),
  ...extra,
});
const page = (measures, extra = {}) => ({ parts: [], systems: [{ top: 0.1, bottom: 0.4, parts: [{ part: 'P2', top: 0.3, bottom: 0.4 }, { part: 'P7', top: 0.2, bottom: 0.3 }] }, { top: 0.5, bottom: 0.8 }], measures, stackedVerses: [], doubts: [], title: '', confidence: 'high', ...extra });
const PARTS = [
  { id: 'P1', name: 'Sopran', staves: 1, clefs: ['G2'] },
  { id: 'P2', name: 'Bass', staves: 1, clefs: ['F4'] },
];

test('the parts of the first page get usable ids, and the page follows them', () => {
  const first = page([measure({ 'Sopran 1': ['C5 4'], '': ['C3 4'] }, { marks: [{ kind: 'dynamic', text: 'p', part: 'Sopran 1', bpm: 0 }] })], {
    parts: [
      { id: 'Sopran 1', name: ' Sopran 1 ', staves: 1, clefs: ['G2'] },
      { id: '', name: 'Klavier', staves: 2, clefs: ['G2', 'nonsense'] },
    ],
    doubts: [{ measure: 1, part: 'Sopran 1', note: 'x' }],
  });
  const parts = adoptParts(first);
  assert.deepEqual(parts, [
    { id: 'Sopran1', name: 'Sopran 1', staves: 1, clefs: ['G2'] },
    { id: 'P2', name: 'Klavier', staves: 2, clefs: ['G2', 'F4'] },
  ]);
  assert.deepEqual(first.measures[0].parts.map((p) => p.part), ['Sopran1', 'P2']);
  assert.equal(first.measures[0].marks[0].part, 'Sopran1');
  assert.equal(first.doubts[0].part, 'Sopran1');
  assert.equal(cleanParts([{ id: 'A', name: '', staves: 9, clefs: [] }, { id: 'A', name: 'Alt 2', staves: 1, clefs: ['C3'] }])[1].id, 'Ab');
});

test('pages are put together: numbers, boxes, stacked verses as a repeat, unreadable bars as hints', () => {
  const p1 = page(
    [
      measure({ P1: ['C5 3 :Lob'], P2: ['C3 3 :Lob'] }, { time: '3/4', keyPrinted: true, key: -1, marks: [{ kind: 'rehearsal', text: 'A', part: '', bpm: 0 }, { kind: 'words', text: 'x', part: 'P9', bpm: 0 }] }),
      measure({ P1: ['D5 1 :Eins-|Zwei-|Drei-', 'E5 2 :zwei|drei|vier'], P2: ['D3 3 :Eins|Zwei|Drei'] }, { left: 0.5, right: 1 }),
      measure({ P1: ['F5 3 :a|b|c'], P2: ['F3 3 :a|b|c'] }, { system: 2, left: 0, right: 1 }),
    ],
    { stackedVerses: [{ first: 2, last: 3, verses: 3 }], title: ' Abendlied ' },
  );
  const p2 = page(
    [
      measure({ P1: ['G5 3 :d|e|f'], P2: ['G3 3 :d|e|f'] }, { number: '4' }),
      measure({ P1: ['A5 3'], P2: ['Q3 3'] }, { endingNumbers: '1', barEnd: 'final' }),
      measure({ P1: ['A5 3'], P2: ['A3 3'] }, { endingNumbers: '2', endingStart: true, endingStop: true }),
    ],
    { stackedVerses: [{ first: 1, last: 1, verses: 3 }], doubts: [{ measure: 1, part: '', note: 'Bogen oder Haltebogen?' }, { measure: 99, part: 'P1', note: 'out of range' }] },
  );
  const { transcript, hints, title } = stitch([p1, p2], PARTS);
  assert.equal(title, 'Abendlied');
  const ms = transcript.measures;
  assert.deepEqual(ms.map((m) => m.number), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(ms.map((m) => m.page), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(ms[1].box, { x0: 0.5, x1: 1, y0: 0.1, y1: 0.4 });
  assert.deepEqual(ms[2].box, { x0: 0, x1: 1, y0: 0.5, y1: 0.8 });
  assert.deepEqual(ms[0].rows, { P2: [0.3, 0.4] }, 'each part’s row, for parts that exist');
  assert.equal(ms[0].time, '3/4');
  assert.equal(ms[0].key, -1);
  assert.equal(ms[1].key, null);
  assert.equal(ms[0].marks.length, 1, 'a mark for an unknown part is dropped');
  // Verses stacked under bars 2-4 (over the page turn): one passage, played three times.
  assert.equal(ms[1].barStart, 'repeat');
  assert.equal(ms[3].barEnd, 'repeat');
  assert.equal(ms[3].repeatTimes, 3);
  assert.equal(ms[4].ending, null, 'inside a bracket without start or stop: nothing to write');
  assert.deepEqual(ms[5].ending, { numbers: [2], start: true, stop: true });
  // Bar 5's bass couldn't be read: left out (a rest when built), and the second run is told.
  assert.equal(ms[4].parts.P2, undefined);
  assert.deepEqual(hints.map((h) => [h.part, h.m]), [['P2', 5], ['', 4]]);
  assert.match(hints[0].note, /couldn't be read/);
  assert.match(hints[1].note, /Bogen/);

  const xml = serializeXml(buildScore(transcript));
  assert.match(xml, /<repeat direction="forward"\/>/);
  assert.match(xml, /<repeat direction="backward" times="3"\/>/);
  assert.match(xml, /<lyric number="3"><syllabic>begin<\/syllabic><text>Drei<\/text><\/lyric>/);
  const { measures } = compactPage(parseXml(xml), [4]);
  assert.deepEqual(measures[0].parts.P2[0].notes, ['r 3']);
});

test('a strophic passage that has its own repeat signs is left as printed', () => {
  const p = page(
    [measure({ P1: ['C5 3 :a|b'], P2: ['C3 3'] }, { time: '3/4', barStart: 'repeat' }), measure({ P1: ['D5 3 :c|d'], P2: ['D3 3'] }, { barEnd: 'repeat', repeatTimes: 0 })],
    { stackedVerses: [{ first: 1, last: 2, verses: 2 }] },
  );
  const { transcript } = stitch([p], PARTS);
  assert.equal(transcript.measures[1].repeatTimes, 0);
});

test('the checks point at bars that don’t add up, odd ranges, leaps and ties', () => {
  const p = page([
    measure({ P1: ['C5 3'], P2: ['C3 3'] }, { time: '3/4' }),
    measure({ P1: ['C5 2'], P2: ['C3 3~'] }), // soprano short a beat; bass tied ...
    measure({ P1: ['C5 1', 'D6 1', 'C5 1'], P2: ['D3 3 :Hal-'] }), // ... to a different note; D6 high, leaps
    measure({ P1: ['C5 3'], P2: ['r 3'] }), // a word broken off before a rest
    measure({ P1: ['C5 3'], P2: ['C6 3'] }), // too high for a bass
    measure({ P1: ['C5 2'], P2: ['C3 2'] }), // a short last bar is fine
  ]);
  const { transcript } = stitch([p], PARTS);
  const hints = plausibility(parseXml(serializeXml(buildScore(transcript))));
  const at = (part, m) => hints.filter((h) => h.part === part && h.m === m).map((h) => h.note);
  assert.equal(at('P1', 2).length, 1);
  assert.match(at('P1', 2)[0], /adds up to 2 quarters, the 3\/4 bar to 3/);
  assert.ok(at('P2', 3).some((n) => /tie from C3 to a different note, D3/.test(n)));
  assert.ok(at('P1', 3).some((n) => /D6 is unusual for a soprano/.test(n)));
  assert.ok(at('P1', 3).some((n) => /leap of more than an octave/.test(n)));
  assert.ok(at('P2', 4).some((n) => /broken off before a rest \("Hal-"\)/.test(n)));
  assert.ok(at('P2', 5).some((n) => /C6 is unusual for a bass/.test(n)));
  assert.deepEqual(at('P1', 6), [], 'the last bar may be short');
  assert.deepEqual(at('P1', 1), []);
});
