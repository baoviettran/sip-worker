// test/asterisk-matrix/matrix-integrity.test.mjs
// Integrity gate for the Asterisk call-matrix harness. Mirrors the FreeSWITCH
// gate (test/freeswitch-matrix/matrix-integrity.test.mjs) with one rule
// inverted and one added — see below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The step-declaration rules PARSE the spec files instead of scanning their
// text — see "Parse, do not scan" below for why the scanner was deleted rather
// than repaired. `typescript` is a DECLARED devDependency (^5.5.0, resolving
// 5.9.3) that resolves from this directory, and `npm ci` installs
// devDependencies in both CI jobs. `acorn` is deliberately NOT used: it is only
// transitive, so a lockfile change could remove it.
import ts from 'typescript';
import { launchOnlyKeysUnderContextOptions } from '../matrix-shared/playwright-config-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── The step manifest: ONE ENTRY PER STEP, every step named ────────────
// Ten steps, but only NINE tests in six files: `controls.spec.ts` covers steps
// 6 and 7 in ONE test (its header explains why they are not split), so 6 and 7
// name the same entry and the set comparison below collapses the duplicate.
// Do NOT "fix" that by splitting the controls test or by dropping a step.
//
// `file` drives the on-disk rules. `title` is the runner's own title PATH —
// the describe chain joined by ` > `, exactly as `--list --reporter=json`
// reports it, NOT a guess about source text. Renaming a describe or a test is
// therefore a deliberate manifest change: update this table with it.
const MATRIX_MANIFEST = {
  1:  { file: 'register.spec.ts',     title: 'asterisk matrix · registration > register: digest challenge then registered' },
  2:  { file: 'register.spec.ts',     title: 'asterisk matrix · registration > refresh: re-REGISTER before expiry' },
  3:  { file: 'register.spec.ts',     title: 'asterisk matrix · registration > wrong-password: typed AUTHENTICATION_FAILED' },
  4:  { file: 'audio.spec.ts',        title: 'matrix · outgoing call two-way audio > outgoing-audio: tone reaches Asterisk (WAV RMS) and echo returns (page energy)' },
  5:  { file: 'call-inbound.spec.ts', title: 'asterisk matrix · inbound > step 5: PBX-originated call is answered' },
  6:  { file: 'controls.spec.ts',     title: 'asterisk matrix · hold/resume + mute/unmute control plane > steps 6-7: hold, resume, mute, unmute on an established outgoing call' },
  7:  { file: 'controls.spec.ts',     title: 'asterisk matrix · hold/resume + mute/unmute control plane > steps 6-7: hold, resume, mute, unmute on an established outgoing call' },
  8:  { file: 'dtmf.spec.ts',         title: 'asterisk matrix · DTMF > step 8: RFC 4733 digits reach the PBX' },
  9:  { file: 'call-inbound.spec.ts', title: 'asterisk matrix · inbound > step 9: remote BYE ends the call cleanly' },
  10: { file: 'recovery.spec.ts',     title: 'asterisk matrix · recovery > step 10: a severed WSS re-registers and the call survives' },
};

test('every MATRIX_MANIFEST spec file exists on disk', () => {
  assert.strictEqual(Object.keys(MATRIX_MANIFEST).length, 10, 'manifest has exactly ten steps');
  for (const [step, entry] of Object.entries(MATRIX_MANIFEST)) {
    assert.ok(existsSync(join(__dirname, entry.file)), `step ${step}: missing ${entry.file}`);
  }
});

test('manifest maps to exactly six unique spec files', () => {
  const unique = [...new Set(Object.values(MATRIX_MANIFEST).map((e) => e.file))];
  assert.strictEqual(unique.length, 6, `expected 6 unique specs, got ${unique.length}: ${unique.join(', ')}`);
});

// ── Every step is backed by a test THE RUNNER ACTUALLY COLLECTS ────────
// The two rules above tie a step to a FILE, not to a test. Measured by the
// whole-branch review: emptying out `dtmf.spec.ts` while keeping the file left
// this gate GREEN (`ok 1` … `ok 9`, `# pass 9 # fail 0`, exit 0), and neither
// workflow counts tests — so the nightly would report green on 17 of 18 and the
// PR slice on 7 of 8 while one step silently stopped running. Deleting the file
// outright IS caught by Assertion 1 above; a step that is deleted or renamed
// WITHIN a file was not. Criterion 7's "a missing step … fails CI" was false for
// exactly this case.
//
// The rule below is NOT a text match, and that is the point. Three rounds of
// "count the `test(` declarations in the source" were each defeated: a `test(`
// at column 0 inside a template literal over-counts, so a correct tree goes RED
// while the message blames a deleted step; and a nested template inside an
// interpolation is not blanked at all, so a deleted test plus a phantom `test(`
// planted in a template read as GREEN with zero real tests left in the file. A
// rule that is wrong in BOTH directions is not a rule to refine a fourth time.
//
// `--list --reporter=json` is Playwright's own answer to "what would you run".
// It never reads source text, so strings, comments, templates and backticks
// cannot reach it. Measured at this revision it needs neither docker nor a
// browser nor the webServer — no `globalSetup`, no container — and the whole
// call costs ~1 s of the gate's run time.
//
// The ONE rule that looks at the spec files is the per-step assertion FLOOR
// further down, because `--list` proves a step still exists and is still named,
// not that its body still asserts anything. It no longer scans their TEXT —
// it parses them. See "Parse, do not scan" below: the hand-rolled scanner this
// file used to carry (`stripCommentsAndTemplates`) is DELETED, together with the
// two rules that read it, and must not be reintroduced.

// The runner's OWN collection, in the shape the rule below compares against
// MATRIX_MANIFEST. Two things are pinned rather than inherited, both of them
// deliberate:
//
//   * `--project=chromium` — the manifest describes the tests, and chromium is
//     the project the PR slice runs. Without it the collection doubles (18 =
//     9 chromium + 9 firefox) and the set comparison would need a project
//     dimension to tell the same test apart from itself.
//   * `MATRIX_MODE=nightly` — `pr` excludes `audio.spec.ts` by `testMatch`, so
//     an inherited `pr` would report 8 tests and turn step 4 into a false RED.
//     The manifest is the complete one; say so here, not in the caller's env.
//
// It spawns the installed CLI by absolute path with `process.execPath`, so no
// npm/npx wrapper is involved and no shell quoting is needed. `npm ci` precedes
// this gate in both CI jobs.
function collectMatrixTests() {
  const root = join(__dirname, '..', '..');
  const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        cli,
        'test',
        `--config=${join(__dirname, 'playwright.config.ts')}`,
        '--project=chromium',
        '--list',
        '--reporter=json',
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, MATRIX_MODE: 'nightly' } },
    );
  } catch (err) {
    // FAIL rather than fall back. The runner is the authority for this rule; a
    // text match is known-bad in both directions and must not be resurrected.
    assert.fail(
      `could not list the matrix tests (${err.message}). This rule needs the ` +
        `installed Playwright CLI; it deliberately does not fall back to reading source text.`,
    );
  }
  const report = JSON.parse(stdout);
  assert.deepStrictEqual(
    report.errors,
    [],
    `playwright reported errors while loading the matrix specs: ${JSON.stringify(report.errors)}`,
  );
  const collected = [];
  const walk = (suite, prefix) => {
    // The outermost suite of each file is titled with the file name; keeping it
    // in the path would put the file name in the title twice.
    const isFileRoot = typeof suite.file === 'string' && suite.title === suite.file;
    const path = isFileRoot ? prefix : [...prefix, suite.title];
    for (const child of suite.suites ?? []) walk(child, path);
    for (const spec of suite.specs ?? []) {
      collected.push({
        file: spec.file ?? suite.file,
        title: [...path, spec.title].join(' > '),
        // `--list` reports every test as `status: 'skipped'` (nothing runs), so
        // `status` says nothing here. `expectedStatus` is the real signal: a
        // `test.skip(`/`test.fixme(` test is `'skipped'` while a live one is
        // `'passed'`.
        expectedStatus: (spec.tests ?? [])[0]?.expectedStatus,
      });
    }
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return collected;
}

