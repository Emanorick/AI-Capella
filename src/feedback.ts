// Feedback from people trying the app out (an ensemble with `feedback: true`, ensembles.ts): a
// button in the top bar opens a short form -- what kind (a bug, a wish, an idea, a remark), what
// happened, a name if they like, and where they were (song, bar, view, device), so a bug can be
// found again. Once someone has really used the app, a small card asks once for a five-question
// survey. Everything goes to the `feedback` collection, which only the ensemble's leaders can read
// (firestore.rules); they read it here (openFeedbackInbox): a list to filter and tick off, the
// survey's averages, and an export to pass it on.
//
// What can't be sent right away (offline, or the database refusing it) waits on the device and
// goes out at the next start.
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, updateDoc, where, type Timestamp, type Unsubscribe } from 'firebase/firestore';
import { currentUid, db, ensureSignedIn } from './firebase';
import { ensembleById, ensembleName, leads } from './ensembles';
import { icon } from './icons';
import { t, type MessageKey } from './i18n';
import { closeOverlay, confirmDialog, openMenu, openSheet, toast } from './ui';

export type FeedbackKind = 'bug' | 'wish' | 'idea' | 'note';
type Kind = FeedbackKind | 'survey';
type Use = 'alone' | 'together' | 'sheet' | 'barely';
type Keep = 'yes' | 'maybe' | 'no';

interface Survey {
  uses: Use[];
  helps: number; // 1-5, 0: not answered
  ease: number;
  keep: Keep | '';
}

interface Outgoing {
  ensemble: string;
  kind: Kind;
  text: string;
  name: string;
  context: string;
  survey?: Survey;
}

export interface FeedbackEntry extends Outgoing {
  id: string;
  at: number; // ms, from the server's time
  done: boolean;
}

const KINDS: FeedbackKind[] = ['bug', 'wish', 'idea', 'note'];
const USES: Use[] = ['alone', 'together', 'sheet', 'barely'];
const KEEPS: Keep[] = ['yes', 'maybe', 'no'];

const NAME_KEY = 'ai-capella-feedback-name';
const OUTBOX_KEY = 'ai-capella-feedback-outbox';
const SURVEY_KEY = (e: string) => `ai-capella-survey-${e}`; // "done" | "never" | asked count
const USE_KEY = (e: string) => `ai-capella-feedback-use-${e}`; // { visits, ms, day }
const SEEN_KEY = (e: string) => `ai-capella-feedback-seen-${e}`; // leaders: newest entry they've seen

// When to ask for the survey: someone who has come back a few times, or practised a while.
const ASK_AFTER_VISITS = 3;
const ASK_AFTER_MS = 15 * 60 * 1000;
const MAX_ASKS = 2;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered on this device */
  }
}

/** Whether this ensemble asks its members for feedback. */
export function feedbackOn(ensemble: string): boolean {
  return !!ensembleById(ensemble)?.feedback;
}

let ensemble = '';
let where_ = (): string => '';
let busy = (): boolean => false;
let onCount: (n: number) => void = () => {};

/**
 * Wires feedback up for the open ensemble: `context` says where the device is now (for the
 * form), `isBusy` whether now is a bad moment for the survey card (playing, a rehearsal being led),
 * `onNewCount` tells a leader's button how many entries are new.
 */
export function initFeedback(opts: { ensemble: string; context: () => string; isBusy: () => boolean; onNewCount: (n: number) => void }) {
  ensemble = opts.ensemble;
  where_ = opts.context;
  busy = opts.isBusy;
  onCount = opts.onNewCount;
  if (!feedbackOn(ensemble)) return;
  void flushOutbox();
  countUse();
  if (leads(ensemble)) watchNew();
}

// ---- sending ----------------------------------------------------------------------------------

async function send(item: Outgoing): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  await ensureSignedIn();
  const write = addDoc(collection(db, 'feedback'), { ...item, uid: currentUid(), createdAt: serverTimestamp(), done: false });
  // Offline, Firestore keeps the write and sends it later by itself: no need to wait for that.
  await Promise.race([write, new Promise((r) => window.setTimeout(r, 8000))]);
}

/** Sends one entry; if that fails, keeps it for the next start. True when it went out. */
async function deliver(item: Outgoing): Promise<boolean> {
  try {
    await send(item);
    return true;
  } catch (err) {
    console.warn('feedback kept for later:', err);
    save(OUTBOX_KEY, [...load<Outgoing[]>(OUTBOX_KEY, []), item]);
    return false;
  }
}

