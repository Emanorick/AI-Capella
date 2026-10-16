// One scan job: uploaded pages -> one image per page -> GPT reads every page into notes (or
// Audiveris does, with OMR_ENGINE=audiveris) -> MusicXML -> automatic plausibility checks -> the
// second run: GPT checks every page against its image, looking closely where the checks found
// something odd -> questions for the person who scanned where it still can't tell, answered in
// the app afterwards (answerQuestions). Jobs live in memory on the one service instance and on
// disk, and are cleaned up after a few hours.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Document } from '@xmldom/xmldom';
import type { PageImage } from './ai.js';
import { buildScore, type Box } from './build.js';
import { plausibility } from './checks.js';
import { applyMeasure, compactPage, CorrectionError, getTitle, measuresByPage, mergeMovements, parseXml, readMxl, serializeXml, setTitle } from './score.js';
import { nameVoices, reviewPage, voicesFromAnswer, type Doubt, type Hint, type PageReport, type Question } from './review.js';
import { adoptParts, readPage, stitch, type PageReading } from './transcribe.js';

export const MAX_PAGES = 40;
const AUDIVERIS = process.env.AUDIVERIS_CMD || '/opt/audiveris/bin/Audiveris';
const WORK_ROOT = process.env.OMR_WORK_DIR || '/tmp/omr';
const CONCURRENCY = Math.max(1, Number(process.env.REVIEW_CONCURRENCY) || 4);
const AUDIVERIS_TIMEOUT_MS = 40 * 60 * 1000;
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
/** Who reads the notes first: GPT (the default) or Audiveris. */
export const ENGINE: 'gpt' | 'audiveris' = process.env.OMR_ENGINE === 'audiveris' ? 'audiveris' : 'gpt';
export const REVIEW_ENABLED = !!process.env.OPENAI_API_KEY;
/** Without an OpenAI key, only Audiveris can read. */
export const READY = ENGINE === 'audiveris' || REVIEW_ENABLED;

export type JobKind = 'pdf' | 'images';
export type JobStatus = 'uploading' | 'queued' | 'recognizing' | 'reviewing' | 'done' | 'answering' | 'failed';

/** A place the singers should look at: a doubt left after the second run, or a question left unanswered. */
export interface ScanMark {
  m: number;
  measure: string;
  part: string; // the voice's name, "" for all
  note: string;
  page: number;
  box: Box | null;
}

export interface Job {
  id: string;
  uid: string;
  kind: JobKind;
  name: string;
  lang: 'de' | 'en';
  engine: 'gpt' | 'audiveris';
  expectedFiles: number;
  files: (string | null)[];
  status: JobStatus;
  progress: { done: number; total: number };
  error: string;
  createdAt: number;
  finishedAt: number;
  pages: number;
  pageFiles: string[]; // one image per page
  // Per measure (m - 1): where it stands on its page, and each part's row in it (GPT reading only).
  layout: { page: number; box: Box | null; rows?: Record<string, [number, number]> }[];
  title: string;
  result: string | null;
  reports: PageReport[];
  reviewed: boolean;
  questions: Question[];
  doubts: Doubt[];
  notes: string[];
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = false;

const say = (job: Pick<Job, 'lang'>, de: string, en: string) => (job.lang === 'de' ? de : en);

/** Jobs of this user that are still uploading or being worked on. */
export function activeJobs(uid: string): number {
  let n = 0;
  for (const job of jobs.values()) if (job.uid === uid && job.status !== 'done' && job.status !== 'failed' && Date.now() - job.createdAt < 60 * 60 * 1000) n++;
  return n;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export async function createJob(uid: string, kind: JobKind, files: number, name: string, lang: 'de' | 'en' = 'en'): Promise<Job> {
  cleanup();
  const job: Job = {
    id: randomUUID(),
    uid,
    kind,
    name: name.slice(0, 200),
    lang,
    engine: ENGINE,
    expectedFiles: files,
    files: Array(files).fill(null),
    status: 'uploading',
    progress: { done: 0, total: 0 },
    error: '',
    createdAt: Date.now(),
    finishedAt: 0,
    pages: 0,
    pageFiles: [],
    layout: [],
    title: '',
    result: null,
    reports: [],
    reviewed: false,
    questions: [],
    doubts: [],
    notes: [],
  };
  jobs.set(job.id, job);
  await mkdir(dir(job), { recursive: true });
  return job;
}

const dir = (job: Job) => join(WORK_ROOT, job.id);

export async function storeFile(job: Job, index: number, ext: string, body: Buffer) {
  const path = join(dir(job), `in-${String(index + 1).padStart(2, '0')}.${ext}`);
  await writeFile(path, body);
  job.files[index] = path;
}

export function startJob(job: Job) {
  job.status = 'queued';
  queue.push(job);
  void pump();
}

/** One job at a time: the machine's memory and CPU (Audiveris), or the API's rate limits (GPT). */
async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    await run(job);
    job.status = 'done';
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    console.error(`job ${job.id} failed:`, err);
  } finally {
    job.finishedAt = Date.now();
    await persist(job);
    running = false;
    void rm(join(dir(job), 'audiveris'), { recursive: true, force: true });
    void pump();
  }
}

