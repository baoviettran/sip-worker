import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const requireFromRoot = createRequire(import.meta.url);
const fixturesRoot = join(packageRoot, 'test', 'package', 'fixtures');

/**
 * Every advertised subpath. Each must resolve for ESM import, CommonJS require,
 * and via the installed package's .d.ts (proven by the TypeScript fixture).
 */
const SUBPATHS = [
  '.',
  './messages',
  './stream',
  './transport/node',
  './transport/browser',
  './transactions',
  './dialogs',
  './auth',
  './ua',
  './media',
  './reliability',
  './bridge',
];

// ---- (1) root import touches no browser/worker/socket/timer/crypto global ----
const SIDE_EFFECT_FIXTURE = `
import { strict as assert } from 'node:assert';
// Snapshot the process-wide globals BEFORE importing the root.
const before = new Set(Object.getOwnPropertyNames(globalThis));
// Fully evaluate the installed root module graph.
await import('sip-worker');
// Any global introduced by a side-effectful import (browser/worker/socket/
// timer/crypto, or a leaked Node adapter) shows up here. Node already defines
// crypto/WebSocket/setTimeout/process; an unchanged own-key set proves the root
// introduced none of them.
const after = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
assert.ok(after.length === 0, \`root import introduced globals: \${after.join(',')}\`);
console.log('root-no-sideeffects OK');
`;

const temporaryRoot = await mkdtemp(join(tmpdir(), 'sip-worker-package-'));
try {
  // ---- pack the tarball ----
  const packed = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryRoot],
    { cwd: packageRoot },
  );
  const packJson = JSON.parse(packed.stdout);
  const packResults = Array.isArray(packJson) ? packJson : Object.values(packJson);
  assert.equal(packResults.length, 1);
  const tarball = join(temporaryRoot, packResults[0].filename);

  // ---- assert every required artifact exists inside the packed tarball ----
  const filesInTarball = await tarballEntries(tarball);
  const artifactReqs = SUBPATHS.map((subpath) => {
    const dir = subpath === '.' ? 'dist/' : `dist/${subpath.slice(2)}/`;
    return [`${dir}index.js`, `${dir}index.cjs`, `${dir}index.d.ts`, `${dir}index.d.cts`];
  }).flat();
  for (const artifact of artifactReqs) {
    assert.ok(
      filesInTarball.some((name) => name.endsWith(artifact)),
      `tarball missing artifact ${artifact}`,
    );
  }

  // ---- build + run the isolated consumer fixtures against the tarball ----
  await runConsumer('esm', tarball);
  await runConsumer('cjs', tarball);
  await runConsumer('types', tarball);

  // ---- root import introduces no globals (side-effect probe) ----
  const probeDir = join(temporaryRoot, 'consumer-probe');
  await mkdir(probeDir, { recursive: true });
  await writeFile(
    join(probeDir, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2),
  );
  await writeFile(join(probeDir, 'probe.mjs'), SIDE_EFFECT_FIXTURE);
  await installTarball(probeDir, tarball);
  const probe = await execFileAsync(process.execPath, [join(probeDir, 'probe.mjs')], { cwd: probeDir });
  assert.match(probe.stdout, /root-no-sideeffects OK/, 'side-effect probe did not pass');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

/**
 * Marshal one fixture directory (test/package/fixtures/<name>) into a fresh temp
 * consumer, install the packed tarball there, then execute (esm/cjs) or compile
 * (types) it.
 */
async function runConsumer(name, tarball) {
  const fresh = join(temporaryRoot, `consumer-${name}`);
  await mkdir(fresh, { recursive: true });
  await cp(join(fixturesRoot, name), fresh, { recursive: true });
  await installTarball(fresh, tarball);

  if (name === 'esm' || name === 'cjs') {
    const entry = name === 'esm' ? 'index.mjs' : 'index.cjs';
    const r = await execFileAsync(process.execPath, [join(fresh, entry)], { cwd: fresh });
    assert.match(r.stdout, /OK/, `${name} consumer did not report OK`);
  } else {
    const tsc = join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    await execFileAsync(process.execPath, [tsc, '--project', 'tsconfig.json'], { cwd: fresh });
  }
}

async function installTarball(cwd, tarball) {
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    { cwd },
  );
}

/** List file paths inside an npm tarball. */
async function tarballEntries(tarball) {
  const out = await execFileAsync('tar', ['--list', `--file=${tarball}`]);
  return out.stdout.split('\n').filter(Boolean);
}

// Keep the direct-from-dist smoke assertions that the original test performed.
{
  const root = await import('../../dist/index.js');
  const messages = await import('../../dist/messages/index.js');
  const stream = await import('../../dist/stream/index.js');
  const required = requireFromRoot('../../dist/index.cjs');
  assert.equal(typeof root.SipStreamDecoder, 'function');
  assert.equal(typeof root.SipIngress, 'function');
  assert.equal(typeof stream.SipStreamDecoder, 'function');
  assert.equal(typeof messages.parseMessage, 'function');
  assert.equal(typeof messages.serializeMessage, 'function');
  assert.equal(typeof required.serializeMessage, 'function');
}
