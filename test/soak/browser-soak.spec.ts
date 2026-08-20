import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  ensureBooted,
  runPhoneScenario,
  waitZeroPhoneResources,
  PHONE_HARNESS_URL,
  PHONE_CONTROL,
  zeroResources,
} from '../browser-phone/harness';
import type { Snapshot } from '../browser-phone/harness';
import { assertNoUpwardTrend } from './trend';
import type { TrendSample } from './trend';

const CYCLES = Number(process.env.SOAK_CYCLES ?? 5);
const SNAPSHOT_FIELDS: (keyof Snapshot)[] = [
  'activeSocketGenerations',
  'reconnectAttempts',
  'reconnectTimers',
  'activeCalls',
  'activeNegotiations',
  'pendingOperations',
  'timers',
  'peerConnections',
  'localTracks',
  'lifecycleListeners',
  'deviceListeners',
];

test.beforeEach(async ({ request }) => {
  await request.post(`${PHONE_CONTROL}/reset`);
});

test('repeated lifecycle cycles never leak owned resources', async ({ page }) => {
  test.setTimeout(180_000 + CYCLES * 10_000);

  await page.goto(PHONE_HARNESS_URL);
  await ensureBooted(page);

  const series: Record<string, TrendSample[]> = {};
  for (const field of SNAPSHOT_FIELDS) series[field] = [];

  for (let i = 0; i < CYCLES; i += 1) {
    const result = await runPhoneScenario(page, {
      scenario: 'lifecycle',
      cycleIndex: i,
      freqA: 523,
      freqB: 220,
    });

    // The exact lifecycle gate contract, per cycle.
    expect(result.error, `cycle ${i} page error`).toBeUndefined();
    expect(result.connectionState, `cycle ${i} connected`).toBe('connected');
    expect(result.registrationState, `cycle ${i} registered`).toBe('registered');
    expect(result.callState, `cycle ${i} call established`).toBe('established');
    expect(result.signalingState, `cycle ${i} signaling stable`).toBe('stable');
    expect(result.connectionStateAfterDispose, `cycle ${i} disposed`).toBe('disposed');

    // Live-phone resources feed the shared trend helper (must stay flat).
    for (const field of SNAPSHOT_FIELDS) {
      series[field]!.push({ tMs: Date.now(), value: result.resourcesBeforeDispose?.[field] ?? 0 });
    }

    // Exact zero owned-resources after dispose, per cycle.
    expect(result.resourcesAfterCycle, `cycle ${i} zero baseline after dispose`).toEqual(zeroResources);
  }

  // No upward trend in any live-phone resource field across cycles.
  for (const field of SNAPSHOT_FIELDS) {
    assertNoUpwardTrend(series[field]!, {
      max: 8,
      maxSlopePerHour: 1,
      maxTailGrowth: 1,
    });
  }

  // After every cycle the whole page bridge has zero open peer connections.
  expect(await waitZeroPhoneResources(page), 'zero open PCs across the bridge').toEqual(true);
});
