import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { deviceChoice } from './design';
import { t } from './i18n';

/**
 * Ensembles: each choir has its own repertoire (its own folder of songs) and its own rehearsal
 * session, opened with its code. A device remembers every code entered on it, so one person can
 * belong to two ensembles and switch between them. Without a code, the public folder holds the
 * bundled sample songs, to look at and listen to only.
 *
 * Like the PIN before it, this is a soft gate: the codes are checked on the device against their
 * hashes in Firestore (config/access), and the rules still let any signed-in device read every
 * song. It keeps the ensembles' repertoires apart in the app, not out of reach of someone who
 * reads the code.
 *
 * Behind a flag while it's being tried out (?ensembles=an; ?ensembles=aus turns it off again).
 */
export const ENSEMBLES_ON = deviceChoice('ensembles', 'ai-capella-ensembles', ['an', 'aus'] as const, 'aus') === 'an';

export interface Ensemble {
  id: string;
  /** The name shown until one is saved in Firestore (config/access names.<id>). */
  defaultName: string;
  /** The rehearsal session's document in the sessions collection; null: no rehearsing together. */
  channel: string | null;
}

export const PUBLIC_ID = 'public';
/** The ensemble every song stored before ensembles existed (no `ensemble` field) belongs to. */
export const FIRST_ENSEMBLE_ID = 'nnb';

export const ENSEMBLES: readonly Ensemble[] = [
  { id: PUBLIC_ID, defaultName: 'Öffentlich', channel: null },
  // Its code is the app's PIN from before (pinHash), and its session the one shared session there
  // was, so the devices already in it carry on as they were.
  { id: FIRST_ENSEMBLE_ID, defaultName: 'Ensemble n.n.b.', channel: 'live' },
  { id: 'rm', defaultName: 'Relativ männlich', channel: 'live-rm' },
];

export function ensembleById(id: string): Ensemble | undefined {
  return ENSEMBLES.find((e) => e.id === id);
}

const UNLOCKED_KEY = 'ai-capella-ensembles-unlocked';
const ACTIVE_KEY = 'ai-capella-ensemble';
const NAMES_KEY = 'ai-capella-ensemble-names';
const LEGACY_ACCESS_KEY = 'ai-capella-access-granted';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: remembered for this visit only */
  }
}

/** The ensembles whose code was entered on this device (a device let in by the old PIN is in the first). */
export function unlockedEnsembles(): string[] {
  const stored = readJson<string[]>(UNLOCKED_KEY, []).filter((id) => id !== PUBLIC_ID && ensembleById(id));
  if (!stored.length && localStorage.getItem(LEGACY_ACCESS_KEY) === '1') return [FIRST_ENSEMBLE_ID];
  return stored;
}

export function unlockEnsemble(id: string) {
  const list = unlockedEnsembles();
  if (!list.includes(id)) writeJson(UNLOCKED_KEY, [...list, id]);
}

/** The folder this device opens: the last one chosen, if it's still open to it; null: none chosen yet. */
export function activeEnsemble(): string | null {
  const stored = localStorage.getItem(ACTIVE_KEY);
  const unlocked = unlockedEnsembles();
  if (stored === PUBLIC_ID) return PUBLIC_ID;
  if (stored && unlocked.includes(stored)) return stored;
  return unlocked[0] ?? null;
}

export function setActiveEnsemble(id: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* see writeJson */
  }
}

let names: Record<string, string> = readJson(NAMES_KEY, {});

export function ensembleName(id: string): string {
  if (id === PUBLIC_ID) return t('publicEnsemble');
  return names[id] || ensembleById(id)?.defaultName || id;
}

const ACCESS_DOC = ['config', 'access'] as const;

interface AccessDoc {
  pinHash?: string;
  codeHashes?: Record<string, string>;
  names?: Record<string, string>;
}

async function readAccess(): Promise<AccessDoc> {
  if (!db) throw new Error('Firebase is not configured');
  const snap = await getDoc(doc(db, ...ACCESS_DOC));
  return snap.exists() ? (snap.data() as AccessDoc) : {};
}

function codeHashOf(access: AccessDoc, id: string): string | undefined {
  return id === FIRST_ENSEMBLE_ID ? access.pinHash : access.codeHashes?.[id];
}

/** Fetches the ensembles' names (renamed in the app) and remembers them for the next start. */
export async function refreshEnsembleNames(): Promise<void> {
  const access = await readAccess();
  names = { ...(access.names ?? {}) };
  writeJson(NAMES_KEY, names);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The ensemble a code opens, or null. Also refreshes the names. */
export async function ensembleForCode(code: string): Promise<string | null> {
  const access = await readAccess();
  names = { ...(access.names ?? {}) };
  writeJson(NAMES_KEY, names);
  const hash = await sha256Hex(code.trim());
  return ENSEMBLES.find((e) => e.id !== PUBLIC_ID && codeHashOf(access, e.id) === hash)?.id ?? null;
}

/** Whether an ensemble has a code yet. */
export async function ensembleHasCode(id: string): Promise<boolean> {
  return !!codeHashOf(await readAccess(), id);
}

/**
 * Sets an ensemble's code (stored only as its hash). A code already opening another ensemble is
 * refused -- one code, one folder.
 */
export async function setEnsembleCode(id: string, code: string): Promise<'ok' | 'taken'> {
  if (!db) throw new Error('Firebase is not configured');
  const access = await readAccess();
  const hash = await sha256Hex(code.trim());
  if (ENSEMBLES.some((e) => e.id !== id && e.id !== PUBLIC_ID && codeHashOf(access, e.id) === hash)) return 'taken';
  const field = id === FIRST_ENSEMBLE_ID ? 'pinHash' : `codeHashes.${id}`;
  await updateDoc(doc(db, ...ACCESS_DOC), { [field]: hash });
  return 'ok';
}

export async function renameEnsemble(id: string, name: string): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  await updateDoc(doc(db, ...ACCESS_DOC), { [`names.${id}`]: name });
  names = { ...names, [id]: name };
  writeJson(NAMES_KEY, names);
}
