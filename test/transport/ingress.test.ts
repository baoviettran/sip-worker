import { describe, expect, it } from 'vitest';
import { ParseError, TransportError } from '../../src/errors.js';
import type { SipMessage } from '../../src/messages/index.js';
import {
  SipIngress,
  type TransportEvent,
} from '../../src/transport/index.js';
import { FakeTransport } from '../support/fake-transport.js';

const encoder = new TextEncoder();
const validResponseBytes = encoder.encode(
  'SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n',
);

class CountingTransport extends FakeTransport {
  subscribeCalls = 0;
  unsubscribeCalls = 0;

  override subscribe(listener: (event: TransportEvent) => void): () => void {
    this.subscribeCalls += 1;
    const unsubscribe = super.subscribe(listener);
    return () => {
      this.unsubscribeCalls += 1;
      unsubscribe();
    };
  }
}

function createTransport(): CountingTransport {
  return new CountingTransport({ reliable: true, framing: 'message' });
}

describe('SipIngress', () => {
  it('routes valid messages and reports failures without fake data', () => {
    const transport = createTransport();
    const messages: SipMessage[] = [];
    const errors: Error[] = [];
    const ingress = new SipIngress(
      transport,
      { receive: (message) => messages.push(message) },
      (error) => errors.push(error),
    );
    const transportError = new TransportError('closed');
    const disconnectError = new TransportError('connection lost');

    ingress.start();
    transport.emitData(validResponseBytes);
    transport.emitData(new Uint8Array([0xff]));
    transport.emitError(transportError);
    transport.emitDisconnected(disconnectError);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'response',
      statusCode: 200,
      reasonPhrase: 'OK',
    });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBeInstanceOf(ParseError);
    expect(errors[1]).toBe(transportError);
    expect(errors[2]).toBe(disconnectError);
  });

  it('subscribes only once while started', () => {
    const transport = createTransport();
    const messages: SipMessage[] = [];
    const ingress = new SipIngress(
      transport,
      { receive: (message) => messages.push(message) },
      () => undefined,
    );

    ingress.start();
    ingress.start();
    transport.emitData(validResponseBytes);

    expect(transport.subscribeCalls).toBe(1);
    expect(messages).toHaveLength(1);
  });

  it('unsubscribes once and ignores later events when stopped repeatedly', () => {
    const transport = createTransport();
    const messages: SipMessage[] = [];
    const errors: Error[] = [];
    const ingress = new SipIngress(
      transport,
      { receive: (message) => messages.push(message) },
      (error) => errors.push(error),
    );

    ingress.start();
    ingress.stop();
    ingress.stop();
    transport.emitData(validResponseBytes);
    transport.emitError(new TransportError('ignored'));

    expect(transport.unsubscribeCalls).toBe(1);
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });
});
