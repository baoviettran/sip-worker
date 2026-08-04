import { describe, expect, it } from 'vitest';
import { NonInviteClientTransaction } from '../../src/transactions/non-invite-client.js';
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
  tx: NonInviteClientTransaction;
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
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: overrides.reliable ?? false, framing: 'datagram' });
  void transport.connect();
  const request = makeRequestMsg();
  const events: TransactionLayerEvent[] = [];
  const tx = new NonInviteClientTransaction({
    request,
    key: 'branch|REGISTER',
    transport,
    clock,
    timers: TIMERS,
    reliable: overrides.reliable ?? false,
    emit: (e) => events.push(e),
    buildNon2xxAck: (req, _resp) => makeRequest('ACK', req.uri),
  });
  return { clock, transport, events, tx };
}

function response(statusCode: number, method = 'REGISTER'): SipResponseMessage {
  const headers = new Headers();
  headers.set('CSeq', `1 ${method}`);
  return makeResponse(statusCode, 'x', headers);
}

describe('NonInviteClientTransaction', () => {
  it('sends the request once on start and arms timers', () => {
    const { clock, transport, events, tx } = setup();
    tx.start();
    expect(transport.sent.length).toBe(1);
    expect(events.length).toBe(0);
    clock.advance(TIMERS.T1 - 1);
    expect(transport.sent.length).toBe(1);
    clock.advance(1);
    expect(transport.sent.length).toBe(2);
  });

  it('timer E resends and doubles up to T2, then plateaus at T2', () => {
    const { clock, transport, tx } = setup();
    tx.start();
    // T1 = 500 -> 1000 -> 2000 -> T2 = 4000 -> 4000 ...
    clock.advance(TIMERS.T1); // +500
    expect(transport.sent.length).toBe(2);
    clock.advance(TIMERS.T1 * 2); // +1000
    expect(transport.sent.length).toBe(3);
    clock.advance(TIMERS.T1 * 4); // +2000
    expect(transport.sent.length).toBe(4);
    clock.advance(TIMERS.T1 * 8); // +4000
    expect(transport.sent.length).toBe(5);
    clock.advance(TIMERS.T2); // +4000, plateau at T2
    expect(transport.sent.length).toBe(6);
  });

  it('1xx from Trying emits, sets E interval to T2, moves to Proceeding', () => {
    const { clock, transport, events, tx } = setup();
    tx.start();
    tx.receive(response(180));
    expect(tx.state).toBe('Proceeding');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // Timer E was re-armed at T2: no retransmission before T2.
    clock.advance(TIMERS.T2 - 1);
    expect(transport.sent.length).toBe(1);
    clock.advance(1);
    expect(transport.sent.length).toBe(2);
  });

  it('Proceeding resends at T2 on timer E', () => {
    const { clock, transport, tx } = setup();
    tx.start();
    tx.receive(response(180));
    clock.advance(TIMERS.T2);
    expect(transport.sent.length).toBe(2);
    clock.advance(TIMERS.T2);
    expect(transport.sent.length).toBe(3);
  });

  it('timer F emits timeout and terminates', () => {
    const { clock, events, tx } = setup();
    tx.start();
    clock.advance(TIMERS.F - 1);
    expect(tx.state).toBe('Trying');
    expect(events.filter((e) => e.type === 'terminated')).toHaveLength(0);
    clock.advance(1);
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'timeout', key: 'branch|REGISTER' });
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|REGISTER' });
  });

  it('200-699 from Trying/Proceeding cancels E/F, emits, starts K, moves to Completed', () => {
    const { clock, transport, events, tx } = setup();
    tx.start();
    tx.receive(response(200));
    expect(tx.state).toBe('Completed');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // Timer E and F cancelled: no retransmission after F would have fired.
    clock.advance(TIMERS.F);
    expect(transport.sent.length).toBe(1);
    // Timer K (=5000) fired during the F-length advance and terminated the tx.
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|REGISTER' });
  });

  it('timer K boundary: terminates one ms before and exactly at K', () => {
    const { clock, events, tx } = setup();
    tx.start();
    tx.receive(response(200));
    expect(tx.state).toBe('Completed');
    clock.advance(TIMERS.K - 1);
    expect(tx.state).toBe('Completed');
    expect(events.filter((e) => e.type === 'terminated')).toHaveLength(0);
    clock.advance(1);
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|REGISTER' });
  });

  it('timer F fires from Proceeding after a provisional', () => {
    const { clock, events, tx } = setup();
    tx.start();
    tx.receive(response(180));
    expect(tx.state).toBe('Proceeding');
    clock.advance(TIMERS.F - 1);
    expect(tx.state).toBe('Proceeding');
    expect(events.filter((e) => e.type === 'timeout')).toHaveLength(0);
    clock.advance(1);
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'timeout', key: 'branch|REGISTER' });
  });

  it('final 488 from Proceeding completes, never retransmitted after K', () => {
    const { clock, transport, tx } = setup();
    tx.start();
    tx.receive(response(180));
    tx.receive(response(488));
    expect(tx.state).toBe('Completed');
    // No retransmission once Completed: E was cancelled.
    clock.advance(TIMERS.T2);
    expect(transport.sent.length).toBe(1);
    clock.advance(TIMERS.K);
    expect(tx.state).toBe('Terminated');
  });

  it('sent exactly once and no retransmits on a reliable transport', () => {
    const { clock, transport, events, tx } = setup({ reliable: true });
    tx.start();
    expect(transport.sent.length).toBe(1);
    clock.advance(TIMERS.T1 * 3);
    expect(transport.sent.length).toBe(1);
    expect(events.length).toBe(0);
  });

  it('provisional after final is ignored (2xx already completed)', () => {
    const { events, tx } = setup();
    tx.start();
    tx.receive(response(200));
    tx.receive(response(180));
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    expect(tx.state).toBe('Completed');
  });

  it('ignores nonmatching CSeq methods', () => {
    const { transport, events, tx } = setup();
    tx.start();
    tx.receive(response(200, 'INVITE'));
    expect(tx.state).toBe('Trying');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(0);
    expect(transport.sent.length).toBe(1);
  });

  it('ignores invalid status codes', () => {
    const { events, tx } = setup();
    tx.start();
    tx.receive(response(99, 'REGISTER'));
    tx.receive(response(700, 'REGISTER'));
    expect(tx.state).toBe('Trying');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(0);
  });

  it('rejects from start send emit transportError and terminate', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
    await transport.disconnect();
    const request = makeRequestMsg();
    const events: TransactionLayerEvent[] = [];
    const tx = new NonInviteClientTransaction({
      request,
      key: 'branch|REGISTER',
      transport,
      clock,
      timers: TIMERS,
      reliable: false,
      emit: (e) => events.push(e),
      buildNon2xxAck: (req, _resp) => makeRequest('ACK', req.uri),
    });
    tx.start();
    await Promise.resolve();
    expect(tx.state).toBe('Terminated');
    expect(events.filter((e) => e.type === 'transportError')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|REGISTER' });
  });

  it('terminate() emits terminated', () => {
    const { events, tx } = setup();
    tx.start();
    tx.terminate();
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|REGISTER' });
  });
});
