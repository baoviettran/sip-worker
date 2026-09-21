import { defineConfig, devices } from '@playwright/test';
import { launchOptionsFor } from './test/browser-matrix/launch';

/**
 * Real three-engine WebRTC verification (v0.5 media + v0.7 controls/recovery)
 * against the BUILT/PACKED browser package.
 *
 * - Two webServers: the v0.5 browser-media harness (4100) and the v0.7
 *   browser-phone harness (4300 HTTP + 4200 WSS). Both FAIL when the built
 *   artifact is absent (never serve source or stale).
 * - Three projects (chromium/firefox/webkit), one worker each, sharing the
 *   servers. Every engine must pass: no capability is `test.skip`ped.
 * - One worker so every engine gets a private, autoplay-enabled page context
 *   and a full 10-cycle lifecycle without cross-test contention.
 * - `ignoreHTTPSErrors` makes each isolated Linux browser profile trust the
 *   per-run local CA of the browser-phone WSS service.
 *
 * The library's microphone and the synthetic peer both use synthetic oscillator
 * audio INSIDE the page, so no real OS mic is needed.
 */
export default defineConfig({
  testDir: './test',
  testMatch: /(browser-media|browser-phone)\/.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://127.0.0.1:4100',
  },
  webServer: [
    {
      command: 'node test/browser-media/server.mjs',
      url: 'http://127.0.0.1:4100/index.html',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node test/browser-phone/server.mjs',
      url: 'http://127.0.0.1:4300/index.html',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ignoreHTTPSErrors: true,
        launchOptions: launchOptionsFor('chromium'),
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        ignoreHTTPSErrors: true,
        launchOptions: launchOptionsFor('firefox'),
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        ignoreHTTPSErrors: true,
        launchOptions: launchOptionsFor('webkit'),
      },
    },
  ],
  reporter: [['list']],
});
