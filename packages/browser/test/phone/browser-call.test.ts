/**
 * BrowserCall per-call lifecycle tests (v0.7).
 *
 * Direct subtype ownership: outgoing start() observes the core invite, then
 * settles only once the media session reaches `connected`; incoming answer()
 * does the same after ACK. Terminal detach happens before state observers run;
 * a throwing observer never disrupts other observers or the call; remote BYE and
 * shared hangup each make the call terminal; disposal is idempotent.
 */
import { describe, expect, it } from 'vitest';
import {
  Headers,
  STUB_SDP,
  makeResponse,
  serializeMessage,
  withTextBody,
  type SipResponseMessage,
} from '@sip-worker/core';
import {
  OutgoingBrowserCall,
  IncomingBrowserCall,
  type BrowserCallEventMap,
} from '../../src/phone/index.js';
import {
  buildPhone,
  settle,
  flush,
  respondOk,
  answerInviteAndConnectMedia,
  buildIncomingHeaders,
  emitIncoming,
  emitRemoteBye,
  emitRemoteReinvite,
  emitReinviteAck,
  sendAck,
  sentRequests,
  type PhoneHarness,
} from '../support/phone-harness.js';
import type { FakeBrowserWebSocket } from '../support/fake-browser-web-socket.js';
import { DTMF_TELEPHONE_EVENT_SDP } from '../support/fake-media-environment.js';

/** Respond to the most recent outbound re-INVITE (echoing its Via/CSeq). */
function respondToReinvite(
  socket: FakeBrowserWebSocket,
  status: number,
  reason: string,
  sdp?: string,
): void {
  const last = sentRequests('INVITE').at(-1);
  if (last === undefined) throw new Error('no outbound INVITE to answer');
  const headers = new Headers();
  headers.set('Via', last.via);
  headers.set('From', last.from);
  headers.set('To', last.to);
  headers.set('Call-ID', last.callId);
  headers.set('CSeq', last.cseqLine);
  headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
  let response: SipResponseMessage = makeResponse(status, reason, headers);
  if (sdp !== undefined) response = withTextBody(response, sdp, 'application/sdp') as SipResponseMessage;
  socket.emitMessage(serializeMessage(response));
}

/** Establish an outgoing call in the `established` state. */
async function establishedCall(): Promise<{ h: PhoneHarness; call: OutgoingBrowserCall }> {
  const h = buildPhone();
  const { phone } = h;
  await phone.connect();
  const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
  const start = call.start();
  await answerInviteAndConnectMedia();
  await start;
  expect(call.state).toBe('established');
  return { h, call };
}

