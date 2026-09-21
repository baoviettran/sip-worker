// test/browser-matrix/publish.mjs — the matrix publisher and the docs renderer.
//
// Two jobs, one file, because they read the same shape:
//
//   node test/browser-matrix/publish.mjs --expected a,b --in reports --out merged.json
//     The completeness gate. Exits non-zero when an expected row's report is
//     absent or its observedVersion is null or does not match the row table —
//     the third fail-not-skip level. Runs even when a row job failed, so a
//     failed row produces a diagnostic rather than a skipped check.
//
//   node test/browser-matrix/publish.mjs --docs --out docs/supported-browser-matrix.md
//   node test/browser-matrix/publish.mjs --docs --in reports --out <page>.md
//     The published matrix. This is the only path a page is written from: the
//     observed column is filled from a merged report when --in is given, and
//     left empty when it is not, so a committed page can never claim a version
//     no run asserted. There is deliberately no separate "--from-table" mode —
//     it would be the same call with a flag that changes nothing.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROWS } from './rows.mjs';

export function validateReports({ expected, reports }) {
  const byRow = new Map();
  const extra = [];
  for (const report of reports) {
    if (expected.includes(report.row)) byRow.set(report.row, report);
    else extra.push(report.row);
  }
  const missing = expected.filter((id) => !byRow.has(id));
  const mismatched = [];
  for (const id of expected) {
    const report = byRow.get(id);
    if (!report) continue;
    // The pin compared against is the TABLE's, never the artifact's own claim:
    // `report.observedVersion !== report.expectedVersion` only proves the report
    // agrees with itself, and a stale artifact — one written against a bumped
    // table — would validate while its engine is a version nobody pinned
    // (measured: validateReports never read ROWS at all).
    const row = ROWS.find((r) => r.id === id);
    if (!row) {
      mismatched.push(`${id}: not a row in the table`);
      continue;
    }
    // A null observation is the marker report.mjs writes when the version spec
    // never ran, so it fails even for the row that pins no version: the spec's
    // third fail-not-skip level rejects "absent or null/mismatched" alike.
    if (typeof report.observedVersion !== 'string') {
      mismatched.push(`${id}: no observation recorded${report.reason ? ` (${report.reason})` : ''}`);
      continue;
    }
    // safari-current pins expectedVersion null because the macOS runner provides
    // it: the row asserts nothing, so any version it RECORDED is acceptable —
    // only the recording is required.
    if (row.expectedVersion !== null && report.observedVersion !== row.expectedVersion) {
      mismatched.push(`${id}: observed ${report.observedVersion}, expected ${row.expectedVersion}`);
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, extra };
}

const PROVISION_TEXT = {
  bundled: (row) => `Playwright bundled (rev ${row.provision.pin})`,
  cft: (row) => `Chrome for Testing ${row.provision.pin}`,
  'edge-deb': (row) => `Edge stable ${row.provision.pin} (\`.deb\`)`,
  'pw-firefox': (row) => `Playwright Firefox build rev ${row.provision.pin}`,
  runner: () => 'provided by the macOS runner',
};

/**
 * The published matrix page. The row table is the source of truth for
 * provenance; observed versions are only ever rendered from a report, never
 * inferred, because a page that claims a version no run asserted is worse than
 * no page.
 */
export function renderMatrixDocs(rows, { observed = new Map() } = {}) {
  const lines = [
    '# Supported browser matrix',
    '',
    'The engines this project is verified against, and how each one is provisioned.',
    'The rows are declared in [`test/browser-matrix/rows.mjs`](../test/browser-matrix/rows.mjs);',
    'this page is rendered from that table by',
    '`npm run test:browsermatrix:docs`.',
    '',
    '| Row | Browser | Engine | Provisioned as | Expected version | Observed version |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const provision = PROVISION_TEXT[row.provision.kind]?.(row) ?? row.provision.kind;
    const observedVersion = observed.get(row.id);
    lines.push(
      `| \`${row.id}\` | ${row.label} | ${row.engine} | ${provision} | ${row.expectedVersion ?? 'recorded, not asserted'} | ${observedVersion ?? '—'} |`,
    );
  }
  lines.push(
    '',
    '## What each column means',
    '',
    '- **Expected version** is asserted at provision time and again in-suite by',
    '  `test/browser-matrix/version.spec.ts`: the row fails unless the launched',
    '  engine reports exactly this version. A vendor bump is a deliberate commit',
    '  that changes the row table and this assertion together.',
    '- **Observed version** is filled in from the `browser-matrix` report artifact of a',
    '  run (`observedVersion` in each row\'s JSON). Rows rendered from the table alone',
    '  show `—`: no version is claimed that a run did not report.',
    '- **Playwright WebKit** is the automated engine on Linux, used as the Safari-family',
    '  proxy. It is not real Safari. The `safari-current` row is the real browser, run by',
    '  the macOS workflow, and its version is **recorded** rather than asserted, because',
    '  Safari cannot be pinned on a hosted runner.',
    '- **Firefox** rows are Playwright\'s own patched, Juggler-speaking Firefox builds.',
    '  Playwright cannot drive upstream Firefox, so a Firefox row is a documented proxy:',
    '  the row names the Playwright build exactly.',
    '- **The Firefox version numbers are Playwright\'s build numbers, not upstream releases.**',
    '  `firefox-current` reporting 153.0 and `firefox-previous` reporting 151.0 are two builds',
    '  of the same patched browser at different Playwright revisions; upstream Firefox is',
    '  further ahead than both. This is a property of the driver, not a stale pin — no pin of',
    '  this table can move it.',
    '- **The `edge-deb` rows unpack a `.deb`** with `dpkg-deb -x` rather than installing it, so',
    '  no vendored package touches the runner\'s own browser installation. The extraction does',
    '  not carry the setuid bit Edge\'s `chrome-sandbox` expects, which is why those rows may',
    '  launch with `--no-sandbox`.',
    '',
    '## Runs',
    '',
    '- Pull requests run the bundled rows only, so no vendor artifact is downloaded.',
    '- Push to `main` and the nightly schedule run the full matrix, one row per job.',
    '- The forced-TURN relay leg stays a separate job: relaying is engine-agnostic and',
    '  already proven on three engines, and a per-row expansion would cost one coturn',
    '  container per row for no new claim.',
    '',
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--docs') args[key.slice(2)] = true;
    else if (key.startsWith('--')) { args[key.slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.docs) {
      if (!args.out) throw new Error('--out is required with --docs (the page to write)');
      const observed = new Map();
      if (args.in) {
        for (const report of readReports(args.in)) observed.set(report.row, report.observedVersion);
      }
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, `${renderMatrixDocs(ROWS, { observed })}\n`);
      process.stdout.write(`publish: wrote ${args.out}${args.in ? ` (observed versions from ${args.in})` : ' (from the row table)'}\n`);
      process.exit(0);
    }
    // T9 hands this the `ids` job output, which rows.mjs emits as a JSON array
    // (`ids=["chromium-current",…]` — pinned by rows.unit.test.ts and asserted
    // verbatim in the workflow gate, so neither side can move to CSV alone).
    // Splitting that on commas leaves every id quoted and bracketed, matching no
    // report, which reads as missing rows and blames the matrix (measured).
    // CSV is still accepted so a hand-run and the CI path use one parser.
    const rawExpected = (args.expected ?? '').trim();
    const expected = (rawExpected.startsWith('[') ? JSON.parse(rawExpected) : rawExpected.split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (expected.length === 0) throw new Error('--expected is required (the row ids this event must produce)');
    const reports = readReports(args.in);
    const result = validateReports({ expected, reports });
    const merged = { generatedAt: new Date().toISOString(), rows: reports, expected, ...result };
    if (args.out) writeFileSync(args.out, `${JSON.stringify(merged, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(
        `publish: INCOMPLETE matrix — missing rows: ${result.missing.join(', ') || 'none'}; ` +
          `mismatched: ${result.mismatched.join('; ') || 'none'}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`publish: ${reports.length} rows complete${result.extra.length ? ` (ignored extra: ${result.extra.join(', ')})` : ''}\n`);
  } catch (error) {
    process.stderr.write(`publish: ${error.message}\n`);
    process.exit(1);
  }
}

function readReports(dir) {
  const reports = [];
  for (const name of readdirSync(dir)) {
    // `matrix.json` is the merge this writes; `<row>.version.json` is the
    // version observation T5's spec writes for the reporter to read back, and
    // it carries `row` and `observedVersion` too. Without this skip it is read
    // as a SECOND report for the same row, wins or loses the by-row race on
    // readdir order, and — when it wins — fails the run with a mismatch against
    // its undefined expectedVersion (measured on the T5 artifact directory: both
    // files accepted, the version file the winner, `ok: false`).
    if (!name.endsWith('.json') || name === 'matrix.json' || name.endsWith('.version.json')) continue;
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (parsed && typeof parsed.row === 'string' && 'observedVersion' in parsed) reports.push(parsed);
  }
  return reports;
}
