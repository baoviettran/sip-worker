import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/errors.js';
import { OptionsLiveness } from '../../src/reliability/options-liveness.js';
import type { RequestFactory } from '../../src/reliability/options-liveness.js';
import { Headers, makeRequest, makeResponse } from '../../src/messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../../src/messages/message.js';
import { makeBranch } from '../../src/dialogs/header-values.js';
import { TransactionLayer } from '../../src/transactions/index.js';
import { deriveTimers } from '../../src/transactions/timers.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import type { TransactionLayerEvent } from '../../src/transactions/types.js';

/** Decide the underlying transport liveness impossible: no window / WebSocket / ws. */

/**
 * A transport whose `send` rejects asynchronously once `failSends` is set,
 * mirroring how a real socket failure surfaces through `Transport.send` as a
 * rejected promise rather than a synchronous throw. This drives the transaction
 * layer's `transportError` terminal path.
 */
class SendRejectTransport extends FakeTransport {
  failSends = false;
  override async send(data: Uint8Array): Promise<void> {
    if (this.failSends) {
      throw new TransportError('FakeTransport link is down');
    }
    return super.send(data);
  }
}

function makeFactory(requests: SipRequestMessage[]): RequestFactory {
  return (index: number) => {
    const headers = new Headers();
    headers.set('Via', `SIP/2.0/UDP 192.0.2.1:5060;branch=${makeBranch(`opt-${index}`)}`);
    headers.set('Max-Forwards', '70');
    headers.set('From', '<sip:alice@example.com>;tag=opt');
    headers.set('To', '<sip:proxy.example.com>');
    headers.set('Call-ID', `opt-${index}`);
    headers.set('CSeq', `${index} OPTIONS`);
    const request = makeRequest('OPTIONS', 'sip:proxy.example.com', headers);
    requests.push(request);
    return request;
  };
}

function responseFor(request: SipRequestMessage, status: number): SipResponseMessage {
  const headers = new Headers();
  headers.set('Via', request.headers.get('Via') ?? '');
  headers.set('From', request.headers.get('From') ?? '');
  headers.set('To', request.headers.get('To') ?? '');
  headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
  headers.set('CSeq', request.headers.get('CSeq') ?? '');
  return makeResponse(status, status >= 200 ? 'OK' : 'Trying', headers);
}

function setup(options: { intervalMs?: number; reliable?: boolean } = {}) {
  const reliable = options.reliable ?? true;
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable, framing: reliable ? 'stream' : 'datagram' });
  void transport.connect();
  const events: TransactionLayerEvent[] = [];
  const layer = new TransactionLayer({
    transport,
    clock,
    timers: deriveTimers({ T1: 100, T2: 400, T4: 500 }, reliable),
    reliable,
    emit: (e) => events.push(e),
  });
  const requests: SipRequestMessage[] = [];
  const failures: TransportError[] = [];
  const liveness = new OptionsLiveness({
    layer,
    clock,
    requestFactory: makeFactory(requests),
    probeIntervalMs: options.intervalMs ?? 1000,
    onFailure: (error) => failures.push(error),
  });
  return { clock, transport, layer, events, requests, failures, liveness };
}

