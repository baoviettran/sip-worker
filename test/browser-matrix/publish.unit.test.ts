// test/browser-matrix/publish.unit.test.ts
import { describe, it, expect } from 'vitest';
import { ROWS } from './rows.mjs';
import { renderMatrixDocs, validateReports } from './publish.mjs';

const report = (rowId: string, observedVersion: string | null) => {
  const row = ROWS.find((r: { id: string }) => r.id === rowId)!;
  return {
    row: row.id, engine: row.engine, label: row.label,
    provision: { ...row.provision }, expectedVersion: row.expectedVersion,
    observedVersion, suites: { 'browser-media/two-way-audio.spec.ts': 'passed' },
    playwrightVersion: '1.62.0', runnerOs: 'Linux', runId: '1', url: '',
  };
};

describe('validateReports', () => {
  it('accepts a complete, matching set', () => {
    const out = validateReports({
      expected: ['chromium-current', 'chrome-previous'],
      reports: [report('chromium-current', '151.0.7922.34'), report('chrome-previous', '152.0.7977.82')],
    });
    expect(out).toEqual({ ok: true, missing: [], mismatched: [], extra: [] });
  });

  it('reports a missing row — the failure that would otherwise be silence', () => {
    const out = validateReports({ expected: ['chromium-current', 'edge-previous'], reports: [report('chromium-current', '151.0.7922.34')] });
    expect(out.ok).toBe(false);
    expect(out.missing).toEqual(['edge-previous']);
  });

  it('reports a null observation (the version spec never ran) as a mismatch', () => {
    const out = validateReports({ expected: ['chrome-previous'], reports: [report('chrome-previous', null)] });
    expect(out.ok).toBe(false);
    expect(out.mismatched).toEqual(['chrome-previous: no observation recorded']);
  });

  it('reports a wrong version as a mismatch and never as a pass', () => {
    const out = validateReports({ expected: ['chrome-previous'], reports: [report('chrome-previous', '151.0.7922.34')] });
    expect(out.mismatched).toEqual(['chrome-previous: observed 151.0.7922.34, expected 152.0.7977.82']);
  });

  it('reports an unexpected row so a stale artifact cannot join the merge', () => {
    const out = validateReports({ expected: ['chromium-current'], reports: [report('chromium-current', '151.0.7922.34'), report('chrome-current', '153.0.8010.52')] });
    expect(out.ok).toBe(true);
    expect(out.extra).toEqual(['chrome-current']);
  });

  it('compares against the table pin, not the artifact\'s own claim', () => {
    // The stale artifact: its own expectedVersion matches its observation, and
    // only the table disagrees. Comparing the report against itself passes this.
    const stale = { ...report('chrome-previous', '999.0.0.1'), expectedVersion: '999.0.0.1' };
    const out = validateReports({ expected: ['chrome-previous'], reports: [stale] });
    expect(out.ok).toBe(false);
    expect(out.mismatched).toEqual(['chrome-previous: observed 999.0.0.1, expected 152.0.7977.82']);
  });

  it('requires the runner-recorded row to be recorded, and accepts what it recorded', () => {
    // safari-current pins no version, so a recorded one is accepted as-is — but
    // the null marker is still a failure, never a quiet pass.
    expect(validateReports({ expected: ['safari-current'], reports: [report('safari-current', '18.6')] }).ok).toBe(true);
    const out = validateReports({ expected: ['safari-current'], reports: [report('safari-current', null)] });
    expect(out.ok).toBe(false);
    expect(out.mismatched).toEqual(['safari-current: no observation recorded']);
  });
});

describe('renderMatrixDocs', () => {
  it('names every row and labels the Firefox and WebKit proxies honestly', () => {
    const text = renderMatrixDocs(ROWS);
    for (const row of ROWS) expect(text, `missing ${row.id}`).toContain(`\`${row.id}\``);
    expect(text).toContain('Playwright WebKit');
    // Never label the automated engine as real Safari (docs contract rule).
    expect(text).not.toMatch(/WebKit *\/ *Safari|Playwright Desktop Safari/i);
    expect(text).toMatch(/Safari[^]{0,80}recorded/i);
  });

  it('renders a table row per matrix row with its pin and expected version', () => {
    const text = renderMatrixDocs(ROWS);
    expect(text).toContain('| `chrome-previous` |');
    expect(text).toContain('152.0.7977.82');
  });

  it('states the observed versions come from the artifact, not from the table', () => {
    const text = renderMatrixDocs(ROWS);
    expect(text).toMatch(/observedVersion|observed version/i);
    expect(text).toMatch(/artifact|report/i);
  });

  it('fills the observed column from a report and never from the pin', () => {
    // Without this the `{ observed }` branch has no caller in the tests at all,
    // and the page's central honesty claim — the column shows what a run
    // reported, or nothing — rests on an unexercised path.
    const text = renderMatrixDocs(ROWS, {
      observed: new Map([
        ['chromium-current', '151.0.7922.34'],
        ['safari-current', '18.6'],
        ['chrome-previous', null],
      ]),
    });
    // A recorded version is rendered.
    expect(text).toMatch(/`safari-current`[^\n]*\| 18\.6 \|/);
    // A null observation is the em dash, never the string "null".
    const chromePrevious = text.split('\n').find((line) => line.includes('`chrome-previous`'))!;
    expect(chromePrevious.endsWith('| — |')).toBe(true);
    // A row with no report claims nothing: its pin appears once, in the expected
    // column, not twice — a fallback of `observed ?? row.expectedVersion` would
    // render the pin as if a run had reported it.
    const firefox = text.split('\n').find((line) => line.includes('`firefox-current`'))!;
    expect(firefox.match(/153\.0/g)).toHaveLength(1);
    expect(firefox.endsWith('| — |')).toBe(true);
  });
});
