import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { applyMeasure, compactPage, CorrectionError, measuresByPage, mergeMovements, pageOfMeasures, parseXml, readMxl, serializeXml, setPartName, setTitle, getTitle } from '../dist/score.js';

const EVENING = readFileSync(new URL('../../public/evening-rise.musicxml', import.meta.url), 'utf8');
const fresh = () => parseXml(EVENING);

test('compact notation reads parts, measures and lyrics', () => {
  const { parts, measures } = compactPage(fresh(), [0, 1]);
  assert.ok(parts.length >= 4);
  assert.equal(measures.length, 2);
  assert.equal(measures[0].m, 1);
  assert.equal(measures[0].time, '4/4');
  assert.equal(measures[0].fifths, 1);
  const [voice] = measures[0].parts[parts[0].id];
  assert.deepEqual([voice.v, voice.staff], [1, 1]);
  assert.equal(voice.notes[0], 'E4 1/2 :Eve-');
  assert.ok(voice.notes.every((n) => /^\+?(r|x?[A-G](#|b)*-?\d) \d+(\/\d+)?~?( :.*)?$/.test(n)));
});

test('writing a measure back unchanged keeps it identical', () => {
  const doc = fresh();
  const { parts, measures } = compactPage(doc, [0, 1, 2, 3]);
  for (const m of measures) for (const p of parts) applyMeasure(doc, p.id, m.m, m.parts[p.id]);
  const again = compactPage(parseXml(serializeXml(doc)), [0, 1, 2, 3]);
  assert.deepEqual(again.measures, measures);
});

test('a pitch correction is applied, the rest of the piece untouched', () => {
  const doc = fresh();
  const { parts, measures } = compactPage(doc, [0, 1]);
  const pid = parts[0].id;
  const voices = structuredClone(measures[0].parts[pid]);
  voices[0].notes[0] = voices[0].notes[0].replace(/^E4/, 'C#5');
  applyMeasure(doc, pid, 1, voices);
  const after = compactPage(parseXml(serializeXml(doc)), [0, 1]);
  assert.equal(after.measures[0].parts[pid][0].notes[0], 'C#5 1/2 :Eve-');
  assert.deepEqual(after.measures[1], measures[1]);
  assert.match(serializeXml(doc), /<step>C<\/step><alter>1<\/alter><octave>5<\/octave>/);
});

test('a correction that no longer fills the bar is refused and changes nothing', () => {
  const doc = fresh();
  const before = serializeXml(doc);
  const { parts, measures } = compactPage(doc, [1]);
  const pid = parts[0].id;
  const voices = structuredClone(measures[0].parts[pid]);
  voices[0].notes.pop();
  assert.throws(() => applyMeasure(doc, pid, 2, voices), CorrectionError);
  // Finer durations that still don't add up: refused before the part is rescaled.
  assert.throws(() => applyMeasure(doc, pid, 2, [{ v: 1, staff: 1, notes: ['C5 1/3', 'C5 1'] }]), /lasts/);
  assert.equal(serializeXml(doc), before);
});

test('bad notes and unknown parts are refused', () => {
  const doc = fresh();
  const { parts, measures } = compactPage(doc, [1]);
  const pid = parts[0].id;
  assert.throws(() => applyMeasure(doc, pid, 2, [{ v: 1, staff: 1, notes: ['H4 4'] }]), /can't read/);
  assert.throws(() => applyMeasure(doc, 'nope', 2, measures[0].parts[pid]), /unknown part/);
});

test('triplets in a part written in eighths: the divisions are made finer', () => {
  const doc = fresh();
  const pid = compactPage(doc, [0]).parts[0].id;
  applyMeasure(doc, pid, 2, [{ v: 1, staff: 1, notes: ['B4 1/3 :spi-', 'A4 1/3', 'G4 1/3', 'A4 1 :rit', 'A4 2 :come,'] }]);
  const again = parseXml(serializeXml(doc));
  const { measures } = compactPage(again, [0, 1]);
  assert.deepEqual(measures[1].parts[pid][0].notes, ['B4 1/3 :spi-', 'A4 1/3', 'G4 1/3', 'A4 1 :rit', 'A4 2 :come,']);
  assert.equal(measures[0].parts[pid][0].notes[0], 'E4 1/2 :Eve-', 'the bar before reads the same');
});

test('words with hyphens become begin/middle/end syllables, verses numbered', () => {
  const doc = fresh();
  const pid = compactPage(doc, [0]).parts[0].id;
  applyMeasure(doc, pid, 1, [{ v: 1, staff: 1, notes: ['E4 1 :Hal-|Glo-', 'F#4 1 :le-|ri-', 'G4 1 :lu|a', 'A4 1 :ja|_'] }]);
  const xml = serializeXml(doc);
  assert.match(xml, /<lyric number="1"><syllabic>begin<\/syllabic><text>Hal<\/text>/);
  assert.match(xml, /<lyric number="1"><syllabic>middle<\/syllabic><text>le<\/text>/);
  assert.match(xml, /<lyric number="1"><syllabic>end<\/syllabic><text>lu<\/text>/);
  assert.match(xml, /<lyric number="2"><syllabic>begin<\/syllabic><text>Glo<\/text>/);
});

test('page breaks split measures into pages; no breaks spread evenly', () => {
  const doc = fresh();
  assert.equal(pageOfMeasures(doc), null);
  const even = measuresByPage(doc, 2);
  assert.equal(even.length, 2);
  assert.equal(even.flat().length, even.flat().length);
  // add a page break on measure 5 of the first part
  const part = doc.getElementsByTagName('part')[0];
  const m5 = part.getElementsByTagName('measure')[4];
  const print = doc.createElement('print');
  print.setAttribute('new-page', 'yes');
  m5.insertBefore(print, m5.firstChild);
  const groups = measuresByPage(doc, 2);
  assert.deepEqual(groups[0], [0, 1, 2, 3]);
  assert.equal(groups[1][0], 4);
});

test('.mxl files are unpacked via their container', () => {
  const mxl = zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>'),
    'score.xml': strToU8(EVENING),
  });
  assert.equal(readMxl(mxl), EVENING);
});

test('movements with the same voices are merged, measures renumbered', () => {
  const a = fresh();
  const n = a.getElementsByTagName('part')[0].getElementsByTagName('measure').length;
  const { doc, dropped } = mergeMovements([a, fresh()]);
  assert.equal(dropped, 0);
  const measures = doc.getElementsByTagName('part')[0].getElementsByTagName('measure');
  assert.equal(measures.length, n * 2);
  assert.equal(measures[measures.length - 1].getAttribute('number'), String(n * 2));
});

test('title and part names can be set', () => {
  const doc = fresh();
  setTitle(doc, 'Abendlied');
  setPartName(doc, compactPage(doc, [0]).parts[0].id, 'Sopran');
  const again = parseXml(serializeXml(doc));
  assert.equal(getTitle(again), 'Abendlied');
  assert.equal(compactPage(again, [0]).parts[0].name, 'Sopran');
});
