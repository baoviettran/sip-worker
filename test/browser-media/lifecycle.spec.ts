import { test, expect } from '@playwright/test';
import { ensureBooted, waitZeroResources, runCycles } from './harness';

/**
 * Lifecycle gate: the real library must complete at least TEN consecutive
 * create -> negotiate -> media -> cleanup call cycles in each engine with ZERO
 * leaked owned PCs, live tracks, listeners, or timers after EVERY close — no
 * leak, no drift on the 10th cycle.
 *
 * Never `test.skip`; all three engines must pass.
 */

const CYCLES = 10;

test('10 call cycles: zero leaked PCs/tracks/listeners/timers after every close', async ({ page }) => {
  await page.goto('/index.html');
  await ensureBooted(page);

  const results = await runCycles(page, CYCLES, { scenario: 'direct', freqA: 440, freqB: 880 });

  // Every cycle must deliver real connected media (no page error, RTP grew)
  // AND must return to ZERO owned live resources after the per-cycle close —
  // a leak or nonzero spike in ANY of the 10 cycles fails here, not just a
  // cumulative leak after the 10th.
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    expect(r.error, `cycle ${i} page error`).toBeUndefined();
    expect(r.libraryConnState, `cycle ${i} library connected`).toEqual('connected');
    expect(r.libraryMedia?.ok, `cycle ${i} library RTP grew`).toEqual(true);
    expect(r.timersAfter, `cycle ${i} has zero live timers after close`).toEqual(0);
    expect(r.listenersAfter, `cycle ${i} has zero device listeners after close`).toEqual(0);
    expect(r.pcsAfter, `cycle ${i} has zero open PCs after close`).toEqual(0);
  }

  // Cumulative form: after every one of the 10 closes the whole bridge is at
  // zero open PCs / timers / listeners (waitZeroResources polls the live bridge
  // tallies), including the 10th.
  expect(await waitZeroResources(page), 'resources returned to zero after every close').toEqual(true);
  const state = await page.evaluate(() =>
    (window as unknown as {
      __webRtcMediaRun: { resourceState: () => { openPcs: number; timers: number; listeners: number } };
    }).__webRtcMediaRun.resourceState(),
  );
  expect(state, 'zero live resources after the 10th close').toEqual({ openPcs: 0, timers: 0, listeners: 0 });
});