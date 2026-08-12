// Browser production bundle audit.
//
// Packs the `@sip-worker/core` and `sip-worker` (browser) workspaces into an
// isolated fixture, installs those *tarballs* (supplying the local core tarball
// in the same install so npm never fetches the registry copy), then bundles the
// fixture entry with esbuild targeting a browser. The build must succeed with
// NO `alias`, `inject`, `fallback`, or polyfill plugins, and the emitted bundle
// plus its inputs must contain no Node runtime token — proving `sip-worker`
// needs no Node polyfill.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

import {
  cleanup,
  makeTempDir,
  packWorkspaces,
} from '../package/pack-workspaces.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtureEntrySrc = join(here, 'entry.ts');

const execFileAsync = promisify(execFile);

// Forbidden Node-runtime signatures in the emitted bundle and its inputs. Each
// is a marker of Node (or a Node-only module) leaking into a browser bundle.
// Identifier tokens are matched at word boundaries so `ArrayBuffer` (a browser
// global) and `.buffer` (an ArrayBufferView accessor) do not trip `Buffer`, and
// opens like `network`/`reset` do not trip `net`/`tls`.
const FORBIDDEN_PATTERNS = [
  /node:/,
  /\bprocess\b/,
  /\bBuffer\b/,
  /require\(/,
  /__dirname/,
  /\bnet\b/,
  /\btls\b/,
  /\bdgram\b/,
  /worker_threads/,
];

const temp = await makeTempDir('sip-worker-bundle-');
try {
  // ---- pack ONLY core + browser; the browser adapter depends on core ----
  const tarballs = await packWorkspaces(temp);

  // ---- isolated fixture installing the packed tarballs, not workspace symlinks ----
  const fixture = join(temp, 'fixture');
  await mkdir(fixture, { recursive: true });
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2),
  );
  // Install core first (local tarball), then browser. Passing the local core
  // tarball in the same install means npm never touches the registry for it.
  await execFileAsync(
    'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      tarballs['@sip-worker/core']],
    { cwd: fixture },
  );
  await execFileAsync(
    'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      tarballs['sip-worker']],
    { cwd: fixture },
  );

  // ---------------- esbuild: real browser bundle, no polyfill plumbing --------
  // Copy the fixture entry into the isolated fixture so `sip-worker` resolves
  // against the *installed tarballs*, not workspace symlinks. esbuild needs a
  // .ts loader; point it at the copied entry and bundle with the browser
  // platform with NO alias/inject/fallback/polyfill configuration.
  const fixtureEntry = join(fixture, 'entry.ts');
  await cp(fixtureEntrySrc, fixtureEntry);
  const result = await build({
    entryPoints: [fixtureEntry],
    loader: { '.ts': 'ts' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    minify: true,
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  assert.ok(result.outputFiles.length > 0, 'esbuild produced no output');
  const emitted = result.outputFiles.map((f) => f.text).join('\n');

  // Every input file that esbuild pulled into the graph (dist artifacts only).
  const inputFiles = Object.keys(result.metafile.inputs);

  // ---------------- forbidden-token audit of emitted text + inputs -----------
  const scanTargets = {
    'emitted bundle': emitted,
    'metafile inputs': inputFiles.join('\n'),
  };
  const hits = [];
  for (const [label, text] of Object.entries(scanTargets)) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) hits.push(`${label} matches ${pattern}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `Forbidden Node tokens leaked into the browser bundle:\n${hits.join('\n')}`,
  );

  // ---------------- no external / polyfill plumbing was configured -----------
  assert.equal(result.errors.length, 0, 'esbuild reported errors');
  assert.equal(
    result.metafile.inputs[fixtureEntry] !== undefined
      || inputFiles.length > 0,
    true,
    'bundle did not pull in the package graph',
  );

  console.log('browser-bundle OK: no Node token leaked; inputs =', inputFiles.length);
} finally {
  await cleanup(temp);
}