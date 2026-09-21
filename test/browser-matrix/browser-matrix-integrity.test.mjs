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
  for (const script of ['test:browsermatrix', 'test:browsermatrix:unit', 'test:browsermatrix:integrity', 'test:browsermatrix:docs']) {
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
  // Pinned to the full invocation, not the bare path: `/node test\/browser-matrix\/run-row\.mjs/`
  // is argument-insensitive and also matches an invocation with the row id
  // dropped or the event hard-coded — which would run every row in every job (or
  // none) and still satisfy every rule, measured on a mutated copy.
  assert.match(
    yaml,
    /run-row\.mjs \$\{\{ matrix\.id \}\} --event '\$\{\{ needs\.rows\.outputs\.event \}\}'/,
    'the engine job must run its own row at the event the rows job selected',
  );
  // The publisher must run even when a row job failed, or a red matrix produces a
  // SKIPPED completeness check instead of a diagnostic — the global constraint
  // this rule set previously left unguarded (measured: with only this line
  // deleted, every other rule and `test:docs` stay green). Written as a two-line
  // sequence because `needs: [rows, engine]` occurs once in the file, so the pair
  // is unambiguous and deleting the `if:` line breaks it.
  assert.match(
    yaml,
    /needs: \[rows, engine\]\n    if: always\(\)/,
    'the publisher must run after both jobs and even when one of them failed',
  );
  assert.match(yaml, /--expected '\$\{\{ needs\.rows\.outputs\.ids \}\}'/, 'the publisher must be told which rows this event expects');
  assert.match(yaml, /name: Matrix rows for this event/, 'the rows job must be identifiable in the checks list');
  // The event -> row-set arms. Rule 8 proves `rowMatrixForEvent('pr')` downloads
  // nothing; this is the other half, that the workflow ever ASKS for 'pr'.
  // Measured: `pull_request) event=nightly` left every gate green while every PR
  // ran all eight rows and both published sentences ("Pull requests run the
  // bundled rows only") became false. The padding between the arm and the value
  // is not pinned beyond one-or-more spaces: the arms are column-aligned, and
  // re-aligning them is an ordinary edit that must not red.
  for (const [trigger, event] of [['pull_request', 'pr'], ['push', 'main'], ['schedule', 'nightly']]) {
    assert.match(
      yaml,
      new RegExp(`^\\s*${trigger}\\)\\s+event=${event}\\s*;;`, 'm'),
      `browser-media.yml must map the ${trigger} event to event=${event}, the row set the matrix is computed from`,
    );
  }
});