// ONE normalizer for a `{file, title}` pair, shared by the manifest rule here
// and the parse-vs-runner cross-check below: the two must compare the same way,
// and a second normalizer is a second thing to keep in step.
const testKey = (t) => `${t.file} :: ${t.title}`;

test('the runner collects exactly the tests MATRIX_MANIFEST names', () => {
  const collected = collectMatrixTests();
  const expected = [...new Set(Object.values(MATRIX_MANIFEST).map(testKey))].sort();
  const actual = [...new Set(collected.map(testKey))].sort();
  assert.deepStrictEqual(
    actual,
    expected,
    'the runner and MATRIX_MANIFEST disagree about which tests exist — a step was ' +
      'deleted, renamed or added, or a whole spec file stopped being collected',
  );
  // `test.skip(` and `test.fixme(` are still COLLECTED, so they need this second
  // half. A skipped step is not a passing step. Measured: both report
  // `expectedStatus: 'skipped'` while a live test reports `'passed'`, and
  // `status` is useless here — list mode marks every test `'skipped'` because
  // nothing runs.
  assert.deepStrictEqual(
    collected.filter((t) => t.expectedStatus !== 'passed').map((t) => `${testKey(t)} (${t.expectedStatus})`),
    [],
    'a matrix test is skipped or marked fixme — a skipped step is not a passing step',
  );

  // `test.only` is a focused-test form the `--list` cross-check below cannot see:
  // `--list` does not apply the focus filter, so list mode reports a focused run as
  // a complete one. THAT measurement is why a source-level rule exists at all, and
  // it survives the runner-level backstop — measured at the commit that armed
  // `forbidOnly: true`, both paths fire, and they say different things: the runner
  // prints the focused title, this gate names the written declaration and the
  // reason. The rule itself now lives in the AST walk below, and F20 widened it to
  // the describe-level form as well; the measurements behind both are recorded
  // with the classifier, not here.
  //
  // Corrected here: the text rule this replaced claimed "a desync blanks text,
  // so it can only HIDE a `test.only`, never invent one. It cannot turn a
  // correct tree red." The FIRST sentence is true and is the reason a
  // source-level rule is still needed. The SECOND was falsified by measurement —
  // the same one-line desync turned a correct tree red and blamed a step nobody
  // touched — and it is gone with the scanner.


});

// ── Parse, do not scan ─────────────────────────────────────────────────
// Rounds 2 and 3 both answered "does this test body still assert anything?" by
// scanning SOURCE TEXT with a hand-rolled scanner, and BOTH were unsound in both
// directions — round 3's job was to replace round 2's matcher with a better
// scanner, and the better scanner failed the same way. **R114: after two failed
// repairs of a mechanism, replace the mechanism.** The declarations below come
// from a real parse of the file (`ts.createSourceFile` + a walk over its
// CallExpressions), and the desync-prone scanner (`stripCommentsAndTemplates`)
// is DELETED rather than patched a third time. A dead scanner is exactly what a
// later "fix" re-adopts — same argument as F1's dead `wireInvites` field.
//
// What the scanner got wrong, measured, and why a tree cannot repeat it: it
// treated every backtick as OPENING a template literal, so a backtick inside a
// REGEX literal (`const TICK = /`/;`) desynced it. Its raw-text fallback fired
// only when the desynced scan found ZERO declarations, i.e. only when the
// desync preceded the FIRST `test(` — and the round-3 placement sweep measured
// `fallback=no` in ALL EIGHT placements. Both directions were live:
//
//   * the desync at the END of test 1's body plus both `expect(` deleted from
//     test 3 → gate at **12 pass / 0 fail, exit 0** while `--list` still
//     reported nine steps: step 3 validated nothing and every gate was green.
//   * the SAME one line at the top of test 2's body, on an otherwise CORRECT
//     tree → `not ok 4`, blaming a step nobody touched.
//
// A regex literal is a node in the tree, and `test(` inside a template literal
// is not a CallExpression at all, so neither can reach this walk. Measured on
// the tree this replaces: the compound attack gives `register [4, 2, 0]`
// (caught) and the correct tree with the same desync still gives `register
// [4, 2, 2]` (unchanged, no false RED).
//
// It also closes the residual round 3 disclosed as OPEN: `const harmless =
// 'expect(';` used to satisfy the floor because it was a SUBSTRING match. A
// string literal is not a CallExpression, so it no longer counts.
const SPEC_FILES = [...new Set(Object.values(MATRIX_MANIFEST).map((e) => e.file))];

