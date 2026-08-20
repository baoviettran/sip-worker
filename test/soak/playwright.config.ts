import { defineConfig, devices } from '@playwright/test';

/**
 * Browser soak (v0.9 Workstream 1): repeated lifecycle cycles against the
 * browser-phone harness, chromium only. The soak measures resource leaks under
 * repetition, NOT engine parity (that is browser-media's three-engine suite).
 *
 * - `retries: 0` always: a leak must fail, never be retried into green.
 * - The webServer is the browser-phone harness (4300); the browser-media
 *   server (4100) is not needed.
 * - `SOAK_CYCLES` (default 5) scales the run: nightly sets a large value, the
 *   PR slice keeps a small one.
 */
const cycles = Number(process.env.SOAK_CYCLES ?? 5);

export default defineConfig({
  testDir: '.',
  testMatch: /browser-soak\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000 + cycles * 10_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices['Desktop Chrome'],
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        // Synthetic oscillator audio inside the page — no real OS mic.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  webServer: {
    command: 'node ../../test/browser-phone/server.mjs',
    url: 'http://127.0.0.1:4300/index.html',
    reuseExistingServer: !process.env.CI,
  },
  reporter: [['list']],
});
