import { deleteDoc, doc, getDoc, getDocFromServer, serverTimestamp, setDoc } from 'firebase/firestore';
import { currentUid, db } from './firebase';
import { t } from './i18n';

/**
 * Ensembles: each choir has its own repertoire (its own folder of songs) and its own rehearsal
 * session, opened with its code. A device remembers every code entered on it, so one person can
 * belong to two ensembles and switch between them. Without a code, the public folder holds the
 * bundled sample songs, to look at and listen to only.
 *
 * Guarded by the Firestore rules (firestore.rules, see below): a device reads an ensemble's songs
 * only after joining it with its code.
 *
 */

export interface Ensemble {
  id: string;
  /** The name shown until one is saved in Firestore (ensembles/<id> name). */
  defaultName: string;
  /** The rehearsal session's document in the sessions collection; null: no rehearsing together. */
  channel: string | null;
}

export const PUBLIC_ID = 'public';
/** The ensemble every song stored before ensembles existed belongs to (migrateUnfiledSongs). */
export const FIRST_ENSEMBLE_ID = 'nnb';

export const ENSEMBLES: readonly Ensemble[] = [
  { id: PUBLIC_ID, defaultName: 'Öffentlich', channel: null },
  // Its session is the one shared session there was before ensembles.
  { id: FIRST_ENSEMBLE_ID, defaultName: 'Ensemble n.n.b.', channel: 'live' },
  { id: 'rm', defaultName: 'Relativ männlich', channel: 'live-rm' },
];

export function ensembleById(id: string): Ensemble | undefined {
  return ENSEMBLES.find((e) => e.id === id);
}

const UNLOCKED_KEY = 'ai-capella-ensembles-unlocked';
const ACTIVE_KEY = 'ai-capella-ensemble';
const NAMES_KEY = 'ai-capella-ensemble-names';

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

/** The ensembles whose code was entered on this device (its memberships, as last known here). */
export function unlockedEnsembles(): string[] {
  return readJson<string[]>(UNLOCKED_KEY, []).filter((id) => id !== PUBLIC_ID && ensembleById(id));
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

// ---- Firestore -------------------------------------------------------------------------------
//
//   ensembleCodes/{codeId}              { ensemble }          codeId = SHA-256 of the salted code
//   members/{uid}/ensembles/{ensemble}  { code: codeId }      this device (anonymous user) is in
//   ensembles/{ensemble}                { name, codeId }      the ensemble's name and current code
//
// The rules (firestore.rules) let a device fetch a code's document only by its id -- so only with
// the code in hand -- and never list them; join an ensemble only by naming a code document that
// opens it; and read or change an ensemble's songs, session and details only once it has joined.
// The salt keeps the ids apart from the old PIN's hash, which every device could read.

const CODE_SALT = 'lightscore-ensemble-code:';
/** A code must be long enough not to be guessed by trying (each try is a request to Firestore). */
export const MIN_CODE_LENGTH = 8;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function codeId(code: string): Promise<string> {
  return sha256Hex(CODE_SALT + code.trim());
}

function firestore() {
  if (!db) throw new Error('Firebase is not configured');
  return db;
}

function memberRef(id: string) {
  return doc(firestore(), 'members', currentUid(), 'ensembles', id);
}

/** Forgets an ensemble on this device (its membership is gone, or was never made). */
export function forgetEnsemble(id: string) {
  writeJson(UNLOCKED_KEY, unlockedEnsembles().filter((e) => e !== id));
  if (localStorage.getItem(ACTIVE_KEY) === id) localStorage.removeItem(ACTIVE_KEY);
}

/**
 * Checks the device's ensembles against its memberships in Firestore, forgetting any it isn't in
 * (opened before the codes were checked there). True if anything changed. Offline, nothing is
 * forgotten.
 */
export async function syncMemberships(): Promise<boolean> {
  let changed = false;
  for (const id of unlockedEnsembles()) {
    try {
      const snap = await getDocFromServer(memberRef(id));
      if (!snap.exists()) {
        forgetEnsemble(id);
        changed = true;
      }
    } catch {
      /* offline or not answered: keep it */
    }
  }
  return changed;
}

/** Fetches the device's ensembles' names (renamed in the app) and remembers them for the next start. */
export async function refreshEnsembleNames(): Promise<void> {
  const next = { ...names };
  for (const id of unlockedEnsembles()) {
    try {
      const snap = await getDoc(doc(firestore(), 'ensembles', id));
      const name = snap.data()?.name;
      if (typeof name === 'string' && name) next[id] = name;
    } catch {
      /* not readable (yet): keep what we had */
    }
  }
  names = next;
  writeJson(NAMES_KEY, names);
}

/** Opens the ensemble a code belongs to: joins it in Firestore and remembers it here. Null: no such code. */
export async function joinWithCode(code: string): Promise<string | null> {
  const id = await codeId(code);
  const snap = await getDoc(doc(firestore(), 'ensembleCodes', id));
  const ensemble = snap.data()?.ensemble;
  if (!snap.exists() || typeof ensemble !== 'string' || !ensembleById(ensemble)) return null;
  await setDoc(memberRef(ensemble), { code: id, joinedAt: serverTimestamp() });
  unlockEnsemble(ensemble);
  void refreshEnsembleNames().catch(() => {});
  return ensemble;
}

/** Whether an ensemble still waits for its first code -- readable only while nobody guards it yet. */
export async function ensembleNeedsCode(id: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(firestore(), 'ensembles', id));
    return !snap.data()?.codeId;
  } catch {
    return false; // not ours to read: it has members, and a code
  }
}

/**
 * Sets an ensemble's code: the new code opens it from now on and the old one no longer does
 * (whoever is in stays in). Whoever sets it joins with it. Refused: a code that is too short, or
 * one that already opens another ensemble.
 */
export async function setEnsembleCode(id: string, code: string): Promise<'ok' | 'short' | 'taken'> {
  if (code.trim().length < MIN_CODE_LENGTH) return 'short';
  const fs = firestore();
  const newId = await codeId(code);
  const existing = await getDoc(doc(fs, 'ensembleCodes', newId));
  if (existing.exists() && existing.data()?.ensemble !== id) return 'taken';
  const ensembleRef = doc(fs, 'ensembles', id);
  const oldId = (await getDoc(ensembleRef)).data()?.codeId as string | undefined;
  if (!existing.exists()) await setDoc(doc(fs, 'ensembleCodes', newId), { ensemble: id });
  await setDoc(memberRef(id), { code: newId, joinedAt: serverTimestamp() });
  await setDoc(ensembleRef, { codeId: newId }, { merge: true });
  if (oldId && oldId !== newId) await deleteDoc(doc(fs, 'ensembleCodes', oldId));
  unlockEnsemble(id);
  return 'ok';
}

export async function renameEnsemble(id: string, name: string): Promise<void> {
  await setDoc(doc(firestore(), 'ensembles', id), { name }, { merge: true });
  names = { ...names, [id]: name };
  writeJson(NAMES_KEY, names);
}
