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
    // firefoxUserPrefs is a LAUNCH option — BrowserContextOptions has no such
    // key — so this block used to sit under `contextOptions` accepted and
    // silently ignored, and every pref in it was inert. Moving it here is the
    // whole fix; no pref was added. Ported from the identical fix in
    // test/asterisk-matrix/playwright.config.ts (a420a46), which measured it
    // there; FreeSWITCH had been left carrying the defect.
    //
    // `media.peerconnection.ice.loopback` is the load-bearing one: it is what
    // lets Firefox use the harness's loopback STUN responder
    // (test/matrix-shared/stun.ts). That responder is the only source of a
    // NON-obfuscated candidate Firefox can gather — host candidates are mDNS
    // `.local` names — so without it Firefox has no address literal to write
    // into the media connection line and settles on `c=IN IP4 0.0.0.0` with
    // `a=recvonly`, an announcement FreeSWITCH reads as having no destination.
    //
    // Evidence, one pref block moved and nothing else changed. "inert" is read
    // from the CI artifact of nightly run 35210424950 — inside trace.zip, so
    // unzip before grepping: test-results/
    // …-establishes-clean-hangup-firefox-retry1/trace.zip → resources/*.jsonl.
    // "applied" was measured locally on this harness.
    //   inert   — FS originates to the page; the page answers
    //             `m=audio 9 … c=IN IP4 0.0.0.0` + `a=recvonly`, mDNS `.local`
    //             host candidates only, no srflx; FS ACKs and tears the call
    //             down with
    //             `Reason: Q.850;cause=88;text="INCOMPATIBLE_DESTINATION"`.
    //             That is the inbound half; the page-offers half fails as 488
    //             on re-INVITE (hold, recovery) and as 120s waitForFunction
    //             timeouts while no RTP arrives (audio, dtmf).
    //   applied — answer `m=audio 45837 … c=IN IP4 127.0.0.1` carrying
    //             `a=candidate:1 1 UDP 1685987327 127.0.0.1 45837 typ srflx`,
    //             and no cause-88 teardown: the call now survives SDP
    //             negotiation.
    //
    // This is a strict improvement, NOT a green nightly. With the prefs applied
    // the Firefox call fails LATER and for a different reason — media
    // establishment, `Media connection did not establish.` — on a box where
    // chromium passes the same spec 2/2, so a second Firefox defect sits behind
    // this one. Whether the nightly goes green is only decidable by a nightly.
    launchOptions: {
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
