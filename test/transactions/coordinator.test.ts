import { describe, expect, it } from 'vitest';
import { TransactionLayer } from '../../src/transactions/index.js';
import { deriveTimers } from '../../src/transactions/timers.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse, parseMessage } from '../../src/messages/index.js';
import { TransportError } from '../../src/errors.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';

export const MAGIC_COOKIE = 'z9hG4bK';

const TIMERS = deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, false);

interface Harness {
  clock: FakeClock;
  transport: FakeTransport;
  events: TransactionLayerEvent[];
  layer: TransactionLayer;
}

function viaHeader(branch: string, sentBy = '192.0.2.1:5060'): string {
  return `SIP/2.0/UDP ${sentBy};branch=${branch}`;
}

function makeInvite(branch = 'z9hG4bK-abc'): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', viaHeader(branch));
  headers.set('From', '<sip:alice@example.com>;tag=alice-tx');
  headers.set('To', '<sip:bob@example.com>');
  headers.set('Call-ID', 'abc123');
  headers.set('CSeq', '41 INVITE');
  headers.set('Max-Forwards', '70');
  return makeRequest('INVITE', 'sip:bob@example.com', headers);
}

function makeRegister(branch = 'z9hG4bK-reg'): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', viaHeader(branch));
  headers.set('From', '<sip:alice@example.com>;tag=alice-tx');
  headers.set('To', '<sip:alice@example.com>');
  headers.set('Call-ID', 'reg123');
  headers.set('CSeq', '1 REGISTER');
  headers.set('Max-Forwards', '70');
  return makeRequest('REGISTER', 'sip:example.com', headers);
}

function makeOptions(branch = 'z9hG4bK-options'): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', viaHeader(branch));
  headers.set('From', '<sip:alice@example.com>;tag=alice-tx');
  headers.set('To', '<sip:example.com>');
  headers.set('Call-ID', 'options123');
  headers.set('CSeq', '1 OPTIONS');
  headers.set('Max-Forwards', '70');
  return makeRequest('OPTIONS', 'sip:example.com', headers);
}

function setup(reliable = false): Harness {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable, framing: 'datagram' });
  void transport.connect();
  const events: TransactionLayerEvent[] = [];
  const layer = new TransactionLayer({
    transport,
    clock,
    timers: deriveTimers({ T1: 500, T2: 4000, T4: 5000 }, reliable),
    reliable,
    emit: (e) => events.push(e),
  });
  return { clock, transport, events, layer };
}

function responseFor(branch: string, statusCode: number, method = 'INVITE', cseq = '41', sentBy = '192.0.2.1:5060'): SipResponseMessage {
  const headers = new Headers();
  headers.set('Via', viaHeader(branch, sentBy));
  headers.set('From', '<sip:alice@example.com>;tag=alice-tx');
  headers.set('To', method === 'REGISTER'
    ? '<sip:alice@example.com>;tag=server'
    : method === 'OPTIONS'
      ? '<sip:example.com>;tag=server'
      : '<sip:bob@example.com>;tag=server');
  headers.set('Call-ID', method === 'REGISTER' ? 'reg123' : method === 'OPTIONS' ? 'options123' : 'abc123');
  headers.set('CSeq', `${cseq} ${method}`);
  return makeResponse(statusCode, 'x', headers);
}

function topBranch(request: SipRequestMessage): string | undefined {
  return request.headers.get('Via')?.match(/;branch=([^;]+)/)?.[1];
}

