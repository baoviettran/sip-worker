import { describe, expect, it } from 'vitest';
import { InviteClientTransaction } from '../../src/transactions/invite-client.js';
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
  tx: InviteClientTransaction;
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

function setup(overrides: Partial<{ reliable: boolean; uri: string; request: SipRequestMessage }> = {}): Harness {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: overrides.reliable ?? false, framing: 'datagram' });
  void transport.connect();
  const request = overrides.request ?? makeInvite(overrides.uri === undefined ? {} : { uri: overrides.uri });
  const events: TransactionLayerEvent[] = [];
  const tx = new InviteClientTransaction({
    request,
    key: 'branch|example.com:5060|INVITE',
    transport,
    clock,
    timers: TIMERS,
    reliable: overrides.reliable ?? false,
    emit: (e) => events.push(e),
    buildNon2xxAck: (req, _resp) => makeRequest('ACK', req.uri),
  });
  return { clock, transport, events, tx };
}

function response(statusCode: number, method = 'INVITE'): SipResponseMessage {
  const headers = new Headers();
  headers.set('CSeq', `1 ${method}`);
  return makeResponse(statusCode, 'x', headers);
}

describe('InviteClientTransaction', () => {
  it('sends the request once on start and arms timers', () => {
    const { clock, transport, events, tx } = setup();
    tx.start();
    expect(transport.sent.length).toBe(1);
    expect(events.length).toBe(0);
    // Nothing fires one ms before T1.
    clock.advance(TIMERS.T1 - 1);
    expect(transport.sent.length).toBe(1);
    // Exactly at T1, timer A fires and resends once.
    clock.advance(1);
    expect(transport.sent.length).toBe(2);
  });

  it('timer A resends and doubles the interval, without a T2 cap', () => {
    const { clock, transport, tx } = setup();
    tx.start();
    // First retransmission at T1 = 500.
    clock.advance(TIMERS.T1);
    expect(transport.sent.length).toBe(2);
    // Second at 1000 more (doubled), not capped at T2.
    clock.advance(TIMERS.T1 * 2);
    expect(transport.sent.length).toBe(3);
    // Third at 2000 more.
    clock.advance(TIMERS.T1 * 4);
    expect(transport.sent.length).toBe(4);
    // Fourth at 4000 more (> T2), proving the INVITE retransmit has no T2 cap.
    clock.advance(TIMERS.T1 * 8);
    expect(transport.sent.length).toBe(5);
  });

  it('retransmits the original header and body bytes after the caller mutates the request', () => {
    const headers = new Headers();
    headers.set('X-Request-Id', 'original');
    const request = makeInvite({ headers, body: new TextEncoder().encode('original body') });
    const { clock, transport, tx } = setup({ request });

    tx.start();
    request.headers.set('X-Request-Id', 'mutated');
    request.body.set(new TextEncoder().encode('mutated!'));
    clock.advance(TIMERS.T1);

    expect(transport.sent[1]).toEqual(transport.sent[0]);
  });

  it('timer B emits timeout and terminates', () => {
    const { clock, events, tx } = setup();
    tx.start();
    const b = TIMERS.B;
    clock.advance(b - 1);
    expect(tx.state).toBe('Calling');
    expect(events.filter((e) => e.type === 'terminated')).toHaveLength(0);
    clock.advance(1);
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'timeout', key: 'branch|example.com:5060|INVITE' });
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|example.com:5060|INVITE' });
  });

  it('1xx from Calling cancels A, emits, and moves to Proceeding', () => {
    const { clock, transport, events, tx } = setup();
    tx.start();
    tx.receive(response(100));
    expect(tx.state).toBe('Proceeding');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // Timer A was cancelled: no retransmission after T1.
    clock.advance(TIMERS.T1 * 3);
    expect(transport.sent.length).toBe(1);
  });

  it('2xx from Calling/Proceeding cancels A/B, emits, starts M, moves to Accepted', () => {
    const { clock, events, tx } = setup();
    tx.start();
    tx.receive(response(200));
    expect(tx.state).toBe('Accepted');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // Timer M fires at 64*T1 and terminates.
    clock.advance(TIMERS.M - 1);
    expect(tx.state).toBe('Accepted');
    clock.advance(1);
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|example.com:5060|INVITE' });
  });

  it('timer B fires from Proceeding after a provisional', () => {
    const { clock, events, tx } = setup();
    tx.start();
    tx.receive(response(100));
    expect(tx.state).toBe('Proceeding');
    clock.advance(TIMERS.B - 1);
    expect(tx.state).toBe('Proceeding');
    expect(events.filter((e) => e.type === 'timeout')).toHaveLength(0);
    clock.advance(1);
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'timeout', key: 'branch|example.com:5060|INVITE' });
  });

  it('2xx from Proceeding moves to Accepted and arms M', () => {
    const { clock, events, tx } = setup();
    tx.start();
    tx.receive(response(100));
    tx.receive(response(200));
    expect(tx.state).toBe('Accepted');
    clock.advance(TIMERS.M);
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|example.com:5060|INVITE' });
  });

  it('sent exactly once and no retransmits on a reliable transport', () => {
    const { clock, transport, events, tx } = setup({ reliable: true });
    tx.start();
    expect(transport.sent.length).toBe(1);
    // Timer A is never armed: nothing resends after several T1s.
    clock.advance(TIMERS.T1 * 3);
    expect(transport.sent.length).toBe(1);
    expect(events.length).toBe(0);
  });

  it('Accepted emits every matching 2xx without restarting M', () => {
    const { clock, events, tx } = setup();
    tx.start();
    tx.receive(response(200));
    const responsesBefore = events.filter((e) => e.type === 'response').length;
    tx.receive(response(200));
    tx.receive(response(200));
    expect(events.filter((e) => e.type === 'response')).toHaveLength(responsesBefore + 2);
    // M is not restarted: the transaction still terminates at the original M.
    clock.advance(TIMERS.M);
    expect(tx.state).toBe('Terminated');
  });

  it('300-699 from Calling/Proceeding sends non-2xx ACK, emits, starts D, moves to Completed', () => {
    const { clock, transport, events, tx } = setup();
    tx.start();
    tx.receive(response(486));
    expect(tx.state).toBe('Completed');
    // Request + non-2xx ACK sent.
    expect(transport.sent.length).toBe(2);
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // Timer D fires and terminates.
    clock.advance(TIMERS.D - 1);
    expect(tx.state).toBe('Completed');
    clock.advance(1);
    expect(tx.state).toBe('Terminated');
  });

  it('Completed resends the cached ACK on repeated final without emitting', () => {
    const { transport, events, tx } = setup();
    tx.start();
    tx.receive(response(486));
    const sentBefore = transport.sent.length;
    const responsesBefore = events.filter((e) => e.type === 'response').length;
    tx.receive(response(486));
    expect(transport.sent.length).toBe(sentBefore + 1);
    expect(events.filter((e) => e.type === 'response')).toHaveLength(responsesBefore);
  });

  it('routes via the shared cseqMethod: ignores a nonmatching method but matches INVITE', () => {
    const { transport, events, tx } = setup();
    tx.start();
    // A non-INVITE CSeq method is ignored through the shared helper.
    tx.receive(response(200, 'BYE'));
    expect(tx.state).toBe('Calling');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(0);
    expect(transport.sent.length).toBe(1);
    // A matching INVITE CSeq method is routed through the same helper.
    tx.receive(response(200, 'INVITE'));
    expect(tx.state).toBe('Accepted');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
  });

  it('ignores invalid status codes', () => {
    const { events, tx } = setup();
    tx.start();
    tx.receive(response(99, 'INVITE'));
    tx.receive(response(700, 'INVITE'));
    expect(tx.state).toBe('Calling');
    expect(events.filter((e) => e.type === 'response')).toHaveLength(0);
  });

  it('rejects from start send emit transportError and terminate', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
    await transport.disconnect(); // make send reject
    const request = makeInvite();
    const events: TransactionLayerEvent[] = [];
    const tx = new InviteClientTransaction({
      request,
      key: 'branch|example.com:5060|INVITE',
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
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|example.com:5060|INVITE' });
  });

  it('terminate() emits terminated', () => {
    const { events, tx } = setup();
    tx.start();
    tx.terminate();
    expect(tx.state).toBe('Terminated');
    expect(events).toContainEqual({ type: 'terminated', key: 'branch|example.com:5060|INVITE' });
  });

  it('does not arm Timer M or D when a final-response listener terminates synchronously', () => {
    for (const statusCode of [200, 486]) {
      const clock = new FakeClock();
      const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
      void transport.connect();
      const events: TransactionLayerEvent[] = [];
      let tx: InviteClientTransaction;
      tx = new InviteClientTransaction({
        request: makeInvite(),
        key: 'branch|example.com:5060|INVITE',
        transport,
        clock,
        timers: TIMERS,
        reliable: false,
        emit: (event) => {
          events.push(event);
          if (event.type === 'response') tx.terminate();
        },
        buildNon2xxAck: (request, _response) => makeRequest('ACK', request.uri),
      });

      tx.start();
      tx.receive(response(statusCode));

      expect(tx.state, `status ${statusCode}`).toBe('Terminated');
      expect(clock.pending(), `status ${statusCode}`).toBe(0);
    }
  });

  it('does not resurrect Timer D when ACK sending terminates synchronously', () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
    void transport.connect();
    const events: TransactionLayerEvent[] = [];
    let tx: InviteClientTransaction;
    tx = new InviteClientTransaction({
      request: makeInvite(),
      key: 'branch|example.com:5060|INVITE',
      transport,
      clock,
      timers: TIMERS,
      reliable: false,
      emit: (event) => events.push(event),
      buildNon2xxAck: (request, _response) => makeRequest('ACK', request.uri),
    });
    transport.onSend = () => {
      if (transport.sent.length === 2) tx.terminate();
    };

    tx.start();
    tx.receive(response(486));

    expect(tx.state).toBe('Terminated');
    expect(clock.pending()).toBe(0);
  });
});