// ── Classify the callee by STRUCTURE, not by an exact string ───────────
// Round 4 decided what a declaration was by comparing the callee's TEXT against
// exact strings at three sites: `/^test\.([A-Za-z]+)$/` (single-dot),
// `=== 'test.describe'` and `=== 'expect'`. That ONE root cause produced both
// defects this round closes, in opposite directions:
//
//   * F20 (critical) — `test.describe.only(` matched NEITHER arm of the
//     declaration test: it is not `test`, and the regex allowed one dot where
//     the callee has two. So it was neither a step nor rejected, and it
//     contributed no title prefix either. MEASURED on the round-4 gate: with
//     `.only` on the dtmf describe plus one title rewritten as a template that
//     evaluates to the SAME string, the gate reported `# pass 12 # fail 0`,
//     exit 0 (14/0 through the npm script), while the PR page slice went from
//     `Running 8 tests / 8 passed` to `Running 1 test / 1 passed` — 7 of the
//     slice's 8 steps stopped running with every gate green. The only rule that
//     noticed anything was the cross-check's STRICT branch, and any dynamic
//     title anywhere in the six files disables it: its fallback compares
//     per-file counts, and focus changes no count.
//   * F21 (medium, a round-4 REGRESSION) — EVERY `test.<word>` that was not
//     `describe` was pushed as a step declaration. MEASURED on the round-4
//     gate, each applied alone to an otherwise correct tree: `test.step(`,
//     `test.use(`, `test.slow(` and `test.setTimeout(` each turned it RED
//     (blaming, for `test.slow`/`test.setTimeout`, a `<non-literal title>`
//     invented from their first argument), and a body whose only assertion was
//     `expect.soft(` failed the floor. Round 3 was GREEN on all of these. The
//     standard is the comment further down: a gate that fails on correct code is
//     a gate someone deletes.
//
// ONE classifier over the callee's dot-segments closes both. It is read off the
// TREE, so whitespace and optional chaining cannot smuggle a form past it:
//
//   | callee                            | classification      | action |
//   | `test`                            | step                | declared; body needs >= 1 assertion |
//   | `test.only/.skip/.fixme/.fail`    | annotated step      | REJECT by name |
//   | `test.<other>`                    | Playwright API call | IGNORE — not a step, not rejected |
//   | `test.describe`                   | container           | contributes its title prefix |
//   | `test.describe` + a focus/skip word anywhere after it | annotated container | REJECT by name, stating which |
//   | `test.describe.configure`         | container modifier  | IGNORE; contributes NO prefix (it takes an object, not a title) |
//   | `test.describe.<other>`           | container           | contributes its title prefix |
//
// The annotation test SEARCHES every segment after `describe`; it does not match
// `segs[1]`. Round 5 matched `segs[1]` alone and whitelisted everything else as a
// container, to avoid rebuilding F21's false RED on `test.describe.parallel` and
// `.serial` — legitimate (deprecated) forms that must stay GREEN. That trade was
// never two-way, and the whitelist was the hole: `test.describe.serial.only(` has
// THREE segments with the annotation at `segs[2]`, so it landed in the `<other>`
// bucket, was never rejected, and was silent-green — the focused suite took its
// steps out of the run while every rule in this gate passed, exit 0, and `--list`
// listed every test. That was R5-1. Searching the whole chain keeps
// `parallel`/`serial` GREEN (they carry no annotation) while catching every
// three-segment focus form; exactly `only` / `skip` / `fixme` are rejected, a
// finite and well-defined set.
//
// **Why IGNORING `test.<other>` is safe, and must not be "tightened" later:**
// Playwright collects a test ONLY from `test(`, `test.only(`, `test.skip(`,
// `test.fixme(` or `test.fail(`. The four annotations are rejected by name and
// plain `test(` is a step, so every COLLECTABLE form is classified. If a
// `test.<other>` call ever hid a collectable step, the runner would collect it
// and this parse would not — the declared and collected sets would disagree,
// which is exactly what the cross-check below exists to make RED.
//
// KNOWN RESIDUAL (measured, disclosed, not fixed): this classifier reads the
// WRITTEN call. A callee reached through an alias (`const d = test.describe;
// d.only(…)`) or a computed member (`test['describe'].only(…)`) is not rooted at
// the identifier `test`, so it is ignored here. The way that fails is NARROW and
// measured: a step declaration hidden that way shows up as declared ⊂ collected
// (the cross-check's strict branch catches it, and so does the count fallback,
// since a hidden declaration changes a file's count); but `test.describe.only`
// spelled that way LOSES ONLY A TITLE PREFIX, and the count fallback cannot see
// a lost prefix. So a non-canonical describe focus is caught today only when
// every title in the six files is a string literal. Closing it needs a
// runner-level `forbidOnly`, which playwright.config.ts now sets, and the
// `forbidOnly` rule below keeps it set. Measured (round-5 re-review, temporary
// edit reverted): it catches the aliased form above. The computed-member
// spelling is the same runtime shape — anything that reaches the real
// `test.describe` object raises a focused suite the runner sees — so the same
// backstop covers it; that spelling was NOT separately measured. The residual
// therefore degrades from "silent-green" to "caught by the runner, though not
// named by this classifier", which is recorded in the round-5 report.
function rootedSegments(node, root) {
  const segs = [];
  let e = node.expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      segs.unshift(e.name.text);
      e = e.expression;
      continue;
    }
    // `test!.only(…)` and `(test.describe)(…)` reach the same call.
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
      continue;
    }
    break;
  }
  if (!ts.isIdentifier(e) || e.text !== root) return null;
  return segs;
}

// Step-level annotations. Playwright accepts these four on a step. The SUITE set
// below is the same minus `fail`: there is no `test.describe.fail`, so
// `test.describe.fail` is left to the container row rather than rejected by a
// rule that would then be guessing.
const STEP_ANNOTATIONS = new Set(['only', 'skip', 'fixme', 'fail']);
const SUITE_ANNOTATIONS = new Set(['only', 'skip', 'fixme']);

// Why each annotated form is rejected, in the failure message itself. Named
// explicitly so a later reader does not "simplify" one of them away as
// redundant with the `--list` rule above — each is a form `--list` cannot see:
//
//   * `test.only` — `--list` does not apply the focus filter (measured: all nine
//     still report `expectedStatus: 'passed'`), and `forbidOnly` aborts the run
//     without saying WHICH declaration to delete. This rule names it.
//   * `test.skip` / `test.fixme` — collected, and caught by the `--list` rule's
//     `expectedStatus !== 'passed'` half as well. Named here so the failure
//     points at the declaration rather than at the runner's report.
//   * `test.fail` — **NOT redundant with the `--list` rule**: measured, `--list`
//     reports `expectedStatus: 'passed'` for it (unlike skip/fixme, which report
//     `'skipped'`), so Rule 3 above is blind to it; and a `test.fail` test whose
//     assertion IS broken reports `1 passed`, exit 0 (measured with real
//     Chromium by the round-3 re-review). A step that cannot fail is not a step.
//
// The SUITE rows are F20's fix and they are the ones that matter most: a focused
// describe takes EVERY step inside it out of the run while `--list` still lists
// them all as `passed`, so nothing downstream of this file can notice.
const ANNOTATION_REASON = {
  'test.only': 'a FOCUSED step — the runner then executes one step and reports it green',
  'test.skip': 'a SKIPPED step — a skipped step is not a passing step',
  'test.fixme': 'a FIXME step — a fixme step is not a passing step',
  'test.fail': 'a step declared to FAIL — `--list` reports it as `passed`, so it validates nothing',
};
const SUITE_ANNOTATION_REASON = {
  'test.describe.only':
    'a FOCUSED suite — every other step stops running and the focused one is reported green, ' +
    'while `--list` still lists all nine as `passed`',
  'test.describe.skip': 'a SKIPPED suite — every step inside it stops running',
  'test.describe.fixme': 'a FIXME suite — every step inside it stops running',
};

// The classification of a call expression's callee, or `null` when the callee is
// not rooted at `test` at all (this gate has no opinion about those).
function classifyCallee(node) {
  const segs = rootedSegments(node, 'test');
  if (!segs) return null;
  if (segs.length === 0) return { kind: 'step', callee: 'test' };
  if (segs[0] !== 'describe') {
    const callee = `test.${segs[0]}`;
    if (segs.length === 1 && STEP_ANNOTATIONS.has(segs[0])) {
      return { kind: 'stepAnnotation', callee, reason: ANNOTATION_REASON[callee] };
    }
    return { kind: 'api', callee };
  }
  if (segs.length === 1) return { kind: 'container', callee: 'test.describe' };
  const callee = `test.describe.${segs[1]}`;
  if (segs[1] === 'configure') return { kind: 'api', callee };
  // A focus/skip word ANYWHERE after `describe`, not only at `segs[1]`. Round 5
  // read `segs[1]` alone, so `test.describe.serial.only(` — three segments, with
  // the annotation at `segs[2]` — fell into the `<other>` container bucket, was
  // never rejected, and was silent-green: the focused suite took its steps out of
  // the run while every rule in this gate passed and `--list` listed every test.
  // That was R5-1. `parallel` and `serial` standing alone carry no
  // annotation, so they remain legitimate containers — which is what round 5's
  // whitelist was protecting, and it is preserved here without the hole.
  const annotation = segs.slice(1).find((s) => SUITE_ANNOTATIONS.has(s));
  if (annotation !== undefined) {
    return {
      kind: 'suiteAnnotation',
      // The WRITTEN path, not `segs[1]`: `test.describe.serial` is not a call
      // anyone can find in the file, and the whole point of this rule is that the
      // failure names the declaration to delete. A two-segment focus is
      // unaffected (`test.describe.only` reads the same either way).
      callee: `test.describe.${segs.slice(1).join('.')}`,
      reason: SUITE_ANNOTATION_REASON[`test.describe.${annotation}`],
    };
  }
  return { kind: 'container', callee };
}