async function flushOutbox() {
  const waiting = load<Outgoing[]>(OUTBOX_KEY, []);
  if (!waiting.length) return;
  save(OUTBOX_KEY, []);
  for (const item of waiting) await deliver(item);
}

// ---- where the device is ----------------------------------------------------------------------

/** "iPhone · Safari 18 · 390×844", from the browser's own description of itself. */
export function deviceSummary(): string {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const platform = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || touchMac ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const browsers: [RegExp, string][] = [
    [/EdgA?\/(\d+)/, 'Edge'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
    [/(?:CriOS|Chrome)\/(\d+)/, 'Chrome'],
    [/Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari/, 'Safari'],
  ];
  let browser = '';
  for (const [re, name] of browsers) {
    const m = ua.match(re);
    if (m) {
      browser = `${name} ${m[1]}`;
      break;
    }
  }
  const app = window.matchMedia('(display-mode: standalone)').matches ? 'App' : '';
  return [platform, browser, `${window.innerWidth}×${window.innerHeight}`, app].filter(Boolean).join(' · ');
}

// ---- the form -----------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function nameField(): HTMLInputElement {
  const input = el('input', 'field');
  input.maxLength = 80;
  input.autocomplete = 'name';
  input.placeholder = t('fbNamePlaceholder');
  input.value = load<string>(NAME_KEY, '');
  return input;
}

function labelled(label: string, control: HTMLElement, hint = ''): HTMLElement {
  const wrap = el('label', 'fb-field');
  wrap.appendChild(el('span', 'fb-label', label));
  if (hint) wrap.appendChild(el('span', 'fb-hint', hint));
  wrap.appendChild(control);
  return wrap;
}

/** A row of choices as toggle chips; `multi`: several at once. */
function choices<T extends string | number>(name: string, options: { value: T; label: string }[], multi: boolean, onChange: (values: T[]) => void, initial: T[] = []): HTMLElement {
  const group = el('div', 'fb-choices');
  group.setAttribute('role', multi ? 'group' : 'radiogroup');
  group.setAttribute('aria-label', name);
  let chosen = [...initial];
  const buttons = options.map((o) => {
    const b = el('button', 'fb-choice', o.label);
    b.type = 'button';
    b.setAttribute(multi ? 'aria-pressed' : 'aria-checked', String(chosen.includes(o.value)));
    if (!multi) b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      chosen = multi ? (chosen.includes(o.value) ? chosen.filter((v) => v !== o.value) : [...chosen, o.value]) : [o.value];
      buttons.forEach((x, i) => x.setAttribute(multi ? 'aria-pressed' : 'aria-checked', String(chosen.includes(options[i].value))));
      onChange(chosen);
    });
    return b;
  });
  group.append(...buttons);
  return group;
}

const PLACEHOLDER: Record<FeedbackKind, MessageKey> = { bug: 'fbTextBug', wish: 'fbTextWish', idea: 'fbTextIdea', note: 'fbTextNote' };

/** The feedback form. `kind`: chosen in advance. */
export function openFeedbackSheet(opener?: Element | null, kind: FeedbackKind = 'bug') {
  const context = where_();
  const body = el('form', 'sheet-body fb');
  body.noValidate = true;
  body.appendChild(el('p', 'fb-lead', t('fbLead', { name: ensembleName(ensemble) })));

  let chosen = kind;
  const text = el('textarea', 'field fb-text');
  text.rows = 5;
  text.maxLength = 4000;
  text.placeholder = t(PLACEHOLDER[chosen]);
  body.appendChild(
    labelled(
      t('fbKindLabel'),
      choices(
        t('fbKindLabel'),
        KINDS.map((k) => ({ value: k, label: t(`fbKind_${k}` as MessageKey) })),
        false,
        ([k]) => {
          chosen = k;
          text.placeholder = t(PLACEHOLDER[k]);
        },
        [kind],
      ),
    ),
  );
  body.appendChild(labelled(t('fbTextLabel'), text));
  const name = nameField();
  body.appendChild(labelled(t('fbNameLabel'), name));

  const withContext = el('label', 'fb-context');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = true;
  const ctxText = el('span');
  ctxText.append(el('span', '', t('fbContextLabel')), el('small', '', context));
  withContext.append(box, ctxText);
  body.appendChild(withContext);

  const error = el('p', 'fb-error');
  error.hidden = true;
  text.addEventListener('input', () => (error.hidden = true));
  const submit = el('button', 'btn primary wide');
  submit.type = 'submit';
  submit.innerHTML = icon('chat');
  submit.appendChild(el('span', '', t('fbSend')));
  body.append(error, submit);

  if (surveyState() !== 'done') {
    const survey = el('button', 'link-btn fb-survey-link', t('fbSurveyLink'));
    survey.type = 'button';
    survey.addEventListener('click', () => {
      closeOverlay();
      window.setTimeout(() => openSurveySheet(opener), 250);
    });
    body.appendChild(survey);
  }

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!text.value.trim()) {
      error.textContent = t('fbNeedText');
      error.hidden = false;
      text.focus();
      return;
    }
    submit.disabled = true;
    save(NAME_KEY, name.value.trim());
    const sent = await deliver({ ensemble, kind: chosen, text: text.value.trim(), name: name.value.trim(), context: box.checked ? context : '' });
    closeOverlay();
    toast(sent ? t('fbThanks') : t('fbThanksLater'));
  });
  openSheet(t('fbTitle'), body, opener);
  window.setTimeout(() => text.focus({ preventScroll: true }), 300);
}

