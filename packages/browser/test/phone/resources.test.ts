/**
 * Diagnostics: exact resource accounting and safe records (v0.7 Task 14).
 *
 * The phone exposes a read-only `diagnostics.resources()` snapshot of the
 * resources it currently owns, wired to DIRECT owners (never a test-only
 * mutable registry): the reconnect controller's in-flight attempt generation,
 * the runtime's live call set and pending public operations, the media
 * manager's session/track/device listener ownership, and the phone's own
 * lifecycle subscription. Every counter is a diagnostic assertion, not a
 * control surface.
 *
 * These tests assert that a full connect → register → call → recover → end
 * cycle returns the resource baseline exactly (10 cycles), that disposal
 * during every pending operation drains to zero, that the emitted records
 * never leak credentials/SDP/device/ICE/URI material, and that diagnostic
 * call IDs are opaque and distinct from SIP Call-IDs.
 */
import { describe, expect, it } from 'vitest';
import { FakePeerConnection } from '../support/fake-media-environment.js';
import { DTMF_TELEPHONE_EVENT_SDP } from '../support/fake-media-environment.js';
import type { OutgoingBrowserCall } from '../../src/phone/browser-call.js';
import type { ResourceSnapshot } from '../../src/phone/types.js';
import {
  buildPhone,
  established,
  answerInDialogOptions,
  emitRemoteBye,
  flush,
  makeAudioStream,
  respondOk,
  restoreAndRegister,
  sentRequests,
  settle,
  waitForPhoneRecovery,
  type PhoneHarness,
} from '../support/phone-harness.js';

/** Every resource counter at its resting value after dispose. */
const ZERO_RESOURCES: ResourceSnapshot = Object.freeze({
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
});

/** Push a fresh peer connection + mic stream so the next call uses a NEW pc. */
function freshPeerConnection(h: PhoneHarness): FakePeerConnection {
  const pc = new FakePeerConnection();
  pc.autoCompleteIceGathering = true;
  h.env.queuedPeerConnections.push(pc as unknown as RTCPeerConnection);
  h.env.queuedUserMedia.push(makeAudioStream());
  return pc;
}

/** Establish an outgoing call on the given peer connection (not the harness pc). */
async function establishOutgoingCall(
  h: PhoneHarness,
  pc: FakePeerConnection,
): Promise<OutgoingBrowserCall> {
  const call = h.phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
  const start = call.start();
  await settle();
  respondOk('INVITE', 'server-tag');
  await settle();
  pc._setIceConnection('connected');
  await settle();
  await start;
  return call;
}

/**
 * One full connect → register → call → recover → end cycle. Ends the call with
 * a remote BYE (terminating it cleanly) while the phone stays connected and
 * registered, so the next cycle starts from the same baseline.
 *
 * Cycle 0 reuses the harness's build-time pc (already queued at construction,
 * so the first call's session consumes it); later cycles push a fresh pc that
 * the next call's session consumes.
 */
async function connectRegisterCallRecoverAndEnd(h: PhoneHarness, cycle: number): Promise<void> {
  await h.phone.connect();
  await h.phone.register();
  const pc = cycle === 0 ? h.pc : freshPeerConnection(h);
  await establishOutgoingCall(h, pc);
  h.server.dropSocket(1006);
  await restoreAndRegister();
  answerInDialogOptions(200);
  await waitForPhoneRecovery();
  emitRemoteBye();
  await settle();
}

/** Dispose the phone and assert every resource counter drains to zero. */
async function disposeAndAssertZero(h: PhoneHarness): Promise<void> {
  await h.phone.dispose();
  await settle();
  expect(h.phone.diagnostics.resources()).toEqual(ZERO_RESOURCES);
  expect(h.clock.pendingCount).toBe(0);
}