// An assertion, for the per-step FLOOR below. `expect`, `expect.soft` and
// `expect.poll` are all real assertions; matching the callee EXACTLY as
// `'expect'` was round 4's third exact-string comparison and it turned an
// `expect.soft(`-only body RED on a correct tree (F21). Widening this matcher
// cannot create vacuity — it is a floor, so all it can do is stop reddening a
// body that does assert.
//
// KNOWN RESIDUAL (pre-existing, unchanged by this round, disclosed): the floor
// recognises `expect`-rooted callees only. A body whose only assertion is
// `test.expect(x).toBe(y)` (Playwright's own re-export) is still RED on a
// correct tree. It was RED before this round too, and the round-5 report carries
// it as a residual rather than widening the matcher further on the last round.
function isAssertion(node) {
  const segs = rootedSegments(node, 'expect');
  if (!segs) return false;
  return segs.length === 0 || (segs.length === 1 && (segs[0] === 'soft' || segs[0] === 'poll'));
}

// The prefix `stepTitle` stamps on a title it could not read as a string
// literal. Shared with the cross-check below, which switches to its per-file
// count fallback when it finds one.
const NON_LITERAL_TITLE = '<non-literal title:';

function stepTitle(arg, sf) {
  if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return arg.text;
  // Not a literal — a template with `${}` in it, or a computed name. Say so in
  // the title rather than dropping the step: the cross-check below falls back to
  // per-file counts when it sees this marker, instead of either inventing a
  // title that cannot match the runner's or failing a correct tree.
  return `${NON_LITERAL_TITLE} ${arg ? arg.getText(sf) : 'missing'}>`;
}

// The describe chain enclosing `node`, outermost first. `--list --reporter=json`
// reports a test's title as that chain joined by ` > `, which is what the
// cross-check below compares against. `setParentNodes: true` is why `.parent`
// is available. Only CONTAINERS contribute a prefix, and the classifier decides
// which callees those are — `test.describe` and `test.describe.<other>`
// (`parallel`, `serial`, …). `test.describe.configure` takes an object rather
// than a title and contributes nothing, and the annotated describe forms are
// rejected by name above instead of being silently trusted for a prefix.
function describeChain(node, sf) {
  const chain = [];
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && classifyCallee(p)?.kind === 'container') {
      chain.unshift(stepTitle(p.arguments[0], sf));
    }
  }
  return chain;
}

