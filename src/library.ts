import { unzipSync, strFromU8 } from 'fflate';

export interface StoredSong {
  id: string;
  title: string;
  xml: string;
  importedAt: number;
}

const DB_NAME = 'ai-capella';
const STORE_NAME = 'songs';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listImportedSongs(): Promise<StoredSong[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as StoredSong[]).sort((a, b) => a.importedAt - b.importedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function saveImportedSong(song: StoredSong): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(song);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteImportedSong(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