/** Finished scans are kept on disk too, so a restart of the service doesn't lose them. */
async function persist(job: Job) {
  try {
    const { result, ...meta } = job;
    if (result) await writeFile(join(dir(job), 'result.musicxml'), result);
    await writeFile(join(dir(job), 'job.json'), JSON.stringify(meta));
  } catch (err) {
    console.error(`could not save job ${job.id}:`, err);
  }
}

/** Loads the finished scans saved before a restart; scans that were still running are gone. */
export async function restoreJobs() {
  const entries = await readdir(WORK_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(WORK_ROOT, entry.name);
    try {
      const meta = JSON.parse(await readFile(join(folder, 'job.json'), 'utf8')) as Omit<Job, 'result'>;
      // Answers being written when the service stopped are lost; the questions stay open.
      if (meta.status === 'answering') meta.status = 'done';
      const result = meta.status === 'done' ? await readFile(join(folder, 'result.musicxml'), 'utf8') : null;
      // (Saved by an older version: no questions, no page images.)
      const older: Partial<Job> = { engine: 'audiveris', pageFiles: [], layout: [], questions: [], doubts: [] };
      jobs.set(meta.id, { ...older, ...meta, result } as Job);
    } catch {
      // no saved state: a scan interrupted by the restart
      void rm(folder, { recursive: true, force: true });
    }
  }
  cleanup();
}

function cleanup() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (now - job.createdAt > JOB_TTL_MS && (job.status === 'done' || job.status === 'failed' || job.status === 'uploading')) {
      jobs.delete(job.id);
      void rm(dir(job), { recursive: true, force: true });
    }
  }
}

