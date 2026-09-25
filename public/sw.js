// AI-Capella service worker: keeps the app itself available offline (rehearsal rooms without
// Wi-Fi). Songs are not stored here -- Firestore keeps its own offline copy (see firebase.ts).
//
// - Page loads: network first, falling back to the stored page when offline. Every successful
//   load also stores the build's scripts, styles and fonts, and drops those of older builds.
// - Everything else from this site (hashed build files, fonts, icons, the sample song, the piano
//   samples): stored copy first, network otherwise -- build files never change under the same name.
// - Other hosts (Firebase) are left alone.
const CACHE = 'ai-capella-v2'; // v2: the paper design's icons

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['./', './evening-rise.musicxml', './favicon.svg', './manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
      // The page that registered this worker loaded before it existed -- store that build now.
      const page = await fetch('./', { cache: 'no-cache' }).catch(() => null);
      if (page && page.ok) await storeBuild(await page.clone().text());
    })(),
  );
});

/** Stores the scripts/styles a page references (and the fonts its styles reference); drops older builds' files. */
async function storeBuild(html) {
  const cache = await caches.open(CACHE);
  const scope = new URL(self.registration.scope);
  const assets = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) assets.add(new URL(m[1], scope).href);
  for (const cssUrl of [...assets].filter((u) => u.endsWith('.css'))) {
    const res = await fetch(cssUrl).catch(() => null);
    if (!res || !res.ok) continue;
    await cache.put(cssUrl, res.clone());
    const css = await res.text();
    // Only the Latin subsets (and the music font) -- the only scripts the app's interface and
    // typical lyrics use; other subsets are fetched and stored on demand if ever needed.
    for (const m of css.matchAll(/url\(([^)]+\.woff2)\)/g)) {
      const fontUrl = new URL(m[1].replace(/["']/g, ''), cssUrl).href;
      if (/latin|bravura/.test(fontUrl)) assets.add(fontUrl);
    }
  }
  // The grand piano's samples (see src/audioEngine.ts), so it plays offline even if nobody played
  // on this device while online.
  for (let midi = 33; midi <= 96; midi += 3) assets.add(new URL(`samples/piano/p${midi}.mp3`, scope).href);
  await Promise.all([...assets].map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => {}))));
  // Prune scripts/styles from older builds (fonts are kept; their names rarely change).
  for (const req of await cache.keys()) {
    if (/\/assets\/.+\.(js|css)$/.test(req.url) && !assets.has(req.url)) await cache.delete(req);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('./', res.clone());
            event.waitUntil(res.clone().text().then(storeBuild));
          }
          return res;
        } catch {
          return (await caches.match('./')) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
