import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  ensureBooted,
  runPhoneScenario,
  runClockProbe,
  waitZeroPhoneResources,
  PHONE_HARNESS_URL,
  PHONE_CONTROL,
  zeroResources,
  idleBaseline,
} from './harness';

/**
 * Lifecycle gate (Task 16):
 *  - Task-15 carry: BrowserPhone constructed WITHOUT an injected clock must
 *    connect, register, and drive its default SIP OPTIONS liveness with NO
 *    `TypeError: Illegal invocation` (the default clock is arrow-bound).
 *  - Task-14 carry: TEN complete connect/register/call/recover/end cycles must
 *    return every owned resource to the exact baseline after every cycle and to
 *    zero after every dispose.
 *  - dispose() must leave the phone in 'disposed' with an all-zero snapshot.
 *
 * NEVER `test.skip`; all three engines must pass.
 */

async function gotoPhone(page: Page): Promise<void> {
  await page.goto(PHONE_HARNESS_URL);
  await ensureBooted(page);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${PHONE_CONTROL}/reset`);
});

test('default clock (no injection) drives OPTIONS liveness without Illegal invocation', async ({ page }) => {
  await gotoPhone(page);

  const result = await runClockProbe(page);

  expect(result.error, 'clock probe page error').toBeUndefined();
  expect(result.connectionState, 'phone connected').toBe('connected');
  expect(result.registrationState, 'phone registered').toBe('registered');
  expect(result.optionsCount ?? 0, 'default-clock liveness OPTIONS actually arrived').toBeGreaterThanOrEqual(1);
  expect(result.uncaughtErrors ?? [], 'no uncaught error (no detached-timer Illegal invocation)').toEqual([]);
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

test('10 connect/register/call/recover/end cycles return to the exact baseline and zero after every cycle', async ({ page }) => {
  await gotoPhone(page);

  const CYCLES = 10;
  const results = [];
  for (let i = 0; i < CYCLES; i += 1) {
    const r = await runPhoneScenario(page, {
      scenario: 'lifecycle',
      cycleIndex: i,
      freqA: 523,
      freqB: 220,
    });
    results.push(r);
  }

  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    expect(r.error, `cycle ${i} page error`).toBeUndefined();
    expect(r.connectionState, `cycle ${i} connected`).toBe('connected');
    expect(r.registrationState, `cycle ${i} registered`).toBe('registered');
    expect(r.callState, `cycle ${i} call established`).toBe('established');
    expect(r.signalingState, `cycle ${i} signaling stable after recovery`).toBe('stable');
    expect(r.resourcesBeforeDispose, `cycle ${i} idle baseline before dispose`).toEqual(idleBaseline);
    expect(r.resourcesAfterCycle, `cycle ${i} exact zero baseline after dispose`).toEqual(zeroResources);
    expect(r.connectionStateAfterDispose, `cycle ${i} disposed`).toBe('disposed');
  }

  // After every one of the 10 closes the whole page bridge has zero open PCs.
  expect(await waitZeroPhoneResources(page), 'zero open PCs across the bridge after 10 cycles').toEqual(true);
});
