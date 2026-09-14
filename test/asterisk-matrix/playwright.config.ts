// test/asterisk-matrix/playwright.config.ts — Asterisk matrix harness.
//
// MATRIX_MODE gates the bounded PR slice: 'pr' excludes audio.spec.ts (no audio
// hardware needed) and registers the Chromium project alone; 'nightly' or unset
// includes every spec and both browser projects. The globalSetup
// (helpers.ts default export) boots ONE Asterisk container per run and its
// returned teardown stops it; the webServer chains the packed-artifact build
// (build-matrix.mjs) ahead of the HTTPS page server (server.mjs), so the
// page can never run against a stale or missing dist/matrix.js.

import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const matrixDir = fileURLToPath(new URL('.', import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.MATRIX_HTTP_PORT ?? 4510);
const BASE_URL = process.env.MATRIX_BASE_URL ?? `https://${HOST}:${PORT}`;

const mode = process.env.MATRIX_MODE ?? 'nightly';
const testMatch = mode === 'pr' ? /^((?!audio\.spec).)*\.spec\.ts$/ : /\.spec\.ts$/;

// The firefox project is registered only outside 'pr': the matrix CI job
// installs the Chromium engine alone, so a registered firefox project would
// fail every test with "Executable doesn't exist" rather than skipping
// anything.
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
    command: 'node ../matrix-shared/build-matrix.mjs && node ../matrix-shared/server.mjs',
    cwd: matrixDir,
    // server.mjs is PBX-agnostic and keeps FreeSWITCH's 4500 as its default, so
    // it cannot know this tree's port. Passing PORT through is what makes the
    // webServer wait on the port this config (and helpers.ts) actually use —
    // without it the wait times out against a listener on 4500.
    env: { MATRIX_HTTP_PORT: String(PORT) },
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
