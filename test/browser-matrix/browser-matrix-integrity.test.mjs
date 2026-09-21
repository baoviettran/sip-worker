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
  const bundled = ROWS.filter((row) => row.provision.kind === 'bundled');
  // Non-vacuity floor: the loop below is the only offline proof that the bundled
  // rows still describe what Playwright ships, so it must not be able to pass
  // having checked nothing.
  assert.ok(bundled.length > 0, 'no bundled rows to cross-check against browsers.json');
  for (const row of bundled) {
    const entry = byName.get(row.engine);
    assert.ok(entry, `browsers.json has no ${row.engine} entry`);
    assert.equal(row.provision.pin, entry.revision, `${row.id}: pin must equal the ${row.engine} revision Playwright ships`);
    assert.equal(row.expectedVersion, entry.browserVersion, `${row.id}: expectedVersion must equal the ${row.engine} version Playwright ships`);
  }
});

test('every row id is referenced by the docs page once it exists', (t) => {
  const page = join(repoRoot, 'docs/supported-browser-matrix.md');
  // Added by a later task, so the rule arms itself then — and says so out loud:
  // an early return is otherwise indistinguishable from a rule that checked, and
  // its green would mean nothing.
  if (!existsSync(page)) {
    t.diagnostic(`${page} does not exist yet — this rule checks nothing until it does`);
    return;
  }
  const text = readFileSync(page, 'utf8');
  for (const row of ROWS) assert.match(text, new RegExp(`\`${row.id}\``), `docs page must name the row ${row.id}`);
});

test('playwright.config.ts keeps launch-only options out of contextOptions', () => {
  // The trap that shipped twice: `firefoxUserPrefs` under `contextOptions` is
  // accepted and silently ignored, making every pref inert and every Firefox leg
  // fail while every Chromium leg passes. The PR slice DOES drive Firefox and
  // WebKit, so a runner would catch it eventually — after a full media suite,
  // and pointing at a failed leg rather than at the line. This rule is offline
  // and names the line.
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
    // Counted, not merely matched: `assert.match` is satisfied by the import line
    // alone, and the drift is per-project — rewriting ONE project's
    // `launchOptions: launchOptionsFor('firefox')` as
    // `contextOptions: launchOptionsFor('firefox')` leaves the other call sites
    // intact, and the shared guard only inspects an object-literal
    // `contextOptions`, so that form is invisible to every other rule here.
    const callSites = source.match(/launchOptionsFor\(/g) ?? [];
    // Line-scoped, so both wired shapes count: the root config's bare call and
    // the row config's `launchOptions: { ...launchOptionsFor(row.engine), ... }`.
    const wired = source.match(/launchOptions:[^\n]*launchOptionsFor\(/g) ?? [];
    assert.ok(callSites.length > 0, `${rel} must call the shared launch module`);
    assert.equal(
      wired.length,
      callSites.length,
      `${rel}: every launchOptionsFor(...) call site must be wired as launchOptions: — one under contextOptions is inert`,
    );
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

test('the workflow runs the matrix as rows, with a nightly schedule and a publisher', () => {
  const yaml = read('.github/workflows/browser-media.yml');
  assert.match(yaml, /schedule:/, 'browser-media.yml needs a nightly schedule (it had none: push and PR only)');
  assert.match(yaml, /cron: '\d+ \d+ \* \* \*'/, 'the schedule must be a cron expression');
  for (const job of ['rows:', 'engine:', 'publisher:', 'forced-turn-relay:']) {
    assert.ok(yaml.includes(`\n  ${job}`), `browser-media.yml has no ${job} job`);
  }
  assert.match(yaml, /fromJSON\(needs\.rows\.outputs\.matrix\)/, 'the engine job matrix must come from the row table');
  assert.match(yaml, /node test\/browser-matrix\/run-row\.mjs/, 'the engine job must run a row through the shared entry point');
  assert.match(yaml, /--expected '\$\{\{ needs\.rows\.outputs\.ids \}\}'/, 'the publisher must be told which rows this event expects');
  assert.match(yaml, /name: Matrix rows for this event/, 'the rows job must be identifiable in the checks list');
});

test('the workflow still installs Playwright engines exactly twice', () => {
  // test/package/documentation-contract.test.mjs:226 asserts this count. Only
  // the two jobs that LAUNCH Playwright engines may carry the install step: the
  // forced-TURN relay job and the row engine job.
  const yaml = read('.github/workflows/browser-media.yml');
  assert.equal((yaml.match(/npm run test:browser-media:install/g) ?? []).length, 2, 'exactly two jobs install engines');
});

test('the old single three-engine job is gone, and its exclusion lives on', () => {
  const yaml = read('.github/workflows/browser-media.yml');
  assert.doesNotMatch(yaml, /^  three-engine:/m, 'the three-engine job is replaced by the row matrix');
  assert.doesNotMatch(yaml, /--project=chromium --project=firefox --project=webkit/, 'the sequential three-project invocation is replaced by per-row jobs');
  assert.match(yaml, /run-row\.mjs/, 'the relay exclusion is owned by run-row.mjs and asserted by its own rule');
});