// ONE walk per file yields the ordered STEP declarations — plain `test(` and the
// annotated forms the rule below rejects — plus the annotated SUITES, which are
// the forms that can take steps out of the run wholesale. `test.describe` is a
// CONTAINER, not a step, and is excluded; `test.<other>` (`test.step`,
// `test.use`, `test.slow`, `test.setTimeout`, `test.beforeEach`, …) is a
// Playwright API CALL and is excluded too — see the classifier above for why
// that is safe and why it must not be tightened.
function parseSpecFile(file) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(__dirname, file), 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const steps = [];
  const suiteAnnotations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const c = classifyCallee(node);
      if (c && (c.kind === 'step' || c.kind === 'stepAnnotation')) {
        // The body is the LAST argument, and only a function argument is a
        // body: assertion CallExpressions inside it are counted by walking it,
        // which includes assertions in nested helpers the body calls.
        const body = node.arguments[node.arguments.length - 1];
        let expects = 0;
        if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
          const count = (n) => {
            if (ts.isCallExpression(n) && isAssertion(n)) expects += 1;
            ts.forEachChild(n, count);
          };
          count(body.body);
        }
        steps.push({
          file,
          callee: c.callee,
          reason: c.reason,
          expects,
          title: [...describeChain(node, sf), stepTitle(node.arguments[0], sf)].join(' > '),
        });
      } else if (c && c.kind === 'suiteAnnotation') {
        suiteAnnotations.push({
          file,
          callee: c.callee,
          reason: c.reason,
          title: [...describeChain(node, sf), stepTitle(node.arguments[0], sf)].join(' > '),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { steps, suiteAnnotations };
}

function declaredSteps(file) {
  return parseSpecFile(file).steps;
}

// ── Every declaration is plain, and no suite is focused or skipped ─────
// The `test.only` measurement behind this rule is why a source-level rule exists
// at all: with `test.only` in dtmf.spec.ts, `--list` still reports every spec with
// `expectedStatus: 'passed'` (list mode does not apply the focus filter), so the
// cross-check below reads a focused run as a complete one. That half is still
// true with the runner-level backstop armed, and the two are not substitutes:
// `forbidOnly` fails the run and prints the offending title, while this rule
// fails it in the gate's own words, with the reason. Without either, a focused
// test would shrink the run to one step with every gate green — verbatim the harm
// this whole manifest rule exists to prevent.
//
// CORRECTED, and the correction is its own finding: this paragraph used to end
// "`forbidOnly` under CI=1 does not change that either — measured, exit 0, full
// JSON ... the config does not mention it, so there is no runner-level backstop
// either." Re-measured at the commit that armed `forbidOnly: true`
// (matrices run through the gate's own list invocation, `--list --reporter=json`,
// MATRIX_MODE=nightly): a focused step, a focused `describe`, a
// `describe.serial.only` and the ALIASED suite form all exit 1 in list mode and
// 1 in a real run, with the runner naming the declaration. The old sentence's
// second half was true when written (the config did not set the option) and its
// first half was not — CI=1 turns the option on by Playwright's own default, so
// that measurement cannot have been taken under the condition it claims. Both
// halves are gone rather than re-worded. What the old text was protecting — the
// claim that a source rule is needed — survives on the `--list` blindness above,
// which is the half that was measured correctly.
//
// The rule is narrowed the same way: it rejects the annotated declarations
// (step-level and describe-level) and does NOT re-check what `--list` already
// covers as a set. Both halves matter, and F20 is why: a focused DESCRIBE takes
// five of the eight steps out of the run while `--list` lists all eight and every
// count in this file stays green, so the describe arm is the only rule here that
// can see it by name.
//
// Corrected here: the text rule this replaced claimed "a desync blanks text, so
// it can only HIDE a `test.only`, never invent one. It cannot turn a correct
// tree red." The FIRST sentence is true and is the reason a source-level rule is
// still needed. The SECOND was falsified by measurement — the same one-line
// desync turned a correct tree red and blamed a step nobody touched — and it is
// gone with the scanner.
test('every matrix step is declared with a plain test() call, and no suite is focused or skipped', () => {
  for (const file of SPEC_FILES) {
    const { steps, suiteAnnotations } = parseSpecFile(file);
    for (const suite of suiteAnnotations) {
      assert.fail(
        `${file}: ${suite.title} is declared with \`${suite.callee}(\` — ${suite.reason}`,
      );
    }
    for (const step of steps) {
      assert.strictEqual(
        step.callee,
        'test',
        `${file}: "${step.title}" is declared with \`${step.callee}(\` — ` +
          `${step.reason ?? 'not a plain test declaration'}`,
      );
    }
  }
});

// ── The runner-level backstop must still be armed ──────────────────────
// `forbidOnly` is the ONLY defence against the aliased focus form
// (`const d = test.describe; d.only(…)`): the classifier above reads callees
// from the tree, and an alias is a different callee that no static rule can
// follow to its target. A backstop a future edit can delete with nothing going
// red is the same defect class as the six this file exists to catch, so its
// presence is asserted here — and asserted STRUCTURALLY, by parsing the config
// rather than matching its text, so commenting the line out cannot satisfy this
// rule. That matters: a text match is exactly the kind of check that silently
// stops checking, which is the subject of this whole file.
test('playwright.config.ts still arms forbidOnly — the backstop for aliased focus', () => {
  const path = join(__dirname, 'playwright.config.ts');
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const values = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'forbidOnly'
    ) {
      values.push(node.initializer.kind === ts.SyntaxKind.TrueKeyword);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(
    values.length > 0,
    'forbidOnly is not set in playwright.config.ts. It is the only defence against ' +
      '`const d = test.describe; d.only(…)`, which the AST classifier cannot see: without it a ' +
      'focused suite is silent-green while every other rule in this file passes.',
  );
  assert.ok(
    values.every(Boolean),
    'forbidOnly is present but not `true` — a falsey value disarms the backstop entirely.',
  );
});

// ── The floor: every step body still asserts something ─────────────────
// `--list` proves a step exists and is still named. It cannot prove the body
// still asserts anything. Measured by the round-2 re-review: deleting BOTH
// `expect(` lines from `register.spec.ts`'s `refresh` test (step 2) — a file
// with three tests — left this gate at 11 pass / 0 fail, exit 0, and the page
// slice at 8 passed. `runStep` resolves `ok: false` rather than throwing
// (test/matrix-shared/helpers.ts:133), so nothing else fails either: step 2
// would validate nothing and every gate would report full green.
//
// So the floor is PER STEP, not per file, and it is counted off the parse:
// `expects >= tests` is NOT the rule — that passes when one of three tests is
// gutted, which is the defect itself. Measured off the tree at this revision:
// register [3,2,2], audio [13], call-inbound [8,9], controls [26], dtmf [2],
// recovery [12].
//
// KNOWN RESIDUAL, deliberate, and it is INCOMPLETENESS rather than vacuity.
// Closed by the parse: `const harmless = 'expect(';` no longer satisfies the
// floor (a string literal is not a CallExpression — measured). What remains open
// is a body whose assertion is PRESENT but cannot EXECUTE: `if (false) { expect
// (…) }`, or an `expect` inside a helper the body never calls. No static rule can
// prove an assertion executes — only running the step can, which is what the
// page slice is for. Do NOT "fix" this with an exact `expect(` count: that turns
// every legitimate test edit into a red gate, which is the failure mode this
// whole file exists to prevent.
//
// The matcher is `isAssertion` above — `expect`, `expect.soft` and `expect.poll`
// all count. Round 4 matched the callee exactly as `'expect'`, so a body whose
// only assertion was `expect.soft(` was RED on a correct tree (F21). This is a
// FLOOR, so widening the matcher cannot create vacuity; it can only stop
// reddening a body that does assert.
test('every declared test body still contains an assertion', () => {
  for (const file of SPEC_FILES) {
    for (const step of declaredSteps(file)) {
      assert.ok(
        step.expects >= 1,
        `${file}: "${step.title}" contains no assertion call at all ` +
          `(\`expect\`, \`expect.soft\`, \`expect.poll\`) — that step's body was ` +
          `emptied and it now validates nothing`,
      );
    }
  }
});

// ── The cross-check: the parse and the runner must agree, BOTH directions ──
// This is the structural half of the round-4 fix, and it is what closes C1's
// SILENT mode. Round 3's scanner left a PARTIAL declaration list — the desync
// swallowed everything after its trigger — and no rule compared that list
// against the runner's, so a gutted step rode along inside a shortened list. A
// partial list cannot equal the runner's nine, so the defect now has to be
// visible. A one-directional check would not do: "every declared step is
// collected" is silent about a step the parse never saw, which is exactly the
// failure being closed.
//
// The set is compared at the `{file, title}` level, reusing the same `testKey`
// normalizer as the manifest rule above — measured, the parse's title path and
// `--list --reporter=json`'s agree EXACTLY on the committed tree, so no second
// normalizer is needed. If they ever stop reconciling, the fix is to reconcile
// them, not to compare a weaker count.
//
// ONE case cannot reconcile at the title level and is handled explicitly rather
// than assumed away: a step whose title is a TEMPLATE with `${}` in it. The
// runner evaluates it to a real string that no static walk can predict, so
// `stepTitle` marks it `<non-literal title: ...>` and no comparison against a
// collected title can ever succeed. The plan prescribes the fallback and this is
// it — per-file declared vs collected counts, BOTH directions, which still
// catches a file's declarations going missing or a step appearing from nowhere,
// just not which step. Measured: every one of the nine committed steps has a
// literal title, so the strict branch is the one that runs today; the fallback
// exists so the first dynamic title is a narrower check rather than a false RED.
//
// **What the fallback does NOT cover, stated here because F20 was exactly this
// and the earlier version of this comment was silent on it: it compares COUNTS,
// so it is blind to FOCUS.** `test.describe.only` on one of the six describes
// takes every step outside it out of the RUN while changing no count at all —
// the parse still declares them, the runner still LISTS them (list mode does not
// apply the focus filter), and the fallback therefore agrees. Before round 5 the
// strict branch's lost title prefix was the only thing that fired, and one
// dynamic title anywhere disabled it: measured, the gate sat at 14 pass / 0 fail
// and exit 0 while seven of the PR slice's eight steps stopped running. Focus is
// NOT this rule's job — it belongs to the annotated-declaration rule above,
// which rejects the describe forms by name. What remains here is the count
// comparison, and it stays: a name-level check that silently did nothing once a
// title was dynamic would be the vacuity this file exists to refuse.
//
// **Do not re-derive round 3's argument against a count floor and delete this
// check.** Round 3 refused to assert a minimum number of declarations because a
// DESYNCED scanner left ZERO declarations in some placements, so any count was
// a fabricated RED. That premise held only for the pre-declaration placement and
// only because the scanner was unreliable: with a real parse the declared set is
// assertable, and this equality is the assertion.
test("the parsed steps and the runner's collected tests agree, in both directions", () => {
  const declared = SPEC_FILES.flatMap((file) => declaredSteps(file));
  const collected = collectMatrixTests();
  if (!declared.some((s) => s.title.includes(NON_LITERAL_TITLE))) {
    assert.deepStrictEqual(
      [...new Set(declared.map(testKey))].sort(),
      [...new Set(collected.map(testKey))].sort(),
      'the parse and the runner disagree about which steps exist — a step the ' +
        'runner collects is missing from the parse (a declaration form the walk ' +
        'does not read), or the parse declares a step the runner never collects',
    );
    return;
  }
  // A dynamic title somewhere: compare per-file counts instead of titles. Both
  // directions, and the runner's own set is checked for the marker first — a
  // collected title carrying it would mean `testKey` was fed a parse-only
  // string, i.e. this check comparing the parse against itself.
  for (const key of collected.map(testKey)) {
    assert.ok(!key.includes(NON_LITERAL_TITLE), `a collected test title carries the parse-only marker: ${key}`);
  }
  const countBy = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.file, (m.get(r.file) ?? 0) + 1);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  };
  assert.deepStrictEqual(
    countBy(declared),
    countBy(collected),
    'a step title is dynamic, so titles cannot be compared — and the per-file ' +
      'declared/collected counts disagree: a file declares a different number of ' +
      'steps than the runner collects, so the parse and the runner are looking at ' +
      'different sets',
  );
});