function exec(cmd: string, args: string[], opts: { timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let tail = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      out += s;
      tail = (tail + s).slice(-4000);
      if (opts.onLine) for (const line of s.split('\n')) if (line.trim()) opts.onLine(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd.split('/').pop()} ${signal ? `was stopped (${signal})` : `exited with ${code}`}: ${tail.split('\n').slice(-6).join(' ').trim()}`));
    });
  });
}

async function findFiles(root: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && re.test(entry.name)) out.push(join(entry.parentPath ?? root, entry.name));
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const MEDIA: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
export const mediaTypeOf = (path: string) => MEDIA[extname(path).toLowerCase()] ?? 'image/jpeg';

async function pageImage(path: string): Promise<PageImage> {
  return { mediaType: mediaTypeOf(path), base64: (await readFile(path)).toString('base64') };
}

/** Runs `fn` over `items`, a few at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function run(job: Job) {
  const work = dir(job);
  const inputs = job.files.filter((f): f is string => !!f);

  // 1. One image per page (photos as they came; a PDF at 200 dpi).
  let pdf: string | null = null;
  if (job.kind === 'images') {
    job.pageFiles = inputs;
  } else {
    pdf = inputs[0];
    const info = await exec('pdfinfo', [pdf]);
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (!pages) throw new Error(say(job, 'Das PDF ließ sich nicht lesen', 'Could not read the PDF'));
    if (pages > MAX_PAGES) throw new Error(say(job, `Das PDF hat ${pages} Seiten – höchstens ${MAX_PAGES} sind möglich`, `The PDF has ${pages} pages -- at most ${MAX_PAGES} are possible`));
    await exec('pdftoppm', ['-r', '200', '-jpeg', '-jpegopt', 'quality=85', pdf, join(work, 'page')]);
    job.pageFiles = await findFiles(work, /^page-\d+\.jpg$/);
  }
  job.pages = job.pageFiles.length;
  if (!job.pages) throw new Error(say(job, 'Keine Seiten gefunden', 'No pages found'));

  // 2. The first reading.
  job.status = 'recognizing';
  job.progress = { done: 0, total: job.pages };
  let doc: Document;
  let hints: Hint[] = [];
  let title = '';
  let groups: number[][];
  if (job.engine === 'gpt') {
    if (!REVIEW_ENABLED) throw new Error(say(job, 'Der Scan-Dienst ist nicht fertig eingerichtet (kein OpenAI-Schlüssel)', 'The scan service is not set up (no OpenAI key)'));
    ({ doc, hints, title } = await readWithGpt(job));
    groups = Array.from({ length: job.pages }, () => [] as number[]);
    job.layout.forEach((l, i) => groups[l.page]?.push(i));
  } else {
    doc = await readWithAudiveris(job, pdf);
    groups = measuresByPage(doc, job.pages);
    if (groups.length !== job.pages) job.notes.push(say(job, `Audiveris hat ${groups.length} von ${job.pages} Seiten gefunden`, `Audiveris found ${groups.length} of ${job.pages} pages`));
  }
  job.progress.done = job.pages;

  // 3. What a careful reader would frown at: the second run looks there first.
  hints.push(...plausibility(doc));

  // 4. The second run, page by page, a few at a time.
  if (REVIEW_ENABLED) {
    job.status = 'reviewing';
    job.progress = { done: 0, total: groups.length };
    const reports: PageReport[] = [];
    const questions: Question[][] = [];
    const doubts: Doubt[][] = [];
    await eachLimited(groups, CONCURRENCY, async (idx, i) => {
      const image = await pageImage(job.pageFiles[Math.min(i, job.pages - 1)]);
      const onPage = new Set(idx.map((k) => k + 1));
      const r = await reviewPage(doc, i, idx, image, job.lang, hints.filter((h) => onPage.has(h.m)));
      reports[i] = r.report;
      questions[i] = r.questions;
      doubts[i] = r.doubts;
      if (r.title && (i === 0 || !title)) title = r.title;
      job.progress.done++;
    });
    job.reports = reports;
    job.questions = questions.flat();
    job.doubts = doubts.flat();
    nameVoices(doc, job.reports, job.questions, job.doubts);
    for (const x of [...job.questions, ...job.doubts]) x.box = boxOf(job, x.m, x.partId);
    job.reviewed = true;
  } else {
    job.notes.push(say(job, 'Der zweite Durchgang ist auf dem Server nicht eingerichtet (kein OpenAI-Schlüssel) – das ist die Lesart von Audiveris allein', 'The second run is not set up on the server (no OPENAI_API_KEY) -- this is Audiveris’ reading alone'));
  }

  title ||= getTitle(doc) || job.name;
  if (title) setTitle(doc, title);
  job.title = title;
  job.result = serializeXml(doc);
  const size = (await stat(pdf ?? inputs[0]).catch(() => null))?.size ?? 0;
  console.log(
    `job ${job.id} (${job.engine}): ${job.pages} pages, ${Math.round(size / 1024)} KB input, ${hints.length} hints, ` +
      `${job.reports.reduce((n, r) => n + r.applied.length, 0)} corrections, ${job.questions.length} questions, ${job.doubts.length} doubts`,
  );
}

/** Where a bar stands on its page: in one part's row when it's about one part, else the whole system. */
function boxOf(job: Job, m: number, partId: string): Box | null {
  const l = job.layout[m - 1];
  if (!l?.box) return null;
  const row = partId ? l.rows?.[partId] : undefined;
  return row ? { ...l.box, y0: row[0], y1: row[1] } : l.box;
}

/** GPT reads the first page (which names the parts), then the others, a few at a time. */
async function readWithGpt(job: Job): Promise<{ doc: Document; hints: Hint[]; title: string }> {
  const readings: (PageReading | null)[] = Array(job.pages).fill(null);
  const read = async (i: number, parts: Parameters<typeof readPage>[3]) => {
    const image = await pageImage(job.pageFiles[i]);
    // A second try for an answer that came back unusable (network errors the client retries itself).
    for (let attempt = 1; ; attempt++) {
      try {
        return await readPage(image, i, job.pages, parts, job.lang);
      } catch (err) {
        if (attempt >= 2) throw err;
        console.warn(`job ${job.id}: page ${i + 1} read failed, trying again:`, err instanceof Error ? err.message : err);
      }
    }
  };
  readings[0] = await read(0, null);
  const parts = adoptParts(readings[0]);
  if (!parts.length || !readings[0].measures.length) throw new Error(say(job, 'Auf der ersten Seite wurden keine Noten gefunden', 'No music was found on the first page'));
  job.progress.done = 1;
  const missing: number[] = [];
  await eachLimited(
    Array.from({ length: job.pages - 1 }, (_, k) => k + 1),
    CONCURRENCY,
    async (i) => {
      try {
        readings[i] = await read(i, parts);
      } catch (err) {
        console.error(`job ${job.id}: page ${i + 1} could not be read:`, err);
        missing.push(i + 1);
      }
      job.progress.done++;
    },
  );
  if (missing.length) {
    missing.sort((a, b) => a - b);
    job.notes.push(say(job, `Seite ${missing.join(', ')} konnte nicht gelesen werden und fehlt im Ergebnis`, `Page ${missing.join(', ')} could not be read and is missing from the result`));
  }
  // Pages left out keep their place, so measures still know which image they are on.
  const pages = readings.map((r) => r ?? { parts: [], systems: [], measures: [], stackedVerses: [], doubts: [], title: '', confidence: 'low' as const });
  const { transcript, hints, title } = stitch(pages, parts);
  if (!transcript.measures.length) throw new Error(say(job, 'Es wurden keine Takte gefunden', 'No measures were found'));
  job.layout = transcript.measures.map((m) => ({ page: m.page, box: m.box, rows: m.rows }));
  const low = pages.flatMap((p, i) => (readings[i] && p.confidence === 'low' ? [i + 1] : []));
  if (low.length) console.log(`job ${job.id}: first reading unsure of page(s) ${low.join(', ')}`);
  return { doc: parseXml(serializeXml(buildScore(transcript))), hints, title };
}

/** Audiveris reads all pages as one book (one PDF), so the result is one score across them. */
async function readWithAudiveris(job: Job, pdf: string | null): Promise<Document> {
  const work = dir(job);
  if (!pdf) {
    pdf = join(work, 'scan.pdf');
    await exec('img2pdf', [...job.pageFiles, '-o', pdf]);
  }
  // Audiveris logs the sheet it's working on as "[scan#3]"-style prefixes.
  const outDir = join(work, 'audiveris');
  await mkdir(outDir, { recursive: true });
  await exec(AUDIVERIS, ['-batch', '-transcribe', '-export', '-output', outDir, '--', pdf], {
    timeoutMs: AUDIVERIS_TIMEOUT_MS,
    onLine: (line) => {
      const m = line.match(/#(\d+)\]/);
      if (m) job.progress.done = Math.min(job.pages, Math.max(job.progress.done, Number(m[1]) - 1));
    },
  });
  const mxls = await findFiles(outDir, /\.mxl$/i);
  if (!mxls.length) throw new Error(say(job, 'Audiveris hat auf diesen Seiten keine Noten erkannt', 'Audiveris recognized no music on these pages'));
  const docs: Document[] = [];
  for (const f of mxls) docs.push(parseXml(readMxl(new Uint8Array(await readFile(f)))));
  const { doc, dropped } = mergeMovements(docs);
  if (dropped) job.notes.push(say(job, `${dropped} Abschnitt(e) mit anderer Stimmenzahl wurden weggelassen`, `${dropped} section(s) with a different number of voices were left out`));
  return doc;
}

// ---- after the scan: the questions answered -------------------------------------------------------

export interface AnswerIn {
  id: string;
  choice?: number; // index of the option chosen
  text?: string; // or typed in
  skip?: boolean; // or left as it is
}

/** The places the singers should look at once the piece is in the repertoire. */
export function marksOf(job: Job): ScanMark[] {
  const marks: ScanMark[] = job.doubts.map((d) => ({ m: d.m, measure: d.measure, part: d.part, note: d.note, page: d.page, box: d.box }));
  for (const q of job.questions) {
    if (q.status === 'answered') continue;
    marks.push({ m: q.m, measure: q.measure, part: q.part, note: q.question, page: q.page, box: q.box });
  }
  return marks.sort((a, b) => a.m - b.m);
}

/**
 * Writes the answers to the scan's open questions into its result: a chosen reading as it is, a
 * typed answer through GPT (which turns it into notes, looking at the page). Runs in the
 * background; the job is "answering" meanwhile, "done" again after.
 */
export function answerQuestions(job: Job, answers: AnswerIn[]) {
  if (job.status !== 'done' || !job.result) throw new Error('not finished');
  const byId = new Map(job.questions.map((q) => [q.id, q]));
  const todo = answers
    .map((a) => ({ a, q: byId.get(String(a.id)) }))
    .filter((x): x is { a: AnswerIn; q: Question } => !!x.q && (x.q.status === 'open' || x.q.status === 'failed'));
  job.status = 'answering';
  job.progress = { done: 0, total: todo.length };
  void (async () => {
    try {
      const doc = parseXml(job.result!);
      await eachLimited(todo, CONCURRENCY, async ({ a, q }) => {
        await answerOne(job, doc, q, a);
        job.progress.done++;
      });
      job.result = serializeXml(doc);
    } catch (err) {
      console.error(`job ${job.id}: answers failed:`, err);
    } finally {
      job.status = 'done';
      await persist(job);
    }
  })();
}

async function answerOne(job: Job, doc: Document, q: Question, a: AnswerIn) {
  const text = typeof a.text === 'string' ? a.text.trim().slice(0, 500) : '';
  const choice = Number.isInteger(a.choice) ? (a.choice as number) : -1;
  if (a.skip || (choice < 0 && !text)) {
    q.status = 'skipped';
    q.answer = '';
    return;
  }
  try {
    if (choice >= 0 && choice < q.options.length) {
      q.answer = q.options[choice].label;
      applyMeasure(doc, q.partId, q.m, q.options[choice].voices);
      q.note = '';
    } else {
      q.answer = text;
      if (!REVIEW_ENABLED) throw new CorrectionError('no OpenAI key');
      const cm = compactPage(doc, [q.m - 1]).measures[0];
      if (!cm) throw new CorrectionError('measure not found');
      const image = await pageImage(job.pageFiles[Math.min(q.page, job.pages - 1)]);
      const out = await voicesFromAnswer(image, { part: q.partId, m: q.m, question: q.question, current: cm.parts[q.partId] ?? [], time: cm.time, fifths: cm.fifths, answer: text }, job.lang);
      if (!out) throw new CorrectionError('the answer could not be turned into notes');
      applyMeasure(doc, q.partId, q.m, out.voices);
      q.note = out.note;
    }
    q.status = 'answered';
  } catch (err) {
    // An API error, an answer GPT couldn't make notes of, or notes that don't fill the bar.
    console.warn(`job ${job.id}: answer to ${q.id} not applied:`, err instanceof Error ? err.message : err);
    q.status = 'failed';
    q.note = say(job, 'Ließ sich nicht übernehmen – die Stelle bleibt markiert', 'Could not be applied – the place stays marked');
  }
}
