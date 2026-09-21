// test/browser-matrix/report.unit.test.ts
import { describe, it, expect } from 'vitest';
import { ROWS } from './rows.mjs';
import { buildReport, VERSION_SPEC_MARKER } from './report.mjs';

const row = ROWS.find((r: { id: string }) => r.id === 'chrome-previous')!;

describe('buildReport', () => {
  it('carries the row provenance, the observed version, and the environment', () => {
    const report = buildReport({
      row,
      observedVersion: '152.0.7977.82',
      suites: { 'browser-media/two-way-audio.spec.ts': 'passed' },
      env: { playwrightVersion: '1.62.0', runnerOs: 'Linux', runId: '123', url: 'https://example.invalid/run/123' },
    });
    expect(report).toEqual({
      row: 'chrome-previous',
      engine: 'chromium',
      label: 'Chrome (previous stable)',
      provision: { kind: 'cft', pin: '152.0.7977.82' },
      expectedVersion: '152.0.7977.82',
      observedVersion: '152.0.7977.82',
      suites: { 'browser-media/two-way-audio.spec.ts': 'passed' },
      playwrightVersion: '1.62.0',
      runnerOs: 'Linux',
      runId: '123',
      url: 'https://example.invalid/run/123',
    });
  });

  it('records an unrun version spec as a null observation, never as a guess', () => {
    const report = buildReport({ row, observedVersion: null, suites: {}, env: {} });
    expect(report.observedVersion).toBeNull();
    expect(report.reason).toEqual(VERSION_SPEC_MARKER);
  });
});
