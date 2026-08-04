import { describe, expect, it } from 'vitest';
import { InviteServerTransaction } from '../../src/transactions/invite-server.js';
import { deriveTimers } from '../../src/transactions/timers.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse } from '../../src/messages/index.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';

const TIMERS = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, false);

interface Harness {
  clock: FakeClock;
  transport: FakeTransport;
  events: TransactionLayerEvent[];
  tx: InviteServerTransaction;
}

function makeInvite(overrides: Partial<SipRequestMessage> = {}): SipRequestMessage {
  return {
    kind: 'request',
    method: 'INVITE',
    uri: 'sip:bob@example.com',
    headers: new Headers(),
    body: new Uint8Array(),
    ...overrides,
  };
}

function setup(overrides: Partial<{ reliable: boolean }> = {}): Harness {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: overrides.reliable ?? false, framing: 'datagram' });
  void transport.connect();
  const request = makeInvite();
  const events: TransactionLayerEvent[] = [];
  const tx = new InviteServerTransaction({
    request,
    key: 'branch|INVITE',
    transport,
    clock,
    timers: TIMERS,
    reliable: overrides.reliable ?? false,
    emit: (e) => events.push(e),
  });
  return { clock, transport, events, tx };
}

function start(h: Harness): void {
  h.tx.receiveRequest(h.tx.request);
}

function response(statusCode: number): SipResponseMessage {
  const headers = new Headers();
  headers.set('CSeq', '1 INVITE');
  return makeResponse(statusCode, 'x', headers);
}

function ack(): SipRequestMessage {
  return makeRequest('ACK', 'sip:bob@example.com');
}

