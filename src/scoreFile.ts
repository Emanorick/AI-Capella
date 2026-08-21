import { unzipSync, strFromU8 } from 'fflate';

// Deliberately separate from library.ts: reading a dropped/picked score file needs only fflate,
// while library.ts drags in the whole Firebase SDK -- which main.ts loads lazily (see there).

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
