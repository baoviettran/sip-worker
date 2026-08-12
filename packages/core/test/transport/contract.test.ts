import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/errors.js';
import type { TransportEvent } from '../../src/transport/index.js';
import { FakeClock } from '../support/fake-clock.js';
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

  it('copies and freezes capabilities supplied at construction', () => {
    const capabilities = { reliable: true, framing: 'message' as const };
    const transport = new FakeTransport(capabilities);

    capabilities.reliable = false;

    expect(transport.capabilities).toEqual({ reliable: true, framing: 'message', token: 'WS' });
    expect(Object.isFrozen(transport.capabilities)).toBe(true);
    expect(() => Object.assign(transport.capabilities, { reliable: false })).toThrow(TypeError);
  });

  it('copies sent bytes before the caller can mutate them', async () => {
    const transport = new FakeTransport({ reliable: true, framing: 'message' });
    const data = new Uint8Array([1, 2]);

    await transport.connect();
    await transport.send(data);
    data[0] = 9;

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toEqual(new Uint8Array([1, 2]));
    expect(transport.sent[0]).not.toBe(data);
  });

  it('tracks lifecycle state and emits lifecycle events', async () => {
    const transport = new FakeTransport({ reliable: true, framing: 'message' });
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    expect(transport.isConnected()).toBe(false);
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
    await transport.disconnect();

    expect(transport.isConnected()).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['connected', 'disconnected']);
  });

  it('emits a disconnected error and clears connection state', async () => {
    const transport = new FakeTransport({ reliable: true, framing: 'message' });
    const error = new TransportError('lost');
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    await transport.connect();
    transport.emitDisconnected(error);

    expect(transport.isConnected()).toBe(false);
    expect(events).toContainEqual({ type: 'disconnected', error });
  });

  it('stops notifying an unsubscribed listener', () => {
    const transport = new FakeTransport({ reliable: true, framing: 'message' });
    const events: TransportEvent[] = [];
    const unsubscribe = transport.subscribe((event) => events.push(event));

    transport.emitData(new Uint8Array([1]));
    unsubscribe();
    transport.emitData(new Uint8Array([2]));

    expect(events).toEqual([{ type: 'data', data: new Uint8Array([1]) }]);
  });

  it('advances time when no timers are due', () => {
    const clock = new FakeClock();

    clock.advance(25);

    expect(clock.now()).toBe(25);
  });

  it('runs due timers in due-time order and leaves later timers pending', () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    clock.setTimeout(() => calls.push(`first@${clock.now()}`), 5);
    clock.setTimeout(() => calls.push(`second@${clock.now()}`), 10);
    clock.setTimeout(() => calls.push(`later@${clock.now()}`), 15);

    clock.advance(10);

    expect(calls).toEqual(['first@5', 'second@10']);
    expect(clock.now()).toBe(10);
  });

  it('runs timers scheduled by callbacks before the advance target', () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    clock.setTimeout(() => {
      calls.push(`outer@${clock.now()}`);
      clock.setTimeout(() => calls.push(`nested@${clock.now()}`), 2);
    }, 5);

    clock.advance(10);

    expect(calls).toEqual(['outer@5', 'nested@7']);
    expect(clock.now()).toBe(10);
  });

  it('does not run timers cleared before advancing', () => {
    const clock = new FakeClock();
    const callback = () => {
      throw new Error('cleared timer ran');
    };
    const timer = clock.setTimeout(callback, 5);
    clock.clearTimeout(timer);

    clock.advance(5);

    expect(clock.now()).toBe(5);
  });
});
