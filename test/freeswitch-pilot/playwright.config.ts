import { defineConfig, devices } from '@playwright/test';

/**
 * Packed-app Playwright gate for the FreeSWITCH pilot (Task 6).
 *
 * Exercises the pilot UI at http://127.0.0.1:4400/?relay=1, which activates
 * the in-page media-relay test hook. The fake SIP server relays the WebRTC
 * offer/answer SDP to a browser-side SyntheticPeer, so mute / hold / DTMF
 * operate on REAL media between the library's PC and the relay peer.
 *
 * The pilot is built with testMode:true by the webServer entry (server.mjs),
 * which also serves static files over HTTPS, runs the SipFakeServer WSS
 * upgrades, and delegates /control/** endpoints.
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
    baseURL: 'http://127.0.0.1:4400',
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:4400/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'pilot',
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
  ],
  reporter: [['list']],
});
