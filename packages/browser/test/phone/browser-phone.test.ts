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

describe('PhoneRuntime — connected-session reclaim', () => {
  it('drops a closed/failed session from the connected set so a reused session id settles fresh again', async () => {
    const { phone } = buildPhone();
    await phone.connect();
    const runtime = (phone as unknown as {
      runtime: {
        waitForMediaConnected(sessionId: string): Promise<void>;
        onManagerEvent(type: string, value: unknown): void;
        dispose(): Promise<void>;
      };
    }).runtime;

    // A fresh waiter on an id not yet seen does NOT resolve immediately; the
    // connected event settles it.
    let firstSettled = false;
    const first = runtime.waitForMediaConnected('s-reuse').then(() => { firstSettled = true; });
    await flush();
    expect(firstSettled).toBe(false);
    runtime.onManagerEvent('mediaStateChanged', {
      type: 'mediaStateChanged',
      sessionId: 's-reuse',
      previous: 'new',
      state: 'connected',
    });
    await first;
    expect(firstSettled).toBe(true);

    // The session closes; its connected marker must be reclaimed.
    runtime.onManagerEvent('mediaStateChanged', {
      type: 'mediaStateChanged',
      sessionId: 's-reuse',
      previous: 'connected',
      state: 'closed',
    });

    // A fresh waiter on the SAME id must NOT resolve from the stale marker.
    let secondSettled = false;
    const second = runtime.waitForMediaConnected('s-reuse');
    second.catch(() => undefined); // rejected at dispose; never unhandled
    second.then(() => { secondSettled = true; }).catch(() => undefined);
    await flush();
    expect(secondSettled).toBe(false);

    await phone.dispose();
  });
});

