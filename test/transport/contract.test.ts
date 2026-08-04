import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/errors.js';
import type { TransportEvent } from '../../src/transport/index.js';
import { FakeTransport } from '../support/fake-transport.js';

describe('transport contract', () => {
  it('keeps data and failures distinct', async () => {
    const transport = new FakeTransport({ reliable: true, framing: 'message' });
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    transport.emitData(new Uint8Array());
    transport.emitError(new TransportError('lost'));
    expect(events.map((event) => event.type)).toEqual(['data', 'error']);
  });
});