// ── The unit gates cannot silently collect nothing ─────────────────────
// The unit scripts are Vitest, and `vitest.config.ts` used to set
// `passWithNoTests: true`: a glob naming a nonexistent file still exited 0, and
// all-unmatched exited 0 with "No test files found". A whole tree's unit tests
// could vanish and the gate stayed green — the same shape as the step rule
// above. The config now sets it false; these names are the second half, so a
// deleted unit spec is named rather than merely reducing a count.
//
// Measured today: matrix-shared 3 (mint-tls, rms, stun), asterisk-matrix 2
// (ami, conf), freeswitch-matrix 1 (conf) — the FreeSWITCH pair is asserted here
// because `test:matrix:unit` is the gate that reads it, and this file is the
// only integrity walk that spans all three trees.
const UNIT_SPECS = {
  'matrix-shared': ['mint-tls.unit.test.ts', 'rms.unit.test.ts', 'stun.unit.test.ts'],
  'asterisk-matrix': ['ami.unit.test.ts', 'conf.unit.test.ts'],
  'freeswitch-matrix': ['conf.unit.test.ts'],
};

test('every unit spec file the unit gates name exists', () => {
  for (const [tree, files] of Object.entries(UNIT_SPECS)) {
    for (const file of files) {
      const full = join(__dirname, '..', tree, file);
      assert.ok(
        existsSync(full),
        `test/${tree}/${file} is missing — a unit gate globbing it would collect nothing`,
      );
    }
  }
});

function walkDir(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Gitignored build output is not part of the tree this gate reads. Without
    // this skip the key-material scan and the file-count floor see a different
    // input set depending on whether a page run happened first in the same
    // checkout. `no-src-imports.test.mjs` skips `dist`, `node_modules` and
    // `artifacts`; `test-results` is added here because it is Playwright's
    // `outputDir`. Measured verdict-neutral today: `dist/matrix.js` is the only
    // file the skip removes (27 scanned without it, 26 with, against a floor of
    // `>= 15`), and the key scan sees the same set either way.
    if (
      entry.name === 'dist' ||
      entry.name === 'node_modules' ||
      entry.name === 'artifacts' ||
      entry.name === 'test-results'
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(full));
    else out.push(full);
  }
  return out;
}

// NOTE: the local `TOKEN_RE` that used to be declared here is gone — the port
// rule below no longer uses it. (`conf.ts` exports its own `TOKEN_RE`, which IS
// live and unrelated; do not confuse the two, and do not remove that one.)
// The committed file at Task 13 fix round 1 still carried the dead local copy;
// delete it on the next touch of that file. No lint runs over these `.mjs`
// gates — there is no `lint` script and no eslint config in this repo — so
// nothing else will ever catch a dead const in them.

// ── The token rule, INVERTED from the FreeSWITCH gate ──────────────────
// FreeSWITCH's gate asserts its committed conf has NO tokens, because
// materialize.mjs renders an overlay. Here the committed ast-conf tree IS the
// template, so every PORT must be a token: a hardcoded port would survive
// review and then collide with the FreeSWITCH matrix on a shared machine.
//
// Scoped by name, and the scope is load-bearing. Only three of the seven
// committed conf files carry a port at all — pjsip.conf (WSS transport),
// http.conf (HTTP + WSS), manager.conf (AMI). The other four carry none:
// extensions.conf is a dialplan, logger.conf and modules.conf configure no
// listener, and rtp.conf pins `rtpstart=20102`/`rtpend=20202` as deliberate
// LITERALS, because that range's whole purpose is to differ from FreeSWITCH's
// and it is fixed for every run (Global Constraints). A rule demanding a token
// in every file would therefore fail on the tree Task 2 already shipped and
// Task 3's boot gate already exercises — and "fixing" that by tokenising the
// RTP range would break the very collision it exists to prevent. If a later
// task gives extensions.conf a port, add it here rather than widening the walk.
const TOKEN_FILES = ['pjsip.conf', 'http.conf', 'manager.conf'];

// PORT-LEVEL, not file-level. **Corrected during Task 13, by measurement.**
// The original rule here was `assert.ok(TOKEN_RE.test(readFileSync(file, 'utf8')))`
// — "this file contains at least one token". Task 13 measured what that misses:
// replacing `tlsbindaddr`'s token with a literal port while `__HTTP_PORT__`
// survived in the same file left the gate GREEN. So a genuine hardcoded port
// could survive review and collide with the FreeSWITCH matrix on a shared
// machine — the exact failure this rule's comment above says it exists to
// prevent. The rule below checks every port-bearing assignment instead.
//
// `bindaddr` is deliberately NOT a directive HERE: its value may legitimately be a
// bare address with no port at all (`bindaddr=127.0.0.1`), so demanding a token in
// it would fail on the correct committed tree. It is NOT left unchecked, though —
// the loopback rule below requires any port it does carry to be a token. The
// earlier claim on this line ("carries a loopback ADDRESS with no port") was FALSE
// and is corrected at that rule.
//
// **Corrected during Task 13 fix round 1's re-review, by measurement.** Asterisk
// truncates a config line at the first unescaped `;` (main/config.c), so
// `bindport=8088 ; the HTTP port` is a VALID line carrying a real port. The value
// clause here was `(\S+)\s*$`, anchored at end-of-line, so no such line could
// match — measured: it left the gate GREEN (9 pass / 0 fail, exit 0), a hardcoded
// port passing the check whose entire job is to stop hardcoded ports. The hole was
// wider than a literal: even `bindport=__HTTP_PORT__ ; c`, a correctly tokened
// line, was invisible, so the rule's coverage silently dropped for EVERY commented
// directive. Both rules now strip the comment first, via one helper.
//
// (The `;`-truncation itself is read from Asterisk master, not from the pinned
// digest's revision — but the rule is written to require tokens in a commented
// directive either way, so it does not depend on which revision is right.)
function withoutInlineComment(line) {
  const i = line.indexOf(';');
  return i === -1 ? line : line.slice(0, i);
}

