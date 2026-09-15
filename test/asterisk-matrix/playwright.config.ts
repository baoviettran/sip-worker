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
    // firefoxUserPrefs is a LAUNCH option — BrowserContextOptions has no such
    // key — so this block used to sit under `contextOptions` accepted and
    // silently ignored, and every pref in it was inert. Moving it here is the
    // whole fix; no pref was added.
    //
    // `media.peerconnection.ice.loopback` is the load-bearing one: it is what
    // lets Firefox use the harness's loopback STUN responder
    // (test/matrix-shared/stun.ts). That responder is the only source of a
    // NON-obfuscated candidate Firefox can gather — host candidates are mDNS
    // `.local` names — so without it Firefox has no address literal to write
    // into the offer's connection line, offers `c=IN IP4 0.0.0.0`, and
    // Asterisk reads that as RFC 3264 hold
    // (res_pjsip_sdp_rtp.c set_session_media_remotely_held ->
    // ast_sockaddr_is_any) and answers `a=recvonly`, leaving the browser
    // send-only with no inbound RTP.
    //
    // Measured, one pref block moved and nothing else changed:
    //   inert   — offer `m=audio 9 ... c=IN IP4 0.0.0.0`, no candidates,
    //             answer `a=recvonly`, audio step exit 1
    //   applied — offer carries srflx `127.0.0.1`, `c=IN IP4 127.0.0.1`,
    //             answer `a=sendrecv`, audio step exit 0
    //
    // `media.peerconnection.ice.obfuscate_host_addresses: false` was tried too
    // and is NOT needed: it measures identically (audio green) while also
    // exposing Firefox's real global IPv6 host candidate, which ICE then
    // prefers. Deliberately left at its default.
    //
    // This closes the outgoing-audio half only. [firefox] controls.spec still
    // fails on an unrelated, unresolved cause — ICE reports `connected` on an
    // IPv6 pair while dtlsState never leaves `connecting`, so no SRTP flows in
    // either direction. See FINAL-REPORT.md §5.1.
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
  // A runner-level backstop for the ENTIRE focus class, and the only defence
  // against the aliased form — `const d = test.describe; d.only(…)` — which no
  // source-reading rule can follow. MEASURED at the commit that armed it, one
  // temporary mutation in dtmf.spec.ts at a time, reverted after each: `test.only`,
  // `test.describe.only`, `test.describe.serial.only`,
  // `test.describe.parallel.only` and the aliased suite form each exit 1 in list
  // mode (the integrity gate's own invocation, `--list --reporter=json`, under
  // MATRIX_MODE=nightly) and 1 in a real run (MATRIX_MODE=pr), the runner naming
  // the focused title and printing the source line; a correct tree exits 0 in
  // both. The option is unconditional, so CI=1 cannot change any of that — which
  // is also why the claim this comment used to carry, that CI=1 left list mode
  // green, was wrong: CI turns the option on by Playwright's own default.
  //
  // It does NOT abort before globalSetup. Measured: the real run boots Asterisk
  // first, then fails 13 s in on the focus check — the teardown removes the
  // container, so nothing leaks, but a focused tree pays the boot. (An earlier
  // draft of this comment claimed it aborted before boot; that was not measured
  // and is not true.)
  //
  // Deliberately `true` rather than `!!process.env.CI`: this tree's whole
  // discipline is that a focused step must never be silent, and local runs
  // should fail the same way CI does. The cost is that a developer cannot leave
  // a stray `.only` in place while debugging — which is the point.
  //
  // NOT redundant with the integrity gate's classifier: the gate names the exact
  // declaration so the failure points at the edit, while this catches what no
  // source rule can reach. The gate asserts this line is still armed (its
  // `forbidOnly` rule), so removing the backstop fails CI instead of silently
  // disarming it.
  forbidOnly: true,
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
