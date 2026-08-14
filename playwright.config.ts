import { defineConfig, devices } from '@playwright/test';

/**
 * Real three-engine WebRTC audio verification (v0.5) against the BUILT/PACKED
 * browser package.
 *
 * - Three projects (chromium/firefox/webkit), one worker each, sharing a single
 *   webServer that FAILS when the built artifact is absent (never serves source
 *   or stale).
 * - The gate is MANDATORY on all three engines: no capability is `test.skip`ped.
 * - One worker so every engine gets a private, autoplay-enabled page context and
 *   a full 10-cycle lifecycle without cross-test contention.
 *
 * The library's microphone and the synthetic peer both use synthetic oscillator
 * audio INSIDE the page (AudioContext -> OscillatorNode -> DestinationNode), so
 * no real OS mic is needed. Per-engine autoplay enables the page AudioContext to
 * actually run (producing RTP with data rather than a suspended/silent stream).
 */
export default defineConfig({
  testDir: './test/browser-media',
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://127.0.0.1:4100',
  },
  webServer: {
    command: 'node test/browser-media/server.mjs',
    url: 'http://127.0.0.1:4100/index.html',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // Deterministic injected media-device adapter is used for the
            // library's getUserMedia; this flag is a belt-and-braces fallback.
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            // Headless Firefox suspends audio without a gesture; allow it.
            'media.autoplay.default': 0,
            'media.autoplay.blocking_policy': 0,
            'media.navigator.streams.fake': false,
          },
        },
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        // WebKit's launch args have NO --autoplay-policy (that flag is
        // Chromium-only and webkit rejects it -> instant exit). Audio/gain is
        // muted by default policy in WebKit; the page side handles autoplay
        // via the injected media adapter, not a browser launch flag.
      },
    },
  ],
  reporter: [['list']],
});