const PORT_DIRECTIVE = /^\s*(?:bindport|tlsbindaddr|bind|port)\s*=\s*(\S+)\s*$/i;
// The value may carry a host prefix: `bind=127.0.0.1:__WSS_PORT__`.
const HOST_AND_TOKEN = /^(?:[^:\s]+:)?__[A-Z][A-Z_]*[A-Z]__$/;
// What a bind directive's value may be: the loopback address, OPTIONALLY followed
// by a tokened port. A port LITERAL here is not acceptable, and that is not
// hypothetical — in http.conf an inline port on `bindaddr` takes precedence over
// `bindport` (http.c sets bindport only `if (!ast_sockaddr_port(&addrs[i]))`), so
// `bindaddr=127.0.0.1:18090` is a hardcoded port that silently wins. Measured
// during the re-review: it passed BOTH gates, because it starts with `127.0.0.1`
// and `bindaddr` is not in the port rule. (Same hedge as above: the precedence
// comes from master, not the pinned revision. The rule is tightened regardless —
// a port literal in a bind value violates the Global Constraint either way.)
const LOOPBACK_OPTIONAL_TOKENDED_PORT = /^127\.0\.0\.1(?::__[A-Z][A-Z_]*[A-Z]__)?$/;

test('every port-bearing ast-conf file uses tokens, not literals', () => {
  for (const name of TOKEN_FILES) {
    const file = join(__dirname, 'ast-conf', name);
    assert.ok(existsSync(file), `ast-conf/${name} is missing — the committed tree is incomplete`);
    let directives = 0;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*[;#]/.test(raw)) continue; // a commented-out directive binds nothing
      const m = PORT_DIRECTIVE.exec(withoutInlineComment(raw));
      if (!m) continue;
      directives += 1;
      assert.ok(HOST_AND_TOKEN.test(m[1]), `ast-conf/${name}: port literal "${m[1]}" — every port must be a token`);
    }
    // A file with no port directive at all would otherwise pass vacuously.
    assert.ok(directives >= 1, `ast-conf/${name} declares no port directive — the rule cannot see it`);
    // KNOWN LIMIT, measured during Task 13 fix round 1 and left open deliberately:
    // this is a per-FILE floor, not per-directive. Deleting ONE of http.conf's two
    // port directives leaves the other in place, so the floor passes and the gate
    // stays GREEN (measured: 9 pass / 0 fail, exit 0). A file that loses only SOME
    // of its ports is a regression this rule cannot see; only losing all of them is.
    //
    // Not fixed, for three reasons. (1) It is incompleteness, not vacuity: every
    // directive the rule does see is asserted on, so unlike the loopback rule below
    // — which reported `ok` while executing zero assertions — this one cannot
    // report success while asserting nothing. (2) The mutation cannot ship
    // silently: deleting a listener directive removes a listener, and the boot gate
    // and the page suite fail loudly on a socket nobody is bound to. (3) Closing it
    // means freezing per-file directive counts or a per-directive expectation
    // table — a third parallel list naming the same three files, which turns every
    // legitimate config change into a red gate, to catch something already caught
    // at runtime.
    //
    // Carried to the final whole-branch review as a known-open condition.
  }
});

// NOTE FOR THE IMPLEMENTER: BOTH rules in this file are DESIGNED, not yet proved
// — they were written from reading the three conf files, not from running them.
// Prove all SIX of these by mutation and report the observed output. 1-4 were
// proved in fix round 1; 5 and 6 are new in round 2 — the two doors round 1's fix
// left open, both measured GREEN when they should have been RED. Re-run all six:
// do not assume 1-4 survived the round-2 edits, because both edits changed the
// code paths they exercise.
//
//   1. REPORT what the port rule actually matched — every `file:line:value` it
//      accepted. It must be exactly four directives: pjsip.conf `bind`,
//      http.conf `bindport`, http.conf `tlsbindaddr`, manager.conf `port`. A
//      rule that also matches something else is a defect to report, not to
//      quietly narrow.
//   2. Replace ONE token with a literal port while another token survives in the
//      same file → the port rule must go RED.
//   3. Delete a port directive entirely → the port rule must go RED on
//      `directives >= 1`.
//   4. Delete the `bindaddr=127.0.0.1` line from manager.conf → the loopback
//      rule must go RED on `seen.length >= 1`.
//   5. NEW — `http.conf`: `bindport=8088 ; the HTTP port` → the port rule must go
//      RED. Before `withoutInlineComment` this line was INVISIBLE to the rule (no
//      match at all) and the gate stayed GREEN (9 pass / 0 fail, measured). Also
//      prove the benign half: `bindport=__HTTP_PORT__ ; c` must still be SEEN and
//      still pass, because a commented TOKENED line was invisible too — the hole
//      was wider than a literal.
//   6. NEW — `http.conf`: `bindaddr=127.0.0.1:18090` → the loopback rule must go
//      RED. Before `LOOPBACK_OPTIONAL_TOKENDED_PORT` this cleared BOTH gates
//      (measured): it starts with `127.0.0.1`, and `bindaddr` is not in the port
//      rule. The bare `bindaddr=127.0.0.1` must stay GREEN, in both files.
//
// A rule that only ever passes is the failure mode this whole task exists to
// prevent. 2, 4, 5 and 6 are the four measured GREEN when they should have been
// RED — and 5 and 6 were found by the round-1 RE-REVIEW, after 2 and 4 had
// already been fixed, which is why the re-review re-ran the whole set instead of
// spot-checking the fix.
//
// PROVED, all six, during Task 13 fix round 2 — the observed output is in
// .superpowers/sdd/2026-09-14-v0.9-asterisk-matrix/task-13-fix-r2-report.md:
//   1. exactly 4 directives, as listed above, no extras, on the committed tree:
//      pjsip.conf:13 `127.0.0.1:__WSS_PORT__`, http.conf:9 `__HTTP_PORT__`,
//      http.conf:11 `127.0.0.1:__WSS_PORT__`, manager.conf:9 `__AMI_PORT__`;
//      gate exit 0.
//   2. RED — `not ok 3 - every port-bearing ast-conf file uses tokens, not literals`
//      (`port literal "127.0.0.1:18083"`), with `__HTTP_PORT__` still present in
//      the same file. This is the case the file-level rule missed. (It now fails
//      the loopback rule as well — 7 pass / 2 fail — since a literal port inside
//      a bind value is also a bind-value violation.)
//   3. RED — same subtest, on `declares no port directive` (the file's ONLY port
//      directive was deleted, so `directives >= 1` fires); also trips the
//      loopback floor, 7 pass / 2 fail.
//   4. RED — `not ok 4 - ast-conf binds nothing outside loopback`
//      (`manager.conf yields no bind directive`).
//   5. RED — `not ok 3`, `port literal "8088"`. This line was INVISIBLE before
//      `withoutInlineComment`: no match at all, gate GREEN. Benign half proved by
//      instrumenting the rule: `bindport=__HTTP_PORT__ ; c` is SEEN
//      (`MATCHED ast-conf/http.conf:9:__HTTP_PORT__`) and the gate stays exit 0.
//   6. RED — `not ok 4`, `binds "127.0.0.1:18090"`. This cleared BOTH gates
//      before. Benign half: bare `bindaddr=127.0.0.1` in http.conf and
//      `bindaddr = 127.0.0.1` in manager.conf stay GREEN, 9 pass / 0 fail.
//
// The per-FILE `directives >= 1` limit is stated in the port test above and is a
// known-open condition carried to the final whole-branch review.

