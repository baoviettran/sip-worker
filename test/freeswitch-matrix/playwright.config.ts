// test/freeswitch-matrix/playwright.config.ts — FreeSWITCH matrix harness.
//
// MATRIX_MODE gates the bounded PR slice: 'pr' excludes audio.spec.ts (no audio
// hardware needed) and registers the Chromium project alone; 'nightly' or unset
// includes every spec and both browser projects. The globalSetup
// (helpers.ts default export) boots ONE FreeSWITCH container per run and its
// returned teardown stops it; the webServer chains the packed-artifact build
// (build-matrix.mjs) ahead of the HTTPS page server (server.mjs), so the
// page can never run against a stale or missing dist/matrix.js.

import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const matrixDir = fileURLToPath(new URL('.', import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.MATRIX_HTTP_PORT ?? 4500);
const BASE_URL = process.env.MATRIX_BASE_URL ?? `https://${HOST}:${PORT}`;

const mode = process.env.MATRIX_MODE ?? 'nightly';
const testMatch = mode === 'pr' ? /^((?!audio\.spec).)*\.spec\.ts$/ : /\.spec\.ts$/;

// The firefox project is registered only outside 'pr': the PR job installs the
// Chromium engine alone (see .github/workflows/freeswitch-matrix.yml), so a
// registered firefox project would fail every test with "Executable doesn't
// exist" rather than skipping anything.
const firefoxProject = {
  name: 'firefox',
  use: {
    ...devices['Desktop Firefox'],
    contextOptions: {
      firefoxUserPrefs: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.navigator.streams.fake': false,
        'media.peerconnection.ice.loopback': true,
      },
    },
  },
};

export default defineConfig({
  testDir: matrixDir,
  testMatch,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  globalSetup: './helpers.ts',
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node build-matrix.mjs && node server.mjs',
    cwd: matrixDir,
    url: `${BASE_URL}/index.html`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
    ...(mode === 'pr' ? [] : [firefoxProject]),
  ],
});
