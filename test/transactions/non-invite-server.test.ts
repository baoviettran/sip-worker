import { describe, expect, it } from 'vitest';
import { NonInviteServerTransaction } from '../../src/transactions/non-invite-server.js';
import { deriveTimers } from '../../src/transactions/timers.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeResponse } from '../../src/messages/index.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';

const TIMERS = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, false);

interface Harness {
  clock: FakeClock;
  transport: FakeTransport;
  events: TransactionLayerEvent[];
  tx: NonInviteServerTransaction;
}

function makeRequestMsg(overrides: Partial<SipRequestMessage> = {}): SipRequestMessage {
  return {
    kind: 'request',
    method: 'REGISTER',
    uri: 'sip:example.com',
    headers: new Headers(),
    body: new Uint8Array(),
    ...overrides,
  };
}

function setup(overrides: Partial<{ reliable: boolean }> = {}): Harness {
  const reliable = overrides.reliable ?? false;
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable, framing: 'datagram' });
  void transport.connect();
  const request = makeRequestMsg();
  const events: TransactionLayerEvent[] = [];
  const tx = new NonInviteServerTransaction({
    request,
    key: 'branch|REGISTER',
    transport,
    clock,
    timers: deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, reliable),
    reliable,
    emit: (e) => events.push(e),
  });
  return { clock, transport, events, tx };
}

function start(h: Harness): void {
  h.tx.receiveRequest(h.tx.request);
}

function response(statusCode: number): SipResponseMessage {
  const headers = new Headers();
  headers.set('CSeq', '1 REGISTER');
  return makeResponse(statusCode, 'x', headers);
}

describe('NonInviteServerTransaction', () => {
  it('initial request emits request, moves to Trying', () => {
    const h = setup();
    start(h);
    expect(h.tx.state).toBe('Trying');
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
  });

  it('1xx from Trying sends, moves to Proceeding', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(180));
    expect(h.tx.state).toBe('Proceeding');
    expect(h.transport.sent.length).toBe(1);
  });

  it('final from Trying/Proceeding sends, starts J, moves to Completed', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(200));
    expect(h.tx.state).toBe('Completed');
    expect(h.transport.sent.length).toBe(1);
    // Timer J boundary: still Completed one ms before J, terminated at J.
    h.clock.advance(TIMERS.J - 1);
    expect(h.tx.state).toBe('Completed');
    h.clock.advance(1);
    expect(h.tx.state).toBe('Terminated');
    expect(h.events).toContainEqual({ type: 'terminated', key: 'branch|REGISTER' });
  });

  it('duplicate in Trying/Proceeding/Completed resends the latest response when present', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(180));
    expect(h.transport.sent.length).toBe(1);
    // Duplicate in Proceeding resends the cached 1xx.
    h.tx.receiveRequest(h.tx.request);
    expect(h.transport.sent.length).toBe(2);
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
    // Final then duplicate in Completed resends the cached final.
    h.tx.sendResponse(response(200));
    h.tx.receiveRequest(h.tx.request);
    expect(h.transport.sent.length).toBe(4);
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
  });

  it('duplicate in Trying with no cached response emits no request', () => {
    const h = setup();
    start(h);
    h.tx.receiveRequest(h.tx.request);
    expect(h.tx.state).toBe('Trying');
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
    expect(h.transport.sent.length).toBe(0);
  });

  it('reliable transport uses zero J, terminates immediately after Completed', () => {
    const h = setup({ reliable: true });
    start(h);
    h.tx.sendResponse(response(200));
    expect(h.tx.state).toBe('Completed');
    h.clock.advance(1);
    expect(h.tx.state).toBe('Terminated');
  });

  it('send failure emits transportError and terminates', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
    await transport.disconnect();
    const request = makeRequestMsg();
    const events: TransactionLayerEvent[] = [];
    const tx = new NonInviteServerTransaction({
      request,
      key: 'branch|REGISTER',
      transport,
      clock,
      timers: TIMERS,
      reliable: false,
      emit: (e) => events.push(e),
    });
    tx.receiveRequest(request);
    tx.sendResponse(response(200));
    await Promise.resolve();
    expect(events.filter((e) => e.type === 'transportError')).toHaveLength(1);
    expect(tx.state).toBe('Terminated');
  });
});