// ── Loopback-only, WITH A FLOOR. **Corrected during Task 13, by measurement.** ──
// As first written this test was VACUOUS, and the review measured it: `matchAll`
// over zero matches runs zero assertions, so deleting every
// `bind`/`bindaddr`/`tlsbindaddr` line from the committed config left it GREEN
// (`ok 4`, exit 0). A gate that cannot fail reads as coverage without being any,
// which is the failure mode this whole task exists to prevent.
//
// The value check keeps its full walk over `ast-conf/` — a NEW file that binds a
// listener must still be caught — and the floor is added on top, per named file,
// so that one file going invisible is named in the failure rather than absorbed
// by the other two. The floor cannot be applied per file across the walk: only
// three of the seven conf files bind a listener at all.
const BIND_FILES = ['pjsip.conf', 'http.conf', 'manager.conf'];

test('ast-conf binds nothing outside loopback', () => {
  // (a) no file anywhere in ast-conf may bind outside loopback, and any port a bind
  // value carries must be a token — not merely start with `127.0.0.1`. That prefix
  // test was the re-review's second finding: `bindaddr=127.0.0.1:18090` starts with
  // the loopback address and so passed, while the port rule never looked at
  // `bindaddr` at all, so a hardcoded port cleared BOTH gates.
  //
  // The comment strip is needed here too, in the opposite direction: without it,
  // `bindaddr=127.0.0.1 ; loopback only` would be compared whole and rejected — the
  // same bug pointed the other way. One helper, both rules.
  for (const file of walkDir(join(__dirname, 'ast-conf'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(bindaddr|tlsbindaddr|bind)\s*=\s*(.+)$/gm)) {
      const value = withoutInlineComment(m[2]).trim();
      assert.ok(
        LOOPBACK_OPTIONAL_TOKENDED_PORT.test(value),
        `${relative(__dirname, file)} binds "${value}" — must be 127.0.0.1, optionally with a __TOKEN__ port`,
      );
    }
  }
  // (b) …and each file that is supposed to bind a listener must have been SEEN
  // doing it. Measured today: pjsip.conf 1 (`bind`), http.conf 2 (`bindaddr`,
  // `tlsbindaddr`), manager.conf 1 (`bindaddr`).
  for (const name of BIND_FILES) {
    const file = join(__dirname, 'ast-conf', name);
    assert.ok(existsSync(file), `ast-conf/${name} is missing — the committed tree is incomplete`);
    const seen = [...readFileSync(file, 'utf8').matchAll(/^\s*(bindaddr|tlsbindaddr|bind)\s*=\s*(.+)$/gm)];
    assert.ok(seen.length >= 1, `ast-conf/${name} yields no bind directive — the rule cannot see the file it guards`);
  }
});

// ── No committed key material, anywhere in the shared or Asterisk trees ──
// TWO rules, because neither covers the other. Measured by the whole-branch
// review against the previous filename-only rule: the gate stayed GREEN with a
// PEM private key sitting in `ast-conf/key.backup`, with a PEM body inlined into
// a `.conf`, and with `.crt`/`.p12` files — only a `.key`/`.pem` FILENAME was
// caught, while the criterion it enforces reads "no secret and no private key in
// the committed Asterisk config; enforced over the whole matrix tree". The
// mechanism is fixed here rather than the wording.
//
// Every certificate-shaped NAME is wrong here too: TLS is minted per run by
// mint-tls and NEVER committed, so there is no legitimate committed cert in this
// tree. The name rule stays as well as the content rule — a DER key carries no
// PEM armour, so only its name will catch it.
const CERT_LIKE_EXTENSIONS = ['.key', '.pem', '.p12', '.pfx', '.der', '.crt'];

// The ARMOUR, not the bare phrase. `test/matrix-shared/mint-tls.unit.test.ts`
// asserts `expect(tls.keyPem).toContain('BEGIN PRIVATE KEY')` — an assertion
// ABOUT a PEM, never key material itself — so a loose
// `/BEGIN [A-Z ]*PRIVATE KEY/` would make this gate RED on a correct tree, and a
// gate that fails on correct code is a gate someone deletes. Requiring BOTH
// `-----` fences is what separates armour from a mention, and this file has no
// comment-stripping helper on purpose: strip comments and an inlined key inside
// a `.conf` comment would go unnoticed.
//
// (This pattern does not match its own source text: `[A-Z ]*` in the source is
// followed by a literal `[`, which the class cannot consume and which is not the
// `P` the pattern needs next. Verified by running it — see the gate result.)
const PRIVATE_KEY_ARMOUR = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

test('no committed private key material, anywhere in the shared or Asterisk trees', () => {
  const files = [...walkDir(__dirname), ...walkDir(join(__dirname, '..', 'matrix-shared'))];
  const byName = files.filter((f) => CERT_LIKE_EXTENSIONS.some((ext) => f.endsWith(ext)));
  assert.deepStrictEqual(
    byName,
    [],
    `found committed key or certificate material: ${byName.join(', ')}`,
  );
  // The real catch: it finds a key whatever it is called, including inlined into
  // a `.conf` or renamed to `key.backup`.
  const byContent = files.filter((f) => PRIVATE_KEY_ARMOUR.test(readFileSync(f, 'utf8')));
  assert.deepStrictEqual(
    byContent,
    [],
    `found PEM private-key armour in: ${byContent.join(', ')}`,
  );
});

// ── The image digest cannot drift between conf.ts and CI ───────────────
// Two places pin the image; a silent divergence would mean the digest in the
// spec, the plan, and the workflow no longer describe the image under test.
test('the pinned digest in conf.ts matches the one in the CI workflow', () => {
  const conf = readFileSync(join(__dirname, 'conf.ts'), 'utf8');
  const digest = /andrius\/asterisk@sha256:([0-9a-f]{64})/.exec(conf);
  assert.ok(digest, 'conf.ts does not pin an andrius/asterisk digest');
  const workflow = readFileSync(
    join(__dirname, '..', '..', '.github', 'workflows', 'asterisk-matrix.yml'),
    'utf8',
  );
  assert.ok(
    workflow.includes(digest[0]),
    `asterisk-matrix.yml does not reference ${digest[0]} — the workflow and the harness disagree about the image`,
  );
});

test('matrix tree is fully enumerated (floor check)', () => {
  const files = walkDir(__dirname);
  assert.ok(files.length >= 15, `asterisk-matrix has ${files.length} files, expected >= 15 — scan may be incomplete`);
});

// `firefoxUserPrefs` under `contextOptions` is accepted and silently ignored,
// making every pref inert and every Firefox leg of the matrix fail while every
// Chromium leg passes. This harness shipped that defect (fixed a420a46) and the
// PR job installs Chromium only, so nothing else here catches it.

test('playwright.config.ts keeps launch-only options out of contextOptions', () => {
  const configPath = join(__dirname, 'playwright.config.ts');
  const found = launchOnlyKeysUnderContextOptions(readFileSync(configPath, 'utf8'));
  assert.deepStrictEqual(
    found,
    [],
    `launch-only option(s) under contextOptions in playwright.config.ts — inert there: ${found
      .map((f) => `${f.key} (line ${f.line})`)
      .join(', ')}`,
  );
});
