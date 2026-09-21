// test/browser-matrix/version.spec.ts — the unskippable version assertion.
//
// A normal test, not a globalSetup: a run can outlive globalSetup, and this
// assertion must fail the row that failed it. It is the second of the three
// fail-not-skip levels (provisioner, this, publisher).
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ROWS } from './rows.mjs';
import { reportDir, versionFilePath } from './report.mjs';

test.describe('browser-matrix row provenance', () => {
  test('the launched engine reports the version this row pins', async ({ browser }) => {
    const rowId = test.info().project.name;
    const row = ROWS.find((r) => r.id === rowId);
    expect(row, `project ${rowId} is not a row in the table`).toBeTruthy();
    expect(
      row!.provision.kind,
      `row ${rowId} is provisioned by another workflow and must never be launched here`,
    ).not.toEqual('runner');

    const observed = browser.version();

    // Write BEFORE asserting: the artifact must record what was seen even when
    // the version is wrong, which is what makes a mis-pinned row diagnosable
    // from the uploaded report alone.
    // versionFilePath, not a hand-built path: the reporter reads this file back
    // in another step, and two independent constructions of one path is how a
    // report silently becomes 'version-spec-not-run'.
    const file = versionFilePath(rowId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ row: rowId, observedVersion: observed }, null, 2)}\n`);

    expect(
      observed,
      `row ${rowId} must report ${row!.expectedVersion} (provision ${row!.provision.kind} ${row!.provision.pin}); ` +
        'a mismatch means the pin, the table, or the provisioned artifact moved — fix the pin deliberately, do not paste the new version in',
    ).toEqual(row!.expectedVersion);
  });
});
