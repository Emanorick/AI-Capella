// The whole API with stand-ins for the PDF tools, Audiveris and OpenAI (test/mocks).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeOpenAI, calls } from './mocks/openai.mjs';
import { compactPage, parseXml } from '../dist/score.js';

const PORT = 18190;
const AI_PORT = 18191;
const base = `http://localhost:${PORT}`;
const mocks = new URL('./mocks/bin/', import.meta.url).pathname;
let server, ai;
const workDir = mkdtempSync(join(tmpdir(), 'omr-test-'));
function startServer(port = PORT, env = {}) {
  const child = spawn('node', ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      PATH: `${mocks}:${process.env.PATH}`,
      AUDIVERIS_CMD: join(mocks, 'audiveris'),
      OMR_SKIP_AUTH: '1',
      OMR_WORK_DIR: workDir,
      OPENAI_API_KEY: 'test',
      OPENAI_BASE_URL: `http://localhost:${AI_PORT}/v1`,
      ALLOWED_ORIGINS: 'http://localhost:5200',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => child.stdout.on('data', (d) => d.toString().includes('OMR service') && resolve(child)));
}

before(async () => {
  ai = await startFakeOpenAI(AI_PORT);
  server = await startServer();
});
after(() => {
  server.kill();
  ai.close();
});

const json = async (res) => ({ status: res.status, body: await res.json() });
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });

