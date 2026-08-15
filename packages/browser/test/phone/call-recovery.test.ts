/**
 * Established-call signaling recovery orchestration tests (v0.7 Task 13).
 *
 * After unexpected transport loss the phone runs reconnect + registration
 * recovery and then a per-established-call decision branch: when media is
 * healthy and the network did not change it validates the dialog in-band
 * (OPTIONS), otherwise it refreshes ICE servers and performs one serialized
 * ICE-restart re-INVITE. Successful settlement returns the call to `stable`;
 * a definitive dialog loss (481), any other final failure, a recovery timeout,
 * exhausted reconnection, or failed registration recovery terminates the call
 * with SIGNALING_RECOVERY_FAILED and signaling `lost`. Unconfirmed calls fail
 * immediately on transport loss (no recovery branch). These tests drive the
 * branch on the phone harness's deterministic fakes.
 */
import { describe, expect, it } from 'vitest';
import { STUB_SDP } from '@sip-worker/core';
import type { OutgoingBrowserCall } from '../../src/phone/browser-call.js';
import type { IceServerProvider } from '../../src/media/types.js';
import { DTMF_TELEPHONE_EVENT_SDP } from '../support/fake-media-environment.js';
import {
  buildPhone,
  established,
  restoreAndRegister,
  dropAndRestore,
  answerInDialogOptions,
  answerReinvite,
  waitForPhoneRecovery,
  flush,
  settle,
  sentRequests,
  emitRemoteBye,
  emitRemoteReinvite,
  emitReinviteAck,
  makeAudioStream,
  type PhoneHarness,
} from '../support/phone-harness.js';

/** A phone configured for bounded reconnection (100 ms recovery deadline). */
function buildRecoveringPhone(overrides: {
  autoRespondRegister?: boolean;
  media?: { iceServerProvider?: IceServerProvider };
} = {}): PhoneHarness {
  return buildPhone({ reconnect: {}, ...overrides });
}

/** Connect + register against the fake server. */
async function registered(h: PhoneHarness): Promise<void> {
  await h.phone.connect();
  await h.phone.register();
  expect(h.phone.connectionState).toBe('connected');
  expect(h.phone.registrationState).toBe('registered');
}

/** Collect `{ previous, state }` signaling-state transitions on a call. */
function signalingHistory(
  call: { on(event: 'signalingStateChanged', listener: (e: { previous: string; state: string }) => void): void },
): Array<{ previous: string; state: string }> {
  const history: Array<{ previous: string; state: string }> = [];
  call.on('signalingStateChanged', (e) => history.push({ previous: e.previous, state: e.state }));
  return history;
}

type FakeSender = {
  dtmf: { tonechangeListenerCount: number };
};

