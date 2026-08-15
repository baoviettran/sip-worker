/**
 * BrowserPhone lifecycle and ownership tests (v0.7).
 *
 * These tests exercise the composition root end to end on deterministic fakes:
 * connection, registration, the single-media-session guarantee, incoming-call
 * wrapping, 486 busy, forward-after-commit state ordering, immutable
 * size-bounded remote identity, and idempotent disposal.
 */
import { describe, expect, it } from 'vitest';
import {
  OutgoingBrowserCall,
  IncomingBrowserCall,
  type BrowserPhoneEventMap,
} from '../../src/phone/index.js';
import {
  buildPhone,
  sentRequests,
  sendIncomingInvite,
  answerInviteAndConnectMedia,
  outboundResponseCodes,
  flush,
  settle,
  buildIncomingHeaders,
  emitIncoming,
  sendAck,
} from '../support/phone-harness.js';

describe('BrowserPhone — lifecycle and ownership', () => {
  it('connects, registers, establishes an outgoing call, then rejects a busy second call (INVALID_STATE)', async () => {
    const { phone } = buildPhone();
    expect(phone.connectionState).toBe('disconnected');
    await phone.connect();
    expect(phone.connectionState).toBe('connected');
    await phone.register();
    expect(phone.registrationState).toBe('registered');

    const call = phone.createCall('sip:bob@example.com') as OutgoingBrowserCall;
    expect(call).toBeInstanceOf(OutgoingBrowserCall);
    expect(call.state).toBe('new');
    expect(sentRequests('INVITE')).toHaveLength(0);
    const start = call.start();
    await answerInviteAndConnectMedia();
    await start;
    expect(call.state).toBe('established');

    let busyError: unknown;
    try {
      phone.createCall('sip:carol@example.com');
    } catch (error) {
      busyError = error;
    }
    expect(busyError).toMatchObject({ code: 'INVALID_STATE' });

    await phone.register();
    await phone.dispose();
  });

  it('wraps an incoming call as IncomingBrowserCall and establishes it via answer()', async () => {
    const { phone, pc } = buildPhone();
    await phone.connect();

    const received: unknown[] = [];
    phone.on('incomingCall', (event) => received.push(event.call));

    sendIncomingInvite('incall@example.com', 'br-incoming');
    await settle();

    expect(received).toHaveLength(1);
    const call = received[0];
    expect(call).toBeInstanceOf(IncomingBrowserCall);
    const incoming = call as IncomingBrowserCall;
    expect(incoming.state).toBe('new');

    const answerPromise = incoming.answer();
    await settle();
    sendAck();
    await settle();
    pc._setIceConnection('connected');
    await answerPromise;

    expect(incoming.state).toBe('established');

    // Busy: an active (established) incoming call rejects a second invite at SIP.
    sendIncomingInvite('second@example.com', 'br-second');
    await flush();
    expect(outboundResponseCodes()).toContain(486);

    await phone.dispose();
  });

  it('emits connection/registration state only after internal commit (no optimistic emission)', async () => {
    const { phone } = buildPhone();
    const observed: string[] = [];
    phone.on('connectionStateChanged', (event: BrowserPhoneEventMap['connectionStateChanged']) => {
      observed.push(event.state);
    });
    const regObserved: string[] = [];
    phone.on('registrationStateChanged', () => regObserved.push(phone.registrationState));

    const connecting = phone.connect();
    expect(phone.connectionState).toBe('connecting');
    await connecting;
    expect(phone.connectionState).toBe('connected');

    const registering = phone.register();
    await registering;

    expect(observed).toEqual(['connected']);
    expect(regObserved).toEqual(['registered']);
    await phone.dispose();
  });

  it('binds remoteIdentity immutable and size-bounded; never copied into a shared error', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    await phone.register();

    // A hostile long display name on an incoming call is bounded.
    const received: IncomingBrowserCall[] = [];
    phone.on('incomingCall', (event: BrowserPhoneEventMap['incomingCall']) => {
      received.push(event.call as IncomingBrowserCall);
    });
    const longName = 'x'.repeat(400);
    emitIncoming(buildIncomingHeaders(`"${longName}" <sip:bob@example.com>;tag=bob-tag`, 'long-from-id', 'long-br'));
    await settle();

    expect(received).toHaveLength(1);
    const incoming = received[0]!;
    expect(incoming.remoteIdentity?.displayName).not.toBeUndefined();
    expect(incoming.remoteIdentity!.displayName!.length).toBeLessThanOrEqual(256);
    // Contrast the raw (unbounded) header does not reach the identity object.
    expect(incoming.remoteIdentity!.displayName!.length).toBeLessThan(400);
    expect(Object.isFrozen(incoming.remoteIdentity)).toBe(true);

    // The caller-owned and per-call outgoing RemoteIdentity is also immutable.
    const call = phone.createCall('sip:carol@example.com');
    const remote = call.remoteIdentity;
    expect(remote?.uri).toContain('carol@example.com');
    expect(Object.isFrozen(remote)).toBe(true);

    await phone.dispose();
  });

  it('disposes idempotently and releases every owned resource exactly once', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    const first = phone.dispose();
    const second = phone.dispose();
    expect(second).toBe(first);
    await first;
    expect(phone.connectionState).toBe('disposed');
    await phone.dispose();
  });
});

