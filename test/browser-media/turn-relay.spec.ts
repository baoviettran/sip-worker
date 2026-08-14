import { test, expect } from '@playwright/test';
import { ensureBooted, waitZeroResources } from './harness';
import type { CallCycleResult } from './harness';

/**
 * Forced-TURN relay gate (v0.5). Provisions a pinned coturn on a CI-local port,
 * hands BOTH ends of the call ephemeral CI-generated credentials, and forces
 * `iceTransportPolicy: 'relay'` on the library's PC AND the synthetic peer's PC.
 * The selected local/remote candidate types must resolve to `relay` and real RTP
 * audio must flow in BOTH directions on every engine — "merely verifying config
 * propagation" is not enough: relay must be the WORKING transport.
 *
 * This gate NEVER skips. If the TURN variables are missing (the coturn service is
 * not provisioned), the test FAILS before any browser is launched, so an absent
 * relay backend cannot produce a false pass on a collapsed direct call.
 */

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
// The peer may use a distinct TURN host so same-server relay allocations get
// distinct relay addresses. It defaults to the library's TURN host.
const TURN_PEER_HOST = turnHost(process.env.TURN_PEER_URL, TURN_HOST);
const TURN_PORT = Number(process.env.TURN_PORT ?? '3478');
const TURN_USERNAME = process.env.TURN_USERNAME ?? '';
const TURN_PASSWORD = process.env.TURN_PASSWORD ?? '';

function requireTurnVars(): void {
  const missing: Array<string> = [];
  if (!TURN_PORT) missing.push('TURN_PORT');
  if (!TURN_USERNAME) missing.push('TURN_USERNAME');
  if (!TURN_PASSWORD) missing.push('TURN_PASSWORD');
  // Missing TURN variables MUST fail the gate before any browser is launched so
  // an unprovisioned relay backend can never masquerade as a passing run.
  expect(
    missing,
    `TURN relay gate requires provisioned coturn credentials. Missing: ${missing.join(', ') || '(none)'}`,
  ).toEqual([]);
}

test('forced TURN relay: selected relay candidates + two-way real audio', async ({ page }) => {
  requireTurnVars();

  await page.goto('/index.html');
  await ensureBooted(page);

  const relay = { port: TURN_PORT, username: TURN_USERNAME, credential: TURN_PASSWORD, host: TURN_HOST, peerHost: TURN_PEER_HOST };

  const result = (await page.evaluate(
    ({ relay }) =>
      (window as unknown as {
        __runCallCycle: (o: { scenario: string; freqA: number; freqB: number; cycleIndex: number; relay: { port: number; username: string; credential: string; host: string; peerHost: string } })
          => Promise<CallCycleResult>;
      }).__runCallCycle({ scenario: 'relay', freqA: 440, freqB: 880, cycleIndex: 0, relay }),
    { relay },
  )) as CallCycleResult;

  // No page-side error. The synthetic peer gathers with relay-only transport, so
  // a genuinely unreachable relay collapses to an unreachable/limited call and
  // the connection never reaches 'connected' below.
  expect(result.error, 'call cycle failed').toBeUndefined();

  // Both PCs must reach connected over the RELAY. With a working, reachable relay
  // service both ends gather a relay candidate and the call connects through it.
  expect(result.libraryConnState, 'library pc connected over relay').toEqual('connected');
  expect(result.peerConnState, 'peer pc connected over relay').toEqual('connected');
  expect(result.libraryIceState, 'library ice connected/completed').toMatch(/connected|completed/);
  expect(result.peerIceState, 'peer ice connected/completed').toMatch(/connected|completed/);

  // Real bidirectional RTP: packet AND byte counters strictly increase BOTH ways.
  expect(result.libraryMedia?.ok, 'library outbound+inbound RTP grew over relay').toEqual(true);
  expect(result.peerMedia?.ok, 'peer outbound+inbound RTP grew over relay').toEqual(true);
  expect(result.libraryMedia?.outbound.packets ?? 0).toBeGreaterThan(0);
  expect(result.libraryMedia?.inbound.packets ?? 0).toBeGreaterThan(0);
  expect(result.peerMedia?.outbound.packets ?? 0).toBeGreaterThan(0);
  expect(result.peerMedia?.inbound.packets ?? 0).toBeGreaterThan(0);

  // Remote audio received in BOTH directions.
  expect(result.peerRemoteTracks, 'peer received library audio track').toBeGreaterThan(0);
  expect(result.libraryRemoteTracks, 'library received peer audio track').toBeGreaterThan(0);

  // RTP growth above is the load-bearing real-audio proof. Energy analysis is
  // additionally required on both sides, with Chromium headless allowed only its
  // explicit, established null-sink admission (never silent success by omission).
  for (const [label, energy] of [['library', result.libraryEnergy], ['peer', result.peerEnergy]] as const) {
    expect(energy, `${label} audio energy was measured over relay`).toBeDefined();
    expect(
      energy!.ok === true || energy!.reason === 'null-audio-decode-sink',
      `${label} measured energy or reported the approved Chromium null sink`,
    ).toEqual(true);
  }

  // THE load-bearing assertion: the SELECTED candidate pair uses relay candidates
  // on BOTH ends. forced `iceTransportPolicy:'relay'` must actually select the
  // relay, never collapse to a direct host-host or srflx path.
  expect(result.librarySelectedTypes?.local, 'library selected LOCAL candidate is relay').toEqual('relay');
  expect(result.librarySelectedTypes?.remote, 'library selected REMOTE candidate is relay').toEqual('relay');
  expect(result.peerSelectedTypes?.local, 'peer selected LOCAL candidate is relay').toEqual('relay');
  expect(result.peerSelectedTypes?.remote, 'peer selected REMOTE candidate is relay').toEqual('relay');

  // Every engine must also have GATHERED a relay candidate on both sides (the raw
  // onicecandidate capture; contrast this with the selected pair asserted above).
  expect(result.gatheredCandidateTypes?.library ?? [], 'library gathered a relay candidate').toContain('relay');
  expect(result.gatheredCandidateTypes?.peer ?? [], 'peer gathered a relay candidate').toContain('relay');

  // Cleanup: relayed resources fully reclaimed after close.
  expect(await waitZeroResources(page), 'resources returned to zero after close').toEqual(true);
});
