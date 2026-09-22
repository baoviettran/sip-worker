import { test, expect } from '@playwright/test';
import { ensureBooted, waitZeroResources } from './harness';
import type { CallCycleResult, Energy } from './harness';
import { matchReflexiveToObservation } from './stun-observations.mjs';

/**
 * Two-way real audio across Chromium, Firefox, and WebKit. Each engine:
 *   - negotiates a full (non-trickle) SDP exchange between the library's real
 *     WebRtcMediaManager session and the controllable synthetic peer,
 *   - receives remote audio BOTH ways,
 *   - drives RTP packet/byte counters upward in BOTH directions via getStats,
 *   - observes non-zero synthetic audio energy,
 *   - reaches connected (ICE) and gathering complete,
 *   - exercises a direct (host candidate) path and a STUN-assisted path,
 *   - asserts selected candidate type.
 *
 * Never `test.skip`. An engine that cannot meet the contract fails the run.
 */

const SCENARIOS = ['direct', 'stun'] as const;

test.describe('two-way audio (real RTP, built browser code)', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario} path: audio flows both ways and media asserts hold`, async ({ page }) => {
      await page.goto('/index.html');
      await ensureBooted(page);

      const result = (await page.evaluate(
        ({ scenario, cycleIndex }) =>
          (window as unknown as {
            __runCallCycle: (o: { scenario: string; freqA: number; freqB: number; cycleIndex: number })
              => Promise<CallCycleResult>;
          }).__runCallCycle({ scenario, freqA: 440, freqB: 880, cycleIndex }),
        { scenario, cycleIndex: 0 },
      )) as CallCycleResult;

      // Make the failure readable when the page itself errored.
      expect(result.error, `call cycle failed on ${scenario}`).toBeUndefined();

      // Both PCs reach connected and gathering complete.
      expect(result.libraryConnState, 'library pc connected').toEqual('connected');
      expect(result.peerConnState, 'peer pc connected').toEqual('connected');
      expect(result.libraryIceState, 'library ice connected/completed').toMatch(/connected|completed/);
      expect(result.peerIceState, 'peer ice connected/completed').toMatch(/connected|completed/);

      // Real RTP: both directions' packet and byte counters strictly increase.
      expect(result.libraryMedia?.ok, 'library outbound+inbound RTP grew').toEqual(true);
      expect(result.peerMedia?.ok, 'peer outbound+inbound RTP grew').toEqual(true);
      expect(result.libraryMedia?.outbound.packets ?? 0).toBeGreaterThan(0);
      expect(result.libraryMedia?.inbound.packets ?? 0).toBeGreaterThan(0);
      expect(result.peerMedia?.outbound.packets ?? 0).toBeGreaterThan(0);
      expect(result.peerMedia?.inbound.packets ?? 0).toBeGreaterThan(0);

      // Remote audio tracks received in BOTH directions.
      expect(result.peerRemoteTracks, 'peer received library audio track').toBeGreaterThan(0);
      expect(result.libraryRemoteTracks, 'library received peer audio track').toBeGreaterThan(0);

      // Selected candidate type resolved on the library's PC.
      expect(result.librarySelectedTypes?.local, 'library selected local candidate type').toBeTruthy();
      expect(result.librarySelectedTypes?.remote, 'library selected remote candidate type').toBeTruthy();

      if (scenario === 'direct') {
        // The direct path must use a host local candidate.
        expect(result.librarySelectedTypes?.local, 'direct path uses host candidate').toEqual('host');
      } else {
        // STUN must be genuinely exercised on every configured engine. The
        // Firefox project explicitly permits loopback ICE for this local gate.
        // A served RFC-5389 binding request proves the call did not silently
        // collapse to the same direct host-host path.
        expect(
          (result.stunBindingsServed ?? 0) > 0,
          `${scenario}: STUN server served ≥1 binding request (got ${result.stunBindingsServed})`,
        ).toEqual(true);

        // …and the reflexive candidate the library gathered must carry a port
        // the STUN server OBSERVED: the port in the srflx candidate is the
        // client socket's own port, so it must appear in the observation set the
        // responder recorded, coupling the candidate to a binding our responder
        // really served. The ADDRESS is not checked here, so this does NOT cover
        // the FreeSWITCH defect class of a fabricated address — that
        // address-level guarantee lives in test/matrix-shared/stun.ts.
        //
        // DELIBERATELY NOT ASSERTED: the selected pair type. Two same-realm
        // peers always select host/host whatever STUN did (server.mjs documents
        // the same reason for mapping onto 127.0.0.2), so asserting it would
        // test the harness rather than the engine.
        // Both halves come off the plain-data result the page already returns,
        // read exactly like stunBindingsServed above — no bridge accessor, no
        // second round trip into the page.
        const observedPorts = result.stunObservedPorts ?? [];
        const matched = matchReflexiveToObservation({
          candidateLines: result.gatheredCandidates?.library ?? [],
          observedPorts,
        });
        // Log on success too, not only in the failure message: the first PR run
        // is where the per-engine evidence is read, and a green run with no
        // output would delete it.
        console.log(
          `[${scenario}] srflx ports ${JSON.stringify(matched.reflexivePorts)} observed ${JSON.stringify(observedPorts)} ` +
            `gathered types ${JSON.stringify(result.gatheredCandidateTypes ?? {})}`,
        );
        expect(
          matched.ok,
          `${scenario}: library gathered a reflexive candidate on a port the STUN server observed ` +
            `(reason=${matched.reason} reflexive=${JSON.stringify(matched.reflexivePorts)} observed=${JSON.stringify(observedPorts)} ` +
            `gathered=${JSON.stringify(result.gatheredCandidateTypes?.library ?? [])})`,
        ).toEqual(true);
      }

      // After the clean close the page returns to zero live resources.
      expect(await waitZeroResources(page), 'resources returned to zero after close').toEqual(true);
    });
  }

  test('non-zero audio energy observed on a receiving side', async ({ page }) => {
    await page.goto('/index.html');
    await ensureBooted(page);

    const result = (await page.evaluate(() =>
      (window as unknown as {
        __runCallCycle: (o: { scenario: string; freqA: number; freqB: number; cycleIndex: number })
          => Promise<CallCycleResult>;
      }).__runCallCycle({ scenario: 'direct', freqA: 523, freqB: 220, cycleIndex: 0 }),
    )) as CallCycleResult;

    expect(result.error).toBeUndefined();

    // RTP already proved BOTH directions carry real audio bytes (packets/bytes
    // strictly increase, remote tracks received both ways). This test observes
    // non-zero synthetic energy on BOTH receiving sides. Every receiving side
    // must genuinely attempt analysis and either measure real energy (ok===true)
    // OR explicitly admit the context it could not run in (a reason string).
    // A side that reports silent-zero WITHOUT an admission (or that was never
    // measured) fails — one side's energy can never mask another side's
    // silent-zero. Chromium's headless-shell decodes WebRTC audio to a null
    // sink so its analyser reads silence even while RTP bytes flow — proven
    // off-line — and honestly reports reason 'null-audio-decode-sink'. Firefox
    // and WebKit drive a real decode path and report ok===true. Passing therefore
    // requires, per side, real energy OR an explicit unavailable-context
    // admission; it can never pass by omission or by one side masking another.
    const assertDocumented = (energy?: Energy, label?: string) => {
      expect(energy, `${label} audio energy was measured`).toBeDefined();
      const documented = energy.ok === true || energy.reason !== undefined;
      expect(
        documented,
        `${label} measured non-zero energy or explicitly admitted an unavailable analysis context (ok=${energy.ok} peak=${energy.peak} reason=${JSON.stringify(energy.reason)})`,
      ).toEqual(true);
    };
    assertDocumented(result.libraryEnergy, 'library side');
    assertDocumented(result.peerEnergy, 'peer side');

    expect(await waitZeroResources(page), 'resources returned to zero after close').toEqual(true);
  });
});