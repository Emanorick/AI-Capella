import { defineConfig } from 'vite';

// GitHub Pages serves this repo at https://<user>.github.io/AI-Capella/, so all
// asset URLs need that subpath prefix. Local dev (npm run dev) is unaffected.
export default defineConfig({
  base: '/AI-Capella/',
});
