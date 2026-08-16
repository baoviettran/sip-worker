import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureBooted, runPhoneScenario, PHONE_HARNESS_URL, PHONE_CONTROL, zeroResources } from './harness';

/**
 * Recovery gate (Task 16): abrupt WSS loss must reconnect, re-register with
 * Call-ID continuity and a strictly-increasing CSeq, and restore the established
 * call — either through in-dialog OPTIONS validation (media stayed up) or a
 * server-observed ICE-restart re-INVITE (a real offline/online network change).
 * Exhausted recovery must FAIL the call. NEVER `test.skip`.
 */

async function gotoPhone(page: Page): Promise<void> {
  await page.goto(PHONE_HARNESS_URL);
  await ensureBooted(page);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${PHONE_CONTROL}/reset`);
});

test('WSS loss reconnects, re-registers with CSeq continuity, and restores the call via OPTIONS validation', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'recovery',
    recovery: { mode: 'fast' },
    freqA: 523,
    freqB: 220,
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.connectionState, 'reconnected').toBe('connected');
  expect(result.registrationState, 're-registered').toBe('registered');
  expect(result.callState, 'call restored').toBe('established');
  expect(result.signalingState, 'signaling stable').toBe('stable');

  expect(result.registerCallIds?.[1], 're-registration reuses the REGISTER Call-ID').toBe(result.registerCallIds?.[0]);
  expect(result.registerCSeqs?.[1] ?? 0, 're-registration CSeq strictly increases').toBeGreaterThan(result.registerCSeqs?.[0] ?? 0);
  expect(result.callIdAfterRecovery, 'dialog Call-ID survives recovery').toBe(result.callIdBeforeRecovery);
  expect(result.inDialogOptionsCount ?? 0, 'server observed the in-dialog OPTIONS validation').toBeGreaterThanOrEqual(1);
  expect(result.rtpResumedAfterRecovery, 'real RTP resumed after recovery').toEqual(true);

  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

test('real offline/online transition drives a server-observed ICE-restart re-INVITE and keeps the same Call-ID', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'recovery',
    recovery: { mode: 'ice-restart' },
    freqA: 523,
    freqB: 220,
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.connectionState, 'reconnected').toBe('connected');
  expect(result.registrationState, 're-registered').toBe('registered');
  expect(result.callState, 'call restored').toBe('established');
  expect(result.signalingState, 'signaling stable').toBe('stable');

  expect(result.callIdAfterRecovery, 'dialog Call-ID survives the ICE restart').toBe(result.callIdBeforeRecovery);
  expect(result.iceRestartRecorded, 'server observed the ICE-restart re-INVITE (new ice-ufrag)').toEqual(true);
  expect(result.registerCallIds?.[1], 're-registration reuses the REGISTER Call-ID').toBe(result.registerCallIds?.[0]);
  expect(result.registerCSeqs?.[1] ?? 0, 're-registration CSeq strictly increases').toBeGreaterThan(result.registerCSeqs?.[0] ?? 0);
  expect(result.rtpResumedAfterRecovery, 'real RTP resumed after the ICE restart').toEqual(true);

  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

test('exhausted recovery fails the call and the connection', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'recovery',
    recovery: { mode: 'exhausted' },
    reconnect: { initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 3, recoveryTimeoutMs: 4000 },
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.callState, 'exhausted recovery fails the call').toBe('failed');
  expect(result.connectionState, 'exhausted recovery fails the connection').toBe('failed');
  expect(result.registrationState, 'exhausted recovery fails registration').toBe('failed');

  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});