describe('BrowserCall — per-call lifecycle', () => {
  it('outgoing call stays in establishing until the media session is connected', async () => {
    const { phone, pc } = buildPhone();
    await phone.connect();

    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const states: string[] = [];
    call.on('stateChanged', (event: BrowserCallEventMap['stateChanged']) => {
      states.push(event.state);
    });

    const start = call.start();
    await settle();
    // The core invite is confirmed (2xx+ACK) but media is not yet connected.
    expect(states).not.toContain('established');

    respondOk('INVITE');
    await settle();
    expect(states).not.toContain('established');

    pc._setIceConnection('connected');
    await settle();
    await start;
    expect(call.state).toBe('established');
    await phone.dispose();
  });

  it('isolates a throwing state observer from other observers and the call', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    await phone.register();

    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const alive: string[] = [];
    call.on('stateChanged', () => {
      throw new Error('observer failed');
    });
    call.on('stateChanged', (event: BrowserCallEventMap['stateChanged']) => {
      alive.push(event.state);
    });

    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;
    expect(alive).toContain('established');
    expect(call.state).toBe('established');
    await phone.dispose();
  });

  it('remote BYE makes an established outgoing call terminal (terminated)', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;
    expect(call.state).toBe('established');

    emitRemoteBye();
    await settle();

    expect(call.state).toBe('terminated');
    await phone.dispose();
  });

  it('shared hangup makes an established call terminal and is visible to observers', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;
    expect(call.state).toBe('established');

    const observed: string[] = [];
    call.on('stateChanged', (event: BrowserCallEventMap['stateChanged']) => {
      observed.push(event.state);
    });

    const hangup = call.hangup();
    await flush();
    respondOk('BYE');
    await hangup;
    await settle();

    expect(call.state).toBe('terminated');
    expect(observed).toContain('terminated');

    // After terminal state the phone no longer holds the call as active.
    let busyError: unknown;
    try {
      phone.createCall('sip:carol@example.com');
    } catch (error) {
      busyError = error;
    }
    expect(busyError).toBeUndefined();
    await phone.dispose();
  });

  it('outgoing restartIce() does not leak a discarded rejection', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;
    expect(call.state).toBe('established');

    // The ICE-restart re-INVITE is staged in Task 12 and does not complete in
    // this harness. The finding is the DISCARDED `super.ownerRestartIce()`
    // rejection, which fired as an unhandled rejection every call. Assert that
    // invoking restartIce() on the outgoing call produces no unhandled rejection.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);
    const guarded = call.restartIce().catch(() => {}); // no late reject leaks on dispose
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', handler);

    expect(unhandled).toHaveLength(0);
    void guarded;
    await phone.dispose();
  });

  it('activeCall is undefined when 2+ calls are live', async () => {
    const { phone } = buildPhone();
    await phone.connect();

    // A live incoming call (no caller busy yet) is tracked as the sole owner.
    let incoming: IncomingBrowserCall | undefined;
    phone.on('incomingCall', (event) => {
      incoming = event.call as IncomingBrowserCall;
    });
    emitIncoming(buildIncomingHeaders('<sip:bob@example.com>;tag=bob-tag'));
    await settle();
    expect(incoming).toBeInstanceOf(IncomingBrowserCall);
    expect(phone.activeCall).toBe(incoming);

    // Creating an outgoing call tracks a second owner without starting it (core
    // `createOutgoingCall` only gates `activeInviter`, which an incoming does not
    // set), so two owners are live together.
    phone.createCall('sip:carol@example.com');

    // Exactly-one contract: 2 live calls must NOT pick an arbitrary owner.
    expect(phone.activeCall).toBeUndefined();

    // End the incoming; activeCall narrows to the sole remaining owner.
    await incoming!.reject(486, 'Busy Here').catch(() => {});
    await settle();
    expect(phone.activeCall).toBeInstanceOf(OutgoingBrowserCall);
    await phone.dispose();
  });

  it('incoming answer() settles only after media connected', async () => {
    const { phone, pc } = buildPhone();
    await phone.connect();

    let incoming: IncomingBrowserCall | undefined;
    phone.on('incomingCall', (event) => {
      incoming = event.call as IncomingBrowserCall;
    });
    emitIncoming(buildIncomingHeaders('<sip:bob@example.com>;tag=bob-tag'));
    await settle();
    expect(incoming).toBeInstanceOf(IncomingBrowserCall);
    expect(incoming!.state).toBe('establishing');

    const answer = incoming!.answer();
    await settle();
    sendAck();
    await settle();
    // ACK received (core confirmed) but media not yet connected.
    expect(incoming!.state).not.toBe('established');

    pc._setIceConnection('connected');
    await settle();
    await answer;
    expect(incoming!.state).toBe('established');
    await phone.dispose();
  });

  it('incoming answer before media does not re-emit establishing', async () => {
    const { phone, pc } = buildPhone();
    await phone.connect();

    let incoming: IncomingBrowserCall | undefined;
    const selfTransitions: string[] = [];
    phone.on('incomingCall', (event) => {
      incoming = event.call as IncomingBrowserCall;
      (event.call as IncomingBrowserCall).on('stateChanged', (e) => {
        // A committed transition must always move (or settle the same target
        // exactly once) — a 'establishing' -> 'establishing' re-emission is a
        // spurious self-transition from the confirmed-before-media gate.
        if (e.previous === e.state) selfTransitions.push(e.state);
      });
    });
    emitIncoming(buildIncomingHeaders('<sip:bob@example.com>;tag=bob-tag'));
    await settle();
    expect(incoming).toBeInstanceOf(IncomingBrowserCall);

    const answer = incoming!.answer();
    await settle();
    sendAck();
    await settle();
    // Core confirmed, media still not connected: the media gate must keep
    // 'establishing' WITHOUT re-emitting it (it was committed at attach).
    expect(incoming!.state).toBe('establishing');
    expect(selfTransitions).toEqual([]);

    pc._setIceConnection('connected');
    await settle();
    await answer;
    expect(incoming!.state).toBe('established');
    await phone.dispose();
  });
});