describe('BrowserPhone diagnostics — exact resource accounting', () => {
  it('restores the resource baseline after every connect-register-call-recover-end cycle', async () => {
    const h = buildPhone({ reconnect: {} });
    const baseline = h.phone.diagnostics.resources();
    for (let i = 0; i < 10; i += 1) {
      await connectRegisterCallRecoverAndEnd(h, i);
      expect(h.phone.diagnostics.resources()).toEqual(baseline);
    }
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('reports lifecycle and device listener counts that drop to zero on dispose', async () => {
    const h = buildPhone();
    expect(h.phone.diagnostics.resources().lifecycleListeners).toBe(1);
    expect(h.phone.diagnostics.resources().deviceListeners).toBe(1);
    await h.phone.connect();
    await h.phone.register();
    await h.phone.dispose();
    await settle();
    expect(h.phone.diagnostics.resources().lifecycleListeners).toBe(0);
    expect(h.phone.diagnostics.resources().deviceListeners).toBe(0);
    expect(h.clock.pendingCount).toBe(0);
  });

  it('dispose during a pending registration settles every pending operation', async () => {
    const h = buildPhone({ autoRespondRegister: false });
    await h.phone.connect();
    const registering = h.phone.register();
    registering.catch(() => {});
    await flush();
    expect(h.phone.diagnostics.resources().pendingOperations).toBe(1);
    await disposeAndAssertZero(h);
  });

  it('dispose during a pending call start settles every pending operation', async () => {
    const h = buildPhone({ reconnect: {} });
    await h.phone.connect();
    await h.phone.register();
    const call = h.phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    start.catch(() => {});
    await settle();
    expect(h.phone.diagnostics.resources().pendingOperations).toBe(1);
    await disposeAndAssertZero(h);
  });

  it('dispose during a pending hold settles every pending operation', async () => {
    const h = buildPhone({ reconnect: {} });
    await h.phone.connect();
    await h.phone.register();
    const call = await established(h);
    const holding = call.hold();
    holding.catch(() => {});
    await settle();
    expect(h.phone.diagnostics.resources().pendingOperations).toBe(1);
    expect(h.phone.diagnostics.resources().activeNegotiations).toBe(1);
    await disposeAndAssertZero(h);
  });

  it('dispose during a pending DTMF sequence settles every pending operation and timer', async () => {
    const h = buildPhone({ reconnect: {} });
    await h.phone.connect();
    await h.phone.register();
    const call = await established(h, DTMF_TELEPHONE_EVENT_SDP);
    const dtmf = call.sendDtmf('123');
    dtmf.catch(() => {});
    await flush();
    expect(h.phone.diagnostics.resources().pendingOperations).toBe(1);
    expect(h.phone.diagnostics.resources().timers).toBe(1);
    await disposeAndAssertZero(h);
  });

  it('dispose during active call recovery settles every pending operation and timer', async () => {
    const h = buildPhone({ reconnect: {} });
    await h.phone.connect();
    await h.phone.register();
    await established(h);
    h.server.dropSocket(1006);
    await restoreAndRegister(); // recovery branch in flight (OPTIONS unanswered)
    expect(h.phone.connectionState).toBe('recovering');
    expect(h.phone.diagnostics.resources().reconnectAttempts).toBe(1);
    await disposeAndAssertZero(h);
  });
});

describe('BrowserPhone diagnostics — safe redacted records', () => {
  it('records hold, resume, DTMF failure, and media failure at their control terminals', async () => {
    const h = buildPhone({ reconnect: {} });
    await h.phone.connect();
    await h.phone.register();
    const call = await established(h);

    const held = call.hold();
    await settle();
    respondOk('INVITE', 'server-tag');
    await settle();
    await held;
    expect(h.records.some((record) => record.code === 'call.hold')).toBe(true);

    const resumed = call.resume();
    await settle();
    respondOk('INVITE', 'server-tag');
    await settle();
    await resumed;
    expect(h.records.some((record) => record.code === 'call.resume')).toBe(true);

    // STUB_SDP has no telephone-event payload: DTMF is unsupported, and the
    // public sendDtmf rejects AND records call.dtmf_failed at the terminal.
    await expect(call.sendDtmf('123')).rejects.toMatchObject({ code: 'DTMF_UNSUPPORTED' });
    expect(h.records.some((record) => record.code === 'call.dtmf_failed')).toBe(true);

    // A terminal media failure on the active call records media.failed.
    h.pc._setIceConnection('failed');
    await settle();
    expect(h.records.some((record) => record.code === 'media.failed')).toBe(true);

    await h.phone.dispose();
  });

  it('emits safe redacted records at control terminals', async () => {
    const h = buildPhone({
      reconnect: {},
      credentials: { username: 'alice-user', password: 'super-secret-password' },
      media: {
        iceServerProvider: async () => [
          { urls: 'turn:relay.test', username: 'turn-user', credential: 'turn-credential-value' },
        ],
      },
    });
    await connectRegisterCallRecoverAndEnd(h, 0);
    // The cycle emitted records at every control terminal; serialize them and
    // prove none of the never-expose material is present.
    const serialized = JSON.stringify(h.records);
    expect(h.records.length).toBeGreaterThan(0);
    for (const needle of [
      'password',
      'super-secret-password',
      'turnCredential',
      'turn-credential-value',
      'sdp',
      'deviceId',
      'candidate',
      'aor',
    ]) {
      expect(serialized).not.toContain(needle);
    }
    await h.phone.dispose();
  });

  it('uses opaque diagnostic call IDs distinct from the SIP Call-IDs', async () => {
    const h = buildPhone({ reconnect: {} });
    await connectRegisterCallRecoverAndEnd(h, 0);
    const sipCallIds = sentRequests('INVITE').map((request) => request.callId);
    expect(sipCallIds.length).toBeGreaterThan(0);
    const recordCallIds = h.records
      .filter((record) => record.callId !== undefined)
      .map((record) => record.callId as string);
    expect(recordCallIds.length).toBeGreaterThan(0);
    for (const callId of recordCallIds) {
      expect(sipCallIds).not.toContain(callId);
    }
    const serialized = JSON.stringify(h.records);
    for (const sipCallId of sipCallIds) {
      expect(serialized).not.toContain(sipCallId);
    }
    await h.phone.dispose();
  });

  it('fault-isolates a throwing diagnostics logger and still captures records', async () => {
    const h = buildPhone({ diagnostics: { logger: () => { throw new Error('sink boom'); } } });
    await h.phone.connect();
    await h.phone.register();
    expect(h.phone.connectionState).toBe('connected');
    expect(h.phone.registrationState).toBe('registered');
    expect(h.records.length).toBeGreaterThan(0);
    await h.phone.dispose();
  });
});
