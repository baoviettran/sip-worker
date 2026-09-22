// test/browser-matrix/report.mjs — the row report, written once per run.
//
// One writer, so no two files can disagree about what a row observed. The
// version assertion is produced by version.spec.ts, which writes
// `<reportDir>/<row>.version.json`; this reporter reads it back in onEnd. When
// that file is absent the report still gets written, with observedVersion null
// and `reason` naming the marker — the publisher rejects such a row, so a
// deleted or renamed version spec cannot produce a green report (it is a third,
// independent fail-not-skip level behind the spec's own assertion).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROWS } from './rows.mjs';

/** Stamped on a report whose version spec never ran. */
export const VERSION_SPEC_MARKER = 'version-spec-not-run';

export function reportDir() {
  return process.env.MATRIX_REPORT_DIR ?? 'test-results/browser-matrix';
}

export function buildReport({ row, observedVersion, suites, env }) {
  const report = {
    row: row.id,
    engine: row.engine,
    label: row.label,
    provision: { ...row.provision },
    expectedVersion: row.expectedVersion,
    observedVersion: observedVersion ?? null,
    suites: suites ?? {},
    playwrightVersion: env.playwrightVersion ?? 'unknown',
    runnerOs: env.runnerOs ?? 'unknown',
    runId: env.runId ?? 'local',
    url: env.url ?? '',
  };
  if (observedVersion == null) report.reason = VERSION_SPEC_MARKER;
  return report;
}

/** The version file one spec run writes for one row. */
export function versionFilePath(rowId) {
  return join(reportDir(), `${rowId}.version.json`);
}

/** Read the version file if the row's version spec ran; null otherwise. */
export function readObservedVersion(rowId) {
  try {
    const parsed = JSON.parse(readFileSync(versionFilePath(rowId), 'utf8'));
    return typeof parsed.observedVersion === 'string' ? parsed.observedVersion : null;
  } catch {
    return null;
  }
}

export function writeReport(report) {
  mkdirSync(reportDir(), { recursive: true });
  writeFileSync(join(reportDir(), `${report.row}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

function environment() {
  let playwrightVersion = 'unknown';
  try {
    // Hoisted to the workspace root by npm ci.
    const require = createRequire(import.meta.url);
    playwrightVersion = require('../../node_modules/@playwright/test/package.json').version;
  } catch {}
  return {
    playwrightVersion,
    runnerOs: process.env.RUNNER_OS ?? process.platform,
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '',
  };
}

/** Per-file pass/fail, which is the granularity a row report is read at. */
export default class MatrixReporter {
  constructor() {
    this.selected = (process.env.MATRIX_ROWS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    this.suites = new Map(); // file -> 'passed' | 'failed'
    this.counts = new Map(); // file -> number of tests
  }

  onBegin(_config, suite) {
    for (const test of suite.allTests()) this.counts.set(test.location.file, (this.counts.get(test.location.file) ?? 0) + 1);
  }

  onTestEnd(test, result) {
    const file = test.location.file;
    const failed = result.status !== 'passed' && result.status !== 'skipped';
    if (failed || !this.suites.has(file)) this.suites.set(file, failed ? 'failed' : 'passed');
  }

  onEnd() {
    const env = environment();
    const reports = this.selected.map((id) => {
      const row = ROWS.find((r) => r.id === id);
      if (!row) throw new Error(`reporter: MATRIX_ROWS names an unknown row: ${id}`);
      const suites = {};
      for (const [file, status] of this.suites) suites[file.replace(/^.*\/test\//, '')] = status;
      return buildReport({ row, observedVersion: readObservedVersion(id), suites, env });
    });
    for (const report of reports) writeReport(report);
    const merged = { generatedAt: new Date().toISOString(), rows: reports };
    mkdirSync(reportDir(), { recursive: true });
    writeFileSync(join(reportDir(), 'matrix.json'), `${JSON.stringify(merged, null, 2)}\n`);
    for (const report of reports) {
      const verdict = report.observedVersion === report.expectedVersion ? 'ok' : `MISMATCH (expected ${report.expectedVersion})`;
      process.stdout.write(`matrix row ${report.row}: observed ${report.observedVersion ?? 'none'} ${verdict}\n`);
    }
  }
}
