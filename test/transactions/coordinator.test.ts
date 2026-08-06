import { describe, expect, it } from 'vitest';
import { TransactionLayer } from '../../src/transactions/index.js';
import { deriveTimers } from '../../src/transactions/timers.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { Headers, makeRequest, makeResponse, parseMessage } from '../../src/messages/index.js';
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

function viaHeader(branch: string): string {
  return `SIP/2.0/UDP 192.0.2.1:5060;branch=${branch}`;
}

function makeInvite(branch = 'z9hG4bK-abc'): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', viaHeader(branch));
  headers.set('From', '<sip:alice@example.com>');
  headers.set('To', '<sip:bob@example.com>');
  headers.set('Call-ID', 'abc123');
  headers.set('CSeq', '41 INVITE');
  headers.set('Max-Forwards', '70');
  return makeRequest('INVITE', 'sip:bob@example.com', headers);
}

function makeRegister(branch = 'z9hG4bK-reg'): SipRequestMessage {
  const headers = new Headers();
  headers.set('Via', viaHeader(branch));
  headers.set('From', '<sip:alice@example.com>');
  headers.set('To', '<sip:alice@example.com>');
  headers.set('Call-ID', 'reg123');
  headers.set('CSeq', '1 REGISTER');
  headers.set('Max-Forwards', '70');
  return makeRequest('REGISTER', 'sip:example.com', headers);
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

function responseFor(branch: string, statusCode: number, method = 'INVITE', cseq = '41'): SipResponseMessage {
  const headers = new Headers();
  headers.set('Via', viaHeader(branch));
  headers.set('From', '<sip:alice@example.com>');
  headers.set('To', '<sip:bob@example.com>');
  headers.set('Call-ID', 'abc123');
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

  it('removes the map entry only after terminated', () => {
    const { clock, layer, events } = setup();
    const invite = makeInvite();
    const first = layer.sendRequest(invite);
    // Before termination the transaction is still tracked: a 2xx routes to it.
    layer.receive(responseFor('z9hG4bK-abc', 200));
    expect(events.filter((e) => e.type === 'response')).toHaveLength(1);
    // Advance past timer M so the Accepted client transaction terminates.
    clock.advance(TIMERS.M);
    expect(events).toContainEqual({ type: 'terminated', key: 'z9hG4bK-abc|INVITE' });
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
    expect(first).toContainEqual({ type: 'terminated', key: 'z9hG4bK-reg|REGISTER' });
    expect(second).toContainEqual({ type: 'terminated', key: 'z9hG4bK-reg|REGISTER' });

    // Unsubscribed subscriber is never called again, while a fresh one is.
    const after: TransactionLayerEvent[] = [];
    unsubscribe();
    layer.subscribe((e) => after.push(e));
    layer.sendRequest(makeInvite());
    layer.receive(responseFor('z9hG4bK-abc', 486));
    expect(after).toContainEqual(expect.objectContaining({ type: 'response' }));
    expect(first.filter((e) => e.type === 'response' && (e as { response: SipResponseMessage }).response.statusCode === 486)).toHaveLength(0);
  });
});
