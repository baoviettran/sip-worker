import { defineConfig, devices } from '@playwright/test';

/**
 * Packed-example UI gate (Task 15): the reference softphone running ONLY the
 * packed `sip-worker` artifact (installed tarballs, esbuild-bundled), exercised
 * at the UI level against a fake SIP WSS server and an in-page synthetic media
 * peer.
 *
 * - One Chromium project (the example is a UI demo; the cross-engine real-media
 *   matrix is Task 16's `test/browser-phone` suite).
 * - `?relay=1` on the page URL activates the media-relay test hook so mute /
 *   hold / DTMF operate on REAL WebRTC media between the library's PC and the
 *   in-page synthetic peer.
 * - The webServer is `build-softphone.mjs`, which packs the workspaces, installs
 *   the exact tarballs into a temp fixture, bundles the example against that
 *   fixture, and serves ONLY the resulting artifacts (never workspace source).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://127.0.0.1:4200',
  },
  webServer: {
    command: 'node build-softphone.mjs',
    url: 'http://127.0.0.1:4200/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'example',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // The example demonstrates gesture-safe play() (a button), but
            // headless audio still needs the page AudioContext enabled and the
            // library's getUserMedia needs a deterministic fake mic.
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],
  reporter: [['list']],
});
