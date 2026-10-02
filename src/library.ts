import { unzipSync, strFromU8, strToU8, gzipSync, gunzipSync } from 'fflate';
import {
  addDoc,
  Bytes,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
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
  // Where it stands in the repertoire, when someone moved it there by hand (else by importedAt).
  sortKey?: number;
  // User-renamed voice/part names, keyed by part id -- a side-channel field rather than rewriting
  // the xml/xmlGz blob itself (far less invasive: no need to re-parse/re-serialize MusicXML or
  // mutate a JSON Score just to change a label). Applied client-side after parsing, before the
  // part name is shown anywhere. Absent/undefined for a song with no renamed voices.
  partNameOverrides?: Record<string, string>;
  // A deliberately-saved default for this song (the "Save" action in main.ts), applied when the
  // song is freshly selected -- not written automatically on every transpose/BPM/marker change,
  // only when the user explicitly asks to remember the current setup. sections is only ever
  // populated here for a song whose MusicXML has no <rehearsal> marks of its own (see
  // Score.rehearsalMarks) -- when it does, those are used directly and nothing needs saving.
  savedConfig?: { transpose?: number; bpm?: number; sections?: { label: string; beat: number }[] };
  // Per-voice clef chosen in the app (keyed by part id), overriding the file's own <clef>.
  clefOverrides?: Record<string, VoiceClef>;
  // Voices removed in the app (part ids). The stored score itself is never rewritten, so a removed
  // voice can be restored at any time; it is filtered out when the song loads.
  removedParts?: string[];
  // Played with swing (swing.ts) instead of straight -- a choice for the song, for everyone.
  swing?: boolean;
}

export type VoiceClef = 'treble' | 'treble8' | 'bass';

const SONGS_COLLECTION = 'songs';

function parseSongDoc(id: string, data: Record<string, unknown>): StoredSong {
  // xmlGz (gzip-compressed bytes) is the current format; xml (raw string) is a fallback for
  // documents written before compression was added. Decompression is the expensive part of
  // this (below), which is exactly why subscribeToSongs only calls this for docs that actually
  // changed rather than on every doc on every snapshot.
  const xml = data.xmlGz ? strFromU8(gunzipSync((data.xmlGz as Bytes).toUint8Array())) : ((data.xml as string) ?? '');
  return {
    id,
    title: data.title as string,
    xml,
    // Documents written before MIDI import existed have no format field; they're always MusicXML.
    format: ((data.format as SongFormat | undefined) ?? 'musicxml') as SongFormat,
    importedAt: (data.importedAt as number) ?? 0,
    sortKey: typeof data.sortKey === 'number' ? data.sortKey : undefined,
    partNameOverrides: data.partNameOverrides as Record<string, string> | undefined,
    savedConfig: data.savedConfig as StoredSong['savedConfig'],
    clefOverrides: data.clefOverrides as StoredSong['clefOverrides'],
    removedParts: Array.isArray(data.removedParts) ? (data.removedParts as string[]) : undefined,
    swing: data.swing === true ? true : undefined,
  };
}

/** Live-subscribes to an ensemble's songs (the only query the Firestore rules allow); the callback
 *  fires immediately and again on every change from any device. */
