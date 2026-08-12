import { describe, expect, expectTypeOf, it } from 'vitest';
import { ParseError, TransportError } from '@sip-worker/core';
import {
  NodeTcpTransport,
  type StreamSocketLike,
} from '../../src/transport/tcp.js';
import type { TransportEvent } from '@sip-worker/core/transport';

type StreamEvent = 'data' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;
const encoder = new TextEncoder();

class FakeStreamSocket implements StreamSocketLike {
  readonly listeners = new Map<StreamEvent, Set<SocketListener>>();
  readonly offCalls: Array<{ event: StreamEvent; listener: SocketListener }> = [];
  readonly writes: Uint8Array[] = [];
  connectedTo?: { port: number; host: string };
  private connectCallback?: () => void;
  private endCallback?: () => void;
  writeError?: Error;

  connect(port: number, host: string, callback: () => void): void {
    this.connectedTo = { port, host };
    this.connectCallback = callback;
  }

  write(data: Uint8Array, callback: (error?: Error) => void): void {
    this.writes.push(data);
    const error = this.writeError;
    this.writeError = undefined;
    callback(error);
  }

  end(callback: () => void): void {
    this.endCallback = callback;
  }

  on(event: StreamEvent, listener: SocketListener): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: StreamEvent, listener: SocketListener): void {
    this.offCalls.push({ event, listener });
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: StreamEvent, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  completeConnect(): void {
    this.connectCallback?.();
  }

  completeEnd(): void {
    this.endCallback?.();
  }
}

function createTransport(socket = new FakeStreamSocket()): {
  socket: FakeStreamSocket;
  transport: NodeTcpTransport;
} {
  return {
    socket,
    transport: new NodeTcpTransport(socket, { host: 'sip.example.test', port: 5060 }),
  };
}

async function connect(socket: FakeStreamSocket, transport: NodeTcpTransport): Promise<void> {
  const pending = transport.connect();
  socket.completeConnect();
  await pending;
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function join(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe('NodeTcpTransport', () => {
  it('requires injected sockets to provide listener removal', () => {
    expectTypeOf<StreamSocketLike['off']>().toEqualTypeOf<
      (event: StreamEvent, listener: SocketListener) => void
    >();
  });

  it('advertises stream capabilities and emits one copied event per decoded message', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);
    const firstMessage = bytes('OPTIONS sip:a@example.test SIP/2.0\r\nContent-Length: 4\r\n\r\nbody');
    const secondMessage = bytes('SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n');
    const stream = join(firstMessage, secondMessage);
    const firstChunk = stream.slice(0, 17);

    socket.emit('data', firstChunk);
    firstChunk.fill(0);
    socket.emit('data', stream.slice(17, 61));
    socket.emit('data', stream.slice(61));

    expect(transport.capabilities).toEqual({ reliable: true, framing: 'stream', token: 'TCP' });
    expect(Object.isFrozen(transport.capabilities)).toBe(true);
    expect(events.filter((event) => event.type === 'data')).toEqual([
      { type: 'data', data: firstMessage },
      { type: 'data', data: secondMessage },
    ]);
  });

  it('emits decoder failures as typed errors and never as data', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);

    socket.emit('data', bytes('OPTIONS sip:a@example.test SIP/2.0\r\nContent-Length: nope\r\n\r\n'));

    const errorEvents = events.filter((event) => event.type === 'error');
    expect(events.filter((event) => event.type === 'data')).toHaveLength(0);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      type: 'error',
      error: { name: 'TransportError', cause: expect.any(ParseError) },
    });
  });

  it('connects to the configured peer and copies outbound bytes', async () => {
    const { socket, transport } = createTransport();
    const data = new Uint8Array([7, 8]);

    await connect(socket, transport);
    await transport.send(data);
    data[0] = 9;

    expect(socket.connectedTo).toEqual({ port: 5060, host: 'sip.example.test' });
    expect(socket.writes).toEqual([new Uint8Array([7, 8])]);
    expect(socket.writes[0]).not.toBe(data);
  });

  it('wraps write callback and socket failures as TransportError', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const writeCause = new Error('write failed');
    const socketCause = new Error('socket failed');
    transport.subscribe((event) => events.push(event));
    await connect(socket, transport);
    socket.writeError = writeCause;

    await expect(transport.send(new Uint8Array([1]))).rejects.toMatchObject({
      name: 'TransportError',
      cause: writeCause,
    });
    socket.emit('error', socketCause);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause: socketCause }),
    });
  });

  it('rejects a failed connect once and ignores a late connect callback', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const cause = new Error('connect failed');
    transport.subscribe((event) => events.push(event));
    transport.subscribe(() => {
      throw new Error('observer failed');
    });

    const pending = transport.connect();
    expect(() => socket.emit('error', cause)).not.toThrow();
    await expect(pending).rejects.toMatchObject({ name: 'TransportError', cause });
    socket.completeConnect();

    expect(transport.isConnected()).toBe(false);
    expect(events.filter((event) => event.type === 'connected')).toHaveLength(0);
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
  });

  it('is one-shot: a failed connect permanently closes the transport', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    const cause = new Error('connect failed');
    transport.subscribe((event) => events.push(event));

    const pending = transport.connect();
    socket.emit('error', cause);
    await expect(pending).rejects.toMatchObject({ name: 'TransportError', cause });
    await expect(transport.connect()).rejects.toBeInstanceOf(TransportError);
    expect(transport.isConnected()).toBe(false);
    expect(events).toContainEqual({
      type: 'disconnected',
      error: expect.objectContaining({ name: 'TransportError', cause }),
    });
  });

  it('waits for the actual socket close before settling a half-closed disconnect', async () => {
    const { socket, transport } = createTransport();
    await connect(socket, transport);

    let settled = false;
    const pending = transport.disconnect().then(() => {
      settled = true;
    });

    // The peer half-closes: our write side finished (FIN sent) but the
    // connection is not fully closed until the socket emits `close`.
    socket.completeEnd();
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.emit('close');
    await pending;
    expect(settled).toBe(true);
  });

  it('settles disconnect once, rejects post-close sends, and removes socket listeners', async () => {
    const { socket, transport } = createTransport();
    const events: TransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    const connected = transport.connect();
    socket.completeConnect();
    socket.completeConnect();
    await connected;

    const disconnected = transport.disconnect();
    socket.emit('close');
    socket.completeEnd();
    await disconnected;

    expect(events.filter((event) => event.type === 'connected')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'disconnected')).toHaveLength(1);
    await expect(transport.send(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportError);
    expect(socket.offCalls.map(({ event }) => event).sort()).toEqual(['close', 'data', 'error']);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('settles disconnect before notifying a throwing subscriber', async () => {
    const { socket, transport } = createTransport();
    await connect(socket, transport);
    transport.subscribe(() => {
      throw new Error('subscriber failed');
    });

    let outcome = 'pending';
    const disconnected = transport.disconnect().then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    expect(() => socket.emit('close')).not.toThrow();
    await Promise.resolve();

    expect(outcome).toBe('resolved');
    await disconnected;
  });
});