// ---- the survey ---------------------------------------------------------------------------------

function surveyState(): 'done' | 'never' | number {
  return load<'done' | 'never' | number>(SURVEY_KEY(ensemble), 0);
}

export function openSurveySheet(opener?: Element | null) {
  const context = where_();
  const answers: Survey = { uses: [], helps: 0, ease: 0, keep: '' };
  const body = el('form', 'sheet-body fb');
  body.noValidate = true;
  body.appendChild(el('p', 'fb-lead', t('svLead')));
  const scale = (label: string, low: string, high: string, set: (n: number) => void) => {
    const wrap = el('div', 'fb-scale');
    wrap.appendChild(choices(label, [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) })), false, ([n]) => set(n)));
    const ends = el('div', 'fb-scale-ends');
    ends.append(el('span', '', low), el('span', '', high));
    wrap.appendChild(ends);
    return wrap;
  };
  const q = (n: number, label: string, control: HTMLElement) => {
    const wrap = el('fieldset', 'fb-q');
    const legend = el('legend', 'fb-label');
    legend.append(el('span', 'fb-num', String(n)), document.createTextNode(label));
    wrap.append(legend, control);
    return wrap;
  };
  body.appendChild(q(1, t('svUses'), choices(t('svUses'), USES.map((u) => ({ value: u, label: t(`svUse_${u}` as MessageKey) })), true, (v) => (answers.uses = v))));
  body.appendChild(q(2, t('svHelps'), scale(t('svHelps'), t('svHelpsLow'), t('svHelpsHigh'), (n) => (answers.helps = n))));
  body.appendChild(q(3, t('svEase'), scale(t('svEase'), t('svEaseLow'), t('svEaseHigh'), (n) => (answers.ease = n))));
  const missing = el('textarea', 'field');
  missing.rows = 3;
  missing.maxLength = 4000;
  missing.placeholder = t('svMissingPlaceholder');
  body.appendChild(q(4, t('svMissing'), missing));
  body.appendChild(q(5, t('svKeep'), choices(t('svKeep'), KEEPS.map((k) => ({ value: k, label: t(`svKeep_${k}` as MessageKey) })), false, ([k]) => (answers.keep = k))));
  const name = nameField();
  body.appendChild(labelled(t('fbNameLabel'), name));
  const error = el('p', 'fb-error');
  error.hidden = true;
  body.addEventListener('click', () => (error.hidden = true));
  const submit = el('button', 'btn primary wide');
  submit.type = 'submit';
  submit.textContent = t('fbSend');
  body.append(error, submit);
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!answers.uses.length && !answers.helps && !answers.ease && !answers.keep && !missing.value.trim()) {
      error.textContent = t('svNeedAnswer');
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    save(NAME_KEY, name.value.trim());
    save(SURVEY_KEY(ensemble), 'done');
    const sent = await deliver({ ensemble, kind: 'survey', text: missing.value.trim(), name: name.value.trim(), context, survey: answers });
    closeOverlay();
    toast(sent ? t('svThanks') : t('fbThanksLater'));
  });
  openSheet(t('svTitle'), body, opener);
}

// ---- asking for the survey, once ----------------------------------------------------------------

