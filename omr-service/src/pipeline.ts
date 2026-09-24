// One scan job: uploaded pages -> (images into one PDF) -> Audiveris -> MusicXML -> GPT check of
// every page against its image -> checked MusicXML plus a report. Jobs live in memory on the one
// service instance (max-instances 1) and are cleaned up after a few hours.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Document } from '@xmldom/xmldom';
import { getTitle, measuresByPage, mergeMovements, parseXml, readMxl, serializeXml, setTitle } from './score.js';
import { nameVoices, reviewPage, type PageReport } from './review.js';

export const MAX_PAGES = 40;
const AUDIVERIS = process.env.AUDIVERIS_CMD || '/opt/audiveris/bin/Audiveris';
const WORK_ROOT = process.env.OMR_WORK_DIR || '/tmp/omr';
const REVIEW_CONCURRENCY = Math.max(1, Number(process.env.REVIEW_CONCURRENCY) || 4);
const AUDIVERIS_TIMEOUT_MS = 40 * 60 * 1000;
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
export const REVIEW_ENABLED = !!process.env.OPENAI_API_KEY;

export type JobKind = 'pdf' | 'images';
export type JobStatus = 'uploading' | 'queued' | 'recognizing' | 'reviewing' | 'done' | 'failed';

export interface Job {
  id: string;
  uid: string;
  kind: JobKind;
  name: string;
  lang: 'de' | 'en';
  expectedFiles: number;
  files: (string | null)[];
  status: JobStatus;
  progress: { done: number; total: number };
  error: string;
  createdAt: number;
  finishedAt: number;
  pages: number;
  title: string;
  result: string | null;
  reports: PageReport[];
  reviewed: boolean;
  notes: string[];
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = false;

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
    expectedFiles: files,
    files: Array(files).fill(null),
    status: 'uploading',
    progress: { done: 0, total: 0 },
    error: '',
    createdAt: Date.now(),
    finishedAt: 0,
    pages: 0,
    title: '',
    result: null,
    reports: [],
    reviewed: false,
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

/** One job at a time: Audiveris wants the machine's memory and CPU to itself. */
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
    running = false;
    void rm(join(dir(job), 'audiveris'), { recursive: true, force: true });
    void pump();
  }
}

function cleanup() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (now - job.createdAt > JOB_TTL_MS && job.status !== 'recognizing' && job.status !== 'reviewing') {
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

async function run(job: Job) {
  const work = dir(job);
  const inputs = job.files.filter((f): f is string => !!f);
  let pdf: string;
  let pageImages: string[];

  // 1. One PDF for Audiveris (one "book", so the result is one score across all pages), and one
  //    image per page for the check.
  if (job.kind === 'images') {
    pdf = join(work, 'scan.pdf');
    await exec('img2pdf', [...inputs, '-o', pdf]);
    pageImages = inputs;
  } else {
    pdf = inputs[0];
    const info = await exec('pdfinfo', [pdf]);
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    if (!pages) throw new Error('Could not read the PDF');
    if (pages > MAX_PAGES) throw new Error(`The PDF has ${pages} pages -- at most ${MAX_PAGES} are possible`);
    await exec('pdftoppm', ['-r', '150', '-jpeg', '-jpegopt', 'quality=85', pdf, join(work, 'page')]);
    pageImages = await findFiles(work, /^page-\d+\.jpg$/);
  }
  job.pages = pageImages.length;

  // 2. Recognition. Audiveris logs the sheet it's working on as "[scan#3]"-style prefixes.
  job.status = 'recognizing';
  job.progress = { done: 0, total: job.pages };
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
  if (!mxls.length) throw new Error('Audiveris recognized no music on these pages');
  const docs: Document[] = [];
  for (const f of mxls) docs.push(parseXml(readMxl(new Uint8Array(await readFile(f)))));
  const { doc, dropped } = mergeMovements(docs);
  if (dropped) job.notes.push(`${dropped} section(s) with a different number of voices were left out`);
  job.progress.done = job.pages;

  // 3. The check, page by page, a few at a time.
  const groups = measuresByPage(doc, job.pages);
  let title = '';
  if (REVIEW_ENABLED) {
    job.status = 'reviewing';
    job.progress = { done: 0, total: groups.length };
    const reports: PageReport[] = [];
    let next = 0;
    const worker = async () => {
      while (next < groups.length) {
        const i = next++;
        const imagePath = pageImages[Math.min(i, pageImages.length - 1)];
        const image = { mediaType: 'image/jpeg', base64: (await readFile(imagePath)).toString('base64') };
        const { report, title: pageTitle } = await reviewPage(doc, i, groups[i], image, job.lang);
        reports[i] = report;
        if (i === 0 && pageTitle) title = pageTitle;
        job.progress.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, groups.length) }, worker));
    nameVoices(doc, reports);
    job.reports = reports;
    job.reviewed = true;
  } else {
    job.notes.push('The GPT check is not set up on the server (no OPENAI_API_KEY) -- this is Audiveris’ reading alone');
  }
  if (groups.length !== job.pages) job.notes.push(`Audiveris found ${groups.length} of ${job.pages} pages`);

  title ||= getTitle(doc) || job.name;
  if (title) setTitle(doc, title);
  job.title = title;
  job.result = serializeXml(doc);
  const size = (await stat(pdf).catch(() => null))?.size ?? 0;
  console.log(`job ${job.id}: ${job.pages} pages, ${Math.round(size / 1024)} KB input, ${job.reports.reduce((n, r) => n + r.applied.length, 0)} corrections`);
}
