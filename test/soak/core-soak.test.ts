import { describe, expect, it } from 'vitest';
import { assertNoUpwardTrend } from './trend.js';
import { runCoreSoak } from './core-soak.js';

describe('core soak', () => {
  it('drives register + call cycles without leaking timers or listeners', { timeout: 60_000 }, async () => {
    const result = await runCoreSoak({ cycles: 5, interCycleMs: 10 });

    expect(result.callFailures).toBe(0);
    expect(result.invitesHandled).toBe(5);
    expect(result.byesHandled).toBe(5);
    expect(result.samples).toHaveLength(5);

    // Exact zero-resource baseline after dispose.
    expect(result.zeroTimers).toBe(0);
    expect(result.zeroListeners).toBe(0);

    // No upward trend across cycles. Slope catches a per-cycle leak
    // (5 extra timers over ~500ms is ~36,000/hour); p95 ceiling catches
    // persistent elevation; the state trace proves each call ran full term.
    assertNoUpwardTrend(result.samples.map((s) => ({ tMs: s.tMs, value: s.timers })), {
      max: 8,
      maxSlopePerHour: 1,
      maxTailGrowth: 1,
    });
    assertNoUpwardTrend(result.samples.map((s) => ({ tMs: s.tMs, value: s.listeners })), {
      max: 12,
      maxSlopePerHour: 1,
      maxTailGrowth: 1,
    });

    expect(result.stateTrace).toContain('registered');
    expect(result.stateTrace).toContain('terminated');
  });
});

const soakDurationMs = Number(process.env.SOAK_DURATION_MS ?? 0);
const interCycleMs = Number(process.env.SOAK_INTER_CYCLE_MS ?? 500);

it.skipIf(soakDurationMs <= 0)(
  'runs the configured soak window without upward trends or leaks',
  { timeout: soakDurationMs + 60_000 },
  async () => {
    const cycles = Math.max(1, Math.ceil(soakDurationMs / interCycleMs) * 2);
    const result = await runCoreSoak({ cycles, interCycleMs, maxDurationMs: soakDurationMs });

    const tolerance = Math.max(1, Math.floor(0.001 * result.samples.length));
    expect(result.callFailures, `${result.callFailures} call failures across ${result.samples.length} cycles`).toBeLessThanOrEqual(tolerance);

    expect(result.zeroTimers).toBe(0);
    expect(result.zeroListeners).toBe(0);

    assertNoUpwardTrend(result.samples.map((s) => ({ tMs: s.tMs, value: s.timers })), {
      max: 8,
      maxSlopePerHour: 1,
      maxTailGrowth: 1,
    });
    assertNoUpwardTrend(result.samples.map((s) => ({ tMs: s.tMs, value: s.listeners })), {
      max: 12,
      maxSlopePerHour: 1,
      maxTailGrowth: 1,
    });

    // The soak actually exercised the full call lifecycle.
    expect(result.invitesHandled).toBeGreaterThan(0);
    expect(result.byesHandled).toBeGreaterThan(0);
  },
);
