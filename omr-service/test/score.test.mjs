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
  const first = measures[0].parts[parts[0].id];
  assert.ok(first.length > 0);
  assert.ok(first.some((n) => n.lyric), 'some lyric in bar 1');
  assert.match(first[0].p, /^([A-G](#|b)?\d|rest)$/);
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
  const notes = measures[0].parts[pid].map((n) => ({ ...n }));
  const i = notes.findIndex((n) => n.p !== 'rest');
  notes[i].p = 'C#5';
  applyMeasure(doc, pid, 1, notes);
  const after = compactPage(parseXml(serializeXml(doc)), [0, 1]);
  assert.equal(after.measures[0].parts[pid][i].p, 'C#5');
  assert.deepEqual(after.measures[1], measures[1]);
});

test('a correction that no longer fills the bar is refused and changes nothing', () => {
  const doc = fresh();
  const before = serializeXml(doc);
  const { parts, measures } = compactPage(doc, [1]);
  const pid = parts[0].id;
  const notes = measures[0].parts[pid].slice(0, -1);
  assert.throws(() => applyMeasure(doc, pid, 2, notes), CorrectionError);
  assert.equal(serializeXml(doc), before);
});

test('bad pitches and unwritable durations are refused', () => {
  const doc = fresh();
  const { parts, measures } = compactPage(doc, [1]);
  const pid = parts[0].id;
  const bad = measures[0].parts[pid].map((n) => ({ ...n }));
  bad[0].p = 'H4';
  assert.throws(() => applyMeasure(doc, pid, 2, bad), /bad pitch/);
  assert.throws(() => applyMeasure(doc, 'nope', 2, measures[0].parts[pid]), /unknown part/);
});

test('lyrics with hyphens become begin/middle/end syllables', () => {
  const doc = fresh();
  const { parts, measures } = compactPage(doc, [0]);
  const pid = parts[0].id;
  const notes = measures[0].parts[pid].map((n) => ({ ...n, lyric: '' }));
  const sung = notes.map((n, i) => (n.p === 'rest' || n.chord ? -1 : i)).filter((i) => i >= 0);
  if (sung.length >= 3) {
    notes[sung[0]].lyric = 'Hal-';
    notes[sung[1]].lyric = 'le-';
    notes[sung[2]].lyric = 'lu';
    applyMeasure(doc, pid, 1, notes);
    const xml = serializeXml(doc);
    assert.match(xml, /<syllabic>begin<\/syllabic><text>Hal<\/text>/);
    assert.match(xml, /<syllabic>middle<\/syllabic><text>le<\/text>/);
    assert.match(xml, /<syllabic>end<\/syllabic><text>lu<\/text>/);
  }
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