/** Counts visits (one a day) and time with the app open, and offers the survey when it's due. */
function countUse() {
  const today = new Date().toDateString();
  const use = load<{ visits: number; ms: number; day: string }>(USE_KEY(ensemble), { visits: 0, ms: 0, day: '' });
  if (use.day !== today) save(USE_KEY(ensemble), { ...use, visits: use.visits + 1, day: today });
  let asked = false;
  window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const now = load<{ visits: number; ms: number; day: string }>(USE_KEY(ensemble), { visits: 1, ms: 0, day: today });
    now.ms += 30000;
    save(USE_KEY(ensemble), now);
    if (!asked && surveyDue(now) && calm()) {
      asked = true;
      askForSurvey();
    }
  }, 30000);
}

function surveyDue(use: { visits: number; ms: number }): boolean {
  const state = surveyState();
  if (state === 'done' || state === 'never' || state >= MAX_ASKS) return false;
  // The second time only on another visit, with a bit more use behind it.
  const needMs = ASK_AFTER_MS * (state + 1);
  return use.visits >= ASK_AFTER_VISITS + state || use.ms >= needMs;
}

const calm = () => !busy() && !document.querySelector('.overlay, .intro, .fb-ask');

function askForSurvey() {
  const state = surveyState();
  save(SURVEY_KEY(ensemble), typeof state === 'number' ? state + 1 : state);
  const card = el('div', 'fb-ask');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('svAskTitle'));
  const textWrap = el('div', 'fb-ask-text');
  textWrap.append(el('b', '', t('svAskTitle')), el('span', '', t('svAskText')));
  const go = el('button', 'btn primary', t('svAskGo'));
  go.type = 'button';
  const later = el('button', 'btn ghost', t('svAskLater'));
  later.type = 'button';
  const never = el('button', 'icon-btn fb-ask-close');
  never.type = 'button';
  never.setAttribute('aria-label', t('svAskNever'));
  never.title = t('svAskNever');
  never.innerHTML = icon('close');
  const actions = el('div', 'fb-ask-actions');
  actions.append(go, later);
  card.append(never, el('span', 'fb-ask-icon', ''), textWrap, actions);
  card.querySelector('.fb-ask-icon')!.innerHTML = icon('chat');
  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add('shown'));
  const close = () => {
    card.classList.remove('shown');
    window.setTimeout(() => card.remove(), 300);
  };
  go.addEventListener('click', () => {
    close();
    openSurveySheet();
  });
  later.addEventListener('click', close);
  never.addEventListener('click', () => {
    save(SURVEY_KEY(ensemble), 'never');
    close();
  });
}

// ---- for the leaders: reading it ----------------------------------------------------------------

function entries(onChange: (list: FeedbackEntry[]) => void, onError: (err: unknown) => void): Unsubscribe {
  if (!db) {
    onError(new Error('Firebase is not configured'));
    return () => {};
  }
  return onSnapshot(
    query(collection(db, 'feedback'), where('ensemble', '==', ensemble)),
    (snap) => {
      const list = snap.docs.map((d) => {
        const data = d.data() as Outgoing & { createdAt?: Timestamp; done?: boolean };
        return { ...data, id: d.id, at: data.createdAt?.toMillis() ?? Date.now(), done: !!data.done } as FeedbackEntry;
      });
      list.sort((a, b) => b.at - a.at);
      onChange(list);
    },
    onError,
  );
}

let latest: FeedbackEntry[] = [];

/** Keeps a leader's count of new entries up to date. */
function watchNew() {
  void ensureSignedIn().then(() =>
    entries(
      (list) => {
        latest = list;
        onCount(newCount());
      },
      () => onCount(0), // the rules don't let this device read it (yet): no count
    ),
  );
}

function newCount(): number {
  const seen = load<number>(SEEN_KEY(ensemble), 0);
  return latest.filter((e) => e.at > seen).length;
}

/** For a leader: the menu behind the feedback button (give it, or read it). */
export function openLeaderFeedbackMenu(anchor: HTMLElement) {
  const n = newCount();
  openMenu(
    anchor,
    [
      { label: t('fbGive'), icon: 'chat', onSelect: () => openFeedbackSheet(anchor) },
      { label: n ? t('fbReadNew', { n }) : t('fbRead'), icon: 'users', onSelect: () => openFeedbackInbox(anchor) },
    ],
    t('fbTitle'),
  );
}

export function feedbackMenuLabel(): string {
  const n = newCount();
  return n ? t('fbReadNew', { n }) : t('fbRead');
}