export function subscribeToSongs(
  callback: (songs: StoredSong[], fromCache: boolean) => void,
  onError: (err: unknown) => void,
  ensemble: string,
): Unsubscribe {
  if (!db) {
    onError(new Error('Firebase is not configured'));
    return () => {};
  }
  // Filtered by ensemble, sorted here: ordering by another field in the query would need a
  // composite index set up in the Firebase console.
  const q = query(collection(db, SONGS_COLLECTION), where('ensemble', '==', ensemble));
  // A collection onSnapshot fires (with the FULL current result set) on every change to ANY doc
  // in it -- one voice's rename, a new import, anything. Re-gunzipping and re-decoding every
  // song's XML from scratch on every single one of those events (as this used to do) means a
  // roomful of devices all simultaneously doing that work for the *entire* library every time
  // any one of them touches it -- a real, repeatable cause of a synced-rehearsal-wide stutter/
  // freeze that gets worse the more songs (and the more people editing) there are. Firestore's
  // docChanges() says exactly which docs were added/modified/removed since the last snapshot, so
  // a per-doc cache lets every unchanged song's already-decompressed StoredSong be reused as-is.
  const cache = new Map<string, StoredSong>();
  return onSnapshot(
    q,
    // Metadata changes too, so the app learns when the list switches between the offline copy and
    // the live server data (fromCache), not only when documents change.
    { includeMetadataChanges: true },
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'removed') cache.delete(change.doc.id);
        else cache.set(change.doc.id, parseSongDoc(change.doc.id, change.doc.data()));
      }
      const songs = snapshot.docs.map((d) => cache.get(d.id)).filter((s): s is StoredSong => s != null);
      songs.sort((a, b) => songOrder(a) - songOrder(b));
      callback(songs, snapshot.metadata.fromCache);
    },
    onError,
  );
}

/** A song's place in the repertoire: where it was moved by hand, else when it was added. */
export function songOrder(song: { importedAt: number; sortKey?: number }): number {
  return song.sortKey ?? song.importedAt;
}

/** Moves songs in the repertoire (for everyone in the ensemble): their new places, in one write. */
export async function saveSongOrder(places: { id: string; sortKey: number }[]): Promise<void> {
  if (!db || !places.length) return;
  const batch = writeBatch(db);
  for (const { id, sortKey } of places) batch.update(doc(db, SONGS_COLLECTION, id), { sortKey });
  await batch.commit();
}

/** Returns the new song's id (available immediately from Firestore's optimistic local write). */
export async function saveImportedSong(song: { title: string; xml: string; format: SongFormat; ensemble?: string }): Promise<string> {
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
    ...(song.ensemble ? { ensemble: song.ensemble } : {}),
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
export async function updateSongMetadata(
  id: string,
  patch: { title?: string; ensemble?: string; swing?: boolean; partName?: { partId: string; name: string }; clef?: { partId: string; clef: VoiceClef }; removedParts?: string[] },
): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  const fields: Record<string, unknown> = {};
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.ensemble !== undefined) fields.ensemble = patch.ensemble;
  if (patch.swing !== undefined) fields.swing = patch.swing; // moved to another ensemble's folder
  if (patch.partName) fields[`partNameOverrides.${patch.partName.partId}`] = patch.partName.name;
  // Dot-path for the same reason as partNameOverrides: only this one voice's entry changes.
  if (patch.clef) fields[`clefOverrides.${patch.clef.partId}`] = patch.clef.clef;
  if (patch.removedParts) fields.removedParts = patch.removedParts;
  await updateDoc(doc(db, SONGS_COLLECTION, id), fields);
}

/**
 * Saves the current transpose/BPM/section-marker setup as this song's default, applied the next
 * time it's freshly selected (see main.ts's selectSong/loadSongLocally). A deliberate, explicit
 * snapshot -- unlike renames, this is never written automatically on every tweak, only when the
 * user actually asks to remember the current one. Replaces the whole `savedConfig` object at once
 * (not a dot-path partial update like updateSongMetadata's partName case) since it's always
 * written as one complete, internally-consistent snapshot, never a single field in isolation.
 */
export async function saveSongConfig(id: string, config: { transpose: number; bpm: number; sections: { label: string; beat: number }[] }): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  await updateDoc(doc(db, SONGS_COLLECTION, id), { savedConfig: config });
}

/**
 * Saves just the hand-set section marks (the A/B/C bookmarks), right when one is added or removed
 * -- they're bookmarks, not a setting to snapshot. Leaves the rest of savedConfig as it is.
 */
export async function saveSongSections(id: string, sections: { label: string; beat: number }[]): Promise<void> {
  if (!db) throw new Error('Firebase is not configured');
  await updateDoc(doc(db, SONGS_COLLECTION, id), { 'savedConfig.sections': sections });
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
