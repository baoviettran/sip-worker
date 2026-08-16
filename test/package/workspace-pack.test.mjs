// Task 7: independently valid workspace tarballs + isolated package consumers.
//
// Packs every workspace into a fresh temp directory via the shared
// packWorkspaces() helper (core before the adapters), asserts each tarball is a
// clean, independently valid archive, then installs each tarball into its own
// fresh ESM, CommonJS, and TypeScript consumer fixture and executes it. The
// per-tarball fixtures prove each package resolves every advertised subpath at
// runtime (import + require) and compiles against every `.d.ts`/`.d.cts`.
//
// Run via `npm run test:package`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  cleanup,
  makeTempDir,
  packWorkspaces,
} from './pack-workspaces.mjs';

const execFileAsync = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const fixturesRoot = join(here, 'fixtures');
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

// Task 1 dependency contract: the adapters depend on the local core at the
// exact workspace version; core has no dependencies. 0.7.0 release contract.
const EXPECTED_DEPENDENCIES = {
  '@sip-worker/core': undefined,
  'sip-worker': { '@sip-worker/core': '0.7.0' },
  '@sip-worker/node': { '@sip-worker/core': '0.7.0' },
};

const DIR_BY_NAME = {
  '@sip-worker/core': 'core',
  'sip-worker': 'browser',
  '@sip-worker/node': 'node',
};

const temp = await makeTempDir('sip-worker-pack-');
try {
  // ---- pack every workspace (core → browser → node) ----
  const tarballs = await packWorkspaces(temp);
  assert.deepEqual(
    Object.keys(tarballs).sort(),
    ['@sip-worker/core', '@sip-worker/node', 'sip-worker'],
    'packWorkspaces returned the wrong set of tarballs',
  );

  // ---- per-tarball content + manifest assertions ----
  for (const name of Object.keys(tarballs)) {
    await assertTarball(tarballs[name], name);
  }

  // ---- per-tarball isolated consumers (ESM, CommonJS, TypeScript) ----
  for (const name of Object.keys(tarballs)) {
    await runConsumers(name, tarballs[name], tarballs['@sip-worker/core']);
  }

  console.log('workspace-pack OK: three clean tarballs pass ESM, CJS, and TS consumers');
} finally {
  await cleanup(temp);
}

/**
 * Assert a single packed tarball is a clean, independently valid archive:
 * every entry is under `package/`, only dist artifacts + package.json + README
 * + LICENSE are present, every advertised export target exists for ESM,
 * CommonJS, `.d.ts`, and `.d.cts`, and the manifest dependency contract holds.
 */
async function assertTarball(tarball, name) {
  const list = (await execFileAsync('tar', ['--list', `--file=${tarball}`]))
    .stdout.split('\n').filter(Boolean);

  // ---- every entry is under package/ ----
  const off = list.filter((e) => !e.startsWith('package/'));
  assert.deepEqual(off, [], `${name}: tarball has non-package entries: ${off.join(', ')}`);

  // ---- only dist/**, package.json, README.md, LICENSE are packed ----
  const alwaysIncluded = new Set([
    'package/package.json', 'package/README.md', 'package/LICENSE',
  ]);
  for (const e of list) {
    if (e === 'package/') continue; // root dir entry
    if (alwaysIncluded.has(e)) continue;
    const rel = e.slice('package/'.length);
    assert.ok(rel.startsWith('dist/'), `${name}: non-dist entry in tarball: ${e}`);
  }

  // ---- every advertised export target must exist for all four formats ----
  const dir = nameToDir(name);
  const pkg = JSON.parse(await readFile(join(packageRoot, 'packages', dir, 'package.json')));
  const subpaths = Object.keys(pkg.exports ?? {});
  assert.ok(subpaths.length > 0, `${name}: no exports map`);
  for (const sub of subpaths) {
    const subDir = sub === '.' ? '' : sub.slice(2);
    const prefix = subDir === '' ? 'dist' : `dist/${subDir}`;
    for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
      const target = `package/${prefix}/${file}`;
      assert.ok(list.includes(target), `${name}: tarball missing export target ${target} (subpath ${sub})`);
    }
  }

  // ---- manifest dependency names/versions match Task 1 ----
  const expected = EXPECTED_DEPENDENCIES[name];
  if (expected === undefined) {
    assert.equal(pkg.dependencies, undefined, `${name}: core must have no dependencies`);
  } else {
    assert.deepEqual(pkg.dependencies, expected, `${name}: manifest dependencies mismatch`);
  }
  assert.equal(pkg.version, '0.7.0', `${name}: unexpected version`);
}

/**
 * Marshal the per-package fixture directory (<fixturesRoot>/<name>/<kind>) into
 * a fresh temp consumer, install the packed tarball (supplying the local core
 * tarball in the same install so npm never fetches the registry copy), then
 * execute the ESM/CJS fixture or compile the TypeScript fixture.
 */
async function runConsumers(name, tarball, coreTarball) {
  const dir = nameToDir(name);
  for (const kind of ['esm', 'cjs', 'types']) {
    const fresh = join(temp, `consumer-${dir}-${kind}`);
    await mkdir(fresh, { recursive: true });
    await cp(join(fixturesRoot, dir, kind), fresh, { recursive: true });

    // Install the local core tarball in the same command so npm never resolves
    // an adapter's `@sip-worker/core` dependency against the registry copy.
    await execFileAsync(
      'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
        '--no-package-lock', tarball, coreTarball],
      { cwd: fresh },
    );

    if (kind === 'esm' || kind === 'cjs') {
      const entry = kind === 'esm' ? 'index.mjs' : 'index.cjs';
      const r = await execFileAsync(process.execPath, [join(fresh, entry)], { cwd: fresh });
      assert.match(r.stdout, /OK/, `${name} ${kind} consumer did not report OK`);
    } else {
      const tsc = join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
      await execFileAsync(process.execPath, [tsc, '--project', 'tsconfig.json'], { cwd: fresh });
    }
  }
}

function nameToDir(name) {
  return DIR_BY_NAME[name];
}