const KIND_ORDER: Kind[] = ['bug', 'wish', 'idea', 'note', 'survey'];
type Filter = 'open' | 'all' | Kind | 'done';

const kindLabel = (k: Kind) => t(`fbKindShort_${k}` as MessageKey); // plural, for counts
const kindOne = (k: Kind) => t(`fbKindOne_${k}` as MessageKey);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function surveyLine(s: Survey): string {
  const parts: string[] = [];
  if (s.uses?.length) parts.push(`${t('svUsesShort')}: ${s.uses.map((u) => t(`svUse_${u}` as MessageKey)).join(', ')}`);
  if (s.helps) parts.push(`${t('svHelpsShort')} ${s.helps}/5`);
  if (s.ease) parts.push(`${t('svEaseShort')} ${s.ease}/5`);
  if (s.keep) parts.push(`${t('svKeepShort')}: ${t(`svKeep_${s.keep}` as MessageKey)}`);
  return parts.join(' · ');
}

function summary(list: FeedbackEntry[]): HTMLElement {
  const wrap = el('div', 'fb-summary');
  const surveys = list.filter((e) => e.kind === 'survey' && e.survey).map((e) => e.survey!);
  const counts = KIND_ORDER.filter((k) => k !== 'survey').map((k) => [k, list.filter((e) => e.kind === k).length] as const);
  const line = el('p', 'fb-summary-line');
  line.textContent = [...counts.filter(([, n]) => n).map(([k, n]) => `${kindLabel(k)} ${n}`), surveys.length ? `${kindLabel('survey')} ${surveys.length}` : ''].filter(Boolean).join(' · ') || t('fbNone');
  wrap.appendChild(line);
  if (surveys.length) {
    const avg = (key: 'helps' | 'ease') => {
      const xs = surveys.map((s) => s[key]).filter((x) => x > 0);
      return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '–';
    };
    const tiles = el('div', 'fb-tiles');
    const tile = (label: string, value: string) => {
      const d = el('div', 'fb-tile');
      d.append(el('b', '', value), el('span', '', label));
      return d;
    };
    const keep = KEEPS.map((k) => `${t(`svKeep_${k}` as MessageKey)} ${surveys.filter((s) => s.keep === k).length}`).join(' · ');
    const uses = USES.map((u) => [u, surveys.filter((s) => s.uses?.includes(u)).length] as const)
      .filter(([, n]) => n)
      .map(([u, n]) => `${t(`svUse_${u}` as MessageKey)} ${n}`)
      .join(' · ');
    tiles.append(tile(t('svHelpsShort'), `⌀ ${avg('helps')}`), tile(t('svEaseShort'), `⌀ ${avg('ease')}`));
    wrap.appendChild(tiles);
    wrap.appendChild(el('p', 'fb-summary-line', `${t('svKeepShort')}: ${keep}`));
    if (uses) wrap.appendChild(el('p', 'fb-summary-line', `${t('svUsesShort')}: ${uses}`));
  }
  return wrap;
}

function csv(list: FeedbackEntry[]): string {
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const head = [t('fbColDate'), t('fbColKind'), t('fbColName'), t('fbColText'), t('svUsesShort'), t('svHelpsShort'), t('svEaseShort'), t('svKeepShort'), t('fbColContext'), t('fbColDone')];
  const rows = list.map((e) => [
    new Date(e.at).toLocaleString(),
    kindOne(e.kind),
    e.name,
    e.text,
    e.survey?.uses?.map((u) => t(`svUse_${u}` as MessageKey)).join(', ') ?? '',
    e.survey?.helps || '',
    e.survey?.ease || '',
    e.survey?.keep ? t(`svKeep_${e.survey.keep}` as MessageKey) : '',
    e.context,
    e.done ? '✓' : '',
  ]);
  // Semicolons and a byte-order mark: what spreadsheet programs set to German open without asking.
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
}

