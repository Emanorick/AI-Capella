// Quick manual test client for the omrTestPage function -- not deployed, not part of the
// function itself. Usage:
//   node test-omr.mjs <path-to-page-image> <function-url> > out.musicxml
// Then, e.g.: python3 -c "import music21; music21.converter.parse('out.musicxml').show('text')"
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const [, , imagePath, functionUrl] = process.argv;
if (!imagePath || !functionUrl) {
  console.error('Usage: node test-omr.mjs <path-to-page-image> <function-url>');
  process.exit(1);
}

const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()];
if (!mediaType) {
  console.error(`Unsupported image extension: ${extname(imagePath)} (use png/jpg/jpeg/webp/gif)`);
  process.exit(1);
}

const imageBase64 = (await readFile(imagePath)).toString('base64');

const res = await fetch(functionUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ imageBase64, mediaType }),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Request failed (${res.status}):`, body);
  process.exit(1);
}
process.stdout.write(body);
