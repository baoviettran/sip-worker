/**
 * Node-side harness for the v0.5 real-browser WebRTC audio gate.
 *
 * The heavy lifting (real RTCPeerConnection negotiation, real RTP flow, RTP
 * getStats, real cleanup) happens INSIDE the page against the BUILT/PACKED
 * bundle, exposed through `window.__runCallCycle`. This module runs in the
 * Playwright Node process, drives that bridge, and asserts on the returned
 * plain-data result. It never constructs a fake PC and never skips a
 * capability.
 */
import type { Page } from '@playwright/test';

/** Plain-data result of one page-side call cycle. */
export interface Energy {
  ok: boolean;
  peak: number;
  reason?: string;
}
export interface SelectedTypes {
  local: string | null;
  remote: string | null;
}
export interface CallCycleResult {
  cycleIndex: number;
  scenario: 'direct' | 'stun';
  error?: { name: string; message: string };
  libraryMedia?: { ok: boolean; inbound: { packets: number; bytes: number }; outbound: { packets: number; bytes: number } };
  peerMedia?: { ok: boolean; inbound: { packets: number; bytes: number }; outbound: { packets: number; bytes: number } };
  peerRemoteTracks?: number;
  libraryRemoteTracks?: number;
  libraryEnergy?: Energy;
  peerEnergy?: Energy;
  librarySelectedTypes?: SelectedTypes;
  peerSelectedTypes?: SelectedTypes;
  libraryIceState?: string;
  libraryConnState?: string;
  peerIceState?: string;
  peerConnState?: string;
  timersBefore?: number;
  listenersBefore?: number;
  timersAfter?: number;
  listenersAfter?: number;
  pcsAfter?: number;
}

export interface RunCallCycleOpts {
  scenario?: 'direct' | 'stun';
  freqA?: number;
  freqB?: number;
  /** Set automatically by runCycles; optional for single-cycle callers. */
  cycleIndex?: number;
}

/** Serve-missing guard: the page must not be reachable before it boots. */
async function ensureBooted(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __webRtcMediaRun?: { booted?: boolean } }).__webRtcMediaRun?.booted === true,
    undefined,
    { timeout: 30_000 },
  );
}

/** Run N consecutive call cycles in the page, returning their results in order. */
export async function runCycles(
  page: Page,
  count: number,
  opts: RunCallCycleOpts,
): Promise<CallCycleResult[]> {
  const results: CallCycleResult[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = (await page.evaluate(
      (o: { scenario: string; freqA: number; freqB: number; cycleIndex: number }) =>
        (window as unknown as {
          __runCallCycle: (o: { scenario: string; freqA: number; freqB: number; cycleIndex: number })
            => Promise<CallCycleResult>;
        }).__runCallCycle(o),
      { scenario: opts.scenario, freqA: opts.freqA ?? 440, freqB: opts.freqB ?? 880, cycleIndex: i },
    )) as CallCycleResult;
    results.push(r);
  }
  return results;
}

/** Wait until the page has zero open PCs / timers / listeners across the whole bridge. */
export async function waitZeroResources(page: Page, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await page.evaluate(() =>
      (window as unknown as {
        __webRtcMediaRun?: { resourceState?: () => { openPcs: number; timers: number; listeners: number } };
      }).__webRtcMediaRun?.resourceState?.(),
    );
    if (state && state.openPcs === 0 && state.timers === 0 && state.listeners === 0) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(150);
  }
}

export { ensureBooted };