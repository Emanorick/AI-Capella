import { unzipSync, strFromU8 } from 'fflate';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';

export interface StoredSong {
  id: string;
  title: string;
  xml: string;
  importedAt: number;
}

const SONGS_COLLECTION = 'songs';
const ACCESS_DOC_PATH = ['config', 'access'] as const;

/** Live-subscribes to the shared song library; the callback fires immediately and again on every change from any device. */
export function subscribeToSongs(callback: (songs: StoredSong[]) => void, onError: (err: unknown) => void): Unsubscribe {
  if (!db) {
    onError(new Error('Firebase is not configured'));
    return () => {};
  }
  const q = query(collection(db, SONGS_COLLECTION), orderBy('importedAt', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const songs: StoredSong[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          title: data.title as string,
          xml: data.xml as string,
          importedAt: (data.importedAt as number) ?? 0,
        };
      });
      callback(songs);
    },
    onError,
  );
}

/** Returns the new song's id (available immediately from Firestore's optimistic local write). */
export async function saveImportedSong(song: { title: string; xml: string }): Promise<string> {
  if (!db) throw new Error('Firebase is not configured');
  const docRef = await addDoc(collection(db, SONGS_COLLECTION), {
    title: song.title,
    xml: song.xml,
    importedAt: Date.now(),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function deleteImportedSong(id: string): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  await deleteDoc(doc(db, SONGS_COLLECTION, id));
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Checks a PIN against the hash stored in Firestore. This is a soft UI gate, not a real
 *  security boundary -- see the setup notes for why that's an acceptable trade-off here. */
export async function verifyPin(pin: string): Promise<boolean> {
  if (!db) throw new Error('Firebase is not configured');
  const snap = await getDoc(doc(db, ...ACCESS_DOC_PATH));
  if (!snap.exists()) throw new Error('No PIN has been set up yet (missing config/access document)');
  const expectedHash = snap.data().pinHash as string | undefined;
  if (!expectedHash) throw new Error('config/access document is missing a pinHash field');
  return (await sha256Hex(pin)) === expectedHash;
}

/** Reads a .musicxml/.xml file as-is, or unzips a compressed .mxl (MuseScore's default export format). */
export async function readScoreFile(file: File): Promise<string> {
  const isCompressed = file.name.toLowerCase().endsWith('.mxl');
  if (!isCompressed) return file.text();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(bytes);

  const containerXml = entries['META-INF/container.xml'];
  if (containerXml) {
    const containerText = strFromU8(containerXml);
    const match = containerText.match(/full-path="([^"]+)"/);
    const targetPath = match?.[1];
    if (targetPath && entries[targetPath]) return strFromU8(entries[targetPath]);
  }

  const xmlEntryName = Object.keys(entries).find((name) => /\.(musicxml|xml)$/i.test(name) && !name.startsWith('META-INF/'));
  if (xmlEntryName) return strFromU8(entries[xmlEntryName]);

  throw new Error('No MusicXML data found inside the .mxl file');
}
