// "Scan sheet music": a PDF or up to 40 photos go to the scan service (omr-service/: Audiveris
// recognition, then a GPT check of every page against its image), and the checked MusicXML comes
// back into the repertoire. A running scan survives closing the sheet and reloading the page: its
// id is kept per device, and the library shows its progress.
import { getIdToken } from './firebase';
import { icon } from './icons';
import { lang, t } from './i18n';
import { closeOverlay, openSheet, toast } from './ui';

export const OMR_URL: string = (import.meta.env.VITE_OMR_URL ?? '').replace(/\/+$/, '');
export const scanAvailable = (): boolean => !!OMR_URL;

const MAX_PAGES = 40;
const MAX_EDGE_PX = 3000;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const JOB_KEY = 'ai-capella-scan-job';
const POLL_MS = 2000;

type Status = 'uploading' | 'queued' | 'recognizing' | 'reviewing' | 'done' | 'failed';

interface PageReport {
  page: number;
  measures: string;
  applied: { part: string; measure: string; reason: string }[];
  rejected: { part: string; measure: string; reason: string; detail: string }[];
  confidence: 'high' | 'medium' | 'low' | 'unchecked';
  remarks: string;
}

interface JobState {
  id: string;
  status: Status;
  progress: { done: number; total: number };
  error: string;
  pages: number;
  title: string;
  reviewed: boolean;
  reports: PageReport[];
  notes: string[];
}

interface Page {
  blob: Blob;
  url: string; // object URL for the thumbnail
}

// ---- state ------------------------------------------------------------------------------------

let pages: Page[] = [];
let pdf: File | null = null;
let name = '';
let upload: { done: number; total: number } | null = null;
let job: JobState | null = null;
let failure = ''; // an error before the service had the job (upload, start)
let pollTimer: number | null = null;
let preparing = 0;
let sheetBody: HTMLElement | null = null;
let onImport: (title: string, xml: string) => Promise<void> = async () => {};
let onStatusChange: () => void = () => {};