function plainText(list: FeedbackEntry[]): string {
  return list
    .map((e) => {
      const lines = [`${when(e.at)} · ${kindOne(e.kind)}${e.name ? ` · ${e.name}` : ''}${e.done ? ' ✓' : ''}`];
      if (e.survey) lines.push(surveyLine(e.survey));
      if (e.text) lines.push(e.text);
      if (e.context) lines.push(`(${e.context})`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** For a leader: everything sent in, newest first, to filter, tick off and pass on. */
export function openFeedbackInbox(opener?: Element | null) {
  const body = el('div', 'sheet-body fb fb-inbox');
  let list: FeedbackEntry[] = [];
  let filter: Filter = 'open';
  let failed = false;
  const render = () => {
    body.replaceChildren();
    if (failed) {
      body.appendChild(el('p', 'fb-error', t('fbReadFailed')));
      return;
    }
    body.appendChild(summary(list));
    const filters: [Filter, string, number][] = [
      ['open', t('fbFilterOpen'), list.filter((e) => !e.done).length],
      ['all', t('fbFilterAll'), list.length],
      ...KIND_ORDER.map((k) => [k, kindLabel(k), list.filter((e) => e.kind === k).length] as [Filter, string, number]),
      ['done', t('fbFilterDone'), list.filter((e) => e.done).length],
    ];
    const bar = el('div', 'fb-choices fb-filters');
    for (const [f, label, n] of filters) {
      if (!n && f !== 'open' && f !== 'all') continue;
      const b = el('button', 'fb-choice', `${label} ${n}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(filter === f));
      b.addEventListener('click', () => {
        filter = f;
        render();
      });
      bar.appendChild(b);
    }
    body.appendChild(bar);
    const shown = list.filter((e) => (filter === 'open' ? !e.done : filter === 'all' ? true : filter === 'done' ? e.done : e.kind === filter));
    const ul = el('ul', 'fb-list');
    for (const e of shown) {
      const li = el('li', `fb-item kind-${e.kind}${e.done ? ' is-done' : ''}`);
      const head = el('div', 'fb-item-head');
      head.append(el('span', 'fb-kind', kindOne(e.kind)), el('span', 'fb-when', when(e.at)));
      if (e.name) head.appendChild(el('b', 'fb-who', e.name));
      li.appendChild(head);
      if (e.survey) li.appendChild(el('p', 'fb-survey-line', surveyLine(e.survey)));
      if (e.text) li.appendChild(el('p', 'fb-item-text', e.text));
      if (e.context) li.appendChild(el('p', 'fb-item-context', e.context));
      const actions = el('div', 'fb-item-actions');
      const done = el('button', 'btn ghost small', e.done ? t('fbReopen') : t('fbMarkDone'));
      done.type = 'button';
      done.addEventListener('click', () => {
        if (!db) return;
        done.disabled = true;
        updateDoc(doc(db, 'feedback', e.id), { done: !e.done }).catch((err) => {
          done.disabled = false;
          toast(String(err), 'error');
        });
      });
      const remove = el('button', 'btn ghost small danger', t('fbDelete'));
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!db || !(await confirmDialog({ title: t('fbDeleteTitle'), body: t('fbDeleteBody'), confirmLabel: t('fbDelete'), danger: true }))) return;
        deleteDoc(doc(db, 'feedback', e.id)).catch((err) => toast(String(err), 'error'));
      });
      actions.append(done, remove);
      li.appendChild(actions);
      ul.appendChild(li);
    }
    if (!shown.length) ul.appendChild(el('li', 'fb-empty', list.length ? t('fbNoneHere') : t('fbNone')));
    body.appendChild(ul);
    if (list.length) {
      const exp = el('div', 'scan-actions fb-export');
      const download = el('button', 'btn', t('fbExportCsv'));
      download.type = 'button';
      download.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv(list)], { type: 'text/csv;charset=utf-8' }));
        a.download = `Feedback ${ensembleName(ensemble)} ${new Date().toISOString().slice(0, 10)}.csv`;
        a.hidden = true;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });
      const copy = el('button', 'btn ghost', t('fbCopy'));
      copy.type = 'button';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(plainText(list)).then(
          () => toast(t('fbCopied')),
          () => toast(t('fbCopyFailed'), 'error'),
        );
      });
      exp.append(download, copy);
      body.appendChild(exp);
    }
  };
  let stop: Unsubscribe = () => {};
  render();
  openSheet(t('fbInboxTitle', { name: ensembleName(ensemble) }), body, opener, () => {
    stop();
    // What was open here counts as seen.
    if (list.length) save(SEEN_KEY(ensemble), Math.max(...list.map((e) => e.at)));
    onCount(newCount());
  });
  void ensureSignedIn().then(() => {
    stop = entries(
      (next) => {
        list = next;
        latest = next;
        failed = false;
        render();
      },
      (err) => {
        console.warn('feedback could not be read:', err);
        failed = true;
        render();
      },
    );
  });
}
