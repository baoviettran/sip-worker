// Shared workspace-packing helper for the isolated consumer tests.
//
// Packs every workspace into a caller-provided temp directory by running each
// workspace's `prepack` (which rebuilds `dist` and runs the release gate) and
// then `npm pack --workspace <name>`. Returns absolute tarball paths keyed by
// package name, packed in dependency order (core before the adapters) so that
// an `npm install` of the returned tarballs never resolves the registry copy.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Workspaces in dependency order: `@sip-worker/core` first, then the adapters
 * (`sip-worker` browser, `@sip-worker/node`) that depend on it.
 */
export const WORKSPACES = ['@sip-worker/core', 'sip-worker', '@sip-worker/node'];

/**
 * Pack every workspace into `destination` and return absolute tarball paths
 * keyed by package name. `npm pack --workspace` runs the workspace's `prepack`
 * script (build + release gate) before packing, so the returned tarballs are
 * freshly built release artifacts.
 *
 * @param {string} destination absolute temp directory to write tarballs into
 * @returns {Promise<Record<string, string>>} package name -> absolute tarball path
 */
export async function packWorkspaces(destination) {
  const tarballs = {};
  for (const name of WORKSPACES) {
    // Run the workspace `prepack` (build + release gate) explicitly so it can
  // build `dist` and surface failures early. Then pack with --ignore-scripts:
  // npm would otherwise re-run prepack during pack and interleave the tsup
  // banner into stdout, corrupting the JSON array.
  await execFileAsync('npm', ['run', 'prepack', '--workspace', name], { cwd: packageRoot });
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--workspace', name, '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: packageRoot },
  );
  const parsed = JSON.parse(stdout);
  const results = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const result = results.find((r) => r && r.name === name);
  if (!result) {
    throw new Error(`npm pack --workspace ${name} produced no matching result`);
  }
  tarballs[name] = join(destination, result.filename);
  }
  return tarballs;
}

/**
 * Create a fresh isolated temp directory owned by this test run.
 */
export async function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Remove a temp directory and all contents.
 */
export async function cleanup(path) {
  await rm(path, { recursive: true, force: true });
}