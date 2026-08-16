import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  ensureBooted,
  runPhoneScenario,
  PHONE_HARNESS_URL,
  PHONE_CONTROL,
  zeroResources,
} from './harness';

/**
 * Peer-initiated re-INVITE gate (Finding 1): the PEER renegotiates an
 * established call with a benign `sendrecv` offer. The library must answer from
 * its EXISTING transceiver — exactly ONE audio transceiver, no mic
 * re-acquisition, the SAME sender track — and mute must still silence the wire
 * afterwards, with RTP recovering on unmute and resources returning to the
 * exact 11-key baseline after hangup + dispose.
 *
 * NEVER `test.skip`. This is part of the three-engine browser-phone gate.
 */

async function gotoPhone(page: Page): Promise<void> {
  await page.goto(PHONE_HARNESS_URL);
  await ensureBooted(page);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${PHONE_CONTROL}/reset`);
});

test('peer re-INVITE preserves one transceiver; mute still silences the wire', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'controls',
    peerReinvite: { direction: 'sendrecv' },
    freqA: 523,
    freqB: 220,
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.connectionState, 'phone connected').toBe('connected');
  expect(result.callState, 'call established').toBe('established');
  expect(result.signalingState, 'signaling stable after the peer re-INVITE').toBe('stable');

  // No re-acquisition: exactly ONE getUserMedia for the whole cycle, and the
  // library keeps ONE audio transceiver with the SAME sender track.
  expect(result.micAcquisitionsBeforeReinvite, 'one mic acquisition at establishment').toBe(1);
  expect(result.micAcquisitionsAfterReinvite, 'no mic re-acquisition on the peer re-INVITE').toBe(1);
  expect(result.libraryTransceiverCountBeforeReinvite, 'one audio transceiver at establishment').toBe(1);
  expect(result.libraryTransceiverCountAfterReinvite, 'still one audio transceiver after the peer re-INVITE').toBe(1);
  expect(result.librarySenderTrackIdAfterReinvite, 'sender track identity unchanged').toBe(
    result.librarySenderTrackIdBeforeReinvite,
  );
  expect(result.reinviteDirectionRecorded, 'server recorded the benign re-INVITE').toBe('sendrecv');

  // Mute still silences the wire and unmute restores RTP on the SAME session.
  expect(typeof result.mutedThreshold, 'mutedThreshold measured by the page').toBe('number');
  expect(result.outboundAudioAfterMute, 'muted outbound audio growth below muted threshold').toBeLessThan(
    result.mutedThreshold as number,
  );
  expect(typeof result.activeThreshold, 'activeThreshold measured by the page').toBe('number');
  expect(result.outboundAudioAfterUnmute, 'unmuted outbound audio growth above active threshold').toBeGreaterThan(
    result.activeThreshold as number,
  );

  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});
