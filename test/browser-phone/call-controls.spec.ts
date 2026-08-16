import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import {
  ensureBooted,
  runPhoneScenario,
  PHONE_HARNESS_URL,
  PHONE_CONTROL,
  zeroResources,
} from './harness';
import type { TurnOpts } from './harness';

/**
 * Call-controls gate (Task 16): mute, hold/resume, and real RFC 4733 DTMF on a
 * real BrowserPhone call between the library's RTCPeerConnection and the in-page
 * synthetic peer, plus accept/reject/cancel call control, and the forced-TURN
 * static/refreshed credential scenarios.
 *
 * NEVER `test.skip`. The forced-TURN tests FAIL (requireTurnVars-style, before
 * any browser launch) when the coturn TURN variables are absent; they run in the
 * CI `forced-turn-relay` job with a provisioned coturn and are excluded from the
 * three-engine gate by their "forced TURN relay" titles.
 */

async function gotoPhone(page: Page): Promise<void> {
  await page.goto(PHONE_HARNESS_URL);
  await ensureBooted(page);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${PHONE_CONTROL}/reset`);
});

// ---------------------------------------------------------------------------
// Turn helper (same requireTurnVars contract as test/browser-media/turn-relay)
// ---------------------------------------------------------------------------

function turnHost(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const normalized = /^turns?:\/\//i.test(value)
    ? value
    : value.replace(/^(turns?):/i, '$1://');
  const hostname = new URL(normalized).hostname;
  if (hostname.length === 0) throw new Error('TURN URL must contain a hostname');
  return hostname;
}

const TURN_HOST = turnHost(process.env.TURN_URL, '127.0.0.1');
const TURN_PEER_HOST = turnHost(process.env.TURN_PEER_URL, TURN_HOST);
const TURN_PORT = process.env.TURN_PORT ? Number(process.env.TURN_PORT) : 0;
const TURN_USERNAME = process.env.TURN_USERNAME ?? '';
const TURN_PASSWORD = process.env.TURN_PASSWORD ?? '';

function requireTurnVars(): void {
  const missing: Array<string> = [];
  if (!TURN_PORT) missing.push('TURN_PORT');
  if (!TURN_USERNAME) missing.push('TURN_USERNAME');
  if (!TURN_PASSWORD) missing.push('TURN_PASSWORD');
  expect(
    missing,
    `forced TURN gate requires provisioned coturn credentials. Missing: ${missing.join(', ') || '(none)'}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

test('mute stops effective outbound audio and unmute restores it', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'controls',
    controls: { mute: true },
    freqA: 523,
    freqB: 220,
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.connectionState, 'phone connected').toBe('connected');
  expect(result.registrationState, 'phone registered').toBe('registered');
  expect(result.callState, 'call established').toBe('established');

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

test('hold changes the negotiated direction to sendonly and resume restores two-way RTP', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'controls',
    controls: { hold: true },
    freqA: 523,
    freqB: 220,
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.callState, 'call established').toBe('established');
  expect(result.holdOfferDirection, 'hold re-INVITE negotiated direction').toBe('sendonly');
  expect(result.holdDirectionAfterResume, 'resume re-INVITE negotiated direction').toBe('sendrecv');
  expect(result.rtpAfterResume?.bytesReceived ?? 0, 'peer inbound RTP grew after resume').toBeGreaterThan(
    result.rtpBeforeResume?.bytesReceived ?? 0,
  );
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

test('real DTMF: telephone-event negotiated both ways, canInsertDTMF, tone buffer drains', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'controls',
    controls: { dtmf: true },
    freqA: 523,
    freqB: 220,
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.callState, 'call established').toBe('established');
  expect(result.telephoneEventInLibraryOffer, 'library offered telephone-event').toEqual(true);
  expect(result.telephoneEventInPeerAnswer, 'peer answered telephone-event').toEqual(true);
  expect(result.dtmfCanInsertLibrary, 'library can insert DTMF').toEqual(true);
  expect(result.dtmfCanInsertPeer, 'peer can insert DTMF').toEqual(true);
  expect(result.dtmfToneChanges?.at(-1), 'tone buffer drained to empty').toBe('');
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

// ---------------------------------------------------------------------------
// Accept / reject / cancel
// ---------------------------------------------------------------------------

test('incoming call answer establishes and remote BYE terminates', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'controls',
    incoming: 'accept',
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.connectionState, 'phone connected').toBe('connected');
  expect(result.callState, 'call accepted then terminated by remote BYE').toBe('terminated');
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

test('incoming call reject fails the call', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'controls',
    incoming: 'reject',
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.connectionState, 'phone connected').toBe('connected');
  expect(result.callState, 'rejected call is failed').toBe('failed');
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

test('outgoing call cancel terminates the establishing call', async ({ page }) => {
  await gotoPhone(page);
  const result = await runPhoneScenario(page, {
    scenario: 'controls',
    outgoingCancel: true,
  });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.callState, 'cancelled call is terminated').toBe('terminated');
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

// ---------------------------------------------------------------------------
// Forced TURN relay (static + refreshed credentials)
// ---------------------------------------------------------------------------

test('forced TURN relay: static config selects relay/relay and never discloses credentials', async ({ page }) => {
  requireTurnVars();
  await gotoPhone(page);

  const turn: TurnOpts = {
    mode: 'static',
    host: TURN_HOST,
    peerHost: TURN_PEER_HOST,
    port: TURN_PORT,
    username: TURN_USERNAME,
    password: TURN_PASSWORD,
  };
  const result = await runPhoneScenario(page, { scenario: 'turn', turn });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.callState, 'call established over relay').toBe('established');
  expect(result.peerRtpGrew, 'peer received real RTP over relay').toEqual(true);
  expect(result.librarySelectedTypes?.local, 'library selected LOCAL relay candidate').toBe('relay');
  expect(result.librarySelectedTypes?.remote, 'library selected REMOTE relay candidate').toBe('relay');
  expect(result.peerSelectedTypes?.local, 'peer selected LOCAL relay candidate').toBe('relay');
  expect(result.peerSelectedTypes?.remote, 'peer selected REMOTE relay candidate').toBe('relay');
  expect(result.gatheredCandidateTypes?.library ?? [], 'library gathered a relay candidate').toContain('relay');
  expect(result.gatheredCandidateTypes?.peer ?? [], 'peer gathered a relay candidate').toContain('relay');
  expect(result.providerCalls, 'static config uses no provider').toBe(0);
  expect(result.credentialDisclosed, 'credentials never appear in the result').toBe(false);
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});

test('forced TURN relay: refreshed provider retains relay/relay across an ICE restart', async ({ page }) => {
  requireTurnVars();
  await gotoPhone(page);

  const turn: TurnOpts = {
    mode: 'refresh',
    host: TURN_HOST,
    peerHost: TURN_PEER_HOST,
    port: TURN_PORT,
    username: TURN_USERNAME,
    password: TURN_PASSWORD,
  };
  const result = await runPhoneScenario(page, { scenario: 'turn', turn });

  expect(result.error, 'scenario page error').toBeUndefined();
  expect(result.callState, 'call established over relay').toBe('established');
  expect(result.providerCalls ?? 0, 'provider re-queried on the ICE restart').toBeGreaterThanOrEqual(2);
  expect(result.iceRestartRecorded, 'server saw the ICE-restart re-INVITE').toEqual(true);
  expect(result.peerRtpGrewAfterRestart, 'peer RTP resumed after the restart').toEqual(true);
  expect(result.librarySelectedTypesAfterRestart?.local, 'library LOCAL stays relay after restart').toBe('relay');
  expect(result.librarySelectedTypesAfterRestart?.remote, 'library REMOTE stays relay after restart').toBe('relay');
  expect(result.peerSelectedTypesAfterRestart?.local, 'peer LOCAL stays relay after restart').toBe('relay');
  expect(result.peerSelectedTypesAfterRestart?.remote, 'peer REMOTE stays relay after restart').toBe('relay');
  expect(result.credentialDisclosed, 'credentials never appear in the result').toBe(false);
  expect(result.resourcesAfterCycle, 'zero owned resources after dispose').toEqual(zeroResources);
});