describe('OptionsLiveness', () => {
  it('sends no immediate probe and emits one OPTIONS with a fresh magic-cookie branch at the first interval', () => {
    const { clock, requests, liveness } = setup();
    liveness.start();

    expect(requests).toHaveLength(0);
    clock.advance(999);
    expect(requests).toHaveLength(0);
    clock.advance(1);

    expect(requests).toHaveLength(1);
    const probe = requests[0]!;
    expect(probe.method).toBe('OPTIONS');
    expect(probe.headers.get('Via')).toMatch(/branch=z9hG4bK-/);
    expect(probe.headers.get('CSeq')).toBe('1 OPTIONS');
  });

  it('treats any final response as peer liveness and schedules the next probe', () => {
    const { clock, layer, requests, failures, liveness } = setup();
    liveness.start();

    clock.advance(1000);
    expect(requests).toHaveLength(1);
    layer.receive(responseFor(requests[0]!, 200));

    clock.advance(1000);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers.get('CSeq')).toBe('2 OPTIONS');
    expect(requests[1]!.headers.get('Via')).toMatch(/branch=z9hG4bK-/);
    expect(failures).toHaveLength(0);
  });

  it('observes a final response delivered synchronously inside sendRequest', () => {
    const { clock, transport, layer, requests, failures, liveness } = setup();
    transport.onSend = () => {
      const request = requests.at(-1);
      if (request !== undefined) layer.receive(responseFor(request, 200));
    };
    liveness.start();

    clock.advance(1000);
    expect(requests).toHaveLength(1);
    expect(failures).toEqual([]);

    // The synchronous final response cleared probe 1, so the next cadence
    // tick is free to send probe 2 instead of treating probe 1 as outstanding.
    clock.advance(1000);
    expect(requests).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it('does not complete a probe on a provisional response', () => {
    const { clock, layer, requests, liveness } = setup();
    liveness.start();

    clock.advance(1000);
    expect(requests).toHaveLength(1);
    layer.receive(responseFor(requests[0]!, 100));

    // The probe is still outstanding: the next interval must not send a second one.
    clock.advance(1000);
    expect(requests).toHaveLength(1);

    // A final response clears the slot, so the following interval can probe again.
    layer.receive(responseFor(requests[0]!, 200));
    clock.advance(1000);
    expect(requests).toHaveLength(2);
  });

  it('never overlaps probes while one is outstanding', () => {
    const { clock, requests, liveness } = setup({ intervalMs: 100 });
    liveness.start();

    clock.advance(1000);
    expect(requests).toHaveLength(1);

    clock.advance(5000);
    expect(requests).toHaveLength(1);
  });

  it('ignores an unrelated final response from another transaction on the shared layer', () => {
    const { clock, layer, requests, failures, liveness } = setup();
    liveness.start();

    clock.advance(1000); // probe 1 (an OPTIONS client transaction) outstanding
    expect(requests).toHaveLength(1);

    // A concurrent transaction (e.g. a REGISTER 200) closes on the same layer
    // while the probe is still pending; it must not clear the probe's slot.
    const unrelated = new Headers();
    unrelated.set('Via', `SIP/2.0/UDP 192.0.2.1:5060;branch=${makeBranch('reg-99')}`);
    unrelated.set('From', '<sip:alice@example.com>');
    unrelated.set('To', '<sip:alice@example.com>');
    unrelated.set('Call-ID', 'reg-99');
    unrelated.set('CSeq', '7 REGISTER');
    layer.receive(makeResponse(200, 'OK', unrelated));

    // The probe slot is still outstanding: the next interval must NOT send a
    // second OPTIONS.
    clock.advance(1000);
    expect(requests).toHaveLength(1);

    // The probe's own final response clears it, letting the next interval probe.
    layer.receive(responseFor(requests[0]!, 200));
    clock.advance(1000);
    expect(requests).toHaveLength(2);
    expect(failures).toHaveLength(0);
  });

  it('reports one liveness failure on transaction timeout and keeps monitoring', () => {
    const { clock, requests, failures, liveness } = setup();
    liveness.start();

    clock.advance(1000); // probe 1 sent; Timer F (64*T1=6400) due at t=7400
    expect(requests).toHaveLength(1);

    clock.advance(6400); // transaction times out
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TransportError);

    // Monitoring continues: the recurring probe timer sends a fresh probe.
    clock.advance(1000);
    expect(requests).toHaveLength(2);
  });

  it('reports one liveness failure on transport error', async () => {
    const reliable = false;
    const clock = new FakeClock();
    const transport = new SendRejectTransport({ reliable, framing: 'datagram' });
    void transport.connect();
    const layer = new TransactionLayer({
      transport,
      clock,
      timers: deriveTimers({ T1: 100, T2: 400, T4: 500 }, reliable),
      reliable,
      emit: () => {},
    });
    const requests: SipRequestMessage[] = [];
    const failures: TransportError[] = [];
    const liveness = new OptionsLiveness({
      layer,
      clock,
      requestFactory: makeFactory(requests),
      probeIntervalMs: 1000,
      onFailure: (error) => failures.push(error),
    });
    liveness.start();

    clock.advance(1000); // probe 1 sent on a live link
    expect(requests).toHaveLength(1);

    // The link dies; the next retransmission (Timer E) fails with a rejected
    // send and surfaces a transportError on the outstanding non-INVITE client
    // transaction, which the strategy reports as one liveness failure.
    transport.failSends = true;
    clock.advance(100); // Timer E retransmission fires, its send rejects
    await new Promise((r) => setTimeout(r, 0)); // let the rejected send's `.catch` run

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(TransportError);
  });

  it('stop unsubscribes from its owned probe without scheduling another', () => {
    const { clock, requests, failures, liveness } = setup();
    liveness.start();

    clock.advance(1000);
    expect(requests).toHaveLength(1);

    liveness.stop();
    const before = requests.length;
    clock.advance(50000);

    expect(requests).toHaveLength(before);
    expect(failures).toHaveLength(0);
  });

  it('makes start and stop idempotent', () => {
    const { clock, requests, liveness } = setup();
    liveness.start();
    liveness.start();
    clock.advance(1000);
    expect(requests).toHaveLength(1); // single probe timer despite double start

    liveness.stop();
    liveness.stop();
    const before = requests.length;
    clock.advance(50000);
    expect(requests).toHaveLength(before);
  });
});
