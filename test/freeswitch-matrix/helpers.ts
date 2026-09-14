// test/freeswitch-matrix/helpers.ts — Playwright glue for the matrix harness.
//
// The DEFAULT export is the globalSetup: it boots ONE FreeSWITCH container for
// the whole run (startFreeSwitch renders the conf tree + mints the WSS TLS
// pair, exactly as fsctl.infra.test.ts does), persists the FsHandle to a temp
// file, and exports its path through MATRIX_FS_HANDLE_FILE so workers can read
// it. Playwright registers a function RETURNED from globalSetup as teardown,
// so stopFreeSwitch runs there — there is no separate globalTeardown file.
//
// bootMatrix opens the harness page with the per-run FS WSS port in the ?wss=
// query (the page server is FreeSWITCH-agnostic), waits for the packed bundle
// to boot, and clicks the unlock-audio button. runStep invokes the page global
// __runMatrixStep and returns the plain-data MatrixResult; disposeMatrix
// best-effort disposes any in-page phones (the container itself is shared and
// torn down once by the globalSetup teardown).

import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { startFreeSwitch, stopFreeSwitch, type FsHandle } from './fsctl';

export interface MatrixEvent {
  type: string;
  detail: string;
}

export interface MatrixResult {
  ok: boolean;
  detail: string;
  errorCode?: string;
  result?: unknown;
  events: MatrixEvent[];
}

export interface MatrixContext {
  handle: FsHandle;
  url: string;
  page: Page;
}

interface HandleFile {
  handle: FsHandle;
}

const HANDLE_FILE_ENV = 'MATRIX_FS_HANDLE_FILE';
const BASE_URL = process.env.MATRIX_BASE_URL ?? 'https://127.0.0.1:4500';

let bootSeq = 0;

// ---------------------------------------------------------------------------
// globalSetup / teardown
// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<() => Promise<void>> {
  const handle = await startFreeSwitch(join(import.meta.dirname, 'fs-conf'));
  const file = join(tmpdir(), `fsmatrix-handle-${process.pid}-${randomUUID()}.json`);
  const payload: HandleFile = { handle };
  writeFileSync(file, JSON.stringify(payload));
  process.env[HANDLE_FILE_ENV] = file;
  console.log(
    `[matrix] FreeSWITCH up: sip=${handle.sipPort} ws=${handle.wsPort} wss=${handle.wssPort} (handle: ${file})`,
  );
  return async () => {
    try {
      await stopFreeSwitch(handle);
    } finally {
      rmSync(file, { force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Worker-side helpers
// ---------------------------------------------------------------------------

/** Read the FsHandle persisted by globalSetup (env-carried handle file). */
export function readHandle(): FsHandle {
  const file = process.env[HANDLE_FILE_ENV];
  if (!file) {
    throw new Error(
      `${HANDLE_FILE_ENV} is unset — the matrix globalSetup (helpers.ts default export) must run first`,
    );
  }
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as HandleFile;
  if (!parsed?.handle?.wssPort) {
    throw new Error(`matrix handle file ${file} does not contain a valid FsHandle`);
  }
  return parsed.handle;
}

/** Navigate to the harness page, wait for the packed bundle to boot, unlock audio. */
export async function bootMatrix(page: Page): Promise<MatrixContext> {
  const handle = readHandle();
  const url = `${BASE_URL}/index.html?wss=${handle.wssPort}&run=${++bootSeq}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The packed bundle sets this after wiring __runMatrixStep; a script-tag
  // failure (e.g. the server's 503) leaves it false and surfaces in the
  // timeout error below via the page's #status text.
  await page.waitForFunction(() => (window as { __matrixRun?: { booted?: boolean } }).__matrixRun?.booted === true, undefined, {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'unlock audio' }).click();
  await page.waitForFunction(
    () => document.querySelector<HTMLButtonElement>('#unlock')?.getAttribute('data-unlocked') === '1',
    undefined,
    { timeout: 10_000 },
  );
  return { handle, url, page };
}

/** Run one matrix step in the page; resolves the plain-data MatrixResult. */
export async function runStep(
  page: Page,
  name: string,
  args: { user: string; password: string },
): Promise<MatrixResult> {
  return page.evaluate(
    async ({ stepName, stepArgs }) =>
      (window as unknown as {
        __runMatrixStep: (n: string, a: unknown) => Promise<unknown>;
      }).__runMatrixStep(stepName, stepArgs) as Promise<MatrixResult>,
    { stepName: name, stepArgs: args },
  );
}

/** Best-effort in-page teardown (the FS container is torn down by globalSetup). */
export async function disposeMatrix(ctx: MatrixContext): Promise<void> {
  const page = ctx.page;
  if (!page) return;
  try {
    await page.evaluate(() => {
      const w = window as unknown as { __matrixDispose?: () => Promise<void> };
      return w.__matrixDispose ? w.__matrixDispose() : undefined;
    });
  } catch {
    // The page may already be closing; nothing to clean up then.
  }
}
