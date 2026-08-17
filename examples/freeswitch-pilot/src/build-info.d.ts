/**
 * Injected build metadata for the FreeSWITCH pilot app.
 *
 * This global is defined at build time by the bundler (e.g. via `define` in
 * esbuild/vite). The declaration lets TypeScript resolve the identifier
 * without a runtime import.
 */
declare const __SIP_WORKER_PILOT_BUILD__: Readonly<{
  readonly packageVersion: string;
  readonly gitCommit: string;
  readonly tarballSha256: string;
}>;
