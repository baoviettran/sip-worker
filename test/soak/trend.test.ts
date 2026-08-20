import { describe, expect, it } from 'vitest';
import { assertNoUpwardTrend, computeTrend } from './trend.js';

describe('computeTrend', () => {
  it('computes a zero slope for a flat series', () => {
    const samples = [
      { tMs: 0, value: 1 },
      { tMs: 100, value: 1 },
      { tMs: 200, value: 1 },
      { tMs: 300, value: 1 },
      { tMs: 400, value: 1 },
    ];
    const t = computeTrend(samples);
    expect(t.count).toBe(5);
    expect(t.p95).toBe(1);
    expect(t.slopePerHour).toBe(0);
  });

  it('computes a positive slope for linear growth', () => {
    const samples = [
      { tMs: 0, value: 0 },
      { tMs: 100, value: 1 },
      { tMs: 200, value: 2 },
      { tMs: 300, value: 3 },
      { tMs: 400, value: 4 },
    ];
    const t = computeTrend(samples);
    // +1 per 100ms ≈ +36000/hour; far above the 1/hour threshold.
    expect(t.slopePerHour).toBeGreaterThan(1);
  });

  it('throws on empty samples', () => {
    expect(() => computeTrend([])).toThrow(/empty/);
  });
});

describe('assertNoUpwardTrend', () => {
  it('passes a flat series', () => {
    const samples = [
      { tMs: 0, value: 1 },
      { tMs: 100, value: 1 },
      { tMs: 200, value: 1 },
      { tMs: 300, value: 1 },
      { tMs: 400, value: 1 },
    ];
    expect(() => assertNoUpwardTrend(samples)).not.toThrow();
  });

  it('fails monotone growth (slope)', () => {
    const samples = [
      { tMs: 0, value: 0 },
      { tMs: 100, value: 1 },
      { tMs: 200, value: 2 },
      { tMs: 300, value: 3 },
      { tMs: 400, value: 4 },
    ];
    expect(() => assertNoUpwardTrend(samples)).toThrow(/slope/);
  });

  it('passes a sawtooth series (jitter tolerance)', () => {
    const samples = [
      { tMs: 0, value: 0 },
      { tMs: 100, value: 1 },
      { tMs: 200, value: 0 },
      { tMs: 300, value: 1 },
      { tMs: 400, value: 0 },
    ];
    expect(() => assertNoUpwardTrend(samples)).not.toThrow();
  });

  it('tolerates a single spike (p95, not max)', () => {
    const samples = [
      { tMs: 0, value: 1 },
      { tMs: 100, value: 1 },
      { tMs: 200, value: 9 },
      { tMs: 300, value: 1 },
      { tMs: 400, value: 1 },
    ];
    // The p95 of [1,1,1,1,9] is 1, below the default ceiling of 8.
    expect(() => assertNoUpwardTrend(samples)).not.toThrow();
  });

  it('fails persistent elevation above the ceiling (p95)', () => {
    const samples = [
      { tMs: 0, value: 9 },
      { tMs: 100, value: 9 },
      { tMs: 200, value: 9 },
      { tMs: 300, value: 9 },
      { tMs: 400, value: 9 },
    ];
    expect(() => assertNoUpwardTrend(samples)).toThrow(/ceiling/);
  });

  it('fails a raised tail half (tail growth)', () => {
    // Head flat at 1; tail flat at 3 two hours later: slope is 2/2h = 1/h
    // (passes), p95 is 3 (passes), but the tail mean exceeds head + 1.
    const samples = [
      { tMs: 0, value: 1 },
      { tMs: 60_000, value: 1 },
      { tMs: 120_000, value: 1 },
      { tMs: 7_200_000, value: 3 },
      { tMs: 7_260_000, value: 3 },
      { tMs: 7_320_000, value: 3 },
    ];
    expect(() => assertNoUpwardTrend(samples)).toThrow(/tail mean/);
  });
});