describe('BrowserCall — setMuted (exact microphone mute ownership)', () => {
  it('mutes the local track, emits one immutable mutedChanged, survives replacement, and never touches remote tracks', async () => {
    const h = buildPhone();
    const { phone, pc } = h;
    await phone.connect();
    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;
    expect(call.state).toBe('established');

    const mutedEvents: BrowserCallEventMap['mutedChanged'][] = [];
    call.on('mutedChanged', (event) => { mutedEvents.push(event); });
    const localTrack = pc.transceivers[0]!.sender.track as unknown as { enabled: boolean };
    const remoteTracks = [pc._emitRemoteAudioTrack() as unknown as { enabled: boolean }];
    expect(localTrack.enabled).toBe(true);
    expect(remoteTracks[0]!.enabled).toBe(true);

    call.setMuted(true);
    expect(localTrack.enabled).toBe(false);
    expect(call.muted).toBe(true);
    expect(mutedEvents).toEqual([
      { type: 'mutedChanged', previous: false, muted: true },
    ]);
    call.setMuted(true); // idempotent: no event
    expect(mutedEvents).toHaveLength(1);

    // A replacement microphone must come in muted; remote tracks stay enabled.
    const replacementTrack = { id: 'replacement-mic', enabled: true, stop(): void {} };
    h.env.queuedUserMedia.push({
      getTracks: () => [replacementTrack],
      getAudioTracks: () => [replacementTrack],
    } as unknown as MediaStream);
    await h.manager.replaceActiveMicrophone('mic-2');
    expect((pc.transceivers[0]!.sender.track as unknown as { enabled: boolean }).enabled).toBe(false);
    expect(call.muted).toBe(true); // the call's committed boolean survives the swap
    expect(remoteTracks.every((track) => track.enabled)).toBe(true);
    await phone.dispose();
  });

  it('unmutes the local track and emits previous:true muted:false', async () => {
    const { phone, pc } = buildPhone();
    await phone.connect();
    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;

    const mutedEvents: BrowserCallEventMap['mutedChanged'][] = [];
    call.on('mutedChanged', (event) => { mutedEvents.push(event); });
    const localTrack = pc.transceivers[0]!.sender.track as unknown as { enabled: boolean };
    call.setMuted(true);
    call.setMuted(false);
    expect(localTrack.enabled).toBe(true);
    expect(call.muted).toBe(false);
    expect(mutedEvents).toEqual([
      { type: 'mutedChanged', previous: false, muted: true },
      { type: 'mutedChanged', previous: true, muted: false },
    ]);
    await phone.dispose();
  });

  it('throws canonical INVALID_STATE synchronously on a terminal call', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;
    expect(call.state).toBe('established');

    emitRemoteBye();
    await settle();
    expect(call.state).toBe('terminated');
    expect(() => call.setMuted(true))
      .toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    await phone.dispose();
  });

  it('throws canonical INVALID_STATE synchronously when no media session is active', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    // The call has never negotiated, so the manager owns no media session.
    expect(() => call.setMuted(true))
      .toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    await phone.dispose();
  });
});

