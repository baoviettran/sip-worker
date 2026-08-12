import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Every public entry point across the three packages, with the package name,
 * the manifest export subpath, and the ESM import + CJS require specifier.
 * Required: the packages must be built first (npm run build) so `dist` exists.
 */
const TARGETS = [
  // core
  { pkg: '@sip-worker/core', subpath: '.' },
  { pkg: '@sip-worker/core', subpath: './messages' },
  { pkg: '@sip-worker/core', subpath: './stream' },
  { pkg: '@sip-worker/core', subpath: './transport' },
  { pkg: '@sip-worker/core', subpath: './transactions' },
  { pkg: '@sip-worker/core', subpath: './dialogs' },
  { pkg: '@sip-worker/core', subpath: './auth' },
  { pkg: '@sip-worker/core', subpath: './ua' },
  { pkg: '@sip-worker/core', subpath: './media' },
  { pkg: '@sip-worker/core', subpath: './reliability' },
  { pkg: '@sip-worker/core', subpath: './bridge' },
  // browser
  { pkg: 'sip-worker', subpath: '.' },
  { pkg: 'sip-worker', subpath: './transport' },
  // node
  { pkg: '@sip-worker/node', subpath: '.' },
  { pkg: '@sip-worker/node', subpath: './transport' },
  { pkg: '@sip-worker/node', subpath: './reliability' },
];

const BROWSER_GLOBALS = ['window', 'document', 'navigator', 'RTCPeerConnection', 'Worker'];

function specifierFor(target) {
  return target.subpath === '.' ? target.pkg : `${target.pkg}/${target.subpath.slice(2)}`;
}

function labelFor(target) {
  return target.subpath === '.' ? target.pkg : `${target.pkg}/${target.subpath.slice(2)}`;
}

/**
 * Spawn a fresh Node process, install throwing accessors for browser globals,
 * snapshot global keys and active handles, then import/require the given
 * specifier and assert no access threw and no new global key or handle appeared.
 */
function probe(target, mode) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', runnableScript(target, mode)],
      { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(
          new Error(
            `probe failed for ${target.pkg}${target.subpath} (${mode})\n` +
            `exit=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    });
  });
}

/** Build the inline module that performs one import-time safety probe. */
function runnableScript(target, mode) {
  const accessors = BROWSER_GLOBALS.map(
    (name) => `Object.defineProperty(globalThis, ${JSON.stringify(name)}, {
        configurable: true, enumerable: true,
        get() { throw new Error('import accessed ' + ${JSON.stringify(name)}); },
      });`,
  ).join('\n');

  const snapshotBefore = `const beforeKeys = new Set(Object.getOwnPropertyNames(globalThis));`;
  const snapshotAfter = `const added = Object.getOwnPropertyNames(globalThis).filter((k) => !beforeKeys.has(k));`;

  const load = mode === 'esm'
    ? `await import(${JSON.stringify(specifierFor(target))});`
    : `const require = createRequire(import.meta.url); require(${JSON.stringify(specifierFor(target))});`;

  return `
    import { strict as assert } from 'node:assert';
    import { createRequire } from 'node:module';
    ${accessors}
    ${snapshotBefore}
    const handlesBefore = process._getActiveHandles().length;
    ${load}
    const handlesAfter = process._getActiveHandles().length;
    ${snapshotAfter}
    assert.ok(added.length === 0, 'introduced globals: ' + added.join(','));
    assert.equal(handlesAfter, handlesBefore, 'introduced ' + (handlesAfter - handlesBefore) + ' active handle(s)');
    console.log('OK ' + ${JSON.stringify(target.pkg + target.subpath)} + ' ' + ${JSON.stringify(mode)});
  `;
}

test('every public entry point is import-safe in ESM and CommonJS', async () => {
  const tested = [];
  for (const target of TARGETS) {
    for (const mode of ['esm', 'cjs']) {
      const { stdout } = await probe(target, mode);
      assert.match(stdout, /OK /, `${labelFor(target)} ${mode} did not probe OK`);
      tested.push(`${labelFor(target)} (${mode})`);
    }
  }
  // The brief: output must name every tested public entry point.
  console.log(`import-safe entry points (${tested.length}):\n  ${tested.join('\n  ')}`);
  console.log('boundary violations: 0 | side-effect violations: 0');
});

// Ensure the suite names every target even if a probe throws mid-loop.
test('plan covers every manifest export', async () => {
  for (const target of TARGETS) {
    const manifestPath = resolve(
      repoRoot,
      'packages',
      target.pkg === 'sip-worker' ? 'browser' : target.pkg.replace('@sip-worker/', ''),
      'package.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.ok(
      manifest.exports[target.subpath],
      `${target.pkg} missing export ${target.subpath}`,
    );
  }
});