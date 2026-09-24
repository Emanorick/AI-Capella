// The whole API with stand-ins for Audiveris, the PDF tools and OpenAI (test/mocks).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeOpenAI, calls } from './mocks/openai.mjs';

const PORT = 18190;
const AI_PORT = 18191;
const base = `http://localhost:${PORT}`;
const mocks = new URL('./mocks/bin/', import.meta.url).pathname;
let server, ai;

before(async () => {
  ai = await startFakeOpenAI(AI_PORT);
  server = spawn('node', ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PATH: `${mocks}:${process.env.PATH}`,
      AUDIVERIS_CMD: join(mocks, 'audiveris'),
      OMR_SKIP_AUTH: '1',
      OMR_WORK_DIR: mkdtempSync(join(tmpdir(), 'omr-test-')),
      OPENAI_API_KEY: 'test',
      OPENAI_BASE_URL: `http://localhost:${AI_PORT}/v1`,
      ALLOWED_ORIGINS: 'http://localhost:5200',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('OMR service') && resolve()));
});
after(() => {
  server.kill();
  ai.close();
});

const json = async (res) => ({ status: res.status, body: await res.json() });

async function waitDone(id) {
  for (let i = 0; i < 100; i++) {
    const { body } = await json(await fetch(`${base}/jobs/${id}`));
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

test('health and CORS', async () => {
  const res = await fetch(`${base}/healthz`, { headers: { Origin: 'http://localhost:5200' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5200');
  assert.deepEqual(await res.json(), { ok: true, review: true, maxPages: 40 });
  const other = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('photos: upload, recognize, check, result', async () => {
  const created = await json(await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'images', files: 2, name: 'Fotos' }) }));
  assert.equal(created.status, 201);
  const id = created.body.id;
  // starting before all pages arrived is refused
  assert.equal((await fetch(`${base}/jobs/${id}/start`, { method: 'POST' })).status, 409);
  for (const i of [1, 0]) {
    const r = await fetch(`${base}/jobs/${id}/files/${i}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('fakejpg') });
    assert.equal(r.status, 200);
  }
  assert.equal((await fetch(`${base}/jobs/${id}/files/0`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: 'x' })).status, 415);
  assert.equal((await fetch(`${base}/jobs/${id}/start`, { method: 'POST' })).status, 200);
  const done = await waitDone(id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.pages, 2);
  assert.equal(done.reviewed, true);
  assert.equal(done.title, 'Evening Rise (geprüft)');
  assert.equal(done.reports.length, 2);
  assert.equal(done.reports[0].measures, '1–4');
  for (const r of done.reports) {
    assert.equal(r.applied.length, 1);
    assert.equal(r.rejected.length, 1, 'the broken correction is refused');
    assert.match(r.rejected[0].detail, /lasts/);
    assert.equal(r.applied[0].part, 'Sopran', 'report names the voice');
  }
  assert.ok(calls.length >= 2 && calls.every((c) => c.hasImage && c.schema === 'omr_page_review'));
  assert.deepEqual(calls.map((c) => c.measures[0]).sort((a, b) => a - b).slice(-2), [1, 5]);

  const res = await fetch(`${base}/jobs/${id}/result`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<work-title>Evening Rise \(geprüft\)<\/work-title>/);
  assert.match(xml, /<part-name>Sopran<\/part-name>/);
  assert.match(xml, /<step>C<\/step><alter>1<\/alter><octave>5<\/octave>/);
});

test('PDF path and input checks', async () => {
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'images', files: 41 }) })).status, 400);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'pdf', files: 2 }) })).status, 400);
  const { body } = await json(await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify({ kind: 'pdf', files: 1, name: 'Heft' }) }));
  await fetch(`${base}/jobs/${body.id}/files/0`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF' });
  await fetch(`${base}/jobs/${body.id}/start`, { method: 'POST' });
  const done = await waitDone(body.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.pages, 2);
  assert.equal((await fetch(`${base}/jobs/nope`)).status, 404);
});
