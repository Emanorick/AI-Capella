import { unzipSync, strFromU8, strToU8, gzipSync, gunzipSync } from 'fflate';
import {
  addDoc,
  Bytes,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';

// Firestore caps a document at 1 MiB (1,048,576 bytes) total, including field names and every
// other field on the doc -- leave headroom below that rather than cutting it exactly at the limit.
const MAX_COMPRESSED_XML_BYTES = 900_000;

export type SongFormat = 'musicxml' | 'score';

export interface StoredSong {
  id: string;
  title: string;
  // MusicXML markup when format is 'musicxml'; a JSON-serialized Score (see score.ts) when
  // format is 'score' -- MIDI imports go this route since MIDI notes are already plain numeric
  // pitches with no notation-level spelling to encode, so round-tripping them through MusicXML
  // text would only add a lossy, unnecessary conversion step.
  xml: string;
  format: SongFormat;
  importedAt: number;
  // User-renamed voice/part names, keyed by part id -- a side-channel field rather than rewriting
  // the xml/xmlGz blob itself (far less invasive: no need to re-parse/re-serialize MusicXML or
  // mutate a JSON Score just to change a label). Applied client-side after parsing, before the
  // part name is shown anywhere. Absent/undefined for a song with no renamed voices.
  partNameOverrides?: Record<string, string>;
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
        // xmlGz (gzip-compressed bytes) is the current format; xml (raw string) is a fallback for
        // documents written before compression was added.
        const xml = data.xmlGz ? strFromU8(gunzipSync((data.xmlGz as Bytes).toUint8Array())) : ((data.xml as string) ?? '');
        return {
          id: d.id,
          title: data.title as string,
          xml,
          // Documents written before MIDI import existed have no format field; they're always
          // MusicXML.
          format: ((data.format as SongFormat | undefined) ?? 'musicxml') as SongFormat,
          importedAt: (data.importedAt as number) ?? 0,
          partNameOverrides: data.partNameOverrides as Record<string, string> | undefined,
        };
      });
      callback(songs);
    },
    onError,
  );
}

/** Returns the new song's id (available immediately from Firestore's optimistic local write). */
export async function saveImportedSong(song: { title: string; xml: string; format: SongFormat }): Promise<string> {
  if (!db) throw new Error('Firebase is not configured');
  const compressed = gzipSync(strToU8(song.xml));
  if (compressed.byteLength > MAX_COMPRESSED_XML_BYTES) {
    throw new Error(
      `This score is too large (${Math.round(compressed.byteLength / 1024)} KB compressed) -- Firestore caps documents at 1 MB.`,
    );
  }
  const docRef = await addDoc(collection(db, SONGS_COLLECTION), {
    title: song.title,
    xmlGz: Bytes.fromUint8Array(compressed),
    format: song.format,
    importedAt: Date.now(),
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function deleteImportedSong(id: string): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  await deleteDoc(doc(db, SONGS_COLLECTION, id));
}

/**
 * Renames a song's title and/or one voice's displayed name, written immediately (no
 * confirmation step, matching this app's existing "any device can change shared state" trust
 * model already used for playback/library changes elsewhere).
 *
 * The part-name field is written via a dot-path key (`partNameOverrides.${partId}`), NOT as a
 * nested object value (`{ partNameOverrides: { [partId]: name } }`) -- Firestore's updateDoc only
 * merges at the top level of the fields object; a plain nested object there *replaces* the whole
 * map wholesale. With a real object value, renaming a second voice would silently wipe out every
 * other voice's already-saved rename the next time this ran. The dot-path form updates just that
 * one nested key, leaving the rest of the map untouched.
 */
export async function updateSongMetadata(id: string, patch: { title?: string; partName?: { partId: string; name: string } }): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  const fields: Record<string, unknown> = {};
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.partName) fields[`partNameOverrides.${patch.partName.partId}`] = patch.partName.name;
  await updateDoc(doc(db, SONGS_COLLECTION, id), fields);
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