describe('TransactionLayer', () => {
  it('routes responses on a reliable transport', () => {
    const { events, layer } = setup(true);
    const invite = makeInvite();
    const tx = layer.sendRequest(invite);
    layer.receive(responseFor('z9hG4bK-abc', 200));
    expect(events).toContainEqual(expect.objectContaining({ type: 'response', transaction: expect.objectContaining({ key: tx.key }) }));
    expect(tx.state).toBe('Accepted');
  });

  it('accepts a tagless 100 Trying without relaxing the remaining response identity', () => {
    const { clock, transport, events, layer } = setup();
    const invite = makeInvite();
    const tx = layer.sendRequest(invite);
    const trying = responseFor('z9hG4bK-abc', 100);
    trying.headers.set('To', '<sip:bob@example.com>');
    const forged = { ...trying, headers: trying.headers.clone() };
    forged.headers.set('Call-ID', 'forged-call-id');
    layer.receive(forged);
    expect(tx.state).toBe('Calling');
    expect(events.filter((event) => event.type === 'response')).toHaveLength(0);

    layer.receive(trying);
    clock.advance(TIMERS.T1);

    expect(tx.state).toBe('Proceeding');
    expect(events.filter((event) => event.type === 'response')).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('accepts a response tag on a bare To address without changing its URI identity', () => {
    const { events, layer } = setup(true);
    const invite = makeInvite();
    invite.headers.set('To', 'sip:bob@example.com;transport=tcp');
    const tx = layer.sendRequest(invite);
    const response = responseFor('z9hG4bK-abc', 200);
    response.headers.set('To', 'sip:bob@example.com;transport=tcp;tag=server');

    layer.receive(response);

    expect(tx.state).toBe('Accepted');
    expect(events.filter((event) => event.type === 'response')).toHaveLength(1);
  });

  it('removes the exact bare To tag instead of a quoted tag decoy', () => {
    const { events, layer } = setup(true);
    const invite = makeInvite();
    invite.headers.set('To', 'sip:bob@example.com;foo="x;tag=fake;bar=y"');
    const tx = layer.sendRequest(invite);
    const response = responseFor('z9hG4bK-abc', 200);
    response.headers.set('To', 'sip:bob@example.com;foo="x;tag=fake;bar=y";tag=server');

    layer.receive(response);

    expect(tx.state).toBe('Accepted');
    expect(events.filter((event) => event.type === 'response')).toHaveLength(1);
  });

  it('tracks before synchronous transport delivery', () => {
    const { transport, events, layer } = setup();
    const invite = makeInvite();
    transport.onSend = (bytes) => {
      const parsed = parseMessage(bytes);
      if (parsed.ok && parsed.value.kind === 'request') {
        // A response referencing the same branch arrives synchronously during send.
        layer.receive(responseFor(topBranch(parsed.value) ?? 'z9hG4bK-abc', 200));
      }
    };
    const tx = layer.sendRequest(invite);
    expect(events).toContainEqual(expect.objectContaining({ type: 'response', transaction: expect.objectContaining({ key: tx.key }) }));
  });

  it('routes a matching response to the client transaction', () => {
    const { events, layer } = setup();
    const invite = makeInvite();
    const tx = layer.sendRequest(invite);
    layer.receive(responseFor('z9hG4bK-abc', 486));
    expect(events).toContainEqual(expect.objectContaining({ type: 'response', transaction: expect.objectContaining({ key: tx.key }) }));
    expect(tx.state).toBe('Completed');
  });

  it.each([
    { label: 'INVITE', request: makeInvite(), statusCode: 486, branch: 'z9hG4bK-abc', cseq: '41' },
    { label: 'REGISTER', request: makeRegister(), statusCode: 403, branch: 'z9hG4bK-reg', cseq: '1' },
  ])('ignores a forged $label final before mutation and accepts the legitimate final', ({ request, statusCode, branch, cseq }) => {
    const { events, layer } = setup();
    const tx = layer.sendRequest(request);
    const forged = responseFor(branch, statusCode, request.method, cseq);
    forged.headers.set('Call-ID', 'forged-call-id');

    layer.receive(forged);

    expect(tx.state).toBe(request.method === 'INVITE' ? 'Calling' : 'Trying');
    expect(events.filter((event) => event.type === 'response')).toHaveLength(0);

    layer.receive(responseFor(branch, statusCode, request.method, cseq));

    expect(tx.state).toBe('Completed');
    expect(events.filter((event) => event.type === 'response')).toHaveLength(1);
  });

  it.each([
    { label: 'INVITE Timer B', request: makeInvite(), statusCode: 486, branch: 'z9hG4bK-abc', cseq: '41', timeout: TIMERS.B },
    { label: 'REGISTER Timer F', request: makeRegister(), statusCode: 403, branch: 'z9hG4bK-reg', cseq: '1', timeout: TIMERS.F },
  ])('ignores a forged final and settles through $label without disposal', ({ request, statusCode, branch, cseq, timeout }) => {
    const { clock, events, layer } = setup();
    const tx = layer.sendRequest(request);
    const forged = responseFor(branch, statusCode, request.method, cseq);
    forged.headers.set('From', '<sip:alice@example.com>;tag=forged-from');

    layer.receive(forged);
    clock.advance(timeout);

    expect(events.filter((event) => event.type === 'response')).toHaveLength(0);
    expect(events).toContainEqual({ type: 'timeout', key: tx.key });
    expect(tx.state).toBe('Terminated');
  });

  it('creates a server transaction for an unmatched request', () => {
    const { events, layer } = setup();
    const invite = makeInvite();
    layer.receive(invite);
    expect(events).toContainEqual(expect.objectContaining({ type: 'request' }));
  });

  it('routes an ACK for a non-2xx to the existing INVITE server transaction', () => {
    const { events, layer } = setup();
    const invite = makeInvite();
    layer.receive(invite);
    const ack = makeRequest('ACK', 'sip:bob@example.com', invite.headers);
    ack.headers.set('CSeq', '41 ACK');
    layer.receive(ack);
    // The ACK is consumed by the server transaction; no statelessRequest is emitted.
    expect(events.filter((e) => e.type === 'statelessRequest')).toHaveLength(0);
  });

  it('emits an unmatched ACK with a fresh 2xx branch as statelessRequest without a server transaction', () => {
    const { events, layer } = setup();
    const ack = makeRequest('ACK', 'sip:bob@example.com', new Headers());
    ack.headers.set('Via', viaHeader('z9hG4bK-fresh2xx'));
    ack.headers.set('From', '<sip:alice@example.com>');
    ack.headers.set('To', '<sip:bob@example.com>');
    ack.headers.set('Call-ID', 'ack123');
    ack.headers.set('CSeq', '41 ACK');
    layer.receive(ack);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ type: 'statelessRequest' }));
  });

  it('emits statelessResponse for unmatched responses', () => {
    const { events, layer } = setup();
    layer.receive(responseFor('z9hG4bK-unknown', 200));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ type: 'statelessResponse' }));
  });

  it('deletes only the owning map entry when a key is shared by client and server', () => {
    const { clock, events, layer } = setup(true);
    // A UA both sends and receives on the SAME branch: an INVITE client
    // transaction and an INVITE server transaction share the key
    // `z9hG4bK-abc|192.0.2.1:5060|INVITE`. Terminating one must not delete the other.
    const invite = makeInvite();
    layer.sendRequest(invite); // client transaction, key z9hG4bK-abc|192.0.2.1:5060|INVITE
    layer.receive(makeInvite()); // server transaction, same key
    // Both reach Completed.
    layer.receive(responseFor('z9hG4bK-abc', 486)); // client -> Completed
    layer.sendResponse('z9hG4bK-abc|192.0.2.1:5060|INVITE', responseFor('z9hG4bK-abc', 486)); // server -> Completed
    expect(events.filter((e) => e.type === 'terminated')).toHaveLength(0);

    // Advance past timer D: only the CLIENT terminates. This layer is reliable,
    // so its derived D = 0 (use TIMERS's own mismatch would skip forward far
    // enough to also fire the server's timer H).
    clock.advance(0); // client Completed -> Terminated (reliable D = 0)
    expect(events).toContainEqual({ type: 'terminated', key: 'z9hG4bK-abc|192.0.2.1:5060|INVITE' });
    const terminatedAtClient = events.filter((e) => e.type === 'terminated').length;

    // The SERVER transaction on the same key must still be tracked: a duplicate
    // INVITE for that branch is routed to it (no fresh transaction, no
    // statelessRequest for a non-ACK).
    const requestsBefore = events.filter((e) => e.type === 'request').length;
    layer.receive(makeInvite());
    expect(events.filter((e) => e.type === 'statelessRequest')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'request').length).toBe(requestsBefore);

    // The server ACKs and its own termination does not resurrect anything.
    const ack = makeRequest('ACK', 'sip:bob@example.com', invite.headers);
    ack.headers.set('CSeq', '41 ACK');
    layer.receive(ack); // server Completed -> Confirmed
    clock.advance(0); // server Confirmed -> Terminated (reliable I = 0)
    expect(events.filter((e) => e.type === 'terminated')).toHaveLength(terminatedAtClient + 1);

    // The client entry was removed on client-terminate: a late 2xx is unmatched
    // and emitted only as a statelessResponse (the earlier 486 was one real
    // response event).
    layer.receive(responseFor('z9hG4bK-abc', 200));
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'statelessResponse')).toHaveLength(1);
  });

  it('removes the map entry only after terminated', () => {
    const { clock, layer, events } = setup();
    const invite = makeInvite();
    const first = layer.sendRequest(invite);
    // Before termination the transaction is still tracked: a 2xx routes to it.
    layer.receive(responseFor('z9hG4bK-abc', 200));
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // Advance past timer M so the Accepted client transaction terminates.
    clock.advance(TIMERS.M);
    expect(events).toContainEqual({ type: 'terminated', key: 'z9hG4bK-abc|192.0.2.1:5060|INVITE' });
    // After termination the map entry is gone; a late response is dropped.
    layer.receive(responseFor('z9hG4bK-abc', 200));
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // The map entry is gone: a fresh request with the same key creates a NEW
    // transaction instead of returning the stale terminated one.
    const second = layer.sendRequest(makeInvite());
    expect(second).not.toBe(first);
    expect(second.state).not.toBe('Terminated');
  });

  it('rejects a request whose top Via branch lacks the magic cookie', () => {
    const { layer } = setup();
    const invite = makeInvite('no-magic-cookie');
    expect(() => layer.sendRequest(invite)).toThrow();
  });

  it('routes a non-INVITE client response to its transaction', () => {
    const { events, layer } = setup();
    const reg = makeRegister();
    const tx = layer.sendRequest(reg);
    layer.receive(responseFor('z9hG4bK-reg', 200, 'REGISTER', '1'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'response', transaction: expect.objectContaining({ key: tx.key }) }));
  });

  it('routes subscriptions only to their returned transaction key when CSeq values collide', () => {
    const { layer } = setup();
    const register = layer.sendRequest(makeRegister('z9hG4bK-shared'));
    const options = layer.sendRequest(makeOptions('z9hG4bK-shared'));
    const received: TransactionLayerEvent[] = [];
    layer.subscribe(register.key, (event: TransactionLayerEvent) => received.push(event));

    layer.receive(responseFor('z9hG4bK-shared', 200, 'OPTIONS', '1'));
    expect(received).toEqual([]);
    layer.receive(responseFor('z9hG4bK-shared', 200, 'REGISTER', '1'));
    expect(received).toContainEqual(expect.objectContaining({ type: 'response', transaction: expect.objectContaining({ key: register.key }) }));
    expect(received).not.toContainEqual(expect.objectContaining({ type: 'response', transaction: expect.objectContaining({ key: options.key }) }));
  });

  it('delivers all events bearing a shared client and server transaction key', () => {
    const { layer } = setup();
    const client = layer.sendRequest(makeInvite());
    const received: TransactionLayerEvent[] = [];
    layer.subscribe(client.key, (event) => received.push(event));

    layer.receive(makeInvite());
    layer.receive(responseFor('z9hG4bK-abc', 486));

    expect(received).toContainEqual(expect.objectContaining({ type: 'request', transaction: expect.objectContaining({ key: client.key }) }));
    expect(received).toContainEqual(expect.objectContaining({ type: 'response', transaction: expect.objectContaining({ key: client.key }) }));
  });

  it('rejects branchless incoming requests instead of legacy-matching them', () => {
    const { events, layer } = setup();
    const invite = makeInvite();
    invite.headers.set('Via', 'SIP/2.0/UDP 192.0.2.1:5060');

    expect(() => layer.receive(invite)).toThrow(TransportError);
    expect(events).toEqual([]);
  });

  it('rejects a branchless top Via even when a lower Via has a magic-cookie branch', () => {
    const { events, layer } = setup();
    const invite = makeInvite();
    invite.headers.set(
      'Via',
      'SIP/2.0/UDP 192.0.2.1:5060;rport, SIP/2.0/UDP 192.0.2.2:5060;branch=z9hG4bK-lower',
    );

    expect(() => layer.receive(invite)).toThrow(TransportError);
    expect(events).toEqual([]);
  });

  it('accepts RFC separator whitespace in the top Via and canonicalizes sent-by', () => {
    const { layer } = setup();
    const options = makeOptions();
    options.headers.set(
      'Via',
      'SIP / 2.0 / UDP Example.COM : 5060 ; branch = z9hG4bK-sws',
    );

    const transaction = layer.sendRequest(options);

    expect(transaction.key).toBe('z9hG4bK-sws|example.com:5060|OPTIONS');
  });

  it('uses the first field when Via is repeated', () => {
    const { layer } = setup();
    const options = makeOptions();
    options.headers.set('Via', viaHeader('z9hG4bK-top', 'Top.Example.COM:5060'));
    options.headers.append('Via', viaHeader('z9hG4bK-lower', 'lower.example.com:5060'));

    const transaction = layer.sendRequest(options);

    expect(transaction.key).toBe('z9hG4bK-top|top.example.com:5060|OPTIONS');
  });

  it('rejects a branchless first field when a repeated lower Via is valid', () => {
    const { events, layer } = setup();
    const options = makeOptions();
    options.headers.set('Via', 'SIP/2.0/UDP top.example.com:5060;rport');
    options.headers.append('Via', viaHeader('z9hG4bK-lower', 'lower.example.com:5060'));

    expect(() => layer.sendRequest(options)).toThrow(TransportError);
    expect(events).toEqual([]);
  });

  it('distinguishes server transactions with the same branch but different Via sent-by values', () => {
    const { events, layer } = setup();
    const first = makeInvite('z9hG4bK-shared');
    first.headers.set('Via', viaHeader('z9hG4bK-shared', 'EXAMPLE.COM:5060'));
    const normalizedDuplicate = makeInvite('z9hG4bK-shared');
    normalizedDuplicate.headers.set('Via', viaHeader('z9hG4bK-shared', 'example.com:5060'));
    const collision = makeInvite('z9hG4bK-shared');
    collision.headers.set('Via', viaHeader('z9hG4bK-shared', 'other.example.com:5060'));

    layer.receive(first);
    layer.receive(normalizedDuplicate);
    layer.receive(collision);

    expect(events.filter((event) => event.type === 'request')).toHaveLength(2);
  });

  it('rejects requests whose CSeq number is invalid or whose CSeq method mismatches', () => {
    const { events, layer } = setup();
    const outgoingMethodMismatch = makeInvite('z9hG4bK-out-method');
    outgoingMethodMismatch.headers.set('CSeq', '41 OPTIONS');
    const outgoingInvalidNumber = makeInvite('z9hG4bK-out-number');
    outgoingInvalidNumber.headers.set('CSeq', 'not-a-number INVITE');
    const incomingMethodMismatch = makeInvite('z9hG4bK-in-method');
    incomingMethodMismatch.headers.set('CSeq', '41 OPTIONS');
    const incomingInvalidNumber = makeInvite('z9hG4bK-in-number');
    incomingInvalidNumber.headers.set('CSeq', 'not-a-number INVITE');

    expect(() => layer.sendRequest(outgoingMethodMismatch)).toThrow(TransportError);
    expect(() => layer.sendRequest(outgoingInvalidNumber)).toThrow(TransportError);
    expect(() => layer.receive(incomingMethodMismatch)).toThrow(TransportError);
    expect(() => layer.receive(incomingInvalidNumber)).toThrow(TransportError);
    expect(events).toEqual([]);
  });

  it('fans out layer events to every subscriber and stops after unsubscribe', () => {
    const { clock, layer } = setup(true);
    const first: TransactionLayerEvent[] = [];
    const second: TransactionLayerEvent[] = [];
    const unsubscribe = layer.subscribe((e) => first.push(e));
    layer.subscribe((e) => second.push(e));

    layer.sendRequest(makeRegister());
    layer.receive(responseFor('z9hG4bK-reg', 200, 'REGISTER', '1'));
    // Both subscribers see the response; advancement past timer K (reliable:
    // K = 0) terminates the transaction, which forward also fans out.
    clock.advance(TIMERS.K);
    expect(first).toContainEqual(expect.objectContaining({ type: 'response' }));
    expect(second).toContainEqual(expect.objectContaining({ type: 'response' }));
    expect(first).toContainEqual({ type: 'terminated', key: 'z9hG4bK-reg|192.0.2.1:5060|REGISTER' });
    expect(second).toContainEqual({ type: 'terminated', key: 'z9hG4bK-reg|192.0.2.1:5060|REGISTER' });

    // Unsubscribed subscriber is never called again, while a fresh one is.
    const after: TransactionLayerEvent[] = [];
    unsubscribe();
    layer.subscribe((e) => after.push(e));
    layer.sendRequest(makeInvite());
    layer.receive(responseFor('z9hG4bK-abc', 486));
    expect(after).toContainEqual(expect.objectContaining({ type: 'response' }));
    expect(first.filter((e) => e.type === 'response' && (e as { response: SipResponseMessage }).response.statusCode === 486)).toHaveLength(0);
  });

  it('does not create new transactions after disposal', () => {
    const { clock, events, layer } = setup();
    layer.dispose();

    let sendError: unknown;
    try {
      layer.sendRequest(makeRegister('z9hG4bK-after-dispose-client'));
    } catch (error) {
      sendError = error;
    }
    layer.receive(makeRegister('z9hG4bK-after-dispose-server'));

    expect(sendError).toBeInstanceOf(TransportError);
    expect(events).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it('terminates every transaction when one termination observer throws during disposal', () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
    void transport.connect();
    let terminatedEvents = 0;
    const layer = new TransactionLayer({
      transport,
      clock,
      timers: TIMERS,
      reliable: false,
      emit: (event) => {
        if (event.type === 'terminated' && terminatedEvents++ === 0) {
          throw new Error('termination observer failed');
        }
      },
    });

    const invite = layer.sendRequest(makeInvite('z9hG4bK-dispose-invite'));
    const register = layer.sendRequest(makeRegister('z9hG4bK-dispose-register'));
    layer.receive(makeInvite('z9hG4bK-dispose-server'));
    expect(clock.pending()).toBeGreaterThan(0);

    expect(() => layer.dispose()).not.toThrow();

    expect(invite.state).toBe('Terminated');
    expect(register.state).toBe('Terminated');
    expect(clock.pending()).toBe(0);
  });

  it('fans a terminal transportError to active client and server transactions on transport disconnect', () => {
    const { transport, events, layer } = setup(false);
    const client = layer.sendRequest(makeInvite('z9hG4bK-level-disc-client'));
    layer.receive(makeInvite('z9hG4bK-level-disc-server'));
    const error = new TransportError('link lost');
    transport.emitDisconnected(error);

    expect(client.state).toBe('Terminated');
    const transportErrors = events.filter((event) => event.type === 'transportError');
    expect(transportErrors).toHaveLength(2);
    expect(transportErrors).toEqual([
      expect.objectContaining({ type: 'transportError', error }),
      expect.objectContaining({ type: 'transportError', error }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'terminated' }));
  });

  it('isolates a throwing subscriber from the rest', () => {
    const { clock, layer } = setup(true);
    const good: unknown[] = [];
    layer.subscribe(() => { throw new Error('boom'); });
    layer.subscribe((e) => good.push(e.type));
    layer.sendRequest(makeRegister());
    layer.receive(responseFor('z9hG4bK-reg', 200, 'REGISTER', '1'));
    clock.advance(TIMERS.K);
    expect(good).toContain('response');
    // The terminated fan-out also reaches `good` past the throwing subscriber.
    expect(good).toContain('terminated');
  });

  it('isolates a throwing subscriber on an unmatched response', () => {
    const { layer } = setup();
    const good: unknown[] = [];
    layer.subscribe(() => { throw new Error('boom'); });
    layer.subscribe((e) => good.push(e.type));
    // No matching client transaction: routed as a statelessResponse.
    layer.receive(responseFor('z9hG4bK-unknown', 200));
    expect(good).toContain('statelessResponse');
  });

  it('isolates a throwing subscriber on an unmatched ACK', () => {
    const { layer } = setup();
    const good: unknown[] = [];
    layer.subscribe(() => { throw new Error('boom'); });
    layer.subscribe((e) => good.push(e.type));
    const ack = makeRequest('ACK', 'sip:bob@example.com', new Headers());
    ack.headers.set('Via', viaHeader('z9hG4bK-fresh2xx'));
    ack.headers.set('From', '<sip:alice@example.com>');
    ack.headers.set('To', '<sip:bob@example.com>');
    ack.headers.set('Call-ID', 'ack123');
    ack.headers.set('CSeq', '41 ACK');
    layer.receive(ack);
    expect(good).toContain('statelessRequest');
  });
});