function readStoredJob(): { id: string; name: string } | null {
  try {
    const raw = localStorage.getItem(JOB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeJob(value: { id: string; name: string } | null) {
  try {
    if (value) localStorage.setItem(JOB_KEY, JSON.stringify(value));
    else localStorage.removeItem(JOB_KEY);
  } catch {
    // private mode: the scan still works, it just can't be resumed after a reload
  }
}

/** Wires the module to the app; picks up a scan that was still running when the page was left. */
export function initScan(opts: { onImport: (title: string, xml: string) => Promise<void>; onStatusChange: () => void }) {
  onImport = opts.onImport;
  onStatusChange = opts.onStatusChange;
  const stored = readStoredJob();
  if (stored && scanAvailable()) {
    name = stored.name;
    job = { id: stored.id, status: 'queued', progress: { done: 0, total: 0 }, error: '', pages: 0, title: '', reviewed: false, reports: [], notes: [] };
    void poll();
  }
}

/** A one-line summary for the library while a scan exists, or null. */
export function scanStatusLine(): { text: string; busy: boolean } | null {
  if (upload) return { text: t('scanUploading', { done: upload.done, total: upload.total }), busy: true };
  if (!job) return null;
  switch (job.status) {
    case 'done':
      return { text: t('scanReady'), busy: false };
    case 'failed':
      return { text: t('scanFailedShort'), busy: false };
    default:
      return { text: stepText(job), busy: true };
  }
}

function stepText(j: JobState): string {
  if (j.status === 'recognizing') return t('scanRecognizing', { done: Math.min(j.progress.done + 1, j.progress.total || 1), total: j.progress.total || '…' });
  if (j.status === 'reviewing') return t('scanReviewing', { done: Math.min(j.progress.done + 1, j.progress.total), total: j.progress.total });
  return t('scanQueued');
}

// ---- service calls ----------------------------------------------------------------------------

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken();
  const res = await fetch(`${OMR_URL}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return res;
}

async function poll() {
  if (!job) return;
  if (pollTimer != null) clearTimeout(pollTimer);
  pollTimer = null;
  try {
    const next = (await (await api(`/jobs/${job.id}`)).json()) as JobState;
    const finished = next.status === 'done' && job.status !== 'done';
    job = next;
    if (finished && !sheetBody) toast(t('scanReadyToast'));
  } catch (err) {
    // The service restarted (jobs live in memory) or the scan expired.
    if (err instanceof Error && /no longer available|404/.test(err.message)) {
      job = { ...job, status: 'failed', error: t('scanLost') };
    }
  }
  if (job && job.status !== 'done' && job.status !== 'failed') pollTimer = window.setTimeout(() => void poll(), POLL_MS);
  render();
}

/** Downscales a photo (respecting its EXIF orientation) to a JPEG the service can take. */
async function preparePhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('image'))), 'image/jpeg', 0.88));
}

async function addPhotos(files: FileList | File[]) {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
  if (!list.length) return;
  if (pdf) pdf = null;
  const room = MAX_PAGES - pages.length - preparing;
  if (list.length > room) toast(t('scanTooMany', { max: MAX_PAGES }), 'error');
  const take = list.slice(0, Math.max(0, room));
  preparing += take.length;
  render();
  for (const file of take) {
    try {
      const blob = await preparePhoto(file);
      pages.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      toast(t('scanBadImage', { name: file.name }), 'error');
    }
    preparing--;
    render();
  }
}

function setPdf(file: File) {
  if (file.size > MAX_PDF_BYTES) {
    toast(t('scanPdfTooBig'), 'error');
    return;
  }
  clearPages();
  pdf = file;
  if (!name) name = file.name.replace(/\.pdf$/i, '');
  render();
}

function clearPages() {
  for (const p of pages) URL.revokeObjectURL(p.url);
  pages = [];
}

async function start() {
  const files: { blob: Blob; type: string }[] = pdf ? [{ blob: pdf, type: 'application/pdf' }] : pages.map((p) => ({ blob: p.blob, type: 'image/jpeg' }));
  if (!files.length) return;
  failure = '';
  upload = { done: 0, total: files.length };
  render();
  try {
    const created = (await (await api('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: pdf ? 'pdf' : 'images', files: files.length, name, lang }) })).json()) as { id: string };
    for (let i = 0; i < files.length; i++) {
      for (let attempt = 0; ; attempt++) {
        try {
          await api(`/jobs/${created.id}/files/${i}`, { method: 'PUT', headers: { 'Content-Type': files[i].type }, body: files[i].blob });
          break;
        } catch (err) {
          if (attempt >= 2) throw err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      upload.done = i + 1;
      render();
    }
    job = (await (await api(`/jobs/${created.id}/start`, { method: 'POST' })).json()) as JobState;
    storeJob({ id: created.id, name });
    upload = null;
    pollTimer = window.setTimeout(() => void poll(), POLL_MS);
  } catch (err) {
    upload = null;
    failure = t('scanStartFailed', { msg: err instanceof Error ? err.message : String(err) });
  }
  render();
}

/** Forgets the finished/failed scan; with `keepPages`, the chosen pages stay for another try. */
function reset(keepPages: boolean) {
  if (pollTimer != null) clearTimeout(pollTimer);
  pollTimer = null;
  job = null;
  failure = '';
  storeJob(null);
  if (!keepPages) {
    clearPages();
    pdf = null;
    name = '';
  }
  render();
}

async function fetchResult(): Promise<string> {
  if (!job) throw new Error('no scan');
  return (await api(`/jobs/${job.id}/result`)).text();
}

/**
 * A download name every browser keeps: some fall back to "download" when the name has non-ASCII
 * letters, so umlauts are spelled out and other accents dropped.
 */
function fileName(title: string): string {
  return title
    .replace(/[äÄöÖüÜß]/g, (c) => ({ ä: 'ae', Ä: 'Ae', ö: 'oe', Ö: 'Oe', ü: 'ue', Ü: 'Ue', ß: 'ss' })[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]+/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim() || 'scan';
}

// ---- UI ---------------------------------------------------------------------------------------

export function openScanSheet(opener?: Element | null) {
  const body = document.createElement('div');
  body.className = 'sheet-body scan';
  sheetBody = body;
  openSheet(t('scanTitle'), body, opener, () => {
    sheetBody = null;
  });
  body.closest('.sheet')?.classList.add('scan-sheet');
  render();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', textContent = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (textContent) e.textContent = textContent;
  return e;
}

function button(label: string, cls: string, onClick: () => void, iconName?: Parameters<typeof icon>[0]): HTMLButtonElement {
  const b = el('button', `btn ${cls}`);
  b.type = 'button';
  if (iconName) b.insertAdjacentHTML('beforeend', icon(iconName));
  b.appendChild(el('span', '', label));
  b.addEventListener('click', onClick);
  return b;
}

function filePicker(accept: string, multiple: boolean, capture: boolean, onFiles: (files: FileList) => void): HTMLInputElement {
  const input = el('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.hidden = true;
  if (capture) input.setAttribute('capture', 'environment');
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles(input.files);
    input.value = '';
  });
  return input;
}

function render() {
  onStatusChange();
  const body = sheetBody;
  if (!body) return;
  body.replaceChildren();
  if (upload) body.appendChild(renderProgress());
  else if (job?.status === 'done') body.appendChild(renderResult(job));
  else if (job?.status === 'failed') body.appendChild(renderFailure(job.error));
  else if (job) body.appendChild(renderProgress());
  else body.appendChild(renderCompose());
}

function renderCompose(): HTMLElement {
  const wrap = el('div', 'scan-compose');
  wrap.appendChild(el('p', 'scan-lead', t('scanLead')));

  const pickPdf = filePicker('application/pdf,.pdf', false, false, (f) => setPdf(f[0]));
  const pickImages = filePicker('image/*', true, false, (f) => void addPhotos(f));
  const takePhoto = filePicker('image/*', false, true, (f) => void addPhotos(f));
  const sources = el('div', 'scan-sources');
  if (window.matchMedia('(pointer: coarse)').matches) {
    sources.appendChild(button(t('scanTakePhoto'), 'primary', () => takePhoto.click(), 'camera'));
  }
  sources.append(button(t('scanChooseImages'), '', () => pickImages.click(), 'image'), button(t('scanChoosePdf'), '', () => pickPdf.click(), 'file'));
  wrap.append(sources, pickPdf, pickImages, takePhoto);

  if (pdf) {
    const row = el('div', 'scan-pdf');
    row.insertAdjacentHTML('beforeend', icon('file'));
    const label = el('span', '', `${pdf.name} · ${(pdf.size / 1024 / 1024).toFixed(1)} MB`);
    const remove = el('button', 'icon-btn');
    remove.type = 'button';
    remove.setAttribute('aria-label', t('scanRemove'));
    remove.innerHTML = icon('close');
    remove.addEventListener('click', () => {
      pdf = null;
      render();
    });
    row.append(label, remove);
    wrap.appendChild(row);
  }

  if (pages.length || preparing) {
    const count = el('p', 'scan-count', t('scanPageCount', { n: pages.length, max: MAX_PAGES }) + (preparing ? ` · ${t('scanPreparing', { n: preparing })}` : ''));
    const grid = el('ol', 'scan-pages');
    pages.forEach((page, i) => {
      const li = el('li', 'scan-page');
      const img = el('img');
      img.src = page.url;
      img.alt = t('scanPageN', { n: i + 1 });
      const num = el('span', 'scan-num', String(i + 1));
      const tools = el('div', 'scan-page-tools');
      const mk = (label: string, iconName: Parameters<typeof icon>[0], disabled: boolean, fn: () => void) => {
        const b = el('button', 'icon-btn');
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.title = label;
        b.innerHTML = icon(iconName);
        b.disabled = disabled;
        b.addEventListener('click', fn);
        return b;
      };
      tools.append(
        mk(t('scanMoveEarlier'), 'chevronLeft', i === 0, () => {
          [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
          render();
        }),
        mk(t('scanRemove'), 'trash', false, () => {
          URL.revokeObjectURL(page.url);
          pages.splice(i, 1);
          render();
        }),
        mk(t('scanMoveLater'), 'chevronRight', i === pages.length - 1, () => {
          [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
          render();
        }),
      );
      li.append(img, num, tools);
      grid.appendChild(li);
    });
    for (let i = 0; i < preparing; i++) grid.appendChild(el('li', 'scan-page skeleton'));
    wrap.append(count, grid);
  }

  const nameField = el('label', 'scan-name');
  nameField.appendChild(el('span', '', t('scanNameLabel')));
  const input = el('input', 'field');
  input.value = name;
  input.placeholder = t('scanNamePlaceholder');
  input.addEventListener('input', () => (name = input.value.trim()));
  nameField.appendChild(input);
  wrap.appendChild(nameField);

  if (failure) wrap.appendChild(el('p', 'scan-error', failure));
  wrap.appendChild(el('p', 'scan-tip', t('scanTip')));
  const go = button(t('scanStart'), 'primary wide', () => void start(), 'upload');
  go.disabled = (!pdf && !pages.length) || preparing > 0;
  wrap.appendChild(go);
  return wrap;
}

function renderProgress(): HTMLElement {
  const wrap = el('div', 'scan-progress');
  const status: Status | 'uploading' = upload ? 'uploading' : (job?.status ?? 'queued');
  const order: Status[] = ['uploading', 'recognizing', 'reviewing', 'done'];
  const reached = status === 'queued' ? 1 : order.indexOf(status);
  const steps: [Status, string, string][] = [
    ['uploading', t('scanStepUpload'), upload ? `${upload.done} / ${upload.total}` : ''],
    ['recognizing', t('scanStepRecognize'), status === 'queued' ? t('scanQueued') : status === 'recognizing' && job ? `${Math.min(job.progress.done + 1, job.progress.total || 1)} / ${job.progress.total || '…'}` : ''],
    ['reviewing', t('scanStepReview'), status === 'reviewing' && job ? `${job.progress.done} / ${job.progress.total}` : ''],
    ['done', t('scanStepDone'), ''],
  ];
  const list = el('ol', 'scan-steps');
  steps.forEach(([key, label, detail], i) => {
    const li = el('li', i < reached ? 'is-done' : i === reached ? 'is-active' : '');
    li.appendChild(el('span', 'scan-dot'));
    li.appendChild(el('span', 'scan-step-label', label));
    if (detail) li.appendChild(el('span', 'scan-step-detail', detail));
    li.dataset.step = key;
    list.appendChild(li);
  });
  const fraction = upload ? upload.done / Math.max(1, upload.total) : job && job.progress.total ? job.progress.done / job.progress.total : 0;
  const bar = el('div', 'scan-bar');
  const fill = el('span');
  fill.style.width = `${Math.round(Math.max(0.03, fraction) * 100)}%`;
  bar.appendChild(fill);
  wrap.append(el('p', 'scan-lead', name || t('scanUntitled')), list, bar, el('p', 'scan-tip', upload ? t('scanKeepOpen') : t('scanCanClose')));
  return wrap;
}

function renderFailure(message: string): HTMLElement {
  const wrap = el('div', 'scan-result');
  wrap.append(el('p', 'scan-error', t('scanFailed', { msg: message || '?' })));
  const actions = el('div', 'scan-actions');
  actions.append(button(t('scanTryAgain'), 'primary', () => reset(true)), button(t('scanDiscard'), '', () => reset(false)));
  wrap.appendChild(actions);
  return wrap;
}

function renderResult(j: JobState): HTMLElement {
  const wrap = el('div', 'scan-result');
  const applied = j.reports.reduce((n, r) => n + r.applied.length, 0);
  const rejected = j.reports.reduce((n, r) => n + r.rejected.length, 0);
  const summary = el('p', 'scan-summary');
  summary.textContent = j.reviewed ? t('scanSummary', { pages: j.pages, fixes: applied }) + (rejected ? ' ' + t('scanSummaryRejected', { n: rejected }) : '') : t('scanSummaryUnchecked', { pages: j.pages });
  wrap.appendChild(summary);
  for (const note of j.notes) wrap.appendChild(el('p', 'scan-note', note));

  if (j.reports.length) {
    const details = el('details', 'scan-report');
    details.appendChild(el('summary', '', t('scanPerPage')));
    const list = el('ul');
    for (const r of j.reports) {
      const li = el('li', `conf-${r.confidence}`);
      const head = el('div', 'scan-report-head');
      head.append(el('span', 'scan-conf'), el('b', '', t('scanPageN', { n: r.page })), el('span', 'scan-report-bars', r.measures ? t('scanBars', { range: r.measures }) : ''), el('span', 'scan-report-count', r.applied.length ? t(r.applied.length === 1 ? 'scanFix1' : 'scanFixes', { n: r.applied.length }) : r.confidence === 'unchecked' ? t('scanUncheckedPage') : t('scanNoFixes')));
      li.appendChild(head);
      const lines = el('ul', 'scan-fixes');
      for (const a of r.applied) lines.appendChild(el('li', '', `${t('scanBarShort', { n: a.measure })} · ${a.part}: ${a.reason}`));
      for (const a of r.rejected) {
        const li2 = el('li', 'rejected');
        li2.append(el('s', '', `${t('scanBarShort', { n: a.measure })} · ${a.part}: ${a.reason}`), el('span', 'scan-why', ` ${t('scanNotApplied')}`));
        li2.title = a.detail;
        lines.appendChild(li2);
      }
      if (lines.childElementCount) li.appendChild(lines);
      if (r.remarks) li.appendChild(el('p', 'scan-remark', r.remarks));
      list.appendChild(li);
    }
    details.appendChild(list);
    wrap.appendChild(details);
  }

  const nameField = el('label', 'scan-name');
  nameField.appendChild(el('span', '', t('scanTitleLabel')));
  const input = el('input', 'field');
  input.value = j.title || name;
  nameField.appendChild(input);
  wrap.append(nameField, el('p', 'scan-tip', t('scanCheckHint')));

  const actions = el('div', 'scan-actions');
  const add = button(t('scanAddToRepertoire'), 'primary', async () => {
    add.disabled = true;
    try {
      const xml = await fetchResult();
      await onImport(input.value.trim() || j.title || name || t('scanUntitled'), xml);
      reset(false);
      closeOverlay();
    } catch (err) {
      toast(t('addFailed', { name: input.value, msg: err instanceof Error ? err.message : String(err) }), 'error');
      add.disabled = false;
    }
  }, 'plus');
  const download = button(t('scanDownload'), '', async () => {
    try {
      const xml = await fetchResult();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }));
      a.download = `${fileName(input.value.trim() || 'scan')}.musicxml`;
      a.hidden = true;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, 'save');
  actions.append(add, download, button(t('scanDiscard'), 'ghost', () => reset(false)));
  wrap.appendChild(actions);
  return wrap;
}