describe('InviteServerTransaction', () => {
  it('initial INVITE emits request, arms the 200ms automatic-100 timer, moves to Proceeding', () => {
    const h = setup();
    start(h);
    expect(h.tx.state).toBe('Proceeding');
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
    // Nothing sends before the 200ms automatic-100 timer.
    h.clock.advance(199);
    expect(h.transport.sent.length).toBe(0);
    h.clock.advance(1);
    expect(h.transport.sent.length).toBe(1);
  });

  it('automatic-100 timer sends and caches 100 Trying', () => {
    const h = setup();
    start(h);
    h.clock.advance(200);
    expect(h.transport.sent.length).toBe(1);
    // Cached: a duplicate INVITE resends the 100 Trying without emitting.
    h.tx.receiveRequest(h.tx.request);
    expect(h.transport.sent.length).toBe(2);
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
  });

  it('TU response before 200ms cancels the automatic-100 timer', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(180));
    h.clock.advance(200);
    expect(h.transport.sent.length).toBe(1); // only the 180, no 100 Trying
    expect(h.tx.state).toBe('Proceeding');
  });

  it('Proceeding 1xx from TU sends and caches, stays Proceeding', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(180));
    expect(h.tx.state).toBe('Proceeding');
    expect(h.transport.sent.length).toBe(1);
    // Duplicate INVITE resends the cached 1xx.
    h.tx.receiveRequest(h.tx.request);
    expect(h.transport.sent.length).toBe(2);
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
  });

  it('Proceeding 2xx from TU sends, starts L, moves to Accepted', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(200));
    expect(h.tx.state).toBe('Accepted');
    expect(h.transport.sent.length).toBe(1);
    // Timer L boundary: still Accepted one ms before L, terminated at L.
    h.clock.advance(TIMERS.L - 1);
    expect(h.tx.state).toBe('Accepted');
    h.clock.advance(1);
    expect(h.tx.state).toBe('Terminated');
    expect(h.events).toContainEqual({ type: 'terminated', key: 'branch|INVITE' });
  });

  it('Accepted repeated INVITE passes the request to the TU', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(200));
    expect(h.tx.state).toBe('Accepted');
    h.tx.receiveRequest(h.tx.request);
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(2);
  });

  it('Accepted 2xx sends again and stays Accepted', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(200));
    h.tx.sendResponse(response(200));
    expect(h.tx.state).toBe('Accepted');
    expect(h.transport.sent.length).toBe(2);
  });

  it('Proceeding 300-699 sends, starts G (unreliable) and H, moves to Completed', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(486));
    expect(h.tx.state).toBe('Completed');
    expect(h.transport.sent.length).toBe(1);
    // Timer G retransmits at T1.
    h.clock.advance(TIMERS.T1);
    expect(h.transport.sent.length).toBe(2);
  });

  it('Completed repeated INVITE resends the cached final without emitting', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(486));
    h.tx.receiveRequest(h.tx.request);
    expect(h.transport.sent.length).toBe(2);
    expect(h.events.filter((e) => e.type === 'request')).toHaveLength(1);
  });

  it('Completed Timer G resends and doubles up to T2', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(486));
    h.clock.advance(TIMERS.T1); // +500
    expect(h.transport.sent.length).toBe(2);
    h.clock.advance(TIMERS.T1 * 2); // +1000
    expect(h.transport.sent.length).toBe(3);
    h.clock.advance(TIMERS.T1 * 4); // +2000
    expect(h.transport.sent.length).toBe(4);
    h.clock.advance(TIMERS.T1 * 8); // +4000 = T2
    expect(h.transport.sent.length).toBe(5);
    h.clock.advance(TIMERS.T2); // plateau at T2
    expect(h.transport.sent.length).toBe(6);
  });

  it('Completed Timer H emits timeout and terminates', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(486));
    h.clock.advance(TIMERS.H - 1);
    expect(h.tx.state).toBe('Completed');
    expect(h.events.filter((e) => e.type === 'timeout')).toHaveLength(0);
    h.clock.advance(1);
    expect(h.tx.state).toBe('Terminated');
    expect(h.events).toContainEqual({ type: 'timeout', key: 'branch|INVITE' });
    expect(h.events).toContainEqual({ type: 'terminated', key: 'branch|INVITE' });
  });

  it('Completed matching ACK cancels G/H, starts I, moves to Confirmed; no Timer H timeout', () => {
    const h = setup();
    start(h);
    h.tx.sendResponse(response(486));
    h.tx.receiveRequest(ack());
    expect(h.tx.state).toBe('Confirmed');
    // Timer I boundary: still Confirmed one ms before I, no timeout event.
    h.clock.advance(TIMERS.I - 1);
    expect(h.tx.state).toBe('Confirmed');
    expect(h.events.filter((e) => e.type === 'timeout')).toHaveLength(0);
    h.clock.advance(1);
    expect(h.tx.state).toBe('Terminated');
    expect(h.events).toContainEqual({ type: 'terminated', key: 'branch|INVITE' });
  });

  it('reliable transport never arms G, still arms H and L, no retransmissions', () => {
    const h = setup({ reliable: true });
    start(h);
    h.tx.sendResponse(response(486));
    expect(h.tx.state).toBe('Completed');
    // No G retransmission after several T1s.
    h.clock.advance(TIMERS.T1 * 3);
    expect(h.transport.sent.length).toBe(1);
    // H still fires and terminates.
    h.clock.advance(TIMERS.H);
    expect(h.tx.state).toBe('Terminated');
    expect(h.events).toContainEqual({ type: 'timeout', key: 'branch|INVITE' });
  });

  it('send failure emits transportError without discarding state; RFC timers still terminate', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
    await transport.disconnect();
    const request = makeInvite();
    const events: TransactionLayerEvent[] = [];
    const tx = new InviteServerTransaction({
      request,
      key: 'branch|INVITE',
      transport,
      clock,
      timers: TIMERS,
      reliable: false,
      emit: (e) => events.push(e),
    });
    tx.receiveRequest(request);
    tx.sendResponse(response(486));
    await Promise.resolve();
    expect(events.filter((e) => e.type === 'transportError')).toHaveLength(1);
    // State not discarded: still Completed.
    expect(tx.state).toBe('Completed');
    // Timer H still terminates.
    clock.advance(TIMERS.H);
    expect(tx.state).toBe('Terminated');
  });
});