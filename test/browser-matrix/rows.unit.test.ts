// test/browser-matrix/rows.unit.test.ts
import { describe, it, expect } from 'vitest';
import {
  ENGINES, EVENTS, ROWS, githubOutputs, launchTarget, rowMatrixForEvent, rowsForEvent, selectRows,
} from './rows.mjs';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('the row table', () => {
  it('has unique kebab-case ids', () => {
    const ids = ROWS.map((r) => r.id);
    expect(new Set(ids).size, `duplicate row id in ${ids.join(', ')}`).toEqual(ids.length);
    for (const id of ids) expect(id, `${id} is not kebab-case`).toMatch(KEBAB);
  });

  it('uses only the three engines', () => {
    for (const row of ROWS) expect(ENGINES, `${row.id}`).toContain(row.engine);
  });

  it('carries a pin and an expected version on every provisioned row', () => {
    for (const row of ROWS) {
      if (row.provision.kind === 'runner') {
        // Recorded, never asserted: the macOS runner provides the browser.
        expect(row.expectedVersion, `${row.id} is a runner row and must not claim an expected version`).toBeNull();
        expect(row.provision.pin, `${row.id} is a runner row and must not carry a pin`).toBeUndefined();
        continue;
      }
      expect(row.provision.pin, `${row.id} has no pin`).toBeTruthy();
      expect(row.expectedVersion, `${row.id} has no expected version`).toBeTruthy();
    }
  });

  it('carries exactly one row per product per stability', () => {
    // NOT "one row per engine": chromium legitimately carries three
    // current/previous rows (the Playwright bundled build, plus Chrome and Edge
    // as their own products). This is the refinement of the spec's invariant
    // that the engine field alone cannot express.
    const keys = ROWS.map((r) => `${r.product}/${r.stability}`);
    expect(new Set(keys).size, `duplicate product/stability in ${keys.join(', ')}`).toEqual(keys.length);
    for (const product of new Set(ROWS.map((r) => r.product))) {
      expect(ROWS.filter((r) => r.product === product && r.stability === 'current'), `${product} needs a current row`).toHaveLength(1);
    }
  });
});

describe('rowsForEvent', () => {
  it('covers every row for every event, and every row carries at least one trigger', () => {
    for (const event of EVENTS) expect(rowsForEvent(event).length, event).toBeGreaterThan(0);
    for (const row of ROWS) expect(row.triggers.length, `${row.id} has no triggers`).toBeGreaterThan(0);
    for (const row of ROWS) {
      for (const t of row.triggers) expect(EVENTS, `${row.id} trigger ${t}`).toContain(t);
    }
  });

  it('makes the PR slice a strict subset that downloads nothing', () => {
    const pr = rowMatrixForEvent('pr');
    const all = rowMatrixForEvent('nightly').map((r) => r.id);
    expect(pr.length).toBeLessThan(all.length);
    for (const entry of pr) expect(all, `${entry.id} is in the PR slice`).toContain(entry.id);
    // Decision 4: the PR slice does zero vendor downloads.
    for (const row of rowsForEvent('pr')) {
      if (row.provision.kind === 'runner') continue; // the Safari row is another workflow, not a Linux row job
      expect(row.provision.kind, `${row.id} runs on PR and must be bundled`).toEqual('bundled');
    }
  });

  it('excludes the runner-provisioned Safari row from the CI matrix', () => {
    for (const event of EVENTS) {
      for (const entry of rowMatrixForEvent(event)) expect(entry.id).not.toEqual('safari-current');
    }
    expect(rowsForEvent('nightly').map((r) => r.id)).toContain('safari-current');
  });
});

describe('selectRows', () => {
  it('returns the requested rows in the requested order', () => {
    const picked = selectRows(['firefox-current', 'chromium-current'], ROWS);
    expect(picked.map((r) => r.id)).toEqual(['firefox-current', 'chromium-current']);
  });

  it('throws on an unknown row id', () => {
    expect(() => selectRows(['chrome-latest'], ROWS)).toThrowError(/unknown row id: chrome-latest/);
  });

  it('throws when a row is not selected for this event', () => {
    const pr = rowsForEvent('pr');
    expect(() => selectRows(['chrome-current'], pr)).toThrowError(/not selected for this event/);
  });

  it('throws on an empty selection instead of reporting a green run that tested nothing', () => {
    expect(() => selectRows([], ROWS)).toThrowError(/no rows selected/);
  });
});

describe('launchTarget', () => {
  const bundled = { id: 'chromium-current', provision: { kind: 'bundled', pin: '1234' } };
  const vendor = { id: 'chrome-previous', provision: { kind: 'cft', pin: '152.0.7977.82' } };
  const runner = { id: 'safari-current', provision: { kind: 'runner' } };

  it('sets no executablePath for a bundled row', () => {
    expect(launchTarget(bundled, {})).toEqual({});
  });

  it('sets the pinned path for a vendor row', () => {
    expect(launchTarget(vendor, { MATRIX_EXECUTABLE_PATH: '/opt/chrome' })).toEqual({ executablePath: '/opt/chrome' });
  });

  it('refuses an external path on a bundled row (decision 6)', () => {
    expect(() => launchTarget(bundled, { MATRIX_EXECUTABLE_PATH: '/usr/bin/google-chrome' })).toThrowError(
      /launched a different build than the row pins/,
    );
  });

  it('refuses to launch a runner-provisioned row', () => {
    expect(() => launchTarget(runner, {})).toThrowError(/provisioned by the macOS workflow/);
  });

  it('refuses a vendor row with no provisioned path', () => {
    expect(() => launchTarget(vendor, {})).toThrowError(/needs MATRIX_EXECUTABLE_PATH/);
  });
});

describe('githubOutputs', () => {
  it('emits GITHUB_OUTPUT lines for the matrix and the expected ids', () => {
    const out = githubOutputs('pr');
    expect(out.ids).toMatch(/^ids=\[".+"\]$/);
    const matrix = JSON.parse(out.matrix.replace(/^matrix=/, ''));
    expect(matrix.include.length).toBe(rowMatrixForEvent('pr').length);
    for (const entry of matrix.include) expect(Object.keys(entry).sort()).toEqual(['id', 'label']);
  });

  it('emits the full Linux matrix for nightly', () => {
    const matrix = JSON.parse(githubOutputs('nightly').matrix.replace(/^matrix=/, ''));
    expect(matrix.include.map((e: { id: string }) => e.id)).toContain('edge-previous');
    expect(matrix.include.map((e: { id: string }) => e.id)).not.toContain('safari-current');
  });
});
