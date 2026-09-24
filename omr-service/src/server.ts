// HTTP API for the app's "Scan sheet music" dialog. Every request carries the app's Firebase ID
// token (the anonymous sign-in every AI-Capella device already has), and a job is only visible to
// the device that created it.
//
//   POST /jobs                   {kind: "pdf" | "images", files: n, name, lang: "de" | "en"}  -> {id, maxPages}
//   PUT  /jobs/:id/files/:index  raw file body (application/pdf, image/jpeg, image/png)
//   POST /jobs/:id/start
//   GET  /jobs/:id               status, progress, report
//   GET  /jobs/:id/result        the MusicXML
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { activeJobs, createJob, getJob, MAX_PAGES, REVIEW_ENABLED, startJob, storeFile, type Job, type JobKind } from './pipeline.js';

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Local testing only -- never set on the deployed service.
const SKIP_AUTH = process.env.OMR_SKIP_AUTH === '1';
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_ACTIVE_JOBS_PER_USER = 2;

if (!SKIP_AUTH) initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'ai-capella' });

const FILE_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
}

async function userId(req: IncomingMessage): Promise<string> {
  if (SKIP_AUTH) return 'local';
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, 'Not signed in');
  try {
    return (await getAuth().verifyIdToken(token)).uid;
  } catch {
    throw new HttpError(401, 'Sign-in could not be verified');
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `File too large (max ${Math.round(limit / 1024 / 1024)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function ownJob(id: string, uid: string): Job {
  const job = getJob(id);
  if (!job || job.uid !== uid) throw new HttpError(404, 'This scan is no longer available');
  return job;
}

function publicJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    pages: job.pages,
    title: job.title,
    reviewed: job.reviewed,
    reports: job.reports,
    notes: job.notes,
    uploaded: job.files.filter(Boolean).length,
    expectedFiles: job.expectedFiles,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, review: REVIEW_ENABLED, maxPages: MAX_PAGES });

  const uid = await userId(req);

  if (req.method === 'POST' && parts.length === 1 && parts[0] === 'jobs') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
    const kind = body.kind as JobKind;
    const files = Number(body.files);
    if (kind !== 'pdf' && kind !== 'images') throw new HttpError(400, 'kind must be "pdf" or "images"');
    if (!Number.isInteger(files) || files < 1 || (kind === 'pdf' ? files !== 1 : files > MAX_PAGES)) {
      throw new HttpError(400, kind === 'pdf' ? 'One PDF per scan' : `Between 1 and ${MAX_PAGES} images`);
    }
    if (activeJobs(uid) >= MAX_ACTIVE_JOBS_PER_USER) throw new HttpError(429, 'Two scans from this device are still running -- wait for one to finish');
    const job = await createJob(uid, kind, files, String(body.name ?? ''), body.lang === 'de' ? 'de' : 'en');
    return send(res, 201, { id: job.id, maxPages: MAX_PAGES, review: REVIEW_ENABLED });
  }

  if (parts[0] !== 'jobs' || !parts[1]) throw new HttpError(404, 'Not found');
  const job = ownJob(parts[1], uid);

  if (req.method === 'PUT' && parts.length === 4 && parts[2] === 'files') {
    if (job.status !== 'uploading') throw new HttpError(409, 'This scan was already started');
    const index = Number(parts[3]);
    if (!Number.isInteger(index) || index < 0 || index >= job.expectedFiles) throw new HttpError(400, 'Bad file index');
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const ext = FILE_TYPES[type];
    if (!ext || (job.kind === 'pdf') !== (ext === 'pdf')) throw new HttpError(415, job.kind === 'pdf' ? 'Expected a PDF' : 'Expected a JPEG or PNG image');
    const body = await readBody(req, MAX_FILE_BYTES);
    if (!body.length) throw new HttpError(400, 'Empty file');
    await storeFile(job, index, ext, body);
    return send(res, 200, { uploaded: job.files.filter(Boolean).length });
  }

  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'start') {
    if (job.status !== 'uploading') return send(res, 200, publicJob(job));
    if (job.files.some((f) => !f)) throw new HttpError(409, 'Not all files have arrived yet');
    startJob(job);
    return send(res, 200, publicJob(job));
  }

  if (req.method === 'GET' && parts.length === 2) return send(res, 200, publicJob(job));

  if (req.method === 'GET' && parts.length === 3 && parts[2] === 'result') {
    if (job.status !== 'done' || !job.result) throw new HttpError(409, 'Not finished yet');
    return send(res, 200, job.result, 'application/vnd.recordare.musicxml+xml; charset=utf-8');
  }

  throw new HttpError(404, 'Not found');
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : 'Server error' });
  });
}).listen(PORT, () => console.log(`AI-Capella OMR service on :${PORT} (GPT check ${REVIEW_ENABLED ? 'on' : 'off'})`));

