// test/matrix-shared/helpers.ts — Playwright glue shared by every PBX matrix.
//
// The returned globalSetup boots ONE container for the whole run, persists the
// handle to a temp file, and exports its path through the tree's handleEnvVar so
// workers can read it. Playwright registers a function RETURNED from
// globalSetup as teardown, so the container stops there — there is no separate
// globalTeardown file. bootMatrix opens the harness page with the per-run WSS
// port in the ?wss= query and the PBX image under test in ?image= (the page
// server is PBX-agnostic); runStep invokes the page global __runMatrixStep.
import type { Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

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

/** Anything with a WSS port can be a matrix handle; each tree adds its own fields. */
export interface MatrixHandle {
  wssPort: number;
}

export interface MatrixContext<H extends MatrixHandle> {
  handle: H;
  url: string;
  page: Page;
}

export interface MatrixHarnessOptions<H extends MatrixHandle> {
  /** Human label for log lines ('FreeSWITCH', 'Asterisk'). */
  label: string;
  /** Env var carrying the handle-file path — per tree, so two matrices can run at once. */
  handleEnvVar: string;
  /** Page-server port when MATRIX_HTTP_PORT is unset. */
  defaultHttpPort: number;
  /** The digest-pinned PBX image under test, carried in the ?image= query. */
  imageRef: string;
  boot: () => Promise<H>;
  stop: (h: H) => Promise<void>;
}

export function createMatrixHelpers<H extends MatrixHandle>(opts: MatrixHarnessOptions<H>) {
  const baseUrl =
    process.env.MATRIX_BASE_URL ?? `https://127.0.0.1:${Number(process.env.MATRIX_HTTP_PORT ?? opts.defaultHttpPort)}`;
  let bootSeq = 0;

  async function globalSetup(): Promise<() => Promise<void>> {
    const handle = await opts.boot();
    const file = join(tmpdir(), `matrix-handle-${process.pid}-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ handle }));
    process.env[opts.handleEnvVar] = file;
    // The WHOLE handle, not just wssPort: every port is what CI reaches for
    // when a leg fails, and each tree adds its own fields.
    console.log(
      `[matrix] ${opts.label} up: ${JSON.stringify(handle)} (handle: ${file})`,
    );
    return async () => {
      try {
        await opts.stop(handle);
      } finally {
        rmSync(file, { force: true });
      }
    };
  }

  /** Read the handle persisted by globalSetup (env-carried handle file). */
  function readHandle(): H {
    const file = process.env[opts.handleEnvVar];
    if (!file) {
      throw new Error(
        `${opts.handleEnvVar} is unset — the matrix globalSetup (helpers.ts default export) must run first`,
      );
    }
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { handle?: H };
    if (!parsed?.handle?.wssPort) {
      throw new Error(`matrix handle file ${file} does not contain a valid ${opts.label} handle`);
    }
    return parsed.handle;
  }

  /** Navigate to the harness page, wait for the packed bundle to boot, unlock audio. */
  async function bootMatrix(page: Page): Promise<MatrixContext<H>> {
    const handle = readHandle();
    const url = `${baseUrl}/index.html?wss=${handle.wssPort}&image=${encodeURIComponent(opts.imageRef)}&run=${++bootSeq}`;
    // The run record (criterion 8), and ONLY when the runner asks for one
    // (the Asterisk workflow sets MATRIX_RECORD_FILE under matrix-record/ for
    // both jobs — NOT under artifacts/, so that the artifacts/ uploader's
    // `if-no-files-found: error` keeps meaning "the test produced artifacts";
    // the FreeSWITCH workflow deliberately does not set it at all).
    //
    // With it unset this block does nothing whatsoever — no binding installed,
    // no path resolved, no file touched — so the page side is exactly what it
    // was before and the frozen tree's runtime is unchanged. Read HERE rather
    // than in steps.ts because that module is bundled into the browser, where
    // `process` does not exist; the page only ever calls the binding.
    //
    // Registered before the navigation so the binding is present for the boot
    // line bootMatrixPage logs, which is the provenance the record exists for.
    const recordFile = process.env.MATRIX_RECORD_FILE;
    if (recordFile) {
      mkdirSync(dirname(recordFile), { recursive: true });
      await page.exposeFunction('__matrixRecordAppend', (line: string) => {
        appendFileSync(recordFile, `${line}\n`);
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // The packed bundle sets this after wiring __runMatrixStep; a script-tag
    // failure (the server's 503) leaves it false and surfaces in the timeout.
    await page.waitForFunction(
      () => (window as { __matrixRun?: { booted?: boolean } }).__matrixRun?.booted === true,
      undefined,
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'unlock audio' }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('#unlock')?.getAttribute('data-unlocked') === '1',
      undefined,
      { timeout: 10_000 },
    );
    return { handle, url, page };
  }

  /** Run one matrix step in the page; resolves the plain-data MatrixResult. */
  async function runStep(
    page: Page,
    name: string,
    args: { user: string; password: string; stunPort?: number; digits?: string },
  ): Promise<MatrixResult> {
    return page.evaluate(
      async ({ stepName, stepArgs }) =>
        (window as unknown as {
          __runMatrixStep: (n: string, a: unknown) => Promise<unknown>;
        }).__runMatrixStep(stepName, stepArgs) as Promise<MatrixResult>,
      { stepName: name, stepArgs: args },
    );
  }

  /** Best-effort in-page teardown (the container is torn down by globalSetup). */
  async function disposeMatrix(ctx: MatrixContext<H>): Promise<void> {
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

  return { globalSetup, readHandle, bootMatrix, runStep, disposeMatrix };
}
