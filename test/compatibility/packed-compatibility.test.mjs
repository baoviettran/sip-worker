// Task 7: combined cross-package identity + deterministic signaling smoke gate.
//
// Packs all three workspaces (core before the adapters) and installs the three
// tarballs together into fresh ESM, CommonJS, and TypeScript consumer fixtures.
// Each fixture asserts cross-package class identity (sip-worker.SipError ===
// @sip-worker/core.SipError, node-adapter errors are real core TransportErrors)
// and runs deterministic browser/node signaling smoke flows driven by core
// UserAgent/codec fakes — proving package composition, not external-server
// interoperability. The local core tarball is supplied in the same npm install
// so npm never fetches the registry 0.5.0.
//
// Run via `npm run test:compatibility`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  cleanup,
  makeTempDir,
  packWorkspaces,
} from '../package/pack-workspaces.mjs';

const execFileAsync = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const fixturesRoot = join(here, 'fixtures');
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

const temp = await makeTempDir('sip-worker-compat-');
try {
  // ---- pack every workspace (core → browser → node) ----
  const tarballs = await packWorkspaces(temp);
  const toInstall = [
    tarballs['@sip-worker/core'],
    tarballs['sip-worker'],
    tarballs['@sip-worker/node'],
  ];

  // ---- install all three tarballs together into each consumer kind ----
  for (const kind of ['esm', 'cjs', 'types']) {
    const fresh = join(temp, `compat-${kind}`);
    await mkdir(fresh, { recursive: true });
    await cp(join(fixturesRoot, kind), fresh, { recursive: true });

    // Same-command install: the local core tarball answers @sip-worker/core so
    // npm never resolves the registry 0.5.0 for the adapter dependencies.
    await execFileAsync(
      'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
        '--no-package-lock', ...toInstall],
      { cwd: fresh },
    );

    if (kind === 'esm' || kind === 'cjs') {
      const entry = kind === 'esm' ? 'index.mjs' : 'index.cjs';
      const r = await execFileAsync(process.execPath, [join(fresh, entry)], { cwd: fresh });
      assert.match(r.stdout, /OK/, `${kind} combined fixture did not report OK`);
    } else {
      const tsc = join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
      await execFileAsync(process.execPath, [tsc, '--project', 'tsconfig.json'], { cwd: fresh });
    }
  }

  console.log('packed-compatibility OK: combined identity + signaling smoke pass for ESM, CJS, TS');
} finally {
  await cleanup(temp);
}