test('the workflow runs the offline gates in the rows job, before it schedules eight row jobs', () => {
  // The load-bearing part is their POSITION, not their existence: measured,
  // before this wave no workflow ran either gate, so a Playwright bump or a
  // row-table edit shipped green. `rows` is the only host that both gates every
  // downstream job and runs the gate once — in `engine` it would run nine times
  // for no added coverage, and after the fan-out it would catch a bad row table
  // only once eight jobs were already scheduled.
  const yaml = read('.github/workflows/browser-media.yml');
  const rowsAt = yaml.indexOf('\n  rows:\n');
  const engineAt = yaml.indexOf('\n  engine:\n');
  assert.ok(rowsAt !== -1 && engineAt > rowsAt, 'browser-media.yml must still declare rows before engine');
  const rowsJob = yaml.slice(rowsAt, engineAt);
  // Each needle is the whole step — its name line plus its `run:` line, both
  // newline terminated — so a renamed step or a dropped invocation reds here
  // rather than reporting a green run with a latent gate.
  const steps = [
    '      - name: Unit tests (no docker, no browser, no audio device)\n        run: npm run test:browsermatrix:unit\n',
    '      - name: Integrity + boundary gates\n        run: npm run test:browsermatrix:integrity\n',
  ];
  const missing = steps.filter((step) => !rowsJob.includes(step));
  assert.deepEqual(
    missing,
    [],
    `the rows job must run the offline gates: missing ${missing.map((step) => step.trim().split('\n')[0]).join(', ')}`,
  );
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

test('the Safari gate runs, always, and cannot be neutralised', () => {
  const safari = read('.github/workflows/safari-media.yml');

  // Every needle below is terminated with its own newline. A needle that stops
  // mid-line is satisfied by any suffix, so an unterminated `if: always()` would
  // still pass on `if: always() && github.ref == 'refs/heads/main'` — a gate
  // that skips on every pull request while the job reports green.
  const line = (text) => `${text}\n`;

  // The step that runs the media suite must still run it, unconditionally.
  // Pinned as the name-plus-`if:` pair because the file has three `if: always()`
  // lines (`:42` here, `:57` on the CA-trust removal, `:74` on the upload), so
  // the bare `if:` identifies nothing.
  //
  // The load-bearing edit this catches today is `if: false`, which turns the
  // gate into a green job with no media coverage. `if: success()` would be
  // equivalent *today* — the only step before the gate cannot fail (`|| true`)
  // — and is caught anyway, so that adding a step which can fail doesn't
  // silently take the gate's diagnostic with it.
  assert.ok(
    safari.includes(
      line('      - name: Run the Safari acceptance gates (media + phone controls/recovery)')
      + line('        if: always()'),
    ),
    'safari-media.yml must still run its acceptance gate, unconditionally — a skipped gate is a green job with no media coverage',
  );

  // The report directory must reach the runner's own invocation, and must sit on
  // the gate step rather than some other step's inert `env:`. Asserted by
  // position — the variable between the gate step's name and its `run:` line —
  // rather than as an adjacent pair, which would also pin it as the step's last
  // env key and red on a correct workflow that adds a variable or a comment
  // after it. Terminating the `run:` needle is what catches `…mjs || true`.
  const gateNameAt = safari.indexOf(line('      - name: Run the Safari acceptance gates (media + phone controls/recovery)'));
  const gateEnvAt = safari.indexOf(line('          MATRIX_REPORT_DIR: test-results/browser-matrix'));
  const gateRunAt = safari.indexOf(line('        run: node test/browser-media/safari-runner.mjs'));
  assert.ok(
    gateNameAt !== -1 && gateEnvAt !== -1 && gateRunAt !== -1
      && gateNameAt < gateEnvAt && gateEnvAt < gateRunAt,
    'the Safari gate must hand its own run the report directory, since the publication reads the file it writes',
  );

  // No step may swallow a failure. This is the whole fail-never-skip constraint
  // for BOTH gated workflows: without it, a red gate exits 0 and the job goes
  // green.
  //
  // Matched as a YAML key at line start, not as a substring: safari-media.yml's
  // header comment reads "there is NO `continue-on-error` and NO ...", so a
  // substring test fails on the correct file. Anchoring on the key also means a
  // commented-out `# continue-on-error: true` stays inert, which is right — it
  // does nothing.
  //
  // The value is read too, and only `false` is accepted. `continue-on-error:
  // false` is inert, and spelling it out is how an editor documents the
  // constraint — reding on it would punish the right instinct. Any other value
  // (including bare `no`/`off`, which Actions need not read as boolean) reds:
  // fail-closed is the correct direction for this rule. The message names the
  // workflow, because the two differ in what they run, not in this rule.
  for (const [workflow, text] of [
    ['safari-media.yml', safari],
    ['browser-media.yml', read('.github/workflows/browser-media.yml')],
  ]) {
    assert.ok(
      !/^\s*continue-on-error\s*:(?!\s*false\b)/m.test(text),
      `no step in ${workflow} may swallow a failure`,
    );
  }

  // The report must ship inside the artifact the publication downloads, under
  // the name it downloads. Each required path is asserted present, so losing one
  // is loud; adding one is not, because widening an artifact's contents is
  // ordinary maintenance rather than a weakening.
  assert.ok(
    safari.includes(line('          name: safari-media-${{ github.run_id }}')),
    'the Safari report must ship inside the artifact the publication downloads',
  );
  const requiredPaths = [
    '            test-results/',
    '            safari-runner.log',
    '            safari-boot-failure-*.png',
    '            safari-ca.crt',
    '            safari-leaf.crt',
    '            test-results/browser-matrix/',
  ];
  const missing = requiredPaths.filter((path) => !safari.includes(line(path)));
  assert.deepEqual(
    missing,
    [],
    `the Safari artifact must still ship: ${missing.join(', ')}`,
  );
});
