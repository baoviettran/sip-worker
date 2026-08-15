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
  sendAck,
} from '../support/phone-harness.js';

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
    expect(incoming!.state).toBe('new');

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
});
