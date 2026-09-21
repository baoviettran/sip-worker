// test/browser-matrix/browser-matrix-integrity.test.mjs
// Integrity gate for the v0.9 browser matrix. Reads files only: no browser is
// launched, no artifact is downloaded, nothing needs the network. Every rule
// below maps to a claim the spec makes about the tree, so a violation points at
// the edit rather than at a suite that failed for an unrelated reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTRACTED_PATHS, URL_TEMPLATES,
} from './provision.mjs';
import { ROWS, rowMatrixForEvent, rowsForEvent, selectRows } from './rows.mjs';
import { launchOnlyKeysUnderContextOptions } from '../matrix-shared/playwright-config-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

test('the config and the version spec the rows depend on exist', () => {
  for (const rel of [
    'test/browser-matrix/rows.mjs',
    'test/browser-matrix/provision.mjs',
    'test/browser-matrix/launch.ts',
    'test/browser-matrix/playwright.config.ts',
    'test/browser-matrix/version.spec.ts',
    'test/browser-matrix/report.mjs',
    'test/browser-matrix/run-row.mjs',
  ]) {
    assert.ok(existsSync(join(repoRoot, rel)), `missing ${rel}`);
  }
});

test('every provision kind has a URL template and an extracted layout, or neither', () => {
  for (const kind of ['cft', 'pw-firefox', 'edge-deb']) {
    assert.equal(typeof URL_TEMPLATES[kind], 'function', `${kind} has no URL template`);
    assert.ok(EXTRACTED_PATHS[kind], `${kind} has no extracted layout`);
  }
  // bundled is Playwright's own download and runner is provisioned elsewhere;
  // neither may gain an artifact URL without this table and the spec changing.
  for (const kind of ['bundled', 'runner']) {
    assert.equal(URL_TEMPLATES[kind], undefined, `${kind} must not have an artifact URL`);
    assert.equal(EXTRACTED_PATHS[kind], undefined, `${kind} must not have an extracted layout`);
  }
});

test('bundled rows pin exactly what the pinned Playwright ships', () => {
  // OFFLINE cross-check: a Playwright bump moves browsers.json, so this fails
  // loudly here instead of silently re-labelling three rows' engines while the
  // table still claims the old versions.
  const browsers = JSON.parse(read('node_modules/playwright-core/browsers.json'));
  const byName = new Map(browsers.browsers.map((b) => [b.name, b]));
  for (const row of ROWS) {
    if (row.provision.kind !== 'bundled') continue;
    const entry = byName.get(row.engine);
    assert.ok(entry, `browsers.json has no ${row.engine} entry`);
    assert.equal(row.provision.pin, entry.revision, `${row.id}: pin must equal the ${row.engine} revision Playwright ships`);
    assert.equal(row.expectedVersion, entry.browserVersion, `${row.id}: expectedVersion must equal the ${row.engine} version Playwright ships`);
  }
});

test('every row id is referenced by the docs page once it exists', () => {
  const page = join(repoRoot, 'docs/supported-browser-matrix.md');
  if (!existsSync(page)) return; // added by a later task; the rule arms itself then
  const text = readFileSync(page, 'utf8');
  for (const row of ROWS) assert.match(text, new RegExp(`\`${row.id}\``), `docs page must name the row ${row.id}`);
});

test('playwright.config.ts keeps launch-only options out of contextOptions', () => {
  // The trap that shipped twice: `firefoxUserPrefs` under `contextOptions` is
  // accepted and silently ignored, making every pref inert and every Firefox leg
  // fail while every Chromium leg passes — and the row matrix's PR slice installs
  // Chromium-family engines only, so nothing else here would catch it.
  for (const rel of ['test/browser-matrix/playwright.config.ts', 'playwright.config.ts']) {
    const found = launchOnlyKeysUnderContextOptions(read(rel), rel);
    assert.deepStrictEqual(
      found,
      [],
      `launch-only option(s) under contextOptions in ${rel} — inert there: ${found.map((f) => `${f.key} (line ${f.line})`).join(', ')}`,
    );
  }
});

test('both configs route launch options through the shared module', () => {
  for (const rel of ['test/browser-matrix/playwright.config.ts', 'playwright.config.ts']) {
    const source = read(rel);
    assert.match(source, /launchOptionsFor\(/, `${rel} must import the shared launch module`);
    assert.doesNotMatch(source, /firefoxUserPrefs\s*:/, `${rel} must not re-declare the Firefox prefs (drift)`);
  }
});

test('the row config matches the two suites verbatim plus its own version spec', () => {
  const source = read('test/browser-matrix/playwright.config.ts');
  // Compared as a literal, not as a regex: the line under test is itself a regex
  // full of backslashes, and a regex-escaped version of it is unreadable enough
  // that a later editor "fixing" the escaping would silently stop matching.
  const testMatchLine = String.raw`testMatch: /(browser-media|browser-phone|browser-matrix)\/.*\.spec\.ts$/,`;
  assert.ok(source.includes(testMatchLine), `testMatch must cover the reused suites and this tree; expected line ${testMatchLine}`);
  assert.match(source, /ignoreHTTPSErrors: true/, 'rows must ignore the per-run CA of the phone harness');
  assert.match(source, /selectRows\(ids, rowsForEvent\(event\)\)/, 'row selection must be the throwing one');
});

test('the runner carries the relay exclusion', () => {
  // A row job has no coturn; the relay spec fails by design when TURN_URL and
  // TURN_PEER_URL are absent, so a row without this exclusion fails every time.
  assert.match(read('test/browser-matrix/run-row.mjs'), /--grep-invert', 'forced TURN relay'/, 'run-row must exclude the forced-TURN specs');
});

test('row selection throws on the two shapes that would otherwise report green', () => {
  assert.throws(() => selectRows(['chrome-current'], rowsForEvent('pr')), /not selected for this event/);
  assert.throws(() => selectRows([], ROWS), /no rows selected/);
  assert.throws(() => selectRows(['nope'], ROWS), /unknown row id/);
});

test('the PR slice stays vendor-free and the Safari row stays out of the Linux matrix', () => {
  for (const entry of rowMatrixForEvent('pr')) {
    const row = ROWS.find((r) => r.id === entry.id);
    assert.equal(row.provision.kind, 'bundled', `${entry.id} would download a vendor artifact on every PR`);
  }
  for (const event of ['pr', 'main', 'nightly']) {
    assert.ok(!rowMatrixForEvent(event).some((e) => e.id === 'safari-current'), `safari-current must not be a Linux row job (${event})`);
  }
});

test('the npm scripts and the vitest include entry exist', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const script of ['test:browsermatrix', 'test:browsermatrix:unit', 'test:browsermatrix:integrity']) {
    assert.equal(typeof pkg.scripts[script], 'string', `package.json has no ${script} script`);
  }
  assert.match(read('vitest.config.ts'), /test\/browser-matrix\/\*\*\/\*\.unit\.test\.ts/, 'vitest.config.ts must include the browser-matrix unit tests');
});

test('matrix tree is fully enumerated (floor check)', () => {
  const files = readdirSync(__dirname).filter((f) => statSync(join(__dirname, f)).isFile());
  assert.ok(files.length >= 8, `browser-matrix has ${files.length} files, expected >= 8 — scan may be incomplete`);
  assert.ok(relative(repoRoot, __dirname).startsWith('test/'), 'sanity: this gate lives under test/');
});
