import { defineConfig } from 'vitest/config';

// GitHub Pages serves this repo at https://<user>.github.io/AI-Capella/, so all
// asset URLs need that subpath prefix. Local dev (npm run dev) is unaffected.
export default defineConfig({
  base: '/AI-Capella/',
  test: {
    // parseMusicXML relies on the browser's DOMParser (including ':scope >' selectors, which
    // happy-dom doesn't support); jsdom provides both without a real browser.
    environment: 'jsdom',
  },
});
