// Runs the scan service locally with the stand-ins (for trying the app's scan dialog):
//   node test/mocks/run-local.mjs   -> http://localhost:18090, fake OpenAI on :18091
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeOpenAI } from './openai.mjs';
const mocks = new URL('./bin/', import.meta.url).pathname;
await startFakeOpenAI(18091);
spawn('node', [new URL('../../dist/server.js', import.meta.url).pathname], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: '18090',
    PATH: `${mocks}:${process.env.PATH}`,
    AUDIVERIS_CMD: join(mocks, 'audiveris'),
    OMR_SKIP_AUTH: '1',
    OMR_WORK_DIR: mkdtempSync(join(tmpdir(), 'omr-local-')),
    OPENAI_API_KEY: 'test',
    OPENAI_BASE_URL: 'http://localhost:18091/v1',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:5201',
  },
});
