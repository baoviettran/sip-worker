// test/browser-matrix/playwright.config.ts — the v0.9 browser-matrix harness.
//
// Rows change the ENGINE, never the suite: testMatch reuses the existing v0.5
// media and v0.7 controls/recovery specs verbatim, plus this tree's
// version.spec.ts, which is what makes the version assertion unskippable.
//
// MATRIX_ROWS is the comma-separated row id list this run may launch;
// MATRIX_EVENT selects the allowed set (the PR slice runs the bundled rows
// only). selectRows THROWS on an unknown or unselected row and on an empty
// selection — a silently empty project list would report a green run that
// tested nothing.
//
// Rows are parallel CI JOBS, not projects in one job: `workers: 1` serialises
// the suite (every engine needs a private, autoplay-enabled context and a full
// 10-cycle lifecycle), so adding rows to one job would blow its timeout.
//
// ignoreHTTPSErrors is required per project, not optional: the rows run the
// controls/recovery suite too, and the browser-phone harness serves a per-run CA
// over HTTPS. A row without it fails the phone specs for a reason unrelated to
// its engine.
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { EVENTS, launchTarget, rowsForEvent, selectRows } from './rows.mjs';
import { launchOptionsFor } from './launch';

const testRoot = fileURLToPath(new URL('..', import.meta.url));
// Both webServer commands below are written repo-root-relative (identical to the
// root playwright.config.ts). Playwright defaults a webServer's cwd to the
// CONFIG's directory, which here is test/browser-matrix — without this the
// commands resolve to test/browser-matrix/test/browser-media/server.mjs and
// every row dies with MODULE_NOT_FOUND before a browser is launched.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const event = process.env.MATRIX_EVENT ?? 'nightly';
if (!EVENTS.includes(event)) throw new Error(`MATRIX_EVENT=${event} is not one of ${EVENTS.join('|')}`);

const ids = (process.env.MATRIX_ROWS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const rows = selectRows(ids, rowsForEvent(event));

const DEVICE = {
  chromium: 'Desktop Chrome',
  firefox: 'Desktop Firefox',
  webkit: 'Desktop Safari',
} as const;

export default defineConfig({
  testDir: testRoot,
  testMatch: /(browser-media|browser-phone|browser-matrix)\/.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['./report.mjs', {}]],
  use: {
    baseURL: 'http://127.0.0.1:4100',
  },
  webServer: [
    {
      command: 'node test/browser-media/server.mjs',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4100/index.html',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node test/browser-phone/server.mjs',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4300/index.html',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: rows.map((row) => ({
    name: row.id,
    use: {
      ...devices[DEVICE[row.engine]],
      ignoreHTTPSErrors: true,
      // launchTarget enforces locked decision 6: a bundled row refuses an
      // external path, a vendor row refuses to run without one.
      launchOptions: { ...launchOptionsFor(row.engine), ...launchTarget(row) },
    },
  })),
});