describe('BrowserCall — established-call recovery', () => {
  it('recovers an established call via in-dialog validation when signaling is lost but media is healthy', async () => {
    const providerCalls: number[] = [];
    const provider: IceServerProvider = async () => {
      providerCalls.push(1);
      return [{ urls: 'turn:relay.test' }];
    };
    const h = buildRecoveringPhone({ media: { iceServerProvider: provider } });
    await registered(h);
    const call = await established(h);
    expect(call.state).toBe('established');
    // One fetch happened for the new-session offer; the validateDialog branch
    // must NOT refresh ICE servers.
    expect(providerCalls).toHaveLength(1);

    const signaling = signalingHistory(call);
    h.server.dropSocket(1006);
    expect(call.signalingState).toBe('recovering');
    expect(h.pc.closed).toBe(false);

    await restoreAndRegister();
    expect(sentRequests('OPTIONS').length).toBeGreaterThan(0);
    answerInDialogOptions(200);
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('stable');
    expect(call.state).toBe('established');
    expect(h.phone.activeCall).toBe(call);
    expect(h.pc.restartIceCalls).toHaveLength(0);
    expect(providerCalls).toHaveLength(1);
    expect(signaling).toContainEqual({ previous: 'stable', state: 'recovering' });
    expect(signaling).toContainEqual({ previous: 'recovering', state: 'stable' });

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('recovers via in-dialog validation on a 405/501 OPTIONS final', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    h.server.dropSocket(1006);
    await restoreAndRegister();
    answerInDialogOptions(405);
    await waitForPhoneRecovery();
    expect(call.signalingState).toBe('stable');
    expect(call.state).toBe('established');
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('fails an established call with SIGNALING_RECOVERY_FAILED on a 408 validation final', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    const failed: Error[] = [];
    call.on('failed', (e) => failed.push(e.error));
    const signaling = signalingHistory(call);

    h.server.dropSocket(1006);
    expect(call.signalingState).toBe('recovering');
    await restoreAndRegister();
    answerInDialogOptions(408);
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('lost');
    expect(call.state).toBe('failed');
    expect(failed[0]).toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
    expect(signaling).toContainEqual({ previous: 'recovering', state: 'lost' });
    expect(h.pc.closed).toBe(true);

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('fails an established call with SIGNALING_RECOVERY_FAILED on a 481 validation final', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    const failed: Error[] = [];
    call.on('failed', (e) => failed.push(e.error));

    h.server.dropSocket(1006);
    await restoreAndRegister();
    answerInDialogOptions(481);
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('lost');
    expect(call.state).toBe('failed');
    expect(failed[0]).toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('fails an established call with SIGNALING_RECOVERY_FAILED when the OPTIONS fast path hits the recovery deadline', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    const failed: Error[] = [];
    call.on('failed', (e) => failed.push(e.error));

    h.server.dropSocket(1006);
    await restoreAndRegister();
    // Leave the OPTIONS unanswered. The recovery deadline (100 ms) is SHORTER
    // than the non-INVITE client timer F (64*T1 ≈ 32 s), so the ENTIRE branch —
    // the OPTIONS fast path included — is bounded by recoveryTimeoutMs.
    h.clock.advance(100);
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('lost');
    expect(call.state).toBe('failed');
    expect(failed[0]).toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('runs the ICE-restart branch when media is disconnected, refreshing servers and re-INVITE', async () => {
    const providerCalls: number[] = [];
    const provider: IceServerProvider = async () => {
      providerCalls.push(1);
      return [{ urls: 'turn:relay.test' }];
    };
    const h = buildRecoveringPhone({ media: { iceServerProvider: provider } });
    await registered(h);
    const call = await established(h);
    expect(providerCalls).toHaveLength(1);

    h.pc._setIceConnection('disconnected');
    await dropAndRestore();
    // The restart branch refreshed the provider and put a re-INVITE on the wire.
    expect(providerCalls).toHaveLength(2);
    expect(sentRequests('OPTIONS')).toHaveLength(0);
    answerReinvite(200, STUB_SDP);
    await flush();
    h.pc._setIceConnection('connected');
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('stable');
    expect(call.state).toBe('established');
    expect(h.pc.restartIceCalls).toHaveLength(1);

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('does NOT invoke the provider when answering a remote re-INVITE on an existing session', async () => {
    const providerCalls: number[] = [];
    const provider: IceServerProvider = async () => {
      providerCalls.push(1);
      return [{ urls: 'turn:relay.test' }];
    };
    const h = buildRecoveringPhone({ media: { iceServerProvider: provider } });
    await registered(h);
    const call = await established(h);
    // One fetch happened for the new-session offer.
    expect(providerCalls).toHaveLength(1);

    // Remote hold: an in-dialog re-INVITE answered via createAnswer on the
    // EXISTING session. The provider must NOT be invoked (a transient provider
    // rejection would fail the live negotiation and reclaim the media session).
    h.env.queuedUserMedia.push(makeAudioStream()); // createAnswer re-acquires a mic track
    emitRemoteReinvite('sendonly', 2);
    await settle();
    emitReinviteAck(2);
    await settle();

    expect(call.state).toBe('established');
    expect(call.holdState).toEqual({ local: false, remote: true });
    expect(providerCalls).toHaveLength(1);

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('fails an established call when the ICE-restart re-INVITE is rejected', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    const failed: Error[] = [];
    call.on('failed', (e) => failed.push(e.error));

    h.pc._setIceConnection('disconnected');
    await dropAndRestore();
    answerReinvite(500, STUB_SDP);
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('lost');
    expect(call.state).toBe('failed');
    expect(failed[0]).toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('fails an established call when the ICE-restart branch hits the recovery deadline', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    const failed: Error[] = [];
    call.on('failed', (e) => failed.push(e.error));

    // Drive media to `checking` so the session leaves `connected` and the
    // post-restart waitForConnected actually waits.
    h.pc._setIceConnection('checking');
    await dropAndRestore();
    answerReinvite(200, STUB_SDP);
    await flush();
    h.clock.advance(100); // recoveryTimeoutMs trips the waitForConnected deadline
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('lost');
    expect(call.state).toBe('failed');
    expect(failed[0]).toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('fails established calls with SIGNALING_RECOVERY_FAILED when registration recovery fails', async () => {
    const h = buildRecoveringPhone({ autoRespondRegister: false });
    // Establish the initial registration with auto-respond on, then disable it
    // so the recovered REGISTER can be answered with a terminal failure.
    h.server.autoRespondRegister = true;
    await registered(h);
    const call = await established(h);
    const failed: Error[] = [];
    call.on('failed', (e) => failed.push(e.error));

    h.server.autoRespondRegister = false;
    h.server.dropSocket(1006);
    expect(call.signalingState).toBe('recovering');
    await restoreAndRegister();
    // The recovered REGISTER is on the wire; answer it with a definitive 403.
    h.server.answerRegister(403);
    await waitForPhoneRecovery();

    expect(call.state).toBe('failed');
    expect(call.signalingState).toBe('lost');
    expect(failed[0]).toMatchObject({ code: 'SIGNALING_RECOVERY_FAILED' });
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('fails an unconfirmed call immediately on transport loss without a recovery branch', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = h.phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    // The transport-drop rejection fires before the assertion attaches; mark the
    // promise handled now (the `rejects` assertion below still observes the code).
    start.catch(() => {});
    await settle(); // the INVITE is on the wire (or mid offer acquisition)

    h.server.dropSocket(1006);
    await waitForPhoneRecovery();

    await expect(start).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(call.state).toBe('failed');
    // An unconfirmed call never entered the established-call recovery branch.
    expect(call.signalingState).toBe('stable');
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('a remote BYE during recovery terminates the call without resurrecting it', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    h.server.dropSocket(1006);
    await restoreAndRegister(); // validation OPTIONS in flight on the recovered socket

    emitRemoteBye();
    await waitForPhoneRecovery();

    expect(call.state).toBe('terminated');
    expect(call.signalingState).toBe('recovering'); // recovery aborted, never 'stable'
    expect(h.phone.connectionState).toBe('connected');
    expect(h.phone.registrationState).toBe('registered');
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('a network change observed during recovery forces the ICE-restart branch', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h);
    expect(h.pc.iceConnectionState).toBe('connected');

    h.server.dropSocket(1006);
    expect(call.signalingState).toBe('recovering');
    // The host went offline during recovery: the phone must treat the network as
    // changed even though media reports connected.
    h.lifecycle.setOnline(false);
    h.lifecycle.setOnline(true);
    await restoreAndRegister();

    expect(sentRequests('OPTIONS')).toHaveLength(0);
    answerReinvite(200, STUB_SDP);
    await flush();
    h.pc._setIceConnection('connected');
    await waitForPhoneRecovery();

    expect(call.signalingState).toBe('stable');
    expect(call.state).toBe('established');
    expect(h.pc.restartIceCalls).toHaveLength(1);
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('C13: recovery failure terminates the call and settles an in-flight DTMF op with ABORTED exactly once', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const call = await established(h, DTMF_TELEPHONE_EVENT_SDP);
    const dtmfOp = call.sendDtmf('123');
    // The recovery-failure teardown settles the DTMF op before the assertion
    // attaches; mark the promise handled now (the `rejects` assertion below
    // still observes ABORTED exactly once).
    dtmfOp.catch(() => {});
    await flush();
    const sender = h.pc.transceivers[0]!.sender as unknown as FakeSender;
    expect(sender.dtmf.tonechangeListenerCount).toBe(1);

    h.server.dropSocket(1006);
    expect(call.signalingState).toBe('recovering');
    await restoreAndRegister();
    answerInDialogOptions(408); // definitive dialog loss
    await waitForPhoneRecovery();

    expect(call.state).toBe('failed');
    expect(call.signalingState).toBe('lost');
    await expect(dtmfOp).rejects.toMatchObject({ code: 'ABORTED' });
    expect(sender.dtmf.tonechangeListenerCount).toBe(0);
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('rejects supplying both static iceServers and an iceServerProvider at phone construction', () => {
    expect(() => buildPhone({
      media: {
        iceServers: [{ urls: 'stun:static.test' }],
        iceServerProvider: async () => [],
      },
    })).toThrow(/mutually exclusive/);
  });
});