describe('BrowserCall — hold/resume', () => {
  it('hold(sendonly) sends a re-INVITE and commits hold state only after media applies', async () => {
    const { h, call } = await establishedCall();
    const { pc, socket } = h;
    const holdEvents: BrowserCallEventMap['holdStateChanged'][] = [];
    call.on('holdStateChanged', (event) => { holdEvents.push(event); });
    const localTrack = pc.transceivers[0]!.sender.track as unknown as { enabled: boolean };
    expect(localTrack.enabled).toBe(true);

    const held = call.hold('sendonly');
    await settle();
    expect(pc.transceivers[0]!.direction).toBe('sendonly');
    expect(call.holdState).toEqual({ local: false, remote: false }); // not yet committed
    const reinvite = sentRequests('INVITE').at(-1)!;
    expect(reinvite.cseqLine).toMatch(/INVITE$/);

    respondToReinvite(socket, 200, 'OK', STUB_SDP);
    await settle();
    await held;
    expect(call.holdState).toEqual({ local: true, remote: false });
    expect(localTrack.enabled).toBe(false);
    expect(holdEvents).toEqual([
      { type: 'holdStateChanged', previous: { local: false, remote: false }, state: { local: true, remote: false } },
    ]);
    await h.phone.dispose();
  });

  it('resume() restores sendrecv and commits hold state only after media applies', async () => {
    const { h, call } = await establishedCall();
    const { pc, socket } = h;
    const held = call.hold('sendonly');
    await settle();
    respondToReinvite(socket, 200, 'OK', STUB_SDP);
    await settle();
    await held;
    expect(call.holdState).toEqual({ local: true, remote: false });

    const resumed = call.resume();
    await settle();
    expect(pc.transceivers[0]!.direction).toBe('sendrecv');
    respondToReinvite(socket, 200, 'OK', STUB_SDP);
    await settle();
    await resumed;
    expect(call.holdState).toEqual({ local: false, remote: false });
    expect((pc.transceivers[0]!.sender.track as unknown as { enabled: boolean }).enabled).toBe(true);
    await h.phone.dispose();
  });

  it('retries exactly once after a 491 with the Call-ID owner window (2100ms default random)', async () => {
    const { h, call } = await establishedCall();
    const { pc, socket, clock } = h;
    const held = call.hold('sendonly');
    await settle();
    const first = sentRequests('INVITE').at(-1)!;
    respondToReinvite(socket, 491, 'Request Pending');
    await settle();

    expect(clock.nextDelay()).toBe(2100);
    expect(call.holdState).toEqual({ local: false, remote: false });
    clock.advance(2100);
    await settle();

    expect(sentRequests('INVITE')).toHaveLength(3); // initial + attempt 1 + retry
    const second = sentRequests('INVITE').at(-1)!;
    expect(second.cseqLine).not.toBe(first.cseqLine);
    respondToReinvite(socket, 200, 'OK', STUB_SDP);
    await settle();
    await held;
    expect(call.holdState).toEqual({ local: true, remote: false });
    expect((pc.transceivers[0]!.sender.track as unknown as { enabled: boolean }).enabled).toBe(false);
    await h.phone.dispose();
  });

  it('preserves a pre-existing mute across hold', async () => {
    const { h, call } = await establishedCall();
    const { pc, socket } = h;
    const localTrack = pc.transceivers[0]!.sender.track as unknown as { enabled: boolean };
    call.setMuted(true);
    expect(localTrack.enabled).toBe(false);

    const held = call.hold();
    await settle();
    respondToReinvite(socket, 200, 'OK', STUB_SDP);
    await settle();
    await held;
    expect(call.holdState).toEqual({ local: true, remote: false });
    expect(localTrack.enabled).toBe(false); // muted AND held
    await h.phone.dispose();
  });

  it('rejects INVALID_STATE on hold/resume of a terminal call', async () => {
    const { h, call } = await establishedCall();
    emitRemoteBye();
    await settle();
    expect(call.state).toBe('terminated');
    await expect(call.hold()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(call.resume()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.phone.dispose();
  });

  it('rejects INVALID_STATE for resume of a non-held call and hold of an already-held call', async () => {
    const { h, call } = await establishedCall();
    await expect(call.resume()).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const held = call.hold();
    await settle();
    respondToReinvite(h.socket, 200, 'OK', STUB_SDP);
    await settle();
    await held;
    expect(call.holdState).toEqual({ local: true, remote: false });
    await expect(call.hold()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.phone.dispose();
  });

  it('freezes hold state at terminal when a remote BYE ends an established held call', async () => {
    const { h, call } = await establishedCall();
    const held = call.hold('sendonly');
    await settle();
    respondToReinvite(h.socket, 200, 'OK', STUB_SDP);
    await settle();
    await held;
    expect(call.holdState).toEqual({ local: true, remote: false });

    emitRemoteBye();
    await settle();
    expect(call.state).toBe('terminated');
    expect(call.holdState).toEqual({ local: true, remote: false });
    await h.phone.dispose();
  });

  it('commits remote hold from a sendonly re-INVITE only after the matching ACK, with exact previous/next events', async () => {
    const { h, call } = await establishedCall();
    const holdEvents: BrowserCallEventMap['holdStateChanged'][] = [];
    call.on('holdStateChanged', (event) => { holdEvents.push(event); });
    expect(call.holdState).toEqual({ local: false, remote: false });

    // The phone's createAnswer for a remote re-INVITE reuses the EXISTING
    // transceiver — it must NOT re-acquire a mic track, so the seeded queue
    // stays drained (a regression here throws on the empty getUserMedia).
    expect(h.env.queuedUserMedia).toHaveLength(0);

    emitRemoteReinvite('sendonly', 2);
    await settle();
    // Remote hold is DERIVED from the offer but must NOT commit before the ACK.
    expect(call.holdState).toEqual({ local: false, remote: false });
    expect(holdEvents).toEqual([]);

    emitReinviteAck(2);
    await settle();
    // The matching ACK commits remote hold: previous {local:false,remote:false}
    // → next {local:false,remote:true}, emitted exactly once.
    expect(call.holdState).toEqual({ local: false, remote: true });
    expect(holdEvents).toEqual([
      { type: 'holdStateChanged', previous: { local: false, remote: false }, state: { local: false, remote: true } },
    ]);

    await h.phone.dispose();
  });
});

describe('BrowserCall — sendDtmf (RFC 4733)', () => {
  type FakeSender = {
    insertDTMFCalls: Array<{ tones: string; duration: number; interToneGap: number }>;
    emitToneChange: (tone: string) => void;
    canInsertDTMF: boolean;
    dtmf: { tonechangeListenerCount: number };
  };

  /** Negotiate RFC 4733 telephone-event in the remote answer (STUB_SDP lacks it). */
  function negotiateTelephoneEvent(h: PhoneHarness): void {
    h.pc.remoteDescription = {
      type: 'answer',
      sdp: DTMF_TELEPHONE_EVENT_SDP,
    } as RTCSessionDescription;
  }

  it('inserts a tone sequence via the DTMF sender and resolves only when the buffer completes', async () => {
    const { h, call } = await establishedCall();
    negotiateTelephoneEvent(h);
    const sender = h.pc.transceivers[0]!.sender as unknown as FakeSender;

    let settled = false;
    const operation = call.sendDtmf('12#A', { durationMs: 120, interToneGapMs: 70 })
      .then(() => { settled = true; });
    expect(sender.insertDTMFCalls).toEqual([
      { tones: '12#A', duration: 120, interToneGap: 70 },
    ]);
    expect(settled).toBe(false);
    sender.emitToneChange('1');
    expect(settled).toBe(false); // a digit event does NOT settle the operation
    sender.emitToneChange('');
    await operation;
    expect(settled).toBe(true);

    await expect(call.sendDtmf('1X')).rejects.toMatchObject({ code: 'DTMF_FAILED' });
    sender.canInsertDTMF = false;
    await expect(call.sendDtmf('1')).rejects.toMatchObject({ code: 'DTMF_UNSUPPORTED' });
    await h.phone.dispose();
  });

  it('rejects DTMF with canonical INVALID_STATE synchronously on a terminal call', async () => {
    const { h, call } = await establishedCall();
    emitRemoteBye();
    await settle();
    expect(call.state).toBe('terminated');
    expect(() => call.sendDtmf('1'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    await h.phone.dispose();
  });

  it('settles a pending DTMF sequence with ABORTED when the call hangs up', async () => {
    const { h, call } = await establishedCall();
    negotiateTelephoneEvent(h);
    const sender = h.pc.transceivers[0]!.sender as unknown as FakeSender;
    const before = h.clock.pendingCount;
    const op = call.sendDtmf('123');
    op.catch(() => undefined); // settled during hangup before the assertion attaches
    expect(h.clock.pendingCount).toBe(before + 1); // exactly one deadline timer armed
    const hangup = call.hangup();
    await flush();
    respondOk('BYE');
    await hangup;
    await settle();
    await expect(op).rejects.toMatchObject({ code: 'ABORTED' });
    expect(h.clock.pendingCount).toBe(before); // DTMF deadline cleared on terminal
    expect(sender.dtmf.tonechangeListenerCount).toBe(0);
    await h.phone.dispose();
  });

  it('settles a pending DTMF sequence even when a state observer throws during hangup', async () => {
    const { h, call } = await establishedCall();
    negotiateTelephoneEvent(h);
    call.on('stateChanged', () => {
      throw new Error('observer failed');
    });
    const op = call.sendDtmf('123');
    op.catch(() => undefined); // settled during hangup before the assertion attaches
    const hangup = call.hangup();
    await flush();
    respondOk('BYE');
    await hangup;
    await settle();
    await expect(op).rejects.toMatchObject({ code: 'ABORTED' });
    await h.phone.dispose();
  });
});

describe('BrowserCall — media event correlation (mediaState + stale-session guard)', () => {
  it('mediaState reflects the last known media session state', async () => {
    const { h, call } = await establishedCall();
    // The call's media session reached `connected` during establishment; the
    // getter must expose that truth (the literal `'new'` the v0.5 stub returned
    // is the regression this fixes).
    expect(call.mediaState).toBe('connected');

    call.notifyMediaEvent('mediaStateChanged', {
      type: 'mediaStateChanged',
      sessionId: call.sessionId,
      previous: 'connected',
      state: 'closed',
    });
    expect(call.mediaState).toBe('closed');
    await h.phone.dispose();
  });

  it('ignores media events from a stale session once the call session id is established', async () => {
    const { h, call } = await establishedCall();
    const received: string[] = [];
    call.on('mediaStateChanged', () => { received.push('mediaStateChanged'); });
    call.on('mediaFailed', () => { received.push('mediaFailed'); });
    call.on('remoteAudio', () => { received.push('remoteAudio'); });
    const before = call.mediaState;

    call.notifyMediaEvent('mediaStateChanged', {
      type: 'mediaStateChanged',
      sessionId: 'stale-session',
      previous: 'new',
      state: 'connected',
    });
    call.notifyMediaEvent('mediaFailed', {
      type: 'mediaFailed',
      sessionId: 'stale-session',
      error: new Error('stale') as never,
    });
    call.notifyMediaEvent('remoteAudio', {
      type: 'remoteAudio',
      sessionId: 'stale-session',
      stream: {} as MediaStream,
    });

    expect(received).toEqual([]);
    expect(call.mediaState).toBe(before);
    await h.phone.dispose();
  });

  it('forwards media events from the matching session', async () => {
    const { h, call } = await establishedCall();
    const received: string[] = [];
    call.on('mediaStateChanged', () => { received.push('mediaStateChanged'); });
    call.notifyMediaEvent('mediaStateChanged', {
      type: 'mediaStateChanged',
      sessionId: call.sessionId,
      previous: 'new',
      state: 'negotiating',
    });
    expect(received).toEqual(['mediaStateChanged']);
    await h.phone.dispose();
  });
});
