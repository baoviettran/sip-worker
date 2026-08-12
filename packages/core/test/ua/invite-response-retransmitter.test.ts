import { describe, expect, it } from 'vitest';
import { Headers, makeResponse } from '../../src/messages/index.js';
import { InviteResponseRetransmitter } from '../../src/ua/invite-response-retransmitter.js';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';

describe('InviteResponseRetransmitter', () => {
  it('does not schedule again when synchronous send handling stops it', () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ reliable: false, framing: 'datagram' });
    void transport.connect();
    const retransmitter = new InviteResponseRetransmitter({
      response: makeResponse(200, 'OK', new Headers()),
      transport,
      clock,
      T1: 500,
      T2: 4000,
    });
    transport.onSend = () => retransmitter.stop();
    retransmitter.start();

    clock.advance(500);

    expect(transport.sent).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });
});