async function waitFor(id, statuses = ['done', 'failed'], at = base) {
  for (let i = 0; i < 100; i++) {
    const { body } = await json(await fetch(`${at}/jobs/${id}`));
    if (statuses.includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

async function scanPhotos(at = base) {
  const created = await json(await fetch(`${at}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'images', files: 2, name: 'Fotos', lang: 'de' }) }));
  assert.equal(created.status, 201);
  const id = created.body.id;
  for (const i of [1, 0]) {
    const r = await fetch(`${at}/jobs/${id}/files/${i}`, { method: 'PUT', headers: { 'Content-Type': i ? 'image/png' : 'image/jpeg' }, body: Buffer.from(`page${i}`) });
    assert.equal(r.status, 200);
  }
  assert.equal((await fetch(`${at}/jobs/${id}/start`, { method: 'POST' })).status, 200);
  return { id, done: await waitFor(id, ['done', 'failed'], at) };
}

test('health and CORS', async () => {
  const res = await fetch(`${base}/healthz`, { headers: { Origin: 'http://localhost:5200' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5200');
  assert.deepEqual(await res.json(), { ok: true, engine: 'gpt', review: true, maxPages: 40 });
  const other = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

let photoJob;

test('photos: GPT reads the pages, the second run checks them, questions are asked', async () => {
  calls.length = 0;
  const created = await json(await post('/jobs', { kind: 'images', files: 2 }));
  // starting before all pages arrived is refused; a PDF where photos are expected too
  assert.equal((await fetch(`${base}/jobs/${created.body.id}/start`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${base}/jobs/${created.body.id}/files/0`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: 'x' })).status, 415);

  const { id, done } = await scanPhotos();
  photoJob = id;
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.pages, 2);
  assert.equal(done.reviewed, true);
  assert.equal(done.title, 'Evening Rise');

  // Reading: page 1 first (it names the parts), then the rest; every call with its page image.
  const reads = calls.filter((c) => c.schema === 'omr_page_transcription');
  assert.deepEqual(reads.map((c) => c.page), [1, 2]);
  const reviews = calls.filter((c) => c.schema === 'omr_page_review');
  assert.equal(reviews.length, 2);
  assert.ok(calls.every((c) => c.hasImage && c.model === 'gpt-6.1-sol'));
  assert.ok(calls.indexOf(reviews[0]) > calls.indexOf(reads[1]), 'the second run starts once every page is read');
  // The second run is pointed at what was odd: the bass bar that couldn't be read, the reading's own doubt.
  const page2 = reviews.find((c) => c.measures[0] === 5);
  assert.deepEqual(page2.measures, [5, 6, 7, 8]);
  assert.ok(page2.lookAt.some((h) => h.part === 'P6' && h.m === 6 && /couldn't be read/.test(h.note)));
  const page1 = reviews.find((c) => c.measures[0] === 1);
  assert.ok(page1.lookAt.some((h) => h.part === 'P5' && h.m === 2 && /Vorzeichen/.test(h.note)));
  assert.ok(!page1.lookAt.some((h) => h.m > 4), 'only this page’s hints');

  // The report: both misreadings put back, the broken suggestion refused, voices named.
  assert.equal(done.reports.length, 2);
  assert.equal(done.reports[0].measures, '1–4');
  assert.deepEqual(done.reports[0].applied.map((a) => [a.part, a.measure]), [['Sopran', '1']]);
  assert.deepEqual(done.reports[1].applied.map((a) => [a.part, a.measure]), [['Bass', '6']]);
  for (const r of done.reports) {
    assert.equal(r.rejected.length, 1, 'the broken correction is refused');
    assert.match(r.rejected[0].detail, /lasts/);
  }

  // Questions: one per page, with where the bar stands on its page; options as labels only.
  assert.equal(done.questions.length, 2);
  const [q1, q2] = done.questions;
  assert.deepEqual([q1.id, q1.page, q1.m, q1.measure, q1.part, q1.status], ['p1q1', 0, 3, '3', 'Melodie', 'open']);
  assert.deepEqual(q1.options, ['H, wie gelesen', 'C']);
  // the bar in the Melodie's row of the system (the second part from the top)
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  assert.ok(near([q1.box.x0, q1.box.x1, q1.box.y0, q1.box.y1], [0.552, 0.765, 0.054 + 0.0605, 0.054 + 2 * 0.0605]), JSON.stringify(q1.box));
  assert.ok(near([done.marks.find((m) => m.part === 'Alt 1').box.y0], [0.442 + 2 * 0.0616]));
  assert.equal(q2.m, 7);
  assert.equal(q1.partId, undefined);
  // Places to check: the doubt left after the second run, and the open questions.
  assert.deepEqual(done.marks.map((m) => [m.m, m.part]), [[3, 'Melodie'], [7, 'Alt 1'], [7, 'Melodie']]);

  const res = await fetch(`${base}/jobs/${id}/result`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<work-title>Evening Rise<\/work-title>/);
  assert.match(xml, /<part-name>Sopran<\/part-name>/);
  assert.match(xml, /<clef><sign>G<\/sign><line>2<\/line><clef-octave-change>-1<\/clef-octave-change><\/clef>/);
  assert.match(xml, /<rehearsal>A<\/rehearsal>/);
  assert.match(xml, /<rehearsal>B<\/rehearsal>/, 'a mark added in the second run');
  assert.match(xml, /<per-minute>72<\/per-minute>/);
  assert.match(xml, /<bar-style>light-heavy<\/bar-style>/);
  assert.match(xml, /<print new-page="yes"\/>/);
  // Read back: the misreadings are put back, so the piece reads as the real Evening Rise.
  const truth = compactPage(parseXml(readFileSync(new URL('../../public/evening-rise.musicxml', import.meta.url), 'utf8')), [0, 1, 2, 3, 4, 5, 6, 7]);
  const read = compactPage(parseXml(xml), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(read.measures[0].parts.P1[0].notes[0], 'E4 1/2 :Eve-');
  assert.deepEqual(read.measures.map((m) => m.parts), truth.measures.map((m) => m.parts));
});

test('the page images can be fetched, for showing a question’s bar', async () => {
  const p0 = await fetch(`${base}/jobs/${photoJob}/pages/0`);
  assert.equal(p0.status, 200);
  assert.equal(p0.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await p0.arrayBuffer()).toString(), 'page0');
  const p1 = await fetch(`${base}/jobs/${photoJob}/pages/1`);
  assert.equal(p1.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/jobs/${photoJob}/pages/2`)).status, 404);
  assert.equal((await fetch(`${base}/jobs/${photoJob}/pages/x`)).status, 404);
});

test('answers: a choice is written as it is, a typed answer through GPT', async () => {
  calls.length = 0;
  const before = await (await fetch(`${base}/jobs/${photoJob}/result`)).text();
  const sent = await json(await post(`/jobs/${photoJob}/answers`, { answers: [{ id: 'p1q1', choice: 1 }, { id: 'p2q1', text: 'Der erste Ton ist ein D' }, { id: 'nope', skip: true }] }));
  assert.equal(sent.status, 202);
  assert.equal(sent.body.status, 'answering');
  assert.equal((await post(`/jobs/${photoJob}/answers`, { answers: [] })).status, 409, 'one round at a time');
  const done = await waitFor(photoJob, ['done']);
  const [q1, q2] = done.questions;
  assert.deepEqual([q1.status, q1.answer], ['answered', 'C']);
  assert.deepEqual([q2.status, q2.answer, q2.note], ['answered', 'Der erste Ton ist ein D', 'Erster Ton auf D geändert']);
  const typed = calls.filter((c) => c.schema === 'omr_answer');
  assert.equal(typed.length, 1);
  assert.ok(typed[0].hasImage);
  assert.deepEqual([typed[0].payload.part, typed[0].payload.m, typed[0].payload.time, typed[0].payload.fifths], ['P2', 7, '4/4', 1]);
  assert.deepEqual(done.marks.map((m) => [m.m, m.part]), [[7, 'Alt 1']], 'answered questions are no longer places to check');
  const after = await (await fetch(`${base}/jobs/${photoJob}/result`)).text();
  assert.notEqual(after, before);
  assert.match(after, /<step>C<\/step><octave>5<\/octave>/);
  assert.match(after, /<step>D<\/step><octave>5<\/octave>/);
  // Answered questions aren't asked again.
  await post(`/jobs/${photoJob}/answers`, { answers: [{ id: 'p1q1', choice: 0 }] });
  assert.equal((await waitFor(photoJob, ['done'])).questions[0].answer, 'C');
});

test('an answer that can’t be used leaves the place marked', async () => {
  const { id, done } = await scanPhotos();
  assert.equal(done.status, 'done');
  await post(`/jobs/${id}/answers`, { answers: [{ id: 'p1q1', text: 'weiß nicht, unklar' }, { id: 'p2q1', skip: true }] });
  const after = await waitFor(id, ['done']);
  assert.equal(after.questions[0].status, 'failed');
  assert.match(after.questions[0].note, /bleibt markiert/);
  assert.equal(after.questions[1].status, 'skipped');
  assert.equal(after.marks.length, 3);
});

test('PDF path and input checks', async () => {
  assert.equal((await post('/jobs', { kind: 'images', files: 41 })).status, 400);
  assert.equal((await post('/jobs', { kind: 'pdf', files: 2 })).status, 400);
  const { body } = await json(await post('/jobs', { kind: 'pdf', files: 1, name: 'Heft' }));
  await fetch(`${base}/jobs/${body.id}/files/0`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF' });
  await fetch(`${base}/jobs/${body.id}/start`, { method: 'POST' });
  const done = await waitFor(body.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.pages, 2);
  assert.equal(done.title, 'Evening Rise');
  assert.equal((await fetch(`${base}/jobs/nope`)).status, 404);
});

test('finished scans and their questions survive a restart of the service', async () => {
  server.kill();
  await new Promise((r) => server.once('exit', r));
  server = await startServer();
  const again = await json(await fetch(`${base}/jobs/${photoJob}`));
  assert.equal(again.body.status, 'done');
  assert.equal(again.body.questions[0].status, 'answered');
  assert.equal(again.body.marks.length, 1);
  const res = await fetch(`${base}/jobs/${photoJob}/result`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<step>D<\/step><octave>5<\/octave>/);
  assert.equal((await fetch(`${base}/jobs/${photoJob}/pages/0`)).status, 200);
});

test('with OMR_ENGINE=audiveris, Audiveris reads and GPT checks as before', async () => {
  const port = PORT + 2;
  const other = await startServer(port, { OMR_ENGINE: 'audiveris', OMR_WORK_DIR: mkdtempSync(join(tmpdir(), 'omr-test-')) });
  try {
    const at = `http://localhost:${port}`;
    assert.equal((await json(await fetch(`${at}/healthz`))).body.engine, 'audiveris');
    calls.length = 0;
    const { done } = await scanPhotos(at);
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.reports[0].measures, '1–4');
    assert.ok(!calls.some((c) => c.schema === 'omr_page_transcription'));
    assert.equal(calls.filter((c) => c.schema === 'omr_page_review').length, 2);
    assert.equal(done.questions[0].box, null, 'no layout from Audiveris');
  } finally {
    other.kill();
  }
});

test('without an OpenAI key, GPT reading is refused up front', async () => {
  const port = PORT + 3;
  const other = await startServer(port, { OPENAI_API_KEY: '', OMR_WORK_DIR: mkdtempSync(join(tmpdir(), 'omr-test-')) });
  try {
    const at = `http://localhost:${port}`;
    assert.deepEqual((await json(await fetch(`${at}/healthz`))).body, { ok: false, engine: 'gpt', review: false, maxPages: 40 });
    const r = await fetch(`${at}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'pdf', files: 1 }) });
    assert.equal(r.status, 503);
  } finally {
    other.kill();
  }
});
