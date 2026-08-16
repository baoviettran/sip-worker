import type { Page } from '@playwright/test';

/**
 * Node-side harness for the browser-phone gate (Task 16).
 *
 * The heavy lifting (real BrowserPhone + real RTCPeerConnection media, SIP
 * signaling, controls, recovery, resource snapshots) happens INSIDE the page
 * against the BUILT/PACKED bundle, exposed through `window.__runPhoneScenario`
 * and `window.__runClockProbe`. This module runs in the Playwright Node process,
 * drives that bridge, and asserts on the returned plain-data result. It never
 * constructs a fake PC and never skips a capability.
 */

export const PHONE_HARNESS_URL = 'http://127.0.0.1:4300/index.html';
export const PHONE_CONTROL = 'http://127.0.0.1:4300/control';

/**
 * The exact zero-owned-resources baseline after `phone.dispose()`: every one of
 * the 11 ResourceSnapshot counters is 0.
 */
export const zeroResources = {
  activeSocketGenerations: 0,
  reconnectAttempts: 0,
  reconnectTimers: 0,
  activeCalls: 0,
  activeNegotiations: 0,
  pendingOperations: 0,
  timers: 0,
  peerConnections: 0,
  localTracks: 0,
  lifecycleListeners: 0,
  deviceListeners: 0,
};

/**
 * The baseline for a live-but-idle phone at the end of a cycle (before
 * dispose): every counter is 0 except the phone's own offline subscription
 * (lifecycleListeners: 1) and the media manager's devicechange listener
 * (deviceListeners: 1).
 */
export const idleBaseline = {
  activeSocketGenerations: 0,
  reconnectAttempts: 0,
  reconnectTimers: 0,
  activeCalls: 0,
  activeNegotiations: 0,
  pendingOperations: 0,
  timers: 0,
  peerConnections: 0,
  localTracks: 0,
  lifecycleListeners: 1,
  deviceListeners: 1,
};

export interface Snapshot {
  activeSocketGenerations: number;
  reconnectAttempts: number;
  reconnectTimers: number;
  activeCalls: number;
  activeNegotiations: number;
  pendingOperations: number;
  timers: number;
  peerConnections: number;
  localTracks: number;
  lifecycleListeners: number;
  deviceListeners: number;
}

export interface InboundAudio {
  bytesReceived: number;
  packets: number;
}

export interface TurnOpts {
  mode: 'static' | 'refresh';
  host: string;
  peerHost: string;
  port: number;
  username: string;
  password: string;
}

export interface PhoneScenarioOpts {
  scenario?: 'controls' | 'recovery' | 'lifecycle' | 'turn';
  controls?: { mute?: boolean; hold?: boolean; dtmf?: boolean };
  recovery?: { mode?: 'fast' | 'ice-restart' | 'exhausted' };
  turn?: TurnOpts;
  incoming?: 'accept' | 'reject' | 'none';
  outgoingCancel?: boolean;
  cycleIndex?: number;
  freqA?: number;
  freqB?: number;
  target?: string;
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
    recoveryTimeoutMs?: number;
  };
}

export interface PhoneScenarioResult {
  cycleIndex: number;
  scenario: string;
  error?: { name: string; message: string };
  connectionState?: string;
  registrationState?: string;
  callState?: string;
  signalingState?: string;
  connectionStateAfterDispose?: string;

  // controls
  outboundAudioAfterMute?: number;
  mutedThreshold?: number;
  outboundAudioAfterUnmute?: number;
  activeThreshold?: number;
  holdOfferDirection?: string | null;
  holdDirectionAfterResume?: string | null;
  rtpEstablished?: number;
  rtpBeforeResume?: InboundAudio;
  rtpAfterResume?: InboundAudio;
  peerConnectionStateBeforeResume?: string;
  peerIceStateBeforeResume?: string;
  peerConnectionStateAfterResume?: string;
  peerIceStateAfterResume?: string;
  dtmfToneChanges?: string[];
  dtmfCanInsertLibrary?: boolean;
  dtmfCanInsertPeer?: boolean;
  telephoneEventInLibraryOffer?: boolean;
  telephoneEventInPeerAnswer?: boolean;

  // recovery
  callIdBeforeRecovery?: string | null;
  callIdAfterRecovery?: string | null;
  registerCallIds?: string[];
  registerCSeqs?: number[];
  iceRestartRecorded?: boolean;
  iceRestarts?: Array<{ callId: string; cseq: number; direction: string; iceRestart: boolean }>;
  inDialogOptionsCount?: number;
  rtpResumedAfterRecovery?: boolean;

  // turn
  providerCalls?: number;
  credentialDisclosed?: boolean;
  peerRtpGrew?: boolean;
  peerRtpGrewAfterRestart?: boolean;
  librarySelectedTypes?: { local: string | null; remote: string | null };
  peerSelectedTypes?: { local: string | null; remote: string | null };
  librarySelectedTypesAfterRestart?: { local: string | null; remote: string | null };
  peerSelectedTypesAfterRestart?: { local: string | null; remote: string | null };
  gatheredCandidateTypes?: { library: string[]; peer: string[] };

  // lifecycle
  resourcesBeforeDispose?: Snapshot;
  resourcesAfterCycle?: Snapshot;

  // clock probe
  optionsCount?: number;
  uncaughtErrors?: string[];
}

async function ensureBooted(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __phoneRun?: { booted?: boolean } }).__phoneRun?.booted === true,
    undefined,
    { timeout: timeoutMs },
  );
}

async function runPhoneScenario(page: Page, opts: PhoneScenarioOpts): Promise<PhoneScenarioResult> {
  return (await page.evaluate(
    (o) => (window as unknown as { __runPhoneScenario: (opts: PhoneScenarioOpts) => Promise<PhoneScenarioResult> })
      .__runPhoneScenario(o),
    opts,
  )) as PhoneScenarioResult;
}

async function runClockProbe(page: Page): Promise<PhoneScenarioResult> {
  return (await page.evaluate(() =>
    (window as unknown as { __runClockProbe: () => Promise<PhoneScenarioResult> }).__runClockProbe(),
  )) as PhoneScenarioResult;
}

/** Poll the page bridge until zero open PCs / page errors (post-everything). */
async function waitZeroPhoneResources(page: Page, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await page.evaluate(() =>
      (window as unknown as {
        __phoneRun?: { resourceState?: () => { openPcs: number; errors: number } };
      }).__phoneRun?.resourceState?.(),
    );
    if (state && state.openPcs === 0) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(150);
  }
}

export { ensureBooted, runPhoneScenario, runClockProbe, waitZeroPhoneResources };
